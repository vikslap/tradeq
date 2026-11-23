// Dashboard → live market breadth (Nifty 500): advancers/decliners, % above the 50- and
// 200-day averages, and the McClellan oscillator — from one Kite quote call for all
// members plus the stored history. After the close it also adds the day to the history.
import { liveBreadth, appendToday, breadthMeasures, subsetHistory, subsetTails } from '../market.js';
import { S, api } from './state.js';
import { $, esc } from './util.js';
import { loadBreadth, members50 } from './breadth.js';
import { intradayShell, mountIntraday, wireIntraday } from './intraday.js';

// Which index the card shows: the full Nifty 500 or just the Nifty 50 members.
const UKEY = 'tq-breadth-universe';
export const getUniverse = () => { try { return localStorage.getItem(UKEY) === 'n50' ? 'n50' : 'n500'; } catch { return 'n500'; } };
const setUniverse = (v) => { try { localStorage.setItem(UKEY, v); } catch { /* private mode */ } };
const UNAME = { n500: 'Nifty 500', n50: 'Nifty 50' };

const istNow = () => new Date(Date.now() + 330 * 60000);
const todayIST = () => istNow().toISOString().slice(0, 10);
const marketOpen = () => { const d = istNow(); const m = d.getUTCHours() * 60 + d.getUTCMinutes(); return d.getUTCDay() % 6 !== 0 && m >= 9 * 60 + 15 && m <= 15 * 60 + 30; };
const afterClose = () => { const d = istNow(); return d.getUTCDay() % 6 !== 0 && d.getUTCHours() * 60 + d.getUTCMinutes() >= 15 * 60 + 45; };

const uToggle = (u) => `<div class="seg seg-sm" role="group" aria-label="Index">${['n500', 'n50'].map((k) => `<label><input type="radio" name="br-universe" value="${k}" data-br-universe ${k === u ? 'checked' : ''}><span>${UNAME[k]}</span></label>`).join('')}</div>`;
export const breadthCardShell = () => { const u = getUniverse(); return `<section class="card o-breadth" id="mkt-breadth"><header class="card-h"><h3>📊 Market breadth</h3>${uToggle(u)}</header><div class="sub" id="mkt-breadth-sub" style="margin:-8px 0 8px"></div><div id="mkt-breadth-body">${S.liveBreadthHtml || '<div class="empty-sm">Loading…</div>'}</div>${intradayShell()}</section>`; };

async function loadTails() {
  if (S.breadthTails) return S.breadthTails;
  try { S.breadthTails = await api('/api/breadth/tails'); } catch { S.breadthTails = { closes: {} }; }
  return S.breadthTails;
}

async function quotesFor(syms) {
  const out = {};
  for (let i = 0; i < syms.length; i += 250) {
    const keys = syms.slice(i, i + 250).map((s) => `NSE:${s}`).join(',');
    Object.assign(out, (await api(`/api/kite/quote?i=${encodeURIComponent(keys)}`)).quotes);
  }
  return out;
}

const zone50 = (v) => (v >= 80 ? ['neg', 'stretched'] : v <= 20 ? ['pos', 'washed out'] : v >= 50 ? ['pos', 'more stocks in uptrends'] : ['neg', 'more stocks in downtrends']);
const zone200 = (v) => (v >= 60 ? ['pos', 'healthy'] : v <= 40 ? ['neg', 'weak'] : ['', 'mixed']);

function spark(values, live) {
  const v = [...values.filter((x) => x != null), ...(live != null ? [live] : [])].slice(-120);
  if (v.length < 2) return '';
  const w = 220; const h = 38;
  const pts = v.map((x, i) => `${((i / (v.length - 1)) * w).toFixed(1)},${(h - (x / 100) * h).toFixed(1)}`).join(' ');
  return `<svg width="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="height:38px;display:block;margin-top:6px"><line x1="0" x2="${w}" y1="${h * 0.2}" y2="${h * 0.2}" stroke="var(--border)" stroke-dasharray="3 3"/><line x1="0" x2="${w}" y1="${h * 0.8}" y2="${h * 0.8}" stroke="var(--border)" stroke-dasharray="3 3"/><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.6"/></svg>`;
}

function html(L, history, u = 'n500') {
  const [c50, t50] = L.pct50 != null ? zone50(L.pct50) : ['', ''];
  const [c200, t200] = L.pct200 != null ? zone200(L.pct200) : ['', ''];
  const m = history?.dates?.length ? breadthMeasures(history) : null;
  const tile = (k, v, s, extra = '') => `<div class="kpi"><div class="k">${k}</div><div class="v mono">${v}</div><div class="s">${s}</div>${extra}</div>`;
  return `<div class="kpis k4">
    ${tile('Today', `<span class="pos">${L.adv}↑</span> <span class="neg">${L.dec}↓</span>`, `${L.unch} unchanged · ${L.n} ${UNAME[u]} stocks`)}
    ${tile('% above 50-DMA', L.pct50 == null ? '—' : `${Math.round(L.pct50)}%`, `<b class="${c50}">${t50}</b>`, m ? spark(m.pct50, L.pct50) : '')}
    ${tile('% above 200-DMA', L.pct200 == null ? '—' : `${Math.round(L.pct200)}%`, `<b class="${c200}">${t200}</b>`, m && u === 'n500' ? spark(m.pct200, L.pct200) : '')}
    ${tile('McClellan oscillator', L.mcclellan == null ? '—' : `${L.mcclellan >= 0 ? '+' : ''}${Math.abs(L.mcclellan) < 10 ? L.mcclellan.toFixed(1) : Math.round(L.mcclellan)}`, L.mcclellan == null ? 'needs 39+ days of history' : `<b class="${L.mcclellan >= 0 ? 'pos' : 'neg'}">breadth momentum ${L.mcclellan >= 0 ? 'up' : 'down'}</b>`)}
  </div>
  ${L.staleDays > 5 ? `<div class="note warn" style="margin-top:10px"><span>The stored history is ${L.staleDays} days old, so the 50/200-day figures are approximate. Rebuild in <a href="#/settings">Settings → Market breadth</a>.</span></div>` : ''}`;
}

let timer = null; let busy = false;
export async function mountBreadthLive() {
  wire();
  const body = $('#mkt-breadth-body'); if (!body) { clearInterval(timer); timer = null; return; }
  paintBreadth();
  mountIntraday(getUniverse());
  if (!timer) timer = setInterval(() => { if (!$('#mkt-breadth-body')) { clearInterval(timer); timer = null; } else if (marketOpen()) { refresh(); mountIntraday(getUniverse(), true); } }, 60000);
  if (!S.liveBreadthAt || Date.now() - S.liveBreadthAt > 55000) refresh();
}

const set = (h, sub = '') => { S.liveBreadthHtml = h; const b = $('#mkt-breadth-body'); if (b) b.innerHTML = h; const s = $('#mkt-breadth-sub'); if (s) s.textContent = sub; };
function paintBreadth() {
  const d = S.liveBreadthData; if (!d) return;
  const u = getUniverse(); const [L, h] = d[u];
  set(html(L, h, u), d.sub);
}

let wired = false;
function wire() {
  if (wired) return; wired = true;
  document.addEventListener('change', (e) => {
    if (!e.target.matches?.('[data-br-universe]')) return;
    setUniverse(e.target.value); paintBreadth(); mountIntraday(e.target.value, true);
  });
  wireIntraday();
}

async function refresh() {
  if (busy) return; busy = true;
  try {
    if (!S.kite.connected) return set('<div class="empty-sm">Connect Kite to see live breadth.</div>');
    const [history, tails] = await Promise.all([loadBreadth(), loadTails()]);
    const syms = Object.keys(tails.closes || {});
    if (!syms.length) return set(`<div class="empty-sm">${history?.dates?.length ? 'Rebuild' : 'Build'} the breadth history once in <a href="#/settings">Settings → Market breadth</a> to switch this on.</div>`);
    const quotes = await quotesFor(syms);
    const today = todayIST();
    const L = liveBreadth(history, tails, quotes, today);
    // Nifty 50: the same quotes, the member subset of the stored closes.
    const m50 = members50();
    if (S._h50src !== tails) { S._h50 = subsetHistory(history, tails, m50); S._t50 = subsetTails(tails, m50); S._h50src = tails; }
    const L50 = liveBreadth(S._h50, S._t50, quotes, today);
    S.liveBreadthAt = Date.now();
    S.liveBreadthData = { n500: [L, history], n50: [L50, S._h50], sub: marketOpen() ? `live · ${istNow().toISOString().slice(11, 16)} IST · updates every minute` : 'as of the last close' };
    paintBreadth();
    // After the close on a trading day, add today to the history so it stays current.
    const quiet = L.n && L.unch / L.n > 0.9; // a holiday: nothing moved
    if (afterClose() && !quiet && history.dates.at(-1) < today && (L.staleDays ?? 99) <= 5) {
      const next = appendToday(history, tails, L, today);
      if (next) {
        await api('/api/breadth', { method: 'PUT', body: next.history });
        await api('/api/breadth/tails', { method: 'PUT', body: next.tails });
        S.breadth = next.history; S.breadthTails = next.tails;
      }
    }
  } catch (e) {
    set(`<div class="empty-sm">Couldn't load breadth: ${esc(e.message)}</div>`);
  } finally { busy = false; }
}
