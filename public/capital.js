// Capital: a fixed trading base, profits swept out to long-term investments, and a
// kill switch. Pure functions shared by the browser, the game engine and the tests.
//
// Equity  = base + trading P&L booked since the start date − sweeps + open P&L
// Sweep   = booked profit you can move out without dropping below the base,
//           after keeping back an estimate of the STCG tax on it.
// Kill switch = equity at or below base × killSwitchPct%.
import { exitsOf, tradeCharges } from './charges.js';

const DAY = 86400000;
export const STCG_RATE = 0.2; // listed equity, held up to 12 months (FY 2026-27)
export const DEFAULT_KILL_PCT = 80;

const istDay = (iso) => new Date(new Date(iso).getTime() + 330 * 60000).toISOString().slice(0, 10);
const isTradingT = (t) => t.horizon !== 'LONGTERM';

/** Indian financial year label for a YYYY-MM-DD day: 2026-11-28 → FY26-27. */
export function fyLabel(day) {
  const y = Number(day.slice(0, 4)); const m = Number(day.slice(5, 7));
  const s = m >= 4 ? y : y - 1;
  return `FY${String(s).slice(2)}-${String(s + 1).slice(2)}`;
}

/** Financial-year quarter: Apr–Jun = Q1 … Jan–Mar = Q4. */
export function quarterOf(day) {
  const m = Number(day.slice(5, 7));
  const q = m >= 4 ? Math.floor((m - 4) / 3) + 1 : 4;
  return `${fyLabel(day)} Q${q}`;
}

/** First and last day of the quarter that contains `day`. */
export function quarterRange(day) {
  const y = Number(day.slice(0, 4)); const m = Number(day.slice(5, 7));
  const startM = m - ((m - 1) % 3); // 1, 4, 7, 10
  const from = `${y}-${String(startM).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(y, startM + 2, 0)); // last day of the third month
  return [from, end.toISOString().slice(0, 10)];
}

/** Every exit of a trade with its own share of the charges: { day, net, heldDays }. */
export function exitNets(t) {
  const ex = exitsOf(t); if (!ex.length) return [];
  const dir = t.side === 'SHORT' ? -1 : 1;
  const exQty = ex.reduce((a, e) => a + (e.qty || 0), 0);
  const charges = t.charges == null ? tradeCharges(t).total : t.charges;
  return ex.filter((e) => e.time).map((e) => ({
    day: istDay(e.time),
    net: (e.price - t.entryPrice) * dir * e.qty - (exQty ? charges * (e.qty / exQty) : 0),
    heldDays: (new Date(e.time) - new Date(t.entryTime)) / DAY,
  }));
}

/** Kind of tax a trading exit falls under. Only listed-equity STCG is estimated. */
export function taxKind(t, x) {
  if (t.segment && t.segment !== 'EQ') return 'business'; // F&O, commodity: slab rate
  if (x.day === istDay(t.entryTime)) return 'business'; // intraday = speculative income
  return x.heldDays > 365 ? 'ltcg' : 'stcg';
}

export function cleanSweeps(list) {
  return (Array.isArray(list) ? list : [])
    .map((s) => ({ id: String(s.id || ''), date: String(s.date || '').slice(0, 10), amount: Number(s.amount), note: String(s.note || '').slice(0, 120) }))
    .filter((s) => s.id && /^\d{4}-\d{2}-\d{2}$/.test(s.date) && s.amount > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Where the trading account stands.
 * @param {{ trades, settings, today?: string, openPnl?: number|null }} o
 * openPnl: live unrealised P&L of open trading positions (null when there are no prices).
 */
export function capitalState({ trades = [], settings = {}, today = istDay(new Date().toISOString()), openPnl = null }) {
  const base = Number(settings.capital) || 0;
  const since = settings.capitalSince || null;
  const killPct = settings.killSwitchPct == null ? DEFAULT_KILL_PCT : Number(settings.killSwitchPct);
  const floor = base * (killPct / 100);
  if (!since || !base) return { ready: false, base, floor, killPct };

  const fy = fyLabel(today);
  const [qFrom, qTo] = quarterRange(today);
  let booked = 0; const tax = { stcg: 0, ltcg: 0, business: 0 };
  const byDay = {};
  for (const t of trades) {
    if (!isTradingT(t)) continue;
    for (const x of exitNets(t)) {
      if (x.day < since || x.day > today) continue;
      booked += x.net;
      byDay[x.day] = (byDay[x.day] || 0) + x.net;
      if (fyLabel(x.day) === fy) tax[taxKind(t, x)] += x.net;
    }
  }
  const sweeps = cleanSweeps(settings.sweeps).filter((s) => s.date >= since);
  const swept = sweeps.reduce((a, s) => a + s.amount, 0);
  const sweptThisQuarter = sweeps.filter((s) => s.date >= qFrom && s.date <= qTo).reduce((a, s) => a + s.amount, 0);
  const cash = base + booked - swept;
  const equity = cash + (openPnl || 0);
  // Tax on this year's STCG is kept back; sweeps already made this year are assumed to have left it in.
  const taxReserve = Math.max(0, tax.stcg) * STCG_RATE;
  const sweepable = Math.max(0, Math.min(booked - swept - taxReserve, equity - base));

  // Quarters (since the start) that ended with booked cash above the base.
  const quarters = [];
  for (let d = quarterRange(since)[0]; d <= today;) {
    const [a, b] = quarterRange(d);
    const end = b < today ? b : today;
    const bookedTo = Object.entries(byDay).filter(([k]) => k <= end).reduce((s, [, v]) => s + v, 0);
    const sweptTo = sweeps.filter((s) => s.date <= end).reduce((s, x) => s + x.amount, 0);
    quarters.push({ label: quarterOf(a), from: a, to: b, done: b < today, cash: base + bookedTo - sweptTo, swept: sweeps.filter((s) => s.date >= a && s.date <= b).reduce((s, x) => s + x.amount, 0) });
    d = new Date(Date.parse(b) + DAY).toISOString().slice(0, 10);
  }
  let aboveStreak = 0;
  for (const q of quarters.filter((x) => x.done).reverse()) { if (q.cash >= base) aboveStreak++; else break; }

  return {
    ready: true, base, since, killPct, floor, booked, swept, sweeps, cash, equity, openPnl,
    surplus: equity - base, breached: equity <= floor, belowBase: equity < base,
    fy, tax, taxReserve, sweepable, quarter: { label: quarterOf(today), from: qFrom, to: qTo, swept: sweptThisQuarter },
    quarters, aboveStreak,
  };
}

/**
 * Game events for the capital rules: +25 for each sweep, −15 for every new trade
 * opened while booked equity sat at or below the kill switch.
 */
export function capitalEvents(state) {
  const s = state.settings || {};
  const base = Number(s.capital) || 0; const since = s.capitalSince;
  if (!base || !since) return [];
  const floor = base * ((s.killSwitchPct == null ? DEFAULT_KILL_PCT : Number(s.killSwitchPct)) / 100);
  const sweeps = cleanSweeps(s.sweeps).filter((x) => x.date >= since);
  const events = sweeps.map((x) => ({ key: `sweep:${x.id}`, at: `${x.date}T12:00:00.000Z`, xp: 25, label: `Swept ₹${Math.round(x.amount).toLocaleString('en-IN')} of profit to long-term` }));
  const trading = (state.trades || []).filter((t) => isTradingT(t));
  const exits = trading.flatMap((t) => exitNets(t)).filter((x) => x.day >= since);
  for (const t of trading) {
    if (t.imported || !t.entryTime) continue;
    const d = istDay(t.entryTime);
    if (d < since) continue;
    const cash = base + exits.filter((x) => x.day < d).reduce((a, x) => a + x.net, 0) - sweeps.filter((x) => x.date < d).reduce((a, x) => a + x.amount, 0);
    if (cash <= floor) events.push({ key: `kill:${t.id}`, at: t.entryTime, xp: -15, label: `Traded through the kill switch (${t.symbol})`, tradeId: t.id, symbol: t.symbol });
  }
  return events;
}
