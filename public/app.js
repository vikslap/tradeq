import { computeGame, metrics, entryChecks, exitChecks, dayKey, tradeKey, weekStart, LEVELS, levelFor } from './game.js';
import { computeStats, groupBy, rHistogram } from './stats.js';

// =====================================================================
// Utilities
// =====================================================================
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const sum = (a) => a.reduce((s, x) => s + x, 0);
const money = (v, { sign = false, dp = 2 } = {}) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const f = dp ? nf2 : nf0;
  return `${v < 0 ? '−' : sign && v > 0 ? '+' : ''}₹${f.format(Math.abs(v))}`;
};
const compact = (v) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v); const s = v < 0 ? '−' : '';
  if (a >= 1e7) return `${s}₹${(a / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(2)}L`;
  return `${s}₹${nf0.format(a)}`;
};
const price = (v) => (v == null ? '—' : nf2.format(v));
const pct = (v, dp = 1) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(dp)}%`);
const rfmt = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}R`);
const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—');
const fmtDT = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const ago = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`; if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return fmtDate(iso);
};
const hold = (d) => (d < 1 ? `${Math.max(1, Math.round(d * 24))}h` : `${Math.round(d)}d`);
const toLocalInput = (iso) => { const d = iso ? new Date(iso) : new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);
const xpPill = (x) => (x ? `<span class="xp-pill ${x > 0 ? 'plus' : 'minus'}">${x > 0 ? '+' : ''}${x} XP</span>` : '');

const EXCHANGES = ['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS'];
const SEGMENTS = [['EQ', 'Equity'], ['FUT', 'Futures'], ['OPT', 'Options'], ['COM', 'Commodity']];
const EMO_IN = ['Calm', 'Confident', 'Excited', 'Anxious', 'FOMO', 'Bored', 'Revenge', 'Greedy'];
const EMO_OUT = ['Calm', 'Satisfied', 'Relieved', 'Frustrated', 'Regretful', 'Euphoric'];
const EXIT_REASONS = ['Target hit', 'Stop hit', 'Trailing stop', 'Thesis invalid', 'Time exit', 'Discretionary'];
const DEFAULT_SETUPS = ['Breakout', 'Range breakout', 'Breakdown', 'Pullback', 'Trend continuation', 'Reversal', 'Support bounce', 'Gap play', 'Earnings'];
const MANTRAS = ['Plan the trade. Trade the plan.', 'The stop is a promise to yourself.', 'Risk first, reward second.', 'No setup, no trade.', 'Small losses are tuition, not failure.', 'Sitting out is a position too.', 'Process today, profits later.'];

function guessSegment(exchange, symbol = '') {
  if (exchange === 'MCX') return /(CE|PE)$/.test(symbol) ? 'OPT' : 'COM';
  if (exchange === 'NFO' || exchange === 'BFO') return /\d(CE|PE)$/.test(symbol) ? 'OPT' : 'FUT';
  return 'EQ';
}

// =====================================================================
// State
// =====================================================================
const S = {
  state: null, game: null, stats: null,
  kite: { configured: false, connected: false, mock: false },
  quotes: {}, quotesAt: null, flash: new Set(),
  f: { q: '', status: 'all', segment: 'all', setup: 'all' },
  drawerId: null, reviewWeek: null,
};

async function api(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(j.error || `Request failed (${res.status})`); e.code = j.code; throw e; }
  return j;
}

async function reload({ celebrate = false } = {}) {
  const prev = S.game;
  S.state = await api('/api/state');
  S.game = computeGame(S.state);
  S.stats = computeStats(S.state.trades);
  if (celebrate && prev) celebrateDiff(prev, S.game);
  render();
}

async function loadKite() {
  try { S.kite = await api('/api/kite/status'); } catch { S.kite = { configured: false, connected: false }; }
}

const quoteFor = (t) => S.quotes[tradeKey(t)];
const ltpFor = (t) => quoteFor(t)?.last ?? null;

// =====================================================================
// Rendering shell
// =====================================================================
function route() {
  const [p, qs] = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('?');
  return { page: p || 'dashboard', params: new URLSearchParams(qs || '') };
}

function render() {
  if (!S.state) return;
  const { page } = route();
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === page));
  renderTop();
  const pages = { dashboard: pageDashboard, journal: pageJournal, insights: pageInsights, review: pageReview, achievements: pageAchievements, settings: pageSettings };
  $('#main').innerHTML = (pages[page] || pageDashboard)();
  if (page === 'settings') bindSettings();
  if (page === 'review') bindReview();
  if (S.drawerId) renderDrawer();
  $('#sidebar-foot').innerHTML = `<div class="card" style="padding:14px"><div class="label">Today's mantra</div><div style="margin-top:6px;font-weight:600;line-height:1.45">${MANTRAS[new Date().getDate() % MANTRAS.length]}</div></div>`;
}

function renderTop() {
  const g = S.game; const L = g.level;
  const k = S.kite;
  const kiteChip = k.mock ? `<span class="chip demo" title="Simulated prices — set KITE_MOCK=0 for real Kite data"><span class="dot"></span>Kite · Demo</span>`
    : k.connected ? `<span class="chip on" title="Connected as ${esc(k.user?.name)} · expires ${fmtDT(k.expiresAt)}"><span class="dot"></span>Kite · Live</span>`
      : `<a href="#/settings" class="chip off" title="${k.configured ? 'Login expired — reconnect' : 'Add your Kite API key in .env'}"><span class="dot"></span>Kite · ${k.configured ? 'Reconnect' : 'Manual mode'}</a>`;
  $('#topbar').innerHTML = `
    <a class="lvl-chip" href="#/achievements" title="${g.xp} XP total">
      <div class="lvl-num">${L.lvl}</div>
      <div class="lvl-meta">
        <div class="lvl-title"><span>${esc(L.title)}</span><span class="xp">${nf0.format(L.xp - L.floor)} / ${nf0.format(L.next - L.floor)} XP</span></div>
        <div class="xpbar"><span style="width:${(L.progress * 100).toFixed(1)}%"></span></div>
      </div>
    </a>
    <span class="chip flame" title="Clean trades in a row (best ${g.streak.best})">🔥 ${g.streak.current} clean streak</span>
    <span class="chip" title="Rule checks passed over your last ${g.disciplineSample} closed trades">🧭 Discipline ${g.discipline == null ? '—' : g.discipline + '%'}</span>
    <div class="top-spacer"></div>
    ${kiteChip}
    <button class="btn primary" data-action="new-trade">＋ New trade</button>`;
}

// =====================================================================
// Pages
// =====================================================================
function ring(p, size, stroke, color) {
  const r = (size - stroke) / 2; const c = 2 * Math.PI * r; const v = Math.max(0, Math.min(1, p || 0));
  return `<svg class="ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="var(--ring-bg)" stroke-width="${stroke}" fill="none"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="${color}" stroke-width="${stroke}" fill="none" stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - v)).toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`;
}

function pageDashboard() {
  const { trades, settings } = S.state; const g = S.game; const st = S.stats;
  if (!trades.length) {
    return `<div class="card empty">
      <div class="big">⚔️</div><h2>Welcome, ${esc(settings.displayName)}. Your quest starts with one trade.</h2>
      <p>TradeQuest rewards <b>process</b>, not profit: set a stop before you enter, keep risk within ₹${nf0.format(settings.maxRiskPerTrade)}, follow your plan and write down what you learned. Do that consistently and the XP, levels and badges follow.</p>
      <div class="row" style="justify-content:center"><button class="btn primary" data-action="new-trade">＋ Log your first trade</button><a class="btn" href="#/settings">Connect Kite</a></div>
    </div>`;
  }
  const L = g.level;
  const open = trades.filter((t) => t.status === 'OPEN');
  const lastBadge = g.badges.filter((b) => b.earned).sort((a, b) => new Date(b.earnedAt) - new Date(a.earnedAt))[0];
  const discColor = g.discipline == null ? 'var(--faint)' : g.discipline >= 80 ? 'var(--green)' : g.discipline >= 60 ? 'var(--gold)' : 'var(--red)';
  const doneQ = g.quests.filter((q) => q.done).length;
  return `<div class="dash">
    <section class="card hero">
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
    <section class="card">
      <header class="card-h"><h3>Today's quests</h3><span class="sub">${doneQ}/${g.quests.length} done · clean day = +20 XP</span></header>
      <div class="quests">${g.quests.map(questHtml).join('')}</div>
    </section>
    <div class="kpis span-2" id="kpis">${kpiTiles()}</div>
    <section class="card span-2">
      <header class="card-h"><h3>Open positions <span class="faint" style="font-weight:500">· ${open.length}</span></h3><span class="sub" id="live-note">${liveNote()}</span></header>
      <div id="open-positions">${openPositionsInner()}</div>
    </section>
    <section class="card">
      <header class="card-h"><h3>Equity curve</h3><span class="sub">${st.count} closed · max drawdown ${compact(-st.maxDD)}</span></header>
      ${equityChart(st.curve)}
    </section>
    <section class="card">
      <header class="card-h"><h3>XP feed</h3><a class="link" href="#/achievements">See all →</a></header>
      ${xpFeed(g.events.slice(0, 9))}
    </section>
  </div>`;
}

function questHtml(q) {
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

function unrealised() {
  return sum(S.state.trades.filter((t) => t.status === 'OPEN').map((t) => metrics(t, ltpFor(t)).net || 0));
}

function kpiTiles() {
  const st = S.stats;
  const open = S.state.trades.filter((t) => t.status === 'OPEN');
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

function liveNote() {
  if (!S.kite.connected) return S.kite.configured ? '<a class="link" href="#/settings">Reconnect Kite for live prices</a>' : 'Manual mode · <a class="link" href="#/settings">connect Kite</a>';
  return S.quotesAt ? `${S.kite.mock ? 'Demo prices' : 'Live'} · updated ${fmtTime(S.quotesAt)}` : 'Fetching prices…';
}

function openPositionsInner() {
  const open = S.state.trades.filter((t) => t.status === 'OPEN').sort((a, b) => new Date(b.entryTime) - new Date(a.entryTime));
  if (!open.length) return '<div class="empty-sm">No open positions. Waiting for the right setup is a skill.</div>';
  return `<div class="table-wrap"><table class="tbl"><thead><tr>
    <th>Symbol</th><th>Side</th><th class="r">Qty</th><th class="r">Entry</th><th class="r">LTP</th><th class="r">Stop</th><th class="r">Target</th><th class="r">MTM</th><th class="r">R now</th><th>Held</th><th></th></tr></thead><tbody>
    ${open.map((t) => {
    const q = quoteFor(t); const m = metrics(t, q?.last ?? null);
    const flash = S.flash.has(tradeKey(t));
    return `<tr class="click" data-action="open-drawer" data-id="${t.id}">
      <td><span class="sym">${esc(t.symbol)}</span><span class="exch">${t.exchange}</span></td>
      <td><span class="side ${t.side}">${t.side}</span></td>
      <td class="r num">${nf0.format(t.qty)}</td>
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

function xpFeed(events) {
  if (!events.length) return '<div class="empty-sm">No XP yet.</div>';
  return `<div class="feed">${events.map((e) => `<div class="feed-item">${xpPill(e.xp)}<span class="what">${esc(e.label)}${e.symbol ? ` <span class="faint">· ${esc(e.symbol)}</span>` : ''}</span><span class="when">${ago(e.at)}</span></div>`).join('')}</div>`;
}

function equityChart(curve) {
  if (curve.length < 2) return '<div class="empty-sm">Close a trade to start your equity curve.</div>';
  const W = 600; const H = 230; const PL = 6; const PR = 6; const PT = 18; const PB = 18;
  const vals = curve.map((p) => p.v);
  let min = Math.min(0, ...vals); let max = Math.max(0, ...vals);
  if (max === min) max += 1;
  const pad = (max - min) * 0.1; min -= pad; max += pad;
  const X = (i) => PL + (i * (W - PL - PR)) / (curve.length - 1);
  const Y = (v) => PT + ((max - v) / (max - min)) * (H - PT - PB);
  const line = curve.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
  const area = `${line}L${X(curve.length - 1).toFixed(1)},${Y(0).toFixed(1)}L${X(0).toFixed(1)},${Y(0).toFixed(1)}Z`;
  const last = vals.at(-1); const c = last >= 0 ? '#22c55e' : '#f4506b';
  const dots = curve.length <= 80 ? curve.slice(1).map((p, i) => `<circle cx="${X(i + 1).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="2.6" fill="${metrics(p.t).net >= 0 ? '#22c55e' : '#f4506b'}"><title>${esc(p.t.symbol)} ${money(metrics(p.t).net, { sign: true })} → ${money(p.v)}</title></circle>`).join('') : '';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <defs><linearGradient id="eqg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${c}" stop-opacity=".32"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></linearGradient></defs>
    <line x1="${PL}" x2="${W - PR}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}" stroke="#2e3850" stroke-dasharray="4 4"/>
    <path d="${area}" fill="url(#eqg)"/>
    <path d="${line}" fill="none" stroke="${c}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
    <text x="${W - PR}" y="12" text-anchor="end">${esc(money(last, { dp: 0 }))}</text>
  </svg>`;
}

// ---------- Journal ----------
function filteredTrades() {
  const f = S.f; const q = f.q.trim().toLowerCase();
  return S.state.trades.filter((t) => {
    if (f.status !== 'all' && t.status !== f.status) return false;
    if (f.segment !== 'all' && t.segment !== f.segment) return false;
    if (f.setup !== 'all' && (t.setup || '') !== f.setup) return false;
    if (q && !`${t.symbol} ${t.setup} ${t.thesis} ${t.lessons} ${(t.tags || []).join(' ')}`.toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => new Date(b.entryTime) - new Date(a.entryTime));
}

function setupOptions() {
  return [...new Set([...S.state.trades.map((t) => t.setup).filter(Boolean), ...DEFAULT_SETUPS])];
}

function pageJournal() {
  const usedSetups = [...new Set(S.state.trades.map((t) => t.setup).filter(Boolean))].sort();
  const f = S.f;
  return `<div class="page-h"><div><h1>Journal</h1><p>Every trade, its plan, and the XP it earned.</p></div>
    <div class="row">${S.kite.connected ? '<button class="btn" data-action="kite-fills">⚡ Today\'s Kite fills</button>' : ''}<button class="btn primary" data-action="new-trade">＋ New trade</button></div></div>
    <div class="toolbar">
      <input class="input search" placeholder="Search symbol, setup, notes…" data-filter="q" value="${esc(f.q)}">
      <div class="seg">${[['all', 'All'], ['OPEN', 'Open'], ['CLOSED', 'Closed']].map(([v, l]) => `<label><input type="radio" name="fstatus" data-filter="status" value="${v}" ${f.status === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
      <select class="input" data-filter="segment"><option value="all">All segments</option>${SEGMENTS.map(([v, l]) => `<option value="${v}" ${f.segment === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select class="input" data-filter="setup"><option value="all">All setups</option>${usedSetups.map((s) => `<option ${f.setup === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
      <span class="muted" id="journal-summary" style="margin-left:auto"></span>
    </div>
    <div class="card" style="padding:6px 14px"><div class="table-wrap"><table class="tbl"><thead><tr>
      <th>Entered</th><th>Symbol</th><th>Side</th><th class="r">Qty</th><th class="r">Entry</th><th class="r">Exit / LTP</th><th class="r">Net P&L</th><th class="r">R</th><th>Setup</th><th>Plan</th><th class="r">XP</th></tr></thead>
      <tbody id="journal-body">${journalRows()}</tbody></table></div></div>`;
}

function journalRows() {
  const list = filteredTrades();
  queueMicrotask(() => {
    const el = $('#journal-summary');
    if (el) { const n = sum(list.filter((t) => t.status === 'CLOSED').map((t) => metrics(t).net)); el.innerHTML = `${list.length} trades · realised <span class="${cls(n)} mono">${money(n, { sign: true })}</span>`; }
  });
  if (!list.length) return `<tr><td colspan="11"><div class="empty-sm">${S.state.trades.length ? 'No trades match these filters.' : 'No trades yet — log your first one.'}</div></td></tr>`;
  return list.map((t) => {
    const ltp = t.status === 'OPEN' ? ltpFor(t) : null;
    const m = metrics(t, ltp); const x = S.game.tradeXp[t.id] || 0;
    const plan = t.status === 'OPEN' ? '<span class="pill violet">open</span>' : t.followedPlan === true ? '<span class="pill green">✓ kept</span>' : t.followedPlan === false ? '<span class="pill red">✕ broke</span>' : '<span class="pill">—</span>';
    return `<tr class="click" data-action="open-drawer" data-id="${t.id}">
      <td class="muted">${fmtDate(t.entryTime)}</td>
      <td><span class="sym">${esc(t.symbol)}</span><span class="exch">${t.exchange}</span></td>
      <td><span class="side ${t.side}">${t.side}</span></td>
      <td class="r num">${nf0.format(t.qty)}</td>
      <td class="r num">${price(t.entryPrice)}</td>
      <td class="r num">${t.status === 'CLOSED' ? price(t.exitPrice) : ltp != null ? `<span class="faint">${price(ltp)}</span>` : '—'}</td>
      <td class="r num ${cls(m.net)}">${m.net == null ? '—' : money(m.net, { sign: true })}${t.status === 'OPEN' && m.net != null ? ' <span class="faint">·u</span>' : ''}</td>
      <td class="r num ${cls(m.r)}">${rfmt(m.r)}</td>
      <td>${t.setup ? `<span class="pill">${esc(t.setup)}</span>` : '<span class="faint">—</span>'}</td>
      <td>${plan}</td>
      <td class="r">${xpPill(x) || '<span class="faint">0</span>'}</td>
    </tr>`;
  }).join('');
}

// ---------- Insights ----------
function bars(groups, { fmt = (v) => money(v, { sign: true, dp: 0 }) } = {}) {
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

function pageInsights() {
  const st = S.stats; const g = S.game;
  if (!st.count) return `<div class="page-h"><div><h1>Insights</h1><p>Patterns appear after a few closed trades.</p></div></div><div class="card empty"><div class="big">📊</div><h2>Close a few trades to unlock insights</h2><p>You'll see P&L by setup, weekday and emotion, your R-multiple distribution, and exactly what your mistakes cost you.</p></div>`;
  const closed = st.closed;
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hist = rHistogram(closed); const hmax = Math.max(...hist.map((h) => h.count), 1);

  // Mistake cost — uses the same rule checks as XP.
  const flag = (id, pred) => closed.filter(({ t }) => {
    const pt = g.perTrade[t.id]; const all = [...(pt?.entry || []), ...(pt?.exit || [])];
    return all.some((i) => i.id === id && pred(i));
  });
  const mistakes = [
    ['No stop-loss at entry', flag('stop', (i) => !i.ok)],
    ['Oversized risk', flag('risk', (i) => i.xp < 0)],
    ['Revenge entries', flag('revenge', (i) => !i.ok)],
    ['Over daily trade limit', flag('overtrade', (i) => !i.ok)],
    ['Broke the plan', flag('plan', (i) => i.xp < 0)],
    ['Widened the stop', flag('widen', (i) => !i.ok)],
    ['Loss ran past the stop', flag('honour', (i) => !i.ok)],
  ];
  const clean = closed.filter(({ t }) => g.perTrade[t.id]?.clean);
  const dirty = closed.filter(({ t }) => !g.perTrade[t.id]?.clean);
  const grp = (list) => ({ n: list.length, net: sum(list.map((x) => x.m.net)), wr: list.length ? list.filter((x) => x.m.net > 0).length / list.length : null, r: (() => { const rs = list.map((x) => x.m.r).filter((v) => v != null); return rs.length ? sum(rs) / rs.length : null; })() });
  const C = grp(clean); const D = grp(dirty);

  const tiles = [
    ['Net P&L', `<span class="${cls(st.net)}">${compact(st.net)}</span>`, `${st.count} closed`],
    ['Expectancy', `<span class="${cls(st.expectancy)}">${compact(st.expectancy)}</span>`, 'avg net per trade'],
    ['Avg win', `<span class="pos">${compact(st.avgWin)}</span>`, `avg loss ${compact(st.avgLoss)} · payoff ${st.avgWin && st.avgLoss ? (st.avgWin / -st.avgLoss).toFixed(2) : '—'}`],
    ['Max drawdown', `<span class="neg">${compact(-st.maxDD)}</span>`, 'peak-to-trough, realised'],
    ['Hold: winners', st.avgHoldWin == null ? '—' : hold(st.avgHoldWin), `losers ${st.avgHoldLoss == null ? '—' : hold(st.avgHoldLoss)}`],
    ['Best trade', `<span class="pos">${compact(st.best?.m.net)}</span>`, `${esc(st.best?.t.symbol || '')} · worst ${compact(st.worst?.m.net)}`],
  ];
  return `<div class="page-h"><div><h1>Insights</h1><p>Where your edge lives — and where it leaks.</p></div></div>
  <div class="kpis" style="margin-bottom:16px">${tiles.map(([k, v, s]) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('')}</div>
  <div class="insights">
    <section class="card span-2"><header class="card-h"><h3>Discipline pays: clean trades vs trades with a broken rule</h3></header>
      <div class="grid-2">
        <div class="kpi" style="border-color:rgba(34,197,94,.35)"><div class="k">✓ Clean trades (${C.n})</div><div class="v ${cls(C.net)}">${compact(C.net)}</div><div class="s">win ${pct(C.wr, 0)} · avg ${rfmt(C.r)}</div></div>
        <div class="kpi" style="border-color:rgba(244,80,107,.35)"><div class="k">✕ Trades with a mistake (${D.n})</div><div class="v ${cls(D.net)}">${compact(D.net)}</div><div class="s">win ${pct(D.wr, 0)} · avg ${rfmt(D.r)}</div></div>
      </div></section>
    <section class="card"><header class="card-h"><h3>What mistakes cost you</h3><span class="sub">net P&L of trades with each mistake</span></header>
      ${mistakes.map(([label, list]) => { const n = sum(list.map((x) => x.m.net)); return `<div class="mistake"><span>${label} <span class="faint">× ${list.length}</span></span><span class="num ${cls(n)}">${list.length ? money(n, { sign: true, dp: 0 }) : '—'}</span></div>`; }).join('')}
    </section>
    <section class="card"><header class="card-h"><h3>R-multiple distribution</h3><span class="sub">avg ${rfmt(st.avgR)}</span></header>
      <div class="hist">${hist.map((h) => `<div class="col"><div class="c">${h.count || ''}</div><div class="b" style="height:${(h.count / hmax) * 100}%;background:${h.neg ? 'var(--red)' : 'var(--green)'};opacity:${h.count ? 0.85 : 0.15}"></div><div class="l">${h.label}</div></div>`).join('')}</div>
    </section>
    <section class="card"><header class="card-h"><h3>P&L by setup</h3></header>${bars(groupBy(closed, (t) => t.setup || 'Untagged'))}</section>
    <section class="card"><header class="card-h"><h3>P&L by entry emotion</h3></header>${bars(groupBy(closed, (t) => t.emotionEntry || 'Not recorded'))}</section>
    <section class="card"><header class="card-h"><h3>P&L by weekday (entry)</h3></header>${bars(groupBy(closed, (t) => WD[new Date(t.entryTime).getDay()]))}</section>
    <section class="card"><header class="card-h"><h3>P&L by exit reason</h3></header>${bars(groupBy(closed, (t) => t.exitReason || 'Not recorded'))}</section>
    <section class="card"><header class="card-h"><h3>P&L by segment</h3></header>${bars(groupBy(closed, (t) => Object.fromEntries(SEGMENTS)[t.segment] || t.segment))}</section>
    <section class="card"><header class="card-h"><h3>Long vs short</h3></header>${bars(groupBy(closed, (t) => t.side))}</section>
    <section class="card span-2"><header class="card-h"><h3>Daily P&L — last 26 weeks</h3><span class="sub">by exit date</span></header>${heatmap(st.daily)}</section>
  </div>`;
}

function heatmap(daily) {
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

// ---------- Weekly review ----------
function weekOptions() {
  const out = []; const d = new Date(weekStart());
  for (let i = 0; i < 8; i++) { out.push(dayKey(d)); d.setDate(d.getDate() - 7); }
  return out;
}

function pageReview() {
  const ws = S.reviewWeek || weekStart();
  const start = new Date(ws); const end = new Date(start); end.setDate(end.getDate() + 7);
  const inWeek = (iso) => iso && new Date(iso) >= start && new Date(iso) < end;
  const closed = S.state.trades.filter((t) => t.status === 'CLOSED' && inWeek(t.exitTime)).map((t) => ({ t, m: metrics(t) }));
  const entered = S.state.trades.filter((t) => inWeek(t.entryTime));
  const net = sum(closed.map((x) => x.m.net)); const wins = closed.filter((x) => x.m.net > 0).length;
  const rs = closed.map((x) => x.m.r).filter((v) => v != null);
  const cleanN = closed.filter(({ t }) => S.game.perTrade[t.id]?.clean).length;
  const weekXp = sum(S.game.events.filter((e) => inWeek(e.at)).map((e) => e.xp));
  const existing = S.state.reviews.find((r) => r.weekStart === ws);
  const past = [...S.state.reviews].sort((a, b) => b.weekStart.localeCompare(a.weekStart));
  const label = `${start.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} – ${new Date(end - 86400000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;
  return `<div class="page-h"><div><h1>Weekly review</h1><p>Ten honest minutes a week compounds faster than any indicator. <span class="gold">+40 XP</span> per review.</p></div>
    <select class="input" style="width:auto" data-action-change="review-week">${weekOptions().map((w) => `<option value="${w}" ${w === ws ? 'selected' : ''}>Week of ${new Date(w).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</option>`).join('')}</select></div>
  <div class="kpis" style="margin-bottom:16px">
    ${[['Week', label, `${entered.length} entries`], ['Net realised', `<span class="${cls(net)}">${compact(net)}</span>`, `${closed.length} closed`], ['Win rate', closed.length ? pct(wins / closed.length, 0) : '—', `${wins}W · ${closed.length - wins}L`], ['Avg R', rfmt(rs.length ? sum(rs) / rs.length : null), 'closed this week'], ['Clean trades', `${cleanN}/${closed.length}`, 'every rule kept'], ['XP this week', `<span class="gold">${weekXp > 0 ? '+' : ''}${weekXp}</span>`, 'process points']]
    .map(([k, v, s]) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('')}
  </div>
  <div class="insights">
    <form class="card stack" id="review-form">
      <header class="card-h" style="margin:0"><h3>${existing ? 'Update' : 'Write'} this review</h3>${existing ? '<span class="pill green">✓ done</span>' : '<span class="pill gold">+40 XP</span>'}</header>
      <div class="field"><label>What went well?</label><textarea class="input" name="wentWell" placeholder="Waited for my A+ setup on Tuesday; took the stop on ITC without hesitation.">${esc(existing?.wentWell)}</textarea></div>
      <div class="field"><label>What will you improve?</label><textarea class="input" name="improve" placeholder="Entered TRENT late out of FOMO — skip if price is >2% past the trigger.">${esc(existing?.improve)}</textarea></div>
      <div class="field"><label>One focus for next week</label><input class="input" name="focus" value="${esc(existing?.focus)}" placeholder="Only trade breakouts with volume confirmation"></div>
      <div class="field"><label>Rate your execution</label>${stars('rating', existing?.rating)}</div>
      <div class="err" id="review-err"></div>
      <div class="row"><button class="btn primary" type="submit">${existing ? 'Save review' : 'Complete review · +40 XP'}</button></div>
    </form>
    <section class="card"><header class="card-h"><h3>Closed this week</h3></header>
      ${closed.length ? `<div class="table-wrap"><table class="tbl"><tbody>${closed.map(({ t, m }) => `<tr class="click" data-action="open-drawer" data-id="${t.id}"><td><span class="sym">${esc(t.symbol)}</span></td><td><span class="side ${t.side}">${t.side}</span></td><td class="r num ${cls(m.net)}">${money(m.net, { sign: true })}</td><td class="r num ${cls(m.r)}">${rfmt(m.r)}</td><td>${S.game.perTrade[t.id]?.clean ? '<span class="pill green">clean</span>' : '<span class="pill red">rule broken</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-sm">No trades closed this week.</div>'}
    </section>
    <section class="card span-2"><header class="card-h"><h3>Past reviews</h3></header>
      ${past.length ? past.map((r) => `<div style="padding:12px 0;border-bottom:1px dashed var(--border)"><div class="row" style="justify-content:space-between"><b>Week of ${new Date(r.weekStart).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</b><span class="row">${r.rating ? '<span class="gold">' + '★'.repeat(r.rating) + '</span>' : ''}<button class="btn ghost sm" data-action="delete-review" data-id="${r.id}">Delete</button></span></div>
        ${r.wentWell ? `<div class="prose" style="margin-top:6px"><span class="pos">✓</span> ${esc(r.wentWell)}</div>` : ''}${r.improve ? `<div class="prose"><span class="gold">↑</span> ${esc(r.improve)}</div>` : ''}${r.focus ? `<div class="prose"><span class="muted">Focus:</span> ${esc(r.focus)}</div>` : ''}</div>`).join('') : '<div class="empty-sm">Your reviews will collect here.</div>'}
    </section>
  </div>`;
}

let starSeq = 0;
function stars(name, val) {
  const p = `${name}-${++starSeq}`;
  return `<div class="stars">${[5, 4, 3, 2, 1].map((n) => `<input type="radio" id="${p}-${n}" name="${name}" value="${n}" ${val === n ? 'checked' : ''}><label for="${p}-${n}" title="${n}">★</label>`).join('')}</div>`;
}

function bindReview() {
  const sel = $('[data-action-change="review-week"]');
  sel?.addEventListener('change', () => { S.reviewWeek = sel.value; render(); });
}

// ---------- Achievements ----------
function pageAchievements() {
  const g = S.game; const L = g.level;
  const rungs = LEVELS.map(([xp, title], i) => ({ n: i + 1, xp, title }));
  if (L.lvl > LEVELS.length) rungs.push({ n: L.lvl, xp: L.floor, title: L.title });
  const RULES = [
    ['Trade logged', '+10'], ['Stop-loss set before entry', '+15 / −10'], ['Risk within your limit', '+10 / −20'], ['Thesis (20+ chars)', '+10'],
    ['Target planned', '+5'], ['Setup tagged', '+5'], ['Planned reward ≥ 2R', '+5'], ['Revenge entry (within window of a loss)', '−15'],
    ['Over daily trade limit', '−10'], ['Exit reason recorded', '+10'], ['Followed / broke the plan', '+15 / −10'], ['Lesson written', '+10'],
    ['Loss kept within 1R', '+15'], ['Loss ran past 1.5R', '−20'], ['Widened the stop (each, max 3)', '−15'], ['2R+ / 3R+ winner', '+15 / +25'],
    ['Clean trading day', '+20'], ['Weekly review', '+40'],
  ];
  return `<div class="page-h"><div><h1>Achievements</h1><p>${nf0.format(g.xp)} XP earned · Level ${L.lvl} ${esc(L.title)}</p></div></div>
  <section class="card" style="margin-bottom:16px"><header class="card-h"><h3>Level path</h3><span class="sub">${nf0.format(L.next - L.xp)} XP to next level</span></header>
    <div class="ladder">${rungs.map((r) => `<div class="rung ${r.n < L.lvl ? 'done' : r.n === L.lvl ? 'cur' : ''}"><div class="n">${r.n}</div><div class="t">${esc(r.title)}</div><div class="x">${nf0.format(r.xp)} XP</div></div>`).join('')}</div>
  </section>
  <section class="card" style="margin-bottom:16px"><header class="card-h"><h3>Badges</h3><span class="sub">${g.badges.filter((b) => b.earned).length} of ${g.badges.length} unlocked</span></header>
    <div class="badges">${g.badges.map((b) => `<div class="badge ${b.earned ? 'earned' : ''}"><div class="ic">${b.icon}</div><div class="nm">${esc(b.name)}</div><div class="ds">${esc(b.desc)}</div>
      ${b.earned ? `<div class="when">Unlocked ${fmtDate(b.earnedAt)}</div>` : `<div class="mini-bar"><span style="width:${(b.progress * 100).toFixed(0)}%"></span></div><div class="faint" style="font-size:11px;margin-top:5px">${b.current}/${b.goal}</div>`}</div>`).join('')}</div>
  </section>
  <div class="insights">
    <section class="card"><header class="card-h"><h3>How XP works</h3><span class="sub">process over profit</span></header>
      <div class="note" style="margin-bottom:12px">XP never rewards P&L directly. A disciplined loser earns more than a lucky, oversized winner — because that's what builds a durable edge. XP is recalculated from your journal every time, so edits can't game it.</div>
      <div class="rules">${RULES.map(([k, v]) => `<div><span class="muted">${k}</span><b class="mono ${v.startsWith('−') ? 'neg' : 'gold'}">${v}</b></div>`).join('')}</div>
    </section>
    <section class="card"><header class="card-h"><h3>XP log</h3><span class="sub">${g.events.length} events</span></header>
      <div style="max-height:560px;overflow:auto">${xpFeed(g.events.slice(0, 200))}</div></section>
  </div>`;
}

// ---------- Settings ----------
function pageSettings() {
  const s = S.state.settings; const k = S.kite;
  const port = location.port || '80';
  const redirectUrl = `${location.protocol}//${location.hostname}:${port}/api/kite/callback`;
  let kiteBody;
  if (k.mock) {
    kiteBody = `<div class="note">Demo mode is on (<code>KITE_MOCK=1</code>). Prices are simulated random walks — great for trying the app, never for real decisions. Set <code>KITE_MOCK=0</code> in <code>.env</code> and restart to use your real Kite account.</div>`;
  } else if (!k.configured) {
    kiteBody = `<ol class="prose" style="padding-left:18px;margin:0">
      <li>Create an app at <a class="link" href="https://developers.kite.trade" target="_blank" rel="noopener">developers.kite.trade</a>. Live quotes need the paid <b>Kite Connect</b> plan.</li>
      <li>Set the app's <b>Redirect URL</b> to <code class="mono">${esc(redirectUrl)}</code></li>
      <li>Copy <code>.env.example</code> to <code>.env</code>, fill <code>KITE_API_KEY</code> and <code>KITE_API_SECRET</code>, then restart <code>npm start</code>.</li>
      <li>Come back here and press <b>Connect</b>. Kite logins expire every morning (~6 AM), so reconnect once a day.</li></ol>
      <div class="note" style="margin-top:12px">Until then everything works in manual mode — type your prices in.</div>`;
  } else if (!k.connected) {
    kiteBody = `<p class="muted" style="margin-top:0">API key found. Log in to Kite to start a session for today.</p><a class="btn primary" href="/api/kite/login">Connect to Kite</a>
      <p class="faint" style="font-size:12px">Redirect URL registered in your Kite app must be <code class="mono">${esc(redirectUrl)}</code></p>`;
  } else {
    kiteBody = `<div class="stat-line"><span class="muted">Logged in as</span><b>${esc(k.user?.name)} (${esc(k.user?.id)})</b></div>
      <div class="stat-line"><span class="muted">Session expires</span><b>${fmtDT(k.expiresAt)}</b></div>
      <div class="row" style="margin-top:10px"><button class="btn danger" data-action="kite-logout">Disconnect</button></div>`;
  }
  return `<div class="page-h"><div><h1>Settings</h1><p>Your rules are what the game holds you to.</p></div></div>
  <div class="insights">
    <form class="card stack" id="settings-form">
      <header class="card-h" style="margin:0"><h3>Profile & risk rules</h3></header>
      <div class="field"><label>Display name</label><input class="input" name="displayName" value="${esc(s.displayName)}"></div>
      <div class="grid-2">
        <div class="field"><label>Trading capital (₹)</label><input class="input num" type="number" name="capital" value="${s.capital}" min="0"></div>
        <div class="field"><label>Max risk per trade (₹)</label><input class="input num" type="number" name="maxRiskPerTrade" value="${s.maxRiskPerTrade}" min="0"><span class="hint">${s.capital ? pct(s.maxRiskPerTrade / s.capital, 2) + ' of capital' : ''}</span></div>
        <div class="field"><label>Max new trades per day</label><input class="input num" type="number" name="maxTradesPerDay" value="${s.maxTradesPerDay}" min="1"></div>
        <div class="field"><label>Revenge-trade window (minutes)</label><input class="input num" type="number" name="revengeWindowMins" value="${s.revengeWindowMins}" min="0"><span class="hint">New entry this soon after a loss = −15 XP</span></div>
      </div>
      <div class="row"><button class="btn primary" type="submit">Save settings</button><span class="muted" id="settings-msg"></span></div>
    </form>
    <section class="card"><header class="card-h"><h3>Zerodha Kite Connect</h3>${k.mock ? '<span class="pill gold">demo</span>' : k.connected ? '<span class="pill green">connected</span>' : '<span class="pill red">not connected</span>'}</header>${kiteBody}</section>
    <section class="card"><header class="card-h"><h3>Your data</h3></header>
      <p class="muted" style="margin-top:0">Everything lives in <code>data/journal.json</code> on this computer (a backup copy is made on every start). Export regularly.</p>
      <div class="row wrap"><a class="btn" href="/api/export" download>⬇ Export JSON</a><label class="btn">⬆ Import JSON<input type="file" accept="application/json" id="import-file" hidden></label></div>
      <p class="faint" style="font-size:12px">Import replaces the whole journal.</p>
    </section>
  </div>`;
}

function bindSettings() {
  $('#import-file')?.addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const ok = await confirmBox('Replace your journal?', `Importing <b>${esc(file.name)}</b> will replace all current trades and reviews. Export first if unsure.`, 'Replace journal');
    if (!ok) return;
    try { await api('/api/import', { method: 'POST', body: JSON.parse(await file.text()) }); toast('Journal imported'); await reload(); } catch (err) { toast(err.message, 'err'); }
  });
}

// =====================================================================
// Modals
// =====================================================================
function openModal(html, { dismissable = false } = {}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="overlay" ${dismissable ? 'data-dismiss' : ''}>${html}</div>`;
  return root.firstElementChild.firstElementChild;
}
function closeModal() { $('#modal-root').innerHTML = ''; }

function confirmBox(title, body, okLabel = 'Confirm') {
  return new Promise((resolve) => {
    const el = openModal(`<div class="modal narrow"><div class="modal-h"><h2>${title}</h2></div><div class="modal-b"><p class="muted" style="margin:0;line-height:1.6">${body}</p></div>
      <div class="modal-f"><button class="btn ghost" data-r="0">Cancel</button><button class="btn danger" data-r="1">${okLabel}</button></div></div>`, { dismissable: true });
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-r]'); if (b) { closeModal(); resolve(b.dataset.r === '1'); } });
  });
}

const radios = (name, opts, val, cls = '') => opts.map(([v, l, c]) => `<label><input type="radio" name="${name}" value="${esc(v)}" ${String(val) === String(v) ? 'checked' : ''}><span class="${c || cls}">${l}</span></label>`).join('');

// ---------- Trade form (new / edit) ----------
function openTradeForm(t = null, prefill = {}) {
  const v = { exchange: 'NSE', segment: 'EQ', side: 'LONG', ...prefill, ...(t || {}) };
  const live = S.kite.connected;
  const form = openModal(`
  <form id="trade-form" class="modal" autocomplete="off">
    <div class="modal-h"><h2>${t ? `Edit ${esc(t.symbol)}` : 'New trade'}</h2><button type="button" class="btn ghost sm" data-action="close-modal">✕</button></div>
    <div class="modal-b form-grid">
      <div class="stack">
        <div class="grid-3">
          <div class="field" style="grid-column:span 2"><label>Symbol</label>
            <div class="ac-wrap"><input class="input" name="symbol" value="${esc(v.symbol)}" placeholder="${live ? 'Search: RELIANCE, NIFTY fut, GOLDM…' : 'e.g. RELIANCE'}" required><div class="ac hidden"></div></div>
            <div class="hint" id="sym-hint">${live ? 'Type 2+ letters to search Kite instruments' : 'Manual mode — connect Kite in Settings for search & live prices'}</div></div>
          <div class="field"><label>Exchange</label><select class="input" name="exchange">${EXCHANGES.map((e) => `<option ${v.exchange === e ? 'selected' : ''}>${e}</option>`).join('')}</select></div>
        </div>
        <div class="row wrap" style="gap:16px;align-items:flex-end">
          <div class="field"><label>Direction</label><div class="seg">${radios('side', [['LONG', '▲ Long', 'long'], ['SHORT', '▼ Short', 'short']], v.side)}</div></div>
          <div class="field"><label>Segment</label><div class="seg">${radios('segment', SEGMENTS.map(([a, b]) => [a, b]), v.segment)}</div></div>
        </div>
        <div class="grid-3">
          <div class="field"><label>Entry price</label><div class="input-row"><input class="input num" name="entryPrice" type="number" step="any" min="0" value="${v.entryPrice ?? ''}" required>
            <button type="button" class="btn live sm" data-action="live-price" data-field="entryPrice" ${live ? '' : 'disabled title="Connect Kite for live prices"'}>⚡ Live</button></div>
            <div class="live-tag" id="tag-entryPrice">${v.entrySource && v.entrySource !== 'manual' ? `⚡ ${v.entrySource === 'kite-fill' ? 'From Kite fill' : 'Live price'}` : ''}</div></div>
          <div class="field"><label>Quantity (units)</label><input class="input num" name="qty" type="number" step="any" min="0" value="${v.qty ?? ''}" required><div class="hint" id="lot-hint">${v.lotSize > 1 ? `1 lot = ${v.lotSize}` : ''}</div></div>
          <div class="field"><label>Entry time</label><input class="input" name="entryTime" type="datetime-local" value="${toLocalInput(v.entryTime)}"></div>
        </div>
        <div class="grid-3">
          <div class="field"><label>Stop-loss</label><input class="input num" name="stopLoss" type="number" step="any" min="0" value="${v.stopLoss ?? ''}"></div>
          <div class="field"><label>Target</label><input class="input num" name="target" type="number" step="any" min="0" value="${v.target ?? ''}"></div>
          <div class="field"><label>Setup</label><input class="input" name="setup" list="setup-list" value="${esc(v.setup)}" placeholder="Breakout"><datalist id="setup-list">${setupOptions().map((s) => `<option value="${esc(s)}">`).join('')}</datalist></div>
        </div>
        ${t ? `<label class="row hidden" id="correction-row" style="font-size:12.5px;color:var(--muted)"><input type="checkbox" name="correction"> This fixes a typo in my original stop (not a stop move)</label>` : ''}
        <div class="field"><label>Thesis — why this trade, why now, what invalidates it?</label><textarea class="input" name="thesis" placeholder="Breaking a 3-month range on 2× volume, sector flows turning positive. Invalid on a close back inside the range.">${esc(v.thesis)}</textarea></div>
        <div class="field"><label>How are you feeling?</label><div class="chips">${radios('emotionEntry', EMO_IN.map((e) => [e, e]), v.emotionEntry)}</div></div>
        <div class="grid-2">
          <div class="field"><label>Confidence</label><div class="seg">${radios('confidence', [1, 2, 3, 4, 5].map((n) => [n, n]), v.confidence)}</div></div>
          <div class="field"><label>Chart link (optional)</label><input class="input" name="screenshotUrl" value="${esc(v.screenshotUrl)}" placeholder="TradingView snapshot URL"></div>
        </div>
        <div class="err" id="form-err"></div>
      </div>
      <aside class="side-panel" id="trade-preview"></aside>
    </div>
    <div class="modal-f"><button type="button" class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">${t ? 'Save changes' : 'Log trade'}</button></div>
  </form>`);
  form.dataset.entrySource = v.entrySource || 'manual';
  if (v.lotSize) form.dataset.lot = v.lotSize;
  form._base = t;
  bindTradeForm(form);
  renderTradePreview(form);
  setTimeout(() => (t ? form.thesis : form.symbol).focus(), 30);
}

function draftFromTradeForm(form) {
  const base = form._base; const fd = new FormData(form); const g = (k) => fd.get(k);
  const stop = num(g('stopLoss'));
  const d = {
    ...(base || {}),
    symbol: String(g('symbol') || '').trim().toUpperCase(), exchange: g('exchange'), segment: g('segment') || 'EQ', side: g('side') || 'LONG',
    qty: num(g('qty')), entryPrice: num(g('entryPrice')), stopLoss: stop, target: num(g('target')),
    setup: g('setup') || '', thesis: g('thesis') || '', emotionEntry: g('emotionEntry') || '', confidence: num(g('confidence')),
    entryTime: fromLocalInput(g('entryTime')), screenshotUrl: g('screenshotUrl') || '', lotSize: num(form.dataset.lot),
    entrySource: form.dataset.entrySource || 'manual',
  };
  if (!base) { d.initialStop = stop; d.stopSetAtEntry = stop != null; d.status = 'OPEN'; d.id = '__draft'; } else if (form.correction?.checked || base.initialStop == null) d.initialStop = stop;
  return d;
}

function renderTradePreview(form) {
  const d = draftFromTradeForm(form); const base = form._base;
  const st = S.state.settings; const m = metrics(d);
  const others = S.state.trades.filter((x) => x.id !== d.id);
  const sameDay = d.entryTime ? others.filter((x) => dayKey(x.entryTime) === dayKey(d.entryTime) && new Date(x.entryTime) <= new Date(d.entryTime)).length : 0;
  const checks = entryChecks(d, { settings: st, trades: others, dayIndex: sameDay + 1 });
  const xp = sum(checks.map((c) => c.xp));
  const lot = d.lotSize > 1 ? d.lotSize : 1;
  const maxQty = m.riskPerUnit > 0 ? Math.floor(st.maxRiskPerTrade / m.riskPerUnit / lot) * lot : null;
  const over = m.riskAmt != null && m.riskAmt > st.maxRiskPerTrade * 1.05;
  const badStop = d.initialStop != null && d.entryPrice && ((d.side === 'LONG' && d.initialStop >= d.entryPrice) || (d.side === 'SHORT' && d.initialStop <= d.entryPrice));
  // Stop movement warning (edit mode)
  let stopNote = '';
  if (base && base.stopLoss != null && d.stopLoss != null && d.stopLoss !== base.stopLoss) {
    const widen = d.side === 'SHORT' ? d.stopLoss > base.stopLoss : d.stopLoss < base.stopLoss;
    $('#correction-row')?.classList.remove('hidden');
    stopNote = form.correction?.checked ? '<div class="note">Treating this as a typo fix — your initial risk will be recalculated.</div>'
      : widen ? `<div class="warn">Widening the stop ${price(base.stopLoss)} → ${price(d.stopLoss)} costs −15 XP when the trade closes.</div>`
        : `<div class="note">Tightening/trailing the stop ${price(base.stopLoss)} → ${price(d.stopLoss)} — no penalty. 👍</div>`;
  } else $('#correction-row')?.classList.add('hidden');

  paint($('#trade-preview', form), `
    <h4>Pre-trade check</h4>
    <div class="stat-line"><span class="muted">Position value</span><b>${m.value ? money(m.value, { dp: 0 }) : '—'}</b></div>
    <div class="stat-line"><span class="muted">Of capital</span><b>${m.value && st.capital ? pct(m.value / st.capital) : '—'}</b></div>
    <div class="stat-line"><span class="muted">Risk to stop</span><b class="${over ? 'neg' : ''}">${m.riskAmt != null && d.qty ? money(m.riskAmt, { dp: 0 }) : '—'}${m.riskAmt != null && st.capital ? ` <span class="faint">(${pct(m.riskAmt / st.capital, 2)})</span>` : ''}</b></div>
    <div class="stat-line"><span class="muted">Reward : risk</span><b>${m.plannedRR != null ? `1 : ${m.plannedRR.toFixed(2)}` : '—'}</b></div>
    <div class="stat-line"><span class="muted">Max qty @ ₹${nf0.format(st.maxRiskPerTrade)} risk</span><b>${maxQty != null ? nf0.format(maxQty) : '—'}</b></div>
    ${maxQty ? `<button type="button" class="btn sm" style="width:100%;margin:6px 0 4px" data-action="size-from-risk" data-qty="${maxQty}">Size position to ₹${nf0.format(st.maxRiskPerTrade)} risk</button>` : ''}
    ${badStop ? `<div class="warn" style="margin-top:8px">Stop must be ${d.side === 'LONG' ? 'below' : 'above'} entry for a ${d.side.toLowerCase()}.</div>` : ''}
    ${over ? `<div class="warn" style="margin-top:8px">Risk is over your ₹${nf0.format(st.maxRiskPerTrade)} limit (−20 XP).</div>` : ''}
    ${stopNote ? `<div style="margin-top:8px">${stopNote}</div>` : ''}
    <h4 style="margin-top:16px">XP for this entry</h4>
    <div class="checklist">${checks.filter((c) => c.xp || c.id === 'revenge' || c.id === 'overtrade').map((c) => `<div class="check ${c.xp > 0 ? 'ok' : c.xp < 0 ? 'bad' : c.ok ? 'ok' : ''}"><span class="ic">${c.xp < 0 ? '✕' : c.ok ? '✓' : ''}</span><span class="lb">${esc(c.label)}</span>${xpPill(c.xp)}</div>`).join('')}
      ${checks.filter((c) => !c.xp && !c.ok && !['revenge', 'overtrade', 'logged'].includes(c.id)).map((c) => `<div class="check"><span class="ic">○</span><span class="lb">${esc(c.label)}</span></div>`).join('')}</div>
    <div class="xp-total ${xp < 0 ? 'neg' : ''}"><span>${base ? 'Entry XP' : 'You\'ll earn'}</span><b>${xp > 0 ? '+' : ''}${xp} XP</b></div>`);
}

// Only touch the DOM when the content changed, so a click that starts while a blur
// triggers a re-render still lands on the same button.
function paint(el, html) { if (el._html !== html) { el.innerHTML = html; el._html = html; } }

function bindTradeForm(form) {
  const rerender = () => renderTradePreview(form);
  form.addEventListener('input', (e) => {
    if (e.target.name === 'entryPrice' && e.isTrusted) { form.dataset.entrySource = 'manual'; $('#tag-entryPrice').textContent = ''; }
    rerender();
  });
  form.addEventListener('change', (e) => {
    if (e.target.name === 'exchange') { setRadio(form, 'segment', guessSegment(form.exchange.value, form.symbol.value.toUpperCase())); showSymbolQuote(form); }
    rerender();
  });
  form.symbol.addEventListener('change', () => { setRadio(form, 'segment', guessSegment(form.exchange.value, form.symbol.value.toUpperCase())); showSymbolQuote(form); rerender(); });
  bindAutocomplete(form, rerender);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = draftFromTradeForm(form); const base = form._base;
    const body = {
      symbol: d.symbol, exchange: d.exchange, segment: d.segment, side: d.side, qty: d.qty, entryPrice: d.entryPrice,
      stopLoss: d.stopLoss, target: d.target, setup: d.setup, thesis: d.thesis, emotionEntry: d.emotionEntry, confidence: d.confidence,
      entryTime: d.entryTime, screenshotUrl: d.screenshotUrl, lotSize: d.lotSize, entrySource: d.entrySource,
    };
    if (base && form.correction?.checked) body.correction = true;
    if (base && d.stopLoss === base.stopLoss) delete body.stopLoss;
    const btn = form.querySelector('[type=submit]'); btn.disabled = true;
    try {
      await api(base ? `/api/trades/${base.id}` : '/api/trades', { method: base ? 'PUT' : 'POST', body });
      closeModal();
      await reload({ celebrate: true });
      pollQuotes();
    } catch (err) { $('#form-err', form).textContent = err.message; btn.disabled = false; }
  });
}

function setRadio(form, name, value) { const r = form.querySelector(`input[name="${name}"][value="${value}"]`); if (r) r.checked = true; }

async function showSymbolQuote(form) {
  const hint = $('#sym-hint', form);
  if (!S.kite.connected || !form.symbol.value.trim()) return;
  const k = `${form.exchange.value}:${form.symbol.value.trim().toUpperCase()}`;
  try {
    const { quotes } = await api('/api/kite/quote?i=' + encodeURIComponent(k));
    const q = quotes[k];
    hint.innerHTML = q ? `LTP <b class="mono">${price(q.last)}</b> <span class="${cls(q.changePct)}">${q.changePct == null ? '' : (q.changePct > 0 ? '+' : '') + (q.changePct * 100).toFixed(2) + '%'}</span>${S.kite.mock ? ' <span class="faint">(demo)</span>' : ''}` : `<span class="neg">No quote for ${esc(k)} — check symbol/exchange</span>`;
  } catch (e) { hint.innerHTML = `<span class="neg">${esc(e.message)}</span>`; }
}

function bindAutocomplete(form, after) {
  const inp = form.symbol; const box = inp.parentElement.querySelector('.ac');
  let timer; let items = []; let active = -1;
  const hide = () => box.classList.add('hidden');
  const draw = () => {
    if (!items.length) return hide();
    box.innerHTML = items.map((it, i) => `<div class="ac-item ${i === active ? 'active' : ''}" data-i="${i}"><span><b>${esc(it.symbol)}</b> <span class="exch">${it.exchange}</span></span><span class="n">${esc(it.name || '')}${it.expiry ? ' · ' + esc(it.expiry) : ''}${it.lotSize > 1 ? ' · lot ' + it.lotSize : ''}</span></div>`).join('');
    box.classList.remove('hidden');
  };
  const pick = (it) => {
    if (!it) return;
    inp.value = it.symbol; form.exchange.value = it.exchange; setRadio(form, 'segment', it.segment);
    form.dataset.lot = it.lotSize > 1 ? it.lotSize : '';
    $('#lot-hint', form).textContent = it.lotSize > 1 ? `1 lot = ${it.lotSize}` : '';
    hide(); showSymbolQuote(form); after();
  };
  inp.addEventListener('input', () => {
    clearTimeout(timer);
    if (!S.kite.connected) return;
    const q = inp.value.trim();
    if (q.length < 2) return hide();
    timer = setTimeout(async () => {
      try { items = (await api('/api/kite/search?q=' + encodeURIComponent(q))).results; active = items.length ? 0 : -1; draw(); } catch (e) { $('#sym-hint', form).innerHTML = `<span class="neg">${esc(e.message)}</span>`; hide(); }
    }, 180);
  });
  inp.addEventListener('keydown', (e) => {
    if (box.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { pick(items[active]); e.preventDefault(); }
    else if (e.key === 'Escape') { hide(); e.stopPropagation(); }
  });
  inp.addEventListener('blur', () => setTimeout(hide, 150));
  box.addEventListener('mousedown', (e) => { const el = e.target.closest('.ac-item'); if (el) { e.preventDefault(); pick(items[+el.dataset.i]); } });
}

async function fillLivePrice(form, field) {
  const sym = (form.symbol?.value || form.dataset.symbol || '').trim().toUpperCase();
  const ex = form.exchange?.value || form.dataset.exchange;
  const tag = $(`#tag-${field}`, form);
  if (!sym) { tag.innerHTML = '<span class="neg">Enter a symbol first</span>'; return; }
  const k = `${ex}:${sym}`;
  tag.textContent = 'Fetching…';
  try {
    const { quotes } = await api('/api/kite/quote?i=' + encodeURIComponent(k));
    const q = quotes[k];
    if (!q) throw new Error(`No quote for ${k}`);
    form[field].value = q.last;
    form.dataset[field === 'entryPrice' ? 'entrySource' : 'exitSource'] = 'live';
    tag.textContent = `⚡ Live ${fmtTime(q.at || new Date().toISOString())}${S.kite.mock ? ' (demo)' : ''}`;
    form.dispatchEvent(new Event('change'));
  } catch (e) { tag.innerHTML = `<span class="neg">${esc(e.message)}</span>`; }
}

// ---------- Close trade ----------
function openCloseForm(t, prefill = {}) {
  const live = S.kite.connected;
  const form = openModal(`
  <form id="close-form" class="modal" autocomplete="off">
    <div class="modal-h"><h2>Close ${esc(t.symbol)} <span class="side ${t.side}">${t.side}</span> <span class="muted" style="font-weight:500;font-size:13px">· ${nf0.format(t.qty)} @ ${price(t.entryPrice)}</span></h2><button type="button" class="btn ghost sm" data-action="close-modal">✕</button></div>
    <div class="modal-b form-grid">
      <div class="stack">
        <div class="grid-3">
          <div class="field"><label>Exit price</label><div class="input-row"><input class="input num" name="exitPrice" type="number" step="any" min="0" value="${prefill.exitPrice ?? ''}" required>
            <button type="button" class="btn live sm" data-action="live-price" data-field="exitPrice" ${live ? '' : 'disabled title="Connect Kite for live prices"'}>⚡ Live</button></div>
            <div class="live-tag" id="tag-exitPrice">${prefill.exitSource === 'kite-fill' ? '⚡ From Kite fill' : ''}</div></div>
          <div class="field"><label>Exit time</label><input class="input" name="exitTime" type="datetime-local" value="${toLocalInput(prefill.exitTime)}"></div>
          <div class="field"><label>Charges (₹)</label><input class="input num" name="charges" type="number" step="any" min="0" value="${t.charges ?? ''}" placeholder="0"></div>
        </div>
        <div class="field"><label>Why did you exit?</label><div class="chips">${radios('exitReason', EXIT_REASONS.map((r) => [r, r]), t.exitReason)}</div></div>
        <div class="field"><label>Did you follow your plan?</label><div class="seg">${radios('followedPlan', [['yes', '✓ Yes, as planned', 'long'], ['no', '✕ No, I deviated', 'short']], t.followedPlan === true ? 'yes' : t.followedPlan === false ? 'no' : '')}</div></div>
        <div class="field"><label>How do you feel now?</label><div class="chips">${radios('emotionExit', EMO_OUT.map((e) => [e, e]), t.emotionExit)}</div></div>
        <div class="field"><label>Lesson — what will you repeat or change?</label><textarea class="input" name="lessons" placeholder="Held through the pullback because the thesis was intact — good. Exited on target instead of trailing; next time trail half.">${esc(t.lessons)}</textarea></div>
        <div class="field"><label>Execution grade</label>${stars('rating', t.rating)}</div>
        <div class="err" id="form-err"></div>
      </div>
      <aside class="side-panel" id="close-preview"></aside>
    </div>
    <div class="modal-f"><button type="button" class="btn ghost" data-action="close-modal">Cancel</button><button class="btn green" type="submit">Close trade</button></div>
  </form>`);
  form.dataset.symbol = t.symbol; form.dataset.exchange = t.exchange;
  form.dataset.exitSource = prefill.exitSource || 'manual';
  const draft = () => {
    const fd = new FormData(form); const fp = fd.get('followedPlan');
    return { ...t, status: 'CLOSED', exitPrice: num(fd.get('exitPrice')), exitTime: fromLocalInput(fd.get('exitTime')), charges: num(fd.get('charges')),
      exitReason: fd.get('exitReason') || '', followedPlan: fp === 'yes' ? true : fp === 'no' ? false : null, emotionExit: fd.get('emotionExit') || '',
      lessons: fd.get('lessons') || '', rating: num(fd.get('rating')), exitSource: form.dataset.exitSource };
  };
  const preview = () => {
    const d = draft(); const m = metrics(d); const checks = d.exitPrice ? exitChecks(d, m) : [];
    const xp = sum(checks.map((c) => c.xp));
    const entryXp = sum((S.game.perTrade[t.id]?.entry || []).map((c) => c.xp));
    paint($('#close-preview', form), `
      <h4>Result</h4>
      <div class="stat-line"><span class="muted">Net P&L</span><b class="${cls(m.net)}">${m.net == null ? '—' : money(m.net, { sign: true })}</b></div>
      <div class="stat-line"><span class="muted">R multiple</span><b class="${cls(m.r)}">${rfmt(m.r)}</b></div>
      <div class="stat-line"><span class="muted">Return on position</span><b class="${cls(m.net)}">${m.net != null && m.value ? pct(m.net / m.value, 2) : '—'}</b></div>
      <div class="stat-line"><span class="muted">Held</span><b>${d.exitTime ? hold(m.holdDays) : '—'}</b></div>
      ${t.stopWidenCount ? `<div class="warn" style="margin-top:6px">Stop was widened ${t.stopWidenCount}× on this trade.</div>` : ''}
      <h4 style="margin-top:16px">XP for this exit</h4>
      ${d.exitPrice ? `<div class="checklist">${checks.map((c) => `<div class="check ${c.xp > 0 ? 'ok' : c.xp < 0 ? 'bad' : c.ok ? 'ok' : ''}"><span class="ic">${c.xp < 0 ? '✕' : c.ok ? '✓' : '○'}</span><span class="lb">${esc(c.label)}</span>${xpPill(c.xp)}</div>`).join('')}</div>
      <div class="xp-total ${xp < 0 ? 'neg' : ''}"><span>Exit XP <span class="faint" style="font-weight:500">(entry earned ${entryXp > 0 ? '+' : ''}${entryXp})</span></span><b>${xp > 0 ? '+' : ''}${xp} XP</b></div>` : '<div class="empty-sm">Enter an exit price.</div>'}
      <p class="faint" style="font-size:11.5px;margin-bottom:0">Profit itself earns nothing — honest journaling and respecting your stop do.</p>`);
  };
  form.addEventListener('input', (e) => { if (e.target.name === 'exitPrice' && e.isTrusted) { form.dataset.exitSource = 'manual'; $('#tag-exitPrice').textContent = ''; } preview(); });
  form.addEventListener('change', preview);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = draft();
    const btn = form.querySelector('[type=submit]'); btn.disabled = true;
    try {
      await api(`/api/trades/${t.id}`, { method: 'PUT', body: { status: 'CLOSED', exitPrice: d.exitPrice, exitTime: d.exitTime, charges: d.charges, exitReason: d.exitReason, followedPlan: d.followedPlan, emotionExit: d.emotionExit, lessons: d.lessons, rating: d.rating, exitSource: d.exitSource } });
      closeModal();
      await reload({ celebrate: true });
    } catch (err) { $('#form-err', form).textContent = err.message; btn.disabled = false; }
  });
  preview();
  setTimeout(() => form.exitPrice.focus(), 30);
}

// ---------- Drawer ----------
function renderDrawer() {
  const t = S.state.trades.find((x) => x.id === S.drawerId);
  if (!t) { S.drawerId = null; $('#drawer-root').innerHTML = ''; return; }
  const ltp = t.status === 'OPEN' ? ltpFor(t) : null; const m = metrics(t, ltp);
  const pt = S.game.perTrade[t.id] || { entry: [], exit: [] };
  const x = S.game.tradeXp[t.id] || 0;
  const item = (k, v) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const checkList = (items) => items.filter((c) => c.xp || c.disc).map((c) => `<div class="check ${c.xp > 0 || (c.ok && c.disc) ? 'ok' : c.xp < 0 || (c.disc && !c.ok) ? 'bad' : ''}"><span class="ic">${c.ok ? '✓' : '✕'}</span><span class="lb">${esc(c.label)}</span>${xpPill(c.xp)}</div>`).join('');
  $('#drawer-root').innerHTML = `<div class="drawer-ov" data-action="close-drawer"></div><aside class="drawer">
    <div class="sec row" style="justify-content:space-between">
      <div><div class="row"><span class="sym" style="font-size:20px">${esc(t.symbol)}</span><span class="exch">${t.exchange}</span><span class="side ${t.side}">${t.side}</span>${t.status === 'OPEN' ? '<span class="pill violet">open</span>' : pt.clean ? '<span class="pill green">clean trade</span>' : '<span class="pill red">rule broken</span>'}</div>
        <div class="muted" style="margin-top:4px;font-size:12.5px">${fmtDT(t.entryTime)}${t.exitTime && t.status === 'CLOSED' ? ' → ' + fmtDT(t.exitTime) : ''} · ${hold(m.holdDays)}</div></div>
      <button class="btn ghost sm" data-action="close-drawer">✕</button>
    </div>
    <div class="sec"><div class="row" style="justify-content:space-between;align-items:flex-end">
      <div><div class="label">${t.status === 'OPEN' ? 'Unrealised P&L' : 'Net P&L'}</div><div class="mono ${cls(m.net)}" style="font-size:28px;font-weight:700;margin-top:4px">${m.net == null ? '—' : money(m.net, { sign: true })}</div></div>
      <div style="text-align:right"><div class="mono ${cls(m.r)}" style="font-size:18px;font-weight:650">${rfmt(m.r)}</div>${xpPill(x)}</div></div></div>
    <div class="sec kv">
      ${item('Quantity', nf0.format(t.qty) + (t.lotSize > 1 ? ` <span class="faint">(${(t.qty / t.lotSize).toFixed(t.qty % t.lotSize ? 2 : 0)} lots)</span>` : ''))}
      ${item('Entry', price(t.entryPrice) + (t.entrySource !== 'manual' ? ' <span class="live-tag">⚡</span>' : ''))}
      ${item(t.status === 'OPEN' ? 'LTP' : 'Exit', t.status === 'OPEN' ? price(ltp) : price(t.exitPrice) + (t.exitSource && t.exitSource !== 'manual' ? ' <span class="live-tag">⚡</span>' : ''))}
      ${item('Stop (initial → now)', `${price(t.initialStop)} → ${price(t.stopLoss)}`)}
      ${item('Target', price(t.target))}
      ${item('Planned R:R', m.plannedRR != null ? '1 : ' + m.plannedRR.toFixed(2) : '—')}
      ${item('Initial risk', m.riskAmt != null ? money(m.riskAmt, { dp: 0 }) : '—')}
      ${item('Charges', t.charges ? money(t.charges) : '—')}
      ${item('Setup', esc(t.setup || '—'))}
      ${item('Segment', esc(Object.fromEntries(SEGMENTS)[t.segment] || t.segment))}
      ${item('Emotion in → out', `${esc(t.emotionEntry || '—')} → ${esc(t.emotionExit || '—')}`)}
      ${item('Confidence · grade', `${t.confidence ?? '—'}/5 · ${t.rating ? '★'.repeat(t.rating) : '—'}`)}
    </div>
    ${t.thesis ? `<div class="sec"><div class="label">Thesis</div><div class="prose" style="margin-top:6px">${esc(t.thesis)}</div></div>` : ''}
    ${t.lessons ? `<div class="sec"><div class="label">Lesson</div><div class="prose" style="margin-top:6px">${esc(t.lessons)}</div></div>` : ''}
    ${t.screenshotUrl ? `<div class="sec"><a class="link" href="${esc(t.screenshotUrl)}" target="_blank" rel="noopener">📈 Open chart ↗</a></div>` : ''}
    ${t.stopHistory?.length ? `<div class="sec"><div class="label">Stop moves</div>${t.stopHistory.map((h) => `<div class="stat-line"><span class="muted">${fmtDT(h.at)}</span><b>${price(h.from)} → ${price(h.to)}</b></div>`).join('')}</div>` : ''}
    <div class="sec"><div class="label">XP breakdown</div><div class="checklist" style="margin-top:8px">${checkList(pt.entry)}${checkList(pt.exit)}</div></div>
    <div class="sec row wrap">
      ${t.status === 'OPEN' ? `<button class="btn green" data-action="close-trade" data-id="${t.id}">Close trade</button>` : `<button class="btn" data-action="reopen-trade" data-id="${t.id}">Reopen</button>`}
      <button class="btn" data-action="edit-trade" data-id="${t.id}">Edit</button>
      ${t.status === 'CLOSED' ? `<button class="btn" data-action="edit-exit" data-id="${t.id}">Edit exit</button>` : ''}
      <span style="flex:1"></span><button class="btn danger" data-action="delete-trade" data-id="${t.id}">Delete</button>
    </div>
  </aside>`;
}

// ---------- Kite fills ----------
async function openFills() {
  const el = openModal(`<div class="modal narrow" style="width:min(760px,100%)"><div class="modal-h"><h2>⚡ Today's Kite fills</h2><button class="btn ghost sm" data-action="close-modal">✕</button></div><div class="modal-b" id="fills-body"><div class="muted">Loading…</div></div></div>`, { dismissable: true });
  try {
    const { fills } = await api('/api/kite/fills');
    const open = S.state.trades.filter((t) => t.status === 'OPEN');
    el._fills = fills;
    $('#fills-body').innerHTML = fills.length ? `<p class="muted" style="margin-top:0">Turn an executed order into a journal entry, or use it as the exit of a matching open trade. ${S.kite.mock ? '<b class="gold">(demo data)</b>' : ''}</p>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th class="r">Qty</th><th class="r">Avg price</th><th></th></tr></thead><tbody>
      ${fills.map((f, i) => {
      const match = open.find((t) => t.symbol === f.symbol && t.exchange === f.exchange && ((t.side === 'LONG' && f.side === 'SELL') || (t.side === 'SHORT' && f.side === 'BUY')));
      return `<tr><td class="muted">${fmtTime(f.time)}</td><td><span class="sym">${esc(f.symbol)}</span><span class="exch">${f.exchange}</span></td><td><span class="side ${f.side === 'BUY' ? 'LONG' : 'SHORT'}">${f.side}</span></td><td class="r num">${nf0.format(f.qty)}</td><td class="r num">${price(f.price)}</td>
        <td class="r">${match ? `<button class="btn sm green" data-action="fill-exit" data-i="${i}" data-id="${match.id}">Use as exit</button>` : ''} <button class="btn sm" data-action="fill-entry" data-i="${i}">Log entry</button></td></tr>`;
    }).join('')}</tbody></table></div>` : '<div class="empty-sm">No executed trades on Kite today.</div>';
    S._fills = fills;
  } catch (e) { $('#fills-body').innerHTML = `<div class="warn">${esc(e.message)}</div>`; }
}

// =====================================================================
// Celebrations
// =====================================================================
function toast(html, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`; el.innerHTML = html;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, kind === 'badge-t' ? 6000 : 4500);
}

function celebrateDiff(prev, next) {
  const before = new Set(prev.events.map((e) => e.key + e.xp));
  const fresh = next.events.filter((e) => !before.has(e.key + e.xp));
  const delta = next.xp - prev.xp;
  if (fresh.length || delta) {
    toast(`<div class="t-h"><span class="t-xp ${delta < 0 ? 'neg' : 'gold'}">${delta > 0 ? '+' : ''}${delta} XP</span><span>${delta >= 0 ? 'Nice process.' : 'Rules broken — XP lost.'}</span></div>
      ${fresh.length ? `<ul>${fresh.slice(0, 7).map((e) => `<li><span>${esc(e.label)}</span>${xpPill(e.xp)}</li>`).join('')}</ul>` : ''}`);
  }
  const had = new Set(prev.badges.filter((b) => b.earned).map((b) => b.id));
  const newBadges = next.badges.filter((b) => b.earned && !had.has(b.id));
  newBadges.forEach((b, i) => setTimeout(() => toast(`<div class="t-h"><span style="font-size:28px">${b.icon}</span><div><div class="gold" style="font-size:11px;text-transform:uppercase;letter-spacing:.1em">Badge unlocked</div><div>${esc(b.name)}</div></div></div><div class="muted" style="font-size:12px;margin-top:4px">${esc(b.desc)}</div>`, 'badge-t'), 400 + i * 500));
  if (next.level.lvl > prev.level.lvl) setTimeout(() => levelUp(next.level), 300);
  else if (newBadges.length) confetti(80);
}

function levelUp(L) {
  confetti(200);
  const el = openModal(`<div class="modal narrow"><div class="levelup"><div class="muted" style="text-transform:uppercase;letter-spacing:.2em;font-size:12px">Level up</div>
    <div class="lv">${L.lvl}</div><h2>${esc(L.title)}</h2><p>Discipline compounds. ${nf0.format(L.next - L.xp)} XP to the next rank.</p>
    <button class="btn primary" data-action="close-modal" style="margin-top:10px">Keep going</button></div></div>`, { dismissable: true });
  el.querySelector('button').focus();
}

function confetti(count = 160) {
  const c = $('#confetti'); const ctx = c.getContext('2d'); const dpr = window.devicePixelRatio || 1;
  c.width = innerWidth * dpr; c.height = innerHeight * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const colors = ['#8b6cff', '#5ad1ff', '#fbbf24', '#22c55e', '#f4506b', '#ffffff'];
  const P = Array.from({ length: count }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 240, y: innerHeight * 0.38, vx: (Math.random() - 0.5) * 16, vy: -Math.random() * 15 - 4,
    w: Math.random() * 7 + 4, h: Math.random() * 4 + 3, c: colors[(Math.random() * colors.length) | 0], rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.35,
  }));
  const t0 = performance.now(); const DUR = 2800;
  const frame = (t) => {
    const el = t - t0; ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of P) {
      p.vy += 0.34; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.globalAlpha = Math.max(0, 1 - el / DUR);
      ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
    }
    if (el < DUR) requestAnimationFrame(frame); else ctx.clearRect(0, 0, innerWidth, innerHeight);
  };
  requestAnimationFrame(frame);
}

// =====================================================================
// Live quotes polling
// =====================================================================
let polling = false;
async function pollQuotes() {
  if (polling || !S.kite.connected || document.hidden || !S.state) return;
  const keys = [...new Set(S.state.trades.filter((t) => t.status === 'OPEN').map(tradeKey))];
  if (!keys.length) return;
  polling = true;
  try {
    const { quotes } = await api('/api/kite/quote?i=' + encodeURIComponent(keys.join(',')));
    S.flash = new Set(Object.keys(quotes).filter((k) => S.quotes[k]?.last !== quotes[k].last));
    Object.assign(S.quotes, quotes); S.quotesAt = new Date().toISOString();
    paintLive();
  } catch (e) {
    if (e.code === 'TOKEN') { await loadKite(); renderTop(); toast(esc(e.message), 'err'); }
  } finally { polling = false; }
}

function paintLive() {
  const op = $('#open-positions'); if (op) op.innerHTML = openPositionsInner();
  const k = $('#kpis'); if (k) k.innerHTML = kpiTiles();
  const ln = $('#live-note'); if (ln) ln.innerHTML = liveNote();
  const jb = $('#journal-body'); if (jb) jb.innerHTML = journalRows();
  if (S.drawerId) { const t = S.state.trades.find((x) => x.id === S.drawerId); if (t?.status === 'OPEN') renderDrawer(); }
}

// =====================================================================
// Actions
// =====================================================================
const findTrade = (id) => S.state.trades.find((t) => t.id === id);
const actions = {
  'new-trade': () => openTradeForm(),
  'close-modal': () => closeModal(),
  'open-drawer': (el) => { S.drawerId = el.dataset.id; renderDrawer(); },
  'close-drawer': () => { S.drawerId = null; $('#drawer-root').innerHTML = ''; },
  'close-trade': (el, e) => { e.stopPropagation(); openCloseForm(findTrade(el.dataset.id)); },
  'edit-trade': (el) => openTradeForm(findTrade(el.dataset.id)),
  'edit-exit': (el) => { const t = findTrade(el.dataset.id); openCloseForm(t, { exitPrice: t.exitPrice, exitTime: t.exitTime, exitSource: t.exitSource }); },
  'reopen-trade': async (el) => {
    if (!(await confirmBox('Reopen trade?', 'The exit will be cleared from the stats until you close it again. Exit notes are kept.', 'Reopen'))) return;
    try { await api(`/api/trades/${el.dataset.id}`, { method: 'PUT', body: { status: 'OPEN' } }); await reload({ celebrate: true }); } catch (e) { toast(esc(e.message), 'err'); }
  },
  'delete-trade': async (el) => {
    const t = findTrade(el.dataset.id);
    if (!(await confirmBox(`Delete ${esc(t.symbol)}?`, 'This removes the trade and all XP it earned. It cannot be undone (except from an export).', 'Delete'))) return;
    try { await api(`/api/trades/${t.id}`, { method: 'DELETE' }); S.drawerId = null; $('#drawer-root').innerHTML = ''; await reload({ celebrate: true }); } catch (e) { toast(esc(e.message), 'err'); }
  },
  'delete-review': async (el) => {
    if (!(await confirmBox('Delete review?', 'Its +40 XP will be removed too.', 'Delete'))) return;
    await api(`/api/reviews/${el.dataset.id}`, { method: 'DELETE' }); await reload({ celebrate: true });
  },
  'live-price': (el) => fillLivePrice(el.closest('form'), el.dataset.field),
  'size-from-risk': (el) => { const f = el.closest('form'); f.qty.value = el.dataset.qty; renderTradePreview(f); },
  'kite-logout': async () => { await api('/api/kite/logout', { method: 'POST' }); await loadKite(); render(); toast('Disconnected from Kite'); },
  'kite-fills': () => openFills(),
  'fill-entry': (el) => {
    const f = S._fills[+el.dataset.i]; closeModal();
    openTradeForm(null, { symbol: f.symbol, exchange: f.exchange, segment: guessSegment(f.exchange, f.symbol), side: f.side === 'BUY' ? 'LONG' : 'SHORT', qty: f.qty, entryPrice: f.price, entryTime: f.time, entrySource: 'kite-fill' });
  },
  'fill-exit': (el) => { const f = S._fills[+el.dataset.i]; closeModal(); openCloseForm(findTrade(el.dataset.id), { exitPrice: f.price, exitTime: f.time, exitSource: 'kite-fill' }); },
};

function bindGlobal() {
  document.addEventListener('click', (e) => {
    const ov = e.target.closest('.overlay');
    if (ov && e.target === ov && ov.hasAttribute('data-dismiss')) return closeModal();
    const el = e.target.closest('[data-action]');
    if (el && actions[el.dataset.action]) { if (el.tagName === 'BUTTON' && el.type !== 'submit') e.preventDefault(); actions[el.dataset.action](el, e); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if ($('#modal-root').innerHTML) { if ($('.overlay[data-dismiss]')) closeModal(); return; }
      if (S.drawerId) actions['close-drawer']();
    }
    if (e.key === 'n' && !e.ctrlKey && !e.metaKey && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !$('#modal-root').innerHTML) { e.preventDefault(); openTradeForm(); }
  });
  // Journal filters
  document.addEventListener('input', (e) => {
    const k = e.target.dataset?.filter; if (!k) return;
    S.f[k] = e.target.value; const jb = $('#journal-body'); if (jb) jb.innerHTML = journalRows();
  });
  // Page forms
  document.addEventListener('submit', async (e) => {
    const f = e.target;
    if (f.id === 'settings-form') {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(f));
      try { await api('/api/settings', { method: 'PUT', body: fd }); await reload({ celebrate: true }); toast('Settings saved'); } catch (err) { toast(esc(err.message), 'err'); }
    } else if (f.id === 'review-form') {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(f));
      try { await api('/api/reviews', { method: 'POST', body: { ...fd, weekStart: S.reviewWeek || weekStart() } }); await reload({ celebrate: true }); } catch (err) { $('#review-err').textContent = err.message; }
    }
  });
  window.addEventListener('hashchange', () => { S.drawerId = null; $('#drawer-root').innerHTML = ''; render(); window.scrollTo(0, 0); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollQuotes(); });
}

// =====================================================================
// Boot
// =====================================================================
async function boot() {
  bindGlobal();
  try {
    await Promise.all([loadKite(), (async () => { S.state = await api('/api/state'); })()]);
  } catch (e) {
    $('#main').innerHTML = `<div class="card empty"><div class="big">⚠️</div><h2>Can't reach the TradeQuest server</h2><p>${esc(e.message)}. Is <code>npm start</code> running?</p></div>`;
    return;
  }
  S.game = computeGame(S.state); S.stats = computeStats(S.state.trades);
  const { params } = route();
  if (params.get('kite') === 'ok') { toast(`<div class="t-h">⚡ Kite connected</div><div class="muted" style="font-size:12px;margin-top:4px">Live prices are on until ~6 AM tomorrow.</div>`); history.replaceState(null, '', '#/settings'); }
  if (params.get('kite') === 'error') { toast(`Kite login failed: ${esc(params.get('msg') || 'unknown error')}`, 'err'); history.replaceState(null, '', '#/settings'); }
  render();
  pollQuotes();
  setInterval(pollQuotes, 5000);
  setInterval(async () => { const before = S.kite.connected; await loadKite(); if (before !== S.kite.connected) render(); }, 60000);
}

boot();
