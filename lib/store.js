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
};

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
  for (const k of ['qty', 'entryPrice', 'plannedEntry', 'mfePrice', 'maePrice', 'target', 'exitPrice', 'charges', 'confidence', 'rating', 'lotSize']) if (k in b) t[k] = num(b[k]);
  for (const k of ['setup', 'thesis', 'emotionEntry', 'emotionExit', 'exitReason', 'lessons', 'screenshotUrl', 'notes']) if (k in b) t[k] = str(b[k]);
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
    if (!(t.exitPrice > 0)) throw new HttpError('Exit price is required to close a trade');
    if (!t.exitTime) throw new HttpError('Exit time is required to close a trade');
    if (new Date(t.exitTime) < new Date(t.entryTime)) throw new HttpError('Exit time is before entry time');
  }
}

const widened = (side, from, to) => (side === 'SHORT' ? to > from : to < from);

// ---------- trades ----------
export function createTrade(b) {
  const now = new Date().toISOString();
  const t = {
    id: randomUUID(), status: 'OPEN', exchange: 'NSE', segment: 'EQ', side: 'LONG',
    entrySource: 'manual', entryTime: now, tags: [], stopWidenCount: 0, stopHistory: [],
    createdAt: now, updatedAt: now,
  };
  applyFields(t, b);
  t.stopLoss = num(b.stopLoss);
  t.initialStop = t.stopLoss;
  t.stopSetAtEntry = t.stopLoss != null;
  if (b.status === 'CLOSED') t.status = 'CLOSED';
  validate(t);
  state.trades.push(t);
  save();
  return t;
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
  for (const k of Object.keys(DEFAULT_SETTINGS).filter((x) => x !== 'displayName')) {
    if (k in b) { const v = num(b[k]); if (v != null && v >= 0) s[k] = v; }
  }
  save();
  return s;
}

export function importState(obj) {
  if (!obj || !Array.isArray(obj.trades)) throw new HttpError('Not a TradeQuest export (missing trades array)');
  state = { settings: obj.settings, trades: obj.trades, reviews: obj.reviews || [] };
  normalise();
  save();
  return state;
}
