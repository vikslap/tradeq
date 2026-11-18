import { metrics, HORIZONS } from '../game.js';
import { parseTradebook, planImport } from '../tradebook.js';
import { $, $$, esc, nf0, num, money, price, cls, fmtDate, fmtDT, fmtTime } from './util.js';
import { S, api, reload, loadPortfolio, horizonPill, suggestGroupName, ltpFor, findTrade } from './state.js';
import { openModal, closeModal, toast } from './ui.js';
import { render } from './main.js';


// ---------- Tradebook import ----------
export function openTradebookImport() {
  const el = openModal(`<div class="modal" style="width:min(1100px,100%)"><div class="modal-h"><h2>⬆ Import Zerodha tradebook</h2><button class="btn ghost sm" data-action="close-modal">✕</button></div>
    <div class="modal-b" id="tb-body">
      <ol class="prose" style="margin:0 0 14px;padding-left:18px">
        <li>Open <a class="link" href="https://console.zerodha.com/reports/tradebook" target="_blank" rel="noopener">Console → Reports → Tradebook</a>.</li>
        <li>Pick the segment (Equity, F&O or Commodity) and a date range — up to a year at a time — and download as <b>CSV</b>.</li>
        <li>Drop one or more files here. Nothing is saved until you review and confirm.</li></ol>
      <label class="dropzone" id="tb-drop"><input type="file" accept=".csv,text/csv" multiple id="tb-file" hidden><b>Choose CSV files</b> or drag them here</label>
      <div class="err" id="tb-err" style="margin-top:8px"></div>
    </div></div>`, { dismissable: true });
  const input = $('#tb-file', el); const drop = $('#tb-drop', el);
  const handle = async (files) => {
    try {
      const fills = [];
      for (const f of files) fills.push(...parseTradebook(await f.text()));
      S._tb = planImport(S.state.trades, fills);
      renderImportPlan();
    } catch (e) { $('#tb-err').textContent = e.message; }
  };
  input.addEventListener('change', () => handle([...input.files]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); handle([...e.dataTransfer.files]); });
}


export function renderImportPlan() {
  const P = S._tb; const body = $('#tb-body'); if (!body) return;
  const pnl = (r) => (r.status === 'CLOSED' ? (r.exitPrice - r.entryPrice) * r.qty * (r.side === 'SHORT' ? -1 : 1) : null);
  const typeSel = (i, v) => `<select class="input" style="padding:5px 8px;width:auto" data-tb-type="${i}">${HORIZONS.map(([k, l]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const nothing = !P.repairs.length && !P.dateFixes.length && !P.closes.length && !P.newTrades.length;
  const tripLine = (r) => `<span class="side ${r.side}">${r.side}</span> ${nf0.format(r.qty)} · ${fmtDate(r.entryTime)} @ ${price(r.entryPrice)} → ${r.expired ? `expired ${fmtDate(r.exitTime)} @ ${price(r.exitPrice)}` : r.status === 'CLOSED' ? `${fmtDate(r.exitTime)} @ ${price(r.exitPrice)}` : 'open'}`;
  body.innerHTML = `
    <div class="row wrap" style="gap:8px;margin-bottom:14px">
      <span class="pill">${P.fills} fills · ${fmtDate(P.from)} → ${fmtDate(P.to)}</span>
      ${P.alreadyImported ? `<span class="pill">${P.alreadyImported} already imported</span>` : ''}
      ${P.dupes.length ? `<span class="pill">${P.dupes.length} already in journal</span>` : ''}
    </div>
    ${nothing ? '<div class="empty-sm">Nothing new to import from this file — your journal already has all of it.</div>' : ''}
    ${P.repairs.length ? `<section style="margin-bottom:18px"><h3 style="margin-bottom:6px">🔧 Re-pair earlier imports <span class="faint">(${P.repairs.length})</span></h3>
      <p class="faint" style="font-size:12px;margin:0 0 8px">This file has trades an earlier import missed, so these instruments are rebuilt from every fill. The earlier imported trades are replaced (notes on them are lost).</p>
      <div class="table-wrap"><table class="tbl"><thead><tr><th><input type="checkbox" data-tb-all="repair" checked></th><th>Instrument</th><th>Was</th><th>Becomes</th></tr></thead><tbody>
      ${P.repairs.map((r, i) => `<tr><td><input type="checkbox" data-tb="repair" value="${i}" checked></td><td><span class="sym">${esc(r.symbol)}</span></td>
        <td class="num" style="white-space:normal">${r.replaces.map((t) => `<div class="faint">${tripLine(t)}</div>`).join('')}</td>
        <td class="num" style="white-space:normal">${r.trips.map((t) => `<div>${tripLine(t)}${t.expired ? ` <input class="input num" style="width:86px;padding:3px 6px" type="number" step="any" min="0" data-tb-rexit="${i}:${r.trips.indexOf(t)}" value="${t.exitPrice ?? ''}" placeholder="settle">` : ''}</div>`).join('')}</td></tr>`).join('')}</tbody></table></div></section>` : ''}
    ${P.dateFixes.length ? `<section style="margin-bottom:18px"><h3 style="margin-bottom:6px">📅 Fix entry dates on open trades <span class="faint">(${P.dateFixes.length})</span></h3>
      <div class="table-wrap"><table class="tbl"><thead><tr><th><input type="checkbox" data-tb-all="fix" checked></th><th>Instrument</th><th>In journal</th><th>From tradebook</th><th></th></tr></thead><tbody>
      ${P.dateFixes.map((f, i) => `<tr><td><input type="checkbox" data-tb="fix" value="${i}" checked></td><td><span class="sym">${esc(f.trade.symbol)}</span> ${horizonPill(f.trade)}</td>
        <td class="num">${fmtDate(f.trade.entryTime)} @ ${price(f.trade.entryPrice)}</td><td class="num"><b>${fmtDT(f.entryTime)} @ ${price(f.entryPrice)}</b></td>
        <td>${f.qtyMatches ? '' : `<span class="pill gold">tradebook qty ${nf0.format(f.qty)} vs ${nf0.format(f.trade.qty)}</span>`}</td></tr>`).join('')}</tbody></table></div></section>` : ''}
    ${P.closes.length ? `<section style="margin-bottom:18px"><h3 style="margin-bottom:6px">✅ Close trades you've sold <span class="faint">(${P.closes.length})</span></h3>
      <div class="table-wrap"><table class="tbl"><thead><tr><th><input type="checkbox" data-tb-all="close" checked></th><th>Instrument</th><th class="r">Qty</th><th>Sold</th><th class="r">P&L</th></tr></thead><tbody>
      ${P.closes.map((c, i) => { const n = (c.exitPrice - c.trade.entryPrice) * c.trade.qty; return `<tr><td><input type="checkbox" data-tb="close" value="${i}" checked></td><td><span class="sym">${esc(c.trade.symbol)}</span> ${horizonPill(c.trade)}</td><td class="r num">${nf0.format(c.trade.qty)}</td><td class="num">${fmtDT(c.exitTime)} @ ${price(c.exitPrice)}</td><td class="r num ${cls(n)}">${money(n, { sign: true, dp: 0 })}</td></tr>`; }).join('')}</tbody></table></div>
      <p class="faint" style="font-size:12px;margin:6px 0 0">These are your journaled trades — open each afterwards to add an exit reason and lesson — until you do, they cost a little XP.</p></section>` : ''}
    ${P.newTrades.length ? `<section><div class="row" style="justify-content:space-between;margin-bottom:6px"><h3>🗂️ Trades not in your journal <span class="faint">(${P.newTrades.length})</span></h3><span class="faint" style="font-size:12px">Imported trades count in P&L and stats, but never earn or lose XP.</span></div>
      <div class="table-wrap" style="max-height:44vh;overflow:auto"><table class="tbl"><thead><tr><th><input type="checkbox" data-tb-all="new" checked></th><th>Instrument</th><th>Side</th><th class="r">Qty</th><th>Entry</th><th>Exit</th><th class="r">Gross P&L</th><th>Type</th></tr></thead><tbody>
      ${P.newTrades.map((r, i) => { const n = pnl(r); return `<tr><td><input type="checkbox" data-tb="new" value="${i}" checked></td><td><span class="sym">${esc(r.symbol)}</span><span class="exch">${r.exchange}</span>${r.partial ? ' <span class="pill gold">partial exit</span>' : ''}</td>
        <td><span class="side ${r.side}">${r.side}</span></td><td class="r num">${nf0.format(r.qty)}</td><td class="num">${fmtDate(r.entryTime)} @ ${price(r.entryPrice)}</td>
        <td class="num">${r.expired ? `<span class="pill gold">expired ${fmtDate(r.exitTime)}</span> @ <input class="input num" style="width:96px;padding:4px 6px" type="number" step="any" min="0" data-tb-exit="${i}" value="${r.exitPrice ?? ''}" placeholder="settle price">` : r.status === 'CLOSED' ? `${fmtDate(r.exitTime)} @ ${price(r.exitPrice)}` : '<span class="pill violet">still open</span>'}</td>
        <td class="r num ${cls(n)}">${n == null ? '—' : money(n, { sign: true, dp: 0 })}</td><td>${typeSel(i, r.horizon)}</td></tr>`; }).join('')}</tbody></table></div></section>` : ''}
    ${P.unmatched.length ? `<p class="faint" style="font-size:12px;margin-top:12px">Skipped ${P.unmatched.length} sale${P.unmatched.length > 1 ? 's' : ''} of shares bought before this file's dates (${P.unmatched.map((u) => esc(u.symbol)).slice(0, 6).join(', ')}${P.unmatched.length > 6 ? '…' : ''}). Import an older tradebook to pair them.</p>` : ''}
    <div class="err" id="tb-err"></div>
    ${nothing ? '' : '<div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-action="tradebook-apply">Import selected</button></div>'}`;
}


export async function applyImport() {
  const P = S._tb;
  const picked = (k) => $$(`[data-tb="${k}"]:checked`).map((x) => +x.value);
  const types = Object.fromEntries($$('[data-tb-type]').map((x) => [x.dataset.tbType, x.value]));
  const exits = Object.fromEntries($$('[data-tb-exit]').map((x) => [x.dataset.tbExit, x.value]));
  const missing = picked('new').filter((i) => P.newTrades[i].expired && (exits[i] === '' || exits[i] == null));
  if (missing.length) { $('#tb-err').textContent = `Enter the settlement price for ${missing.map((i) => P.newTrades[i].symbol).join(', ')} (use 0 if it expired worthless).`; return; }
  const rexits = Object.fromEntries($$('[data-tb-rexit]').map((x) => [x.dataset.tbRexit, x.value]));
  const reps = picked('repair').map((i) => P.repairs[i]);
  const repTrips = reps.flatMap((r) => r.trips.map((t, j) => ({ ...t, exitPrice: t.expired ? (rexits[`${P.repairs.indexOf(r)}:${j}`] === '' ? null : Number(rexits[`${P.repairs.indexOf(r)}:${j}`])) : t.exitPrice })));
  if (repTrips.some((t) => t.expired && (t.exitPrice == null || Number.isNaN(t.exitPrice)))) { $('#tb-err').textContent = 'Enter the settlement price for expired contracts being re-paired (0 if worthless).'; return; }
  // Exits for the server: the trip's exit orders, plus the expiry/settlement for expired contracts.
  const exitsFor = (r, settle) => {
    const ex = [...(r.exits || [])];
    if (r.expired) { const left = r.qty - ex.reduce((a, e) => a + e.qty, 0); if (left > 0) ex.push({ qty: left, price: settle, time: r.exitTime, source: 'manual' }); }
    return ex;
  };
  const toBody = (r, horizon, settle = r.exitPrice) => ({ symbol: r.symbol, exchange: r.exchange, segment: r.segment, side: r.side, qty: r.qty, entryPrice: r.entryPrice, entryTime: r.entryTime, horizon: horizon || r.horizon, fillIds: r.fillIds, entryOrders: r.entryOrders, exits: exitsFor(r, settle) });
  const payload = {
    remove: reps.flatMap((r) => r.replaces.map((t) => t.id)),
    updates: picked('fix').map((i) => ({ id: P.dateFixes[i].trade.id, entryTime: P.dateFixes[i].entryTime, entryPrice: P.dateFixes[i].entryPrice, fillIds: P.dateFixes[i].fillIds })),
    closes: picked('close').map((i) => ({ id: P.closes[i].trade.id, exitPrice: P.closes[i].exitPrice, exitTime: P.closes[i].exitTime, fillIds: P.closes[i].fillIds })),
    create: [...repTrips.map((r) => toBody(r, null, r.exitPrice)), ...picked('new').map((i) => { const r = P.newTrades[i]; return toBody(r, types[i], r.expired ? Number(exits[i]) : r.exitPrice); })],
  };
  const btn = $('[data-action="tradebook-apply"]'); if (btn) btn.disabled = true;
  try {
    const res = await api('/api/import/tradebook', { method: 'POST', body: payload });
    closeModal(); S._tb = null;
    await reload({ celebrate: true });
    toast(`<div class="t-h">⬆ Tradebook imported</div><div class="muted" style="font-size:12px;margin-top:4px">${res.created} trades added · ${res.updated} entry dates fixed · ${res.closed} closed${res.removed ? ` · ${res.removed} re-paired` : ''}</div>`);
  } catch (e) { $('#tb-err').textContent = e.message; if (btn) btn.disabled = false; }
}


export function openLinkModal(ids) {
  const legs = ids.map(findTrade).filter(Boolean);
  const already = legs.filter((l) => l.groupId);
  const form = openModal(`<form class="modal narrow" id="link-form">
    <div class="modal-h"><h2>🔗 Link as one position</h2><button type="button" class="btn ghost sm" data-action="close-modal">✕</button></div>
    <div class="modal-b stack">
      <div class="table-wrap"><table class="tbl"><tbody>${legs.map((l) => { const n = metrics(l, l.status === 'OPEN' ? ltpFor(l) : null).net; return `<tr><td><span class="sym">${esc(l.symbol)}</span></td><td><span class="side ${l.side}">${l.side}</span></td><td class="r num">${nf0.format(l.qty)}</td><td class="r num ${cls(n)}">${n == null ? '—' : money(n, { sign: true, dp: 0 })}</td></tr>`; }).join('')}</tbody></table></div>
      <div class="field"><label>Name</label><input class="input" name="name" value="${esc(suggestGroupName(legs))}" maxlength="80"></div>
      <div class="field"><label>Note (optional)</label><input class="input" name="note" placeholder="Bull call spread, hedged with puts…"></div>
      ${already.length ? `<div class="note">${already.length} of these trades ${already.length > 1 ? 'are' : 'is'} already linked elsewhere — ${already.length > 1 ? 'they' : 'it'} will move to this group.</div>` : ''}
      <p class="faint" style="font-size:12px;margin:0">In stats (win rate, best/worst trade, R, equity curve, Insights) linked legs count as one trade, booked when the last leg closes. Each leg keeps its own XP.</p>
      <div class="err" id="link-err"></div>
    </div>
    <div class="modal-f"><button type="button" class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">Link ${legs.length} trades</button></div></form>`);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/groups', { method: 'POST', body: { tradeIds: ids, name: form.name.value, note: form.note.value } });
      closeModal(); S.sel.clear(); await reload(); toast('🔗 Linked — they now count as one position in your stats');
    } catch (err) { $('#link-err').textContent = err.message; }
  });
}


export async function openSync() {
  openModal(`<div class="modal narrow" style="width:min(820px,100%)"><div class="modal-h"><h2>🔗 Journal vs Kite</h2><button class="btn ghost sm" data-action="close-modal">✕</button></div><div class="modal-b" id="sync-body"><div class="muted">Fetching your Kite holdings and positions…</div></div></div>`, { dismissable: true });
  await loadPortfolio({ quiet: false });
  const body = $('#sync-body'); if (!body) return;
  if (!S.sync) { body.innerHTML = '<div class="warn">Could not read your Kite portfolio. Check the connection in Settings.</div>'; return; }
  const ST = { match: ['green', '✓ Matches'], unlogged: ['red', 'Not in journal'], closed: ['gold', 'Closed at Kite'], qty: ['violet', 'Quantity differs'] };
  body.innerHTML = `<p class="muted" style="margin-top:0">Open journal trades compared with your Kite holdings and positions${S.kite.mock ? ' <b class="gold">(demo data)</b>' : ''}. Fix the differences so your stats and XP reflect what really happened.</p>
    ${S.sync.rows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Instrument</th><th class="r">Journal</th><th class="r">Kite</th><th>Status</th><th></th></tr></thead><tbody>
    ${S.sync.rows.map((r, i) => {
      const [c, l] = ST[r.status];
      const diff = r.kiteQty - r.journalQty;
      let act = '';
      if (r.status === 'unlogged') act = `<button class="btn sm primary" data-action="sync-log" data-i="${i}">Log trade</button> <button class="btn sm ghost" data-action="sync-ignore" data-i="${i}" title="Stop flagging this holding (e.g. an old investment you don't journal)">Ignore</button>`;
      else if (r.status === 'closed') act = `<button class="btn sm green" data-action="sync-close" data-i="${i}">Close in journal</button>`;
      else if (r.status === 'qty') act = (Math.sign(diff) === Math.sign(r.journalQty) ? `<button class="btn sm" data-action="sync-log" data-i="${i}">Log extra ${nf0.format(Math.abs(diff))}</button> ` : '') + `<button class="btn sm ghost" data-action="sync-review" data-i="${i}">Review</button>`;
      return `<tr><td><span class="sym">${esc(r.symbol)}</span><span class="exch">${r.exchange}</span></td>
        <td class="r num">${r.journalQty ? nf0.format(r.journalQty) : '—'}</td><td class="r num">${r.kiteQty ? nf0.format(r.kiteQty) : '—'}</td>
        <td><span class="pill ${c}">${l}</span></td><td class="r">${act}</td></tr>`;
    }).join('')}</tbody></table></div>
    ${S.sync.ignored ? `<p class="faint" style="font-size:12px">${S.sync.ignored} ignored holding${S.sync.ignored > 1 ? 's' : ''} hidden — manage in Settings.</p>` : ''}<p class="faint" style="font-size:12px;margin-bottom:0">Negative = short. Partly exited a position? Edit the trade's quantity, or close it and log the remainder as a new trade.</p>`
    : '<div class="empty-sm">Nothing open at Kite or in your journal.</div>'}`;
  render();
}


export async function openFills() {
  const el = openModal(`<div class="modal narrow" style="width:min(760px,100%)"><div class="modal-h"><h2>⚡ Today's Kite fills</h2><button class="btn ghost sm" data-action="close-modal">✕</button></div><div class="modal-b" id="fills-body"><div class="muted">Loading…</div></div></div>`, { dismissable: true });
  try {
    const { fills } = await api('/api/kite/fills');
    const open = S.state.trades.filter((t) => t.status === 'OPEN');
    el._fills = fills;
    $('#fills-body').innerHTML = fills.length ? `<p class="muted" style="margin-top:0">Turn an executed order into a journal entry, or use it as the exit of a matching open trade. ${S.kite.mock ? '<b class="gold">(demo data)</b>' : ''}</p>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th class="r">Qty</th><th class="r">Avg price</th><th></th></tr></thead><tbody>
      ${fills.map((f, i) => {
      const match = open.find((t) => t.symbol === f.symbol && t.exchange === f.exchange && ((t.side === 'LONG' && f.side === 'SELL') || (t.side === 'SHORT' && f.side === 'BUY')));
      return `<tr><td class="muted">${fmtTime(f.time)}</td><td><span class="sym">${esc(f.symbol)}</span><span class="exch">${f.exchange}</span></td><td><span class="side ${f.side === 'BUY' ? 'LONG' : 'SHORT'}">${f.side}</span></td><td class="r num">${nf0.format(f.qty)}</td><td class="r num">${price(f.price)}</td>
        <td class="r">${match ? `<button class="btn sm green" data-action="fill-exit" data-i="${i}" data-id="${match.id}">Use as exit</button>` : ''} <button class="btn sm" data-action="fill-entry" data-i="${i}">Log entry</button></td></tr>`;
    }).join('')}</tbody></table></div>` : '<div class="empty-sm">No executed trades on Kite today.</div>';
    S._fills = fills;
  } catch (e) { $('#fills-body').innerHTML = `<div class="warn">${esc(e.message)}</div>`; }
}
