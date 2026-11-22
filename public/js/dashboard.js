import { breadthCardShell } from './breadthlive.js';
import { valuationCardShell } from './valuation-ui.js';
import { metrics, tradeKey, isLT, isTrading, reviewStatus } from '../game.js';
import { computeStats, investmentStats } from '../stats.js';
import { mountEquityChart } from '../tradechart.js';
import { $, esc, nf0, num, sum, money, compact, price, pct, rfmt, cls, fmtTime, ago, hold, xpPill, ring } from './util.js';
import { S, syncQuest, syncBadge, viewTrades, viewSeg, linkPill, quoteFor, ltpFor } from './state.js';


export function pageDashboard() {
  const { trades, settings } = S.state; const g = S.game; const st = S.stats;
  if (!trades.length) {
    return `<div class="card empty">
      <div class="big">⚔️</div><h2>Welcome, ${esc(settings.displayName)}. Your quest starts with one trade.</h2>
      <p>TradeQuest rewards <b>process</b>, not profit: set a stop before you enter, keep risk within ₹${nf0.format(settings.maxRiskPerTrade)}, follow your plan and write down what you learned. Do that consistently and the XP, levels and badges follow.</p>
      <div class="row" style="justify-content:center"><button class="btn primary" data-action="new-trade">＋ Log your first trade</button><a class="btn" href="#/settings">Connect Kite</a></div>
    </div>`;
  }
  const L = g.level;
  const open = trades.filter((t) => t.status === 'OPEN' && isTrading(t));
  const lastBadge = g.badges.filter((b) => b.earned).sort((a, b) => new Date(b.earnedAt) - new Date(a.earnedAt))[0];
  const discColor = g.discipline == null ? 'var(--faint)' : g.discipline >= 80 ? 'var(--green)' : g.discipline >= 60 ? 'var(--gold)' : 'var(--red)';
  const quests = [...g.quests, ...syncQuest()];
  const doneQ = quests.filter((q) => q.done).length;
  return `<div class="dash2">
  <div class="dash-main">
    <div class="kpis k6 o-kpis" id="kpis">${kpiTiles()}</div>
    <section class="card o-open">
      <header class="card-h"><h3>Open positions <span class="faint" style="font-weight:500">· ${open.length}</span></h3><span class="row"><span class="sub" id="live-note">${liveNote()}</span><span id="sync-badge">${syncBadge()}</span></span></header>
      <div id="open-positions">${openPositionsInner()}</div>
    </section>
    <section class="card o-equity">
      ${(() => { const vs = computeStats(viewTrades(), S.state.groups); return `<header class="card-h"><h3>Equity curve</h3>${viewSeg()}</header>
      <div class="sub" style="margin:-6px 0 10px">${vs.count} closed · net ${compact(vs.net)} · max drawdown ${compact(-vs.maxDD)} · daily, by exit date</div>
      ${equityChart(vs.curve)}`; })()}
    </section>
    ${longTermCard()}
  </div>
  <aside class="dash-rail">
    <section class="card hero o-hero">
      <div class="ring-wrap">${ring(L.progress, 118, 10, 'url(#lvlgrad)')}<svg width="0" height="0" style="position:absolute"><defs><linearGradient id="lvlgrad" x1="0" x2="1"><stop offset="0" stop-color="#8b6cff"/><stop offset="1" stop-color="#5ad1ff"/></linearGradient></defs></svg>
        <div class="ring-label"><div><small>Level</small><b>${L.lvl}</b></div></div></div>
      <div style="flex:1;min-width:0">
        <h2>${esc(settings.displayName)}, ${esc(L.title)}</h2>
        <div class="title-line">${nf0.format(L.next - L.xp)} XP to Level ${L.lvl + 1}${lastBadge ? ` · latest badge ${lastBadge.icon} ${esc(lastBadge.name)}` : ''}</div>
        <div class="meters">
          <div class="meter"><div class="v gold">${nf0.format(g.xp)}</div><div class="k">Total XP</div></div>
          <div class="meter"><div class="v" style="color:${discColor}">${g.discipline == null ? '—' : g.discipline + '%'}</div><div class="k">Discipline</div></div>
          <div class="meter"><div class="v">🔥 ${g.streak.current}</div><div class="k">Clean streak · best ${g.streak.best}</div></div>
          <div class="meter"><div class="v">${g.badges.filter((b) => b.earned).length}/${g.badges.length}</div><div class="k">Badges</div></div>
        </div>
      </div>
    </section>
    ${breadthCardShell()}
    ${valuationCardShell()}
    <section class="card o-quests">
      <header class="card-h"><h3>Today's quests</h3><span class="sub">${doneQ}/${quests.length} done · clean day = +20 XP</span></header>
      <div class="quests">${quests.map(questHtml).join('')}</div>
    </section>
    <section class="card o-xp">
      <header class="card-h"><h3>XP feed</h3><a class="link" href="#/achievements">See all →</a></header>
      ${xpFeed(g.events.slice(0, 9))}
    </section>
  </aside>
  </div>`;
}


export function longTermCard() {
  const lt = S.state.trades.filter(isLT);
  if (!lt.length) return '';
  return `<section class="card o-lt" id="lt-card">${longTermInner()}</section>`;
}


export function longTermInner() {
  const inv = investmentStats(S.state.trades, ltpFor);
  const rows = inv.holdings.sort((a, b) => b.inv - a.inv);
  return `<header class="card-h"><h3>🌳 Long-term holdings <span class="faint" style="font-weight:500">· ${rows.length}</span></h3>
      <span class="sub lt-sum">invested ${compact(inv.invested)} · value ${compact(inv.value)}${inv.unpriced ? `<span class="faint" title="${inv.unpriced} holding(s) without a live price are counted at cost">*</span>` : ''} · P&L <span class="${cls(inv.unrealised)}">${compact(inv.unrealised)} (${pct(inv.returnPct)})</span>${inv.xirr != null ? ` · XIRR <b class="${cls(inv.xirr)}">${pct(inv.xirr)}</b>` : ''}${inv.sold.length ? ` · realised ${compact(inv.realised)}` : ''}</span></header>
    ${rows.length ? `<div class="table-wrap"><table class="tbl ltt"><thead><tr><th>Symbol</th><th class="r">Qty</th><th class="r">Avg</th><th class="r">LTP</th><th class="r">Value</th><th class="r">P&L</th><th class="r">Return</th><th class="r">CAGR</th><th>Held</th><th>Thesis review</th><th></th></tr></thead><tbody>
    ${rows.map((h) => { const rs = reviewStatus(h.t); return `<tr class="click" data-action="open-drawer" data-id="${h.t.id}">
      <td><span class="sym">${esc(h.t.symbol)}</span><span class="exch">${h.t.exchange}</span></td>
      <td class="r num">${nf0.format(h.t.qty)}</td><td class="r num">${price(h.t.entryPrice)}</td><td class="r num">${h.unpriced ? `<span class="faint" title="${S.kite.connected ? 'Kite returned no price for this symbol — check it matches Kite (Edit → symbol search)' : 'Connect Kite for live prices'}">no price</span>` : price(h.ltp)}</td>
      <td class="r num">${h.value == null ? '—' : compact(h.value)}</td><td class="r num ${cls(h.pnl)}">${h.pnl == null ? '—' : money(h.pnl, { sign: true, dp: 0 })}</td>
      <td class="r num ${cls(h.ret)}">${pct(h.ret)}</td><td class="r num ${cls(h.cagr)}">${h.cagr != null ? pct(h.cagr) : h.unpriced ? '<span class="faint" title="No live price">—</span>' : '<span class="faint" title="Annualised returns are shown after 1 year — short periods exaggerate">&lt;1y</span>'}</td>
      <td class="muted">${hold(h.days)}</td>
      <td>${rs.overdue ? '<span class="pill red">overdue</span>' : rs.daysLeft <= 14 ? `<span class="pill gold">due in ${rs.daysLeft}d</span>` : `<span class="pill">in ${rs.daysLeft}d</span>`}</td>
      <td class="r"><button class="btn sm" data-action="thesis-review" data-id="${h.t.id}">Review</button></td></tr>`; }).join('')}</tbody></table></div>`
    : '<div class="empty-sm">No long-term holdings open.</div>'}`;
}


export function questHtml(q) {
  const state = q.failed ? 'failed' : q.done ? 'done' : q.isIdle ? 'idle' : '';
  const right = q.failed ? `${q.progress}/${q.total} ✕` : q.done ? '✓ done' : q.isIdle ? '—' : `${q.progress}/${q.total}`;
  const p = q.total ? Math.min(1, q.progress / q.total) : 0;
  return `<div class="quest ${state}">
    <div class="q-icon">${q.icon}</div>
    <div class="q-body"><div class="q-title">${esc(q.title)} ${q.weekly ? '<span class="pill violet">weekly</span>' : ''}</div>
      <div class="q-desc">${esc(q.isIdle && q.idle ? q.idle : q.desc)}</div>
      ${!q.isIdle ? `<div class="mini-bar"><span style="width:${p * 100}%;${q.failed ? 'background:var(--red)' : ''}"></span></div>` : ''}</div>
    <div class="q-state">${right}</div>
  </div>`;
}


export function unrealised() {
  return sum(S.state.trades.filter((t) => t.status === 'OPEN' && isTrading(t)).map((t) => metrics(t, ltpFor(t)).net || 0));
}


export function kpiTiles() {
  const st = S.stats;
  const open = S.state.trades.filter((t) => t.status === 'OPEN' && isTrading(t));
  const haveLtp = open.some((t) => ltpFor(t) != null);
  const openRisk = sum(open.map((t) => Math.max(0, metrics(t).openRisk || 0)));
  const tiles = [
    ['Net realised P&L', `<span class="${cls(st.net)}">${compact(st.net)}</span>`, `${st.count} closed trades`],
    ['Unrealised (live)', haveLtp ? `<span class="${cls(unrealised())}">${compact(unrealised())}</span>` : '—', haveLtp ? `${open.length} open` : S.kite.connected ? 'waiting for prices…' : 'connect Kite for live MTM'],
    ['Win rate', pct(st.winRate, 0), `${st.wins}W · ${st.losses}L`],
    ['Avg R', `<span class="${cls(st.avgR)}">${rfmt(st.avgR)}</span>`, 'per closed trade'],
    ['Profit factor', st.profitFactor == null ? '—' : st.profitFactor === Infinity ? '∞' : st.profitFactor.toFixed(2), 'gross win ÷ gross loss'],
    ['Open risk', compact(openRisk), 'if every stop is hit'],
  ];
  return tiles.map(([k, v, s]) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('');
}


export function liveNote() {
  if (!S.kite.connected) return S.kite.configured ? '<a class="link" href="#/settings">Reconnect Kite for live prices</a>' : 'Manual mode · <a class="link" href="#/settings">connect Kite</a>';
  return S.quotesAt ? `${S.kite.mock ? 'Demo prices' : 'Live'} · updated ${fmtTime(S.quotesAt)}` : 'Fetching prices…';
}


export function openPositionsInner() {
  const open = S.state.trades.filter((t) => t.status === 'OPEN' && isTrading(t)).sort((a, b) => new Date(b.entryTime) - new Date(a.entryTime));
  if (!open.length) return '<div class="empty-sm">No open positions. Waiting for the right setup is a skill.</div>';
  return `<div class="table-wrap"><table class="tbl pt"><thead><tr>
    <th>Symbol</th><th>Side</th><th class="r">Qty</th><th class="r">Entry</th><th class="r">LTP</th><th class="r">Stop</th><th class="r">Target</th><th class="r">MTM</th><th class="r">R now</th><th>Held</th><th></th></tr></thead><tbody>
    ${open.map((t) => {
    const q = quoteFor(t); const m = metrics(t, q?.last ?? null);
    const flash = S.flash.has(tradeKey(t));
    return `<tr class="click" data-action="open-drawer" data-id="${t.id}">
      <td><span class="sym">${esc(t.symbol)}</span><span class="exch">${t.exchange}</span> ${linkPill(t)}</td>
      <td><span class="side ${t.side}">${t.side}</span></td>
      <td class="r num">${t.status === 'OPEN' && m.exQty ? `${nf0.format(m.openQty)}<span class="faint">/${nf0.format(t.qty)}</span>` : nf0.format(t.qty)}</td>
      <td class="r num">${price(t.entryPrice)}</td>
      <td class="r num">${q ? `<span class="ltp">${flash ? '<span class="blink"></span>' : ''}${price(q.last)}</span><div class="${cls(q.changePct)}" style="font-size:11px">${q.changePct == null ? '' : (q.changePct > 0 ? '+' : '') + (q.changePct * 100).toFixed(2) + '%'}</div>` : '<span class="faint">—</span>'}</td>
      <td class="r num">${t.stopLoss == null ? '<span class="pill red">none</span>' : price(t.stopLoss)}</td>
      <td class="r num">${price(t.target)}</td>
      <td class="r num ${cls(m.net)}">${m.net == null ? '—' : money(m.net, { sign: true })}</td>
      <td class="r num ${cls(m.r)}">${rfmt(m.r)}</td>
      <td class="muted">${hold(m.holdDays)}</td>
      <td class="r"><button class="btn sm" data-action="close-trade" data-id="${t.id}">Close</button></td>
    </tr>`;
  }).join('')}</tbody></table></div>`;
}


export function xpFeed(events) {
  if (!events.length) return '<div class="empty-sm">No XP yet.</div>';
  return `<div class="feed">${events.map((e) => `<div class="feed-item">${xpPill(e.xp)}<span class="what">${esc(e.label)}${e.symbol ? ` <span class="faint">· ${esc(e.symbol)}</span>` : ''}</span><span class="when">${ago(e.at)}</span></div>`).join('')}</div>`;
}


export function equityChart(curve) {
  if (curve.length < 2) return '<div class="empty-sm">Close a trade to start your equity curve.</div>';
  S._eqCurve = curve;
  return '<div class="equity-host"></div>';
}


export function mountEquity() {
  S.eqChart?.destroy(); S.eqChart = null;
  const host = $('.equity-host');
  if (host && S._eqCurve) S.eqChart = mountEquityChart(host, S._eqCurve, { height: 240 });
}
