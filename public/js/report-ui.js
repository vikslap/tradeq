// 📒 Report card — one table that keeps things apart: Equity · Long-term (value buying) vs
// Equity · Trading (swing + positional), F&O, Commodities, with Equity and Overall totals.
// Tap a row for that bucket's year-by-year results (and, for equity, the comparison with a
// Nifty 50 index fund on the same money, the rolling 12 months and the drawdown).
import { BUCKETS, TOTALS, summarize, yearsWithActivity, inBucket } from '../report.js';
import { fyOf } from '../ledger.js';
import { S, ltpFor } from './state.js';
import { $, esc, money, cls } from './util.js';
import { vsIndex, rollingBlock, ddBlock } from './vsindex.js';

const PKEY = 'tq-report-period'; const BKEY = 'tq-report-bucket';
const get = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const put = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private */ } };
const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const rsS = (v) => money(v, { sign: true, dp: 0 });
const rs0 = (v) => money(v, { dp: 0 });
const wr = (r) => (r.winRate == null ? '—' : `${Math.round(r.winRate * 100)}%`);
const ar = (r) => (r.avgR == null ? '—' : `${r.avgR >= 0 ? '+' : ''}${r.avgR.toFixed(2)}R`);
const ALL = [...BUCKETS, ...TOTALS];
const R = { vs: {}, at: 0 };

// The equity buckets' comparison with the index (cached for a minute; closes fetched once).
async function vsFor(id, fetchCloses = false) {
  const k = `${id}:${fetchCloses}`;
  if (R.vs[k] && Date.now() - R.at < 60000) return R.vs[k];
  const r = await vsIndex({ filter: inBucket(id), fetchCloses });
  R.vs[k] = r; R.at = Date.now();
  return r;
}
const gapFor = (r, fy) => { if (!r || r.empty) return null; if (!fy) return r.gap; const y = r.years.find((x) => x.fy === fy); return y ? y.gap : null; };

export const reportSectionShell = () => `<section class="card" style="margin-bottom:16px" id="report">
  <header class="card-h" style="flex-wrap:wrap;gap:8px"><h3>📒 Report card</h3><select class="input sm-select" id="report-period" style="max-width:150px"></select></header>
  <div id="report-body"><div class="empty-sm">Working it out…</div></div>
  <div id="report-detail"></div>
  <p class="faint" style="font-size:11.5px;margin:10px 0 0"><b>Long-term</b> = trades marked Long-term (value buys). <b>Trading</b> = intraday, swing and positional — a swing that becomes positional stays here. F&O includes currency futures; Commodities = MCX. Booked P&L is after Zerodha charges and dated by each exit; Open = today's unrealised P&L on what you still hold. "vs Nifty 50" = what the same rupees, on the same days, would have made in a Nifty 50 index fund — shown for equity only (F&O and commodities run on margin, so an index comparison doesn't fit). Mutual funds are never counted.</p>
</section>`;

function table(rows, period, gaps) {
  const used = (id) => rows[id].trades > 0;
  const shown = ALL.filter((b) => used(b.id) || b.id === 'all');
  const sel = get(BKEY, 'eq-tr');
  const row = (b) => { const r = rows[b.id]; const total = TOTALS.some((t) => t.id === b.id); const g = gaps[b.id];
    return `<tr class="${total ? 'rc-total' : ''} ${sel === b.id ? 'sel-row' : ''}" data-report-bucket="${b.id}" style="cursor:pointer">
      <td><b>${esc(b.label)}</b>${b.hint ? `<div class="sub">${esc(b.hint)}</div>` : ''}</td>
      <td class="r mono" data-l="Trades">${r.trades}${r.openTrades ? `<div class="sub">${r.openTrades} open</div>` : ''}</td>
      <td class="r mono ${cls(r.booked)}" data-l="Booked">${rsS(r.booked)}</td>
      <td class="r mono ${cls(r.open)}" data-l="Open">${r.open ? rsS(r.open) : '—'}</td>
      <td class="r mono ${cls(r.net)}" data-l="Net P&L"><b>${rsS(r.net)}</b></td>
      <td class="r mono" data-l="Charges">${rs0(r.charges)}</td>
      <td class="r mono" data-l="Win rate">${wr(r)}</td>
      <td class="r mono ${cls(r.avgR)}" data-l="Avg R">${ar(r)}</td>
      <td class="r mono ${cls(g)}" data-l="vs Nifty 50">${g == null ? (b.equity || b.id === 'eq' ? '…' : '—') : `<b>${rsS(g)}</b>`}</td></tr>`; };
  return `<div class="table-wrap"><table class="tbl rc-tbl"><thead><tr><th>${esc(period ? period.replace('FY', 'FY ') : 'All time')}</th><th class="r">Trades</th><th class="r">Booked</th><th class="r">Open</th><th class="r">Net P&L</th><th class="r">Charges</th><th class="r">Win rate</th><th class="r">Avg R</th><th class="r">vs Nifty 50</th></tr></thead>
    <tbody>${shown.map(row).join('')}</tbody></table></div>`;
}

async function detail(id) {
  const el = $('#report-detail'); if (!el) return;
  R.detailAt = Date.now();
  const b = ALL.find((x) => x.id === id) || ALL[1];
  const years = yearsWithActivity(S.state.trades, today());
  const per = years.map((fy) => ({ fy, r: summarize(S.state.trades, { ltpFor, fy, today: today() })[b.id] })).filter((x) => x.r.trades);
  const equity = b.equity || b.id === 'eq';
  el.innerHTML = `<h3 class="pp-h" style="margin-top:18px">${esc(b.label)} <span class="sub">year by year</span></h3><div id="rc-years"></div><div id="rc-more"></div>`;
  const vs = equity ? await vsFor(b.id, true).catch(() => null) : null;
  const yt = $('#rc-years'); if (!yt) return;
  yt.innerHTML = per.length ? `<div class="table-wrap"><table class="tbl rc-tbl"><thead><tr><th>Year</th><th class="r">Trades</th><th class="r">Net P&L</th><th class="r">Charges</th><th class="r">Win rate</th><th class="r">Avg R</th>${equity ? '<th class="r">vs Nifty 50</th>' : ''}</tr></thead><tbody>
    ${per.map(({ fy, r }) => { const g = equity ? gapFor(vs, fy) : null; const y = vs?.years?.find((x) => x.fy === fy);
      return `<tr><td><b>${esc(fy)}</b>${fy === fyOf(today()) ? ' <span class="pill">so far</span>' : ''}${y?.estimated ? ' <span class="pill" title="Some 31-March prices were unavailable, so part of the split is by days held">≈</span>' : ''}</td><td class="r mono" data-l="Trades">${r.trades}</td><td class="r mono ${cls(r.net)}" data-l="Net P&L"><b>${rsS(r.net)}</b></td><td class="r mono" data-l="Charges">${rs0(r.charges)}</td><td class="r mono" data-l="Win rate">${wr(r)}</td><td class="r mono ${cls(r.avgR)}" data-l="Avg R">${ar(r)}</td>${equity ? `<td class="r mono ${cls(g)}" data-l="vs Nifty 50">${g == null ? '—' : rsS(g)}</td>` : ''}</tr>`; }).join('')}
  </tbody></table></div>` : '<div class="empty-sm">No trades in this bucket yet.</div>';
  const more = $('#rc-more');
  if (more && vs && !vs.empty) {
    const lt = b.id === 'eq-lt';
    more.innerHTML = `${lt && vs.youXirr != null ? `<div class="sub" style="margin-top:10px">Yearly return on your long-term buys: <b class="${cls(vs.youXirr - vs.idxXirr)}">${(vs.youXirr * 100).toFixed(1)}%</b> vs <b>${(vs.idxXirr * 100).toFixed(1)}%</b> for the same money in a Nifty 50 index fund.</div>` : ''}${lt ? '' : rollingBlock(vs)}${ddLine(vs)}`;
  }
}

// Drawdown in one line: your deepest fall vs the index's, on the same money.
function ddLine(vs) {
  const y = vs.dd.you; const i = vs.dd.idx;
  return `<div class="sub" style="margin-top:12px">📉 Deepest fall from a previous high: <b class="neg">−${rs0(y.max)}</b>${y.max ? ` (${esc(y.from)} → ${esc(y.to)})` : ''} · the index on the same money: <b class="neg">−${rs0(i.max)}</b>${y.current ? ` · now ${rs0(y.current)} below your high` : ' · you\'re at a high now'}.</div>`;
}

export async function mountReport() {
  const sel = $('#report-period'); const body = $('#report-body'); if (!sel || !body) return;
  const years = yearsWithActivity(S.state.trades, today());
  const period = get(PKEY, fyOf(today()));
  const valid = period === 'all' || years.includes(period) ? period : 'all';
  sel.innerHTML = `<option value="all" ${valid === 'all' ? 'selected' : ''}>All time</option>${years.map((y) => `<option value="${y}" ${y === valid ? 'selected' : ''}>${y.replace('FY', 'FY ')}</option>`).join('')}`;
  if (!sel.dataset.bound) {
    sel.dataset.bound = '1';
    sel.addEventListener('change', () => { put(PKEY, sel.value); mountReport(); });
    document.addEventListener('click', (e) => { const tr = e.target.closest?.('[data-report-bucket]'); if (!tr || !$('#report')) return; put(BKEY, tr.dataset.reportBucket); document.querySelectorAll('[data-report-bucket]').forEach((x) => x.classList.toggle('sel-row', x === tr)); detail(tr.dataset.reportBucket); });
  }
  const fy = valid === 'all' ? null : valid;
  const rows = summarize(S.state.trades, { ltpFor, fy, today: today() });
  R.fy = fy; R.gaps = R.gapsFy === fy ? R.gaps || {} : {};
  body.innerHTML = table(rows, fy, R.gaps);
  detail(get(BKEY, 'eq-tr'));
  // Fill in the index comparison for the equity rows (needs the fund's prices).
  const gaps = {};
  for (const id of ['eq-lt', 'eq-tr', 'eq']) if (rows[id].trades) { try { gaps[id] = gapFor(await vsFor(id), fy); } catch { gaps[id] = null; } }
  R.gaps = gaps; R.gapsFy = fy;
  if ($('#report-body')) body.innerHTML = table(summarize(S.state.trades, { ltpFor, fy, today: today() }), fy, gaps);
}

/** Live prices arrived: refresh the open P&L in the report card and the dashboard tile. */
export function repaintReport() {
  const body = $('#report-body');
  if (body && R.fy !== undefined) body.innerHTML = table(summarize(S.state.trades, { ltpFor, fy: R.fy, today: today() }), R.fy, R.gaps || {});
  if ($('#rc-tile-body') && R.tilePaint) R.tilePaint();
  if ($('#report-detail') && Date.now() - (R.detailAt || 0) > 60000) detail(get(BKEY, 'eq-tr'));
}

// ---------- dashboard tile: this financial year at a glance ----------
export const reportTileShell = () => `<section class="card o-vs" id="rc-tile"><header class="card-h"><h3>📒 ${esc(fyOf(today()).replace('FY', 'FY '))} so far</h3><a class="sub" href="#/capital">report card →</a></header><div id="rc-tile-body">${S.rcTileHtml || '<div class="empty-sm">Working it out…</div>'}</div></section>`;

export async function mountReportTile() {
  const el = $('#rc-tile-body'); if (!el) return;
  const fy = fyOf(today());
  const rows = summarize(S.state.trades, { ltpFor, fy, today: today() });
  const shown = ALL.filter((b) => rows[b.id].trades && b.id !== 'eq');
  if (!rows.all.trades) { el.innerHTML = '<div class="empty-sm">No trades this financial year yet.</div>'; return; }
  const paint = (gaps) => {
    S.rcTileHtml = `<div class="vs-rows">${shown.map((b) => { const r = rows[b.id]; const g = gaps[b.id];
      const tag = b.id === 'all' ? `${r.trades} trades · ${rs0(r.charges)} charges` : b.equity ? (g == null ? (b.id === 'eq-tr' ? ar(r) : '') : `${rsS(g)} vs Nifty 50`) : `${wr(r)} win rate · ${ar(r)}`;
      return `<div class="${b.id === 'all' ? 'rc-all' : ''}"><span>${esc(b.label)}</span><b class="mono ${cls(r.net)}">${rsS(r.net)}</b><em>${tag}</em></div>`; }).join('')}</div>`;
    el.innerHTML = S.rcTileHtml;
  };
  R.tilePaint = () => { const now = summarize(S.state.trades, { ltpFor, fy, today: today() }); Object.assign(rows, now); paint(R.tileGaps || {}); };
  paint(R.tileGaps || {});
  const gaps = {};
  for (const id of ['eq-lt', 'eq-tr']) if (rows[id].trades) { try { gaps[id] = gapFor(await vsFor(id), fy); } catch { /* leave blank */ } }
  R.tileGaps = gaps;
  if ($('#rc-tile-body')) paint(gaps);
}
