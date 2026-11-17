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

  let eq = 0; let peak = 0; let maxDD = 0;
  const curve = closed.length ? [{ at: closed[0].t.entryTime, v: 0 }] : [];
  const daily = {};
  for (const x of closed) {
    eq += x.m.net; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq);
    curve.push({ at: x.t.exitTime, v: eq, t: x.t });
    const d = dayKey(x.t.exitTime); daily[d] = (daily[d] || 0) + x.m.net;
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
