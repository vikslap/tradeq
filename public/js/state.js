import { setClientSearch } from './kiteinst.js';
import { computeGame, tradeKey, HORIZON_LABEL, isLT, isTrading } from '../game.js';
import { computeStats } from '../stats.js';
import { reconcile } from '../sync.js';
import { $, esc } from './util.js';
import { toast, celebrateDiff } from './ui.js';
import { render } from './main.js';


// =====================================================================
// State
// =====================================================================
export const S = {
  state: null, game: null, stats: null,
  kite: { configured: false, connected: false, mock: false },
  quotes: {}, quotesAt: null, flash: new Set(),
  f: { q: '', status: 'all', segment: 'all', setup: 'all', horizon: 'all' },
  drawerId: null, reviewWeek: null,
  portfolio: null, sync: null, charts: {}, view: 'TRADING',
  chartIv: {}, cv: null, big: null, sel: new Set(),
  emas: (() => { try { const v = localStorage.getItem('tq-emas'); return v == null ? [20, 50] : v.split(',').filter(Boolean).map(Number); } catch { return [20, 50]; } })(),
};


// Hosted version: a password screen when the session cookie is missing or expired.
let loginShown = false;
export function showLogin() {
  if (loginShown) return; loginShown = true;
  const el = document.createElement('div');
  el.className = 'login-screen';
  el.innerHTML = `<form class="login-card" autocomplete="on">
    <div class="brand" style="justify-content:center;margin-bottom:6px"><span class="brand-mark">⚔️</span><span>Trade<b>Quest</b></span></div>
    <p class="muted" style="text-align:center;margin:0 0 16px">Enter your password to open your journal.</p>
    <input class="input" type="password" name="password" placeholder="Password" autocomplete="current-password" required autofocus>
    <div class="err" id="login-err" style="min-height:18px;margin:6px 0"></div>
    <button class="btn primary" type="submit" style="width:100%">Unlock</button>
  </form>`;
  document.body.appendChild(el);
  const form = el.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button'); btn.disabled = true;
    const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: form.password.value }) });
    if (res.ok) return location.reload();
    const j = await res.json().catch(() => ({}));
    el.querySelector('#login-err').textContent = j.error || 'Login failed'; btn.disabled = false; form.password.select();
  });
  setTimeout(() => form.password.focus(), 50);
}

export async function api(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(j.error || `Request failed (${res.status})`); e.code = j.code;
    if (j.code === 'AUTH') showLogin();
    throw e;
  }
  return j;
}


export async function reload({ celebrate = false } = {}) {
  const prev = S.game;
  S.state = await api('/api/state');
  S.game = computeGame(S.state);
  S.stats = computeStats(S.state.trades.filter(isTrading), S.state.groups);
  if (S.portfolio) S.sync = reconcile(S.state.trades, S.portfolio, S.state.settings.syncIgnore);
  if (celebrate && prev) celebrateDiff(prev, S.game);
  render();
}


export async function loadPortfolio({ quiet = true } = {}) {
  if (!S.kite.connected) { S.portfolio = null; S.sync = null; return; }
  try {
    S.portfolio = await api('/api/kite/portfolio');
    S.sync = reconcile(S.state.trades, S.portfolio, S.state.settings.syncIgnore);
  } catch (e) { if (!quiet) toast(esc(e.message), 'err'); }
}


export function syncQuest() {
  if (!S.sync) return [];
  const n = S.sync.rows.length; const ok = n - S.sync.issues;
  return [{ id: 'sync', icon: '🔗', title: 'Books match Kite', desc: 'Every Kite position is in your journal, and nothing extra', progress: ok, total: n, done: S.sync.issues === 0 && n > 0, isIdle: n === 0, idle: 'No positions at Kite or in the journal' }];
}


export function syncBadge() {
  if (!S.kite.connected) return '';
  if (!S.sync) return '<span class="sub">Checking Kite…</span>';
  return S.sync.issues
    ? `<button class="btn sm warn-btn" data-action="kite-sync">⚠ ${S.sync.issues} out of sync with Kite</button>`
    : '<button class="btn ghost sm" data-action="kite-sync">✓ Matches Kite</button>';
}


export async function loadKite() {
  try { S.kite = await api('/api/kite/status'); } catch (e) { if (e.code === 'AUTH') throw e; S.kite = { configured: false, connected: false }; }
  setClientSearch(S.kite.clientSearch && !S.kite.mock);
}


export const VIEWS = [['TRADING', 'Trading'], ['LONGTERM', 'Long-term'], ['ALL', 'All']];

export const viewTrades = () => S.state.trades.filter((t) => (S.view === 'ALL' ? true : S.view === 'LONGTERM' ? isLT(t) : isTrading(t)));

export const viewSeg = () => `<div class="seg sm-seg">${VIEWS.map(([v, l]) => `<label><input type="radio" name="view" data-action-view value="${v}" ${S.view === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>`;

export const horizonPill = (t) => `<span class="pill ${isLT(t) ? 'gold' : ''}">${HORIZON_LABEL[t.horizon] || '—'}</span>`;

export const groupOf = (t) => (t.groupId ? (S.state.groups || []).find((g) => g.id === t.groupId) : null);

export const legsOfGroup = (gid) => S.state.trades.filter((t) => t.groupId === gid);

export const linkPill = (t) => { const g = groupOf(t); return g ? `<span class="pill violet" title="Linked: ${esc(g.name)}">🔗 ${esc(g.name.length > 22 ? g.name.slice(0, 21) + '…' : g.name)}</span>` : ''; };

/** Suggest a name: "NIFTY 26N17 23400/23600 CE" for option legs on one underlying + expiry. */

export function suggestGroupName(legs) {
  const parts = legs.map((t) => t.symbol.match(/^([A-Z&-]+?)(\d{2}(?:[A-Z]{3}|[1-9OND]\d{2}))(\d+(?:\.\d+)?)(CE|PE)$/));
  if (parts.every(Boolean) && new Set(parts.map((p) => p[1] + p[2])).size === 1) {
    const strikes = [...new Set(parts.map((p) => p[3]))].sort((a, b) => a - b);
    const types = [...new Set(parts.map((p) => p[4]))];
    return `${parts[0][1]} ${parts[0][2]} ${strikes.join('/')} ${types.join('/')}`;
  }
  return legs.map((t) => t.symbol).join(' / ');
}


export const quoteFor = (t) => S.quotes[tradeKey(t)];

export const ltpFor = (t) => quoteFor(t)?.last ?? null;


// =====================================================================
// Actions
// =====================================================================
export const findTrade = (id) => S.state.trades.find((t) => t.id === id);
