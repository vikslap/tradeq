import { tradeCharges, exitsOf, CHARGE_LABELS } from '../charges.js';
import { metrics, isLT, reviewStatus, REVIEW_DAYS } from '../game.js';
import { mountTradeChart, INTERVAL_LABEL } from '../tradechart.js';
import { drawToolbar } from '../drawing.js';
import { $, esc, nf0, num, sum, money, price, pct, rfmt, cls, fmtDate, fmtDT, hold, xpPill, SEGMENTS, radios } from './util.js';
import { S, api, reload, horizonPill, groupOf, legsOfGroup, linkPill, ltpFor } from './state.js';
import { openModal, closeModal, toast } from './ui.js';
import { unrealised } from './dashboard.js';


// ---------- Drawer ----------
// ---------- Trade chart (interactive) ----------
export const theme = () => document.documentElement.dataset.theme || 'dark';

export const dataKey = (t, iv) => `${t.id}|${iv || 'auto'}|${t.status === 'OPEN' ? Math.floor(Date.now() / 300000) : t.updatedAt}`;


export async function chartData(t, iv) {
  const k = dataKey(t, iv);
  if (S.charts[k]) return S.charts[k];
  const data = await api(`/api/trades/${t.id}/chart${iv ? `?interval=${iv}` : ''}`);
  S.charts[k] = data;
  if (data.updated) setTimeout(() => reload({ celebrate: true }), 0);
  return data;
}


export function chartToolbar(t, iv, def) {
  const cur = iv || def;
  return `<div class="chart-bar">
    <div class="seg sm-seg">${Object.entries(INTERVAL_LABEL).map(([v, l]) => `<label><input type="radio" name="iv-${t.id}" data-action-iv="${v}" ${cur === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
    <div class="chips">${[20, 50, 200].map((n) => `<label><input type="checkbox" data-action-ema="${n}" ${S.emas.includes(n) ? 'checked' : ''}><span class="ema-chip ema-${n}">EMA ${n}</span></label>`).join('')}</div>
    ${drawToolbar()}
    <span style="flex:1"></span>
    <button class="btn ghost sm" data-action="chart-expand" data-id="${t.id}" title="Full screen">⛶ Expand</button>
  </div>`;
}

/** Mount (or re-attach) the chart in the open drawer without rebuilding it on every live tick. */

export async function mountDrawerChart(t) {
  const slot = $('#trade-chart'); if (!slot) return;
  const iv = S.chartIv[t.id];
  const key = `${dataKey(t, iv)}|${theme()}|${S.emas.join(',')}`;
  if (S.cv?.tradeId === t.id && S.cv.key === key) { slot.replaceWith(S.cv.wrap); return; }
  if (S.cv) { S.cv.inst?.destroy(); S.cv = null; }
  const wrap = document.createElement('div'); wrap.id = 'trade-chart'; wrap.dataset.chartWrap = '1';
  wrap.innerHTML = `<div class="chart-loading">${S.kite.connected || t.status === 'CLOSED' ? 'Loading chart…' : 'Connect Kite to see this trade on a chart.'}</div>`;
  slot.replaceWith(wrap);
  const cv = { tradeId: t.id, key, wrap, inst: null };
  S.cv = cv;
  if (!S.kite.connected && t.status === 'OPEN') return;
  try {
    const data = await chartData(t, iv);
    if (S.cv !== cv) return;
    if (!data.candles?.length) { wrap.innerHTML = '<div class="chart-loading">No candles for this period.</div>'; return; }
    wrap.innerHTML = `${chartToolbar(t, iv, data.interval)}<div class="chart-host"></div>${S.kite.mock ? '<div class="faint" style="font-size:11px;margin-top:4px">Demo data</div>' : ''}`;
    cv.inst = mountTradeChart($('.chart-host', wrap), t, data, { height: 330, emas: S.emas, drawKey: `trade:${t.id}` });
    const ltp = t.status === 'OPEN' ? ltpFor(t) : null; if (ltp) cv.inst.setLive(ltp);
  } catch (e) {
    if (S.cv === cv) wrap.innerHTML = `<div class="chart-loading">${esc(e.code === 'TOKEN' ? 'Connect Kite to load this chart.' : e.message)}</div>`;
  }
}


export async function openBigChart(t) {
  const iv = S.chartIv[t.id];
  const el = openModal(`<div class="modal" style="width:min(1400px,100%)"><div class="modal-h"><h2>${esc(t.symbol)} <span class="exch">${t.exchange}</span> <span class="side ${t.side}">${t.side}</span> ${horizonPill(t)}</h2><button class="btn ghost sm" data-action="close-modal">✕</button></div>
    <div class="modal-b" id="big-chart" data-chart-wrap><div class="chart-loading" style="height:70vh">Loading chart…</div></div></div>`, { dismissable: true });
  try {
    const data = await chartData(t, iv);
    const box = $('#big-chart', el); if (!box) return;
    box.innerHTML = `${chartToolbar(t, iv, data.interval).replace('data-action="chart-expand"', 'data-action="close-modal"').replace('⛶ Expand', '✕ Close')}<div class="chart-host"></div>`;
    S.big = { tradeId: t.id, inst: mountTradeChart($('.chart-host', box), t, data, { height: Math.round(window.innerHeight * 0.72), emas: S.emas, drawKey: `trade:${t.id}` }) };
  } catch (e) { const box = $('#big-chart', el); if (box) box.innerHTML = `<div class="warn">${esc(e.message)}</div>`; }
}


export function renderDrawer() {
  const t = S.state.trades.find((x) => x.id === S.drawerId);
  if (!t) { S.drawerId = null; $('#drawer-root').innerHTML = ''; return; }
  const ltp = t.status === 'OPEN' ? ltpFor(t) : null; const m = metrics(t, ltp);
  const pt = S.game.perTrade[t.id] || { entry: [], exit: [] };
  const x = S.game.tradeXp[t.id] || 0;
  const item = (k, v) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const checkList = (items) => items.filter((c) => c.xp || c.disc).map((c) => `<div class="check ${c.xp > 0 || (c.ok && c.disc) ? 'ok' : c.xp < 0 || (c.disc && !c.ok) ? 'bad' : ''}"><span class="ic">${c.ok ? '✓' : '✕'}</span><span class="lb">${esc(c.label)}</span>${xpPill(c.xp)}</div>`).join('');
  $('#drawer-root').innerHTML = `<div class="drawer-ov" data-action="close-drawer"></div><aside class="drawer">
    <div class="sec row" style="justify-content:space-between">
      <div><div class="row"><span class="sym" style="font-size:20px">${esc(t.symbol)}</span><span class="exch">${t.exchange}</span><span class="side ${t.side}">${t.side}</span>${horizonPill(t)}${linkPill(t)}${t.status === 'OPEN' ? '<span class="pill violet">open</span>' : t.imported ? '<span class="pill">imported</span>' : isLT(t) ? '<span class="pill">sold</span>' : pt.clean ? '<span class="pill green">clean trade</span>' : '<span class="pill red">rule broken</span>'}</div>
        <div class="muted" style="margin-top:4px;font-size:12.5px">${fmtDT(t.entryTime)}${t.exitTime && t.status === 'CLOSED' ? ' → ' + fmtDT(t.exitTime) : ''} · ${hold(m.holdDays)}</div></div>
      <button class="btn ghost sm" data-action="close-drawer">✕</button>
    </div>
    <div class="sec" style="padding-top:12px;padding-bottom:12px"><div id="trade-chart"></div></div>
    <div class="sec"><div class="row" style="justify-content:space-between;align-items:flex-end">
      <div><div class="label">${t.status === 'OPEN' ? (m.exQty ? 'Total P&L (booked + open)' : 'Unrealised P&L') : 'Net P&L'}</div><div class="mono ${cls(m.net)}" style="font-size:28px;font-weight:700;margin-top:4px">${m.net == null ? '—' : money(m.net, { sign: true })}</div>${t.status === 'OPEN' && m.exQty ? `<div class="faint" style="font-size:12px">Booked ${money(m.realised, { sign: true })} · open ${m.unrealised == null ? '—' : money(m.unrealised, { sign: true })}</div>` : ''}</div>
      <div style="text-align:right"><div class="mono ${cls(m.r)}" style="font-size:18px;font-weight:650">${rfmt(m.r)}</div>${xpPill(x)}</div></div></div>
    <div class="sec kv">
      ${item('Quantity', nf0.format(t.qty) + (t.lotSize > 1 ? ` <span class="faint">(${(t.qty / t.lotSize).toFixed(t.qty % t.lotSize ? 2 : 0)} lots)</span>` : '') + (t.status === 'OPEN' && m.exQty ? ` <span class="pill gold">${nf0.format(m.openQty)} open</span>` : ''))}
      ${item('Entry', price(t.entryPrice) + (t.entrySource !== 'manual' ? ' <span class="live-tag">⚡</span>' : ''))}
      ${item(t.status === 'OPEN' ? 'LTP' : 'Exit', t.status === 'OPEN' ? price(ltp) : price(t.exitPrice) + (t.exitSource && t.exitSource !== 'manual' ? ' <span class="live-tag">⚡</span>' : ''))}
      ${isLT(t) ? `${item('Invested', money(t.entryPrice * t.qty, { dp: 0 }))}${item('Return', (() => { const v = t.status === 'OPEN' ? ltp : t.exitPrice; return v ? `<span class="${cls(v - t.entryPrice)}">${pct(v / t.entryPrice - 1)}</span>` : '—'; })())}` : `
      ${item('Stop (initial → now)', `${price(t.initialStop)} → ${price(t.stopLoss)}`)}
      ${item('Target', price(t.target))}
      ${item('Planned R:R', m.plannedRR != null ? '1 : ' + m.plannedRR.toFixed(2) : '—')}
      ${item('Initial risk', m.riskAmt != null ? money(m.riskAmt, { dp: 0 }) : '—')}`}
      ${item('Charges', m.exQty ? `${money(m.charges)} <span class="faint">${m.chargesAuto ? 'auto' : 'manual'}</span>` : '—')}
      ${item('Best / worst price seen', t.mfePrice != null ? `${price(t.mfePrice)} / ${price(t.maePrice)}` : '—')}
      ${isLT(t) ? '' : item('Setup', esc(t.setup || '—'))}
      ${item('Segment', esc(Object.fromEntries(SEGMENTS)[t.segment] || t.segment))}
      ${item('Emotion in → out', `${esc(t.emotionEntry || '—')} → ${esc(t.emotionExit || '—')}`)}
      ${item('Confidence · grade', `${t.confidence ?? '—'}/5 · ${t.rating ? '★'.repeat(t.rating) : '—'}`)}
    </div>
    ${t.thesis ? `<div class="sec"><div class="label">${isLT(t) ? 'Investment thesis' : 'Thesis'}</div><div class="prose" style="margin-top:6px">${esc(t.thesis)}</div></div>` : ''}
    ${isLT(t) ? (() => { const rs = reviewStatus(t); return `<div class="sec">
      ${t.sellCondition ? `<div class="label">Sell condition</div><div class="prose" style="margin:6px 0 14px">${esc(t.sellCondition)}</div>` : '<div class="warn" style="margin-bottom:12px">No sell condition yet — edit the trade to add one (+10 XP).</div>'}
      <div class="row" style="justify-content:space-between"><div class="label">Thesis reviews · every ${REVIEW_DAYS} days</div>
        ${t.status === 'OPEN' ? `<span class="row">${rs.overdue ? '<span class="pill red">overdue</span>' : `<span class="pill">next in ${rs.daysLeft}d</span>`}<button class="btn sm primary" data-action="thesis-review" data-id="${t.id}">＋ Review</button></span>` : ''}</div>
      ${(t.thesisReviews || []).length ? [...t.thesisReviews].reverse().map((r) => `<div style="padding:10px 0;border-bottom:1px dashed var(--border)"><div class="row" style="justify-content:space-between"><span class="muted" style="font-size:12px">${fmtDate(r.at)} · ${r.thesisIntact ? '<span class="pos">thesis intact</span>' : '<span class="neg">thesis broken</span>'}</span><button class="btn ghost sm" data-action="delete-thesis-review" data-id="${t.id}" data-rid="${r.id}">✕</button></div><div class="prose" style="margin-top:4px">${esc(r.note)}</div></div>`).join('') : '<div class="empty-sm" style="text-align:left">No reviews yet. After results each quarter, note whether the thesis still holds.</div>'}
    </div>`; })() : ''}
    ${t.lessons ? `<div class="sec"><div class="label">Lesson</div><div class="prose" style="margin-top:6px">${esc(t.lessons)}</div></div>` : ''}
    ${t.screenshotUrl ? `<div class="sec"><a class="link" href="${esc(t.screenshotUrl)}" target="_blank" rel="noopener">📈 Open chart ↗</a></div>` : ''}
    ${(() => {
      const ex = exitsOf(t); if (!ex.length) return '';
      const multi = ex.length > 1 || t.status === 'OPEN';
      const ch = m.chargesAuto ? tradeCharges(t) : null;
      return `<div class="sec"><div class="label">Exits${multi ? ` · ${ex.length}` : ''}</div>
        ${ex.map((e) => { const g = (e.price - t.entryPrice) * m.dir * e.qty; return `<div class="stat-line"><span class="muted">${fmtDT(e.time)} · ${nf0.format(e.qty)} @ ${price(e.price)}</span><span class="row" style="gap:6px"><b class="${cls(g)}">${money(g, { sign: true, dp: 0 })}</b>${multi && e.id ? `<button class="btn ghost sm" data-action="delete-exit" data-id="${t.id}" data-eid="${e.id}" title="Remove this exit">✕</button>` : ''}</span></div>`; }).join('')}
        ${ch ? `<details class="charges" style="margin-top:6px"><summary class="faint">Charges ${money(ch.total)} — breakdown</summary>${Object.entries(CHARGE_LABELS).filter(([k]) => ch[k]).map(([k, l]) => `<div class="stat-line"><span class="muted">${l}</span><b>${money(ch[k])}</b></div>`).join('')}</details>` : ''}
      </div>`;
    })()}
    ${t.stopHistory?.length ? `<div class="sec"><div class="label">Stop moves</div>${t.stopHistory.map((h) => `<div class="stat-line"><span class="muted">${fmtDT(h.at)}</span><b>${price(h.from)} → ${price(h.to)}</b></div>`).join('')}</div>` : ''}
    ${(() => {
      const g = groupOf(t); if (!g) return '';
      const legs = legsOfGroup(g.id);
      const nets = legs.map((l) => metrics(l, l.status === 'OPEN' ? ltpFor(l) : null).net);
      const total = nets.every((v) => v != null) ? sum(nets) : null;
      const allClosed = legs.every((l) => l.status === 'CLOSED');
      return `<div class="sec"><div class="row" style="justify-content:space-between"><div class="label">🔗 Linked position · ${esc(g.name)}</div>
        <span class="row"><button class="btn ghost sm" data-action="rename-group" data-gid="${g.id}">Rename</button><button class="btn ghost sm" data-action="unlink-trade" data-id="${t.id}">Unlink this leg</button><button class="btn ghost sm" data-action="delete-group" data-gid="${g.id}">Unlink all</button></span></div>
        <div class="table-wrap" style="margin-top:8px"><table class="tbl"><tbody>${legs.map((l, k) => `<tr class="click ${l.id === t.id ? 'selected' : ''}" data-action="open-drawer" data-id="${l.id}"><td><span class="sym">${esc(l.symbol)}</span></td><td><span class="side ${l.side}">${l.side}</span></td><td class="r num">${nf0.format(l.qty)}</td><td class="r num ${cls(nets[k])}">${nets[k] == null ? '—' : money(nets[k], { sign: true, dp: 0 })}${l.status === 'OPEN' ? ' <span class="faint">·u</span>' : ''}</td></tr>`).join('')}</tbody></table></div>
        <div class="stat-line" style="margin-top:6px"><span class="muted">Combined ${allClosed ? 'net P&L' : 'P&L (incl. unrealised)'}</span><b class="${cls(total)}">${total == null ? '—' : money(total, { sign: true })}</b></div>
        <p class="faint" style="font-size:11.5px;margin:4px 0 0">Counts as one trade in stats${allClosed ? '' : ' once every leg is closed'}.</p></div>`;
    })()}
    ${t.imported ? '<div class="sec"><div class="note">Imported from your Zerodha tradebook. It counts in P&L, stats and charts, but doesn\'t earn or lose XP — XP is for journaling as you trade. Add notes freely.</div></div>' : ''}
    <div class="sec ${t.imported ? 'hidden' : ''}"><div class="label">XP breakdown</div><div class="checklist" style="margin-top:8px">${checkList(pt.entry)}${checkList(pt.exit)}${(pt.penalties || []).map((c) => `<div class="check bad"><span class="ic">✕</span><span class="lb">${esc(c.label)}</span>${xpPill(c.xp)}</div>`).join('')}</div></div>
    <div class="sec row wrap">
      ${t.status === 'OPEN' ? `<button class="btn green" data-action="close-trade" data-id="${t.id}">Close trade</button>` : `<button class="btn" data-action="reopen-trade" data-id="${t.id}">Reopen</button>`}
      <button class="btn" data-action="edit-trade" data-id="${t.id}">Edit</button>
      ${t.status === 'CLOSED' && exitsOf(t).length === 1 ? `<button class="btn" data-action="edit-exit" data-id="${t.id}">Edit exit</button>` : ''}
      <span style="flex:1"></span><button class="btn danger" data-action="delete-trade" data-id="${t.id}">Delete</button>
    </div>
  </aside>`;
  mountDrawerChart(t);
}


// ---------- Kite fills ----------
export function openThesisReview(t) {
  const rs = reviewStatus(t);
  const form = openModal(`<form class="modal narrow" id="thesis-form">
    <div class="modal-h"><h2>📚 Thesis review · ${esc(t.symbol)}</h2><button type="button" class="btn ghost sm" data-action="close-modal">✕</button></div>
    <div class="modal-b stack">
      ${t.thesis ? `<div><div class="label">Your thesis</div><div class="prose" style="margin-top:4px">${esc(t.thesis)}</div></div>` : ''}
      ${t.sellCondition ? `<div><div class="label">Sell if</div><div class="prose" style="margin-top:4px">${esc(t.sellCondition)}</div></div>` : ''}
      <div class="field"><label>What changed? Results, management, valuation, competition…</label><textarea class="input" name="note" required placeholder="Q2: revenue +18%, margins steady, debt reduced. Thesis on track; valuation 32× vs my 45× ceiling."></textarea></div>
      <div class="field"><label>Is the thesis still intact?</label><div class="seg">${radios('thesisIntact', [['yes', '✓ Intact', 'long'], ['no', '✕ Broken', 'short']], 'yes')}</div></div>
      <div class="note">${rs.overdue ? 'This review is overdue.' : `Next review was due in ${rs.daysLeft} days.`} Reviews earn +20 XP once every 60 days per holding.</div>
      <div class="err" id="thesis-err"></div>
    </div>
    <div class="modal-f"><button type="button" class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">Save review</button></div>
  </form>`);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await api(`/api/trades/${t.id}/thesis-reviews`, { method: 'POST', body: { note: fd.get('note'), thesisIntact: fd.get('thesisIntact') !== 'no' } });
      closeModal(); await reload({ celebrate: true });
      if (fd.get('thesisIntact') === 'no') toast(`<div class="t-h">Thesis broken on ${esc(t.symbol)}</div><div class="muted" style="font-size:12px;margin-top:4px">${t.sellCondition ? 'Your sell condition: ' + esc(t.sellCondition) : 'Consider whether it still deserves a place in your portfolio.'}</div>`, 'err');
    } catch (err) { $('#thesis-err').textContent = err.message; }
  });
  setTimeout(() => form.note.focus(), 30);
}
