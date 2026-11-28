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
