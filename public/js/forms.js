import { clientSearch, searchLocal } from './kiteinst.js';
import { tradeCharges, exitsOf, CHARGE_LABELS } from '../charges.js';
import { metrics, entryChecks, exitChecks, dayKey, MISTAKE_TAGS, HORIZONS, isLT } from '../game.js';
import { $, esc, nf0, num, sum, money, price, pct, rfmt, cls, fmtTime, hold, toLocalInput, fromLocalInput, xpPill, EXCHANGES, SEGMENTS, EMO_IN, EMO_OUT, LT_EXIT_REASONS, EXIT_REASONS, guessSegment, stars, radios, paint, setRadio } from './util.js';
import { S, api, reload, ltpFor } from './state.js';
import { openModal, closeModal } from './ui.js';
import { setupOptions } from './journal.js';
import { pollQuotes } from './live.js';


// ---------- Trade form (new / edit) ----------
export function openTradeForm(t = null, prefill = {}) {
  const v = { exchange: 'NSE', segment: 'EQ', side: 'LONG', ...prefill, ...(t || {}) };
  const live = S.kite.connected;
  const form = openModal(`
  <form id="trade-form" class="modal" autocomplete="off">
    <div class="modal-h"><h2>${t ? `Edit ${esc(t.symbol)}` : 'New trade'}</h2><button type="button" class="btn ghost sm" data-action="close-modal">✕</button></div>
    <div class="modal-b form-grid">
      <div class="stack">
        <div class="grid-3">
          <div class="field" style="grid-column:span 2"><label>Symbol</label>
            <div class="ac-wrap"><input class="input" name="symbol" value="${esc(v.symbol)}" placeholder="${live ? 'Search: RELIANCE, NIFTY fut, GOLDM…' : 'e.g. RELIANCE'}" required><div class="ac hidden"></div></div>
            <div class="hint" id="sym-hint">${live ? 'Type 2+ letters to search Kite instruments' : 'Manual mode — connect Kite in Settings for search & live prices'}</div></div>
          <div class="field"><label>Exchange</label><select class="input" name="exchange">${EXCHANGES.map((e) => `<option ${v.exchange === e ? 'selected' : ''}>${e}</option>`).join('')}</select></div>
        </div>
        <div class="row wrap" style="gap:16px;align-items:flex-end">
          <div class="field"><label>Type</label><div class="seg">${radios('horizon', HORIZONS, v.horizon || 'SWING')}</div></div>
          <div class="field"><label>Direction</label><div class="seg">${radios('side', [['LONG', '▲ Long', 'long'], ['SHORT', '▼ Short', 'short']], v.side)}</div></div>
          <div class="field"><label>Segment</label><div class="seg">${radios('segment', SEGMENTS.map(([a, b]) => [a, b]), v.segment)}</div></div>
        </div>
        <div class="grid-3">
          <div class="field"><label>Entry price</label><div class="input-row"><input class="input num" name="entryPrice" type="number" step="any" min="0" value="${v.entryPrice ?? ''}" required>
            <button type="button" class="btn live sm" data-action="live-price" data-field="entryPrice" ${live ? '' : 'disabled title="Connect Kite for live prices"'}>⚡ Live</button></div>
            <div class="live-tag" id="tag-entryPrice">${v.entrySource && v.entrySource !== 'manual' ? `⚡ ${v.entrySource === 'kite-fill' ? 'From Kite fill' : 'Live price'}` : ''}</div></div>
          <div class="field"><label>Quantity (units)</label><input class="input num" name="qty" type="number" step="any" min="0" value="${v.qty ?? ''}" required><div class="hint" id="lot-hint">${v.lotSize > 1 ? `1 lot = ${v.lotSize}` : ''}</div></div>
          <div class="field ${v.needDate ? 'need-date' : ''}"><label>Entry time</label><input class="input" name="entryTime" type="datetime-local" value="${v.needDate ? '' : toLocalInput(v.entryTime)}" ${v.needDate ? 'required' : ''}>
            <div class="hint">${v.needDate ? '<span class="neg">Kite doesn\'t share the buy date — when did you buy?</span>' : t ? '' : 'Defaults to now — change it when logging an older trade'}</div></div>
        </div>
        <div class="grid-4">
          <div class="field trade-only"><label>Planned trigger</label><input class="input num" name="plannedEntry" type="number" step="any" min="0" value="${v.plannedEntry ?? ''}" placeholder="optional"></div>
          <div class="field"><label>Stop-loss</label><input class="input num" name="stopLoss" type="number" step="any" min="0" value="${v.stopLoss ?? ''}"></div>
          <div class="field"><label>Target</label><input class="input num" name="target" type="number" step="any" min="0" value="${v.target ?? ''}"></div>
          <div class="field"><label>Setup</label><input class="input" name="setup" list="setup-list" value="${esc(v.setup)}" placeholder="Breakout"><datalist id="setup-list">${setupOptions().map((s) => `<option value="${esc(s)}">`).join('')}</datalist></div>
        </div>
        ${t ? `<label class="row hidden" id="correction-row" style="font-size:12.5px;color:var(--muted)"><input type="checkbox" name="correction"> This fixes a typo in my original stop (not a stop move)</label>` : ''}
        <div class="field"><label><span class="trade-only">Thesis — why this trade, why now, what invalidates it?</span><span class="lt-only">Investment thesis — why own this business for years?</span></label><textarea class="input" name="thesis" placeholder="Breaking a 3-month range on 2× volume, sector flows turning positive. Invalid on a close back inside the range.">${esc(v.thesis)}</textarea></div>
        <div class="field lt-only"><label>Sell condition — what would make you sell?</label><textarea class="input" name="sellCondition" placeholder="Sell if ROCE falls below 15% for two years, promoter pledging rises, or the stock trades above 60× earnings.">${esc(v.sellCondition)}</textarea></div>
        <div class="field"><label>How are you feeling?</label><div class="chips">${radios('emotionEntry', EMO_IN.map((e) => [e, e]), v.emotionEntry)}</div></div>
        <div class="grid-2">
          <div class="field"><label>Confidence</label><div class="seg">${radios('confidence', [1, 2, 3, 4, 5].map((n) => [n, n]), v.confidence)}</div></div>
          <div class="field"><label>Chart link (optional)</label><input class="input" name="screenshotUrl" value="${esc(v.screenshotUrl)}" placeholder="TradingView snapshot URL"></div>
        </div>
        <div class="err" id="form-err"></div>
      </div>
      <aside class="side-panel" id="trade-preview"></aside>
    </div>
    <div class="modal-f"><button type="button" class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">${t ? 'Save changes' : 'Log trade'}</button></div>
  </form>`);
  form.dataset.entrySource = v.entrySource || 'manual';
  form.dataset.horizon = v.horizon || 'SWING';
  if (v.lotSize) form.dataset.lot = v.lotSize;
  form._base = t;
  bindTradeForm(form);
  renderTradePreview(form);
  setTimeout(() => (t ? form.thesis : form.symbol).focus(), 30);
}


export function draftFromTradeForm(form) {
  const base = form._base; const fd = new FormData(form); const g = (k) => fd.get(k);
  const stop = num(g('stopLoss'));
  const d = {
    ...(base || {}),
    symbol: String(g('symbol') || '').trim().toUpperCase(), exchange: g('exchange'), segment: g('segment') || 'EQ', side: g('side') || 'LONG',
    horizon: g('horizon') || 'SWING', sellCondition: g('sellCondition') || '',
    qty: num(g('qty')), entryPrice: num(g('entryPrice')), plannedEntry: g('horizon') === 'LONGTERM' ? null : num(g('plannedEntry')), stopLoss: stop, target: num(g('target')),
    setup: g('setup') || '', thesis: g('thesis') || '', emotionEntry: g('emotionEntry') || '', confidence: num(g('confidence')),
    entryTime: fromLocalInput(g('entryTime')), screenshotUrl: g('screenshotUrl') || '', lotSize: num(form.dataset.lot),
    entrySource: form.dataset.entrySource || 'manual',
  };
  if (!base) { d.initialStop = stop; d.stopSetAtEntry = stop != null; d.status = 'OPEN'; d.id = '__draft'; } else if (form.correction?.checked || base.initialStop == null) d.initialStop = stop;
  return d;
}


export function renderTradePreview(form) {
  const d = draftFromTradeForm(form); const base = form._base;
  const st = S.state.settings; const m = metrics(d);
  const others = S.state.trades.filter((x) => x.id !== d.id);
  const sameDay = d.entryTime ? others.filter((x) => dayKey(x.entryTime) === dayKey(d.entryTime) && new Date(x.entryTime) <= new Date(d.entryTime)).length : 0;
  const checks = entryChecks(d, { settings: st, trades: others, dayIndex: sameDay + 1 });
  const nErr = checks.filter((c) => c.xp < 0).length;
  const xp = sum(checks.map((c) => c.xp)) - (nErr >= 2 ? Math.min(40, 10 * (nErr - 1)) : 0);
  const lot = d.lotSize > 1 ? d.lotSize : 1;
  const maxQty = m.riskPerUnit > 0 ? Math.floor(st.maxRiskPerTrade / m.riskPerUnit / lot) * lot : null;
  const over = m.riskAmt != null && m.riskAmt > st.maxRiskPerTrade * 1.05;
  const badStop = d.initialStop != null && d.entryPrice && ((d.side === 'LONG' && d.initialStop >= d.entryPrice) || (d.side === 'SHORT' && d.initialStop <= d.entryPrice));
  // Stop movement warning (edit mode)
  let stopNote = '';
  if (base && base.stopLoss != null && d.stopLoss != null && d.stopLoss !== base.stopLoss) {
    const widen = d.side === 'SHORT' ? d.stopLoss > base.stopLoss : d.stopLoss < base.stopLoss;
    $('#correction-row')?.classList.remove('hidden');
    stopNote = form.correction?.checked ? '<div class="note">Treating this as a typo fix — your initial risk will be recalculated.</div>'
      : widen ? `<div class="warn">Widening the stop ${price(base.stopLoss)} → ${price(d.stopLoss)} costs −15 XP when the trade closes.</div>`
        : `<div class="note">Tightening/trailing the stop ${price(base.stopLoss)} → ${price(d.stopLoss)} — no penalty. 👍</div>`;
  } else $('#correction-row')?.classList.add('hidden');

  paint($('#trade-preview', form), `
    <h4>Pre-trade check</h4>
    <div class="stat-line"><span class="muted">Position value</span><b>${m.value ? money(m.value, { dp: 0 }) : '—'}</b></div>
    <div class="stat-line"><span class="muted">Of capital</span><b>${m.value && st.capital ? pct(m.value / st.capital) : '—'}</b></div>
    <div class="stat-line"><span class="muted">Risk to stop</span><b class="${over ? 'neg' : ''}">${m.riskAmt != null && d.qty ? money(m.riskAmt, { dp: 0 }) : '—'}${m.riskAmt != null && st.capital ? ` <span class="faint">(${pct(m.riskAmt / st.capital, 2)})</span>` : ''}</b></div>
    <div class="stat-line"><span class="muted">Reward : risk</span><b>${m.plannedRR != null ? `1 : ${m.plannedRR.toFixed(2)}` : '—'}</b></div>
    <div class="stat-line"><span class="muted">Max qty @ ₹${nf0.format(st.maxRiskPerTrade)} risk</span><b>${maxQty != null ? nf0.format(maxQty) : '—'}</b></div>
    ${maxQty ? `<button type="button" class="btn sm" style="width:100%;margin:6px 0 4px" data-action="size-from-risk" data-qty="${maxQty}">Size position to ₹${nf0.format(st.maxRiskPerTrade)} risk</button>` : ''}
    ${badStop ? `<div class="warn" style="margin-top:8px">Stop must be ${d.side === 'LONG' ? 'below' : 'above'} entry for a ${d.side.toLowerCase()}.</div>` : ''}
    ${over ? `<div class="warn" style="margin-top:8px">Risk is over your ₹${nf0.format(st.maxRiskPerTrade)} limit (−20 XP).</div>` : ''}
    ${stopNote ? `<div style="margin-top:8px">${stopNote}</div>` : ''}
    <h4 style="margin-top:16px">XP for this entry</h4>
    <div class="checklist">${checks.filter((c) => c.xp < 0).map((c) => `<div class="check bad"><span class="ic">✕</span><span class="lb">${esc(c.label)}</span>${xpPill(c.xp)}</div>`).join('')}
      ${checks.filter((c) => c.xp > 0).map((c) => `<div class="check ok"><span class="ic">✓</span><span class="lb">${esc(c.label)}</span>${xpPill(c.xp)}</div>`).join('')}
      ${checks.filter((c) => !c.xp && !c.ok && !c.disc && c.id !== 'logged').map((c) => `<div class="check"><span class="ic">○</span><span class="lb">${esc(c.label)}</span></div>`).join('')}
      ${(() => { const pass = checks.filter((c) => c.disc && c.ok && !c.xp); return pass.length ? `<div class="check ok" title="${esc(pass.map((c) => c.label).join(' · '))}"><span class="ic">✓</span><span class="lb">${pass.length} mistake checks passed</span></div>` : ''; })()}</div>
    ${(() => { const n = checks.filter((c) => c.xp < 0).length; return n >= 2 ? `<div class="warn" style="margin-top:8px">${n} mistakes on one trade: an extra ${-Math.min(40, 10 * (n - 1))} XP stack penalty applies.</div>` : ''; })()}
    <div class="xp-total ${xp < 0 ? 'neg' : ''}"><span>${base ? 'Entry XP' : xp < 0 ? 'You\'ll lose' : 'You\'ll earn'}</span><b>${xp > 0 ? '+' : ''}${xp} XP</b></div>`);
}


export function bindTradeForm(form) {
  const rerender = () => renderTradePreview(form);
  form.addEventListener('input', (e) => {
    if (e.target.name === 'entryPrice' && e.isTrusted) { form.dataset.entrySource = 'manual'; $('#tag-entryPrice').textContent = ''; }
    rerender();
  });
  form.addEventListener('change', (e) => {
    if (e.target.name === 'horizon') form.dataset.horizon = e.target.value;
    if (e.target.name === 'exchange') { setRadio(form, 'segment', guessSegment(form.exchange.value, form.symbol.value.toUpperCase())); showSymbolQuote(form); }
    rerender();
  });
  form.symbol.addEventListener('change', () => { setRadio(form, 'segment', guessSegment(form.exchange.value, form.symbol.value.toUpperCase())); showSymbolQuote(form); rerender(); });
  bindAutocomplete(form, rerender);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = draftFromTradeForm(form); const base = form._base;
    if (!d.entryTime) { $('#form-err', form).textContent = 'Set the date and time you entered this trade.'; form.entryTime.focus(); return; }
    const body = {
      symbol: d.symbol, exchange: d.exchange, segment: d.segment, side: d.side, qty: d.qty, entryPrice: d.entryPrice, plannedEntry: d.plannedEntry, horizon: d.horizon, sellCondition: d.sellCondition,
      stopLoss: d.stopLoss, target: d.target, setup: d.setup, thesis: d.thesis, emotionEntry: d.emotionEntry, confidence: d.confidence,
      entryTime: d.entryTime, screenshotUrl: d.screenshotUrl, lotSize: d.lotSize, entrySource: d.entrySource,
    };
    if (base && form.correction?.checked) body.correction = true;
    if (base && d.stopLoss === base.stopLoss) delete body.stopLoss;
    const btn = form.querySelector('[type=submit]'); btn.disabled = true;
    try {
      await api(base ? `/api/trades/${base.id}` : '/api/trades', { method: base ? 'PUT' : 'POST', body });
      closeModal();
      await reload({ celebrate: true });
      pollQuotes();
    } catch (err) { $('#form-err', form).textContent = err.message; btn.disabled = false; }
  });
}


export async function showSymbolQuote(form) {
  const hint = $('#sym-hint', form);
  if (!S.kite.connected || !form.symbol.value.trim()) return;
  const k = `${form.exchange.value}:${form.symbol.value.trim().toUpperCase()}`;
  try {
    const { quotes } = await api('/api/kite/quote?i=' + encodeURIComponent(k));
    const q = quotes[k];
    hint.innerHTML = q ? `LTP <b class="mono">${price(q.last)}</b> <span class="${cls(q.changePct)}">${q.changePct == null ? '' : (q.changePct > 0 ? '+' : '') + (q.changePct * 100).toFixed(2) + '%'}</span>${S.kite.mock ? ' <span class="faint">(demo)</span>' : ''}` : `<span class="neg">No quote for ${esc(k)} — check symbol/exchange</span>`;
  } catch (e) { hint.innerHTML = `<span class="neg">${esc(e.message)}</span>`; }
}


export function bindAutocomplete(form, after) {
  const inp = form.symbol; const box = inp.parentElement.querySelector('.ac');
  let timer; let items = []; let active = -1;
  const hide = () => box.classList.add('hidden');
  const draw = () => {
    if (!items.length) return hide();
    box.innerHTML = items.map((it, i) => `<div class="ac-item ${i === active ? 'active' : ''}" data-i="${i}"><span><b>${esc(it.symbol)}</b> <span class="exch">${it.exchange}</span></span><span class="n">${esc(it.name || '')}${it.expiry ? ' · ' + esc(it.expiry) : ''}${it.lotSize > 1 ? ' · lot ' + it.lotSize : ''}</span></div>`).join('');
    box.classList.remove('hidden');
  };
  const pick = (it) => {
    if (!it) return;
    inp.value = it.symbol; form.exchange.value = it.exchange; setRadio(form, 'segment', it.segment);
    form.dataset.lot = it.lotSize > 1 ? it.lotSize : '';
    $('#lot-hint', form).textContent = it.lotSize > 1 ? `1 lot = ${it.lotSize}` : '';
    hide(); showSymbolQuote(form); after();
  };
  inp.addEventListener('input', () => {
    clearTimeout(timer);
    if (!S.kite.connected) return;
    const q = inp.value.trim();
    if (q.length < 2) return hide();
    timer = setTimeout(async () => {
      try { items = clientSearch() ? await searchLocal(q) : (await api('/api/kite/search?q=' + encodeURIComponent(q))).results; active = items.length ? 0 : -1; draw(); } catch (e) { $('#sym-hint', form).innerHTML = `<span class="neg">${esc(e.message)}</span>`; hide(); }
    }, 180);
  });
  inp.addEventListener('keydown', (e) => {
    if (box.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { pick(items[active]); e.preventDefault(); }
    else if (e.key === 'Escape') { hide(); e.stopPropagation(); }
  });
  inp.addEventListener('blur', () => setTimeout(hide, 150));
  box.addEventListener('mousedown', (e) => { const el = e.target.closest('.ac-item'); if (el) { e.preventDefault(); pick(items[+el.dataset.i]); } });
}


export async function fillLivePrice(form, field) {
  const sym = (form.symbol?.value || form.dataset.symbol || '').trim().toUpperCase();
  const ex = form.exchange?.value || form.dataset.exchange;
  const tag = $(`#tag-${field}`, form);
  if (!sym) { tag.innerHTML = '<span class="neg">Enter a symbol first</span>'; return; }
  const k = `${ex}:${sym}`;
  tag.textContent = 'Fetching…';
  try {
    const { quotes } = await api('/api/kite/quote?i=' + encodeURIComponent(k));
    const q = quotes[k];
    if (!q) throw new Error(`No quote for ${k}`);
    form[field].value = q.last;
    form.dataset[field === 'entryPrice' ? 'entrySource' : 'exitSource'] = 'live';
    tag.textContent = `⚡ Live ${fmtTime(q.at || new Date().toISOString())}${S.kite.mock ? ' (demo)' : ''}`;
    form.dispatchEvent(new Event('change'));
  } catch (e) { tag.innerHTML = `<span class="neg">${esc(e.message)}</span>`; }
}


// ---------- Close trade ----------
export function openCloseForm(t, prefill = {}) {
  const live = S.kite.connected;
  const edit = Boolean(prefill.edit); // editing the exit of a closed single-exit trade
  const prior = edit ? [] : exitsOf(t);
  const remaining = t.qty - prior.reduce((a, e) => a + e.qty, 0);
  const startQty = edit ? t.qty : Math.min(remaining, prefill.qty ?? remaining);
  const form = openModal(`
  <form id="close-form" class="modal" autocomplete="off">
    <div class="modal-h"><h2><span id="cf-title">Close</span> ${esc(t.symbol)} <span class="side ${t.side}">${t.side}</span> <span class="muted" style="font-weight:500;font-size:13px">· ${nf0.format(t.qty)} @ ${price(t.entryPrice)}${prior.length ? ` · ${nf0.format(remaining)} still open` : ''}</span></h2><button type="button" class="btn ghost sm" data-action="close-modal">✕</button></div>
    <div class="modal-b form-grid">
      <div class="stack">
        <div class="grid-4">
          <div class="field"><label>Quantity</label><input class="input num" name="exitQty" type="number" step="any" min="0" max="${remaining}" value="${startQty}" ${edit ? 'readonly' : ''}><div class="hint">${edit ? '' : `of ${nf0.format(remaining)} open · less = partial exit`}</div></div>
          <div class="field"><label>Exit price</label><div class="input-row"><input class="input num" name="exitPrice" type="number" step="any" min="0" value="${prefill.exitPrice ?? ''}" required>
            <button type="button" class="btn live sm" data-action="live-price" data-field="exitPrice" ${live ? '' : 'disabled title="Connect Kite for live prices"'}>⚡ Live</button></div>
            <div class="live-tag" id="tag-exitPrice">${prefill.exitSource === 'kite-fill' ? '⚡ From Kite fill' : ''}</div></div>
          <div class="field"><label>Exit time</label><input class="input" name="exitTime" type="datetime-local" value="${toLocalInput(prefill.exitTime)}"></div>
          <div class="field"><label>Charges (₹)</label><input class="input num" name="charges" type="number" step="any" min="0" value="${t.charges ?? ''}" placeholder="auto"><div class="hint">blank = Zerodha's schedule</div></div>
        </div>
        <div class="field ${isLT(t) ? 'hidden' : ''}"><label>Best price reached while open <span class="faint" style="font-weight:500">${t.mfePrice != null ? '(tracked from live prices)' : '(optional — catches winners that turned into losers)'}</span></label><input class="input num" name="mfePrice" type="number" step="any" min="0" value="${t.mfePrice ?? ''}" style="max-width:220px"></div>
        <div class="field"><label>${isLT(t) ? 'Why are you selling?' : 'Why did you exit?'}</label><div class="chips">${radios('exitReason', (isLT(t) ? LT_EXIT_REASONS : EXIT_REASONS).map((r) => [r, r]), t.exitReason)}</div></div>
        ${isLT(t) && t.sellCondition ? `<div class="note">Your sell condition: ${esc(t.sellCondition)}</div>` : ''}
        <div class="field"><label>${isLT(t) ? 'Are you selling per your sell condition?' : 'Did you follow your plan?'}</label><div class="seg">${radios('followedPlan', [['yes', '✓ Yes, as planned', 'long'], ['no', '✕ No, I deviated', 'short']], t.followedPlan === true ? 'yes' : t.followedPlan === false ? 'no' : '')}</div></div>
        <div class="field"><label>Mistakes only you know about <span class="faint" style="font-weight:500">(−5 XP each — cheaper than repeating them)</span></label>
          <div class="chips">${Object.entries(MISTAKE_TAGS).map(([k, l]) => `<label><input type="checkbox" name="mistakes" value="${k}" ${(t.mistakes || []).includes(k) ? 'checked' : ''}><span>${esc(l)}</span></label>`).join('')}</div></div>
        <div class="field"><label>How do you feel now?</label><div class="chips">${radios('emotionExit', EMO_OUT.map((e) => [e, e]), t.emotionExit)}</div></div>
        <div class="field"><label>Lesson — what will you repeat or change?</label><textarea class="input" name="lessons" placeholder="Held through the pullback because the thesis was intact — good. Exited on target instead of trailing; next time trail half.">${esc(t.lessons)}</textarea></div>
        <div class="field"><label>Execution grade</label>${stars('rating', t.rating)}</div>
        <div class="err" id="form-err"></div>
      </div>
      <aside class="side-panel" id="close-preview"></aside>
    </div>
    <div class="modal-f"><button type="button" class="btn ghost" data-action="close-modal">Cancel</button><button class="btn green" type="submit" id="cf-submit">Close trade</button></div>
  </form>`);
  form.dataset.symbol = t.symbol; form.dataset.exchange = t.exchange;
  form.dataset.exitSource = prefill.exitSource || 'manual';
  const exitQty = () => Math.min(remaining, num(form.exitQty.value) ?? remaining);
  const isPartial = () => !edit && exitQty() < remaining - 1e-9;
  const draft = () => {
    const fd = new FormData(form); const fp = fd.get('followedPlan');
    const e = { qty: exitQty(), price: num(fd.get('exitPrice')), time: fromLocalInput(fd.get('exitTime')) };
    const exits = e.price != null && e.qty > 0 ? [...prior, e] : prior;
    const partial = isPartial();
    return { ...t, exits, status: partial ? 'OPEN' : 'CLOSED', exitPrice: partial ? null : e.price, exitTime: partial ? null : e.time, charges: num(fd.get('charges')),
      exitReason: fd.get('exitReason') || '', followedPlan: fp === 'yes' ? true : fp === 'no' ? false : null, emotionExit: fd.get('emotionExit') || '',
      lessons: fd.get('lessons') || '', rating: num(fd.get('rating')), exitSource: form.dataset.exitSource,
      mistakes: fd.getAll('mistakes'), mfePrice: num(fd.get('mfePrice')) };
  };
  const preview = () => {
    const d = draft(); const partial = isPartial(); const m = metrics(d, partial ? ltpFor(t) : null);
    const checks = !partial && d.exitPrice != null ? exitChecks(d, m) : [];
    const xp = sum(checks.map((c) => c.xp));
    const entryXp = sum((S.game.perTrade[t.id]?.entry || []).map((c) => c.xp));
    $('#cf-title', form).textContent = partial ? 'Partly exit' : 'Close';
    $('#cf-submit', form).textContent = partial ? `Book partial exit (${nf0.format(exitQty())})` : 'Close trade';
    const ch = tradeCharges({ ...d, exits: d.exits });
    paint($('#close-preview', form), `
      <h4>${partial ? 'After this partial exit' : 'Result'}</h4>
      <div class="stat-line"><span class="muted">${partial ? 'Realised so far' : 'Net P&L'}</span><b class="${cls(partial ? m.realised : m.net)}">${(partial ? m.realised : m.net) == null ? '—' : money(partial ? m.realised : m.net, { sign: true })}</b></div>
      ${partial ? `<div class="stat-line"><span class="muted">Still open</span><b>${nf0.format(remaining - exitQty())}</b></div>` : ''}
      <div class="stat-line"><span class="muted">Charges ${m.chargesAuto ? '(auto)' : '(manual)'}</span><b>${money(m.charges)}</b></div>
      ${m.chargesAuto && ch.total ? `<details class="charges"><summary class="faint">Breakdown</summary>${Object.entries(CHARGE_LABELS).filter(([k]) => ch[k]).map(([k, l]) => `<div class="stat-line"><span class="muted">${l}</span><b>${money(ch[k])}</b></div>`).join('')}</details>` : ''}
      <div class="stat-line"><span class="muted">R multiple</span><b class="${cls(m.r)}">${rfmt(m.r)}</b></div>
      <div class="stat-line"><span class="muted">Return on position</span><b class="${cls(m.net)}">${m.net != null && m.value ? pct(m.net / m.value, 2) : '—'}</b></div>
      <div class="stat-line"><span class="muted">Held</span><b>${d.exitTime ? hold(m.holdDays) : '—'}</b></div>
      ${t.stopWidenCount ? `<div class="warn" style="margin-top:6px">Stop was widened ${t.stopWidenCount}× on this trade.</div>` : ''}
      ${partial ? '<div class="note" style="margin-top:12px">Partial exit — exit XP is scored when the rest is closed.</div>' : ''}
      <h4 style="margin-top:16px;${partial ? 'display:none' : ''}">XP for this exit</h4>
      ${d.exitPrice && checks.filter((c) => c.xp < 0).length >= 2 ? `<div class="warn" style="margin:6px 0">${checks.filter((c) => c.xp < 0).length} mistakes on this exit — stack penalty applies.</div>` : ''}
      ${partial ? '' : d.exitPrice != null ? `<div class="checklist">${checks.map((c) => `<div class="check ${c.xp > 0 ? 'ok' : c.xp < 0 ? 'bad' : c.ok ? 'ok' : ''}"><span class="ic">${c.xp < 0 ? '✕' : c.ok ? '✓' : '○'}</span><span class="lb">${esc(c.label)}</span>${xpPill(c.xp)}</div>`).join('')}</div>
      <div class="xp-total ${xp < 0 ? 'neg' : ''}"><span>Exit XP <span class="faint" style="font-weight:500">(entry earned ${entryXp > 0 ? '+' : ''}${entryXp})</span></span><b>${xp > 0 ? '+' : ''}${xp} XP</b></div>` : '<div class="empty-sm">Enter an exit price.</div>'}
      <p class="faint" style="font-size:11.5px;margin-bottom:0">Profit itself earns nothing — honest journaling and respecting your stop do.</p>`);
  };
  form.addEventListener('input', (e) => { if (e.target.name === 'exitPrice' && e.isTrusted) { form.dataset.exitSource = 'manual'; $('#tag-exitPrice').textContent = ''; } preview(); });
  form.addEventListener('change', preview);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = draft();
    const btn = form.querySelector('[type=submit]'); btn.disabled = true;
    try {
      const fd = new FormData(form);
      const e = { qty: exitQty(), price: num(fd.get('exitPrice')), time: fromLocalInput(fd.get('exitTime')), source: form.dataset.exitSource };
      if (e.price == null) throw new Error('Enter an exit price');
      const notes = { charges: d.charges, exitReason: d.exitReason, followedPlan: d.followedPlan, emotionExit: d.emotionExit, lessons: d.lessons, rating: d.rating, mistakes: d.mistakes, ...(d.mfePrice != null ? { mfePrice: d.mfePrice } : {}) };
      const body = edit ? { status: 'CLOSED', exitPrice: e.price, exitTime: e.time, exitSource: e.source, ...notes }
        : isPartial() ? { addExit: e, charges: d.charges } : { addExit: { ...e, qty: remaining }, ...notes };
      await api(`/api/trades/${t.id}`, { method: 'PUT', body });
      closeModal();
      await reload({ celebrate: true });
    } catch (err) { $('#form-err', form).textContent = err.message; btn.disabled = false; }
  });
  preview();
  setTimeout(() => form.exitPrice.focus(), 30);
}
