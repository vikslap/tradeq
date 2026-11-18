// Interactive trade chart built on TradingView Lightweight Charts (Apache-2.0, vendored).
import { attachDrawings } from './drawing.js';
import { createChart, CandlestickSeries, HistogramSeries, LineSeries, BaselineSeries, LineStyle, LineType, CrosshairMode, createSeriesMarkers } from './vendor/lightweight-charts.mjs';

const IST = 19800; // seconds
const nf = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nfc = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const alpha = (hex, a) => {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};

export const INTERVAL_LABEL = { '5minute': '5m', '15minute': '15m', '60minute': '1h', day: '1D', week: '1W' };
const STEP = { '5minute': 300e3, '15minute': 900e3, '60minute': 3600e3, day: 86400e3, week: 7 * 86400e3 };

/** Kite candle ms → chart time. Intraday shifted to IST clock; daily/weekly as IST calendar dates. */
function toTime(ms, interval) {
  if (interval === 'day' || interval === 'week') return new Date(ms + IST * 1000).toISOString().slice(0, 10);
  return Math.floor(ms / 1000) + IST;
}

function ema(closes, n) {
  const k = 2 / (n + 1); const out = []; let prev = null;
  closes.forEach((c, i) => {
    if (i < n - 1) { out.push(null); return; }
    prev = prev == null ? closes.slice(0, n).reduce((a, b) => a + b, 0) / n : c * k + prev * (1 - k);
    out.push(prev);
  });
  return out;
}

/**
 * Mount a chart for a trade. Returns { el, chart, setLive(price), destroy() }.
 * opts: { height, emas: [20, 50], showVolume }
 */
export function mountTradeChart(container, t, { candles, interval }, opts = {}) {
  const C = {
    text: css('--muted'), faint: css('--faint'), grid: css('--row-line') || css('--border'), border: css('--border'),
    green: css('--green'), red: css('--red'), accent: css('--accent'), gold: css('--gold'), bg: css('--panel'),
  };
  const el = document.createElement('div');
  el.className = 'tq-chart';
  el.style.height = `${opts.height || 340}px`;
  container.replaceChildren(el);
  const legend = document.createElement('div');
  legend.className = 'tq-legend';
  el.appendChild(legend);

  const intraday = interval !== 'day' && interval !== 'week';
  const chart = createChart(el, {
    autoSize: true,
    layout: { background: { color: 'transparent' }, textColor: C.text, fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 11, attributionLogo: true },
    grid: { vertLines: { color: alpha(C.border, 0.35) || C.grid }, horzLines: { color: alpha(C.border, 0.35) || C.grid } },
    crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: { borderColor: C.border, scaleMargins: { top: 0.08, bottom: opts.showVolume === false ? 0.06 : 0.22 } },
    timeScale: { borderColor: C.border, timeVisible: intraday, secondsVisible: false, rightOffset: 4 },
    localization: { priceFormatter: (p) => nf.format(p) },
  });

  const data = candles.map((c) => ({ time: toTime(c[0], interval), open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] || 0 }));
  // Bar index helpers.
  const step = STEP[interval];
  const barAt = (iso) => {
    const ms = new Date(iso).getTime();
    const i = candles.findIndex((c) => c[0] + step > ms);
    return i < 0 ? candles.length - 1 : i;
  };
  const iE = barAt(t.entryTime);
  const iX = t.status === 'CLOSED' && t.exitTime ? barAt(t.exitTime) : data.length - 1;

  // Shade the time in trade: a faint band behind the candles between entry and exit.
  const band = chart.addSeries(HistogramSeries, { priceScaleId: 'band', lastValueVisible: false, priceLineVisible: false, base: 0 });
  chart.priceScale('band').applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false });
  band.setData(data.map((d, i) => (i >= iE && i <= iX ? { time: d.time, value: 1, color: alpha(C.accent, 0.07) } : { time: d.time })));

  // Keep entry, stop, target and exit in view, not just the candles.
  const levels = [t.entryPrice, t.initialStop, t.stopLoss, t.target, t.status === 'CLOSED' ? t.exitPrice : null].filter((v) => v != null);
  const price = chart.addSeries(CandlestickSeries, {
    upColor: C.green, downColor: C.red, borderVisible: false, wickUpColor: C.green, wickDownColor: C.red, priceLineVisible: false,
    autoscaleInfoProvider: (original) => {
      const r = original();
      if (!r || !levels.length) return r;
      return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, ...levels), maxValue: Math.max(r.priceRange.maxValue, ...levels) } };
    },
  });
  price.setData(data);

  if (opts.showVolume !== false) {
    const vol = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    vol.setData(data.map((d) => ({ time: d.time, value: d.volume, color: alpha(d.close >= d.open ? C.green : C.red, 0.35) })));
  }

  const emaColors = { 20: '#f59e0b', 50: '#38bdf8', 200: '#a78bfa' };
  for (const n of opts.emas || []) {
    if (data.length < n) continue;
    const vals = ema(data.map((d) => d.close), n);
    const s = chart.addSeries(LineSeries, { color: emaColors[n] || C.faint, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, title: `EMA ${n}` });
    s.setData(data.map((d, i) => (vals[i] == null ? { time: d.time } : { time: d.time, value: vals[i] })));
  }

  // Plan levels as labelled price lines.
  const line = (p, title, color, style = LineStyle.Dashed, width = 1) => p != null && price.createPriceLine({ price: p, title, color, lineStyle: style, lineWidth: width, axisLabelVisible: true });
  line(t.target, 'TGT', C.green);
  line(t.entryPrice, 'ENTRY', C.accent, LineStyle.Solid, 2);
  line(t.initialStop, 'SL', C.red);
  if (t.status === 'CLOSED') line(t.exitPrice, 'EXIT', C.gold, LineStyle.Solid, 1);

  // Stop as a stepped line over time: shows exactly when you trailed it.
  if (t.initialStop != null || t.stopLoss != null) {
    const pts = [{ i: iE, v: t.initialStop ?? t.stopLoss }];
    for (const h of t.stopHistory || []) if (h.to != null) pts.push({ i: Math.max(iE, barAt(h.at)), v: h.to });
    const stopData = [];
    let cur = pts[0].v; let p = 0;
    for (let i = iE; i <= iX; i++) {
      while (p < pts.length && pts[p].i <= i) { cur = pts[p].v; p++; }
      stopData.push({ time: data[i].time, value: cur });
    }
    const stopS = chart.addSeries(LineSeries, { color: C.red, lineWidth: 2, lineType: LineType.WithSteps, lineStyle: LineStyle.Solid, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    stopS.setData(stopData);
  }

  const long = t.side !== 'SHORT';
  const qty = new Intl.NumberFormat('en-IN').format(t.qty);
  const markers = [{ time: data[iE].time, position: long ? 'belowBar' : 'aboveBar', color: C.accent, shape: long ? 'arrowUp' : 'arrowDown', text: `${long ? 'Buy' : 'Sell'} ${qty} @ ${nf.format(t.entryPrice)}` }];
  for (const h of t.stopHistory || []) {
    const i = barAt(h.at);
    if (i >= iE && i <= iX && h.to != null) markers.push({ time: data[i].time, position: long ? 'belowBar' : 'aboveBar', color: C.red, shape: 'circle', text: `SL → ${nf.format(h.to)}` });
  }
  if (t.status === 'CLOSED') markers.push({ time: data[iX].time, position: long ? 'aboveBar' : 'belowBar', color: C.gold, shape: long ? 'arrowDown' : 'arrowUp', text: `Exit @ ${nf.format(t.exitPrice)}` });
  markers.sort((a, b) => (a.time > b.time ? 1 : a.time < b.time ? -1 : 0));
  createSeriesMarkers(price, markers);

  // OHLC legend that follows the crosshair.
  const fmtLegend = (d) => {
    if (!d) return '';
    const ch = d.close - d.open; const pc = d.open ? (ch / d.open) * 100 : 0;
    const col = ch >= 0 ? C.green : C.red;
    return `<span>O <b>${nf.format(d.open)}</b></span><span>H <b>${nf.format(d.high)}</b></span><span>L <b>${nf.format(d.low)}</b></span><span>C <b style="color:${col}">${nf.format(d.close)}</b></span><span style="color:${col}">${ch >= 0 ? '+' : ''}${pc.toFixed(2)}%</span>${d.volume ? `<span>Vol <b>${nfc.format(d.volume)}</b></span>` : ''}`;
  };
  legend.innerHTML = fmtLegend(data.at(-1));
  chart.subscribeCrosshairMove((param) => {
    const d = param.time ? param.seriesData.get(price) : null;
    legend.innerHTML = fmtLegend(d ? { ...d, volume: data.find((x) => x.time === param.time)?.volume } : data.at(-1));
  });

  // Frame the trade with some context either side.
  const pad = Math.max(8, Math.round((iX - iE) * 0.6));
  chart.timeScale().setVisibleLogicalRange({ from: Math.max(-2, iE - pad), to: Math.min(data.length + 3, iX + pad) });

  const times = candles.map((c) => c[0]);
  const draw = opts.drawKey ? attachDrawings({ chart, series: price, host: el, times: () => times, candles: () => candles, key: opts.drawKey }) : null;

  return {
    el, chart, draw,
    /** Nudge the last candle with a live price (open trades). */
    setLive(p) {
      if (p == null || !data.length) return;
      const last = data.at(-1);
      last.close = p; last.high = Math.max(last.high, p); last.low = Math.min(last.low, p);
      price.update(last);
    },
    destroy() { draw?.destroy(); chart.remove(); },
  };
}


/** Daily equity curve: green above zero, red below, with a hover readout. */
export function mountEquityChart(container, curve, { height = 240 } = {}) {
  const C = { text: css('--muted'), border: css('--border'), green: css('--green'), red: css('--red') };
  const el = document.createElement('div');
  el.className = 'tq-chart'; el.style.height = `${height}px`;
  container.replaceChildren(el);
  const legend = document.createElement('div'); legend.className = 'tq-legend'; el.appendChild(legend);
  const chart = createChart(el, {
    autoSize: true,
    layout: { background: { color: 'transparent' }, textColor: C.text, fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 11, attributionLogo: true },
    grid: { vertLines: { visible: false }, horzLines: { color: alpha(C.border, 0.35) } },
    rightPriceScale: { borderColor: C.border },
    timeScale: { borderColor: C.border, rightOffset: 2 },
    crosshair: { mode: CrosshairMode.Magnet },
    localization: { priceFormatter: (p) => `₹${nfc.format(p)}` },
    handleScroll: false, handleScale: false,
  });
  const s = chart.addSeries(BaselineSeries, {
    baseValue: { type: 'price', price: 0 }, lineWidth: 2, priceLineVisible: false,
    topLineColor: C.green, topFillColor1: alpha(C.green, 0.28), topFillColor2: alpha(C.green, 0.02),
    bottomLineColor: C.red, bottomFillColor1: alpha(C.red, 0.02), bottomFillColor2: alpha(C.red, 0.28),
  });
  s.setData(curve.map((p) => ({ time: p.day, value: p.v })));
  s.createPriceLine({ price: 0, color: alpha(C.text, 0.5), lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false });
  const money = (v) => `${v < 0 ? '−' : v > 0 ? '+' : ''}₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.abs(v))}`;
  const show = (p) => {
    if (!p) { legend.innerHTML = ''; return; }
    const d = new Date(`${p.day}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
    legend.innerHTML = `<span>${d}</span><span>Equity <b style="color:${p.v >= 0 ? C.green : C.red}">${money(p.v)}</b></span>${p.n ? `<span>Day <b style="color:${p.pnl >= 0 ? C.green : C.red}">${money(p.pnl)}</b> · ${p.n} trade${p.n > 1 ? 's' : ''}</span>` : ''}`;
  };
  show(curve.at(-1));
  chart.subscribeCrosshairMove((param) => { show(param.time ? curve.find((p) => p.day === param.time) : curve.at(-1)); });
  chart.timeScale().fitContent();
  return { chart, destroy() { chart.remove(); } };
}
