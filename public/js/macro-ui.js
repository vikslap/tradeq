// Market page → 🌍 Global markets: DXY, Brent and gold — live tiles plus one chart, either
// all three as % change on one scale (to compare the moves) or each on its own price scale.
import { createChart, LineSeries, CrosshairMode } from '../vendor/lightweight-charts.mjs';
import { api } from './state.js';
import { $, esc, nf2 } from './util.js';

const COLORS = { dxy: '#3b82f6', brent: '#f97316', gold: '#d4a017' };
const RKEY = 'tq-macro-range'; const VKEY = 'tq-macro-view'; const HKEY = 'tq-macro-hidden';
const get = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const put = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private */ } };
const hidden = () => new Set(get(HKEY, '').split(',').filter(Boolean));
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const ist = (ms) => Math.floor(ms / 1000) + 19800;
const M = { data: null, charts: [], timer: null, wired: false };

const seg = (name, opts, val) => `<div class="seg seg-sm">${opts.map(([v, l]) => `<label><input type="radio" name="${name}" value="${v}" ${v === val ? 'checked' : ''} data-macro="${name}"><span>${l}</span></label>`).join('')}</div>`;

export const macroCardShell = () => `<section class="card o-macro" id="mkt-macro">
  <header class="card-h" style="flex-wrap:wrap;gap:8px"><h3>🌍 Global markets</h3>${seg('range', [['1d', '1D'], ['5d', '5D'], ['1mo', '1M'], ['6mo', '6M'], ['1y', '1Y']], get(RKEY, '1d'))}</header>
  <div id="macro-tiles" class="macro-tiles"><div class="empty-sm">Loading…</div></div>
  <div class="row" style="justify-content:space-between;align-items:center;margin:10px 0 6px;gap:8px;flex-wrap:wrap">${seg('view', [['overlay', '% change together'], ['separate', 'Each on its own']], get(VKEY, 'overlay'))}<span class="sub" id="macro-asof" style="font-size:11px"></span></div>
  <div id="macro-chart"></div>
  <p class="faint" style="font-size:11px;margin:8px 0 0">Tap a tile to hide or show it. A stronger dollar (DXY up) usually means foreign money leaves India and the rupee weakens; Brent up is a headwind for India (imports most of its oil); gold up often signals caution. DXY: ICE index · Brent and gold: front-month futures (ICE, COMEX) — via Yahoo Finance, about 10–15 minutes delayed for futures.</p>
</section>`;

function tiles() {
  const el = $('#macro-tiles'); if (!el || !M.data) return;
  const h = hidden();
  el.innerHTML = M.data.series.map((s) => {
    const ch = s.change != null ? s.change * 100 : null;
    return `<button class="macro-t ${h.has(s.key) ? 'off' : ''}" data-macro-toggle="${s.key}" style="--c:${COLORS[s.key]}">
      <span class="macro-n"><i></i>${esc(s.short)}</span>
      <b class="mono">${s.last != null ? nf2.format(s.last) : '—'}</b>
      <small class="${ch == null ? '' : ch >= 0 ? 'pos' : 'neg'}">${ch == null ? (s.error ? 'unavailable' : '') : `${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%`}${s.unit ? ` · ${esc(s.unit)}` : ''}</small>
    </button>`;
  }).join('');
  const asOf = Math.max(...M.data.series.map((s) => s.asOf || 0));
  const a = $('#macro-asof'); if (a) a.textContent = asOf ? `as of ${new Date(asOf).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })} IST` : '';
}

function opts(height) {
  const C = { text: css('--muted'), border: css('--border') };
  const range = M.data.range;
  return {
    height, autoSize: false,
    layout: { background: { color: 'transparent' }, textColor: C.text, fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 10, attributionLogo: true },
    grid: { vertLines: { visible: false }, horzLines: { color: C.border } },
    rightPriceScale: { borderColor: C.border }, timeScale: { borderColor: C.border, timeVisible: range === '1d' || range === '5d', secondsVisible: false },
    crosshair: { mode: CrosshairMode.Normal }, handleScroll: false, handleScale: false,
  };
}

function charts() {
  const box = $('#macro-chart'); if (!box || !M.data) return;
  for (const c of M.charts) { try { c.remove(); } catch { /* gone */ } }
  M.charts = []; box.innerHTML = '';
  const h = hidden(); const view = get(VKEY, 'overlay');
  const shown = M.data.series.filter((s) => !h.has(s.key) && s.points.length);
  if (!shown.length) { box.innerHTML = '<div class="empty-sm">Nothing to show — tap a tile to show it.</div>'; return; }
  const width = box.clientWidth || 360;
  if (view === 'overlay') {
    const el = document.createElement('div'); box.appendChild(el);
    const ch = createChart(el, { ...opts(240), width, localization: { priceFormatter: (p) => `${p >= 0 ? '+' : ''}${p.toFixed(2)}%` } });
    for (const s of shown) {
      const base = M.data.range === '1d' && s.prev ? s.prev : s.points[0][1];
      const ln = ch.addSeries(LineSeries, { color: COLORS[s.key], lineWidth: 2, priceLineVisible: false, title: s.short });
      ln.setData(dedupe(s.points.map(([t, v]) => ({ time: ist(t), value: ((v - base) / base) * 100 }))));
    }
    ch.timeScale().fitContent(); M.charts.push(ch);
  } else {
    for (const s of shown) {
      const el = document.createElement('div'); el.className = 'macro-sep'; el.innerHTML = `<div class="sub" style="font-size:11px;margin:4px 0 2px"><b style="color:${COLORS[s.key]}">${esc(s.name)}</b>${s.unit ? ` · ${esc(s.unit)}` : ''}</div>`; box.appendChild(el);
      const holder = document.createElement('div'); el.appendChild(holder);
      const ch = createChart(holder, { ...opts(120), width, localization: { priceFormatter: (p) => nf2.format(p) } });
      const ln = ch.addSeries(LineSeries, { color: COLORS[s.key], lineWidth: 2, priceLineVisible: false });
      ln.setData(dedupe(s.points.map(([t, v]) => ({ time: ist(t), value: v }))));
      ch.timeScale().fitContent(); M.charts.push(ch);
    }
  }
}
const dedupe = (pts) => pts.filter((p, i) => i === 0 || p.time > pts[i - 1].time);

async function load() {
  const box = $('#macro-chart'); if (!box) return;
  try { M.data = await api(`/api/macro?range=${get(RKEY, '1d')}`); tiles(); charts(); }
  catch (e) { const t = $('#macro-tiles'); if (t) t.innerHTML = `<div class="note warn"><span>${esc(e.message)}</span></div>`; }
}

export async function mountMacro() {
  if (!M.wired) {
    M.wired = true;
    document.addEventListener('change', (e) => {
      const k = e.target.dataset?.macro; if (!k) return;
      if (k === 'range') { put(RKEY, e.target.value); load(); }
      if (k === 'view') { put(VKEY, e.target.value); charts(); }
    });
    document.addEventListener('click', (e) => {
      const t = e.target.closest?.('[data-macro-toggle]'); if (!t) return;
      const h = hidden(); const k = t.dataset.macroToggle; h.has(k) ? h.delete(k) : h.add(k); put(HKEY, [...h].join(','));
      tiles(); charts();
    });
    let rt = null; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if ($('#macro-chart')) charts(); }, 200); });
  }
  await load();
  clearInterval(M.timer);
  M.timer = setInterval(() => { if (!$('#macro-chart')) { clearInterval(M.timer); return; } if (!document.hidden) load(); }, get(RKEY, '1d') === '1d' ? 60000 : 300000);
}
