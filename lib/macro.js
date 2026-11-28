// Global markets for the Market page: US Dollar Index (ICE DXY), Brent crude (front-month
// futures) and gold (COMEX futures), from Yahoo Finance's public chart data — Kite doesn't
// carry them. Unofficial and for personal use; cached a minute so we ask rarely.
export const MACRO = [
  { key: 'dxy', sym: 'DX-Y.NYB', name: 'US Dollar Index', short: 'DXY', unit: '' },
  { key: 'brent', sym: 'BZ=F', name: 'Brent crude', short: 'Brent', unit: '$/bbl' },
  { key: 'gold', sym: 'GC=F', name: 'Gold', short: 'Gold', unit: '$/oz' },
];
export const RANGES = { '1d': '5m', '5d': '15m', '1mo': '1h', '6mo': '1d', '1y': '1d' };

const mem = new Map();
export async function macroSeries(range = '1d', { fetchImpl = fetch, mock = false } = {}) {
  if (!RANGES[range]) range = '1d';
  const ck = `macro|${range}`; const hit = mem.get(ck);
  if (hit && Date.now() - hit.at < 60000) return hit.data;
  const out = {}; const errors = [];
  await Promise.all(MACRO.map(async (m) => {
    try { out[m.key] = mock ? mockSeries(m, range) : await yahoo(m.sym, range, fetchImpl); } catch (e) { errors.push(`${m.short}: ${e.message}`); }
  }));
  const data = { range, at: Date.now(), series: MACRO.map((m) => ({ ...m, ...(out[m.key] || { points: [], error: true }) })), errors };
  if (Object.keys(out).length) mem.set(ck, { at: Date.now(), data });
  return data;
}

async function yahoo(sym, range, fetchImpl) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${RANGES[range]}&includePrePost=false`;
  const res = await fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json(); const r = j?.chart?.result?.[0];
  if (!r) throw new Error(j?.chart?.error?.description || 'no data');
  const ts = r.timestamp || []; const cl = r.indicators?.quote?.[0]?.close || [];
  const points = ts.map((t, i) => [t * 1000, cl[i]]).filter((p) => p[1] != null);
  const meta = r.meta || {};
  const last = meta.regularMarketPrice ?? points.at(-1)?.[1] ?? null;
  const prev = range === '1d' ? (meta.chartPreviousClose ?? meta.previousClose ?? null) : (points[0]?.[1] ?? null);
  return { points, last, prev, change: last != null && prev ? (last - prev) / prev : null, asOf: (meta.regularMarketTime || 0) * 1000 || points.at(-1)?.[0] || null, currency: meta.currency || 'USD' };
}

function mockSeries(m, range) {
  const base = { dxy: 99.2, brent: 63.4, gold: 4120 }[m.key];
  const n = { '1d': 96, '5d': 130, '1mo': 160, '6mo': 126, '1y': 250 }[range]; const step = { '1d': 3e5, '5d': 9e5, '1mo': 3.6e6, '6mo': 864e5, '1y': 864e5 }[range];
  let p = base; let seed = base * 100; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  const points = []; const t0 = Date.now() - n * step;
  for (let i = 0; i < n; i++) { p *= 1 + rnd() * 0.004; points.push([t0 + i * step, Math.round(p * 100) / 100]); }
  const prev = points[0][1]; const last = points.at(-1)[1];
  return { points, last, prev, change: (last - prev) / prev, asOf: points.at(-1)[0], currency: 'USD' };
}
