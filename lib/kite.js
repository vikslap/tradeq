// Zerodha Kite Connect v3 client (login flow, quotes, instrument search, today's fills)
// plus a "demo" mock with simulated prices so the app can be tried without an API key.
// Platform-neutral: storage is passed in ({ get, put, del }, all async), so the
// same client runs in the local server (files) and the Cloudflare Worker (D1).
import { kiteDate, parseKiteCandles, mockCandles } from './chart.js';
import { INSTRUMENT_EXCHANGES, parseExchange, searchInstruments, segmentFor } from '../public/instruments.js';
export { segmentFor };

const API = 'https://api.kite.trade';
const LOGIN = 'https://kite.zerodha.com/connect/login';

export class KiteError extends Error {
  constructor(message, status = 502, code) { super(message); this.status = status; this.code = code; }
}

/** Kite access tokens are invalidated around 6:00 AM IST the next morning. */
function nextExpiry(from = new Date()) {
  const IST = 330 * 60000;
  const ist = new Date(from.getTime() + IST);
  const e = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 6, 0, 0));
  if (e <= ist) e.setUTCDate(e.getUTCDate() + 1);
  return new Date(e.getTime() - IST).toISOString();
}
const istDate = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const kiteTime = (s) => (s ? new Date(String(s).replace(' ', 'T') + '+05:30').toISOString() : null);

async function sha256hex(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * storage: { get(key), put(key, value), del(key) } — async, JSON values.
 * clientSearch: the browser searches the instrument list itself and passes the
 * instrument token for candles (used on Cloudflare, where parsing it is too slow).
 */
export function createKite({ apiKey, apiSecret, storage, mock, getTrades = () => [], clientSearch = false }) {
  if (mock) return createMock(getTrades);

  let session = null;
  const configured = Boolean(apiKey && apiSecret);
  const isLive = () => Boolean(session?.access_token && new Date(session.expiresAt) > new Date());
  const clear = async () => { session = null; try { await storage.del('kite-session'); } catch { /* none */ } };

  async function call(p, { method = 'GET', form, auth = true } = {}) {
    if (!configured) throw new KiteError('Add KITE_API_KEY and KITE_API_SECRET (.env locally, secrets on Cloudflare)', 400, 'NOT_CONFIGURED');
    const headers = { 'X-Kite-Version': '3' };
    if (auth && session?.access_token) headers.Authorization = `token ${apiKey}:${session.access_token}`;
    let body;
    if (form) { body = new URLSearchParams(form).toString(); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    let res;
    try { res = await fetch(API + p, { method, headers, body, signal: AbortSignal.timeout(25000) }); } catch (e) { throw new KiteError('Could not reach Kite: ' + e.message, 502, 'NETWORK'); }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) {
      if (!res.ok) throw new KiteError(`Kite returned HTTP ${res.status}`, 502);
      return res.text();
    }
    const j = await res.json();
    if (!res.ok || j.status === 'error') {
      if (j.error_type === 'TokenException') { await clear(); throw new KiteError('Kite session expired — reconnect from Settings', 401, 'TOKEN'); }
      if (j.error_type === 'PermissionException') throw new KiteError(j.message + ' (live quotes need the paid Kite Connect plan)', 403, 'PERMISSION');
      throw new KiteError(j.message || `Kite returned HTTP ${res.status}`, res.status >= 400 && res.status < 500 ? 400 : 502, j.error_type);
    }
    return j.data;
  }

  const requireLive = () => { if (!isLive()) throw new KiteError('Kite is not connected — connect from Settings', 401, 'TOKEN'); };

  // Instrument master: downloaded once per day, cached on disk.
  let instruments = null; let instDay = null; let loading = null;
  async function ensureInstruments() {
    const today = istDate();
    if (instruments && instDay === today) return instruments;
    if (!loading) {
      loading = (async () => {
        try {
          const cached = await storage.get('kite-instruments');
          if (cached?.day === today && cached.v === 2) { instruments = cached.list; instDay = today; return instruments; }
        } catch { /* refetch */ }
        const list = [];
        for (const ex of INSTRUMENT_EXCHANGES) list.push(...parseExchange(ex, await call(`/instruments/${ex}`)));
        instruments = list; instDay = today;
        await storage.put('kite-instruments', { v: 2, day: today, list });
        return list;
      })().finally(() => { loading = null; });
    }
    return loading;
  }

  return {
    /** Load the saved login. Call once before use (every request on Cloudflare). */
    async init() { try { session = (await storage.get('kite-session')) || null; } catch { session = null; } },
    status() {
      return {
        configured, connected: isLive(), mock: false, clientSearch,
        user: isLive() ? { id: session.user_id, name: session.user_name } : null,
        expiresAt: isLive() ? session.expiresAt : null,
      };
    },
    loginUrl() {
      if (!configured) throw new KiteError('Add KITE_API_KEY and KITE_API_SECRET (.env locally, secrets on Cloudflare)', 400, 'NOT_CONFIGURED');
      return `${LOGIN}?v=3&api_key=${encodeURIComponent(apiKey)}`;
    },
    async exchange(requestToken) {
      const checksum = await sha256hex(apiKey + requestToken + apiSecret);
      const d = await call('/session/token', { method: 'POST', auth: false, form: { api_key: apiKey, request_token: requestToken, checksum } });
      session = {
        access_token: d.access_token, user_id: d.user_id, user_name: d.user_name || d.user_shortname,
        loginTime: new Date().toISOString(), expiresAt: nextExpiry(),
      };
      await storage.put('kite-session', session);
      return session;
    },
    async logout() {
      if (session?.access_token) {
        try { await call(`/session/token?api_key=${encodeURIComponent(apiKey)}&access_token=${encodeURIComponent(session.access_token)}`, { method: 'DELETE' }); } catch { /* ignore */ }
      }
      await clear();
    },
    async quotes(keys) {
      requireLive();
      const out = {};
      for (let i = 0; i < keys.length; i += 500) {
        const qs = keys.slice(i, i + 500).map((k) => 'i=' + encodeURIComponent(k)).join('&');
        const d = await call('/quote/ohlc?' + qs);
        for (const [k, v] of Object.entries(d || {})) {
          const prev = v.ohlc?.close || null;
          out[k] = { last: v.last_price, prevClose: prev, changePct: prev ? (v.last_price - prev) / prev : null, at: new Date().toISOString() };
        }
      }
      return out;
    },
    async search(q) {
      requireLive();
      if (clientSearch) throw new KiteError('Search runs in the browser on this server', 400, 'CLIENT_SEARCH');
      return searchInstruments(await ensureInstruments(), q);
    },
    /** Kite's historical-candle response for one instrument token, passed through untouched
     *  (the browser parses it — used to build market breadth from 500 stocks). */
    async rawCandles({ token, interval, from, to }) {
      requireLive();
      const qs = new URLSearchParams({ from: kiteDate(from), to: kiteDate(to) });
      const res = await fetch(`${API}/instruments/historical/${Number(token)}/${interval}?${qs}`, { headers: { 'X-Kite-Version': '3', Authorization: `token ${apiKey}:${session.access_token}` }, signal: AbortSignal.timeout(25000) });
      if (res.status === 403) { await clear(); throw new KiteError('Kite session expired — reconnect from Settings', 401, 'TOKEN'); }
      return res;
    },
    /** Instrument tokens for symbols (local server; the hosted version looks them up in the browser). */
    async tokens(exchange, symbols) {
      requireLive();
      const list = await ensureInstruments();
      const by = new Map(list.filter((i) => i.e === exchange).map((i) => [i.s, i.k]));
      return Object.fromEntries(symbols.map((s) => [s, by.get(s) ?? null]));
    },
    /** Raw instrument CSV for one exchange, for the browser to parse (a fetch Response). */
    async instrumentsCsv(ex) {
      requireLive();
      if (!INSTRUMENT_EXCHANGES.includes(ex)) throw new KiteError('Unknown exchange', 400);
      const res = await fetch(`${API}/instruments/${ex}`, { headers: { 'X-Kite-Version': '3', Authorization: `token ${apiKey}:${session.access_token}` }, signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new KiteError(`Kite returned HTTP ${res.status}`, 502);
      return res;
    },
    async candles({ exchange, symbol, interval, from, to, token }) {
      requireLive();
      let k = Number(token) || null;
      if (!k) {
        if (clientSearch) throw new KiteError('Instrument token missing — reload the page', 400, 'NO_TOKEN');
        const inst = (await ensureInstruments()).find((i) => i.e === exchange && i.s === symbol);
        if (!inst) throw new KiteError(`${exchange}:${symbol} isn't in today's Kite instrument list (expired contract?)`, 404, 'NO_INSTRUMENT');
        k = inst.k;
      }
      const qs = new URLSearchParams({ from: kiteDate(from), to: kiteDate(to) });
      const d = await call(`/instruments/historical/${k}/${interval}?${qs}`);
      return parseKiteCandles(d?.candles);
    },
    async portfolio() {
      requireLive();
      const [h, p, mf] = await Promise.all([call('/portfolio/holdings'), call('/portfolio/positions'), call('/mf/holdings').catch(() => [])]);
      return {
        mf: (mf || []).map((x) => ({ symbol: x.tradingsymbol, fund: x.fund, qty: x.quantity, avgPrice: x.average_price, lastPrice: x.last_price, lastPriceDate: x.last_price_date })),
        holdings: (h || []).map((x) => ({ symbol: x.tradingsymbol, exchange: x.exchange, product: 'CNC', qty: (x.quantity || 0) + (x.t1_quantity || 0), avgPrice: x.average_price, lastPrice: x.last_price })),
        positions: (p?.net || []).map((x) => ({ symbol: x.tradingsymbol, exchange: x.exchange, product: x.product, qty: x.quantity, avgPrice: x.average_price, lastPrice: x.last_price, buyPrice: x.buy_price, sellPrice: x.sell_price })),
      };
    },
    async fills() {
      requireLive();
      const d = await call('/trades');
      return (d || []).map((f) => ({
        id: f.trade_id, orderId: f.order_id, symbol: f.tradingsymbol, exchange: f.exchange,
        side: f.transaction_type, qty: f.quantity, price: f.average_price, product: f.product,
        time: kiteTime(f.fill_timestamp || f.exchange_timestamp || f.order_timestamp),
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// Demo mode: simulated random-walk prices for a few well-known instruments.
// ---------------------------------------------------------------------------
const DEMO_LIST = [
  ['RELIANCE', 'NSE', 'RELIANCE INDUSTRIES', 'EQ', 1, 1420], ['TCS', 'NSE', 'TATA CONSULTANCY SERV', 'EQ', 1, 3150],
  ['INFY', 'NSE', 'INFOSYS', 'EQ', 1, 1520], ['HDFCBANK', 'NSE', 'HDFC BANK', 'EQ', 1, 990],
  ['ICICIBANK', 'NSE', 'ICICI BANK', 'EQ', 1, 1380], ['SBIN', 'NSE', 'STATE BANK OF INDIA', 'EQ', 1, 870],
  ['ITC', 'NSE', 'ITC', 'EQ', 1, 410], ['TATAMOTORS', 'NSE', 'TATA MOTORS', 'EQ', 1, 690],
  ['BHARTIARTL', 'NSE', 'BHARTI AIRTEL', 'EQ', 1, 1980], ['LT', 'NSE', 'LARSEN & TOUBRO', 'EQ', 1, 3700],
  ['AXISBANK', 'NSE', 'AXIS BANK', 'EQ', 1, 1170], ['TITAN', 'NSE', 'TITAN COMPANY', 'EQ', 1, 3500],
  ['DIXON', 'NSE', 'DIXON TECHNOLOGIES', 'EQ', 1, 15600], ['TRENT', 'NSE', 'TRENT', 'EQ', 1, 4900],
  ['RELIANCE26DECFUT', 'NFO', 'RELIANCE', 'FUT', 500, 1425], ['SBIN26DECFUT', 'NFO', 'SBIN', 'FUT', 750, 873],
  ['NIFTY26DECFUT', 'NFO', 'NIFTY', 'FUT', 75, 25900], ['BANKNIFTY26DECFUT', 'NFO', 'BANKNIFTY', 'FUT', 35, 58200],
  ['GOLDM26DECFUT', 'MCX', 'GOLDM', 'FUT', 10, 122000], ['CRUDEOIL26DECFUT', 'MCX', 'CRUDEOIL', 'FUT', 100, 5300],
];

function createMock(getTrades) {
  const px = new Map();
  const base = (k) => {
    const [ex, sym] = k.split(':');
    const hit = DEMO_LIST.find((d) => d[0] === sym && d[1] === ex);
    if (hit) return hit[5];
    let h = 0; for (const c of k) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return 100 + (h % 2900);
  };
  const tick = (k) => {
    const b = base(k);
    let p = px.get(k) ?? b * (1 + (Math.random() - 0.5) * 0.03);
    p *= 1 + (Math.random() - 0.5) * 0.004;
    p = Math.round(p * 20) / 20;
    px.set(k, p);
    return { last: p, prevClose: b, changePct: (p - b) / b, at: new Date().toISOString() };
  };
  return {
    init: async () => {},
    instrumentsCsv: async () => { throw new KiteError('Not available in demo mode', 400); },
    tokens: async (exchange, symbols) => Object.fromEntries(symbols.map((s, i) => [s, 900000 + i])),
    rawCandles: async ({ token, interval, from, to }) => {
      const k = Number(token) || 1;
      const px = k === 256265 ? 20000 : 50 + ((k * 7919) % 2950);
      const fake = { id: `raw${k}${interval}`, entryTime: new Date(from + (to - from) * 0.5).toISOString(), entryPrice: px, initialStop: px * 0.8, status: 'OPEN' };
      const candles = mockCandles(fake, { interval, from, to }).map((c) => [new Date(c[0] + 330 * 60000).toISOString().replace('Z', '+0530'), c[1], c[2], c[3], c[4], c[5]]);
      return new Response(JSON.stringify({ status: 'success', data: { candles } }), { headers: { 'Content-Type': 'application/json' } });
    },
    status: () => ({ configured: true, connected: true, mock: true, clientSearch: false, user: { id: 'DEMO', name: 'Demo prices' }, expiresAt: null }),
    loginUrl: () => '/#/settings',
    exchange: async () => ({}),
    logout: async () => {},
    quotes: async (keys) => Object.fromEntries(keys.map((k) => [k, tick(k)])),
    search: async (q) => searchInstruments(
      DEMO_LIST.map(([s, e, n, t, l]) => ({ s, e, n, t, l, x: t === 'FUT' ? '2026-12-29' : '' })), q),
    candles: async ({ trade, plan }) => mockCandles(trade, plan),
    // Demo portfolio mirrors your open demo trades with a few deliberate differences,
    // so every sync status shows up: match, qty mismatch, closed at broker, unlogged.
    portfolio: async () => {
      const open = getTrades().filter((t) => t.status === 'OPEN').sort((a, b) => a.entryTime.localeCompare(b.entryTime));
      const holdings = []; const positions = [];
      open.forEach((t, i) => {
        const q = tick(`${t.exchange}:${t.symbol}`).last;
        const signed = (t.side === 'SHORT' ? -1 : 1) * t.qty;
        const row = { symbol: t.symbol, exchange: t.exchange, avgPrice: t.entryPrice, lastPrice: q };
        if (i === 1) { positions.push({ ...row, product: 'NRML', qty: 0, buyPrice: t.entryPrice, sellPrice: q }); return; } // closed at broker
        const qty = i === 2 ? signed * 2 : signed; // qty mismatch
        if (t.segment === 'EQ' && qty > 0) holdings.push({ ...row, product: 'CNC', qty });
        else positions.push({ ...row, product: 'NRML', qty });
      });
      holdings.push({ symbol: 'TATAPOWER', exchange: 'NSE', product: 'CNC', qty: 50, avgPrice: 402.5, lastPrice: tick('NSE:TATAPOWER').last });
      return { holdings, positions };
    },
    fills: async () => {
      const now = Date.now();
      return [
        { id: 'D1', orderId: 'O1', symbol: 'ITC', exchange: 'NSE', side: 'BUY', qty: 100, price: tick('NSE:ITC').last, product: 'CNC', time: new Date(now - 3600e3).toISOString() },
        { id: 'D2', orderId: 'O2', symbol: 'SBIN26DECFUT', exchange: 'NFO', side: 'SELL', qty: 750, price: tick('NFO:SBIN26DECFUT').last, product: 'NRML', time: new Date(now - 1800e3).toISOString() },
      ];
    },
  };
}
