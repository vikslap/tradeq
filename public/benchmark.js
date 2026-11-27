// "Am I beating the index?" — for your Swing and Positional stock trades only.
//
// Every trade is split into slices: each exit closes a slice, and whatever is still open is
// one more slice marked at today's price. For each slice we compare what you made with what
// the same rupees would have made in a Nifty 50 index fund over exactly the same days:
// bought the day you entered, sold the day you exited. Mutual funds, long-term holds,
// intraday trades and F&O are left out.
//
// Per financial year, a slice that spans 31 March is valued at that day's close (stock and
// fund), so each year gets only the gain made inside it.
import { exitsOf, tradeCharges } from './charges.js';
import { fyOf, fyRange } from './ledger.js';
import { xirr } from './stats.js';

export const BENCH_HORIZONS = ['SWING', 'POSITIONAL'];
const DERIV = new Set(['NFO', 'BFO', 'MCX', 'CDS', 'BCD']);
export const isStockTrade = (t) => !DERIV.has(t.exchange) && t.exchange !== 'MF' && (t.segment || 'EQ') === 'EQ'; // never mutual funds
export const inBenchmark = (t) => BENCH_HORIZONS.includes(t.horizon) && isStockTrade(t);

const DAY = 86400000;
export const istDay = (iso) => new Date(Date.parse(iso) + 330 * 60000).toISOString().slice(0, 10);
const days = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / DAY));

/** NAV lookup: last NAV on or before `d` (or the first one, before the data starts). */
export function navLookup(nav) {
  return (d) => {
    let lo = 0; let hi = nav.length - 1; let best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (nav[mid][0] <= d) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    return nav[Math.max(best, 0)][1];
  };
}

/**
 * Slices of the trades that count. ltpFor(t) gives today's price for open trades (or null).
 * Each slice: { t, sym, side, start, end, cost, endPrice, qty, charges, open, unpriced }.
 */
export function slicesOf(trades, ltpFor, today) {
  const out = [];
  for (const t of trades) {
    if (!inBenchmark(t) || !t.qty || !t.entryPrice || !t.entryTime) continue;
    const start = istDay(t.entryTime);
    const exits = exitsOf(t);
    const ch = tradeCharges(t).total || 0;
    const exitValue = exits.reduce((s, e) => s + e.price * e.qty, 0) || 1;
    let left = t.qty;
    for (const e of exits) {
      if (!e.qty || !e.price) continue;
      left -= e.qty;
      out.push({ t, sym: t.symbol, side: t.side, start, end: e.time ? istDay(e.time) : today, qty: e.qty, cost: t.entryPrice * e.qty, endPrice: e.price, charges: ch * ((e.price * e.qty) / exitValue), open: false });
    }
    if (left > 0 && t.status !== 'CLOSED') {
      const ltp = ltpFor(t);
      out.push({ t, sym: t.symbol, side: t.side, start, end: today, qty: left, cost: t.entryPrice * left, endPrice: ltp ?? t.entryPrice, charges: 0, open: true, unpriced: ltp == null });
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

const pnlAt = (s, price) => (s.side === 'SHORT' ? s.entry - price : price - s.entry) * s.qty;

/**
 * The comparison. nav: [[date, nav]] for the index fund. closeOn(sym, date) gives a stock's
 * close on a 31 March (or null — then that year's split is by days, flagged as estimated).
 */
export function compareWithIndex(slices, nav, today, closeOn = () => null) {
  if (!nav?.length) return null;
  const N = navLookup(nav);
  const years = {}; const flowsYou = []; const flowsIdx = [];
  let you = 0; let idx = 0; let charges = 0; let capDays = 0; let estimated = 0;
  const Y = (fy) => (years[fy] ||= { fy, you: 0, idx: 0, capDays: 0, charges: 0, trades: new Set(), estimated: false });
  for (const s0 of slices) {
    const s = { ...s0, entry: s0.cost / s0.qty };
    const youPnl = pnlAt(s, s.endPrice) - s.charges;
    const idxPnl = s.cost * (N(s.end) / N(s.start) - 1);
    you += youPnl; idx += idxPnl; charges += s.charges; capDays += s.cost * Math.max(1, days(s.start, s.end));
    flowsYou.push({ t: Date.parse(s.start), v: -s.cost }, { t: Date.parse(s.end) + DAY / 2, v: s.cost + youPnl });
    flowsIdx.push({ t: Date.parse(s.start), v: -s.cost }, { t: Date.parse(s.end) + DAY / 2, v: s.cost + idxPnl });
    // Walk the financial years the slice lives through.
    let from = s.start; let fromPrice = s.entry; let fromNav = N(s.start);
    for (;;) {
      const fy = fyOf(from); const [, fyEnd] = fyRange(fy);
      const y = Y(fy); y.trades.add(s.t.id);
      if (s.end <= fyEnd) {
        y.you += pnlAt({ ...s, entry: fromPrice }, s.endPrice) - s.charges;
        y.idx += (s.cost * (N(s.end) - fromNav)) / N(s.start);
        y.capDays += s.cost * Math.max(1, days(from, s.end));
        y.charges += s.charges;
        break;
      }
      let mark = closeOn(s.sym, fyEnd);
      if (mark == null) { // no 31-March price: split the move by days held
        mark = s.entry + (s.endPrice - s.entry) * (days(s.start, fyEnd) / Math.max(1, days(s.start, s.end)));
        y.estimated = true; estimated++;
      }
      y.you += pnlAt({ ...s, entry: fromPrice }, mark);
      y.idx += (s.cost * (N(fyEnd) - fromNav)) / N(s.start);
      y.capDays += s.cost * Math.max(1, days(from, fyEnd));
      from = new Date(Date.parse(fyEnd) + DAY).toISOString().slice(0, 10); fromPrice = mark; fromNav = N(fyEnd);
    }
  }
  const first = slices[0]?.start; const span = first ? days(first, today) : 0;
  const deployed = (cd, a, b) => cd / Math.max(1, days(a, b)); // average rupees in the market
  const yearList = Object.values(years).sort((a, b) => a.fy.localeCompare(b.fy)).map((y) => {
    const [a, b] = fyRange(y.fy); const end = b < today ? b : today; const begin = first && first > a ? first : a;
    const avg = deployed(y.capDays, begin, end);
    return {
      fy: y.fy, you: y.you, idx: y.idx, gap: y.you - y.idx, charges: y.charges, trades: y.trades.size, avgDeployed: avg,
      youPct: avg ? y.you / avg : null, idxPct: avg ? y.idx / avg : null,
      niftyYear: N(end) / N(new Date(Date.parse(a) - DAY).toISOString().slice(0, 10)) - 1, // the fund over the whole year
      partial: end < b, estimated: y.estimated,
    };
  });
  const avgAll = first ? deployed(capDays, first, today) : 0;
  return {
    you, idx, gap: you - idx, charges, slices: slices.length, trades: new Set(slices.map((s) => s.t.id)).size,
    first, span, avgDeployed: avgAll,
    youPct: avgAll ? you / avgAll : null, idxPct: avgAll ? idx / avgAll : null,
    // Annualised only with a year of history (as elsewhere in the app).
    youXirr: span >= 365 ? xirr(flowsYou) : null, idxXirr: span >= 365 ? xirr(flowsIdx) : null,
    unpriced: slices.filter((s) => s.unpriced).length, estimated,
    years: yearList,
  };
}

/** The 31-March dates (and stocks) whose closes the yearly split needs. */
export function marksNeeded(slices) {
  const need = new Map();
  for (const s of slices) {
    let from = s.start;
    for (;;) {
      const [, fyEnd] = fyRange(fyOf(from));
      if (s.end <= fyEnd) break;
      if (!need.has(s.sym)) need.set(s.sym, new Set());
      need.get(s.sym).add(fyEnd);
      from = new Date(Date.parse(fyEnd) + DAY).toISOString().slice(0, 10);
    }
  }
  return need;
}

// ---------- rolling 12-month windows and drawdown ----------
// Each slice's result counts on the day it closes (open slices: today), for you and for the
// index on the same money — the closed-trade view a trading journal uses.
const addMonths = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
const monthEnd = (iso) => { const d = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10); };

/** Per-slice results (you and the index on the same money), each dated by its end. */
export function sliceResults(slices, nav) {
  const N = navLookup(nav);
  return slices.map((s) => {
    const entry = s.cost / s.qty;
    const you = (s.side === 'SHORT' ? entry - s.endPrice : s.endPrice - entry) * s.qty - s.charges;
    return { start: s.start, end: s.end, cost: s.cost, you, idx: s.cost * (N(s.end) / N(s.start) - 1) };
  });
}

export function rollingWindows(results, today, months = 12) {
  if (!results.length) return { windows: [], beat: 0 };
  const first = results.reduce((m, r) => (r.start < m ? r.start : m), results[0].start);
  const out = [];
  let end = monthEnd(addMonths(first, months));
  for (;;) {
    const e = end > today ? today : end; const s = addMonths(e, -months);
    let you = 0; let idx = 0; let capDays = 0; let n = 0;
    for (const r of results) {
      if (r.end > s && r.end <= e) { you += r.you; idx += r.idx; n++; }
      const a = r.start > s ? r.start : s; const b = r.end < e ? r.end : e;
      if (b > a) capDays += r.cost * days(a, b);
    }
    const avg = capDays / Math.max(1, days(s, e));
    out.push({ from: s, to: e, you, idx, gap: you - idx, trades: n, avgDeployed: avg, youPct: avg ? you / avg : null, idxPct: avg ? idx / avg : null });
    if (end >= today) break;
    end = monthEnd(addMonths(end.slice(0, 8) + '01', 1));
  }
  const counted = out.filter((w) => w.trades);
  return { windows: out, beat: counted.filter((w) => w.gap > 0).length, counted: counted.length };
}

/** Largest fall from a running high of a cumulative P&L series (₹), and where things stand now. */
export function drawdown(points) {
  let cum = 0; let peak = 0; let peakAt = null; let max = 0; let maxFrom = null; let maxTo = null; let fromAt = null;
  const sorted = [...points].sort((a, b) => a.t.localeCompare(b.t));
  for (const p of sorted) {
    cum += p.v;
    if (cum >= peak) { peak = cum; peakAt = p.t; }
    const dd = peak - cum;
    if (dd > max) { max = dd; maxFrom = peakAt; maxTo = p.t; }
  }
  fromAt = peakAt;
  return { max, from: maxFrom, to: maxTo, current: peak - cum, since: fromAt, total: cum };
}

export function drawdowns(results) {
  return {
    you: drawdown(results.map((r) => ({ t: r.end, v: r.you }))),
    idx: drawdown(results.map((r) => ({ t: r.end, v: r.idx }))),
  };
}
