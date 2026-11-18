import { metrics, dayKey } from './game.js';

const sum = (a) => a.reduce((s, x) => s + x, 0);

export function computeStats(trades) {
  const closed = trades
    .filter((t) => t.status === 'CLOSED' && t.exitTime)
    .map((t) => ({ t, m: metrics(t) }))
    .sort((a, b) => new Date(a.t.exitTime) - new Date(b.t.exitTime));
  const wins = closed.filter((x) => x.m.net > 0);
  const losses = closed.filter((x) => x.m.net < 0);
  const net = sum(closed.map((x) => x.m.net));
  const grossWin = sum(wins.map((x) => x.m.net));
  const grossLoss = -sum(losses.map((x) => x.m.net));
  const rs = closed.map((x) => x.m.r).filter((v) => v != null);

  // Equity curve and drawdown are measured per day (by exit date), so legs of a spread
  // or a scale-out closed on the same day net out instead of showing a fake plunge.
  const daily = {}; const dayCount = {};
  for (const x of closed) { const d = dayKey(x.t.exitTime); daily[d] = (daily[d] || 0) + x.m.net; dayCount[d] = (dayCount[d] || 0) + 1; }
  let eq = 0; let peak = 0; let maxDD = 0;
  const curve = [];
  if (closed.length) {
    const start = dayKey(closed.reduce((m, x) => (x.t.entryTime < m ? x.t.entryTime : m), closed[0].t.entryTime));
    const first = Object.keys(daily).sort()[0];
    const prev = new Date(`${first}T12:00:00`); prev.setDate(prev.getDate() - 1);
    curve.push({ day: start < first ? start : dayKey(prev), v: 0, pnl: 0, n: 0 });
  }
  for (const d of Object.keys(daily).sort()) {
    eq += daily[d]; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq);
    curve.push({ day: d, v: eq, pnl: daily[d], n: dayCount[d] });
  }

  return {
    count: closed.length, wins: wins.length, losses: losses.length, net,
    winRate: closed.length ? wins.length / closed.length : null,
    avgWin: wins.length ? grossWin / wins.length : null,
    avgLoss: losses.length ? -grossLoss / losses.length : null,
    profitFactor: grossLoss ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
    expectancy: closed.length ? net / closed.length : null,
    avgR: rs.length ? sum(rs) / rs.length : null,
    best: closed.reduce((b, x) => (!b || x.m.net > b.m.net ? x : b), null),
    worst: closed.reduce((b, x) => (!b || x.m.net < b.m.net ? x : b), null),
    maxDD, curve, closed, daily,
    avgHoldWin: wins.length ? sum(wins.map((x) => x.m.holdDays)) / wins.length : null,
    avgHoldLoss: losses.length ? sum(losses.map((x) => x.m.holdDays)) / losses.length : null,
  };
}

export function groupBy(closed, keyFn) {
  const g = {};
  for (const x of closed) {
    const k = keyFn(x.t, x.m) || '—';
    (g[k] ||= []).push(x);
  }
  return Object.entries(g).map(([key, list]) => {
    const rs = list.map((x) => x.m.r).filter((v) => v != null);
    return {
      key, count: list.length, net: sum(list.map((x) => x.m.net)),
      winRate: list.filter((x) => x.m.net > 0).length / list.length,
      avgR: rs.length ? sum(rs) / rs.length : null,
    };
  }).sort((a, b) => b.net - a.net);
}

export function rHistogram(closed) {
  const buckets = [
    { label: '< −2R', test: (r) => r < -2 }, { label: '−2 to −1', test: (r) => r >= -2 && r < -1 },
    { label: '−1 to 0', test: (r) => r >= -1 && r < 0 }, { label: '0 to 1', test: (r) => r >= 0 && r < 1 },
    { label: '1 to 2', test: (r) => r >= 1 && r < 2 }, { label: '2 to 3', test: (r) => r >= 2 && r < 3 },
    { label: '≥ 3R', test: (r) => r >= 3 },
  ];
  return buckets.map((b, i) => ({ ...b, neg: i < 3, count: closed.filter((x) => x.m.r != null && b.test(x.m.r)).length }));
}

// ---------------------------------------------------------------------------
// Long-term holdings
// ---------------------------------------------------------------------------
const YEAR = 365 * 86400000;

/** Annualised money-weighted return for dated cash flows [{t: ms, v: ₹}] (out < 0, in > 0). */
export function xirr(flows) {
  if (!flows.some((f) => f.v < 0) || !flows.some((f) => f.v > 0)) return null;
  const t0 = Math.min(...flows.map((f) => f.t));
  const npv = (r) => flows.reduce((s, f) => s + f.v / Math.pow(1 + r, (f.t - t0) / YEAR), 0);
  let lo = -0.9999; let hi = 100; let flo = npv(lo);
  if (flo * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2; const fm = npv(mid);
    if (Math.sign(fm) === Math.sign(flo)) { lo = mid; flo = fm; } else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Annualising short holding periods exaggerates wildly, so CAGR is only shown after a year. */
export const CAGR_MIN_DAYS = 365;
const cagr = (ret, days) => (ret != null && days >= CAGR_MIN_DAYS ? Math.pow(1 + ret, 365 / days) - 1 : null);

export function investmentStats(trades, ltpFor, now = Date.now()) {
  const lt = trades.filter((t) => t.horizon === 'LONGTERM');
  const flows = [];
  const holdings = lt.filter((t) => t.status === 'OPEN').map((t) => {
    const inv = t.entryPrice * t.qty; const ltp = ltpFor(t);
    const value = ltp != null ? ltp * t.qty : null;
    const days = (now - new Date(t.entryTime)) / 86400000;
    const ret = value != null ? value / inv - 1 : null;
    flows.push({ t: new Date(t.entryTime).getTime(), v: -inv }, { t: now, v: value ?? inv });
    return { t, inv, ltp, value, pnl: value != null ? value - inv : null, ret, cagr: cagr(ret, days), days, unpriced: value == null };
  });
  const sold = lt.filter((t) => t.status === 'CLOSED' && t.exitTime).map((t) => {
    const inv = t.entryPrice * t.qty; const net = metrics(t).net;
    const days = (new Date(t.exitTime) - new Date(t.entryTime)) / 86400000;
    flows.push({ t: new Date(t.entryTime).getTime(), v: -inv }, { t: new Date(t.exitTime).getTime(), v: inv + net });
    return { t, inv, net, ret: net / inv, cagr: cagr(net / inv, days), days };
  });
  const priced = holdings.filter((h) => h.value != null);
  const invested = sum(holdings.map((h) => h.inv));
  // Holdings without a live price are valued at cost so totals still add up.
  const value = sum(holdings.map((h) => h.value ?? h.inv));
  const unrealised = sum(priced.map((h) => h.pnl));
  const oldest = flows.length ? Math.min(...flows.map((f) => f.t)) : now;
  return {
    holdings, sold, invested, value, unrealised,
    unpriced: holdings.length - priced.length,
    returnPct: invested ? unrealised / invested : null,
    realised: sum(sold.map((x) => x.net)),
    // Same rule as CAGR: an annualised portfolio return only once there's a year of history.
    xirr: (now - oldest) / 86400000 >= CAGR_MIN_DAYS ? xirr(flows) : null,
  };
}
