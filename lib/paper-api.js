// Live paper trading — server side. Keeps one paper account (separate from the journal),
// feeds the engine Kite quotes (and 1-minute candles to catch up on minutes when nothing
// was running), and asks Kite's read-only margin calculator what each order needs.
// Nothing here ever places a real order.
import {
  newAccount, placeOrder, cancelOrder, modifyOrder, createGtt, deleteGtt, advance, funds, stats,
  instrumentKeys, isLive, isOpen, groupOf, SESSIONS, approxMargin, chargesFor, openingQty, PaperError, positionOf, riskCheck, istParts, positionRiskFree,
} from '../public/paper/engine.js';

const KEY = 'paper|account';
// Local testing only: PAPER_SHIFT_MIN moves the paper clock (the hosted site never sets it).
const nowMs = () => Date.now() + (globalThis.__PAPER_SHIFT || 0);
const DAY = 86400000;

// One engine run at a time (a page poll and the minute job could otherwise fill an order twice).
let chain = Promise.resolve();
const locked = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

let lastQuotes = { at: 0, keys: '', data: {} };
async function quotesFor(kite, keys) {
  if (!keys.length) return {};
  const k = keys.slice().sort().join(',');
  if (lastQuotes.keys === k && nowMs() - lastQuotes.at < 1500) return lastQuotes.data;
  const raw = await kite.quotes(keys, { full: true });
  const data = Object.fromEntries(Object.entries(raw).map(([key, q]) => [key, { ltp: q.last, bid: q.bid || null, ask: q.ask || null, upper: q.upper || null, lower: q.lower || null, ltt: q.ltt || null, prevClose: q.prevClose, changePct: q.changePct }]));
  lastQuotes = { at: nowMs(), keys: k, data };
  return data;
}

const anyOpen = (now) => Object.keys(SESSIONS).some((g) => isOpen(g, now));

/** Minute candles since the last check, for instruments with something waiting on them. */
async function catchUp(kite, acc, now) {
  if (!acc.lastCheck || now - acc.lastCheck < 90000 || kite.status().mock) return {};
  const from = Math.max(acc.lastCheck, now - 5 * DAY);
  const out = {};
  const things = [...acc.orders.filter(isLive), ...acc.gtts.filter((g) => g.status === 'active'), ...acc.positions.filter((p) => p.qty)];
  const byKey = new Map(things.filter((x) => x.token).map((x) => [`${x.exchange}:${x.symbol}`, x]));
  for (const [key, x] of byKey) {
    try {
      const cs = await kite.candles({ exchange: x.exchange, symbol: x.symbol, interval: 'minute', from, to: now, token: x.token });
      out[key] = cs.filter((c) => c[0] + 60000 > acc.lastCheck && c[0] + 60000 <= now).map((c) => ({ t: c[0], o: c[1], h: c[2], l: c[3], c: c[4] }));
    } catch { /* this instrument just won't catch up */ }
  }
  return out;
}

export function paperRunner({ kite, cache }) {
  const load = async () => {
    const a = await cache.get(KEY).catch(() => null);
    return a?.v ? a : newAccount();
  };
  const save = (a) => { a.rev = (a.rev || 0) + 1; trimHistory(a); return cache.put(KEY, a); };

  /** Bring the account up to now. Returns { acc, quotes }. */
  async function tick({ extraKeys = [], force = false } = {}) {
    const acc = await load();
    const now = nowMs();
    const keys = [...new Set([...instrumentKeys(acc), ...extraKeys])];
    let quotes = {};
    const connected = kite.status().connected;
    // Quotes even when markets are closed, so the watchlist shows the last price (the engine ignores them then).
    if (connected && keys.length) { try { quotes = await quotesFor(kite, keys); } catch { /* keep going without prices */ } }
    const candles = connected ? await catchUp(kite, acc, now) : {};
    const before = JSON.stringify([acc.orders.length, acc.orders.filter(isLive).length, acc.fills.length, acc.gtts.filter((g) => g.status === 'active').length, acc.positions.length, acc.holdings.length, acc.sessionDone, acc.lastSeen]);
    advance(acc, { now, quotes, candles });
    const after = JSON.stringify([acc.orders.length, acc.orders.filter(isLive).length, acc.fills.length, acc.gtts.filter((g) => g.status === 'active').length, acc.positions.length, acc.holdings.length, acc.sessionDone, acc.lastSeen]);
    // Save when something happened, and at least every few minutes (lastCheck drives catch-up).
    if (before !== after || !acc._savedAt || now - acc._savedAt > 120000) { acc._savedAt = now; await save(acc); }
    return { acc, quotes, now };
  }

  async function marginFor(o, ref) {
    const opening = openingQty(o.acc, o);
    const est = { margin: opening ? approxMargin({ ...o, qty: opening }, ref) : 0, charges: chargesFor(o, o.side, o.qty, ref).total, source: 'estimate' };
    if (!opening) return est;
    try {
      const r = await kite.orderMargins([{ exchange: o.exchange, tradingsymbol: o.symbol, transaction_type: o.side, variety: o.variety === 'co' ? 'co' : 'regular', product: o.product, order_type: o.type, quantity: opening, price: o.price || 0, trigger_price: o.trigger || o.coTrigger || 0 }]);
      const m = Array.isArray(r) ? r[0] : null;
      if (m?.total > 0) return { margin: m.total, charges: m.charges?.total ?? est.charges, source: 'kite' };
    } catch { /* fall back to the estimate */ }
    return est;
  }

  return { load, save, tick, marginFor };
}

// Keep the stored account small: the last 30 days of finished orders and fills.
function trimHistory(a) {
  const cut = nowMs() - 30 * DAY;
  a.orders = a.orders.filter((o) => isLive(o) || (o.closedAt || o.placedAt) >= cut);
  a.fills = a.fills.filter((f) => f.t >= cut || a.fills.length < 2000);
  a.gtts = a.gtts.filter((g) => g.status === 'active' || (g.triggeredAt || g.createdAt) >= cut);
}

/** View sent to the page. */
function view(acc, quotes, now) {
  const ltpOf = (k) => quotes[k]?.ltp ?? null;
  const groups = Object.fromEntries(Object.entries(SESSIONS).map(([g, S]) => [g, { open: isOpen(g, now), label: S.label, opens: S.open, closes: S.close, misCut: S.misCut }]));
  return {
    now, groups, funds: funds(acc, ltpOf), stats: stats(acc), quotes,
    capital: acc.capital, riskPct: acc.riskPct, created: acc.created,
    orders: acc.orders.slice(-400), gtts: acc.gtts.slice(-200), positions: acc.positions.map((p) => ({ ...p, rf: p.qty ? positionRiskFree(acc, p) : null })), holdings: acc.holdings,
    trades: acc.trades.slice(-500), fills: acc.fills.slice(-500), ledger: acc.ledger.slice(-100), today: istParts(now).day,
  };
}

export function paperRoutes(on, { kite, cache, HttpError }) {
  const P = paperRunner({ kite, cache });
  const wrap = (fn) => async (c) => locked(async () => {
    try { return await fn(c); } catch (e) { if (e instanceof PaperError) throw new HttpError(e.message, 400); throw e; }
  });
  const ctxFor = async (acc, req, now) => {
    const key = `${req.exchange}:${req.symbol}`;
    const q = (await quotesFor(kite, [key]).catch(() => ({})))[key] || {};
    return { now, quote: q };
  };

  on('GET', '/api/paper', wrap(async (c) => {
    const extra = (c.url.searchParams.get('watch') || '').split(',').filter((k) => /^[A-Z]+:[A-Z0-9&\-_. ]+$/.test(k)).slice(0, 20);
    const { acc, quotes, now } = await P.tick({ extraKeys: extra, force: c.url.searchParams.get('force') === '1' });
    return view(acc, quotes, now);
  }));

  // Margin, charges and the 1% check for the order window (nothing is placed).
  on('POST', '/api/paper/preview', wrap(async (c) => {
    const req = await c.body(); const acc = await P.load(); const now = nowMs();
    const { quote } = await ctxFor(acc, req, now);
    const o = { ...req, qty: Number(req.qty) || 0, price: Number(req.price) || null, trigger: Number(req.trigger) || null, coTrigger: Number(req.coTrigger) || null, stop: Number(req.stop) || null, target: Number(req.target) || null, lotSize: req.lotSize || 1 };
    const ref = o.price || o.trigger || quote.ltp || 0;
    const m = o.qty && ref ? await P.marginFor({ ...o, acc }, ref) : { margin: 0, charges: 0, source: 'estimate' };
    return { quote, ...m, available: funds(acc).available, risk: riskCheck(acc, o, quote.ltp) };
  }));

  on('POST', '/api/paper/orders', wrap(async (c) => {
    const req = await c.body(); const { acc } = await P.tick({ extraKeys: [`${req.exchange}:${req.symbol}`], force: true });
    const now = nowMs(); const ctx = await ctxFor(acc, req, now);
    const ref = Number(req.price) || Number(req.trigger) || ctx.quote.ltp;
    if (!ref && req.variety !== 'amo') throw new HttpError('No price from Kite for this instrument yet — try again in a moment');
    const draft = { ...req, qty: Math.round(Number(req.qty) || 0), price: Number(req.price) || null, trigger: Number(req.trigger) || null, coTrigger: Number(req.coTrigger) || null, acc };
    ctx.margin = ref ? (await P.marginFor(draft, ref)).margin : undefined;
    const o = placeOrder(acc, req, ctx);
    await P.save(acc);
    return { order: o, risk: riskCheck(acc, o, ctx.quote.ltp) };
  }));

  on('PUT', '/api/paper/orders/:id', wrap(async (c) => {
    const ch = await c.body(); const acc = await P.load(); const o = acc.orders.find((x) => x.id === c.params.id);
    if (!o) throw new HttpError('No such order', 404);
    const ctx = await ctxFor(acc, o, nowMs());
    modifyOrder(acc, o.id, ch, ctx); await P.save(acc); return { order: o };
  }));
  on('DELETE', '/api/paper/orders/:id', wrap(async (c) => { const acc = await P.load(); const o = cancelOrder(acc, c.params.id, nowMs()); await P.save(acc); return { order: o }; }));

  on('POST', '/api/paper/gtt', wrap(async (c) => {
    const g = await c.body(); const acc = await P.load();
    const { quote } = await ctxFor(acc, g, nowMs());
    const x = createGtt(acc, { ...g, trigger: Number(g.trigger) || null, stop: Number(g.stop) || null, target: Number(g.target) || null, price: Number(g.price) || null, ltpAtCreate: quote.ltp }, nowMs());
    await P.save(acc); return { gtt: x };
  }));
  on('DELETE', '/api/paper/gtt/:id', wrap(async (c) => { const acc = await P.load(); deleteGtt(acc, c.params.id); await P.save(acc); return { ok: true }; }));

  // Exit a position at market (cancelling its cover-order stop once flat).
  on('POST', '/api/paper/exit', wrap(async (c) => {
    const { exchange, symbol, product } = await c.body(); const acc = await P.load(); const now = nowMs();
    const p = acc.positions.find((x) => x.exchange === exchange && x.symbol === symbol && x.product === product && x.qty);
    if (!p) throw new HttpError('No open position to exit');
    for (const o of acc.orders) if (isLive(o) && o.coLeg && o.exchange === exchange && o.symbol === symbol) { o.status = 'CANCELLED'; o.closedAt = now; o.margin = 0; o.history.push({ t: now, s: 'CANCELLED', msg: 'Exited' }); }
    const ctx = await ctxFor(acc, p, now);
    const o = placeOrder(acc, { exchange, symbol, token: p.token, segment: p.segment, lotSize: p.lotSize, tickSize: 0.05, expiry: p.expiry, side: p.qty > 0 ? 'SELL' : 'BUY', product, type: 'MARKET', qty: Math.abs(p.qty), tag: 'EXIT' }, ctx);
    await P.save(acc); return { order: o };
  }));

  // Convert a position's product (MIS ↔ CNC / NRML), like Kite's "Convert".
  on('POST', '/api/paper/convert', wrap(async (c) => {
    const { exchange, symbol, from, to } = await c.body(); const acc = await P.load();
    const p = acc.positions.find((x) => x.exchange === exchange && x.symbol === symbol && x.product === from && x.qty);
    if (!p) throw new HttpError('No such position');
    const ok = p.segment === 'EQ' ? ['CNC', 'MIS', 'MTF'] : ['NRML', 'MIS'];
    if (!ok.includes(to) || to === from) throw new HttpError(`Can't convert ${from} to ${to}`);
    if (to === 'CNC' && p.qty < 0) throw new HttpError('A short position can\'t be converted to delivery');
    if (to === 'MIS' && !isOpen(groupOf(exchange), nowMs())) throw new HttpError('Convert to intraday while the market is open');
    const need = approxMargin({ ...p, product: to, qty: Math.abs(p.qty) }, p.avg) - p.margin;
    if (need > funds(acc).available) throw new HttpError(`Insufficient funds to convert. ₹${Math.round(need).toLocaleString('en-IN')} more margin needed.`);
    const into = acc.positions.find((x) => x.exchange === exchange && x.symbol === symbol && x.product === to && x.qty);
    if (into) { into.avg = (into.avg * into.qty + p.avg * p.qty) / (into.qty + p.qty); into.qty += p.qty; into.margin += p.margin + need; acc.positions.splice(acc.positions.indexOf(p), 1); }
    else { p.product = to; p.margin += need; }
    for (const t of acc.trades) if (!t.closedAt && t.exchange === exchange && t.symbol === symbol && t.product === from) t.product = to;
    await P.save(acc); return { ok: true };
  }));

  on('PUT', '/api/paper/settings', wrap(async (c) => {
    const b = await c.body(); const acc = await P.load();
    if (b.riskPct != null) { const r = Number(b.riskPct); if (!(r > 0 && r <= 10)) throw new HttpError('Risk per trade should be between 0.1% and 10%'); acc.riskPct = r; }
    await P.save(acc); return { ok: true };
  }));
  // Start again (optionally with a different capital).
  on('POST', '/api/paper/reset', wrap(async (c) => {
    const b = await c.body(); const cap = Number(b.capital) || 600000;
    if (cap < 10000 || cap > 1e9) throw new HttpError('Capital should be between ₹10,000 and ₹100 crore');
    const acc = newAccount({ capital: cap, riskPct: Number(b.riskPct) || 1 });
    await P.save(acc); return { ok: true };
  }));
}

/** For the scheduled job (Cloudflare cron / local timer): run the engine if any market is open. */
export async function paperCron({ kite, cache }) {
  if (!anyOpen(nowMs()) && !anyOpen(nowMs() - 10 * 60000)) return; // also once just after the close
  await locked(() => paperRunner({ kite, cache }).tick());
}
