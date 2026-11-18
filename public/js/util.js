


// =====================================================================
// Utilities
// =====================================================================
export const $ = (s, r = document) => r.querySelector(s);

export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const nf2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const nf0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

export const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

export const sum = (a) => a.reduce((s, x) => s + x, 0);

export const money = (v, { sign = false, dp = 2 } = {}) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const f = dp ? nf2 : nf0;
  return `${v < 0 ? '−' : sign && v > 0 ? '+' : ''}₹${f.format(Math.abs(v))}`;
};

export const compact = (v) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v); const s = v < 0 ? '−' : '';
  if (a >= 1e7) return `${s}₹${(a / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(2)}L`;
  return `${s}₹${nf0.format(a)}`;
};

export const price = (v) => (v == null ? '—' : nf2.format(v));

export const pct = (v, dp = 1) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(dp)}%`);

export const rfmt = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}R`);

export const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—');

export const fmtDT = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

export const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const ago = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`; if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return fmtDate(iso);
};

export const hold = (d) => (d < 1 ? `${Math.max(1, Math.round(d * 24))}h` : `${Math.round(d)}d`);

export const toLocalInput = (iso) => { const d = iso ? new Date(iso) : new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };

export const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

export const xpPill = (x) => (x ? `<span class="xp-pill ${x > 0 ? 'plus' : 'minus'}">${x > 0 ? '+' : ''}${x} XP</span>` : '');


export const EXCHANGES = ['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS'];

export const SEGMENTS = [['EQ', 'Equity'], ['FUT', 'Futures'], ['OPT', 'Options'], ['COM', 'Commodity']];

export const EMO_IN = ['Calm', 'Confident', 'Excited', 'Anxious', 'FOMO', 'Bored', 'Revenge', 'Greedy'];

export const EMO_OUT = ['Calm', 'Satisfied', 'Relieved', 'Frustrated', 'Regretful', 'Euphoric'];

export const LT_EXIT_REASONS = ['Thesis broken', 'Sell condition hit', 'Valuation too rich', 'Better opportunity', 'Needed the money', 'Discretionary'];

export const EXIT_REASONS = ['Target hit', 'Stop hit', 'Trailing stop', 'Thesis invalid', 'Time exit', 'Discretionary'];

export const DEFAULT_SETUPS = ['Breakout', 'Range breakout', 'Breakdown', 'Pullback', 'Trend continuation', 'Reversal', 'Support bounce', 'Gap play', 'Earnings'];

export const MANTRAS = ['Plan the trade. Trade the plan.', 'The stop is a promise to yourself.', 'Risk first, reward second.', 'No setup, no trade.', 'Small losses are tuition, not failure.', 'Sitting out is a position too.', 'Process today, profits later.'];


export function guessSegment(exchange, symbol = '') {
  if (exchange === 'MCX') return /(CE|PE)$/.test(symbol) ? 'OPT' : 'COM';
  if (exchange === 'NFO' || exchange === 'BFO') return /\d(CE|PE)$/.test(symbol) ? 'OPT' : 'FUT';
  return 'EQ';
}


// =====================================================================
// Pages
// =====================================================================
export function ring(p, size, stroke, color) {
  const r = (size - stroke) / 2; const c = 2 * Math.PI * r; const v = Math.max(0, Math.min(1, p || 0));
  return `<svg class="ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="var(--ring-bg)" stroke-width="${stroke}" fill="none"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="${color}" stroke-width="${stroke}" fill="none" stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - v)).toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`;
}


export let starSeq = 0;

export function stars(name, val) {
  const p = `${name}-${++starSeq}`;
  return `<div class="stars">${[5, 4, 3, 2, 1].map((n) => `<input type="radio" id="${p}-${n}" name="${name}" value="${n}" ${val === n ? 'checked' : ''}><label for="${p}-${n}" title="${n}">★</label>`).join('')}</div>`;
}


export const radios = (name, opts, val, cls = '') => opts.map(([v, l, c]) => `<label><input type="radio" name="${name}" value="${esc(v)}" ${String(val) === String(v) ? 'checked' : ''}><span class="${c || cls}">${l}</span></label>`).join('');


// Only touch the DOM when the content changed, so a click that starts while a blur
// triggers a re-render still lands on the same button.
export function paint(el, html) { if (el._html !== html) { el.innerHTML = html; el._html = html; } }


export function setRadio(form, name, value) { const r = form.querySelector(`input[name="${name}"][value="${value}"]`); if (r) r.checked = true; }
