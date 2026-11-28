// The report card: results split two ways —
//   by strategy (equity only): Long-term (value buying) vs Trading (intraday, swing, positional —
//   a swing that turns positional stays in Trading), and
//   by segment: Equity cash · F&O (incl. currency) · Commodities, with an Equity total and an Overall total.
// Booked P&L is dated by each exit (so partial exits land in the right year); open P&L is today's.
import { metrics } from './game.js';
import { fyOf } from './ledger.js';
import { exitsOf } from './charges.js';

export const BUCKETS = [
  { id: 'eq-lt', label: 'Equity · Long-term', hint: 'value buying', equity: true },
  { id: 'eq-tr', label: 'Equity · Trading', hint: 'swing + positional', equity: true },
  { id: 'fno', label: 'F&O', hint: 'futures & options' },
  { id: 'com', label: 'Commodities', hint: 'MCX' },
];
export const TOTALS = [
  { id: 'eq', label: 'Equity total', of: ['eq-lt', 'eq-tr'] },
  { id: 'all', label: 'Overall', of: ['eq-lt', 'eq-tr', 'fno', 'com'] },
];

const DERIV = new Set(['NFO', 'BFO', 'CDS', 'BCD']);
export function bucketOf(t) {
  if (t.exchange === 'MCX' || t.segment === 'COM') return 'com';
  if (DERIV.has(t.exchange) || ['FUT', 'OPT'].includes(t.segment)) return 'fno';
  if (t.exchange === 'MF') return null; // never mutual funds
  return t.horizon === 'LONGTERM' ? 'eq-lt' : 'eq-tr';
}
export const inBucket = (id) => (t) => { const b = bucketOf(t); return id === 'all' ? !!b : id === 'eq' ? b === 'eq-lt' || b === 'eq-tr' : b === id; };

const istDay = (iso) => new Date(Date.parse(iso) + 330 * 60000).toISOString().slice(0, 10);
const blank = () => ({ trades: 0, closed: 0, wins: 0, losses: 0, booked: 0, open: 0, charges: 0, rSum: 0, rN: 0, openTrades: 0 });

/**
 * Summary per bucket for a period: fy = 'FY25-26' or null for all time. ltpFor(t) → live price.
 * A trade belongs to the period if it had an exit in it, or it's open and the period is current/all.
 */
export function summarize(trades, { ltpFor = () => null, fy = null, today } = {}) {
  const cur = fyOf(today || new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10));
  const rows = Object.fromEntries([...BUCKETS, ...TOTALS].map((b) => [b.id, blank()]));
  for (const t of trades) {
    const b = bucketOf(t); if (!b || t.entryPrice == null) continue;
    const m = metrics(t, ltpFor(t));
    const exits = exitsOf(t); const exQty = exits.reduce((a, e) => a + (e.qty || 0), 0);
    let booked = 0; let charges = 0; let touched = false;
    for (const e of exits) {
      if (!e.qty) continue;
      const efy = e.time ? fyOf(istDay(e.time)) : cur;
      if (fy && efy !== fy) continue;
      const share = exQty ? e.qty / exQty : 0;
      booked += (e.price - t.entryPrice) * m.dir * e.qty - m.charges * share;
      charges += m.charges * share; touched = true;
    }
    const isOpen = t.status !== 'CLOSED' && m.openQty > 0;
    const open = isOpen && (!fy || fy === cur) ? (m.unrealised || 0) : 0;
    if (isOpen && (!fy || fy === cur)) touched = true;
    if (!touched) continue;
    const finalFy = t.status === 'CLOSED' && t.exitTime ? fyOf(istDay(t.exitTime)) : null;
    const closedHere = t.status === 'CLOSED' && (!fy || finalFy === fy);
    for (const id of [b, ...TOTALS.filter((x) => x.of.includes(b)).map((x) => x.id)]) {
      const r = rows[id];
      r.trades++; r.booked += booked; r.open += open; r.charges += charges;
      if (isOpen) r.openTrades++;
      if (closedHere) { r.closed++; if (m.net > 0) r.wins++; else r.losses++; if (m.r != null) { r.rSum += m.r; r.rN++; } }
    }
  }
  for (const r of Object.values(rows)) { r.net = r.booked + r.open; r.winRate = r.closed ? r.wins / r.closed : null; r.avgR = r.rN ? r.rSum / r.rN : null; }
  return rows;
}

/** Financial years in which anything happened, newest first. */
export function yearsWithActivity(trades, today) {
  const s = new Set([fyOf(today)]);
  for (const t of trades) { if (!bucketOf(t)) continue; for (const e of exitsOf(t)) if (e.time) s.add(fyOf(istDay(e.time))); }
  return [...s].sort().reverse();
}

// ---------- monthly returns grid (like a fund's performance capsule) ----------
/** Every exit as a dated P&L event (after its share of charges), for trades in `bucket`. */
export function exitEvents(trades, bucket = 'eq-tr') {
  const keep = inBucket(bucket); const out = [];
  for (const t of trades) {
    if (!keep(t) || t.entryPrice == null) continue;
    const m = metrics(t); const exits = exitsOf(t); const exQty = exits.reduce((a, e) => a + (e.qty || 0), 0);
    for (const e of exits) if (e.qty && e.time) out.push({ day: istDay(e.time), pnl: (e.price - t.entryPrice) * m.dir * e.qty - m.charges * (e.qty / exQty) });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Month-by-month return: that month's booked P&L ÷ the account at the start of the month
 * (capital + earlier P&L − earlier sweeps). Year total compounds the months.
 * basis 'cal' → Jan–Dec columns; 'fy' → Apr–Mar (labelled by financial year).
 */
export function monthlyReturns(events, { capital, sweeps = [], basis = 'cal' } = {}) {
  if (!(capital > 0) || !events.length) return { years: [], rows: [] };
  const byMonth = new Map();
  for (const e of events) { const k = e.day.slice(0, 7); byMonth.set(k, (byMonth.get(k) || 0) + e.pnl); }
  const sw = [...sweeps].filter((s) => s.date && s.amount > 0).sort((a, b) => a.date.localeCompare(b.date));
  const first = events[0].day.slice(0, 7); const last = events.at(-1).day.slice(0, 7);
  const months = []; for (let d = new Date(`${first}-01T00:00:00Z`); d.toISOString().slice(0, 7) <= last; d.setUTCMonth(d.getUTCMonth() + 1)) months.push(d.toISOString().slice(0, 7));
  const yearOf = (k) => (basis === 'fy' ? fyOf(`${k}-15`) : k.slice(0, 4));
  const slotOf = (k) => { const m = Number(k.slice(5)); return basis === 'fy' ? (m + 8) % 12 : m - 1; }; // fy: Apr = 0 … Mar = 11
  let equity = capital; const cells = {};
  for (const k of months) {
    for (const s of sw) if (s.date.slice(0, 7) < k && !s._done) { equity -= s.amount; s._done = true; }
    const pnl = byMonth.get(k) || 0;
    const y = yearOf(k); (cells[y] ||= Array(12).fill(null));
    cells[y][slotOf(k)] = { month: k, pnl, pct: byMonth.has(k) && equity > 0 ? pnl / equity : (byMonth.has(k) ? null : 0), start: equity, traded: byMonth.has(k) };
    equity += pnl;
  }
  for (const s of sw) delete s._done;
  const years = Object.keys(cells).sort().reverse();
  const totals = Object.fromEntries(years.map((y) => {
    const cs = cells[y].filter(Boolean);
    return [y, { pct: cs.reduce((a, c) => a * (1 + (c.pct || 0)), 1) - 1, pnl: cs.reduce((a, c) => a + c.pnl, 0) }];
  }));
  return { years, cells, totals, labels: basis === 'fy' ? ['April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'January', 'February', 'March'] : ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] };
}
