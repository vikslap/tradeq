// Helpers for per-trade charts: which candle interval/range to request, how to
// read Kite's candle format, and how to derive best/worst prices (MFE/MAE).

const DAY = 86400000;

/** Pick an interval and window that frame the trade with some context either side. */
export function chartPlan(t, now = Date.now()) {
  const entry = new Date(t.entryTime).getTime();
  const end = t.status === 'CLOSED' && t.exitTime ? new Date(t.exitTime).getTime() : now;
  const hold = Math.max(0, end - entry) / DAY;
  let interval; let from; let to;
  if (hold <= 2) { interval = '5minute'; from = entry - 1 * DAY; to = end + 0.5 * DAY; }
  else if (hold <= 25) { interval = '60minute'; from = entry - 6 * DAY; to = end + 3 * DAY; }
  else { interval = 'day'; from = entry - Math.max(45, hold * 0.4) * DAY; to = end + 12 * DAY; }
  return { interval, from: Math.floor(from), to: Math.floor(Math.min(to, now)) };
}

/** Kite wants "yyyy-mm-dd hh:mm:ss" in IST. */
export const kiteDate = (ms) => new Date(ms + 330 * 60000).toISOString().replace('T', ' ').slice(0, 19);

/** Kite candle: ["2026-11-17T09:15:00+0530", o, h, l, c, v] → [ms, o, h, l, c, v] */
export const parseKiteCandles = (rows) => (rows || []).map((r) => [
  new Date(String(r[0]).replace(/([+-]\d{2})(\d{2})$/, '$1:$2')).getTime(), r[1], r[2], r[3], r[4], r[5] || 0,
]);

/**
 * Best (MFE) and worst (MAE) price reached while the trade was open.
 * Intraday bars: every bar from the entry bar to the exit bar.
 * Daily bars: only days strictly between entry and exit (we can't know what part of
 * the entry/exit day happened while you were in), plus the actual fill prices.
 */
export function excursionsFromCandles(t, candles, interval) {
  if (!candles?.length) return null;
  const dir = t.side === 'SHORT' ? -1 : 1;
  const entry = new Date(t.entryTime).getTime();
  const exit = t.status === 'CLOSED' && t.exitTime ? new Date(t.exitTime).getTime() : Infinity;
  const ist = (ms) => new Date(ms + 330 * 60000).toISOString().slice(0, 10);
  const barMs = { '5minute': 5 * 60000, '60minute': 3600000 }[interval];
  const inTrade = candles.filter(([ts]) => {
    if (interval === 'day') return ist(ts) > ist(entry) && (exit === Infinity || ist(ts) < ist(exit));
    return ts + barMs > entry && ts <= exit;
  });
  const prices = [t.entryPrice];
  if (t.status === 'CLOSED' && t.exitPrice) prices.push(t.exitPrice);
  let hi = Math.max(...prices); let lo = Math.min(...prices);
  for (const c of inTrade) { hi = Math.max(hi, c[2]); lo = Math.min(lo, c[3]); }
  return dir === 1 ? { mfe: hi, mae: lo } : { mfe: lo, mae: hi };
}

/** Demo candles: a random walk that passes through the real entry and exit prices. */
export function mockCandles(t, plan) {
  const step = { '5minute': 5 * 60000, '60minute': 3600000, day: DAY }[plan.interval];
  const times = [];
  for (let ts = plan.from; ts <= plan.to; ts += step) {
    const d = new Date(ts + 330 * 60000);
    const wd = d.getUTCDay(); const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (wd === 0 || wd === 6) continue;
    if (plan.interval !== 'day' && (mins < 555 || mins > 925)) continue; // 9:15–15:25 IST
    times.push(ts);
  }
  if (times.length < 2) return [];
  let seed = [...t.id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const entry = new Date(t.entryTime).getTime();
  const exit = t.status === 'CLOSED' && t.exitTime ? new Date(t.exitTime).getTime() : null;
  const iE = Math.max(0, times.findIndex((x) => x + step > entry));
  const iX = exit ? Math.max(iE, times.findIndex((x) => x + step > exit)) : -1;
  const risk = Math.abs(t.entryPrice - (t.initialStop ?? t.entryPrice * 0.95)) || t.entryPrice * 0.02;
  const vol = risk / Math.sqrt(Math.max(4, (iX > 0 ? iX - iE : times.length - iE) / 2));
  const close = new Array(times.length);
  close[iE] = t.entryPrice;
  for (let i = iE - 1; i >= 0; i--) close[i] = close[i + 1] - (rnd() - 0.48) * vol;
  const target = iX > 0 ? t.exitPrice : null;
  for (let i = iE + 1; i < times.length; i++) {
    let drift = 0;
    if (target != null && i <= iX) drift = (target - close[i - 1]) / Math.max(1, iX - i + 1);
    close[i] = i === iX && target != null ? target : close[i - 1] + drift + (rnd() - 0.5) * vol * (i <= iX ? 0.9 : 1);
  }
  return times.map((ts, i) => {
    const o = i ? close[i - 1] : close[i] - (rnd() - 0.5) * vol;
    const c = close[i];
    const h = Math.max(o, c) + rnd() * vol * 0.6; const l = Math.min(o, c) - rnd() * vol * 0.6;
    const r = (v) => Math.round(v * 20) / 20;
    return [ts, r(o), r(h), r(l), r(c), Math.round(1e4 + rnd() * 9e4)];
  });
}
