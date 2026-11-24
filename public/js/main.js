import { mountBreadthLive } from './breadthlive.js';
import { breadthActions, mountBreadthCard } from './breadth-ui.js';
import { pageSizer, mountSizer } from './sizer.js';
import { pageMarket, mountMarket } from './heatmap-page.js';
import { mountWealth, importLedgerFiles, setWealthScope } from './wealth.js';
import { mountVsTile, mountVsSection } from './vsindex.js';
import { computeGame, weekStart, isTrading, HORIZON_LABEL } from '../game.js';
import { computeStats } from '../stats.js';
import { handleDrawClick } from '../drawing.js';
import { initPractice, pagePractice, mountPractice, practiceAction, practiceKey } from '../practice.js';
import { $, $$, esc, nf0, fmtDT, MANTRAS, guessSegment } from './util.js';
import { S, api, reload, loadPortfolio, syncBadge, loadKite, findTrade } from './state.js';
import { openModal, closeModal, confirmBox, toast } from './ui.js';
import { pageDashboard, mountEquity } from './dashboard.js';
import { filteredTrades, selBar, pageJournal, journalRows } from './journal.js';
import { pageInsights } from './insights.js';
import { pageReview, bindReview } from './review.js';
import { pageAchievements } from './achievements.js';
import { pageSettings, bindSettings } from './settings.js';
import { openTradeForm, renderTradePreview, fillLivePrice, openCloseForm } from './forms.js';
import { theme, openBigChart, renderDrawer, openThesisReview } from './drawer.js';
import { openTradebookImport, applyImport, openLinkModal, openSync, openFills } from './importers.js';
import { pollQuotes } from './live.js';


// =====================================================================
// Rendering shell
// =====================================================================
export function route() {
  const [p, qs] = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('?');
  return { page: p || 'dashboard', params: new URLSearchParams(qs || '') };
}


// "⋯ More" floating button (phones): a bottom sheet with the extra tools.
const sheet = () => $('#more-sheet');
function closeSheet() { const s = sheet(); if (s) s.hidden = true; const f = $('#fab-more'); if (f) f.setAttribute('aria-expanded', 'false'); }
document.addEventListener('click', (e) => {
  if (e.target.closest('#fab-more')) { const s = sheet(); s.hidden = !s.hidden; e.target.closest('#fab-more').setAttribute('aria-expanded', String(!s.hidden)); return; }
  if (e.target.closest('[data-sheet-close]')) closeSheet();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

export function render() {
  if (!S.state) return;
  const { page } = route();
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === page));
  renderTop();
  const pages = { dashboard: pageDashboard, journal: pageJournal, insights: pageInsights, review: pageReview, practice: pagePractice, achievements: pageAchievements, size: pageSizer, market: pageMarket, settings: pageSettings };
  $('#main').innerHTML = (pages[page] || pageDashboard)();
  mountEquity();
  if (page === 'dashboard') { mountBreadthLive(); mountVsTile(); }
  if (page === 'practice') mountPractice();
  if (page === 'insights') { mountWealth(); mountVsSection(); }
  if (page === 'size') mountSizer();
  if (page === 'market') mountMarket();
  if (page === 'settings') mountBreadthCard();
  closeSheet();
  if (page === 'settings') bindSettings();
  if (page === 'review') bindReview();
  if (S.drawerId) renderDrawer();
  $('#sidebar-foot').innerHTML = `<div class="card" style="padding:14px"><div class="label">Today's mantra</div><div style="margin-top:6px;font-weight:600;line-height:1.45">${MANTRAS[new Date().getDate() % MANTRAS.length]}</div></div>`;
}


export function renderTop() {
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
    <span class="chip flame hide-m" title="Clean trades in a row (best ${g.streak.best})">🔥 ${g.streak.current} clean streak</span>
    <span class="chip hide-m" title="Rule checks passed over your last ${g.disciplineSample} closed trades">🧭 Discipline ${g.discipline == null ? '—' : g.discipline + '%'}</span>
    <div class="top-spacer"></div>
    ${kiteChip}
    <button class="btn ghost sm theme-btn" data-action="toggle-theme" title="Switch to ${document.documentElement.dataset.theme === 'light' ? 'night' : 'light'} mode">${document.documentElement.dataset.theme === 'light' ? '🌙' : '☀️'}</button>
    <button class="btn primary" data-action="new-trade" title="New trade">＋<span class="hide-m"> New trade</span></button>`;
}

export const actions = {
  'toggle-theme': () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    S.cv?.inst?.destroy(); S.cv = null;
    try { localStorage.setItem('tq-theme', next); } catch { /* private mode */ }
    render();
  },
  'new-trade': () => openTradeForm(),
  'close-modal': () => closeModal(),
  'open-drawer': (el) => { S.drawerId = el.dataset.id; renderDrawer(); },
  'close-drawer': () => { S.drawerId = null; S.cv?.inst?.destroy(); S.cv = null; $('#drawer-root').innerHTML = ''; },
  'chart-expand': (el) => openBigChart(findTrade(el.dataset.id)),
  'close-trade': async (el, e) => { e.stopPropagation(); const id = el.dataset.id; await reload(); openCloseForm(findTrade(id)); },
  'edit-trade': (el) => openTradeForm(findTrade(el.dataset.id)),
  'delete-exit': async (el) => {
    const t = findTrade(el.dataset.id);
    if (!(await confirmBox('Remove this exit?', 'The quantity goes back to open. Everything else on the trade stays.', 'Remove'))) return;
    try { await api(`/api/trades/${t.id}`, { method: 'PUT', body: { exits: (t.exits || []).filter((e) => e.id !== el.dataset.eid) } }); await reload({ celebrate: true }); } catch (e) { toast(esc(e.message), 'err'); }
  },
  'rename-remove': async (el) => {
    const list = (S.state.settings.symbolRenames || []).filter((r) => r.from !== el.dataset.from);
    try { await api('/api/settings', { method: 'PUT', body: { symbolRenames: list } }); await reload(); } catch (e) { toast(esc(e.message), 'err'); }
  },
  'delete-imported': async () => {
    const n = S.state.trades.filter((t) => t.imported).length;
    if (!(await confirmBox(`Delete ${n} imported trades?`, 'Every trade that came from a Zerodha tradebook import is removed. Trades you logged yourself stay. This can\'t be undone — export first if unsure.', 'Delete'))) return;
    try { const r = await api('/api/trades/delete-imported', { method: 'POST' }); await reload(); toast(`🗑 ${r.removed} imported trades deleted`); } catch (e) { toast(esc(e.message), 'err'); }
  },
  'reset-journal': async () => {
    if (!(await confirmBox('Reset the whole journal?', `All ${S.state.trades.length} trades, weekly reviews and links are deleted. Settings and Practice stay. This can\'t be undone — export first if unsure.`, 'Reset'))) return;
    if (!(await confirmBox('Really start from zero?', 'Last check: your journal will be empty.', 'Yes, reset'))) return;
    try { const r = await api('/api/journal/reset', { method: 'POST' }); await reload(); toast(`Journal reset · ${r.removed} trades removed`); } catch (e) { toast(esc(e.message), 'err'); }
  },
  'ledger-import': () => importLedgerFiles(),
  'ledger-clear': async () => {
    if (!(await confirmBox('Remove the imported ledger?', 'Money in/out and account fees disappear from Insights. Your trades are not touched.', 'Remove'))) return;
    try { await api('/api/ledger', { method: 'DELETE' }); await reload(); } catch (e) { toast(esc(e.message), 'err'); }
  },
  'acct-value-clear': async () => { try { await api('/api/settings', { method: 'PUT', body: { accountValue: null } }); await reload(); } catch (e) { toast(esc(e.message), 'err'); } },
  ...breadthActions,
  'install-app': async () => {
    const p = S.installPrompt; if (!p) return;
    p.prompt();
    const { outcome } = await p.userChoice.catch(() => ({}));
    S.installPrompt = null; render();
    if (outcome === 'accepted') toast('📲 Installing TradeQuest…');
  },
  'app-logout': async () => { await fetch('/api/auth/logout', { method: 'POST' }); location.reload(); },
  'edit-exit': (el) => { const t = findTrade(el.dataset.id); openCloseForm(t, { exitPrice: t.exitPrice, exitTime: t.exitTime, exitSource: t.exitSource, edit: true }); },
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
  'tradebook-import': () => openTradebookImport(),
  'link-selected': () => openLinkModal([...S.sel]),
  'clear-sel': () => { S.sel.clear(); render(); },
  'unlink-trade': async (el) => { await api(`/api/trades/${el.dataset.id}/group`, { method: 'DELETE' }); await reload(); toast('Leg unlinked'); },
  'delete-group': async (el) => {
    if (!(await confirmBox('Unlink all legs?', 'They go back to counting as separate trades in your stats. Nothing else changes.', 'Unlink all'))) return;
    await api(`/api/groups/${el.dataset.gid}`, { method: 'DELETE' }); await reload(); toast('Unlinked');
  },
  'rename-group': async (el) => {
    const g = (S.state.groups || []).find((x) => x.id === el.dataset.gid); if (!g) return;
    const form = openModal(`<form class="modal narrow"><div class="modal-h"><h2>Rename linked position</h2></div><div class="modal-b"><input class="input" name="name" value="${esc(g.name)}" maxlength="80"></div><div class="modal-f"><button type="button" class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`);
    form.addEventListener('submit', async (e) => { e.preventDefault(); await api(`/api/groups/${g.id}`, { method: 'PUT', body: { name: form.name.value } }); closeModal(); await reload(); });
    setTimeout(() => form.name.select(), 30);
  },
  'tradebook-apply': () => applyImport(),
  'kite-sync': () => openSync(),
  'sync-log': (el) => {
    const r = S.sync.rows[+el.dataset.i]; const diff = r.kiteQty - r.journalQty; closeModal();
    openTradeForm(null, { symbol: r.symbol, exchange: r.exchange, segment: guessSegment(r.exchange, r.symbol), side: diff > 0 ? 'LONG' : 'SHORT', qty: Math.abs(diff), entryPrice: r.avgPrice, entrySource: 'kite-fill', needDate: true });
  },
  'sync-close': (el) => {
    const r = S.sync.rows[+el.dataset.i]; closeModal();
    openCloseForm(r.trades[0], r.exitPrice ? { exitPrice: r.exitPrice, exitSource: 'kite-fill' } : {});
  },
  'sync-ignore': async (el) => {
    const r = S.sync.rows[+el.dataset.i];
    await api('/api/settings', { method: 'PUT', body: { syncIgnore: [...(S.state.settings.syncIgnore || []), r.key] } });
    await reload(); openSync();
  },
  'sync-unignore': async (el) => {
    await api('/api/settings', { method: 'PUT', body: { syncIgnore: (S.state.settings.syncIgnore || []).filter((k) => k !== el.dataset.key) } });
    await reload(); toast('Kite sync will flag it again');
  },
  'thesis-review': (el, e) => { e.stopPropagation(); openThesisReview(findTrade(el.dataset.id)); },
  'delete-thesis-review': async (el) => {
    if (!(await confirmBox('Delete this review?', 'Any XP it earned is removed.', 'Delete'))) return;
    await api(`/api/trades/${el.dataset.id}/thesis-reviews/${el.dataset.rid}`, { method: 'DELETE' }); await reload({ celebrate: true });
  },
  'sync-review': (el) => { const r = S.sync.rows[+el.dataset.i]; closeModal(); S.drawerId = r.trades[0].id; renderDrawer(); },
  'fill-entry': (el) => {
    const f = S._fills[+el.dataset.i]; closeModal();
    openTradeForm(null, { symbol: f.symbol, exchange: f.exchange, segment: guessSegment(f.exchange, f.symbol), side: f.side === 'BUY' ? 'LONG' : 'SHORT', qty: f.qty, entryPrice: f.price, entryTime: f.time, entrySource: 'kite-fill' });
  },
  'fill-exit': (el) => { const f = S._fills[+el.dataset.i]; closeModal(); openCloseForm(findTrade(el.dataset.id), { exitPrice: f.price, exitTime: f.time, exitSource: 'kite-fill', qty: f.qty }); },
};


export function bindGlobal() {
  document.addEventListener('click', (e) => {
    const ov = e.target.closest('.overlay');
    if (ov && e.target === ov && ov.hasAttribute('data-dismiss')) return closeModal();
    const db = e.target.closest('[data-draw]');
    if (db) { e.preventDefault(); handleDrawClick(db); return; }
    const pa = e.target.closest('[data-pa]');
    if (pa) { e.preventDefault(); practiceAction(pa.dataset.pa, pa); return; }
    if (e.target.closest('[data-stop]')) { const cb = e.target.closest('[data-stop]').querySelector('input'); if (cb && e.target !== cb) cb.click(); return; }
    const el = e.target.closest('[data-action]');
    if (el && actions[el.dataset.action]) { if (el.tagName === 'BUTTON' && el.type !== 'submit') e.preventDefault(); actions[el.dataset.action](el, e); }
  });
  document.addEventListener('keydown', (e) => {
    if (!$('#modal-root').innerHTML && practiceKey(e)) return;
    if (e.key === 'Escape') {
      if ($('#modal-root').innerHTML) { if ($('.overlay[data-dismiss]')) closeModal(); return; }
      if (S.drawerId) actions['close-drawer']();
    }
    if (e.key === 'n' && !e.ctrlKey && !e.metaKey && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !$('#modal-root').innerHTML) { e.preventDefault(); openTradeForm(); }
  });
  // Journal filters
  document.addEventListener('input', (e) => {
    if (e.target.hasAttribute?.('data-action-view')) { S.view = e.target.value; render(); return; }
    if (e.target.name === 'wealth-scope') { setWealthScope(e.target.value); render(); return; }
    if (e.target.name === 'ins-year') { S.insYear = e.target.value; render(); return; }
    if (e.target.name === 'bulk-type' && e.target.value) {
      const horizon = e.target.value; const ids = [...S.sel];
      api('/api/trades/bulk', { method: 'POST', body: { ids, horizon } })
        .then(async (r) => { S.sel.clear(); await reload(); toast(`${r.updated} trade${r.updated === 1 ? '' : 's'} set to ${esc(HORIZON_LABEL[horizon] || horizon)}`); })
        .catch((err) => toast(esc(err.message), 'err'));
      return;
    }
    if (e.target.dataset?.sel) {
      const id = e.target.dataset.sel; e.target.checked ? S.sel.add(id) : S.sel.delete(id);
      e.target.closest('tr')?.classList.toggle('selected', e.target.checked);
      const b = $('#sel-bar'); if (b) b.innerHTML = selBar(); return;
    }
    if (e.target.hasAttribute?.('data-sel-all')) {
      for (const t of filteredTrades()) e.target.checked ? S.sel.add(t.id) : S.sel.delete(t.id);
      const jb = $('#journal-body'); if (jb) jb.innerHTML = journalRows();
      const b = $('#sel-bar'); if (b) b.innerHTML = selBar(); return;
    }
    if (e.target.dataset?.tbAll) { $$(`[data-tb="${e.target.dataset.tbAll}"]`).forEach((x) => { x.checked = e.target.checked; }); return; }
    const iv = e.target.dataset?.actionIv; const emaN = e.target.dataset?.actionEma;
    if (iv || emaN) {
      if (emaN) { const n = +emaN; S.emas = e.target.checked ? [...new Set([...S.emas, n])].sort((a, b) => a - b) : S.emas.filter((x) => x !== n); try { localStorage.setItem('tq-emas', S.emas.join(',')); } catch { /* ignore */ } }
      const id = S.big?.tradeId || S.drawerId; const t = findTrade(id); if (!t) return;
      if (iv) S.chartIv[t.id] = iv;
      if (S.big) { closeModal(); openBigChart(t); }
      if (S.drawerId) { S.cv?.inst?.destroy(); S.cv = null; renderDrawer(); }
      return;
    }
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
// Installable app (Android Chrome "Install app" / "Add to Home screen").
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installPrompt = e; if (route().page === 'settings') render(); });
window.addEventListener('appinstalled', () => { S.installPrompt = null; toast('📲 TradeQuest installed — open it from your home screen'); });
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));

export async function boot() {
  bindGlobal();
  initPractice({ api, S: () => S, state: () => S.state, kite: () => S.kite, toast, esc, reload, openModal, closeModal });
  try {
    await Promise.all([loadKite(), (async () => { S.state = await api('/api/state'); })()]);
  } catch (e) {
    if (e.code === 'AUTH') return; // the login screen is showing
    const setup = e.code === 'NO_PASSWORD';
    $('#main').innerHTML = setup
      ? `<div class="card empty"><div class="big">🔑</div><h2>One step left: set your password</h2><p>In Cloudflare, open the <b>tradequest</b> Worker → <b>Settings → Variables and Secrets → Add</b>. Choose type <b>Secret</b>, name <code>APP_PASSWORD</code>, and a password of 12+ characters. Save, then reload this page.</p></div>`
      : `<div class="card empty"><div class="big">⚠️</div><h2>Can't reach the TradeQuest server</h2><p>${esc(e.message)}. Is <code>npm start</code> running?</p></div>`;
    return;
  }
  S.game = computeGame(S.state); S.stats = computeStats(S.state.trades.filter(isTrading), S.state.groups);
  loadPortfolio().then(() => render());
  const { params } = route();
  if (params.get('kite') === 'ok') { toast(`<div class="t-h">⚡ Kite connected</div><div class="muted" style="font-size:12px;margin-top:4px">Live prices are on until ~6 AM tomorrow.</div>`); history.replaceState(null, '', '#/settings'); }
  if (params.get('kite') === 'error') { toast(`Kite login failed: ${esc(params.get('msg') || 'unknown error')}`, 'err'); history.replaceState(null, '', '#/settings'); }
  render();
  if (params.get('new') === '1') { history.replaceState(null, '', '#/dashboard'); openTradeForm(); }
  pollQuotes();
  setInterval(pollQuotes, 5000);
  setInterval(async () => { const before = S.kite.connected; await loadKite(); if (before !== S.kite.connected) { await loadPortfolio(); render(); } }, 60000);
  setInterval(async () => { if (document.hidden || !S.kite.connected) return; await loadPortfolio(); const b = $('#sync-badge'); if (b) b.innerHTML = syncBadge(); }, 120000);
}

boot();
