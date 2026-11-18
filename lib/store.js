// JSON-file journal store. One file, atomic writes, a backup copy on every start.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_SETTINGS = {
  displayName: 'Trader',
  capital: 100000,
  maxRiskPerTrade: 2000,
  maxTradesPerDay: 3,
  revengeWindowMins: 30,
  maxDailyLoss: 4000,
  maxPortfolioHeatPct: 6,
  maxPositionPct: 30,
  chaseTolerancePct: 1,
  syncIgnore: [],
};

const HORIZONS = ['INTRADAY', 'SWING', 'POSITIONAL', 'LONGTERM'];
const localDay = (iso) => new Date(iso).toLocaleDateString('en-CA');

/** Existing trades without a type: same-day = Intraday, up to 20 days = Swing, longer = Positional. */
export function guessHorizon(t, now = Date.now()) {
  const end = t.status === 'CLOSED' && t.exitTime ? new Date(t.exitTime).getTime() : now;
  if (t.status === 'CLOSED' && t.exitTime && localDay(t.exitTime) === localDay(t.entryTime)) return 'INTRADAY';
  return (end - new Date(t.entryTime).getTime()) / 86400000 <= 20 ? 'SWING' : 'POSITIONAL';
}

export class HttpError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

let file;
let state;

export function init(dir) {
  mkdirSync(dir, { recursive: true });
  file = path.join(dir, 'journal.json');
  if (existsSync(file)) {
    state = JSON.parse(readFileSync(file, 'utf8'));
    copyFileSync(file, path.join(dir, 'journal.backup.json'));
  } else {
    state = {};
  }
  normalise();
  save();
}

function normalise() {
  state.version = 1;
  state.settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
  state.trades = Array.isArray(state.trades) ? state.trades : [];
  state.reviews = Array.isArray(state.reviews) ? state.reviews : [];
  state.groups = Array.isArray(state.groups) ? state.groups : [];
  state.practice = state.practice && Array.isArray(state.practice.sessions) ? state.practice : { sessions: [] };
  pruneGroups();
  for (const t of state.trades) {
    // Repair F&O trades an earlier tradebook import labelled as NSE/BSE cash equity.
    const fut = /\d{2}[A-Z]{3}FUT$/.test(t.symbol || ''); const opt = /\d(CE|PE)$/.test(t.symbol || '');
    if ((fut || opt) && (t.exchange === 'NSE' || t.exchange === 'BSE')) { t.exchange = t.exchange === 'BSE' ? 'BFO' : 'NFO'; t.segment = opt ? 'OPT' : 'FUT'; }
    if (!HORIZONS.includes(t.horizon)) t.horizon = guessHorizon(t);
    if (!Array.isArray(t.thesisReviews)) t.thesisReviews = [];
  }
  if (!Array.isArray(state.settings.syncIgnore)) state.settings.syncIgnore = [];
}

function save() {
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}

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
  for (const k of ['qty', 'entryPrice', 'plannedEntry', 'mfePrice', 'maePrice', 'target', 'exitPrice', 'charges', 'confidence', 'rating', 'lotSize']) if (k in b) t[k] = num(b[k]);
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
    if (!t.exitTime) throw new HttpError('Exit time is required to close a trade');
    if (new Date(t.exitTime) < new Date(t.entryTime)) throw new HttpError('Exit time is before entry time');
  }
}

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
  if (b.status === 'CLOSED') t.status = 'CLOSED';
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
      const t = createTrade({ ...b, entrySource: 'kite-fill', exitSource: b.status === 'CLOSED' ? 'kite-fill' : undefined, stopLoss: null }, { persist: false });
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
      Object.assign(d, { status: 'CLOSED', exitPrice: num(c.exitPrice), exitTime: iso(c.exitTime), exitSource: 'kite-fill' });
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
  if ('status' in b) draft.status = oneOf(b.status, ['OPEN', 'CLOSED'], draft.status);
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
export function updateSettings(b) {
  const s = state.settings;
  if ('displayName' in b) s.displayName = str(b.displayName, 40) || 'Trader';
  for (const k of Object.keys(DEFAULT_SETTINGS).filter((x) => !['displayName', 'syncIgnore'].includes(x))) {
    if (k in b) { const v = num(b[k]); if (v != null && v >= 0) s[k] = v; }
  }
  if (Array.isArray(b.syncIgnore)) s.syncIgnore = [...new Set(b.syncIgnore.map((x) => str(x, 60).toUpperCase()).filter((x) => /^[A-Z]+:[A-Z0-9&\-_.]+$/.test(x)))].slice(0, 200);
  save();
  return s;
}

export function importState(obj) {
  if (!obj || !Array.isArray(obj.trades)) throw new HttpError('Not a TradeQuest export (missing trades array)');
  state = { settings: obj.settings, trades: obj.trades, reviews: obj.reviews || [], groups: obj.groups || [], practice: obj.practice };
  normalise();
  save();
  return state;
}
