// The TradeQuest API, independent of where it runs. The local server (server.js)
// and the Cloudflare Worker (worker/index.js) both pass requests in here.
//
// A handler returns plain data (sent as JSON), or one of:
//   { redirect: '/path' }                     302 redirect
//   { json, headers }                         JSON with extra headers
//   { response }                              a fetch Response, passed through
import { chartPlan, defaultInterval, excursionsFromCandles, toWeekly } from './chart.js';

/**
 * store: lib/store.js (already loaded)
 * kite:  createKite(...) (already init()-ed)
 * cache: { get(key), put(key, value) } — async, JSON values; for candles that never change.
 */
export function createApi({ store, kite, cache, hosted = false }) {
  const routes = [];
  const on = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });
  const HttpError = store.HttpError;

  on('GET', '/api/state', () => store.getState());
  on('POST', '/api/trades', async (c) => store.createTrade(await c.body()));
  on('PUT', '/api/trades/:id', async (c) => store.updateTrade(c.params.id, await c.body()));
  on('DELETE', '/api/trades/:id', (c) => { store.deleteTrade(c.params.id); return { ok: true }; });
  on('POST', '/api/trades/:id/thesis-reviews', async (c) => store.addThesisReview(c.params.id, await c.body()));
  on('DELETE', '/api/trades/:id/thesis-reviews/:rid', (c) => store.deleteThesisReview(c.params.id, c.params.rid));
  on('POST', '/api/groups', async (c) => store.createGroup(await c.body()));
  on('PUT', '/api/groups/:id', async (c) => store.updateGroup(c.params.id, await c.body()));
  on('DELETE', '/api/groups/:id', (c) => { store.deleteGroup(c.params.id); return { ok: true }; });
  on('DELETE', '/api/trades/:id/group', (c) => { store.unlinkTrade(c.params.id); return { ok: true }; });

  // ---------- Practice (chart replay) ----------
  // Candles around a start date: enough history to read the chart, plus the "future" to play.
  const PRACTICE_WINDOW = { day: [500, 300], '60minute': [60, 60], '15minute': [25, 25], '5minute': [8, 8] };
  on('GET', '/api/practice/candles', async (c) => {
    const q = c.url.searchParams;
    const exchange = (q.get('exchange') || 'NSE').toUpperCase();
    const symbol = (q.get('symbol') || '').toUpperCase().trim();
    const interval = PRACTICE_WINDOW[q.get('interval')] ? q.get('interval') : 'day';
    const start = Date.parse(q.get('start'));
    if (!symbol || !Number.isFinite(start)) throw new HttpError('symbol and start are required');
    const [back, fwd] = PRACTICE_WINDOW[interval];
    const from = start - back * 86400000;
    const to = Math.min(start + fwd * 86400000, Date.now());
    if (to <= start) throw new HttpError('Start date must be in the past');
    const key = ['practice2', exchange, symbol, interval, from, to].join('|');
    const settled = to < Date.now() - 86400000; // past data never changes: cache it
    if (settled) { const hit = await cache.get(key).catch(() => null); if (hit) return hit; }
    let fake = null;
    if (kite.status().mock) {
      const k = `${exchange}:${symbol}`;
      const last = (await kite.quotes([k]))[k]?.last || 500;
      const px = last * (0.6 + Math.random() * 0.5);
      fake = { id: `${k}|${start}|${Math.random()}`, entryTime: new Date(start).toISOString(), entryPrice: px, initialStop: px * 0.75, status: 'OPEN' };
    }
    const candles = await kite.candles({ exchange, symbol, interval, from, to, token: q.get('token'), trade: fake, plan: { interval, from, to } });
    const at = candles.findIndex((x) => x[0] >= start);
    // The Nifty 50 over the same bars, for relative strength.
    let bench = null;
    try {
      const fakeBench = kite.status().mock ? { id: `bench|${from}|${interval}`, entryTime: new Date(start).toISOString(), entryPrice: 20000, initialStop: 18000, status: 'OPEN' } : null;
      bench = await kite.candles({ exchange: 'NSE', symbol: 'NIFTY 50', interval, from, to, token: 256265, trade: fakeBench, plan: { interval, from, to } });
    } catch { bench = null; }
    const out = { exchange, symbol, interval, candles, bench, startIndex: at < 0 ? candles.length : Math.max(0, at) };
    if (settled && candles.length) await cache.put(key, out).catch(() => {});
    return out;
  });
  on('POST', '/api/practice/sessions', async (c) => store.createPracticeSession(await c.body()));
  on('PUT', '/api/practice/sessions/:id', async (c) => store.updatePracticeSession(c.params.id, await c.body()));
  on('DELETE', '/api/practice/sessions/:id', (c) => { store.deletePracticeSession(c.params.id); return { ok: true }; });

  on('POST', '/api/reviews', async (c) => store.upsertReview(await c.body()));
  on('DELETE', '/api/reviews/:id', (c) => { store.deleteReview(c.params.id); return { ok: true }; });
  on('PUT', '/api/settings', async (c) => store.updateSettings(await c.body()));
  on('POST', '/api/symbols/rename', async (c) => store.renameSymbol(await c.body()));
  on('POST', '/api/trades/bulk', async (c) => store.bulkUpdate(await c.body()));
  on('POST', '/api/trades/delete-imported', () => store.deleteImported());
  on('POST', '/api/journal/reset', () => store.resetJournal());
  on('POST', '/api/import/ledger', async (c) => store.importLedger(await c.body()));
  on('DELETE', '/api/ledger', () => store.clearLedger());

  // Daily NAVs of an index fund (AMFI data via mfapi.in), for "what if it went into an index fund".
  on('GET', '/api/benchmark', async (c) => {
    const code = /^\d{3,7}$/.test(c.url.searchParams.get('scheme') || '') ? c.url.searchParams.get('scheme') : '120716';
    const day = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const key = `nav|${code}|${day}`;
    const hit = await cache.get(key).catch(() => null);
    if (hit) return hit;
    let out;
    if (kite.status().mock) {
      // Demo: a smooth ~11%/yr line with wobble.
      const nav = []; let v = 50; const start = Date.UTC(2015, 0, 1);
      for (let t = start; t <= Date.now(); t += 86400000) { const d = new Date(t); if (d.getUTCDay() % 6 === 0) continue; v *= 1 + 0.11 / 250 + Math.sin(t / 4e9) * 0.004; nav.push([d.toISOString().slice(0, 10), Math.round(v * 1e4) / 1e4]); }
      out = { scheme: code, name: 'Demo Nifty 50 Index Fund', nav };
    } else {
      const res = await fetch(`https://api.mfapi.in/mf/${code}`, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new HttpError(`Couldn't load index fund prices (HTTP ${res.status})`, 502);
      const j = await res.json();
      const nav = (j.data || []).map((x) => { const [d, m, y] = String(x.date).split('-'); return [`${y}-${m}-${d}`, Number(x.nav)]; }).filter((x) => x[1] > 0).sort((a, b) => a[0].localeCompare(b[0]));
      if (!nav.length) throw new HttpError('No prices found for that fund code', 404);
      out = { scheme: code, name: j.meta?.scheme_name || code, nav };
    }
    await cache.put(key, out).catch(() => {});
    return out;
  });
  on('POST', '/api/import/tradebook', async (c) => store.importTradebook(await c.body()));
  on('POST', '/api/import', async (c) => store.importState(await c.body()));
  on('GET', '/api/export', () => {
    const day = new Date().toISOString().slice(0, 10);
    return { json: store.getState(), headers: { 'Content-Disposition': `attachment; filename="tradequest-${day}.json"` } };
  });

  // ---------- Kite ----------
  on('GET', '/api/kite/status', () => ({ ...kite.status(), hosted }));
  on('GET', '/api/kite/login', () => ({ redirect: kite.loginUrl() }));
  on('GET', '/api/kite/callback', async (c) => {
    const token = c.url.searchParams.get('request_token');
    if (c.url.searchParams.get('status') !== 'success' || !token) return { redirect: '/#/settings?kite=error&msg=' + encodeURIComponent('Login was cancelled') };
    try {
      await kite.exchange(token);
      return { redirect: '/#/settings?kite=ok' };
    } catch (e) {
      return { redirect: '/#/settings?kite=error&msg=' + encodeURIComponent(e.message) };
    }
  });
  on('POST', '/api/kite/logout', async () => { await kite.logout(); return kite.status(); });
  on('GET', '/api/kite/quote', async (c) => {
    const keys = [...new Set((c.url.searchParams.get('i') || '').split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]+:[A-Z0-9&\-_.]+$/.test(s)))];
    if (!keys.length) throw new HttpError('Pass instruments as ?i=NSE:INFY,NFO:NIFTY25DECFUT');
    const quotes = await kite.quotes(keys);
    store.recordExcursions(quotes);
    return { quotes };
  });
  on('GET', '/api/kite/search', async (c) => ({ results: await kite.search(c.url.searchParams.get('q') || '') }));
  on('GET', '/api/kite/instruments/:ex', async (c) => ({ response: await kite.instrumentsCsv(c.params.ex.toUpperCase()) }));
  on('GET', '/api/kite/portfolio', () => kite.portfolio());
  // Market breadth: the browser fetches each member's daily candles through this proxy
  // (paced to Kite's limit), tallies them, and stores the result with PUT /api/breadth.
  on('GET', '/api/kite/raw-candles', async (c) => {
    const q = c.url.searchParams;
    const interval = ['day', '60minute', '15minute', '5minute'].includes(q.get('interval')) ? q.get('interval') : 'day';
    const from = Date.parse(q.get('from')); const to = Date.parse(q.get('to'));
    if (!Number(q.get('token')) || !Number.isFinite(from) || !Number.isFinite(to)) throw new HttpError('token, from and to are required');
    return { response: await kite.rawCandles({ token: q.get('token'), interval, from, to }) };
  });
  on('POST', '/api/kite/tokens', async (c) => { const b = await c.body(); return { tokens: await kite.tokens(String(b.exchange || 'NSE'), (b.symbols || []).slice(0, 1000).map(String)) }; });
  on('GET', '/api/breadth', async () => (await cache.get('breadth|nifty500').catch(() => null)) || { dates: [] });
  on('PUT', '/api/breadth', async (c) => {
    const b = await c.body();
    if (!Array.isArray(b.dates) || ['adv', 'dec', 'unch', 'a50', 'n50', 'a200', 'n200'].some((k) => !Array.isArray(b[k]) || b[k].length !== b.dates.length)) throw new HttpError('Bad breadth data');
    await cache.put('breadth|nifty500', b);
    return { ok: true, days: b.dates.length };
  });
  on('GET', '/api/kite/fills', async () => ({ fills: await kite.fills() }));

  // Candles for one trade. Closed trades are cached (their chart never changes), and
  // the candles also fill in the best/worst price reached while the trade was open.
  on('GET', '/api/trades/:id/chart', async (c) => {
    const t = store.getState().trades.find((x) => x.id === c.params.id);
    if (!t) throw new HttpError('Trade not found', 404);
    const plan = chartPlan(t, Date.now(), c.url.searchParams.get('interval') || undefined);
    const fetchInterval = plan.interval === 'week' ? 'day' : plan.interval;
    const sig = `${t.exchange}:${t.symbol}|${t.entryTime}|${t.exitTime}|${plan.interval}|${plan.from}`;
    const key = `chart|${t.id}|${plan.interval}`;
    let candles = null;
    if (t.status === 'CLOSED') {
      const hit = await cache.get(key).catch(() => null);
      if (hit?.key === sig) candles = hit.candles;
    }
    if (!candles) {
      candles = await kite.candles({ exchange: t.exchange, symbol: t.symbol, interval: fetchInterval, from: plan.from, to: plan.to, token: c.url.searchParams.get('token'), trade: t, plan: { ...plan, interval: fetchInterval } });
      if (plan.interval === 'week') candles = toWeekly(candles);
      if (t.status === 'CLOSED' && candles.length) await cache.put(key, { key: sig, candles }).catch(() => {});
    }
    const updated = store.mergeExcursions(t.id, excursionsFromCandles(t, candles, plan.interval));
    return { interval: plan.interval, defaultInterval: defaultInterval(t), candles, updated };
  });

  /** Returns null when no route matches. */
  return async function handle({ method, pathname, url, body }) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
      return { result: await r.handler({ params, url, body }) };
    }
    return null;
  };
}
