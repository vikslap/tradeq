// 🧮 Position size calculator page.
import { sizePosition } from '../position.js';
import { metrics } from '../game.js';
import { S, api } from './state.js';
import { $, esc, money, pct, nf0, price } from './util.js';
import { clientSearch, searchLocal } from './kiteinst.js';
import { openTradeForm } from './forms.js';

const DEFAULTS = { symbol: '', exchange: 'NSE', segment: 'EQ', side: 'LONG', hold: 'OVERNIGHT', entry: '', stop: '', target: '', lotSize: 1, riskPct: null, slippagePct: 0.1 };
const cur = () => (S.sizer ||= { ...DEFAULTS });
/** Open the calculator with a stock filled in (from the heatmap). */
export const prefillSizer = (o) => { S.sizer = { ...DEFAULTS, ...(S.sizer || {}), stop: '', target: '', ...o }; };

export function openRiskNow() {
  return S.state.trades.filter((t) => t.status === 'OPEN').reduce((a, t) => { const r = metrics(t).openRisk; return a + (r > 0 ? r : 0); }, 0);
}

const radio = (name, opts, val) => opts.map(([v, l]) => `<label><input type="radio" name="${name}" value="${v}" ${val === v ? 'checked' : ''}><span>${l}</span></label>`).join('');

export function pageSizer() {
  const v = cur(); const s = S.state.settings;
  const riskPct = v.riskPct ?? s.riskPctPerTrade ?? 1;
  return `<div class="page-h"><div><h1>🧮 Position size</h1><p>How much to buy so a stop-out costs exactly what you planned — charges and slippage included.</p></div></div>
  <div class="sizer-grid">
    <form class="card stack" id="sizer-form" autocomplete="off" onsubmit="return false">
      <div class="grid-3">
        <div class="field" style="grid-column:span 2"><label>Symbol <span class="faint">(optional)</span></label>
          <div class="row" style="gap:6px"><input class="input" name="symbol" value="${esc(v.symbol)}" placeholder="e.g. INFY, NIFTY26DECFUT" style="text-transform:uppercase;flex:1">
          ${S.kite.connected ? '<button class="btn" type="button" data-sizer="lookup" title="Fill lot size and live price from Kite">⚡ Fetch</button>' : ''}</div></div>
        <div class="field"><label>Exchange</label><select class="input" name="exchange">${['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS'].map((x) => `<option ${v.exchange === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Instrument</label><div class="seg">${radio('segment', [['EQ', 'Stock / ETF'], ['FUT', 'Futures'], ['OPT', 'Options'], ['COM', 'Commodity']], v.segment)}</div></div>
      <div class="grid-2">
        <div class="field"><label>Direction</label><div class="seg">${radio('side', [['LONG', 'Buy'], ['SHORT', 'Short / sell']], v.side)}</div></div>
        <div class="field"><label>Holding</label><div class="seg">${radio('hold', [['INTRADAY', 'Intraday'], ['OVERNIGHT', 'Overnight +']], v.hold)}</div></div>
      </div>
      <div class="grid-3">
        <div class="field"><label>Entry ₹</label><input class="input num" name="entry" type="number" step="any" min="0" value="${v.entry}"></div>
        <div class="field"><label>Stop-loss ₹</label><input class="input num" name="stop" type="number" step="any" min="0" value="${v.stop}"></div>
        <div class="field"><label>Target ₹ <span class="faint">(optional)</span></label><input class="input num" name="target" type="number" step="any" min="0" value="${v.target}"></div>
      </div>
      <div class="grid-3">
        <div class="field"><label>Risk % of capital</label><input class="input num" name="riskPct" type="number" step="0.05" min="0" value="${riskPct}"><div class="hint">of ${money(s.capital, { dp: 0 })} · cap ${money(s.maxRiskPerTrade, { dp: 0 })}</div></div>
        <div class="field"><label>Slippage %</label><input class="input num" name="slippagePct" type="number" step="0.05" min="0" value="${v.slippagePct}"><div class="hint">extra loss when the stop fills</div></div>
        <div class="field" id="lot-field"><label>Lot size</label><input class="input num" name="lotSize" type="number" step="1" min="1" value="${v.lotSize}"><div class="hint">1 for shares</div></div>
      </div>
      <p class="faint" style="font-size:12px;margin:0">Defaults come from Settings (risk ${s.riskPctPerTrade ?? 1}% per trade, max position ${s.maxPositionPct}%, max open risk ${s.maxPortfolioHeatPct}%). Changing them here doesn't save anything.</p>
    </form>
    <section class="card" id="sizer-out"></section>
  </div>`;
}

function readForm() {
  const f = $('#sizer-form'); if (!f) return null;
  const fd = new FormData(f);
  const v = { ...cur() };
  for (const k of ['symbol', 'exchange', 'segment', 'side', 'hold', 'entry', 'stop', 'target', 'lotSize', 'riskPct', 'slippagePct']) if (fd.has(k)) v[k] = fd.get(k);
  v.symbol = String(v.symbol || '').toUpperCase().trim();
  S.sizer = v;
  return v;
}

function result() {
  const v = readForm(); if (!v) return;
  const s = S.state.settings;
  const lotField = $('#lot-field'); if (lotField) lotField.style.opacity = v.segment === 'EQ' ? 0.5 : 1;
  const openRisk = openRiskNow();
  const r = sizePosition({ ...v, intraday: v.hold === 'INTRADAY', lotSize: v.segment === 'EQ' ? 1 : v.lotSize }, { ...s, riskPctPerTrade: Number(v.riskPct) }, openRisk);
  const out = $('#sizer-out'); if (!out) return;
  if (r.errors.length && !r.qty) {
    out.innerHTML = `<h3 style="margin-top:0">Result</h3>${r.errors.map((e) => `<div class="note warn">${esc(e)}</div>`).join('')}
      ${r.budget ? `<div class="stat-line" style="margin-top:10px"><span class="muted">Risk budget</span><b>${money(r.budget, { dp: 0 })}</b></div>` : ''}`;
    return;
  }
  const unit = r.lotSize > 1 ? `${nf0.format(r.lots)} lot${r.lots === 1 ? '' : 's'} · ${nf0.format(r.qty)} units` : `${nf0.format(r.qty)} share${r.qty === 1 ? '' : 's'}`;
  const line = (k, val, cls = '') => `<div class="stat-line"><span class="muted">${k}</span><b class="${cls}">${val}</b></div>`;
  out.innerHTML = `
    <div class="muted" style="font-size:12px;text-transform:uppercase;letter-spacing:.06em">${v.side === 'SHORT' ? 'Sell' : 'Buy'}${v.symbol ? ` ${esc(v.symbol)}` : ''}</div>
    <div class="mono" style="font-size:34px;font-weight:700;line-height:1.1;margin:4px 0 2px">${r.qty ? unit : '0'}</div>
    <div class="faint" style="font-size:12.5px;margin-bottom:12px">Budget ${money(r.budget, { dp: 0 })} (${r.budgetBy === 'pct' ? `${v.riskPct}% of capital` : 'your ₹ cap per trade'}) · open risk now ${money(openRisk, { dp: 0 })}</div>
    ${r.limits.map((l) => `<div class="note warn" style="margin-bottom:8px">⚖️ ${esc(l.text)}</div>`).join('')}
    ${!r.qty ? (r.byRisk ? `<div class="faint" style="font-size:12.5px">Your risk budget alone would allow ${nf0.format(r.byRisk)} ${r.lotSize > 1 ? 'units' : 'shares'}.</div>` : '') : `${line('Position value', `${money(r.value, { dp: 0 })} <span class="faint">${pct(r.pctCapital, 1)} of capital</span>`)}
    ${line(r.premiumRisk ? 'Max loss (whole premium + charges)' : 'Loss if stopped out', `<span class="neg">${money(-r.risk.total, { dp: 0 })}</span> <span class="faint">${pct(r.riskPct, 2)} of capital</span>`)}
    ${r.premiumRisk ? '' : `<div class="faint" style="font-size:12px;margin:-2px 0 6px;text-align:right">move ${money(r.risk.move, { dp: 0 })} + slippage ${money(r.risk.slip, { dp: 0 })} + charges ${money(r.risk.charges, { dp: 0 })}</div>`}
    ${r.reward ? line('Profit at target (after charges)', `<span class="pos">${money(r.reward.net, { sign: true, dp: 0 })}</span>`) : ''}
    ${r.rr != null ? line('Reward : risk', `${r.rr.toFixed(2)} : 1`, r.rr >= 2 ? 'pos' : r.rr < 1.5 ? 'neg' : '') : ''}
    ${line('Charges, in and out', money(r.chargesRoundTrip, { dp: 0 }))}
    ${r.breakeven != null ? line('Break-even price', `${price(r.breakeven)} <span class="faint">needs ${pct(Math.abs(r.breakeven - Number(v.entry)) / Number(v.entry), 2)} just to cover charges</span>`) : ''}
    ${r.warnings.map((w) => `<div class="note" style="margin-top:8px">⚠️ ${esc(w)}</div>`).join('')}
    <button class="btn primary" type="button" data-sizer="log" style="width:100%;margin-top:14px">📝 Log this trade</button>`}`;
}

export function mountSizer() {
  const f = $('#sizer-form'); if (!f) return;
  if (!f.dataset.bound) {
    f.dataset.bound = '1';
    f.addEventListener('input', result);
    f.closest('.sizer-grid').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-sizer]'); if (!b) return;
      const v = readForm();
      if (b.dataset.sizer === 'log') {
        const r = sizePosition({ ...v, intraday: v.hold === 'INTRADAY', lotSize: v.segment === 'EQ' ? 1 : v.lotSize }, { ...S.state.settings, riskPctPerTrade: Number(v.riskPct) }, openRiskNow());
        openTradeForm(null, { symbol: v.symbol, exchange: v.exchange, segment: v.segment, side: v.side, qty: r.qty, entryPrice: Number(v.entry) || undefined, stopLoss: v.stop === '' ? undefined : Number(v.stop), target: v.target === '' ? undefined : Number(v.target), lotSize: Number(v.lotSize) || 1, horizon: v.hold === 'INTRADAY' ? 'INTRADAY' : 'SWING' });
      }
      if (b.dataset.sizer === 'lookup') {
        if (!v.symbol) return;
        try {
          const hits = clientSearch() ? await searchLocal(v.symbol) : (await api('/api/kite/search?q=' + encodeURIComponent(v.symbol))).results;
          const h = hits.find((x) => x.symbol === v.symbol) || hits[0];
          if (h) Object.assign(S.sizer, { symbol: h.symbol, exchange: h.exchange, segment: h.segment === 'EQ' ? 'EQ' : h.segment, lotSize: h.lotSize || 1 });
          const key = `${S.sizer.exchange}:${S.sizer.symbol}`;
          const q = (await api(`/api/kite/quote?i=${encodeURIComponent(key)}`)).quotes[key];
          if (q?.last) S.sizer.entry = q.last;
          const host = $('#main'); host.innerHTML = pageSizer(); host._html = null; mountSizer();
        } catch (err) { const o = $('#sizer-out'); if (o) o.insertAdjacentHTML('afterbegin', `<div class="note warn">${esc(err.message)}</div>`); }
      }
    });
  }
  result();
}
