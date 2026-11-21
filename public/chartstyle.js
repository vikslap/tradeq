// Candles or OHLC bars — one switch for every chart, remembered on this device.
import { CandlestickSeries, BarSeries } from './vendor/lightweight-charts.mjs';

const KEY = 'tq-chart-style';
export function getChartStyle() { try { return localStorage.getItem(KEY) === 'bars' ? 'bars' : 'candles'; } catch { return 'candles'; } }
export function setChartStyle(v) { try { localStorage.setItem(KEY, v); } catch { /* private mode */ } }

/** Price series in the chosen style. C: { green, red }; extra: more series options. */
export function addPriceSeries(chart, C, extra = {}) {
  return getChartStyle() === 'bars'
    ? chart.addSeries(BarSeries, { upColor: C.green, downColor: C.red, openVisible: true, thinBars: false, ...extra })
    : chart.addSeries(CandlestickSeries, { upColor: C.green, downColor: C.red, borderVisible: false, wickUpColor: C.green, wickDownColor: C.red, ...extra });
}

export const styleButton = () => {
  const bars = getChartStyle() === 'bars';
  return `<button type="button" class="btn ghost sm" data-chart-style title="Switch between candlesticks and OHLC bars">${bars ? '┤├ Bars' : '🕯️ Candles'}</button>`;
};

// One listener for every chart: flip the style, relabel the buttons, tell charts to redraw.
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-chart-style]'); if (!b) return;
    e.preventDefault();
    setChartStyle(getChartStyle() === 'bars' ? 'candles' : 'bars');
    document.querySelectorAll('[data-chart-style]').forEach((x) => { x.outerHTML = styleButton(); });
    window.dispatchEvent(new CustomEvent('tq:chartstyle', { detail: getChartStyle() }));
  });
}
