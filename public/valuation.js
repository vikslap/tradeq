// Nifty 50 valuation: NSE's daily P/E (also P/B and dividend yield) and how today's
// reading compares with its own history — median, percentile, and where the
// "cheap" and "expensive" quartiles sit.
//
// Source: niftyindices.com (NSE Indices). One caveat matters for medians: from
// 1 April 2021 NSE switched the index P/E from standalone to consolidated earnings,
// which pushed readings down by roughly 1–2 points. Medians that mix both eras
// overstate the "normal" P/E a little, so the post-2021 median is shown separately.

export const BASIS_CHANGE = '2021-04-01';
const MON = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

// "20 Nov 2026" / "20-Nov-2026" / "20-11-2026" / "2026-11-20" → "2026-11-20"
export function isoDate(s) {
  s = String(s || '').trim().replace(/"/g, '');
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[\s\-/]([A-Za-z]{3})[A-Za-z]*[\s\-/,]+(\d{4})$/); if (m && MON[m[2].toLowerCase()]) return `${m[3]}-${MON[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

const num = (v) => { const n = Number(String(v ?? '').replace(/[",\s]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };

// Rows from niftyindices' getpepbHistoricaldataDBtoString: {d: "[{HistoricalDate, pe, pb, divYield}, …]"}
export function parseNseRows(json) {
  let rows = json?.d ?? json;
  if (typeof rows === 'string') rows = JSON.parse(rows);
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({ date: isoDate(r.HistoricalDate ?? r.Date ?? r.date), pe: num(r.pe ?? r.PE ?? r['P/E']), pb: num(r.pb ?? r.PB ?? r['P/B']), dy: num(r.divYield ?? r.DY ?? r['Div Yield']) }))
    .filter((r) => r.date && r.pe);
}

// The CSV you can download from niftyindices.com → Reports → Historical data → P/E, P/B & Div Yield.
export function parsePeCsv(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const split = (l) => { const out = []; let cur = ''; let q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; } else cur += ch; } out.push(cur.trim()); return out; };
  const hi = lines.findIndex((l) => /p\s*\/?\s*e/i.test(l) && /date/i.test(l));
  if (hi < 0) return [];
  const head = split(lines[hi]).map((h) => h.toLowerCase().replace(/\s+/g, ''));
  const col = (re) => head.findIndex((h) => re.test(h));
  const cd = col(/date/); const cpe = col(/^p\/?e$|pe(ratio)?$/); const cpb = col(/^p\/?b$|pb(ratio)?$/); const cdy = col(/div|yield/);
  if (cd < 0 || cpe < 0) return [];
  return lines.slice(hi + 1).map((l) => { const c = split(l); return { date: isoDate(c[cd]), pe: num(c[cpe]), pb: cpb >= 0 ? num(c[cpb]) : null, dy: cdy >= 0 ? num(c[cdy]) : null }; })
    .filter((r) => r.date && r.pe);
}

// Stored shape: parallel arrays, sorted by date. New rows overwrite same-date rows.
export function mergeSeries(series, rows) {
  const map = new Map();
  const s = series || {};
  (s.dates || []).forEach((d, i) => map.set(d, { date: d, pe: s.pe[i], pb: s.pb?.[i] ?? null, dy: s.dy?.[i] ?? null }));
  for (const r of rows || []) map.set(r.date, r);
  const all = [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  return { dates: all.map((r) => r.date), pe: all.map((r) => r.pe), pb: all.map((r) => r.pb), dy: all.map((r) => r.dy) };
}

const quantile = (sorted, q) => { if (!sorted.length) return null; const p = (sorted.length - 1) * q; const lo = Math.floor(p); const hi = Math.ceil(p); return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo); };

export function windowStats(series, fromDate, value) {
  const v = []; let first = null;
  series.dates.forEach((d, i) => { if (d >= fromDate && series.pe[i]) { v.push(series.pe[i]); if (!first) first = d; } });
  if (v.length < 60) return null;
  const s = [...v].sort((a, b) => a - b);
  const below = s.filter((x) => x < value).length;
  return { from: first, n: v.length, median: quantile(s, 0.5), q1: quantile(s, 0.25), q3: quantile(s, 0.75), min: s[0], max: s[s.length - 1], percentile: Math.round((below / s.length) * 100) };
}

const yearsBack = (iso, y) => `${Number(iso.slice(0, 4)) - y}${iso.slice(4)}`;

// Everything the tile needs. `today` is the last date in the series unless given.
export function valuationSummary(series) {
  if (!series?.dates?.length) return null;
  const i = series.dates.length - 1;
  const asOf = series.dates[i]; const pe = series.pe[i];
  const windows = [
    { key: '5y', label: '5-year', from: yearsBack(asOf, 5) },
    { key: '10y', label: '10-year', from: yearsBack(asOf, 10) },
    { key: 'post21', label: 'Since Apr 2021 (consolidated)', from: BASIS_CHANGE },
    { key: 'all', label: 'All history', from: '0000' },
  ].map((w) => ({ ...w, ...(windowStats(series, w.from, pe) || {}) })).filter((w) => w.median != null);
  const prevYear = series.dates.findIndex((d) => d >= yearsBack(asOf, 1));
  return { asOf, pe, pb: series.pb?.[i] ?? null, dy: series.dy?.[i] ?? null, peYearAgo: prevYear >= 0 ? series.pe[prevYear] : null, first: series.dates[0], windows };
}

export function zone(pe, w) {
  if (!w) return ['', ''];
  if (pe >= w.q3) return ['neg', 'expensive vs its history'];
  if (pe <= w.q1) return ['pos', 'cheap vs its history'];
  return ['', pe >= w.median ? 'above median' : 'below median'];
}

// Fetch windows for niftyindices (it is happier with ≤1 year per request).
export function yearChunks(from, to) {
  const out = []; let a = new Date(`${from}T00:00:00Z`); const end = new Date(`${to}T00:00:00Z`);
  while (a <= end) { const b = new Date(Math.min(Date.UTC(a.getUTCFullYear(), 11, 31), end)); out.push([a.toISOString().slice(0, 10), b.toISOString().slice(0, 10)]); a = new Date(Date.UTC(a.getUTCFullYear() + 1, 0, 1)); }
  return out;
}

const M3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const nseDate = (iso) => `${iso.slice(8, 10)}-${M3[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}`;
