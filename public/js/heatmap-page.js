// 🟩 Market heatmap: every Nifty 50 / Nifty 500 stock coloured by today's move, sized by
// today's traded value, grouped by sector when NSE's list (with its Industry column) has
// been uploaded. Refreshes every minute while the market is open.
import { squarify, heatColor, groupSectors } from '../heatmap.js';
import { S, api } from './state.js';
import { $, esc, nf2 } from './util.js';
import { members500, members50, industries, loadBreadth } from './breadth.js';
import { prefillSizer } from './sizer.js';
import { breadthCardShell, mountBreadthLive } from './breadthlive.js';
import { valuationCardShell, mountValuation } from './valuation-ui.js';

const UKEY = 'tq-breadth-universe'; // shared with the dashboard breadth card
const SKEY = 'tq-heat-size';
const get = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const put = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const ist = () => new Date(Date.now() + 330 * 60000);
const marketOpen = () => { const d = ist(); const m = d.getUTCHours() * 60 + d.getUTCMinutes(); return d.getUTCDay() % 6 !== 0 && m >= 555 && m <= 930; };
const crore = (v) => (v >= 1e7 ? `₹${(v / 1e7).toLocaleString('en-IN', { maximumFractionDigits: v >= 1e9 ? 0 : 1 })} Cr` : `₹${(v / 1e5).toLocaleString('en-IN', { maximumFractionDigits: 1 })} L`);
const sgn = (v, dp = 2) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(dp)}%`);
const seg = (name, opts, val) => `<div class="seg seg-sm">${opts.map(([v, l]) => `<label><input type="radio" name="${name}" value="${v}" ${v === val ? 'checked' : ''} data-heat="${name}"><span>${l}</span></label>`).join('')}</div>`;

const H = { quotes: null, at: 0, u: null, drill: null, sel: null, timer: null, ro: null };

// One switch drives the whole page: heatmap, breadth tiles and the intraday chart.
const useg = (u) => `<div class="seg seg-sm" role="group" aria-label="Index">${[['n50', 'Nifty 50'], ['n500', 'Nifty 500']].map(([v, l]) => `<label><input type="radio" name="mkt-universe" value="${v}" ${v === u ? 'checked' : ''} data-heat="universe" data-br-universe><span>${l}</span></label>`).join('')}</div>`;

export function pageMarket() {
  const u = get(UKEY, 'n500') === 'n50' ? 'n50' : 'n500';
  return `<div class="page-h"><div><h1>📊 Market</h1><p>How the whole market is doing today — breadth, the index through the day, every stock's move, and valuation.</p></div>
    <div class="row" style="gap:8px;flex-wrap:wrap">${useg(u)}</div></div>
  <div class="mkt-page">
    <div class="mkt-side">${breadthCardShell({ toggle: false })}${valuationCardShell()}</div>
    <div class="mkt-main">${heatCard()}</div>
  </div>`;
}

export async function mountMarket() {
  await mountBreadthLive().catch(() => {});
  mountValuation();
  mountHeatmap();
}

const heatCard = () => `
  <section class="card heat-card o-heat">
    <header class="card-h"><h3>🟩 Heatmap</h3>${seg('size', [['value', 'By traded value'], ['equal', 'Equal size']], get(SKEY, 'value'))}</header>
    <div class="heat-top"><div id="heat-summary" class="sub">Loading…</div><div class="heat-legend" aria-hidden="true"><span>−3%</span><i></i><span>+3%</span></div></div>
    <div id="heat-crumb"></div>
    <div id="heat-map" class="heat-map" role="list"></div>
    <div id="heat-detail"></div>
  </section>`;

function stocksNow() {
  const u = get(UKEY, 'n500') === 'n50' ? 'n50' : 'n500';
  const syms = u === 'n50' ? members50() : members500();
  const ind = industries(); const byValue = get(SKEY, 'value') === 'value';
  const list = [];
  for (const s of syms) {
    const q = H.quotes?.[`NSE:${s}`]; if (!q?.last) continue;
    const pct = q.changePct == null ? null : q.changePct * 100;
    const traded = q.volume ? q.volume * q.last : 0;
    list.push({ sym: s, pct, last: q.last, prev: q.prevClose, traded, value: byValue ? Math.max(traded, 1) : 1, sector: ind[s] || null });
  }
  if (byValue) { const med = list.map((x) => x.traded).filter(Boolean).sort((a, b) => a - b)[Math.floor(list.length / 2)] || 1; for (const x of list) if (!x.traded) x.value = med; } // no volume yet → median size
  return { u, list, hasSectors: list.some((x) => x.sector) };
}

function tileHtml(r, s, extra = '') {
  const big = r.w > 64 && r.h > 34; const mid = r.w > 34 && r.h > 18;
  const label = big ? `<b>${esc(s.sym)}</b><span>${sgn(s.pct)}</span>` : mid ? `<b>${esc(s.sym)}</b>` : '';
  return `<button class="heat-tile${H.sel === s.sym ? ' sel' : ''}" role="listitem" data-heat-sym="${esc(s.sym)}" title="${esc(s.sym)} ${sgn(s.pct)}" style="left:${r.x}px;top:${r.y}px;width:${Math.max(0, r.w - 1)}px;height:${Math.max(0, r.h - 1)}px;background:${heatColor(s.pct)}${big && r.w > 110 ? ';font-size:13px' : ''}"${extra}>${label}</button>`;
}

function draw() {
  const box = $('#heat-map'); if (!box || !H.quotes) return;
  const { u, list, hasSectors } = stocksNow();
  const W = box.clientWidth; const phone = W < 700;
  const Hh = Math.max(360, Math.min(phone ? 640 : 760, Math.round(window.innerHeight * (phone ? 0.68 : 0.72))));
  box.style.height = `${Hh}px`;
  const groups = hasSectors ? groupSectors(list) : [{ name: null, stocks: [...list].sort((a, b) => b.value - a.value), value: list.reduce((a, s) => a + s.value, 0) }];
  const crumb = $('#heat-crumb');
  let html = '';
  if (H.drill && hasSectors) {
    const g = groups.find((x) => x.name === H.drill);
    if (!g) H.drill = null;
    else {
      crumb.innerHTML = `<button class="btn sm ghost" data-heat-back>← All sectors</button> <b>${esc(g.name)}</b> <span class="sub">${g.stocks.length} stocks · <b class="${g.pct >= 0 ? 'pos' : 'neg'}">${sgn(g.pct)}</b> · ${g.up}↑ ${g.down}↓</span>`;
      squarify(g.stocks.map((s) => s.value), 0, 0, W, Hh).forEach((r, i) => { html += tileHtml(r, g.stocks[i]); });
    }
  }
  if (!H.drill || !hasSectors) {
    crumb.innerHTML = hasSectors && phone && u === 'n500' ? '<div class="sub" style="margin-bottom:6px">Tap a sector to see its stocks.</div>' : '';
    const rects = squarify(groups.map((g) => g.value), 0, 0, W, Hh);
    groups.forEach((g, gi) => {
      const R = rects[gi]; if (!R || R.w < 1 || R.h < 1) return;
      if (hasSectors && phone && u === 'n500') { // sector blocks only; tap to drill in
        const big = R.w > 70 && R.h > 38;
        html += `<button class="heat-tile heat-sector" data-heat-sector="${esc(g.name)}" style="left:${R.x}px;top:${R.y}px;width:${R.w - 2}px;height:${R.h - 2}px;background:${heatColor(g.pct)}">${big ? `<b>${esc(g.name)}</b><span>${sgn(g.pct)} · ${g.stocks.length}</span>` : R.w > 40 && R.h > 18 ? `<span>${sgn(g.pct, 1)}</span>` : ''}</button>`;
        return;
      }
      const head = g.name && R.h > 40 && R.w > 50 ? 16 : 0;
      if (g.name) html += `<div class="heat-group" style="left:${R.x}px;top:${R.y}px;width:${R.w}px;height:${R.h}px">${head ? `<button class="heat-ghead" data-heat-sector="${esc(g.name)}" title="${esc(g.name)} ${sgn(g.pct)}">${esc(g.name)} <span>${sgn(g.pct, 1)}</span></button>` : ''}</div>`;
      squarify(g.stocks.map((s) => s.value), R.x + 1, R.y + head + 1, R.w - 2, R.h - head - 2).forEach((r, i) => { html += tileHtml(r, g.stocks[i]); });
    });
  }
  box.innerHTML = html;
  summary(list, groups, hasSectors, u);
  detail();
}

function summary(list, groups, hasSectors, u) {
  const el = $('#heat-summary'); if (!el) return;
  const up = list.filter((s) => s.pct > 0).length; const dn = list.filter((s) => s.pct < 0).length;
  const sorted = [...list].filter((s) => s.pct != null).sort((a, b) => b.pct - a.pct);
  const avg = sorted.length ? sorted.reduce((a, s) => a + s.pct, 0) / sorted.length : null;
  const top = sorted.slice(0, 3).map((s) => `${esc(s.sym)} <b class="pos">${sgn(s.pct, 1)}</b>`).join(', ');
  const bot = sorted.slice(-3).reverse().map((s) => `${esc(s.sym)} <b class="neg">${sgn(s.pct, 1)}</b>`).join(', ');
  const secs = hasSectors ? [...groups].filter((g) => g.pct != null).sort((a, b) => b.pct - a.pct) : [];
  const secLine = secs.length > 1 ? `<div>Strongest sectors: ${secs.slice(0, 3).map((g) => `${esc(g.name)} <b class="${g.pct >= 0 ? 'pos' : 'neg'}">${sgn(g.pct, 1)}</b>`).join(', ')} · Weakest: ${secs.slice(-3).reverse().map((g) => `${esc(g.name)} <b class="${g.pct >= 0 ? 'pos' : 'neg'}">${sgn(g.pct, 1)}</b>`).join(', ')}</div>` : '';
  const when = marketOpen() ? `live · ${ist().toISOString().slice(11, 16)} IST · updates every minute` : 'as of the last close';
  el.innerHTML = `<div><b>${u === 'n50' ? 'Nifty 50' : 'Nifty 500'}</b> · <span class="pos">${up}↑</span> <span class="neg">${dn}↓</span> · average stock ${sgn(avg)} · <span class="muted">${when}</span></div>
    <div>Top: ${top || '—'} · Bottom: ${bot || '—'}</div>${secLine}
    ${hasSectors ? '' : '<div class="muted" style="font-size:11.5px">No sectors yet — upload NSE\'s Nifty 500 list in <a href="#/settings">Settings → Market breadth</a> to group stocks by sector.</div>'}`;
}

// Where the stock sits against its 50- and 200-day averages, from the stored daily closes.
function dmas(sym, last) {
  const t = S.breadthTails; const c = t?.closes?.[sym]; if (!c?.length) return null;
  const today = ist().toISOString().slice(0, 10);
  const past = t.asOf >= today ? c.slice(0, -1) : c;
  const sma = (n) => (past.length >= n - 1 ? (past.slice(-(n - 1)).reduce((a, x) => a + x, 0) + last) / n : null);
  return { d50: sma(50), d200: sma(200) };
}

function detail() {
  const el = $('#heat-detail'); if (!el) return;
  if (!H.sel) { el.innerHTML = '<div class="sub" style="margin-top:10px;font-size:12px">Tap a tile for details. Tile size = today\'s traded value (₹); colour runs from −3% (deep red) to +3% (deep green).</div>'; return; }
  const q = H.quotes?.[`NSE:${H.sel}`]; if (!q) { el.innerHTML = ''; return; }
  const pctv = q.changePct == null ? null : q.changePct * 100;
  const d = dmas(H.sel, q.last); const ind = industries()[H.sel];
  const vs = (v, n) => (v == null ? '' : `<span class="${q.last >= v ? 'pos' : 'neg'}">${q.last >= v ? 'above' : 'below'} ${n}-DMA (${nf2.format(v)})</span>`);
  el.innerHTML = `<div class="heat-info">
    <div><b style="font-size:16px">${esc(H.sel)}</b> <span class="mono">₹${nf2.format(q.last)}</span> <b class="${pctv >= 0 ? 'pos' : 'neg'}">${sgn(pctv)}</b>${ind ? ` <span class="pill">${esc(ind)}</span>` : ''}</div>
    <div class="sub">Prev close ₹${q.prevClose ? nf2.format(q.prevClose) : '—'}${q.volume ? ` · traded ${crore(q.volume * q.last)}` : ''}${d ? ` · ${[vs(d.d50, 50), vs(d.d200, 200)].filter(Boolean).join(' · ')}` : ''}</div>
    <div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap">
      <a class="btn sm" href="https://www.tradingview.com/chart/?symbol=NSE:${encodeURIComponent(H.sel)}" target="_blank" rel="noopener">📈 Chart (TradingView)</a>
      <button class="btn sm ghost" data-heat-size="${esc(H.sel)}">🧮 Size a trade</button>
    </div></div>`;
}

async function load(force = false) {
  const { u } = stocksNow();
  if (!force && H.quotes && H.u === u && Date.now() - H.at < 55000) return draw();
  if (!S.kite?.connected) { $('#heat-summary').innerHTML = 'Connect Kite to see the heatmap.'; return; }
  const syms = u === 'n50' ? members50() : members500();
  // Reuse the quotes the breadth card just fetched (one request for the whole page).
  if (S.liveQuotesFull && Date.now() - S.liveQuotesAt < 55000 && syms.filter((s) => S.liveQuotes[`NSE:${s}`]).length > syms.length * 0.9) {
    H.quotes = S.liveQuotes; H.at = S.liveQuotesAt; H.u = u; return draw();
  }
  const out = {};
  for (let i = 0; i < syms.length; i += 250) {
    const keys = syms.slice(i, i + 250).map((s) => `NSE:${s}`).join(',');
    Object.assign(out, (await api(`/api/kite/quote?full=1&i=${encodeURIComponent(keys)}`)).quotes);
  }
  H.quotes = out; H.at = Date.now(); H.u = u;
  draw();
}

let wired = false;
function wire() {
  if (wired) return; wired = true;
  document.addEventListener('tq:quotes', () => { if ($('#heat-map') && S.liveQuotesFull) { H.quotes = S.liveQuotes; H.at = S.liveQuotesAt; H.u = stocksNow().u; draw(); } });
  document.addEventListener('change', (e) => {
    const k = e.target.dataset?.heat; if (!k) return;
    if (k === 'universe') { put(UKEY, e.target.value); H.drill = null; H.sel = null; load(true).catch(() => {}); }
    if (k === 'size') { put(SKEY, e.target.value); draw(); }
  });
  document.addEventListener('click', (e) => {
    if (!$('#heat-map')) return;
    const t = e.target.closest('[data-heat-sym]'); if (t) { H.sel = H.sel === t.dataset.heatSym ? null : t.dataset.heatSym; $$sel(); detail(); return; }
    const sec = e.target.closest('[data-heat-sector]'); if (sec) { H.drill = sec.dataset.heatSector; H.sel = null; draw(); return; }
    if (e.target.closest('[data-heat-back]')) { H.drill = null; H.sel = null; draw(); return; }
    const sz = e.target.closest('[data-heat-size]');
    if (sz) { const q = H.quotes?.[`NSE:${sz.dataset.heatSize}`]; prefillSizer({ symbol: sz.dataset.heatSize, exchange: 'NSE', segment: 'EQ', entry: q?.last ? String(q.last) : '' }); location.hash = '#/size'; }
  });
}
const $$sel = () => document.querySelectorAll('.heat-tile[data-heat-sym]').forEach((b) => b.classList.toggle('sel', b.dataset.heatSym === H.sel));

export async function mountHeatmap() {
  wire();
  const box = $('#heat-map'); if (!box) return;
  if (!S.breadthTails) { try { await loadBreadth(); S.breadthTails ||= await api('/api/breadth/tails'); } catch { /* DMAs just won't show */ } }
  try { await load(); } catch (e) { const s = $('#heat-summary'); if (s) s.textContent = `Couldn't load quotes: ${e.message}`; }
  H.ro?.disconnect(); H.ro = new ResizeObserver(() => draw()); H.ro.observe(box);
  clearInterval(H.timer);
  H.timer = setInterval(() => { if (!$('#heat-map')) { clearInterval(H.timer); H.ro?.disconnect(); return; } if (marketOpen() && Date.now() - (S.liveQuotesAt || 0) > 75000) load(true).catch(() => {}); }, 60000);
}
