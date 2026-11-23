// Dashboard → intraday index chart (Nifty 50 or Nifty 500), toggled open under the breadth
// tiles: 1-minute closes for the current (or last) session, shaded green above / red below
// the previous close, with the day's high and low and the swing peaks and troughs marked.
import { createChart, BaselineSeries, LineStyle, CrosshairMode, createSeriesMarkers } from '../vendor/lightweight-charts.mjs';
import { swings } from '../market.js';
import { S, api } from './state.js';
import { $, esc } from './util.js';
import { rawCandles, tokensFor } from './breadth.js';

const OKEY = 'tq-intraday-open';
const isOpen = () => { try { return localStorage.getItem(OKEY) === '1'; } catch { return false; } };
const setOpen = (v) => { try { localStorage.setItem(OKEY, v ? '1' : '0'); } catch { /* private mode */ } };
const INDEX = { n50: { name: 'Nifty 50', sym: 'NIFTY 50', token: 256265 }, n500: { name: 'Nifty 500', sym: 'NIFTY 500', token: 268041 } };
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const nf = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 });
const hhmm = (ms) => new Date(ms + 19800000).toISOString().slice(11, 16);
const istDay = (ms) => new Date(ms + 19800000).toISOString().slice(0, 10);

export const intradayShell = () => `<div class="intraday">
  <button class="btn sm ghost" data-action="intraday-toggle" aria-expanded="${isOpen()}">📈 ${isOpen() ? 'Hide' : 'Show'} intraday chart</button>
  <div id="intraday-wrap" ${isOpen() ? '' : 'hidden'}><div class="sub mono" id="intraday-legend" style="margin:8px 0 6px"></div><div id="intraday-chart" class="intraday-chart"></div><div class="sub" style="font-size:11px;margin-top:4px">● swing peaks and troughs (a turn of at least <span id="intraday-pct">—</span>) · H/L = day's high and low · dashed line = previous close</div></div>
</div>`;

let G = null; // { el, chart, series, markers }
let loading = false;

export function wireIntraday() {
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-action="intraday-toggle"]'); if (!b) return;
    const open = !isOpen(); setOpen(open);
    b.textContent = `📈 ${open ? 'Hide' : 'Show'} intraday chart`; b.setAttribute('aria-expanded', open);
    const w = $('#intraday-wrap'); if (w) w.hidden = !open;
    if (open) mountIntraday(localStorage.getItem('tq-breadth-universe') === 'n50' ? 'n50' : 'n500', true);
  });
}

async function tokenOf(u) {
  S._idxTok ||= {};
  if (S._idxTok[u]) return S._idxTok[u];
  try { const t = (await tokensFor([INDEX[u].sym]))[INDEX[u].sym]; if (t) return (S._idxTok[u] = t); } catch { /* fall back */ }
  return (S._idxTok[u] = INDEX[u].token);
}

function ensureChart(el) {
  if (G && G.el === el && document.contains(el)) return G;
  if (G) { try { G.chart.remove(); } catch { /* gone */ } }
  const C = { text: css('--muted'), border: css('--border'), green: css('--green'), red: css('--red') };
  const chart = createChart(el, {
    autoSize: true,
    layout: { background: { color: 'transparent' }, textColor: C.text, fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 10, attributionLogo: true },
    grid: { vertLines: { visible: false }, horzLines: { color: C.border } },
    rightPriceScale: { borderColor: C.border, scaleMargins: { top: 0.12, bottom: 0.12 } },
    timeScale: { borderColor: C.border, timeVisible: true, secondsVisible: false, rightOffset: 2, fixLeftEdge: true },
    crosshair: { mode: CrosshairMode.Magnet },
    localization: { priceFormatter: (p) => nf.format(p) },
    handleScroll: false, handleScale: false,
  });
  const series = chart.addSeries(BaselineSeries, { lineWidth: 2, topLineColor: C.green, bottomLineColor: C.red, topFillColor1: 'rgba(34,197,94,.18)', topFillColor2: 'rgba(34,197,94,.02)', bottomFillColor1: 'rgba(239,68,68,.02)', bottomFillColor2: 'rgba(239,68,68,.18)', priceLineVisible: false, lastValueVisible: true });
  G = { el, chart, series, markers: createSeriesMarkers(series, []), C, prevLine: null };
  return G;
}

/** Load and draw. `force` refetches even if this index was drawn in the last minute. */
export async function mountIntraday(u = 'n500', force = false) {
  const el = $('#intraday-chart'); const legend = $('#intraday-legend');
  if (!el || !isOpen() || loading) return;
  if (!S.kite?.connected) { legend.textContent = 'Connect Kite to see the intraday chart.'; return; }
  const key = `${u}`; if (!force && G?.key === key && G.el === el && Date.now() - G.at < 55000) return;
  loading = true;
  try {
    const now = Date.now();
    const candles = await rawCandles(await tokenOf(u), 'minute', now - 6 * 86400000, now);
    if (!candles.length) { legend.textContent = 'No intraday data from Kite yet.'; return; }
    const day = istDay(candles.at(-1)[0]);
    const todayC = candles.filter((c) => istDay(c[0]) === day);
    const before = candles.filter((c) => istDay(c[0]) < day);
    let prev = before.at(-1)?.[4] ?? null;
    if (prev == null) { try { prev = (await api(`/api/kite/quote?i=${encodeURIComponent(`NSE:${INDEX[u].sym}`)}`)).quotes?.[`NSE:${INDEX[u].sym}`]?.prevClose ?? null; } catch { /* no prev close */ } }
    const pts = todayC.map((c) => [c[0], c[4]]);
    const g = ensureChart(el);
    const base = prev ?? pts[0][1];
    g.series.applyOptions({ baseValue: { type: 'price', price: base } });
    g.series.setData(pts.map(([t, v]) => ({ time: Math.floor(t / 1000) + 19800, value: v })));
    if (g.prevLine) g.series.removePriceLine(g.prevLine);
    g.prevLine = prev != null ? g.series.createPriceLine({ price: prev, color: g.C.text, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: 'prev' }) : null;

    // Swing threshold scales with the day's range: ~¼ of it, between 0.12% and 0.6%.
    const hi = Math.max(...pts.map((p) => p[1])); const lo = Math.min(...pts.map((p) => p[1]));
    const rangePct = ((hi - lo) / lo) * 100;
    const pct = Math.min(0.6, Math.max(0.12, rangePct / 4));
    const sw = swings(pts, pct);
    g.markers.setMarkers(sw.map((s) => ({
      time: Math.floor(s.time / 1000) + 19800,
      position: s.type === 'peak' ? 'aboveBar' : 'belowBar',
      shape: 'circle', size: s.extreme ? 1 : 0.5,
      color: s.type === 'peak' ? g.C.green : g.C.red,
      text: s.extreme ? `${s.type === 'peak' ? 'H' : 'L'} ${nf.format(s.price)}` : nf.format(s.price),
    })));
    g.chart.timeScale().fitContent();
    const last = pts.at(-1)[1]; const chg = prev ? ((last - prev) / prev) * 100 : null;
    const hiS = sw.find((s) => s.extreme && s.type === 'peak'); const loS = sw.find((s) => s.extreme && s.type === 'trough');
    const turns = sw.filter((s) => !s.extreme).length;
    legend.innerHTML = `<b>${esc(INDEX[u].name)}</b> ${nf.format(last)} ${chg == null ? '' : `<b class="${chg >= 0 ? 'pos' : 'neg'}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</b>`} · H ${nf.format(hi)} <span class="muted">${hhmm(hiS.time)}</span> · L ${nf.format(lo)} <span class="muted">${hhmm(loS.time)}</span> · range ${rangePct.toFixed(2)}% · ${turns} swing${turns === 1 ? '' : 's'}${day !== istDay(now) ? ` · <span class="muted">session of ${day}</span>` : ''}`;
    const pe = $('#intraday-pct'); if (pe) pe.textContent = `${pct.toFixed(2)}%`;
    g.key = key; g.at = Date.now();
  } catch (e) {
    legend.textContent = `Couldn't load the intraday chart: ${e.message}`;
  } finally { loading = false; }
}
