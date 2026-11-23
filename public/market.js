// Market context for practice replays: relative strength against the Nifty 50 and
// market breadth (Nifty 500 daily, Nifty 50 bar by bar). Pure functions — shared by
// the browser and the tests. Candles are [ms, open, high, low, close, volume].

const IST = 330 * 60000;
export const istDate = (ms) => new Date(ms + IST).toISOString().slice(0, 10);
export const NIFTY50_TOKEN = 256265;

/** Bench close for each stock candle (same bar time, or the latest bench bar before it). */
export function alignBench(candles, bench) {
  const out = new Array(candles.length).fill(null);
  if (!bench?.length) return out;
  let j = 0;
  for (let i = 0; i < candles.length; i++) {
    while (j + 1 < bench.length && bench[j + 1][0] <= candles[i][0]) j++;
    if (bench[j][0] <= candles[i][0]) out[i] = bench[j][4];
  }
  return out;
}

/** Relative-strength line: (stock ÷ Nifty), scaled to 100 at the first bar. */
export function rsLine(candles, bench) {
  const b = alignBench(candles, bench);
  const first = candles.findIndex((c, i) => b[i]);
  if (first < 0) return candles.map(() => null);
  const base = candles[first][4] / b[first];
  return candles.map((c, i) => (b[i] ? (c[4] / b[i] / base) * 100 : null));
}

/** At bar `i`: stock vs Nifty % change over `n` bars, and whether RS is at a 50-bar high. */
export function rsReadout(candles, bench, i, n = 20) {
  if (!bench?.length || i < 1) return null;
  const b = alignBench(candles, bench);
  const rs = rsLine(candles, bench);
  const k = Math.max(0, i - n);
  if (!b[i] || !b[k]) return null;
  const stockPct = candles[i][4] / candles[k][4] - 1;
  const benchPct = b[i] / b[k] - 1;
  const win = rs.slice(Math.max(0, i - 49), i + 1).filter((v) => v != null);
  const atHigh = win.length >= 20 && rs[i] >= Math.max(...win) - 1e-9;
  const atLow = win.length >= 20 && rs[i] <= Math.min(...win) + 1e-9;
  return { bars: i - k, stockPct, benchPct, edge: stockPct - benchPct, atHigh, atLow };
}

// ---------- daily breadth (built once from all Nifty 500 members) ----------

/** Add one stock's daily closes ([['YYYY-MM-DD', close], …], oldest first) to the per-day tallies. */
export function addStockToBreadth(days, closes) {
  let sum50 = 0; let sum200 = 0;
  for (let i = 0; i < closes.length; i++) {
    const [d, c] = closes[i];
    sum50 += c; sum200 += c;
    if (i >= 50) sum50 -= closes[i - 50][1];
    if (i >= 200) sum200 -= closes[i - 200][1];
    const x = (days[d] ||= [0, 0, 0, 0, 0, 0, 0]); // adv, dec, unch, above50, n50, above200, n200
    if (i > 0) { const p = closes[i - 1][1]; if (c > p) x[0]++; else if (c < p) x[1]++; else x[2]++; }
    if (i >= 49) { x[4]++; if (c > sum50 / 50) x[3]++; }
    if (i >= 199) { x[6]++; if (c > sum200 / 200) x[5]++; }
  }
  return days;
}

/** Turn the tallies into compact columns, oldest first. */
export function finishBreadth(days, meta = {}) {
  const dates = Object.keys(days).sort();
  const col = (k) => dates.map((d) => days[d][k]);
  return { ...meta, dates, adv: col(0), dec: col(1), unch: col(2), a50: col(3), n50: col(4), a200: col(5), n200: col(6) };
}

/** Breadth on `date` (or the last day before it when `before` is set). */
export function breadthOn(b, date, { before = false } = {}) {
  if (!b?.dates?.length) return null;
  let lo = 0; let hi = b.dates.length - 1; let k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (before ? b.dates[m] < date : b.dates[m] <= date) { k = m; lo = m + 1; } else hi = m - 1; }
  if (k < 0) return null;
  // Too far from the bar (outside the data) → nothing, rather than stale numbers.
  if ((Date.parse(date) - Date.parse(b.dates[k])) / 86400000 > 7) return null;
  return { date: b.dates[k], adv: b.adv[k], dec: b.dec[k], unch: b.unch[k], pct50: b.n50[k] ? b.a50[k] / b.n50[k] : null, pct200: b.n200[k] ? b.a200[k] / b.n200[k] : null, n: b.adv[k] + b.dec[k] + b.unch[k] };
}

// ---------- intraday breadth, bar by bar (Nifty 50, loaded on request) ----------

/**
 * For each bar time: how many stocks are above / below their previous day's close.
 * stocks: { SYMBOL: candles[] } (same interval). Returns Map(ms → { adv, dec, n }).
 */
export function intradayBreadth(stocks, times) {
  const out = new Map(times.map((t) => [t, { adv: 0, dec: 0, n: 0 }]));
  for (const candles of Object.values(stocks)) {
    if (!candles?.length) continue;
    const prevClose = {}; let lastDay = null; let lastClose = null;
    for (const c of candles) { const d = istDate(c[0]); if (d !== lastDay) { if (lastDay) prevClose[d] = lastClose; lastDay = d; } lastClose = c[4]; }
    let j = 0;
    for (const t of times) {
      while (j + 1 < candles.length && candles[j + 1][0] <= t) j++;
      const c = candles[j]; if (!c || c[0] > t) continue;
      const d = istDate(c[0]); if (d !== istDate(t)) continue; // no bar yet today for this stock
      const p = prevClose[d]; if (p == null) continue;
      const x = out.get(t); x.n++;
      if (c[4] > p) x.adv++; else if (c[4] < p) x.dec++;
    }
  }
  return out;
}

// ---------- rolling breadth measures (from the daily Nifty 500 tallies) ----------
export const BREADTH_VIEWS = [
  ['pct50', '% above 50-DMA'], ['adline', 'A/D line'], ['net10', '10-day net A/D'], ['mcclellan', 'McClellan oscillator'], ['pct200', '% above 200-DMA'], ['net', 'Daily net A/D'],
];

/** Every measure as a column aligned with b.dates (computed once, cached on the object). */
export function breadthMeasures(b) {
  if (b._m) return b._m;
  const n = b.dates.length;
  const net = b.adv.map((a, i) => a - b.dec[i]);
  const ema = (len) => { const k = 2 / (len + 1); const out = []; let e = null; for (const v of net) { e = e == null ? v : v * k + e * (1 - k); out.push(e); } return out; };
  const e19 = ema(19); const e39 = ema(39);
  const adline = []; let run = 0; for (const v of net) { run += v; adline.push(run); }
  const net10 = net.map((_, i) => (i < 9 ? null : net.slice(i - 9, i + 1).reduce((a, v) => a + v, 0) / 10));
  const pct = (a, d) => a.map((v, i) => (d[i] ? (v / d[i]) * 100 : null));
  Object.defineProperty(b, '_m', { value: { net, adline, net10, mcclellan: e19.map((v, i) => (i < 38 ? null : v - e39[i])), pct50: pct(b.a50, b.n50), pct200: pct(b.a200, b.n200), n }, enumerable: false });
  return b._m;
}

/** Value of one measure on a date (that day, or the last day before it when `before`). */
export function breadthValue(b, view, date, opts = {}) {
  const x = breadthOn(b, date, opts); if (!x) return null;
  const i = b.dates.indexOf(x.date);
  const v = breadthMeasures(b)[view]?.[i];
  return v == null ? null : v;
}

// ---------- live breadth (today, from one Kite quote call for all members) ----------

/**
 * history: stored daily breadth; tails: { asOf, closes: { SYM: [last ≤200 daily closes] } };
 * quotes: { 'NSE:SYM': { last, prevClose } }; today: 'YYYY-MM-DD' (IST).
 * Returns today's adv/dec, % above 50/200-DMA and the McClellan oscillator.
 */
export function liveBreadth(history, tails, quotes, today) {
  let adv = 0; let dec = 0; let unch = 0; let a50 = 0; let n50 = 0; let a200 = 0; let n200 = 0; let seen = 0;
  const closesToday = {};
  for (const [sym, tail0] of Object.entries(tails?.closes || {})) {
    const q = quotes[`NSE:${sym}`]; if (!q || !(q.last > 0)) continue;
    seen++;
    const tail = tails.asOf >= today ? tail0.slice(0, -1) : tail0; // already holds today's close → leave it out
    const last = q.last; closesToday[sym] = last;
    if (q.prevClose) { if (last > q.prevClose) adv++; else if (last < q.prevClose) dec++; else unch++; }
    if (tail.length >= 49) { n50++; const s = tail.slice(-49).reduce((a, v) => a + v, 0) + last; if (last > s / 50) a50++; }
    if (tail.length >= 199) { n200++; const s = tail.slice(-199).reduce((a, v) => a + v, 0) + last; if (last > s / 200) a200++; }
  }
  // McClellan: carry the 19/39-day averages of net advances forward by today's net.
  let mcclellan = null;
  if (history?.dates?.length) {
    const net = history.adv.map((a, i) => a - history.dec[i]);
    let upto = history.dates.length; while (upto > 0 && history.dates[upto - 1] >= today) upto--;
    if (upto >= 39) {
      const ema = (len) => { const k = 2 / (len + 1); let e = null; for (let i = 0; i < upto; i++) e = e == null ? net[i] : net[i] * k + e * (1 - k); return e * (1 - k) + (adv - dec) * k; };
      mcclellan = ema(19) - ema(39);
    }
  }
  const staleDays = tails?.asOf ? Math.round((Date.parse(today) - Date.parse(tails.asOf)) / 86400000) : null;
  return { adv, dec, unch, n: seen, pct50: n50 ? (a50 / n50) * 100 : null, pct200: n200 ? (a200 / n200) * 100 : null, a50, n50, a200, n200, mcclellan, staleDays, closesToday };
}

/** After the close: add today's figures to the history and today's closes to the tails. */
export function appendToday(history, tails, live, today) {
  if (!history?.dates?.length || history.dates.at(-1) >= today) return null;
  const h = { ...history };
  for (const [k, v] of [['dates', today], ['adv', live.adv], ['dec', live.dec], ['unch', live.unch], ['a50', live.a50], ['n50', live.n50], ['a200', live.a200], ['n200', live.n200]]) h[k] = [...history[k], v];
  const closes = {};
  for (const [s, tail] of Object.entries(tails.closes)) closes[s] = live.closesToday[s] != null ? [...tail, live.closesToday[s]].slice(-200) : tail;
  return { history: h, tails: { asOf: today, closes } };
}

// ---------- breadth for a subset (e.g. Nifty 50) from the stored per-stock closes ----------

/**
 * Daily breadth history for `syms`, rebuilt from the stored tails (the last ≤199 closes per
 * stock, right-aligned to tails.asOf). Dates come from the full history. Gives ~198 days of
 * advance/decline and ~150 days of % above the 50-DMA; % above the 200-DMA needs 200 closes,
 * so only today's live figure has it.
 */
export function subsetHistory(history, tails, syms) {
  const dates = (history?.dates || []).filter((d) => !tails?.asOf || d <= tails.asOf);
  const cols = syms.map((s) => tails?.closes?.[s]).filter((t) => Array.isArray(t) && t.length > 1);
  const L = Math.min(dates.length, Math.max(0, ...cols.map((t) => t.length)));
  const out = { dates: dates.slice(dates.length - L + 1), adv: [], dec: [], unch: [], a50: [], n50: [], a200: [], n200: [] };
  for (let j = 1; j < L; j++) {
    let adv = 0; let dec = 0; let unch = 0; let a50 = 0; let n50 = 0;
    for (const t of cols) {
      const k = j - (L - t.length); // index into this stock's tail
      if (k < 1) continue;
      if (t[k] > t[k - 1]) adv++; else if (t[k] < t[k - 1]) dec++; else unch++;
      if (k >= 49) { n50++; let s = 0; for (let x = k - 49; x <= k; x++) s += t[x]; if (t[k] > s / 50) a50++; }
    }
    out.adv.push(adv); out.dec.push(dec); out.unch.push(unch); out.a50.push(a50); out.n50.push(n50); out.a200.push(0); out.n200.push(0);
  }
  return out;
}

export const subsetTails = (tails, syms) => ({ asOf: tails?.asOf, closes: Object.fromEntries(syms.filter((s) => tails?.closes?.[s]).map((s) => [s, tails.closes[s]])) });

// ---------- intraday swings (zig-zag) ----------

/**
 * Peaks and troughs of a price line: a turn counts once price has reversed by `pct`% from
 * the extreme. points: [[time, price]]. Returns [{ i, time, price, type: 'peak'|'trough' }],
 * plus the day's high and low flagged with `extreme: true`.
 */
export function swings(points, pct) {
  if (points.length < 3) return [];
  const P = (i) => points[i][1]; const up = 1 + pct / 100; const dn = 1 - pct / 100;
  const piv = []; let dir = 0; let ext = 0; let hiI = 0; let loI = 0;
  for (let i = 1; i < points.length; i++) {
    const p = P(i);
    if (dir === 0) {
      if (p > P(hiI)) hiI = i; if (p < P(loI)) loI = i;
      if (hiI > loI && P(hiI) >= P(loI) * up) { piv.push({ i: loI, type: 'trough' }); dir = 1; ext = hiI; }
      else if (loI > hiI && P(loI) <= P(hiI) * dn) { piv.push({ i: hiI, type: 'peak' }); dir = -1; ext = loI; }
    } else if (dir === 1) {
      if (p > P(ext)) ext = i; else if (p <= P(ext) * dn) { piv.push({ i: ext, type: 'peak' }); dir = -1; ext = i; }
    } else if (p < P(ext)) ext = i; else if (p >= P(ext) * up) { piv.push({ i: ext, type: 'trough' }); dir = 1; ext = i; }
  }
  let hi = 0; let lo = 0; points.forEach((_, i) => { if (P(i) > P(hi)) hi = i; if (P(i) < P(lo)) lo = i; });
  const res = piv.filter((x) => x.i !== hi && x.i !== lo && x.i > 2); // the first minutes after the open aren't swings
  res.push({ i: hi, type: 'peak', extreme: true }, { i: lo, type: 'trough', extreme: true });
  return res.sort((a, b) => a.i - b.i).map((x) => ({ ...x, time: points[x.i][0], price: P(x.i) }));
}
