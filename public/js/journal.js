import { metrics, HORIZONS, isLT } from '../game.js';
import { $, esc, nf0, num, sum, money, price, rfmt, cls, fmtDate, xpPill, SEGMENTS, DEFAULT_SETUPS } from './util.js';
import { S, horizonPill, linkPill, ltpFor } from './state.js';


// ---------- Journal ----------
export function filteredTrades() {
  const f = S.f; const q = f.q.trim().toLowerCase();
  return S.state.trades.filter((t) => {
    if (f.status !== 'all' && t.status !== f.status) return false;
    if (f.segment !== 'all' && t.segment !== f.segment) return false;
    if (f.horizon === 'TRADING' && isLT(t)) return false;
    if (f.horizon !== 'all' && f.horizon !== 'TRADING' && t.horizon !== f.horizon) return false;
    if (f.setup !== 'all' && (t.setup || '') !== f.setup) return false;
    if (q && !`${t.symbol} ${t.setup} ${t.thesis} ${t.lessons} ${(t.tags || []).join(' ')}`.toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => new Date(b.entryTime) - new Date(a.entryTime));
}


export function selBar() {
  const n = S.sel.size;
  if (!n) return '';
  return `<span class="row" style="gap:6px"><span class="pill violet">${n} selected</span>${n >= 2 ? '<button class="btn sm primary" data-action="link-selected">🔗 Link as one position</button>' : '<span class="faint" style="font-size:12px">select 2+ legs to link</span>'}<button class="btn sm ghost" data-action="clear-sel">Clear</button></span>`;
}


export function setupOptions() {
  return [...new Set([...S.state.trades.map((t) => t.setup).filter(Boolean), ...DEFAULT_SETUPS])];
}


export function pageJournal() {
  const usedSetups = [...new Set(S.state.trades.map((t) => t.setup).filter(Boolean))].sort();
  const f = S.f;
  return `<div class="page-h"><div><h1>Journal</h1><p>Every trade, its plan, and the XP it earned.</p></div>
    <div class="row">${S.kite.connected ? `<button class="btn" data-action="kite-sync">🔗 Sync with Kite${S.sync?.issues ? ` <span class="pill red">${S.sync.issues}</span>` : ''}</button><button class="btn" data-action="kite-fills">⚡ Today's Kite fills</button>` : ''}<button class="btn" data-action="tradebook-import">⬆ Import tradebook</button><button class="btn primary" data-action="new-trade">＋ New trade</button></div></div>
    <div class="toolbar">
      <input class="input search" placeholder="Search symbol, setup, notes…" data-filter="q" value="${esc(f.q)}">
      <div class="seg">${[['all', 'All'], ['OPEN', 'Open'], ['CLOSED', 'Closed']].map(([v, l]) => `<label><input type="radio" name="fstatus" data-filter="status" value="${v}" ${f.status === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
      <select class="input" data-filter="horizon"><option value="all">All types</option><option value="TRADING" ${f.horizon === 'TRADING' ? 'selected' : ''}>Trading only</option>${HORIZONS.map(([v, l]) => `<option value="${v}" ${f.horizon === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select class="input" data-filter="segment"><option value="all">All segments</option>${SEGMENTS.map(([v, l]) => `<option value="${v}" ${f.segment === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select class="input" data-filter="setup"><option value="all">All setups</option>${usedSetups.map((s) => `<option ${f.setup === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
      <span id="sel-bar">${selBar()}</span>
      <span class="muted" id="journal-summary" style="margin-left:auto"></span>
    </div>
    <div class="card" style="padding:6px 14px"><div class="table-wrap"><table class="tbl jt"><thead><tr>
      <th style="width:28px"><input type="checkbox" data-sel-all title="Select all shown"></th><th>Entered</th><th>Symbol</th><th>Type</th><th>Side</th><th class="r">Qty</th><th class="r">Entry</th><th class="r">Exit / LTP</th><th class="r">Net P&L</th><th class="r">R</th><th>Setup</th><th>Plan</th><th class="r">XP</th></tr></thead>
      <tbody id="journal-body">${journalRows()}</tbody></table></div></div>`;
}


export function journalRows() {
  const list = filteredTrades();
  queueMicrotask(() => {
    const el = $('#journal-summary');
    if (el) { const n = sum(list.filter((t) => t.status === 'CLOSED').map((t) => metrics(t).net)); el.innerHTML = `${list.length} trades · realised <span class="${cls(n)} mono">${money(n, { sign: true })}</span>`; }
  });
  if (!list.length) return `<tr><td colspan="13"><div class="empty-sm">${S.state.trades.length ? 'No trades match these filters.' : 'No trades yet — log your first one.'}</div></td></tr>`;
  return list.map((t) => {
    const ltp = t.status === 'OPEN' ? ltpFor(t) : null;
    const m = metrics(t, ltp); const x = S.game.tradeXp[t.id] || 0;
    const plan = t.status === 'OPEN' ? '<span class="pill violet">open</span>' : t.followedPlan === true ? '<span class="pill green">✓ kept</span>' : t.followedPlan === false ? '<span class="pill red">✕ broke</span>' : '<span class="pill">—</span>';
    return `<tr class="click ${S.sel.has(t.id) ? 'selected' : ''}" data-action="open-drawer" data-id="${t.id}">
      <td data-stop><input type="checkbox" data-sel="${t.id}" ${S.sel.has(t.id) ? 'checked' : ''}></td>
      <td class="muted">${fmtDate(t.entryTime)}</td>
      <td><span class="sym">${esc(t.symbol)}</span><span class="exch">${t.exchange}</span> ${linkPill(t)}</td>
      <td>${horizonPill(t)}</td>
      <td><span class="side ${t.side}">${t.side}</span></td>
      <td class="r num">${t.status === 'OPEN' && m.exQty ? `${nf0.format(m.openQty)}<span class="faint">/${nf0.format(t.qty)}</span>` : nf0.format(t.qty)}</td>
      <td class="r num">${price(t.entryPrice)}</td>
      <td class="r num">${t.status === 'CLOSED' ? price(t.exitPrice) : ltp != null ? `<span class="faint">${price(ltp)}</span>` : '—'}</td>
      <td class="r num ${cls(m.net)}">${m.net == null ? '—' : money(m.net, { sign: true })}${t.status === 'OPEN' && m.net != null ? ' <span class="faint">·u</span>' : ''}</td>
      <td class="r num ${cls(m.r)}">${rfmt(m.r)}</td>
      <td>${t.setup ? `<span class="pill">${esc(t.setup)}</span>` : '<span class="faint">—</span>'}</td>
      <td>${plan}</td>
      <td class="r">${t.imported ? '<span class="pill" title="Imported from tradebook — no XP">imported</span>' : xpPill(x) || '<span class="faint">0</span>'}</td>
    </tr>`;
  }).join('');
}
