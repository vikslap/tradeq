import { NIFTY500 } from './data/indices.js';
import { rsLine, rsReadout, breadthOn, breadthValue, BREADTH_VIEWS, istDate } from './market.js';
import { addPriceSeries } from './chartstyle.js';
import { maColor, maChips, practiceMas, setPracticeMas, MA_PERIODS } from './mastyle.js';
import { tokenParam } from './js/kiteinst.js';
// 🎮 Practice — chart replay game on real Kite candles.
// Paper trades live in their own record (state.practice) and never touch the journal.
import { attachDrawings, drawToolbar } from './drawing.js';
import { createChart, CandlestickSeries, HistogramSeries, LineSeries, LineStyle, CrosshairMode, createSeriesMarkers } from './vendor/lightweight-charts.mjs';

// ---------------------------------------------------------------------------
// Pure engine (also used by tests)
// ---------------------------------------------------------------------------
// Surprise charts come from the whole Nifty 500 (large, mid and small caps), so replays
// include laggards and sideways stocks, not just today's best-known winners.
export const SURPRISE = NIFTY500;
const surprisePool = () => { const l = ctx?.S?.()?.state?.settings?.indexLists?.nifty500; return l?.length ? l : SURPRISE; };
const pick = (avoid) => { const pool = surprisePool(); let s; do s = pool[Math.floor(Math.random() * pool.length)]; while (s === avoid && pool.length > 1); return s; };

/** Random weekday start date with enough future data for the chosen interval. */
export function randomStart(interval, now = Date.now(), rnd = Math.random) {
  const DAY = 86400000;
  const [minBack, maxBack] = { day: [320, 365 * 12], '60minute': [70, 365 * 3], '15minute': [30, 365 * 2], '5minute': [10, 365 * 2] }[interval];
  const d = new Date(now - (minBack + rnd() * (maxBack - minBack)) * DAY);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  d.setHours(9, 15, 0, 0);
  return d.toISOString();
}

const dirOf = (side) => (side === 'SHORT' ? -1 : 1);

/**
 * Advance a position through one bar. Market orders fill at the bar's open; stops and
 * targets fill intrabar, at the open if the bar gaps past them. If a bar touches both,
 * the stop is assumed first (conservative). Returns { position, closed }.
 */
/**
 * Does a pending entry order fill on this bar, and at what price?
 *  MARKET: at the open.
 *  LIMIT:  long at or below `price` (short at or above) — at the open if it gaps through, else at the price.
 *  STOP:   long when price rises to `price` (short when it falls to it) — breakout entries; gaps fill at the open.
 */
export function fillOrder(order, bar) {
  const [, o, h, l] = bar; const long = order.side !== 'SHORT'; const P = order.price;
  if (order.type === 'MARKET' || !order.type) return { price: o, atOpen: true };
  if (order.type === 'LIMIT') {
    if (long ? o <= P : o >= P) return { price: o, atOpen: true };
    if (long ? l <= P : h >= P) return { price: P, atOpen: false };
  }
  if (order.type === 'STOP') {
    if (long ? o >= P : o <= P) return { price: o, atOpen: true };
    if (long ? h >= P : l <= P) return { price: P, atOpen: false };
  }
  return null;
}

/** Order-type rules relative to the current price; returns an error message or null. */
export function checkOrder({ type, side, price, stop, target }, last) {
  const long = side !== 'SHORT';
  if (type === 'LIMIT' && !(price > 0)) return 'Enter a limit price.';
  if (type === 'STOP' && !(price > 0)) return 'Enter a trigger price.';
  if (type === 'LIMIT' && (long ? price >= last : price <= last)) return `A ${long ? 'buy' : 'short'} limit must be ${long ? 'below' : 'above'} the current price (${last}) — otherwise use Market.`;
  if (type === 'STOP' && (long ? price <= last : price >= last)) return `A ${long ? 'buy' : 'short'} stop (breakout) must be ${long ? 'above' : 'below'} the current price (${last}).`;
  const ref = type === 'MARKET' ? last : price;
  if (stop != null && (long ? stop >= ref : stop <= ref)) return `Stop-loss must be ${long ? 'below' : 'above'} your entry (${ref}).`;
  if (target != null && (long ? target <= ref : target >= ref)) return `Target must be ${long ? 'above' : 'below'} your entry (${ref}).`;
  return null;
}

export function stepBar(position, bar, barIndex, { pendingExit = false, skipTarget = false } = {}) {
  if (!position) return { position: null, closed: null };
  const [ts, o, h, l] = bar;
  const d = dirOf(position.side);
  const close = (price, reason) => ({ position: null, closed: { ...position, exitPrice: round2(price), exitBar: barIndex, exitTime: new Date(ts).toISOString(), exitReason: reason } });
  if (pendingExit) return close(o, 'Manual');
  const { stop, target } = position;
  if (stop != null) {
    const gapped = d > 0 ? o <= stop : o >= stop;
    const touched = d > 0 ? l <= stop : h >= stop;
    if (gapped) return close(o, 'Stop (gap)');
    if (touched) return close(stop, 'Stop');
  }
  // On the bar an order filled intrabar we can't know if the target came after the
  // fill, so only the stop is checked (conservative).
  if (target != null && !skipTarget) {
    const gapped = d > 0 ? o >= target : o <= target;
    const touched = d > 0 ? h >= target : l <= target;
    if (gapped) return close(o, 'Target (gap)');
    if (touched) return close(target, 'Target');
  }
  return { position, closed: null };
}
const round2 = (v) => Math.round(v * 100) / 100;

export function tradeResult(t) {
  const d = dirOf(t.side);
  const pnl = t.exitPrice != null ? (t.exitPrice - t.entryPrice) * d * t.qty : null;
  const risk = t.initialStop != null ? Math.abs(t.entryPrice - t.initialStop) * t.qty : null;
  return { pnl, r: pnl != null && risk > 0 ? pnl / risk : null, risk };
}

/** Practice XP: same habits as the journal, scaled down. */
export function scoreTrade(t, riskLimit) {
  const { r, risk } = tradeResult(t);
  const items = [];
  items.push(t.initialStop != null ? { xp: 10, label: 'Stop set before entry' } : { xp: -10, label: 'No stop at entry' });
  if (t.target != null) items.push({ xp: 3, label: 'Target planned' });
  if (risk != null) items.push(risk <= riskLimit * 1.05 ? { xp: 5, label: 'Risk within limit' } : { xp: -10, label: 'Oversized risk' });
  if (t.widened) items.push({ xp: -10 * Math.min(3, t.widened), label: `Widened stop ${t.widened}×` });
  if (r != null && r < 0 && r >= -1.1) items.push({ xp: 10, label: 'Loss kept within 1R' });
  if (r != null && r >= 3) items.push({ xp: 15, label: 'Let it run (3R+)' });
  else if (r != null && r >= 2) items.push({ xp: 10, label: '2R+ winner' });
  return items;
}

export function practiceStats(sessions, riskLimit) {
  const trades = sessions.flatMap((s) => (s.trades || []).map((t) => ({ ...t, session: s })));
  const res = trades.map((t) => ({ t, ...tradeResult(t), xp: scoreTrade(t, s_risk(t.session, riskLimit)).reduce((a, b) => a + b.xp, 0) }));
  const rs = res.map((x) => x.r).filter((v) => v != null);
  const wins = res.filter((x) => x.pnl > 0).length;
  const sessionXp = sessions.filter((s) => s.status === 'done' && (s.cursor ?? 0) - (s.startIndex ?? 0) >= 20).length * 5;
  return {
    trades: res.length, wins, winRate: res.length ? wins / res.length : null,
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null, totalR: rs.reduce((a, b) => a + b, 0),
    xp: Math.max(0, res.reduce((a, b) => a + b.xp, 0) + sessionXp), sessions: sessions.length,
  };
}
const s_risk = (s, fallback) => s?.risk || fallback;

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
let ctx; // { api, state(), kite(), toast, esc, reload, openModal, closeModal }
let G = null; // active game { session, data, cursor, position, trades, pendingExit, chart, ... }
let auto = null;

export function initPractice(c) { ctx = c; }

const nf2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const money = (v) => (v == null ? '—' : `${v < 0 ? '−' : v > 0 ? '+' : ''}₹${nf0.format(Math.abs(v))}`);
const rfmt = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}R`);
const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const IV_LABEL = { day: 'Daily', '60minute': 'Hourly', '15minute': '15-min', '5minute': '5-min' };
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const toTime = (ms, iv) => (iv === 'day' ? new Date(ms + 19800000).toISOString().slice(0, 10) : Math.floor(ms / 1000) + 19800);
const fmtBar = (ms, iv) => new Date(ms).toLocaleString('en-IN', iv === 'day' ? { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' } : { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function pagePractice() {
  const st = ctx.state();
  const sessions = st.practice?.sessions || [];
  const P = practiceStats(sessions, st.settings.maxRiskPerTrade);
  const active = G && G.session.status === 'active';
  return `<div class="page-h"><div><h1>🎮 Practice</h1><p>Replay real charts bar by bar and trade them with paper money. Nothing here touches your journal or Zerodha.</p></div>
    ${active ? '<button class="btn" data-pa="end">🏁 End session</button>' : ''}</div>
  <div class="kpis" style="margin-bottom:16px">
    ${[['Practice XP', `<span class="gold">${nf0.format(P.xp)}</span>`, 'separate from your journal XP'], ['Sessions', P.sessions, `${P.trades} paper trades`],
      ['Win rate', P.winRate == null ? '—' : `${Math.round(P.winRate * 100)}%`, `${P.wins} wins`], ['Avg R', `<span class="${cls(P.avgR)}">${rfmt(P.avgR)}</span>`, 'per paper trade'],
      ['Total R', `<span class="${cls(P.totalR)}">${rfmt(P.totalR)}</span>`, 'all sessions'], ['Data', ctx.kite().mock ? '<span class="gold">Demo</span>' : ctx.kite().connected ? 'Kite' : '<span class="neg">Offline</span>', ctx.kite().connected ? 'real historical candles' : 'connect Kite in Settings']]
    .map(([k, v, s]) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('')}
  </div>
  <div id="pa-root">${active ? gameShell() : setupHtml(st) + historyHtml(sessions)}</div>`;
}

function setupHtml(st) {
  const ivs = Object.entries(IV_LABEL);
  return `<section class="card" style="margin-bottom:16px"><header class="card-h"><h3>New replay</h3><span class="sub">${ctx.kite().mock ? 'Demo candles — connect Kite for real data' : ctx.kite().connected ? 'Real Kite candles' : 'Kite needed for real data'}</span></header>
    <form id="pa-setup" class="stack">
      <div class="grid-3">
        <div class="field" style="grid-column:span 2"><label>Stock or index</label><div class="input-row"><input class="input" name="symbol" placeholder="e.g. RELIANCE, NIFTY 50" autocomplete="off"><button type="button" class="btn" data-pa="surprise">🎲 Surprise me</button></div>
          <div class="hint">Surprise picks a liquid NSE stock and a random date — best with blind mode.</div></div>
        <div class="field"><label>Exchange</label><select class="input" name="exchange"><option>NSE</option><option>BSE</option><option>NFO</option><option>MCX</option></select></div>
      </div>
      <div class="row wrap" style="gap:16px;align-items:flex-end">
        <div class="field"><label>Candles</label><div class="seg">${ivs.map(([v, l], i) => `<label><input type="radio" name="interval" value="${v}" ${i === 0 ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></div>
        <div class="field"><label>Start from</label><input class="input" type="date" name="start" max="${new Date(Date.now() - 86400000 * 5).toISOString().slice(0, 10)}"></div>
        <label class="row" style="gap:8px;padding-bottom:8px"><input type="checkbox" name="blind" checked> <span><b>Blind mode</b> <span class="faint">— hide name & dates until the end</span></span></label>
      </div>
      <div class="grid-3">
        <div class="field"><label>Paper capital (₹)</label><input class="input num" type="number" name="capital" value="${st.settings.capital}"></div>
        <div class="field"><label>Risk per trade (₹)</label><input class="input num" type="number" name="risk" value="${st.settings.maxRiskPerTrade}"></div>
        <div class="field" style="justify-content:flex-end"><button class="btn primary" type="submit">▶ Start replay</button></div>
      </div>
      <div class="err" id="pa-err"></div>
    </form></section>`;
}

function historyHtml(sessions) {
  if (!sessions.length) return '<div class="card empty"><div class="big">🎮</div><h2>No practice yet</h2><p>Start with <b>🎲 Surprise me</b> on daily candles in blind mode: read the chart, plan the trade, step forward and see if your stop and target hold up.</p></div>';
  const risk = ctx.state().settings.maxRiskPerTrade;
  return `<section class="card"><header class="card-h"><h3>Sessions</h3><span class="sub">${sessions.length}</span></header><div class="table-wrap"><table class="tbl"><thead><tr><th>Played</th><th>Instrument</th><th>Candles</th><th class="r">Trades</th><th class="r">P&L</th><th class="r">Total R</th><th class="r">XP</th><th></th></tr></thead><tbody>
    ${sessions.map((s) => {
      const res = (s.trades || []).map(tradeResult); const pnl = res.reduce((a, b) => a + (b.pnl || 0), 0); const tr = res.reduce((a, b) => a + (b.r || 0), 0);
      const xp = (s.trades || []).reduce((a, t) => a + scoreTrade(t, s.risk || risk).reduce((x, y) => x + y.xp, 0), 0);
      const hidden = s.blind && s.status === 'active';
      return `<tr><td class="muted">${new Date(s.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</td>
        <td>${hidden ? '🙈 hidden' : `<span class="sym">${ctx.esc(s.symbol)}</span> <span class="faint">${new Date(s.start).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}</span>`}</td>
        <td>${IV_LABEL[s.interval]}</td><td class="r num">${(s.trades || []).length}</td><td class="r num ${cls(pnl)}">${money(pnl)}</td><td class="r num ${cls(tr)}">${rfmt(tr)}</td>
        <td class="r">${xp ? `<span class="xp-pill ${xp > 0 ? 'plus' : 'minus'}">${xp > 0 ? '+' : ''}${xp}</span>` : '<span class="faint">0</span>'}</td>
        <td class="r">${s.status === 'active' ? `<button class="btn sm primary" data-pa="resume" data-id="${s.id}">Resume</button>` : `<button class="btn sm" data-pa="review" data-id="${s.id}">Review</button>`} <button class="btn sm ghost" data-pa="delete" data-id="${s.id}">✕</button></td></tr>`;
    }).join('')}</tbody></table></div></section>`;
}

function gameShell() {
  return `<div class="pa-grid">
    <section class="card" style="padding:12px" data-chart-wrap><div class="row wrap" style="justify-content:space-between;margin-bottom:8px">
      <div class="row wrap"><b id="pa-title"></b><span class="pill" id="pa-iv"></span>${maChips(practiceMas(), 'data-pa-ema')}${drawToolbar()}</div><span class="muted mono" id="pa-date"></span></div>
      <div id="pa-mkt" class="mkt-strip"></div>
      <div id="pa-chart" style="height:600px"></div>
      <div class="row wrap" style="margin-top:10px;gap:8px">
        <button class="btn" data-pa="next" title="Next bar — → , Space or D">▶ Next bar <kbd>→</kbd></button>
        <button class="btn" data-pa="skip" title="10 bars — Shift + →">⏭ +10 bars <kbd>⇧→</kbd></button>
        <button class="btn" data-pa="auto" id="pa-auto" title="Auto-play — P">⏯ Auto-play <kbd>P</kbd></button>
        <button class="btn" data-pa="skip-chart" title="Don't like the setup? Skip to a new chart — skipped charts don't count in your stats">🎲 Skip chart <kbd>N</kbd></button>
        <div class="seg sm-seg">${[1, 2, 5].map((x) => `<label><input type="radio" name="pa-speed" value="${x}" ${x === 1 ? 'checked' : ''}><span>${x}×</span></label>`).join('')}</div>
        <span style="flex:1"></span><span class="faint" id="pa-left"></span>
      </div></section>
    <aside class="stack">
      <section class="card" id="pa-account"></section>
      <section class="card" id="pa-ticket"></section>
      <section class="card"><header class="card-h"><h3>Paper trades</h3></header><div id="pa-log"></div></section>
    </aside></div>`;
}

// ---------- mounting / binding ----------
export function mountPractice() {
  const root = document.getElementById('pa-root'); if (!root) { stopAuto(); return; }
  const form = document.getElementById('pa-setup');
  if (form) bindSetup(form);
  if (G && G.session.status === 'active' && document.getElementById('pa-chart')) { buildChart(); paint(); }
  if (!ctx.S().breadth) import('./js/breadth.js').then((m) => m.loadBreadth()).then(() => { if (G && G.session.status === 'active' && document.getElementById('pa-chart')) { buildChart(); paint(); } });
}

function bindSetup(form) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const interval = fd.get('interval');
    const symbol = String(fd.get('symbol') || '').trim().toUpperCase();
    if (!symbol) { form.querySelector('#pa-err').textContent = 'Type a symbol, or press 🎲 Surprise me.'; return; }
    const startDate = fd.get('start');
    const start = startDate ? new Date(`${startDate}T09:15:00+05:30`).toISOString() : randomStart(interval);
    await startSession({ symbol, exchange: fd.get('exchange'), interval, start, blind: fd.get('blind') === 'on', capital: fd.get('capital'), risk: fd.get('risk') });
  });
}

async function startSession(body, { rethrow = false } = {}) {
  const err = document.getElementById('pa-err');
  try {
    if (err) err.textContent = 'Loading candles…';
    const data = await loadCandles(body);
    if (data.startIndex < 30) throw new Error('Not enough history before that date for this instrument. Try a later date or another stock.');
    if (data.candles.length - data.startIndex < 10) throw new Error('Not enough data after that date. Pick an earlier start.');
    const session = await ctx.api('/api/practice/sessions', { method: 'POST', body: { ...body, start: new Date(data.candles[data.startIndex][0]).toISOString() } });
    session.startIndex = data.startIndex; session.cursor = data.startIndex - 1;
    await ctx.api(`/api/practice/sessions/${session.id}`, { method: 'PUT', body: { startIndex: session.startIndex, cursor: session.cursor } });
    G = { session, data, cursor: session.cursor, position: null, trades: [], pendingExit: false, pending: null };
    await ctx.reload();
  } catch (e) { if (rethrow) throw e; if (err) err.textContent = e.message; else ctx.toast(ctx.esc(e.message), 'err'); }
}

/** Load a fresh surprise chart with the same settings; retries if a pick lacks history. */
async function newSurprise(opts, avoid) {
  const root = document.getElementById('pa-root');
  if (root) root.innerHTML = '<div class="card"><div class="chart-loading" style="height:520px">🎲 Loading a new chart…</div></div>';
  let last = null;
  // Recent listings have no history for older dates, so a pick can fail — just try another.
  for (let i = 0; i < 8; i++) {
    const symbol = pick(avoid);
    try {
      await startSession({ symbol, exchange: 'NSE', interval: opts.interval, start: randomStart(opts.interval), blind: opts.blind, capital: opts.capital, risk: opts.risk }, { rethrow: true });
      return;
    } catch (e) { last = e; }
  }
  ctx.toast(ctx.esc(last?.message || 'Could not load a new chart'), 'err');
  await ctx.reload();
}

async function skipChart() {
  if (!G) return;
  stopAuto(); clearTimeout(saveTimer);
  const s = G.session; const taken = G.trades.length > 0 || G.position;
  // Skipping before you trade is free. Once you've traded, the result counts —
  // otherwise skipping losers would make your stats look better than your trading.
  if (taken && !window.confirm('You already traded this chart, so it counts towards your stats (otherwise skipping losers would flatter them).\n\nSave it (any open position closes at the last price) and load a new chart?')) return;
  if (taken) await finishSession({ review: false });
  else {
    G.draw?.destroy(); G = null;
    await ctx.api(`/api/practice/sessions/${s.id}`, { method: 'DELETE' }).catch(() => {});
    ctx.toast('🎲 Chart skipped — not counted in your stats');
  }
  await newSurprise({ interval: s.interval, blind: s.blind, capital: s.capital, risk: s.risk }, s.symbol);
}

async function loadCandles(s) {
  const qs = new URLSearchParams({ exchange: s.exchange, symbol: s.symbol, interval: s.interval, start: s.start });
  return ctx.api(`/api/practice/candles?${qs}${await tokenParam(s.exchange, s.symbol)}`);
}

async function resume(id, review = false) {
  const s = (ctx.state().practice?.sessions || []).find((x) => x.id === id); if (!s) return;
  try {
    const data = await loadCandles(s);
    if (review) return openReview(s, data);
    const pend = s.pending ? { ...s.pending, type: s.pending.orderType, price: s.pending.orderPrice } : null;
    G = { session: s, data, cursor: s.cursor ?? s.startIndex - 1, position: s.position, trades: [...(s.trades || [])], pendingExit: false, pending: pend };
    await ctx.reload();
  } catch (e) { ctx.toast(ctx.esc(e.message), 'err'); }
}

// ---------- chart ----------
function buildChart() {
  G.draw?.destroy(); G.chart?.remove();
  const el = document.getElementById('pa-chart');
  const C = { text: css('--muted'), border: css('--border'), green: css('--green'), red: css('--red'), accent: css('--accent'), gold: css('--gold') };
  const blind = G.session.blind && G.session.status === 'active';
  G.chart = createChart(el, {
    autoSize: true,
    layout: { background: { color: 'transparent' }, textColor: C.text, fontFamily: "'JetBrains Mono', monospace", fontSize: 11, attributionLogo: true },
    grid: { vertLines: { color: 'rgba(128,128,128,.08)' }, horzLines: { color: 'rgba(128,128,128,.08)' } },
    crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: { borderColor: C.border, scaleMargins: { top: 0.08, bottom: 0.2 } },
    timeScale: { borderColor: C.border, visible: !blind, timeVisible: G.data.interval !== 'day', rightOffset: 12 },
  });
  G.series = addPriceSeries(G.chart, C);
  G.vol = G.chart.addSeries(HistogramSeries, { priceScaleId: 'v', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  G.chart.priceScale('v').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
  G.ema = practiceMas().map((n) => ({ n, s: G.chart.addSeries(LineSeries, { color: maColor(n), lineWidth: n === 200 ? 2 : 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }) }));
  G.markers = createSeriesMarkers(G.series, []);
  G.lines = [];
  G.C = C;
  // Market context panes: relative strength vs Nifty 50, then breadth.
  G.rsAll = G.data.bench?.length ? rsLine(G.data.candles, G.data.bench) : null;
  G.rsS = G.rsAll ? G.chart.addSeries(LineSeries, { color: C.accent, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: 'RS', priceFormat: { type: 'price', precision: 1, minMove: 0.1 } }, 1) : null;
  G.brAll = breadthBars();
  const brPane = G.rsS ? 2 : 1;
  G.brS = !G.brAll ? null : G.brAll.kind === 'line'
    ? G.chart.addSeries(LineSeries, { color: C.gold || '#f59e0b', lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: G.brAll.label, priceFormat: { type: 'price', precision: 0, minMove: 1 } }, brPane)
    : G.chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false, title: G.brAll.label, priceFormat: { type: 'price', precision: 0, minMove: 1 } }, brPane);
  if (G.brS && ['pct50', 'pct200'].includes(G.brAll.view)) for (const [p, col] of [[80, C.red], [50, C.text || '#888'], [20, C.green]]) G.brS.createPriceLine({ price: p, color: col, lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
  if (G.brS && G.brAll.view === 'mcclellan') G.brS.createPriceLine({ price: 0, color: C.text || '#888', lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
  const panes = G.chart.panes();
  if (panes.length > 1) { panes[0].setStretchFactor(6); panes[1].setStretchFactor(1.3); if (panes[2]) panes[2].setStretchFactor(1); }
  const vis = G.data.candles.slice(0, G.cursor + 1);
  G.series.setData(vis.map(bar));
  G.vol.setData(vis.map(volBar));
  for (const e of G.ema) e.s.setData(emaData(vis, e.n));
  if (G.rsS) G.rsS.setData(vis.map((c, i) => (G.rsAll[i] != null ? { time: toTime(c[0], G.data.interval), value: G.rsAll[i] } : { time: toTime(c[0], G.data.interval) })));
  if (G.brS) G.brS.setData(vis.map((c, i) => brPoint(c, i)));
  G.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, vis.length - 120), to: vis.length + 12 });
  el.style.position = 'relative';
  G.draw = attachDrawings({ chart: G.chart, series: G.series, host: el, key: `pa:${G.session.id}`,
    times: () => G.data.candles.slice(0, G.cursor + 1).map((c) => c[0]), candles: () => G.data.candles.slice(0, G.cursor + 1) });
}
const bar = (c) => ({ time: toTime(c[0], G.data.interval), open: c[1], high: c[2], low: c[3], close: c[4] });
const volBar = (c) => ({ time: toTime(c[0], G.data.interval), value: c[5] || 0, color: c[4] >= c[1] ? 'rgba(34,197,94,.35)' : 'rgba(244,80,107,.35)' });
function emaData(vis, n) { return emaLine(vis, n, G.data.interval); }
function emaLine(cs, n, iv) {
  const k = 2 / (n + 1); let prev = null;
  return cs.map((c, i) => {
    if (i < n - 1) return { time: toTime(c[0], iv) };
    prev = prev == null ? cs.slice(0, n).reduce((a, x) => a + x[4], 0) / n : c[4] * k + prev * (1 - k);
    return { time: toTime(c[0], iv), value: prev };
  });
}

function refreshOverlays() {
  for (const l of G.lines) G.series.removePriceLine(l);
  G.lines = [];
  const p = G.position; const C = G.C;
  if (p) {
    G.lines.push(G.series.createPriceLine({ price: p.entryPrice, title: 'ENTRY', color: C.accent, lineWidth: 2, lineStyle: LineStyle.Solid }));
    if (p.stop != null) G.lines.push(G.series.createPriceLine({ price: p.stop, title: 'SL', color: C.red, lineStyle: LineStyle.Dashed }));
    if (p.target != null) G.lines.push(G.series.createPriceLine({ price: p.target, title: 'TGT', color: C.green, lineStyle: LineStyle.Dashed }));
  }
  const o = G.pending;
  if (!p && o && o.type !== 'MARKET') {
    G.lines.push(G.series.createPriceLine({ price: o.price, title: `${o.side === 'LONG' ? 'BUY' : 'SHORT'} ${o.type === 'LIMIT' ? 'LMT' : 'STP'}`, color: C.accent, lineWidth: 2, lineStyle: LineStyle.Dotted }));
    if (o.stop != null) G.lines.push(G.series.createPriceLine({ price: o.stop, title: 'SL', color: C.red, lineStyle: LineStyle.Dotted }));
    if (o.target != null) G.lines.push(G.series.createPriceLine({ price: o.target, title: 'TGT', color: C.green, lineStyle: LineStyle.Dotted }));
  }
  const iv = G.data.interval; const cs = G.data.candles;
  const marks = [];
  for (const t of [...G.trades, ...(p ? [p] : [])]) {
    const long = t.side === 'LONG';
    if (cs[t.entryBar]) marks.push({ time: toTime(cs[t.entryBar][0], iv), position: long ? 'belowBar' : 'aboveBar', color: C.accent, shape: long ? 'arrowUp' : 'arrowDown', text: `${long ? 'Buy' : 'Short'} ${nf2.format(t.entryPrice)}` });
    if (t.exitBar != null && cs[t.exitBar]) marks.push({ time: toTime(cs[t.exitBar][0], iv), position: long ? 'aboveBar' : 'belowBar', color: C.gold, shape: 'circle', text: `${t.exitReason} ${nf2.format(t.exitPrice)}` });
  }
  marks.sort((a, b) => (a.time > b.time ? 1 : a.time < b.time ? -1 : 0));
  G.markers.setMarkers(marks);
}

// ---------- engine glue ----------
function lastBar() { return G.data.candles[G.cursor]; }

function next(n = 1) {
  for (let k = 0; k < n; k++) {
    if (G.cursor >= G.data.candles.length - 1) { stopAuto(); ctx.toast('No more data in this replay — ending the session.'); return endSession(); }
    G.cursor++;
    const c = G.data.candles[G.cursor];
    // Pending market order fills at this bar's open.
    let skipTarget = false;
    if (G.pending) {
      const f = fillOrder(G.pending, c);
      if (f) {
        const { type, price, ...rest } = G.pending;
        G.position = { ...rest, entryPrice: round2(f.price), entryBar: G.cursor, entryTime: new Date(c[0]).toISOString(), orderType: type || 'MARKET' };
        skipTarget = !f.atOpen;
        if (type && type !== 'MARKET') { ctx.toast(`<div class="t-h">✅ ${type === 'LIMIT' ? 'Limit' : 'Breakout stop'} order filled @ ${nf2.format(f.price)}${f.atOpen ? ' (gap, at the open)' : ''}</div>`); stopAuto(); }
        G.pending = null;
      }
    }
    const { position, closed } = stepBar(G.position, c, G.cursor, { pendingExit: G.pendingExit, skipTarget });
    G.pendingExit = false;
    G.position = position;
    G.series.update(bar(c)); G.vol.update(volBar(c));
    if (G.rsS && G.rsAll[G.cursor] != null) G.rsS.update({ time: toTime(c[0], G.data.interval), value: G.rsAll[G.cursor] });
    if (G.brS) G.brS.update(brPoint(c, G.cursor));
    const vis = G.data.candles.slice(0, G.cursor + 1);
    for (const e of G.ema) { const d = emaData(vis.slice(-Math.max(e.n * 3, 60)), e.n).at(-1); if (d.value != null) e.s.update(d); }
    if (closed) {
      G.trades.push(closed);
      const { pnl, r } = tradeResult(closed);
      const xp = scoreTrade(closed, G.session.risk).reduce((a, b) => a + b.xp, 0);
      ctx.toast(`<div class="t-h"><span class="${cls(pnl)} mono">${money(pnl)}</span><span>${closed.exitReason} · ${rfmt(r)}</span></div><div class="muted" style="font-size:12px;margin-top:4px">Practice ${xp >= 0 ? '+' : ''}${xp} XP</div>`);
      stopAuto(); save(true);
      break;
    }
  }
  refreshOverlays(); paint(); save();
  G?.draw?.redraw();
}

let saveTimer = null;
function save(now = false) {
  clearTimeout(saveTimer);
  if (!G) return;
  // Snapshot now: the session may end (G = null) before a delayed save runs.
  const id = G.session.id;
  const pending = G.pending && G.pending.type !== 'MARKET' ? { ...G.pending, orderType: G.pending.type, orderPrice: G.pending.price } : null;
  const body = { cursor: G.cursor, trades: [...G.trades], position: G.position, pending };
  const go = () => ctx.api(`/api/practice/sessions/${id}`, { method: 'PUT', body }).catch(() => {});
  if (now) go(); else saveTimer = setTimeout(go, 1500);
}

function stopAuto() { if (auto) { clearInterval(auto); auto = null; } const b = document.getElementById('pa-auto'); if (b) b.textContent = '⏯ Auto-play'; }
function toggleAuto() {
  if (auto) return stopAuto();
  const speed = Number(document.querySelector('input[name="pa-speed"]:checked')?.value || 1);
  auto = setInterval(() => { if (!document.getElementById('pa-chart')) return stopAuto(); next(); }, 900 / speed);
  document.getElementById('pa-auto').textContent = '⏸ Pause';
}

function endSession() { return finishSession({ review: true }); }

async function finishSession({ review }) {
  stopAuto(); clearTimeout(saveTimer);
  if (G.position) { // close any open position at the last close
    const c = lastBar();
    G.trades.push({ ...G.position, exitPrice: c[4], exitBar: G.cursor, exitTime: new Date(c[0]).toISOString(), exitReason: 'Session end' });
    G.position = null;
  }
  const s = await ctx.api(`/api/practice/sessions/${G.session.id}`, { method: 'PUT', body: { cursor: G.cursor, trades: G.trades, position: null, pending: null, status: 'done' } });
  const done = G; done.draw?.destroy(); G = null;
  if (!review) return;
  await ctx.reload();
  openReview(s, done.data);
}

// ---------- side panels ----------
function paint() {
  if (!G || !document.getElementById('pa-account')) return;
  const s = G.session; const c = lastBar(); const iv = G.data.interval;
  const blind = s.blind && s.status === 'active';
  document.getElementById('pa-title').textContent = blind ? '🙈 Mystery chart' : `${s.symbol}`;
  document.getElementById('pa-iv').textContent = IV_LABEL[iv];
  document.getElementById('pa-date').textContent = blind ? `Bar ${G.cursor - G.session.startIndex + 1}` : c ? fmtBar(c[0], iv) : '';
  document.getElementById('pa-left').textContent = `${G.data.candles.length - 1 - G.cursor} bars left`;
  paintMarket(blind);
  const realised = G.trades.reduce((a, t) => a + (tradeResult(t).pnl || 0), 0);
  const p = G.position;
  const unreal = p ? (c[4] - p.entryPrice) * dirOf(p.side) * p.qty : 0;
  const totalR = G.trades.reduce((a, t) => a + (tradeResult(t).r || 0), 0);
  document.getElementById('pa-account').innerHTML = `
    <div class="stat-line"><span class="muted">Equity</span><b>${money(s.capital + realised + unreal).replace('+', '')}</b></div>
    <div class="stat-line"><span class="muted">Realised</span><b class="${cls(realised)}">${money(realised)}</b></div>
    <div class="stat-line"><span class="muted">Open P&L</span><b class="${cls(unreal)}">${p ? money(unreal) : '—'}</b></div>
    <div class="stat-line"><span class="muted">Session R</span><b class="${cls(totalR)}">${rfmt(totalR)}</b></div>
    <div class="stat-line"><span class="muted">Last close</span><b>${nf2.format(c[4])}</b></div>`;
  document.getElementById('pa-ticket').innerHTML = p ? positionHtml(p, c) : G.pending ? pendingHtml(G.pending, c) : ticketHtml(c);
  document.getElementById('pa-log').innerHTML = G.trades.length ? `<table class="tbl"><tbody>${[...G.trades].reverse().map((t) => { const { pnl, r } = tradeResult(t); return `<tr><td><span class="side ${t.side}">${t.side === 'LONG' ? 'L' : 'S'}</span></td><td class="num">${nf2.format(t.entryPrice)} → ${nf2.format(t.exitPrice)}</td><td class="faint">${ctx.esc(t.exitReason)}</td><td class="r num ${cls(pnl)}">${rfmt(r)}</td></tr>`; }).join('')}</tbody></table>` : '<div class="empty-sm">No paper trades yet.</div>';
  bindTicket();
}

function ticketHtml(c) {
  return `<header class="card-h" style="margin-bottom:10px"><h3>Plan a trade</h3><span class="sub" id="pa-osub">fills at next open</span></header>
    <form id="pa-order" class="stack" style="gap:10px" data-otype="MARKET">
      <div class="seg"><label><input type="radio" name="side" value="LONG" checked><span class="long">▲ Buy</span></label><label><input type="radio" name="side" value="SHORT"><span class="short">▼ Short</span></label></div>
      <div class="seg sm-seg"><label><input type="radio" name="otype" value="MARKET" checked><span>Market</span></label><label><input type="radio" name="otype" value="LIMIT"><span>Limit</span></label><label><input type="radio" name="otype" value="STOP"><span>Stop (breakout)</span></label></div>
      <div class="field otype-px"><label id="pa-pxlabel">Limit price</label><input class="input num" name="price" type="number" step="any"></div>
      <div class="grid-2"><div class="field"><label>Stop-loss</label><input class="input num" name="stop" type="number" step="any"></div><div class="field"><label>Target</label><input class="input num" name="target" type="number" step="any"></div></div>
      <div class="field"><label>Quantity</label><div class="input-row"><input class="input num" name="qty" type="number" min="1" step="1"><button type="button" class="btn sm" data-pa="size">Size to ₹${nf0.format(G.session.risk)} risk</button></div></div>
      <div class="faint" id="pa-preview" style="font-size:12px;min-height:16px"></div>
      <div class="err" id="pa-oerr"></div>
      <button class="btn primary" type="submit">Place order</button>
    </form>`;
}

function pendingHtml(o, c) {
  const label = `${o.side === 'LONG' ? 'BUY' : 'SHORT'} ${o.type === 'LIMIT' ? 'LIMIT' : 'STOP'}`;
  const dist = ((o.price - c[4]) / c[4]) * 100;
  return `<header class="card-h" style="margin-bottom:10px"><h3>⏳ ${label} ${nf0.format(o.qty)} @ ${nf2.format(o.price)}</h3><span class="sub">${dist > 0 ? '+' : ''}${dist.toFixed(2)}% away</span></header>
    <form id="pa-pending" class="stack" style="gap:10px">
      <div class="field"><label>${o.type === 'LIMIT' ? 'Limit price' : 'Trigger price'}</label><input class="input num" name="price" type="number" step="any" value="${o.price}"></div>
      <div class="grid-2"><div class="field"><label>Stop-loss</label><input class="input num" name="stop" type="number" step="any" value="${o.stop ?? ''}"></div>
        <div class="field"><label>Target</label><input class="input num" name="target" type="number" step="any" value="${o.target ?? ''}"></div></div>
      <div class="row"><button class="btn" type="submit">Modify order</button><button class="btn danger" type="button" data-pa="cancel-order">Cancel order</button></div>
      <div class="faint" style="font-size:12px">Stays open until filled or cancelled. Keep stepping forward.</div>
      <div class="err" id="pa-perr"></div>
    </form>`;
}

function positionHtml(p, c) {
  const unreal = (c[4] - p.entryPrice) * dirOf(p.side) * p.qty;
  const r = p.initialStop != null ? unreal / (Math.abs(p.entryPrice - p.initialStop) * p.qty) : null;
  return `<header class="card-h" style="margin-bottom:10px"><h3><span class="side ${p.side}">${p.side}</span> ${nf0.format(p.qty)} @ ${nf2.format(p.entryPrice)}</h3><b class="mono ${cls(unreal)}">${rfmt(r)}</b></header>
    <form id="pa-manage" class="stack" style="gap:10px">
      <div class="grid-2"><div class="field"><label>Stop-loss</label><input class="input num" name="stop" type="number" step="any" value="${p.stop ?? ''}"></div><div class="field"><label>Target</label><input class="input num" name="target" type="number" step="any" value="${p.target ?? ''}"></div></div>
      <div class="row"><button class="btn" type="submit">Update stop / target</button><button class="btn danger" type="button" data-pa="close">Exit at next open</button></div>
      <div class="faint" style="font-size:12px">Trailing the stop is free; widening it costs practice XP.</div>
      <div class="err" id="pa-merr"></div>
    </form>`;
}

function bindTicket() {
  const f = document.getElementById('pa-order');
  if (f) {
    const prev = () => {
      const c = lastBar(); const side = f.side.value; const stop = Number(f.stop.value) || null; const tgt = Number(f.target.value) || null; const q = Number(f.qty.value) || 0;
      const type = f.otype.value; f.dataset.otype = type;
      document.getElementById('pa-pxlabel').textContent = type === 'LIMIT' ? (side === 'LONG' ? 'Buy at or below' : 'Short at or above') : (side === 'LONG' ? 'Buy when price rises to' : 'Short when price falls to');
      document.getElementById('pa-osub').textContent = type === 'MARKET' ? 'fills at next open' : 'stays open until filled';
      const ref = type === 'MARKET' ? c[4] : Number(f.price.value) || c[4];
      const rpu = stop ? Math.abs(ref - stop) : null;
      document.getElementById('pa-preview').innerHTML = [rpu && q ? `risk ≈ ₹${nf0.format(rpu * q)}` : '', rpu && tgt ? `R:R ≈ 1:${(Math.abs(tgt - ref) / rpu).toFixed(2)}` : ''].filter(Boolean).join(' · ');
    };
    f.addEventListener('input', prev);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const c = lastBar(); const side = f.side.value; const qty = Math.floor(Number(f.qty.value)); const type = f.otype.value;
      const stop = f.stop.value === '' ? null : Number(f.stop.value); const target = f.target.value === '' ? null : Number(f.target.value);
      const price = type === 'MARKET' ? null : Number(f.price.value);
      const err = (m) => { document.getElementById('pa-oerr').textContent = m; };
      if (!(qty > 0)) return err('Enter a quantity (or size to risk).');
      const bad = checkOrder({ type, side, price, stop, target }, c[4]); if (bad) return err(bad);
      G.pending = { type, price, side, qty, stop, initialStop: stop, target, stopMoves: 0, widened: 0 };
      if (type === 'MARKET') next(); // fills at the next bar's open
      else { refreshOverlays(); paint(); save(true); }
    });
  }
  const po = document.getElementById('pa-pending');
  if (po) {
    po.addEventListener('submit', (e) => {
      e.preventDefault();
      const o = G.pending; const c = lastBar();
      const upd = { ...o, price: Number(po.price.value), stop: po.stop.value === '' ? null : Number(po.stop.value), target: po.target.value === '' ? null : Number(po.target.value) };
      const bad = checkOrder(upd, c[4]); if (bad) { document.getElementById('pa-perr').textContent = bad; return; }
      upd.initialStop = upd.stop; G.pending = upd; refreshOverlays(); paint(); save(true);
    });
  }
  const m = document.getElementById('pa-manage');
  if (m) {
    m.addEventListener('submit', (e) => {
      e.preventDefault();
      const p = G.position; const c = lastBar(); const d = dirOf(p.side);
      const stop = m.stop.value === '' ? null : Number(m.stop.value); const target = m.target.value === '' ? null : Number(m.target.value);
      if (stop != null && (d > 0 ? stop >= c[4] : stop <= c[4])) { document.getElementById('pa-merr').textContent = 'That stop would already be hit — use Exit instead.'; return; }
      if (stop !== p.stop) {
        if (p.stop != null && stop != null && (stop - p.stop) * d < 0) p.widened = (p.widened || 0) + 1;
        if (p.stop == null && p.initialStop == null) p.initialStop = stop;
        p.stop = stop; p.stopMoves = (p.stopMoves || 0) + 1;
      }
      p.target = target;
      refreshOverlays(); paint(); save(true);
    });
  }
}

export function practiceAction(name, el) {
  const id = el?.dataset?.id;
  switch (name) {
    case 'surprise': {
      const f = document.getElementById('pa-setup'); if (!f) return;
      f.symbol.value = pick(); f.exchange.value = 'NSE'; f.start.value = ''; f.blind.checked = true;
      f.requestSubmit(); return;
    }
    case 'next': return G && next();
    case 'skip': return G && next(10);
    case 'auto': return G && toggleAuto();
    case 'end': return G && endSession();
    case 'skip-chart': return skipChart();
    case 'close': if (G?.position) { G.pendingExit = true; next(); } return;
    case 'cancel-order': if (G?.pending) { G.pending = null; refreshOverlays(); paint(); save(true); } return;
    case 'size': {
      const f = document.getElementById('pa-order'); const c = lastBar(); const stop = Number(f.stop.value);
      if (!stop) { document.getElementById('pa-oerr').textContent = 'Set a stop first.'; return; }
      const ref = f.otype.value === 'MARKET' ? c[4] : Number(f.price.value) || c[4];
      f.qty.value = Math.max(1, Math.floor(G.session.risk / Math.abs(ref - stop))); f.dispatchEvent(new Event('input')); return;
    }
    case 'resume': return resume(id);
    case 'review': return resume(id, true);
    case 'delete': return (async () => { if (G?.session.id === id) G = null; await ctx.api(`/api/practice/sessions/${id}`, { method: 'DELETE' }); await ctx.reload(); })();
    default:
  }
}

export function practiceKey(e) {
  if (!G || !document.getElementById('pa-chart')) return false;
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.key === 'ArrowRight' && e.shiftKey) { e.preventDefault(); next(10); return true; }
  if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'd' || e.key === 'D') { e.preventDefault(); next(); return true; }
  if (e.key === 'p' || e.key === 'P') { e.preventDefault(); toggleAuto(); return true; }
  if ((e.key === 'n' || e.key === 'N') && !e.ctrlKey && !e.metaKey) { e.preventDefault(); skipChart(); return true; }
  return false;
}

// ---------- review ----------
function openReview(s, data) {
  const risk = ctx.state().settings.maxRiskPerTrade;
  const res = (s.trades || []).map((t) => ({ t, ...tradeResult(t), items: scoreTrade(t, s.risk || risk) }));
  const pnl = res.reduce((a, b) => a + (b.pnl || 0), 0); const tr = res.reduce((a, b) => a + (b.r || 0), 0);
  const xp = res.reduce((a, b) => a + b.items.reduce((x, y) => x + y.xp, 0), 0);
  const first = data.candles[s.startIndex]; const last = data.candles[s.cursor ?? data.candles.length - 1];
  const el = ctx.openModal(`<div class="modal" style="width:min(1200px,100%)"><div class="modal-h"><h2>🏁 ${ctx.esc(s.symbol)} <span class="pill">${IV_LABEL[s.interval]}</span> <span class="faint" style="font-size:13px;font-weight:500">${first ? fmtBar(first[0], s.interval) : ''} → ${last ? fmtBar(last[0], s.interval) : ''}</span></h2><button class="btn ghost sm" data-action="close-modal">✕</button></div>
    <div class="modal-b"><div class="kpis" style="margin-bottom:12px;grid-template-columns:repeat(4,1fr)">
      ${[['Trades', res.length], ['P&L', `<span class="${cls(pnl)}">${money(pnl)}</span>`], ['Total R', `<span class="${cls(tr)}">${rfmt(tr)}</span>`], ['Practice XP', `<span class="gold">${xp > 0 ? '+' : ''}${xp}</span>`]].map(([k, v]) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}</div>
      <div data-chart-wrap><div class="row" style="margin-bottom:6px">${drawToolbar()}<span class="faint" style="font-size:12px">Shift+click to measure</span></div><div id="pa-review-chart" style="height:440px;position:relative"></div></div>
      ${res.length ? `<div class="table-wrap" style="margin-top:12px"><table class="tbl"><tbody>${res.map((x) => `<tr><td><span class="side ${x.t.side}">${x.t.side}</span></td><td class="num">${nf0.format(x.t.qty)} @ ${nf2.format(x.t.entryPrice)} → ${nf2.format(x.t.exitPrice)}</td><td class="faint">${ctx.esc(x.t.exitReason)}</td><td class="r num ${cls(x.pnl)}">${money(x.pnl)}</td><td class="r num ${cls(x.r)}">${rfmt(x.r)}</td><td class="faint" style="white-space:normal;font-size:12px">${x.items.map((i) => `${i.xp > 0 ? '+' : ''}${i.xp} ${ctx.esc(i.label)}`).join(' · ')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-sm">No trades taken — sometimes the best trade is none.</div>'}
    </div></div>`, { dismissable: true });
  // Full chart including what happened after you stopped.
  const C = { text: css('--muted'), border: css('--border'), green: css('--green'), red: css('--red'), accent: css('--accent'), gold: css('--gold') };
  const host = el.querySelector('#pa-review-chart');
  let chart; let drawn;
  const drawReview = () => {
  drawn?.destroy?.(); chart?.remove();
  chart = createChart(host, { autoSize: true, layout: { background: { color: 'transparent' }, textColor: C.text, fontSize: 11, attributionLogo: true }, grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(128,128,128,.08)' } }, timeScale: { borderColor: C.border, timeVisible: s.interval !== 'day' }, rightPriceScale: { borderColor: C.border } });
  const ser = addPriceSeries(chart, C);
  ser.setData(data.candles.map((c) => ({ time: toTime(c[0], s.interval), open: c[1], high: c[2], low: c[3], close: c[4] })));
  for (const n of practiceMas()) {
    const line = chart.addSeries(LineSeries, { color: maColor(n), lineWidth: n === 200 ? 2 : 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    line.setData(emaLine(data.candles, n, s.interval));
  }
  const marks = [];
  if (first) marks.push({ time: toTime(first[0], s.interval), position: 'aboveBar', color: C.text, shape: 'square', text: 'Replay start' });
  for (const t of s.trades || []) {
    const long = t.side === 'LONG';
    if (data.candles[t.entryBar]) marks.push({ time: toTime(data.candles[t.entryBar][0], s.interval), position: long ? 'belowBar' : 'aboveBar', color: C.accent, shape: long ? 'arrowUp' : 'arrowDown', text: `${long ? 'Buy' : 'Short'} ${nf2.format(t.entryPrice)}` });
    if (data.candles[t.exitBar]) marks.push({ time: toTime(data.candles[t.exitBar][0], s.interval), position: long ? 'aboveBar' : 'belowBar', color: C.gold, shape: 'circle', text: `${t.exitReason} ${nf2.format(t.exitPrice)}` });
  }
  marks.sort((a, b) => (a.time > b.time ? 1 : a.time < b.time ? -1 : 0));
  createSeriesMarkers(ser, marks);
  chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, s.startIndex - 60), to: Math.min(data.candles.length, (s.cursor ?? s.startIndex) + 40) });
  drawn = attachDrawings({ chart, series: ser, host, key: `pa:${s.id}`, times: () => data.candles.map((c) => c[0]), candles: () => data.candles });
  };
  drawReview();
  const onStyle = () => { if (!document.body.contains(host)) return window.removeEventListener('tq:chartstyle', onStyle); drawReview(); };
  window.addEventListener('tq:chartstyle', onStyle);
}

// EMA 20 / 50 / 200 on or off in Practice.
if (typeof document !== 'undefined') document.addEventListener('change', (e) => {
  const n = +e.target.dataset?.paEma; if (!n) return;
  const on = practiceMas();
  setPracticeMas(MA_PERIODS.filter((x) => (x === n ? e.target.checked : on.includes(x))));
  if (G && G.session.status === 'active' && document.getElementById('pa-chart')) { buildChart(); paint(); }
});

// Candles ↔ bars (and MA colours): redraw the live replay chart.
if (typeof window !== 'undefined') window.addEventListener('tq:chartstyle', () => { if (G && G.session.status === 'active' && document.getElementById('pa-chart')) { buildChart(); paint(); } });

// ---------- market context: relative strength + breadth ----------
const pctTxt = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;

/** Per-bar breadth values for the histogram pane: Nifty 500 daily, or Nifty 50 bar by bar once loaded. */
const breadthView = () => { try { const v = localStorage.getItem('tq-breadth-view'); return BREADTH_VIEWS.some(([k]) => k === v) ? v : 'pct50'; } catch { return 'pct50'; } };
const LINE_VIEWS = new Set(['pct50', 'pct200', 'adline']);
function breadthBars() {
  const iv = G.data.interval;
  if (iv !== 'day' && G.n50) return { label: 'N50 net', kind: 'hist', at: (c) => { const x = G.n50.get(c[0]); return x && x.n ? x.adv - x.dec : null; } };
  const b = ctx.S().breadth;
  if (iv === 'day' && b?.dates?.length) {
    const view = breadthView();
    const label = BREADTH_VIEWS.find(([k]) => k === view)[1];
    return { view, label: `N500 ${label}`, kind: LINE_VIEWS.has(view) ? 'line' : 'hist', at: (c) => breadthValue(b, view, istDate(c[0])) };
  }
  return null;
}
function brPoint(c) {
  const t = toTime(c[0], G.data.interval);
  const v = G.brAll?.at(c);
  if (v == null) return { time: t };
  return G.brAll.kind === 'line' ? { time: t, value: v } : { time: t, value: v, color: v >= 0 ? 'rgba(34,197,94,.55)' : 'rgba(244,80,107,.55)' };
}

function paintMarket(blind) {
  const el = document.getElementById('pa-mkt'); if (!el) return;
  const c = G.data.candles[G.cursor]; if (!c) { el.innerHTML = ''; return; }
  const parts = [];
  const rs = G.data.bench?.length ? rsReadout(G.data.candles, G.data.bench, G.cursor, 20) : null;
  if (rs) {
    const tag = rs.atHigh ? ' · <b class="pos">RS at 50-bar high</b>' : rs.atLow ? ' · <b class="neg">RS at 50-bar low</b>' : '';
    parts.push(`<span title="Relative strength: the stock's move vs the Nifty 50 over the last ${rs.bars} bars">💪 RS vs Nifty 50 (${rs.bars} bars): stock <b class="${rs.stockPct >= 0 ? 'pos' : 'neg'}">${pctTxt(rs.stockPct)}</b> · Nifty <b>${pctTxt(rs.benchPct)}</b> → <b class="${rs.edge >= 0 ? 'pos' : 'neg'}">${rs.edge >= 0 ? 'outperforming' : 'underperforming'}</b>${tag}</span>`);
  } else parts.push('<span class="faint">💪 RS: Nifty 50 data unavailable for this chart</span>');
  const b = ctx.S().breadth; const iv = G.data.interval;
  if (iv !== 'day' && G.n50) {
    const x = G.n50.get(c[0]);
    if (x?.n) parts.push(`<span>📊 Nifty 50 now: <b class="pos">${x.adv}↑</b> / <b class="neg">${x.dec}↓</b> of ${x.n}</span>`);
  }
  if (b?.dates?.length) {
    const x = breadthOn(b, istDate(c[0]), { before: iv !== 'day' });
    if (x) parts.push(`<span title="${iv === 'day' ? 'This day' : 'The previous trading day'} across the Nifty 500">📊 Nifty 500${iv === 'day' ? '' : ' (prev. day)'}${blind ? '' : ` ${fmtBar(Date.parse(x.date), 'day').replace(/^\w+, /, '')}`}: <b class="pos">${x.adv}↑</b> / <b class="neg">${x.dec}↓</b> · ${x.pct50 != null ? `${Math.round(x.pct50 * 100)}% > 50-DMA` : ''}${x.pct200 != null ? ` · ${Math.round(x.pct200 * 100)}% > 200-DMA` : ''}</span>`);
    else parts.push('<span class="faint">📊 No Nifty 500 breadth for this date — build more years in Settings</span>');
  } else parts.push(`<span class="faint">📊 Breadth: build it once in <a href="#/settings">Settings → Market breadth</a></span>`);
  if (iv === 'day' && b?.dates?.length) {
    const view = breadthView();
    const v = breadthValue(b, view, istDate(c[0]));
    const hint = { pct50: v == null ? '' : v >= 80 ? ' (stretched)' : v <= 20 ? ' (washed out)' : '', pct200: v == null ? '' : v >= 60 ? ' (healthy)' : v <= 40 ? ' (weak)' : '', mcclellan: v == null ? '' : v >= 0 ? ' (breadth momentum up)' : ' (breadth momentum down)' }[view] || '';
    parts.push(`<label class="row" style="gap:6px">Pane: <select class="input sm-select" data-breadth-view>${BREADTH_VIEWS.map(([k, l]) => `<option value="${k}" ${k === view ? 'selected' : ''}>${l}</option>`).join('')}</select>${v != null && view !== 'adline' ? `<b>${view.startsWith('pct') ? `${Math.round(v)}%` : Math.round(v)}${hint}</b>` : ''}</label>`);
  }
  if (iv !== 'day' && !G.n50 && ctx.S().kite.connected) parts.push(`<button class="btn sm ghost" data-pa="n50">Load Nifty 50 breadth bar by bar (~20 s)</button>`);
  el.innerHTML = parts.join('');
}

async function loadN50(btn) {
  if (!G) return;
  btn.disabled = true;
  try {
    const times = G.data.candles.map((c) => c[0]);
    const { nifty50Intraday } = await import('./js/breadth.js');
    G.n50 = await nifty50Intraday(G.data.interval, times, (d, n) => { btn.textContent = `Loading Nifty 50… ${d}/${n}`; });
    buildChart(); paint();
  } catch (e) { btn.disabled = false; btn.textContent = 'Load Nifty 50 breadth bar by bar'; ctx.toast(ctx.esc(e.message), 'err'); }
}
if (typeof document !== 'undefined') document.addEventListener('click', (e) => { const b = e.target.closest?.('[data-pa="n50"]'); if (b) loadN50(b); });
if (typeof document !== 'undefined') document.addEventListener('change', (e) => {
  const sel = e.target.closest?.('[data-breadth-view]'); if (!sel) return;
  try { localStorage.setItem('tq-breadth-view', sel.value); } catch { /* private mode */ }
  if (G && document.getElementById('pa-chart')) { buildChart(); paint(); }
});
