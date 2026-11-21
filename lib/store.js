// Journal store: validation, migrations and every change to the journal.
// Storage-agnostic: the local server saves to a JSON file (store-file.js), the
// Cloudflare Worker saves to D1. Both hand the state in with load() and set a saver.
const randomUUID = () => globalThis.crypto.randomUUID();
import { ledgerKey } from '../public/ledger.js';

export const DEFAULT_SETTINGS = {
  displayName: 'Trader',
  capital: 100000,
  riskPctPerTrade: 1, // position-size calculator default: % of capital risked per trade
  maxRiskPerTrade: 2000,
  maxTradesPerDay: 3,
  revengeWindowMins: 30,
  maxDailyLoss: 4000,
  maxPortfolioHeatPct: 6,
  maxPositionPct: 30,
  chaseTolerancePct: 1,
  syncIgnore: [],
  accountValue: null, // { value, date } — typed in when Kite isn't connected
  benchmarkScheme: '120716', // AMFI code: UTI Nifty 50 Index Fund — Direct Growth
  indexLists: null, // { nifty500: [...], nifty500AsOf, nifty50: [...] } — uploaded NSE lists for market breadth
  symbolRenames: [], // [{ from: 'ACRYSIL', to: 'CARYSIL' }] — company renames, applied to imports
};

const HORIZONS = ['INTRADAY', 'SWING', 'POSITIONAL', 'LONGTERM'];
const localDay = (iso) => new Date(iso).toLocaleDateString('en-CA');

const heldDays = (t, now = Date.now()) => ((t.status === 'CLOSED' && t.exitTime ? new Date(t.exitTime).getTime() : now) - new Date(t.entryTime).getTime()) / 86400000;

/** Trades without a type: same-day = Intraday, up to 20 days = Swing, over a year = Long-term, else Positional. */
export function guessHorizon(t, now = Date.now()) {
  if (t.status === 'CLOSED' && t.exitTime && localDay(t.exitTime) === localDay(t.entryTime)) return 'INTRADAY';
  const d = heldDays(t, now);
  return d > 365 ? 'LONGTERM' : d <= 20 ? 'SWING' : 'POSITIONAL';
}

export class HttpError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

let state;
let saver = () => {};

/** Load a journal object (parsed JSON, or {} for a new journal) and migrate it. */
export function load(obj) {
  state = obj && typeof obj === 'object' ? obj : {};
  normalise();
  return state;
}
/** Called with the full state after every change. */
export function setSaver(fn) { saver = fn; }

function normalise() {
  state.version = 1;
  state.settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
  state.trades = Array.isArray(state.trades) ? state.trades : [];
  state.reviews = Array.isArray(state.reviews) ? state.reviews : [];
  state.groups = Array.isArray(state.groups) ? state.groups : [];
  state.ledger = Array.isArray(state.ledger) ? state.ledger : [];
  // One-time: imported trades held over a year become Long-term (earlier imports never used that type).
  state.migrations = state.migrations && typeof state.migrations === 'object' ? state.migrations : {};
  if (!state.migrations.longTermOverAYear) {
    let n = 0;
    for (const t of state.trades) if (t.imported && t.horizon !== 'LONGTERM' && heldDays(t) > 365) { t.horizon = 'LONGTERM'; n++; }
    state.migrations.longTermOverAYear = { at: new Date().toISOString(), count: n };
  }
  state.ledger.sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.seq || 0) - (b.seq || 0));
  state.practice = state.practice && Array.isArray(state.practice.sessions) ? state.practice : { sessions: [] };
  pruneGroups();
  for (const t of state.trades) {
    // Repair F&O trades an earlier tradebook import labelled as NSE/BSE cash equity.
    const fut = /\d{2}[A-Z]{3}FUT$/.test(t.symbol || ''); const opt = /\d(CE|PE)$/.test(t.symbol || '');
    if ((fut || opt) && (t.exchange === 'NSE' || t.exchange === 'BSE')) { t.exchange = t.exchange === 'BSE' ? 'BFO' : 'NFO'; t.segment = opt ? 'OPT' : 'FUT'; }
    if (!HORIZONS.includes(t.horizon)) t.horizon = guessHorizon(t);
    if (!Array.isArray(t.thesisReviews)) t.thesisReviews = [];
    // Partial-exit model: older trades get their single exit as a one-item list.
    if (!Array.isArray(t.exits)) t.exits = t.status === 'CLOSED' && t.exitPrice != null ? [{ id: randomUUID(), qty: t.qty, price: t.exitPrice, time: t.exitTime, source: t.exitSource || 'manual' }] : [];
  }
  if (!Array.isArray(state.settings.syncIgnore)) state.settings.syncIgnore = [];
  if (!Array.isArray(state.settings.symbolRenames)) state.settings.symbolRenames = [];
}

function save() { saver(state); }

export const getState = () => state;

// ---------- field helpers ----------
const num = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const str = (v, max = 5000) => (v === null || v === undefined ? '' : String(v).trim().slice(0, max));
const iso = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };
const oneOf = (v, list, def) => (list.includes(v) ? v : def);

const SEGMENTS = ['EQ', 'FUT', 'OPT', 'COM', 'CUR'];
const EXCHANGES = ['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS'];
const SOURCES = ['manual', 'live', 'kite-fill'];

function applyFields(t, b) {
  if ('symbol' in b) t.symbol = str(b.symbol, 60).toUpperCase();
  if ('exchange' in b) t.exchange = oneOf(str(b.exchange).toUpperCase(), EXCHANGES, 'NSE');
  if ('segment' in b) t.segment = oneOf(b.segment, SEGMENTS, 'EQ');
  if ('side' in b) t.side = oneOf(b.side, ['LONG', 'SHORT'], 'LONG');
  if ('horizon' in b) t.horizon = oneOf(b.horizon, HORIZONS, t.horizon || 'SWING');
  for (const k of ['qty', 'entryPrice', 'plannedEntry', 'mfePrice', 'maePrice', 'target', 'exitPrice', 'charges', 'confidence', 'rating', 'lotSize', 'entryOrders']) if (k in b) t[k] = num(b[k]);
  for (const k of ['sellCondition', 'setup', 'thesis', 'emotionEntry', 'emotionExit', 'exitReason', 'lessons', 'screenshotUrl', 'notes']) if (k in b) t[k] = str(b[k]);
  for (const k of ['entrySource', 'exitSource']) if (k in b) t[k] = oneOf(b[k], SOURCES, 'manual');
  for (const k of ['entryTime', 'exitTime']) if (k in b) t[k] = iso(b[k]);
  if ('followedPlan' in b) t.followedPlan = b.followedPlan === true ? true : b.followedPlan === false ? false : null;
  if ('mistakes' in b) t.mistakes = Array.isArray(b.mistakes) ? [...new Set(b.mistakes.map((x) => str(x, 30)).filter((x) => /^[a-zA-Z]+$/.test(x)))].slice(0, 12) : [];
  if ('tags' in b) t.tags = Array.isArray(b.tags) ? b.tags.map((x) => str(x, 40)).filter(Boolean).slice(0, 20) : [];
}

function validate(t) {
  if (!t.symbol) throw new HttpError('Symbol is required');
  if (!(t.qty > 0)) throw new HttpError('Quantity must be greater than 0');
  if (!(t.entryPrice > 0)) throw new HttpError('Entry price must be greater than 0');
  if (!t.entryTime) throw new HttpError('Entry time is required');
  if (t.initialStop != null) {
    if (t.side === 'LONG' && t.initialStop >= t.entryPrice) throw new HttpError('For a long trade the initial stop-loss must be below entry');
    if (t.side === 'SHORT' && t.initialStop <= t.entryPrice) throw new HttpError('For a short trade the initial stop-loss must be above entry');
  }
  if (t.stopLoss != null && !(t.stopLoss > 0)) throw new HttpError('Stop-loss must be a positive price');
  if (t.status === 'CLOSED') {
    if (!(t.exitPrice > 0 || (t.segment === 'OPT' && t.exitPrice === 0))) throw new HttpError('Exit price is required to close a trade (options that expired worthless can close at 0)');
    if (!(t.exits || []).length) throw new HttpError('A closed trade needs at least one exit');
    if (!t.exitTime) throw new HttpError('Exit time is required to close a trade');
    if (new Date(t.exitTime) < new Date(t.entryTime)) throw new HttpError('Exit time is before entry time');
  }
}

// ---------- exits (partial or full) ----------
const cleanExit = (e) => ({ id: str(e.id, 64) || randomUUID(), qty: num(e.qty), price: num(e.price), time: iso(e.time), source: oneOf(e.source, SOURCES, 'manual') });

/** Sort exits, check them, and derive status / average exit price / exit time. */
function applyExits(t) {
  t.exits = (Array.isArray(t.exits) ? t.exits : []).map(cleanExit).filter((e) => e.qty > 0 && e.price != null && e.time).sort((a, b) => a.time.localeCompare(b.time));
  const q = t.exits.reduce((a, e) => a + e.qty, 0);
  if (t.qty != null && q > t.qty + 1e-9) throw new HttpError(`Exits add up to ${q}, more than the ${t.qty} in this trade`);
  if (t.entryTime && t.exits.some((e) => e.time < t.entryTime)) throw new HttpError('Exit time is before entry time');
  if (t.exits.some((e) => !(e.price > 0) && !(t.segment === 'OPT' && e.price === 0))) throw new HttpError('Exit price must be greater than 0 (options that expired worthless can exit at 0)');
  if (q > 0 && t.qty != null && q >= t.qty - 1e-9) {
    t.status = 'CLOSED';
    t.exitPrice = Math.round((t.exits.reduce((a, e) => a + e.price * e.qty, 0) / q) * 100) / 100;
    t.exitTime = t.exits.at(-1).time;
    t.exitSource = t.exits.at(-1).source;
  } else {
    t.status = 'OPEN'; t.exitPrice = null; t.exitTime = null;
  }
}
const exitedQty = (t) => (t.exits || []).reduce((a, e) => a + (e.qty || 0), 0);

const widened = (side, from, to) => (side === 'SHORT' ? to > from : to < from);

// ---------- trades ----------
export function createTrade(b, { persist = true } = {}) {
  const now = new Date().toISOString();
  const t = {
    id: randomUUID(), status: 'OPEN', exchange: 'NSE', segment: 'EQ', side: 'LONG',
    horizon: 'SWING', entrySource: 'manual', entryTime: now, tags: [], stopWidenCount: 0, stopHistory: [], thesisReviews: [],
    createdAt: now, updatedAt: now,
  };
  applyFields(t, b);
  t.stopLoss = num(b.stopLoss);
  t.initialStop = t.stopLoss;
  t.stopSetAtEntry = t.stopLoss != null;
  t.entryOrders = Math.max(1, Math.round(num(b.entryOrders) || 1));
  if (Array.isArray(b.exits)) t.exits = b.exits;
  else if (b.status === 'CLOSED' && num(b.exitPrice) != null) t.exits = [{ qty: t.qty, price: num(b.exitPrice), time: b.exitTime, source: b.exitSource }];
  else t.exits = [];
  applyExits(t);
  validate(t);
  state.trades.push(t);
  if (persist) save();
  return t;
}

// ---------- tradebook import ----------
const fillIdList = (v) => (Array.isArray(v) ? v.map((x) => str(x, 64)).filter(Boolean).slice(0, 500) : []);

/**
 * Apply a reviewed tradebook import in one go:
 *  create: new trades (marked imported: no XP, counted in P&L/stats)
 *  updates: [{ id, entryTime, entryPrice, fillIds }] real entry date/price for open trades
 *  closes:  [{ id, exitPrice, exitTime, fillIds }] journal trades sold per the tradebook
 */
export function importTradebook({ create = [], updates = [], closes = [], remove = [] }) {
  const snapshot = structuredClone(state.trades);
  try {
    let created = 0; let updated = 0; let closed = 0; let removed = 0;
    // Only earlier *imported* trades can be replaced (re-paired); journaled trades are never deleted here.
    const drop = new Set(remove);
    const before = state.trades.length;
    state.trades = state.trades.filter((t) => !(drop.has(t.id) && t.imported));
    removed = before - state.trades.length;
    for (const b of create.slice(0, 5000)) {
      const t = createTrade({ ...b, entrySource: 'kite-fill', stopLoss: null, status: Array.isArray(b.exits) ? undefined : b.status }, { persist: false });
      t.imported = true;
      t.fillIds = fillIdList(b.fillIds);
      created++;
    }
    for (const u of updates) {
      const t = state.trades.find((x) => x.id === u.id);
      if (!t) continue;
      const d = structuredClone(t);
      d.entryTime = iso(u.entryTime) || d.entryTime;
      if (num(u.entryPrice) > 0) d.entryPrice = num(u.entryPrice);
      if (d.initialStop != null && ((d.side === 'LONG' && d.initialStop >= d.entryPrice) || (d.side === 'SHORT' && d.initialStop <= d.entryPrice))) d.entryPrice = t.entryPrice;
      d.fillIds = [...new Set([...(t.fillIds || []), ...fillIdList(u.fillIds)])];
      validate(d);
      Object.assign(t, d, { updatedAt: new Date().toISOString() });
      updated++;
    }
    for (const c of closes) {
      const t = state.trades.find((x) => x.id === c.id);
      if (!t || t.status !== 'OPEN') continue;
      const d = structuredClone(t);
      d.exits = [...(d.exits || []), { qty: d.qty - exitedQty(d), price: num(c.exitPrice), time: c.exitTime, source: 'kite-fill' }];
      applyExits(d);
      d.fillIds = [...new Set([...(t.fillIds || []), ...fillIdList(c.fillIds)])];
      validate(d);
      Object.assign(t, d, { updatedAt: new Date().toISOString() });
      closed++;
    }
    save();
    return { created, updated, closed, removed };
  } catch (e) {
    state.trades = snapshot; // all or nothing
    throw e;
  }
}

export function updateTrade(id, b) {
  const t = state.trades.find((x) => x.id === id);
  if (!t) throw new HttpError('Trade not found', 404);
  const draft = structuredClone(t);
  applyFields(draft, b);
  if ('stopLoss' in b) {
    const ns = num(b.stopLoss);
    if (b.correction) {
      // Fixing a typo in the original stop: no penalty, initial risk changes too.
      draft.initialStop = ns;
    } else if (ns !== t.stopLoss) {
      if (t.stopLoss != null && ns != null && widened(draft.side, t.stopLoss, ns)) draft.stopWidenCount = (draft.stopWidenCount || 0) + 1;
      if (draft.initialStop == null && ns != null) draft.initialStop = ns; // stop added after entry
      draft.stopHistory = [...(draft.stopHistory || []), { at: new Date().toISOString(), from: t.stopLoss, to: ns }];
    }
    draft.stopLoss = ns;
  }
  // Exits: add one (partial or final), replace the list, legacy close, or reopen.
  if (b.addExit) {
    const remaining = draft.qty - exitedQty(draft);
    draft.exits = [...(draft.exits || []), { ...b.addExit, qty: num(b.addExit.qty) ?? remaining }];
  } else if (Array.isArray(b.exits)) {
    draft.exits = b.exits;
  } else if (b.status === 'OPEN') {
    draft.exits = [];
  } else if (b.status === 'CLOSED' && 'exitPrice' in b) {
    const ex = draft.exits || [];
    const e = { price: num(b.exitPrice), time: b.exitTime || draft.exitTime, source: b.exitSource };
    // Editing the exit of a single-exit trade updates it; otherwise close what's left.
    draft.exits = t.status === 'CLOSED' && ex.length === 1 ? [{ ...ex[0], ...e }] : [...ex, { ...e, qty: draft.qty - exitedQty(draft) }];
  }
  applyExits(draft);
  if (b.status === 'CLOSED' && draft.status !== 'CLOSED') throw new HttpError('Exit price is required to close a trade');
  validate(draft);
  draft.updatedAt = new Date().toISOString();
  Object.assign(t, draft);
  save();
  return t;
}

export function deleteTrade(id) {
  const i = state.trades.findIndex((x) => x.id === id);
  if (i < 0) throw new HttpError('Trade not found', 404);
  state.trades.splice(i, 1);
  pruneGroups();
  save();
}

// ---------- funds ledger (money in/out, account fees) ----------
const hashId = (s) => { let h1 = 0x811c9dc5; let h2 = 0x01000193; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 ^ c, 2246822519); } return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36); };

/** Add ledger entries (from one or more CSV files). Entries already present are skipped. */
export function importLedger(b) {
  const rows = Array.isArray(b?.rows) ? b.rows : null;
  if (!rows) throw new HttpError('rows required');
  if (rows.length > 50000) throw new HttpError('Too many ledger rows in one go');
  const have = new Set(state.ledger.map((r) => r.id));
  let seq = state.ledger.reduce((m, r) => Math.max(m, r.seq || 0), 0);
  let added = 0;
  for (const r of rows) {
    const e = { date: str(r.date, 10), particulars: str(r.particulars, 300), costCenter: str(r.costCenter, 40), voucher: str(r.voucher, 40), debit: num(r.debit) || 0, credit: num(r.credit) || 0, balance: num(r.balance) };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date) || !e.particulars) continue;
    const id = hashId(ledgerKey(e));
    if (have.has(id)) continue;
    have.add(id); state.ledger.push({ id, seq: ++seq, ...e }); added++;
  }
  state.ledger.sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq);
  save();
  return { added, skipped: rows.length - added, total: state.ledger.length };
}

export function clearLedger() { const n = state.ledger.length; state.ledger = []; save(); return { removed: n }; }

/** Change several trades at once (currently: their type). */
export function bulkUpdate(b) {
  const ids = new Set(Array.isArray(b?.ids) ? b.ids : []);
  if (!ids.size) throw new HttpError('Select some trades first');
  if (!HORIZONS.includes(b.horizon)) throw new HttpError('Unknown type');
  let n = 0;
  for (const t of state.trades) if (ids.has(t.id) && t.horizon !== b.horizon) { t.horizon = b.horizon; t.updatedAt = new Date().toISOString(); n++; }
  save();
  return { updated: n };
}

/** Remove every trade that came from a tradebook import. Manual trades stay. */
export function deleteImported() {
  const before = state.trades.length;
  state.trades = state.trades.filter((t) => !t.imported);
  pruneGroups();
  save();
  return { removed: before - state.trades.length };
}

/** Start the journal over: no trades, reviews or links. Settings and Practice stay. */
export function resetJournal() {
  const removed = state.trades.length;
  state.trades = []; state.reviews = []; state.groups = [];
  save();
  return { removed };
}

// ---------- linked trades (pairs, spreads, hedges) ----------
/** Drop links to missing groups and groups with fewer than 2 legs. */
function pruneGroups() {
  const ids = new Set(state.groups.map((g) => g.id));
  for (const t of state.trades) if (t.groupId && !ids.has(t.groupId)) delete t.groupId;
  const count = {};
  for (const t of state.trades) if (t.groupId) count[t.groupId] = (count[t.groupId] || 0) + 1;
  state.groups = state.groups.filter((g) => (count[g.id] || 0) >= 2);
  const live = new Set(state.groups.map((g) => g.id));
  for (const t of state.trades) if (t.groupId && !live.has(t.groupId)) delete t.groupId;
}

export function createGroup(b) {
  const ids = [...new Set(Array.isArray(b.tradeIds) ? b.tradeIds : [])];
  const legs = ids.map((id) => state.trades.find((t) => t.id === id)).filter(Boolean);
  if (legs.length < 2) throw new HttpError('Pick at least two trades to link');
  const g = { id: randomUUID(), name: str(b.name, 80) || legs.map((t) => t.symbol).join(' / '), note: str(b.note, 2000), createdAt: new Date().toISOString() };
  state.groups.push(g);
  for (const t of legs) t.groupId = g.id; // a trade belongs to one group; relinking moves it
  pruneGroups();
  save();
  return g;
}

export function updateGroup(id, b) {
  const g = state.groups.find((x) => x.id === id);
  if (!g) throw new HttpError('Linked group not found', 404);
  if ('name' in b) g.name = str(b.name, 80) || g.name;
  if ('note' in b) g.note = str(b.note, 2000);
  save();
  return g;
}

export function deleteGroup(id) {
  for (const t of state.trades) if (t.groupId === id) delete t.groupId;
  state.groups = state.groups.filter((g) => g.id !== id);
  save();
}

export function unlinkTrade(id) {
  const t = state.trades.find((x) => x.id === id);
  if (!t) throw new HttpError('Trade not found', 404);
  delete t.groupId;
  pruneGroups();
  save();
}

/** Track the best (MFE) and worst (MAE) price seen while a trade is open, from live quotes. */
export function recordExcursions(quotes) {
  let changed = false;
  for (const t of state.trades) {
    if (t.status !== 'OPEN') continue;
    const q = quotes[`${t.exchange}:${t.symbol}`];
    if (!q || !(q.last > 0)) continue;
    const dir = t.side === 'SHORT' ? -1 : 1;
    if (t.mfePrice == null || (q.last - t.mfePrice) * dir > 0) { t.mfePrice = q.last; changed = true; }
    if (t.maePrice == null || (q.last - t.maePrice) * dir < 0) { t.maePrice = q.last; changed = true; }
  }
  if (changed) save();
}

/** Merge best/worst prices derived from candles (keeps whichever is more extreme). */
export function mergeExcursions(id, ex) {
  const t = state.trades.find((x) => x.id === id);
  if (!t || !ex) return false;
  const dir = t.side === 'SHORT' ? -1 : 1;
  let changed = false;
  if (ex.mfe != null && (t.mfePrice == null || (ex.mfe - t.mfePrice) * dir > 0)) { t.mfePrice = ex.mfe; changed = true; }
  if (ex.mae != null && (t.maePrice == null || (ex.mae - t.maePrice) * dir < 0)) { t.maePrice = ex.mae; changed = true; }
  if (changed) save();
  return changed;
}

// ---------- thesis reviews (long-term holdings) ----------
export function addThesisReview(id, b) {
  const t = state.trades.find((x) => x.id === id);
  if (!t) throw new HttpError('Trade not found', 404);
  const note = str(b.note, 4000);
  if (note.length < 10) throw new HttpError('Write at least a sentence on how the thesis is holding up');
  const r = { id: randomUUID(), at: iso(b.at) || new Date().toISOString(), note, thesisIntact: b.thesisIntact === false ? false : true };
  (t.thesisReviews ||= []).push(r);
  t.thesisReviews.sort((a, c) => a.at.localeCompare(c.at));
  save();
  return t;
}

export function deleteThesisReview(id, rid) {
  const t = state.trades.find((x) => x.id === id);
  if (!t) throw new HttpError('Trade not found', 404);
  t.thesisReviews = (t.thesisReviews || []).filter((r) => r.id !== rid);
  save();
  return t;
}

// ---------- practice (chart replay) — kept apart from the real journal ----------
const INTERVALS = ['5minute', '15minute', '60minute', 'day'];
const cleanPracticeTrade = (x) => ({
  side: oneOf(x.side, ['LONG', 'SHORT'], 'LONG'), qty: num(x.qty), entryPrice: num(x.entryPrice), entryBar: num(x.entryBar), entryTime: iso(x.entryTime),
  stop: num(x.stop), initialStop: num(x.initialStop), target: num(x.target), stopMoves: num(x.stopMoves) || 0, widened: num(x.widened) || 0,
  exitPrice: num(x.exitPrice), exitBar: num(x.exitBar), exitTime: iso(x.exitTime), exitReason: str(x.exitReason, 40), note: str(x.note, 1000),
});

export function createPracticeSession(b) {
  const s = {
    id: randomUUID(), status: 'active', createdAt: new Date().toISOString(),
    symbol: str(b.symbol, 60).toUpperCase(), exchange: oneOf(str(b.exchange).toUpperCase(), EXCHANGES, 'NSE'),
    interval: oneOf(b.interval, INTERVALS, 'day'), start: iso(b.start), blind: Boolean(b.blind),
    capital: num(b.capital) > 0 ? num(b.capital) : state.settings.capital, risk: num(b.risk) > 0 ? num(b.risk) : state.settings.maxRiskPerTrade,
    startIndex: null, cursor: null, trades: [], position: null, notes: '',
  };
  if (!s.symbol) throw new HttpError('Pick a symbol');
  if (!s.start) throw new HttpError('Pick a start date');
  state.practice.sessions.unshift(s);
  state.practice.sessions = state.practice.sessions.slice(0, 500);
  save();
  return s;
}

export function updatePracticeSession(id, b) {
  const s = state.practice.sessions.find((x) => x.id === id);
  if (!s) throw new HttpError('Practice session not found', 404);
  for (const k of ['cursor', 'startIndex']) if (k in b) s[k] = num(b[k]);
  if ('trades' in b && Array.isArray(b.trades)) s.trades = b.trades.slice(0, 500).map(cleanPracticeTrade);
  if ('position' in b) s.position = b.position ? cleanPracticeTrade(b.position) : null;
  if ('pending' in b) s.pending = b.pending ? { ...cleanPracticeTrade(b.pending), orderType: oneOf(b.pending.orderType, ['LIMIT', 'STOP'], 'LIMIT'), orderPrice: num(b.pending.orderPrice) } : null;
  if ('notes' in b) s.notes = str(b.notes, 4000);
  if (b.status === 'done' && s.status !== 'done') { s.status = 'done'; s.endedAt = new Date().toISOString(); }
  s.updatedAt = new Date().toISOString();
  save();
  return s;
}

export function deletePracticeSession(id) {
  state.practice.sessions = state.practice.sessions.filter((x) => x.id !== id);
  save();
}

// ---------- reviews ----------
export function upsertReview(b) {
  const weekStart = str(b.weekStart, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw new HttpError('weekStart must be YYYY-MM-DD');
  const fields = { wentWell: str(b.wentWell), improve: str(b.improve), focus: str(b.focus), rating: num(b.rating) };
  if (!fields.wentWell && !fields.improve) throw new HttpError('Write at least what went well or what to improve');
  let r = state.reviews.find((x) => x.weekStart === weekStart);
  if (r) Object.assign(r, fields, { updatedAt: new Date().toISOString() });
  else {
    r = { id: randomUUID(), weekStart, ...fields, createdAt: new Date().toISOString() };
    state.reviews.push(r);
  }
  save();
  return r;
}

export function deleteReview(id) {
  const i = state.reviews.findIndex((x) => x.id === id);
  if (i < 0) throw new HttpError('Review not found', 404);
  state.reviews.splice(i, 1);
  save();
}

// ---------- settings / import ----------
const SYM = /^[A-Z0-9&\-_.]{1,40}$/;
const cleanRenames = (list) => {
  const out = new Map();
  for (const r of list) {
    const from = str(r?.from, 40).toUpperCase().replace(/\s+/g, ''); const to = str(r?.to, 40).toUpperCase().replace(/\s+/g, '');
    if (SYM.test(from) && SYM.test(to) && from !== to) out.set(from, to);
  }
  return [...out].map(([from, to]) => ({ from, to })).slice(0, 100);
};

/** A company changed its NSE/BSE symbol: rename its cash-equity trades and remember it for future imports. */
export function renameSymbol(b) {
  const [r] = cleanRenames([b]);
  if (!r) throw new HttpError('Enter the old and the new symbol (different, letters/numbers only)');
  let renamed = 0;
  for (const t of state.trades) if (t.symbol === r.from && ['NSE', 'BSE'].includes(t.exchange)) { t.symbol = r.to; t.updatedAt = new Date().toISOString(); renamed++; }
  state.settings.symbolRenames = cleanRenames([...state.settings.symbolRenames.filter((x) => x.from !== r.from), r]);
  save();
  return { renamed, rename: r };
}

export function updateSettings(b) {
  const s = state.settings;
  if ('displayName' in b) s.displayName = str(b.displayName, 40) || 'Trader';
  for (const k of Object.keys(DEFAULT_SETTINGS).filter((x) => !['displayName', 'syncIgnore', 'symbolRenames', 'accountValue', 'benchmarkScheme', 'indexLists'].includes(x))) {
    if (k in b) { const v = num(b[k]); if (v != null && v >= 0) s[k] = v; }
  }
  if (Array.isArray(b.symbolRenames)) s.symbolRenames = cleanRenames(b.symbolRenames);
  if ('accountValue' in b) { const v = num(b.accountValue?.value); s.accountValue = v != null && v >= 0 ? { value: v, date: iso(b.accountValue?.date) || new Date().toISOString() } : null; }
  if ('indexLists' in b) {
    const L = b.indexLists; const clean = (a) => (Array.isArray(a) ? [...new Set(a.map((x) => str(x, 40).toUpperCase()).filter((x) => /^[A-Z0-9&\-_.]+$/.test(x)))].slice(0, 1000) : null);
    s.indexLists = L ? { nifty500: clean(L.nifty500), nifty500AsOf: iso(L.nifty500AsOf), nifty50: clean(L.nifty50) } : null;
  }
  if ('benchmarkScheme' in b && /^\d{3,7}$/.test(String(b.benchmarkScheme))) s.benchmarkScheme = String(b.benchmarkScheme);
  if (Array.isArray(b.syncIgnore)) s.syncIgnore = [...new Set(b.syncIgnore.map((x) => str(x, 60).toUpperCase()).filter((x) => /^[A-Z]+:[A-Z0-9&\-_.]+$/.test(x)))].slice(0, 200);
  save();
  return s;
}

export function importState(obj) {
  if (!obj || !Array.isArray(obj.trades)) throw new HttpError('Not a TradeQuest export (missing trades array)');
  state = { settings: obj.settings, trades: obj.trades, reviews: obj.reviews || [], groups: obj.groups || [], practice: obj.practice, ledger: obj.ledger || [] };
  normalise();
  save();
  return state;
}
