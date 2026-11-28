// 📅 Monthly returns — a fund-style performance grid: months down, years across (newest
// first), each cell that month's booked P&L as a % of the account at the start of the month.
import { BUCKETS, TOTALS, exitEvents, monthlyReturns } from '../report.js';
import { S } from './state.js';
import { $, esc, money } from './util.js';

const BKEY = 'tq-monthly-bucket'; const YKEY = 'tq-monthly-basis';
const get = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const put = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private */ } };
const pct = (v) => `${v >= 0 ? '' : '−'}${Math.abs(v * 100).toFixed(2)}%`;
const OPTS = [...BUCKETS, ...TOTALS];
const tint = (v) => { if (v == null || v === 0) return ''; const a = Math.min(0.45, 0.08 + Math.abs(v) * 3); return `background:${v > 0 ? `rgba(22,163,74,${a})` : `rgba(220,38,38,${a})`}`; };

export const monthlyShell = () => `<section class="card" style="margin-bottom:16px" id="monthly">
  <header class="card-h" style="flex-wrap:wrap;gap:8px"><h3>📅 Monthly returns</h3>
    <span class="row" style="gap:8px;flex-wrap:wrap">
      <select class="input sm-select" id="mr-bucket">${OPTS.map((b) => `<option value="${b.id}" ${get(BKEY, 'eq-tr') === b.id ? 'selected' : ''}>${esc(b.label)}</option>`).join('')}</select>
      <select class="input sm-select" id="mr-basis"><option value="cal" ${get(YKEY, 'cal') === 'cal' ? 'selected' : ''}>Calendar years</option><option value="fy" ${get(YKEY, 'cal') === 'fy' ? 'selected' : ''}>Financial years</option></select>
    </span></header>
  <div id="mr-body"></div>
</section>`;

function render() {
  const el = $('#mr-body'); if (!el) return;
  const st = S.state.settings; const capital = Number(st.capital) || 0;
  if (!capital) { el.innerHTML = '<div class="empty-sm">Set your trading capital above — monthly returns are worked out as a % of it.</div>'; return; }
  const bucket = get(BKEY, 'eq-tr'); const basis = get(YKEY, 'cal');
  const r = monthlyReturns(exitEvents(S.state.trades, bucket), { capital, sweeps: st.sweeps || [], basis });
  if (!r.years.length) { el.innerHTML = '<div class="empty-sm">No closed trades in this bucket yet.</div>'; return; }
  const cell = (c) => {
    if (!c) return '<td></td>';
    if (!c.traded) return `<td class="r mono faint" title="No exits this month">—</td>`;
    return `<td class="r mono ${c.pct >= 0 ? 'pos' : 'neg'}" style="${tint(c.pct)}" title="${esc(c.month)}: ${esc(money(c.pnl, { sign: true, dp: 0 }))} on ${esc(money(c.start, { dp: 0 }))}">${c.pct == null ? '—' : pct(c.pct)}</td>`;
  };
  const best = []; const worst = []; let up = 0; let n = 0;
  for (const y of r.years) for (const c of r.cells[y]) if (c?.traded && c.pct != null) { n++; if (c.pct > 0) up++; best.push(c); worst.push(c); }
  best.sort((a, b) => b.pct - a.pct); worst.sort((a, b) => a.pct - b.pct);
  const mname = (k) => new Date(`${k}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  el.innerHTML = `<div class="table-wrap"><table class="tbl mr-tbl"><thead><tr><th></th>${r.years.map((y) => `<th class="r">${esc(basis === 'fy' ? y.replace('FY', 'FY ') : y)}</th>`).join('')}</tr></thead><tbody>
      ${r.labels.map((m, i) => `<tr><th class="mr-m"><span class="mr-long">${m}</span><span class="mr-short">${m.slice(0, 3)}</span></th>${r.years.map((y) => cell(r.cells[y][i])).join('')}</tr>`).join('')}
      <tr class="mr-ytd"><th class="mr-m">${basis === 'fy' ? 'Year' : 'YTD'}</th>${r.years.map((y) => { const t = r.totals[y]; return `<td class="r mono ${t.pct >= 0 ? 'pos' : 'neg'}" title="${esc(money(t.pnl, { sign: true, dp: 0 }))}"><b>${pct(t.pct)}</b></td>`; }).join('')}</tr>
    </tbody></table></div>
    <div class="sub" style="margin-top:8px">Positive in <b>${up} of ${n}</b> months with exits${best[0] ? ` · best ${mname(best[0].month)} <b class="pos">${pct(best[0].pct)}</b> · worst ${mname(worst[0].month)} <b class="neg">${pct(worst[0].pct)}</b>` : ''}.</div>
    <p class="faint" style="font-size:11.5px;margin:8px 0 0">Each month = profit booked that month (after Zerodha charges, dated by each exit) ÷ the account at the start of the month, which begins at your trading capital (${esc(money(capital, { dp: 0 }))}), grows with profits and drops with sweeps. ${basis === 'fy' ? 'Year' : 'YTD'} compounds the months. Open positions count when you exit. "—" = no exits that month. Hover a cell for the ₹ amounts.</p>`;
}

export function mountMonthly() {
  const b = $('#mr-bucket'); const y = $('#mr-basis'); if (!b) return;
  if (!b.dataset.bound) {
    b.dataset.bound = '1';
    b.addEventListener('change', () => { put(BKEY, b.value); render(); });
    y.addEventListener('change', () => { put(YKEY, y.value); render(); });
  }
  render();
}
