// Moving-average lines: which ones are on, and what colour each one is.
// Remembered on this device and shared by every chart (trade charts and Practice).
export const MA_PERIODS = [20, 50, 200];
export const MA_DEFAULTS = { 20: '#f59e0b', 50: '#38bdf8', 200: '#a78bfa' };

const COLOR_KEY = 'tq-ma-colors';
const PRACTICE_KEY = 'tq-pa-emas';
const HEX = /^#[0-9a-f]{6}$/i;

function readColors() {
  try { const v = JSON.parse(localStorage.getItem(COLOR_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

/** Colour for an MA period: the user's pick, else the default. */
export function maColor(n) {
  const c = readColors()[n];
  return HEX.test(c || '') ? c : (MA_DEFAULTS[n] || '#94a3b8');
}

export function setMaColor(n, color) {
  if (!HEX.test(color)) return;
  const all = readColors(); all[n] = color.toLowerCase();
  try { localStorage.setItem(COLOR_KEY, JSON.stringify(all)); } catch { /* private mode */ }
}

export function resetMaColors() { try { localStorage.removeItem(COLOR_KEY); } catch { /* ignore */ } }

/** A short signature of the current colours, for chart cache keys. */
export const maColorKey = () => MA_PERIODS.map(maColor).join('');

/** MAs switched on in Practice (defaults to all three). */
export function practiceMas() {
  try {
    const v = localStorage.getItem(PRACTICE_KEY);
    return v == null ? [...MA_PERIODS] : v.split(',').filter(Boolean).map(Number).filter((n) => MA_PERIODS.includes(n));
  } catch { return [...MA_PERIODS]; }
}
export function setPracticeMas(list) { try { localStorage.setItem(PRACTICE_KEY, list.join(',')); } catch { /* ignore */ } }

/**
 * Toggle chips with a colour swatch for each MA.
 * on: periods currently shown; attr: the checkbox data attribute (e.g. 'data-action-ema').
 */
export function maChips(on, attr) {
  return `<div class="chips ma-chips">${MA_PERIODS.map((n) => {
    const c = maColor(n);
    return `<span class="ma-item"><label><input type="checkbox" ${attr}="${n}" ${on.includes(n) ? 'checked' : ''}><span class="ema-chip" style="box-shadow:inset 3px 0 0 ${c}">EMA ${n}</span></label><input type="color" class="ma-color" data-ma-color="${n}" value="${c}" title="Colour of EMA ${n}" aria-label="Colour of EMA ${n}"></span>`;
  }).join('')}</div>`;
}

// One listener for every chart: save the colour, repaint the chips, tell charts to redraw.
if (typeof document !== 'undefined') {
  document.addEventListener('change', (e) => {
    const inp = e.target.closest?.('[data-ma-color]'); if (!inp) return;
    const n = +inp.dataset.maColor;
    setMaColor(n, inp.value);
    document.querySelectorAll(`[data-ma-color="${n}"]`).forEach((x) => {
      x.value = maColor(n);
      const chip = x.closest('.ma-item')?.querySelector('.ema-chip');
      if (chip) chip.style.boxShadow = `inset 3px 0 0 ${maColor(n)}`;
    });
    window.dispatchEvent(new CustomEvent('tq:chartstyle', { detail: 'ma-color' }));
  });
}
