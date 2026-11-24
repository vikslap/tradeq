// "You vs Nifty 50" — Swing + Positional stock trades against the same money in a
// Nifty 50 index fund over the same days. Dashboard tile + Insights section with a
// year-by-year scorecard. Mutual funds, long-term holds, intraday and F&O are left out.
import { slicesOf, compareWithIndex, marksNeeded } from '../benchmark.js';
import { fyOf } from '../ledger.js';
import { S, api, ltpFor } from './state.js';
import { $, esc, money, pct, cls } from './util.js';
import { rawCandles, tokensFor } from './breadth.js';

const DAY = 86400000;
const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const rs0 = (v) => money(v, { dp: 0 });
const rsS = (v) => money(v, { sign: true, dp: 0 });
const pp = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
const MKEY = 'tq-fy-closes'; // { "SYM|2025-03-31": close } — history doesn't change, so keep it

const marks = () => { try { return JSON.parse(localStorage.getItem(MKEY) || '{}'); } catch { return {}; } };
const saveMarks = (m) => { try { localStorage.setItem(MKEY, JSON.stringify(m)); } catch { /* full / private */ } };

// Fetch the 31-March closes the yearly split needs (once; cached in this browser).
async function fetchMarks(need) {
  const m = marks(); const missing = [];
  for (const [sym, ds] of need) for (const d of ds) if (!(`${sym}|${d}` in m)) missing.push([sym, d]);
  if (!missing.length || !S.kite?.connected) return m;
  const syms = [...new Set(missing.map(([s]) => s))];
  let toks = {}; try { toks = await tokensFor(syms); } catch { return m; }
  for (const sym of syms) {
    const tok = toks[sym]; const ds = missing.filter(([s]) => s === sym).map(([, d]) => d);
    if (!tok) { for (const d of ds) m[`${sym}|${d}`] = null; continue; } // renamed / delisted: estimate by days
    for (const d of ds) {
      try {
        const c = await rawCandles(tok, 'day', Date.parse(d) - 10 * DAY, Date.parse(d) + DAY);
        const last = c.filter((x) => new Date(x[0] + 330 * 60000).toISOString().slice(0, 10) <= d).at(-1);
        m[`${sym}|${d}`] = last ? last[4] : null;
      } catch { /* try again next time */ }
    }
  }
  saveMarks(m);
  return m;
}

/** Work it all out (cached until trades, prices or the day change). */
export async function vsIndex({ fetchCloses = true } = {}) {
  const scheme = S.state.settings.benchmarkScheme || '120716';
  S._bench ||= {};
  const b = (S._bench[scheme] ||= await api(`/api/benchmark?scheme=${scheme}`));
  const d = today();
  const slices = slicesOf(S.state.trades, ltpFor, d);
  if (!slices.length) return { empty: true };
  const need = marksNeeded(slices);
  const m = fetchCloses ? await fetchMarks(need) : marks();
  const r = compareWithIndex(slices, b.nav, d, (sym, date) => m[`${sym}|${date}`] ?? null);
  return { ...r, fundName: b.name, navTo: b.nav.at(-1)?.[0] };
}

// ---------- dashboard tile ----------
export const vsTileShell = () => `<section class="card o-vs" id="vs-tile"><header class="card-h"><h3>🏁 You vs Nifty 50</h3><a class="sub" href="#/insights">details →</a></header><div id="vs-tile-body">${S.vsTileHtml || '<div class="empty-sm">Working it out…</div>'}</div></section>`;

export async function mountVsTile() {
  const el = $('#vs-tile-body'); if (!el) return;
  try {
    const r = await vsIndex();
    if (r.empty) { el.innerHTML = '<div class="empty-sm">Log some Swing or Positional trades to compare them with the index.</div>'; return; }
    const fy = r.years.find((y) => y.fy === fyOf(today()));
    const ahead = r.gap >= 0;
    S.vsTileHtml = `<div class="vs-head ${ahead ? 'pos' : 'neg'}"><span class="mono">${rsS(r.gap)}</span><small>${ahead ? 'ahead of' : 'behind'} the index since ${new Date(`${r.first}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' })}</small></div>
      <div class="vs-rows">
        <div><span>Your trades</span><b class="mono ${cls(r.you)}">${rsS(r.you)}</b><em>${r.youXirr != null ? `${pct(r.youXirr)} a year` : pp(r.youPct)}</em></div>
        <div><span>Same money in Nifty 50</span><b class="mono ${cls(r.idx)}">${rsS(r.idx)}</b><em>${r.idxXirr != null ? `${pct(r.idxXirr)} a year` : pp(r.idxPct)}</em></div>
        ${fy ? `<div><span>This year (${esc(fy.fy)})</span><b class="mono ${cls(fy.gap)}">${rsS(fy.gap)}</b><em>${pp(fy.youPct)} vs ${pp(fy.idxPct)}</em></div>` : ''}
      </div>
      <div class="sub" style="font-size:11px;margin-top:6px">Swing + Positional stock trades only, after charges, against the same rupees in a Nifty 50 index fund over the same days.${r.unpriced ? ` ${r.unpriced} open position${r.unpriced === 1 ? '' : 's'} without a live price counted at cost.` : ''}</div>`;
    el.innerHTML = S.vsTileHtml;
  } catch (e) { el.innerHTML = `<div class="sub neg">${esc(e.message)}</div>`; }
}

// ---------- Insights section ----------
export const vsSectionShell = () => `<section class="card" style="margin-bottom:16px" id="vs-section">
  <header class="card-h" style="flex-wrap:wrap;gap:8px"><h3>🏁 Are my trades beating the index?</h3><span class="sub">Swing + Positional stock trades only</span></header>
  <div id="vs-body"><div class="empty-sm">Working it out…</div></div>
  <p class="faint" style="font-size:12px;margin:10px 0 0">Every rupee you put into a Swing or Positional stock trade is matched with the same rupees in a Nifty 50 index fund (direct plan, after its costs), bought the day you entered and sold the day you exited; open trades are marked at today's price. Your side is after Zerodha charges. <b>Not counted:</b> mutual funds, long-term holdings, intraday trades and F&O. "Return on money used" divides by the average rupees you actually had in trades, so both sides are judged on the same money. Years split at 31 March using each stock's closing price that day.</p>
</section>`;

export async function mountVsSection() {
  const el = $('#vs-body'); if (!el) return;
  try {
    const r = await vsIndex();
    if (r.empty) { el.innerHTML = '<div class="empty-sm">No Swing or Positional stock trades yet.</div>'; return; }
    const ahead = r.gap >= 0;
    const k = (label, v, s, c = '') => `<div class="kpi"><div class="k">${label}</div><div class="v mono ${c}">${v}</div><div class="s">${s}</div></div>`;
    const rows = [...r.years].reverse().map((y) => `<tr>
      <td><b>${esc(y.fy)}</b>${y.partial ? ' <span class="pill">so far</span>' : ''}${y.estimated ? ' <span class="pill" title="Some 31-March closing prices weren\'t available, so part of the split is by days held">≈</span>' : ''}</td>
      <td class="r">${y.trades}</td><td class="r mono">${rs0(y.avgDeployed)}</td>
      <td class="r mono ${cls(y.you)}" data-l="You">${rsS(y.you)}<div class="sub">${pp(y.youPct)}</div></td>
      <td class="r mono ${cls(y.idx)}" data-l="Nifty 50">${rsS(y.idx)}<div class="sub">${pp(y.idxPct)}</div></td>
      <td class="r mono" data-l="Gap"><b class="${cls(y.gap)}">${rsS(y.gap)}</b><div class="sub ${cls(y.gap)}">${y.youPct != null ? `${y.gap >= 0 ? '+' : ''}${((y.youPct - y.idxPct) * 100).toFixed(1)} pts` : ''}</div></td>
      <td class="r mono ${cls(y.niftyYear)}">${pp(y.niftyYear)}</td></tr>`).join('');
    const won = r.years.filter((y) => y.gap > 0).length;
    el.innerHTML = `<div class="kpis k4" style="margin-bottom:12px">
        ${k('Your trades made', rsS(r.you), `${r.trades} trades · ${rs0(r.charges)} charges paid`, cls(r.you))}
        ${k('Same money in Nifty 50', rsS(r.idx), 'bought and sold on the same days', cls(r.idx))}
        ${k(ahead ? 'You are ahead by' : 'You are behind by', rs0(Math.abs(r.gap)), `return on money used: ${pp(r.youPct)} vs ${pp(r.idxPct)}`, ahead ? 'pos' : 'neg')}
        ${k('Yearly return', r.youXirr != null ? pct(r.youXirr) : '—', r.youXirr != null ? `index on the same money: ${pct(r.idxXirr)}` : 'shown after a year of trades', cls((r.youXirr ?? 0) - (r.idxXirr ?? 0)))}
      </div>
      <div class="sub" style="margin-bottom:8px">You beat the index in <b>${won} of ${r.years.length}</b> financial year${r.years.length === 1 ? '' : 's'}. On average you had <b>${rs0(r.avgDeployed)}</b> in trades.</div>
      <div class="table-wrap"><table class="tbl vs-tbl"><thead><tr><th>Year</th><th class="r">Trades</th><th class="r">Avg money<br>used</th><th class="r">You</th><th class="r">Same money<br>in Nifty 50</th><th class="r">Gap</th><th class="r">Nifty 50 fund,<br>whole year</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="sub" style="font-size:11.5px;margin-top:6px">"Nifty 50 fund, whole year" is the fund's return from 1 April to 31 March — what you'd have got with all your money in it all year, for context.${r.estimated ? ' ≈ = some 31-March prices were unavailable (renamed or delisted stocks), so that part is split by days held.' : ''}</div>`;
  } catch (e) { el.innerHTML = `<div class="sub neg">${esc(e.message)}</div>`; }
}
