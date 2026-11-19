import { wealthSection, yearlySection } from './wealth.js';
import { dayKey, weekStart, MISTAKES, mistakeName, HORIZON_LABEL } from '../game.js';
import { computeStats, groupBy, rHistogram } from '../stats.js';
import { $, esc, num, sum, money, compact, pct, rfmt, cls, hold, SEGMENTS } from './util.js';
import { S, viewTrades, viewSeg } from './state.js';


// ---------- Insights ----------
export function bars(groups, { fmt = (v) => money(v, { sign: true, dp: 0 }) } = {}) {
  if (!groups.length) return '<div class="empty-sm">Not enough closed trades yet.</div>';
  const max = Math.max(...groups.map((g) => Math.abs(g.net)), 1);
  return `<div class="bars">${groups.map((g) => {
    const w = (Math.abs(g.net) / max) * 50;
    return `<div class="bar-row" title="${g.count} trades · win ${pct(g.winRate, 0)} · avg ${rfmt(g.avgR)}">
      <div class="lbl">${esc(g.key)} <span class="faint">(${g.count})</span></div>
      <div class="bar-track"><div class="mid"></div><div class="bar-fill ${g.net >= 0 ? 'pos' : 'neg'}" style="${g.net >= 0 ? `left:50%;width:${w}%` : `right:50%;width:${w}%`}"></div></div>
      <div class="r num ${cls(g.net)}" style="text-align:right">${fmt(g.net)}</div></div>`;
  }).join('')}</div>`;
}


export function pageInsights() {
  const st = computeStats(viewTrades(), S.state.groups); const g = S.game;
  const head = `<div class="page-h"><div><h1>Insights</h1><p>Where your edge lives — and where it leaks.</p></div>${viewSeg()}</div>`;
  const money_ = wealthSection() + yearlySection();
  if (!st.count) return `${head}${money_}<div class="card empty"><div class="big">📊</div><h2>Close a few trades to unlock insights</h2><p>You'll see P&L by setup, weekday and emotion, your R-multiple distribution, and exactly what your mistakes cost you.</p></div>`;
  const closed = st.closed;
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hist = rHistogram(closed); const hmax = Math.max(...hist.map((h) => h.count), 1);

  // Mistake cost — every mistake the engine knows, plus anything you self-reported.
  const agg = Object.fromEntries(Object.values(MISTAKES).map((n) => [n, { n: 0, net: 0 }]));
  const legsOf = (t) => t.legs || [t];
  for (const { t, m } of closed) {
    const seen = new Set();
    for (const i of legsOf(t).flatMap((l) => g.perTrade[l.id]?.mistakes || [])) {
      const k = mistakeName(i); if (seen.has(k)) continue; seen.add(k);
      (agg[k] ||= { n: 0, net: 0 }); agg[k].n++; agg[k].net += m.net;
    }
  }
  const mistakes = Object.entries(agg).sort((a, b) => (b[1].n > 0) - (a[1].n > 0) || a[1].net - b[1].net);
  const isImp = (t) => legsOf(t).every((l) => l.imported);
  const isClean = (t) => legsOf(t).every((l) => g.perTrade[l.id]?.clean);
  const clean = closed.filter(({ t }) => !isImp(t) && isClean(t));
  const dirty = closed.filter(({ t }) => !isImp(t) && !isClean(t));
  const grp = (list) => ({ n: list.length, net: sum(list.map((x) => x.m.net)), wr: list.length ? list.filter((x) => x.m.net > 0).length / list.length : null, r: (() => { const rs = list.map((x) => x.m.r).filter((v) => v != null); return rs.length ? sum(rs) / rs.length : null; })() });
  const C = grp(clean); const D = grp(dirty);

  const tiles = [
    ['Net P&L', `<span class="${cls(st.net)}">${compact(st.net)}</span>`, `${st.count} closed`],
    ['Expectancy', `<span class="${cls(st.expectancy)}">${compact(st.expectancy)}</span>`, 'avg net per trade'],
    ['Avg win', `<span class="pos">${compact(st.avgWin)}</span>`, `avg loss ${compact(st.avgLoss)} · payoff ${st.avgWin && st.avgLoss ? (st.avgWin / -st.avgLoss).toFixed(2) : '—'}`],
    ['Max drawdown', `<span class="neg">${compact(-st.maxDD)}</span>`, 'peak-to-trough, daily realised'],
    ['Hold: winners', st.avgHoldWin == null ? '—' : hold(st.avgHoldWin), `losers ${st.avgHoldLoss == null ? '—' : hold(st.avgHoldLoss)}`],
    ['Best trade', `<span class="pos">${compact(st.best?.m.net)}</span>`, `${esc(st.best?.t.symbol || '')} · worst ${compact(st.worst?.m.net)}`],
  ];
  return `${head}${money_}
  <div class="kpis" style="margin-bottom:16px">${tiles.map(([k, v, s]) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('')}</div>
  <div class="insights">
    <section class="card span-2"><header class="card-h"><h3>Discipline pays: clean trades vs trades with a broken rule</h3></header>
      <div class="grid-2">
        <div class="kpi" style="border-color:rgba(34,197,94,.35)"><div class="k">✓ Clean trades (${C.n})</div><div class="v ${cls(C.net)}">${compact(C.net)}</div><div class="s">win ${pct(C.wr, 0)} · avg ${rfmt(C.r)}</div></div>
        <div class="kpi" style="border-color:rgba(244,80,107,.35)"><div class="k">✕ Trades with a mistake (${D.n})</div><div class="v ${cls(D.net)}">${compact(D.net)}</div><div class="s">win ${pct(D.wr, 0)} · avg ${rfmt(D.r)}</div></div>
      </div></section>
    <section class="card"><header class="card-h"><h3>What mistakes cost you</h3><span class="sub">net P&L of closed trades with each mistake</span></header>
      ${mistakes.map(([label, v]) => `<div class="mistake ${v.n ? '' : 'none'}"><span>${esc(label)} <span class="faint">× ${v.n}</span></span><span class="num ${cls(v.net)}">${v.n ? money(v.net, { sign: true, dp: 0 }) : '—'}</span></div>`).join('')}
    </section>
    <section class="card"><header class="card-h"><h3>R-multiple distribution</h3><span class="sub">avg ${rfmt(st.avgR)}</span></header>
      <div class="hist">${hist.map((h) => `<div class="col"><div class="c">${h.count || ''}</div><div class="b" style="height:${(h.count / hmax) * 100}%;background:${h.neg ? 'var(--red)' : 'var(--green)'};opacity:${h.count ? 0.85 : 0.15}"></div><div class="l">${h.label}</div></div>`).join('')}</div>
    </section>
    ${S.view !== 'LONGTERM' ? `<section class="card"><header class="card-h"><h3>P&L by trade type</h3></header>${bars(groupBy(closed, (t) => HORIZON_LABEL[t.horizon] || '—'))}</section>` : ''}
    <section class="card"><header class="card-h"><h3>P&L by setup</h3></header>${bars(groupBy(closed, (t) => t.setup || 'Untagged'))}</section>
    <section class="card"><header class="card-h"><h3>P&L by entry emotion</h3></header>${bars(groupBy(closed, (t) => t.emotionEntry || 'Not recorded'))}</section>
    <section class="card"><header class="card-h"><h3>P&L by weekday (entry)</h3></header>${bars(groupBy(closed, (t) => WD[new Date(t.entryTime).getDay()]))}</section>
    <section class="card"><header class="card-h"><h3>P&L by exit reason</h3></header>${bars(groupBy(closed, (t) => t.exitReason || 'Not recorded'))}</section>
    <section class="card"><header class="card-h"><h3>P&L by segment</h3></header>${bars(groupBy(closed, (t) => Object.fromEntries(SEGMENTS)[t.segment] || t.segment))}</section>
    <section class="card"><header class="card-h"><h3>Long vs short</h3></header>${bars(groupBy(closed, (t) => t.side))}</section>
    <section class="card span-2"><header class="card-h"><h3>Daily P&L — last 26 weeks</h3><span class="sub">by exit date</span></header>${heatmap(st.daily)}</section>
  </div>`;
}


export function heatmap(daily) {
  const weeks = 26; const start = new Date(weekStart()); start.setDate(start.getDate() - (weeks - 1) * 7);
  const vals = Object.values(daily); const maxAbs = Math.max(1, ...vals.map(Math.abs));
  const cells = [];
  for (let w = 0; w < weeks; w++) for (let d = 0; d < 5; d++) {
    const dt = new Date(start); dt.setDate(start.getDate() + w * 7 + d);
    const k = dayKey(dt); const v = daily[k];
    const a = v == null ? 0 : 0.25 + 0.75 * (Math.abs(v) / maxAbs);
    const bg = v == null ? '' : v >= 0 ? `background:rgba(34,197,94,${a.toFixed(2)})` : `background:rgba(244,80,107,${a.toFixed(2)})`;
    cells.push(`<div class="cell" style="${bg}" title="${dt.toDateString()}${v == null ? '' : ' · ' + money(v, { sign: true })}"></div>`);
  }
  return `<div class="heat">${cells.join('')}</div><div class="legend"><span>Mon→Fri rows, oldest week on the left</span><span><span class="cell" style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--green)"></span> profit</span><span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--red)"></span> loss</span></div>`;
}
