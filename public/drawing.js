// Drawing tools for Lightweight Charts: trendline, horizontal line and ruler.
// Drawings are anchored by (time, price), so they stay put when you change candle
// size, and are saved in this browser per chart key (a trade or a practice session).

const NS = 'http://www.w3.org/2000/svg';
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const nf = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------- time ⇄ logical index (pure, tested) ----------
/** Fractional bar index for a timestamp; extrapolates before the first / after the last bar. */
export function timeToLogical(T, ms) {
  const n = T.length;
  if (!n) return 0;
  if (n === 1) return 0;
  if (ms <= T[0]) return (ms - T[0]) / ((T[1] - T[0]) || 1);
  if (ms >= T[n - 1]) return n - 1 + (ms - T[n - 1]) / ((T[n - 1] - T[n - 2]) || 1);
  let lo = 0; let hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (T[mid] <= ms) lo = mid; else hi = mid; }
  return lo + (ms - T[lo]) / ((T[hi] - T[lo]) || 1);
}

/** Timestamp for a fractional bar index (inverse of timeToLogical). */
export function logicalToTime(T, l) {
  const n = T.length;
  if (!n) return 0;
  if (n === 1) return T[0];
  if (l <= 0) return T[0] + l * (T[1] - T[0]);
  if (l >= n - 1) return T[n - 1] + (l - (n - 1)) * (T[n - 1] - T[n - 2]);
  const i = Math.floor(l);
  return T[i] + (l - i) * (T[i + 1] - T[i]);
}

/** Ruler numbers between two anchors. */
export function measure(T, a, b) {
  const dp = b.p - a.p;
  const bars = Math.round(Math.abs(timeToLogical(T, b.t) - timeToLogical(T, a.t)));
  return { dp, pct: a.p ? dp / a.p : 0, bars, ms: Math.abs(b.t - a.t) };
}

const span = (ms) => {
  const d = ms / 86400000;
  if (d >= 60) return `${Math.round(d / 30.4)}mo`;
  if (d >= 1) return `${Math.round(d)}d`;
  const h = ms / 3600000;
  return h >= 1 ? `${Math.round(h)}h` : `${Math.round(ms / 60000)}m`;
};

/** Distance from point P to segment AB (pixels). */
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax; const dy = by - ay; const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// ---------- overlay ----------
/**
 * opts: { chart, series, host (the chart's container), times: () => ms[], candles: () => [[ms,o,h,l,c]], key, onTool(tool) }
 * Returns { setTool, tool, clear, redraw, reload, destroy }.
 */
export function attachDrawings({ chart, series, host, times, candles = () => [], key, onTool }) {
  // Toolbar buttons live in the nearest [data-chart-wrap]; keep their "on" state in sync.
  onTool ||= (t) => host.closest('[data-chart-wrap]')?.querySelectorAll('[data-draw]').forEach((b) => b.classList.toggle('on', b.dataset.draw === t));
  const store = { load() { try { return JSON.parse(localStorage.getItem(`tq-draw:${key}`) || '[]'); } catch { return []; } }, save(d) { try { localStorage.setItem(`tq-draw:${key}`, JSON.stringify(d)); } catch { /* full/private */ } } };
  let drawings = store.load();
  let tool = 'none'; let pending = null; let hover = null; let ruler = null; let selected = null; let drag = null;

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'tq-draw');
  svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:4;overflow:visible';
  host.style.position = host.style.position || 'relative';
  host.appendChild(svg);

  const ts = chart.timeScale();
  const xOf = (t) => { const T = times(); const x0 = ts.logicalToCoordinate(0); const x1 = ts.logicalToCoordinate(1); return x0 == null || x1 == null ? null : x0 + timeToLogical(T, t) * (x1 - x0); };
  const tOf = (x) => { const T = times(); const x0 = ts.logicalToCoordinate(0); const x1 = ts.logicalToCoordinate(1); return logicalToTime(T, (x - x0) / ((x1 - x0) || 1)); };
  const yOf = (p) => series.priceToCoordinate(p);
  const pOf = (y) => series.coordinateToPrice(y);

  /** Pointer → anchor, with magnet snapping to the nearest O/H/L/C within 10px. */
  function anchorAt(clientX, clientY, snap = true) {
    const r = host.getBoundingClientRect(); const x = clientX - r.left; const y = clientY - r.top;
    let t = tOf(x); let p = pOf(y);
    if (snap) {
      const T = times(); const C = candles();
      const i = Math.round(timeToLogical(T, t));
      if (C[i]) {
        let best = null;
        for (const v of [C[i][1], C[i][2], C[i][3], C[i][4]]) { const d = Math.abs(yOf(v) - y); if (d < 10 && (!best || d < best.d)) best = { v, d }; }
        if (best) { p = best.v; t = C[i][0]; }
      }
    }
    return { t, p, x, y };
  }

  const el = (name, attrs) => { const e = document.createElementNS(NS, name); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

  function redraw() {
    const W = host.clientWidth; const priceAxis = chart.priceScale('right').width() || 60; const plotW = W - priceAxis;
    const C = { accent: css('--accent') || '#8b6cff', gold: css('--gold') || '#fbbf24', green: css('--green'), red: css('--red'), text: css('--text'), panel: css('--panel') };
    svg.replaceChildren();
    const clip = el('clipPath', { id: `clip-${key.replace(/[^a-z0-9]/gi, '')}` }); clip.appendChild(el('rect', { x: 0, y: 0, width: plotW, height: host.clientHeight }));
    const defs = el('defs', {}); defs.appendChild(clip); svg.appendChild(defs);
    const g = el('g', { 'clip-path': `url(#${clip.id})` }); svg.appendChild(g);
    const handles = [];
    const all = [...drawings, ...(pending && hover ? [{ ...pending, b: hover, preview: true }] : [])];
    for (const d of all) {
      const sel = selected === d.id;
      if (d.type === 'hline') {
        const y = yOf(d.a.p); if (y == null) continue;
        g.appendChild(el('line', { x1: 0, x2: plotW, y1: y, y2: y, stroke: C.gold, 'stroke-width': sel ? 2.5 : 1.5, 'stroke-dasharray': '6 4' }));
        const lab = el('text', { x: 6, y: y - 4, fill: C.gold, 'font-size': 10.5, 'font-family': 'JetBrains Mono, monospace' }); lab.textContent = nf.format(d.a.p); g.appendChild(lab);
        if (sel) handles.push({ d, end: 'a', x: 18, y });
      } else if (d.type === 'trend') {
        const ax = xOf(d.a.t); const ay = yOf(d.a.p); const bx = xOf(d.b.t); const by = yOf(d.b.p);
        if ([ax, ay, bx, by].some((v) => v == null)) continue;
        g.appendChild(el('line', { x1: ax, y1: ay, x2: bx, y2: by, stroke: C.accent, 'stroke-width': sel ? 2.5 : 2, 'stroke-linecap': 'round', opacity: d.preview ? 0.7 : 1 }));
        if (sel || d.preview) { handles.push({ d, end: 'a', x: ax, y: ay }, { d, end: 'b', x: bx, y: by }); }
      }
    }
    // Ruler (temporary).
    const R = ruler && (ruler.b || hover) ? { a: ruler.a, b: ruler.b || hover } : null;
    if (R) {
      const ax = xOf(R.a.t); const ay = yOf(R.a.p); const bx = xOf(R.b.t); const by = yOf(R.b.p);
      if (![ax, ay, bx, by].some((v) => v == null)) {
        const m = measure(times(), R.a, R.b);
        const col = m.dp >= 0 ? C.green : C.red;
        g.appendChild(el('rect', { x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay), fill: col, opacity: 0.14 }));
        g.appendChild(el('line', { x1: ax, y1: ay, x2: bx, y2: by, stroke: col, 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }));
        const label = `${m.dp >= 0 ? '+' : ''}${nf.format(m.dp)} (${m.dp >= 0 ? '+' : ''}${(m.pct * 100).toFixed(2)}%) · ${m.bars} bars · ${span(m.ms)}`;
        const lx = Math.min(Math.max(bx, 8), plotW - 8); const ly = by + (m.dp >= 0 ? -14 : 22);
        const txt = el('text', { x: lx, y: ly, 'text-anchor': bx > plotW - 160 ? 'end' : 'start', fill: '#fff', 'font-size': 11, 'font-weight': 600, 'font-family': 'JetBrains Mono, monospace' });
        txt.textContent = label;
        g.appendChild(txt);
        const bb = txt.getBBox();
        g.insertBefore(el('rect', { x: bb.x - 6, y: bb.y - 3, width: bb.width + 12, height: bb.height + 6, rx: 5, fill: col }), txt);
      }
    }
    // Endpoint handles (draggable when a drawing is selected).
    for (const h of handles) {
      const c = el('circle', { cx: h.x, cy: h.y, r: 5, fill: C.panel || '#121723', stroke: C.accent, 'stroke-width': 2, style: h.d.preview ? 'pointer-events:none' : 'pointer-events:all;cursor:grab' });
      if (!h.d.preview) c.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); drag = { id: h.d.id, end: h.end }; chart.applyOptions({ handleScroll: false, handleScale: false }); });
      svg.appendChild(c);
    }
    // While a tool is active, a transparent layer captures clicks (chart panning pauses).
    if (tool !== 'none') {
      const cap = el('rect', { x: 0, y: 0, width: plotW, height: host.clientHeight, fill: 'transparent', style: 'pointer-events:all;cursor:crosshair' });
      cap.addEventListener('pointerdown', onCapDown);
      cap.addEventListener('pointermove', (e) => { hover = anchorAt(e.clientX, e.clientY, tool === 'trend'); redraw(); });
      svg.appendChild(cap);
    }
  }

  function setTool(t) {
    tool = t; pending = null; hover = null; if (t !== 'ruler') ruler = null;
    if (t !== 'none') selected = null;
    redraw(); onTool(tool);
  }

  function onCapDown(e) {
    e.preventDefault();
    const a = anchorAt(e.clientX, e.clientY, tool === 'trend');
    if (tool === 'hline') { drawings.push({ id: crypto.randomUUID(), type: 'hline', a: { t: a.t, p: a.p } }); store.save(drawings); setTool('none'); return; }
    if (tool === 'trend') {
      if (!pending) { pending = { id: 'preview', type: 'trend', a: { t: a.t, p: a.p } }; hover = a; redraw(); return; }
      drawings.push({ id: crypto.randomUUID(), type: 'trend', a: pending.a, b: { t: a.t, p: a.p } }); store.save(drawings); setTool('none'); return;
    }
    if (tool === 'ruler') {
      if (!ruler || ruler.b) { ruler = { a: { t: a.t, p: a.p } }; hover = a; redraw(); return; }
      ruler.b = { t: a.t, p: a.p }; tool = 'none'; onTool(tool); redraw(); // the result stays until the next click
    }
  }

  // Shift+click anywhere starts a ruler; a plain click selects the nearest drawing.
  function onHostClick(e) {
    if (tool !== 'none') return;
    if (e.shiftKey) { const a = anchorAt(e.clientX, e.clientY, false); ruler = { a: { t: a.t, p: a.p } }; hover = a; tool = 'ruler'; onTool(tool); redraw(); return; }
    if (ruler?.b) { ruler = null; }
    const r = host.getBoundingClientRect(); const x = e.clientX - r.left; const y = e.clientY - r.top;
    let best = null;
    for (const d of drawings) {
      let dist = Infinity;
      if (d.type === 'hline') { const yy = yOf(d.a.p); if (yy != null) dist = Math.abs(yy - y); }
      else { const ax = xOf(d.a.t); const ay = yOf(d.a.p); const bx = xOf(d.b.t); const by = yOf(d.b.p); if (![ax, ay, bx, by].some((v) => v == null)) dist = distToSeg(x, y, ax, ay, bx, by); }
      if (dist < 7 && (!best || dist < best.dist)) best = { d, dist };
    }
    selected = best ? best.d.id : null;
    redraw();
  }

  function onMove(e) {
    if (!drag) return;
    const d = drawings.find((x) => x.id === drag.id); if (!d) return;
    const a = anchorAt(e.clientX, e.clientY, d.type === 'trend');
    d[drag.end] = d.type === 'hline' ? { t: d.a.t, p: a.p } : { t: a.t, p: a.p };
    redraw();
  }
  function onUp() { if (!drag) return; drag = null; chart.applyOptions({ handleScroll: true, handleScale: true }); store.save(drawings); }

  function onKey(e) {
    if (!host.isConnected) return;
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    if (e.key === 'Escape' && (tool !== 'none' || ruler || selected)) { e.stopPropagation(); ruler = null; selected = null; setTool('none'); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
      e.preventDefault(); drawings = drawings.filter((d) => d.id !== selected); selected = null; store.save(drawings); redraw();
    }
  }

  host.addEventListener('click', onHostClick);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  document.addEventListener('keydown', onKey, true);
  ts.subscribeVisibleLogicalRangeChange(redraw);
  chart.subscribeCrosshairMove(() => { if (!drag) redraw(); });
  const ro = new ResizeObserver(() => redraw()); ro.observe(host);
  requestAnimationFrame(redraw);

  const api = {
    setTool, redraw,
    tool: () => tool,
    count: () => drawings.length,
    clear() { drawings = []; ruler = null; selected = null; store.save(drawings); redraw(); },
    reload() { drawings = store.load(); redraw(); },
    destroy() {
      host.removeEventListener('click', onHostClick);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.removeEventListener('keydown', onKey, true);
      ro.disconnect(); svg.remove();
      delete host.dataset.hasDraw; delete host._draw;
    },
  };
  host.dataset.hasDraw = '1';
  host._draw = api;
  return api;
}

/** Route a toolbar click to the chart in the same [data-chart-wrap]. */
export function handleDrawClick(btn) {
  const d = btn.closest('[data-chart-wrap]')?.querySelector('[data-has-draw]')?._draw;
  if (!d) return;
  const t = btn.dataset.draw;
  if (t === 'clear') { if (d.count() === 0 || window.confirm('Remove all drawings on this chart?')) d.clear(); return; }
  d.setTool(d.tool() === t ? 'none' : t);
}

/** Toolbar buttons; wire clicks with data-draw="trend|hline|ruler|clear". */
export const drawToolbar = (active = 'none') => `<span class="draw-bar">
  <button type="button" class="btn ghost sm ${active === 'trend' ? 'on' : ''}" data-draw="trend" title="Trendline — click two points (snaps to candles)">╱ Trend</button>
  <button type="button" class="btn ghost sm ${active === 'hline' ? 'on' : ''}" data-draw="hline" title="Horizontal line — click once">─ Level</button>
  <button type="button" class="btn ghost sm ${active === 'ruler' ? 'on' : ''}" data-draw="ruler" title="Ruler — click two points (or Shift+click)">📏 Ruler</button>
  <button type="button" class="btn ghost sm" data-draw="clear" title="Remove all drawings on this chart">🗑</button></span>`;
