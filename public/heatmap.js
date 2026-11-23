// Heatmap layout: a squarified treemap (Bruls, Huizing & van Wijk) plus colours and
// sector grouping. Pure functions — the page lives in js/heatmap-page.js.

const worst = (row, side) => {
  let sum = 0; let mx = 0; let mn = Infinity;
  for (const a of row) { sum += a; if (a > mx) mx = a; if (a < mn) mn = a; }
  const s2 = side * side; const q = sum * sum;
  return Math.max((s2 * mx) / q, q / (s2 * mn));
};

/** Rectangles for `values` inside (x, y, w, h), returned in the same order as `values`. */
export function squarify(values, x, y, w, h) {
  const idx = values.map((v, i) => [Math.max(Number(v) || 0, 1e-9), i]).sort((a, b) => b[0] - a[0]);
  const total = idx.reduce((s, [v]) => s + v, 0);
  const out = new Array(values.length);
  if (!idx.length || w <= 0 || h <= 0) return out.fill({ x, y, w: 0, h: 0 });
  const scale = (w * h) / total;
  let i = 0;
  while (i < idx.length) {
    const side = Math.min(w, h);
    let row = [idx[i][0] * scale]; let j = i + 1; let wr = worst(row, side);
    while (j < idx.length) { const next = [...row, idx[j][0] * scale]; const wn = worst(next, side); if (wn > wr) break; row = next; wr = wn; j++; }
    const rs = row.reduce((s, a) => s + a, 0);
    if (w >= h) { const cw = rs / h; let yy = y; row.forEach((a, k) => { out[idx[i + k][1]] = { x, y: yy, w: cw, h: a / cw }; yy += a / cw; }); x += cw; w -= cw; }
    else { const rh = rs / w; let xx = x; row.forEach((a, k) => { out[idx[i + k][1]] = { x: xx, y, w: a / rh, h: rh }; xx += a / rh; }); y += rh; h -= rh; }
    i = j;
  }
  return out;
}

/** Tile colour for a % change: red ← grey → green, full strength at ±3%. */
export function heatColor(pct) {
  if (pct == null || !Number.isFinite(pct)) return 'rgb(90,98,112)';
  const t = Math.max(-1, Math.min(1, pct / 3)); const a = Math.abs(t) ** 0.8;
  const [r0, g0, b0] = [90, 98, 112]; const [r1, g1, b1] = t >= 0 ? [22, 163, 74] : [220, 38, 38];
  return `rgb(${Math.round(r0 + (r1 - r0) * a)},${Math.round(g0 + (g1 - g0) * a)},${Math.round(b0 + (b1 - b0) * a)})`;
}

/**
 * stocks: [{ sym, pct, value, sector }] → sectors sorted by total size, each with its stocks,
 * a size-weighted average move, and how many rose / fell.
 */
export function groupSectors(stocks) {
  const m = new Map();
  for (const s of stocks) { const k = s.sector || 'Other'; if (!m.has(k)) m.set(k, []); m.get(k).push(s); }
  return [...m.entries()].map(([name, list]) => {
    const value = list.reduce((a, s) => a + s.value, 0);
    const wsum = list.reduce((a, s) => a + (s.pct == null ? 0 : s.value), 0);
    const pct = wsum ? list.reduce((a, s) => a + (s.pct == null ? 0 : s.pct * s.value), 0) / wsum : null;
    return { name, stocks: list.sort((a, b) => b.value - a.value), value, pct, up: list.filter((s) => s.pct > 0).length, down: list.filter((s) => s.pct < 0).length };
  }).sort((a, b) => b.value - a.value);
}
