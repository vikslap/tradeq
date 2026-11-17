// Zerodha Kite Connect v3 client (login flow, quotes, instrument search, today's fills)
// plus a "demo" mock with simulated prices so the app can be tried without an API key.
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const API = 'https://api.kite.trade';
const LOGIN = 'https://kite.zerodha.com/connect/login';
const INSTRUMENT_EXCHANGES = ['NSE', 'BSE', 'NFO', 'MCX'];

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

export function segmentFor(exchange, type, symbol = '') {
  if (exchange === 'NSE' || exchange === 'BSE') return 'EQ';
  if (exchange === 'CDS') return 'CUR';
  const t = type || (/FUT$/.test(symbol) ? 'FUT' : /(CE|PE)$/.test(symbol) ? 'CE' : 'FUT');
  if (t === 'CE' || t === 'PE') return 'OPT';
  return exchange === 'MCX' ? 'COM' : 'FUT';
}

function splitCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseInstruments(csv) {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const head = splitCsvLine(lines[0]);
  const ix = (k) => head.indexOf(k);
  const [S, N, E, T, L, X] = ['tradingsymbol', 'name', 'exchange', 'instrument_type', 'lot_size', 'expiry'].map(ix);
  return lines.slice(1).map((l) => {
    const c = splitCsvLine(l);
    return { s: c[S], n: c[N], e: c[E], t: c[T], l: Number(c[L]) || 1, x: c[X] || '' };
  });
}

const EX_RANK = { NSE: 0, NFO: 1, MCX: 2, BSE: 3 };
function searchInstruments(list, q, limit = 15) {
  const Q = String(q || '').toUpperCase().trim();
  if (!Q) return [];
  const hits = [];
  for (const i of list) {
    const s = i.s; const n = (i.n || '').toUpperCase();
    let score;
    if (s === Q) score = 0;
    else if (s.startsWith(Q)) score = 1;
    else if (n.startsWith(Q)) score = 2;
    else if (s.includes(Q)) score = 3;
    else if (n.includes(Q)) score = 4;
    else continue;
    // Prefer cash & futures over the long tail of option strikes.
    if (i.t === 'CE' || i.t === 'PE') score += 2;
    hits.push({ i, score });
  }
  hits.sort((a, b) => a.score - b.score || (EX_RANK[a.i.e] ?? 9) - (EX_RANK[b.i.e] ?? 9) || (a.i.x || '').localeCompare(b.i.x || '') || a.i.s.length - b.i.s.length);
  return hits.slice(0, limit).map(({ i }) => ({
    symbol: i.s, exchange: i.e, name: i.n, type: i.t, lotSize: i.l, expiry: i.x || null, segment: segmentFor(i.e, i.t, i.s),
  }));
}

export function createKite({ apiKey, apiSecret, dataDir, mock }) {
  if (mock) return createMock();

  const sessFile = path.join(dataDir, 'kite-session.json');
  const instFile = path.join(dataDir, 'kite-instruments.json');
  let session = null;
  try { if (existsSync(sessFile)) session = JSON.parse(readFileSync(sessFile, 'utf8')); } catch { session = null; }
  const configured = Boolean(apiKey && apiSecret);
  const isLive = () => Boolean(session?.access_token && new Date(session.expiresAt) > new Date());
  const clear = () => { session = null; try { unlinkSync(sessFile); } catch { /* none */ } };

  async function call(p, { method = 'GET', form, auth = true } = {}) {
    if (!configured) throw new KiteError('Add KITE_API_KEY and KITE_API_SECRET to .env and restart', 400, 'NOT_CONFIGURED');
    const headers = { 'X-Kite-Version': '3' };
    if (auth && session?.access_token) headers.Authorization = `token ${apiKey}:${session.access_token}`;
    let body;
    if (form) { body = new URLSearchParams(form).toString(); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    let res;
    try { res = await fetch(API + p, { method, headers, body }); } catch (e) { throw new KiteError('Could not reach Kite: ' + e.message, 502, 'NETWORK'); }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) {
      if (!res.ok) throw new KiteError(`Kite returned HTTP ${res.status}`, 502);
      return res.text();
    }
    const j = await res.json();
    if (!res.ok || j.status === 'error') {
      if (j.error_type === 'TokenException') { clear(); throw new KiteError('Kite session expired — reconnect from Settings', 401, 'TOKEN'); }
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
          if (existsSync(instFile)) {
            const cached = JSON.parse(readFileSync(instFile, 'utf8'));
            if (cached.day === today) { instruments = cached.list; instDay = today; return instruments; }
          }
        } catch { /* refetch */ }
        const list = [];
        for (const ex of INSTRUMENT_EXCHANGES) {
          const csv = await call(`/instruments/${ex}`);
          list.push(...parseInstruments(String(csv)).filter((i) => !(ex === 'BSE' && i.t !== 'EQ')));
        }
        instruments = list; instDay = today;
        writeFileSync(instFile, JSON.stringify({ day: today, list }));
        return list;
      })().finally(() => { loading = null; });
    }
    return loading;
  }

  return {
    status() {
      return {
        configured, connected: isLive(), mock: false,
        user: isLive() ? { id: session.user_id, name: session.user_name } : null,
        expiresAt: isLive() ? session.expiresAt : null,
      };
    },
    loginUrl() {
      if (!configured) throw new KiteError('Add KITE_API_KEY and KITE_API_SECRET to .env and restart', 400, 'NOT_CONFIGURED');
      return `${LOGIN}?v=3&api_key=${encodeURIComponent(apiKey)}`;
    },
    async exchange(requestToken) {
      const checksum = crypto.createHash('sha256').update(apiKey + requestToken + apiSecret).digest('hex');
      const d = await call('/session/token', { method: 'POST', auth: false, form: { api_key: apiKey, request_token: requestToken, checksum } });
      session = {
        access_token: d.access_token, user_id: d.user_id, user_name: d.user_name || d.user_shortname,
        loginTime: new Date().toISOString(), expiresAt: nextExpiry(),
      };
      writeFileSync(sessFile, JSON.stringify(session, null, 2));
      return session;
    },
    async logout() {
      if (session?.access_token) {
        try { await call(`/session/token?api_key=${encodeURIComponent(apiKey)}&access_token=${encodeURIComponent(session.access_token)}`, { method: 'DELETE' }); } catch { /* ignore */ }
      }
      clear();
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
      return searchInstruments(await ensureInstruments(), q);
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

function createMock() {
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
    status: () => ({ configured: true, connected: true, mock: true, user: { id: 'DEMO', name: 'Demo prices' }, expiresAt: null }),
    loginUrl: () => '/#/settings',
    exchange: async () => ({}),
    logout: async () => {},
    quotes: async (keys) => Object.fromEntries(keys.map((k) => [k, tick(k)])),
    search: async (q) => searchInstruments(
      DEMO_LIST.map(([s, e, n, t, l]) => ({ s, e, n, t, l, x: t === 'FUT' ? '2026-12-29' : '' })), q),
    fills: async () => {
      const now = Date.now();
      return [
        { id: 'D1', orderId: 'O1', symbol: 'ITC', exchange: 'NSE', side: 'BUY', qty: 100, price: tick('NSE:ITC').last, product: 'CNC', time: new Date(now - 3600e3).toISOString() },
        { id: 'D2', orderId: 'O2', symbol: 'SBIN26DECFUT', exchange: 'NFO', side: 'SELL', qty: 750, price: tick('NFO:SBIN26DECFUT').last, product: 'NRML', time: new Date(now - 1800e3).toISOString() },
      ];
    },
  };
}
