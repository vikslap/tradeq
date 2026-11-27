// 📝 Live paper trading: a separate ₹6,00,000 practice account traded against live Kite prices,
// with Kite's order window (regular / AMO / cover / iceberg, Market / Limit / SL / SL-M,
// CNC / MIS / MTF / NRML, Day / IOC / TTL, disclosed qty, stoploss & target), GTTs, positions,
// holdings and stats. Orders are simulated on the server; nothing reaches your real Kite account.
import { S, api } from './state.js';
import { $, $$, esc, nf2, nf0, money, cls, paint } from './util.js';
import { openModal, closeModal, confirmBox, toast } from './ui.js';
import { clientSearch, searchLocal } from './kiteinst.js';
import { noteRiskFree } from './riskfree-alerts.js';

const WKEY = 'tq-paper-watch';
const TKEY = 'tq-paper-tab';
const DEFAULT_WATCH = [
  { exchange: 'NSE', symbol: 'RELIANCE', segment: 'EQ', lotSize: 1, tickSize: 0.05, token: 738561, name: 'RELIANCE INDUSTRIES' },
  { exchange: 'NSE', symbol: 'HDFCBANK', segment: 'EQ', lotSize: 1, tickSize: 0.05, token: 341249, name: 'HDFC BANK' },
  { exchange: 'NSE', symbol: 'INFY', segment: 'EQ', lotSize: 1, tickSize: 0.05, token: 408065, name: 'INFOSYS' },
];
const P = { data: null, timer: null, busy: false, tab: null, sel: null };
const get = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const put = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private */ } };
const watch = () => get(WKEY, DEFAULT_WATCH);
const kOf = (x) => `${x.exchange}:${x.symbol}`;
const rs = (v) => money(v, { dp: 2 });
const rs0 = (v) => money(v, { dp: 0 });
const tm = (ms) => new Date(ms + 330 * 60000).toISOString().slice(11, 19);
const dt = (ms) => new Date(ms).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
const segName = (s) => (s === 'EQ' ? 'Equity' : s === 'FUT' ? 'Futures' : s === 'COM' ? 'Commodity' : s);
const PROD_LABEL = { CNC: 'Longterm (CNC)', MIS: 'Intraday (MIS)', MTF: 'MTF', NRML: 'Overnight (NRML)' };
const STATUS_CLS = { COMPLETE: 'pos', REJECTED: 'neg', CANCELLED: 'muted', OPEN: 'warn', 'TRIGGER PENDING': 'warn', 'AMO REQ RECEIVED': 'warn' };
const isLive = (o) => ['OPEN', 'TRIGGER PENDING', 'AMO REQ RECEIVED'].includes(o.status);
const groupOf = (ex) => (ex === 'MCX' ? 'MCX' : ex === 'NFO' || ex === 'BFO' ? 'FO' : 'EQ');
const ltp = (x) => P.data?.quotes?.[kOf(x)]?.ltp ?? null;

// ---------------------------------------------------------------- page
export function pagePaper() {
  P.tab = P.tab || get(TKEY, 'positions');
  return `<div class="page-h"><div><h1>📝 Paper trading</h1><p>Live Kite prices, Kite's order types — your own ₹ practice account. Nothing here reaches your real account.</p></div>
    <div id="pp-status" class="pp-status"></div></div>
  <div class="pp-grid">
    <aside class="pp-side">
      <section class="card pp-funds" id="pp-funds"><div class="empty-sm">Loading…</div></section>
      <section class="card pp-watch">
        <div class="pp-search"><input id="pp-q" placeholder="Search stocks, futures, commodities  ( / )" autocomplete="off" spellcheck="false"><div id="pp-results" class="pp-results" hidden></div></div>
        <div id="pp-watchlist"></div>
        <div class="sub desk-only" style="font-size:11px;margin-top:8px">Hover a row for Buy / Sell. Shortcuts: <kbd>B</kbd> buy, <kbd>S</kbd> sell the selected row, <kbd>/</kbd> search.</div>
      </section>
    </aside>
    <div class="pp-main">
      <div class="pp-tabs" role="tablist">${[['positions', 'Positions'], ['orders', 'Orders'], ['gtt', 'GTT'], ['holdings', 'Holdings'], ['stats', 'Stats & funds']].map(([k, l]) => `<button role="tab" data-pp-tab="${k}" class="${P.tab === k ? 'on' : ''}">${l}<span class="pp-count" data-pp-count="${k}"></span></button>`).join('')}</div>
      <section class="card" id="pp-body"><div class="empty-sm">Loading…</div></section>
    </div>
  </div>`;
}

export async function mountPaper() {
  wire();
  await refresh(true);
  clearInterval(P.timer);
  P.timer = setInterval(() => {
    if (!$('#pp-body')) { clearInterval(P.timer); return; }
    if (document.hidden) return;
    const open = Object.values(P.data?.groups || {}).some((g) => g.open);
    const due = open ? 2000 : 30000;
    if (Date.now() - (P.at || 0) >= due - 100) refresh();
  }, 2000);
}

async function refresh(force = false) {
  if (P.busy) return; P.busy = true;
  try {
    const keys = watch().map(kOf).join(',');
    P.data = await api(`/api/paper?watch=${encodeURIComponent(keys)}${force ? '&force=1' : ''}`);
    P.at = Date.now();
    paintAll();
  } catch (e) {
    const b = $('#pp-body'); if (b && !P.data) b.innerHTML = `<div class="note warn"><span>${esc(e.message)}</span></div>`;
  } finally { P.busy = false; }
}

function paintAll() {
  if (!P.data || !$('#pp-body')) return;
  paintStatus(); paintFunds(); paintWatch(); paintTab(); paintCounts();
  noteRiskFree(P.data.positions.filter((p) => p.qty).map((p) => ({ id: `${kOf(p)}:${p.product}:${p.openedAt}`, label: p.symbol, free: !!p.rf?.free, locked: p.rf?.locked ?? 0 })), 'paper');
  if (S.ow) owQuote();
}

function paintStatus() {
  const g = P.data.groups; const el = $('#pp-status'); if (!el) return;
  const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  paint(el, Object.entries(g).map(([k, x]) => `<span class="pp-mkt ${x.open ? 'on' : ''}" title="${x.label}: ${hm(x.opens)}–${hm(x.closes)} IST · MIS squared off at ${hm(x.misCut)}"><i></i>${esc(x.label)} ${x.open ? 'open' : 'closed'}</span>`).join('') + (S.kite?.connected ? '' : '<span class="pp-mkt neg-b">Kite not connected — prices unavailable</span>'));
}

function paintFunds() {
  const f = P.data.funds; const el = $('#pp-funds'); if (!el) return;
  const pnl = f.equity - f.capital;
  paint(el, `<div class="pp-f-top"><div><div class="k">Available margin</div><div class="v mono">${rs(f.available)}</div></div><div style="text-align:right"><div class="k">Account value</div><div class="v mono">${rs0(f.equity)}</div><div class="mono ${cls(pnl)}" style="font-size:12px">${pnl >= 0 ? '+' : ''}${rs0(pnl)} (${((pnl / f.capital) * 100).toFixed(2)}%)</div></div></div>
    <div class="pp-f-rows"><span>Used margin</span><b class="mono">${rs0(f.used)}</b><span>Open P&L</span><b class="mono ${cls(f.mtm + f.unrealHold)}">${rs0(f.mtm + f.unrealHold)}</b><span>Capital</span><b class="mono">${rs0(f.capital)}</b><span>Risk per trade</span><b class="mono">${P.data.riskPct}% · ${rs0((f.capital * P.data.riskPct) / 100)}</b></div>`);
}

// ---------------------------------------------------------------- watchlist & search
function paintWatch() {
  const el = $('#pp-watchlist'); if (!el) return;
  const rows = watch().map((w) => {
    const q = P.data?.quotes?.[kOf(w)]; const ch = q?.changePct != null ? q.changePct * 100 : null;
    return `<div class="pp-w ${P.sel === kOf(w) ? 'sel' : ''}" data-pp-row="${esc(kOf(w))}">
      <div class="pp-w-n"><b class="${ch == null ? '' : ch >= 0 ? 'pos' : 'neg'}">${esc(w.symbol)}</b><small>${esc(w.exchange)}${w.segment !== 'EQ' ? ` · ${segName(w.segment)}${w.lotSize > 1 ? ` · lot ${w.lotSize}` : ''}` : ''}</small></div>
      <div class="pp-w-p"><span class="mono">${q?.ltp ? nf2.format(q.ltp) : '—'}</span><small class="${cls(ch)}">${ch == null ? '' : `${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%`}</small></div>
      <div class="pp-w-a"><button class="pp-b" data-pp-buy="${esc(kOf(w))}" title="Buy (B)">B</button><button class="pp-s" data-pp-sell="${esc(kOf(w))}" title="Sell (S)">S</button><button class="pp-x" data-pp-unwatch="${esc(kOf(w))}" title="Remove">✕</button></div>
    </div>`;
  }).join('');
  paint(el, rows || '<div class="empty-sm">Search above to add instruments.</div>');
}

let searchT = null;
async function doSearch(q) {
  const box = $('#pp-results'); if (!box) return;
  if (!q.trim()) { box.hidden = true; return; }
  try {
    const hits = (clientSearch() ? await searchLocal(q) : (await api(`/api/kite/search?q=${encodeURIComponent(q)}`)).results)
      .filter((h) => ['EQ', 'FUT', 'COM'].includes(h.segment) && !['CE', 'PE'].includes(h.type));
    const miss = (hits.missing || []).length ? `<div class="sub" style="padding:6px 10px;font-size:11.5px">${esc(hits.missing.join(', '))} list${hits.missing.length > 1 ? 's' : ''} didn't load (Kite busy) — those results are missing; try again shortly.</div>` : '';
    box.innerHTML = miss + (hits.length ? hits.slice(0, 12).map((h, i) => `<button class="pp-r" data-pp-add="${i}"><b>${esc(h.symbol)}</b> <small>${esc(h.exchange)} · ${segName(h.segment)}${h.expiry ? ` · ${esc(h.expiry)}` : ''}${h.lotSize > 1 ? ` · lot ${h.lotSize}` : ''}</small><span>${esc(h.name || '')}</span></button>`).join('') : '<div class="empty-sm">No matching stock, future or commodity</div>');
    box._hits = hits; box.hidden = false;
  } catch (e) { box.innerHTML = `<div class="sub neg" style="padding:8px">${esc(e.message)}</div>`; box.hidden = false; }
}

// ---------------------------------------------------------------- tabs
function paintCounts() {
  const d = P.data; const n = { positions: d.positions.filter((p) => p.qty).length, orders: d.orders.filter(isLive).length, gtt: d.gtts.filter((g) => g.status === 'active').length, holdings: d.holdings.length };
  for (const [k, v] of Object.entries(n)) { const el = $(`[data-pp-count="${k}"]`); if (el) el.textContent = v ? v : ''; }
}

function paintTab() {
  const el = $('#pp-body'); if (!el) return;
  const fn = { positions: tabPositions, orders: tabOrders, gtt: tabGtt, holdings: tabHoldings, stats: tabStats }[P.tab] || tabPositions;
  paint(el, fn());
}

function tabPositions() {
  const d = P.data; const open = d.positions.filter((p) => p.qty); const closed = d.positions.filter((p) => !p.qty);
  const pnlOf = (p) => { const l = ltp(p) ?? p.avg; return (l - p.avg) * p.qty + (p.realized || 0); };
  const total = d.positions.reduce((s, p) => s + pnlOf(p), 0);
  if (!d.positions.length) return '<div class="empty-sm">No positions today. Search for an instrument and press <b>B</b> or <b>S</b> to place an order.</div>';
  const row = (p) => { const l = ltp(p); const pl = pnlOf(p); const ch = l && p.avg ? ((l - p.avg) / p.avg) * 100 * Math.sign(p.qty || 1) : null; return `<tr class="${p.qty ? '' : 'muted'}">
    <td><span class="pill">${esc(p.product)}</span></td><td><b>${esc(p.symbol)}</b> <small class="muted">${esc(p.exchange)}</small>${p.rf ? `<div class="sub" style="font-size:11px">stop ${nf2.format(p.rf.stop)}${p.rf.free ? ` <span class="pill rf" title="If the stop is hit this still makes ${esc(rs(p.rf.locked))} after charges">🛡️ risk-free</span>` : ` · risk ${rs0(-p.rf.locked)}`}</div>` : p.qty ? '<div class="sub neg" style="font-size:11px">no stop</div>' : ''}</td>
    <td class="r mono ${p.qty > 0 ? 'pos' : p.qty < 0 ? 'neg' : ''}" data-l="Qty">${p.qty}</td><td class="r mono" data-l="Avg">${p.qty ? nf2.format(p.avg) : '—'}</td>
    <td class="r mono" data-l="LTP">${l ? nf2.format(l) : '—'}</td><td class="r mono ${cls(pl)}" data-l="P&L"><b>${rs(pl)}</b></td><td class="r mono ${cls(ch)}" data-l="Chg">${ch == null || !p.qty ? '' : `${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%`}</td>
    <td class="r pp-act">${p.qty ? `<button class="btn sm" data-pp-add-pos="${esc(kOf(p))}|${p.product}">Add</button><button class="btn sm danger" data-pp-exit="${esc(kOf(p))}|${p.product}">Exit</button><button class="btn sm ghost" data-pp-convert="${esc(kOf(p))}|${p.product}">Convert</button><button class="btn sm ghost" data-pp-gtt-pos="${esc(kOf(p))}|${p.product}">GTT</button>` : '<span class="sub">closed</span>'}</td></tr>`; };
  return `<div class="pp-sum"><span>Total P&L (today's positions)</span><b class="mono ${cls(total)}">${rs(total)}</b></div>
    <div class="table-wrap"><table class="tbl pp-tbl"><thead><tr><th>Product</th><th>Instrument</th><th class="r">Qty</th><th class="r">Avg</th><th class="r">LTP</th><th class="r">P&L</th><th class="r">Chg</th><th></th></tr></thead><tbody>${[...open, ...closed].map(row).join('')}</tbody></table></div>`;
}

function tabOrders() {
  const d = P.data; const live = d.orders.filter(isLive).reverse(); const done = d.orders.filter((o) => !isLive(o) && !o.icebergOf).reverse().slice(0, 150);
  const row = (o) => `<tr>
    <td class="mono" data-l="Time">${tm(o.placedAt)}${o.placedAt < Date.now() - 20 * 3600000 ? `<div class="sub">${dt(o.placedAt).slice(0, 6)}</div>` : ''}</td>
    <td><b class="${o.side === 'BUY' ? 'pos' : 'neg'}">${o.side}</b></td>
    <td><b>${esc(o.symbol)}</b> <small class="muted">${esc(o.exchange)}</small>${o.variety !== 'regular' ? ` <span class="pill">${o.coLeg ? 'CO stop' : esc(o.variety.toUpperCase())}</span>` : ''}${o.tag ? ` <span class="pill">${esc(o.tag)}</span>` : ''}</td>
    <td data-l="Product">${esc(o.product)}</td><td data-l="Type">${esc(o.type)}${o.validity !== 'DAY' ? ` · ${o.validity === 'TTL' ? `${o.ttl}m` : o.validity}` : ''}</td>
    <td class="r mono" data-l="Qty">${o.filled}/${o.qty}</td>
    <td class="r mono" data-l="Price">${o.avgPrice ? nf2.format(o.avgPrice) : o.price ? nf2.format(o.price) : 'MKT'}${o.trigger ? `<div class="sub">trg ${nf2.format(o.trigger)}</div>` : ''}${o.coTrigger && !o.coLeg ? `<div class="sub">CO stop ${nf2.format(o.coTrigger)}</div>` : ''}</td>
    <td data-l="Status"><span class="pp-st ${STATUS_CLS[o.status] || ''}" title="${esc(o.message || '')}">${esc(o.status)}</span>${o.message && !isLive(o) && o.status !== 'COMPLETE' ? `<div class="sub" style="max-width:220px">${esc(o.message)}</div>` : ''}</td>
    <td class="r pp-act">${isLive(o) ? `${o.icebergOf ? '' : `<button class="btn sm" data-pp-modify="${o.id}">Modify</button>`}${o.coLeg ? '' : `<button class="btn sm ghost" data-pp-cancel="${o.id}">Cancel</button>`}` : `<button class="btn sm ghost" data-pp-repeat="${o.id}" title="Place this order again">Repeat</button>`}</td></tr>`;
  const head = '<thead><tr><th>Time</th><th>Type</th><th>Instrument</th><th>Product</th><th>Order</th><th class="r">Qty</th><th class="r">Price</th><th>Status</th><th></th></tr></thead>';
  return `<h3 class="pp-h">Open orders <span class="sub">${live.length}</span></h3>
    ${live.length ? `<div class="table-wrap"><table class="tbl pp-tbl pp-otbl">${head}<tbody>${live.map(row).join('')}</tbody></table></div>` : '<div class="empty-sm">No open orders.</div>'}
    <h3 class="pp-h" style="margin-top:18px">Executed & closed <span class="sub">last 30 days</span></h3>
    ${done.length ? `<div class="table-wrap"><table class="tbl pp-tbl pp-otbl">${head}<tbody>${done.map(row).join('')}</tbody></table></div>` : '<div class="empty-sm">Nothing yet.</div>'}`;
}

function tabGtt() {
  const d = P.data; const act = d.gtts.filter((g) => g.status === 'active').reverse(); const old = d.gtts.filter((g) => g.status !== 'active').reverse().slice(0, 50);
  const row = (g) => `<tr><td class="mono" data-l="Created">${dt(g.createdAt)}</td><td><b>${esc(g.symbol)}</b> <small class="muted">${esc(g.exchange)}</small></td>
    <td data-l="Type">${g.type === 'oco' ? 'OCO' : 'Single'}</td><td><b class="${g.side === 'BUY' ? 'pos' : 'neg'}">${g.side}</b> ${g.qty} · ${esc(g.product)}</td>
    <td class="r mono" data-l="Trigger">${g.type === 'oco' ? `SL ${nf2.format(g.stop)}<div class="sub">Target ${nf2.format(g.target)}</div>` : nf2.format(g.trigger)}</td>
    <td class="r mono" data-l="LTP">${ltp(g) ? nf2.format(ltp(g)) : '—'}</td>
    <td data-l="Status"><span class="pp-st ${g.status === 'active' ? 'warn' : g.status === 'triggered' ? 'pos' : 'muted'}">${esc(g.status)}</span>${g.note ? `<div class="sub">${esc(g.note)}</div>` : ''}</td>
    <td class="r pp-act">${g.status === 'active' ? `<button class="btn sm ghost" data-pp-gtt-del="${g.id}">Delete</button>` : ''}</td></tr>`;
  const head = '<thead><tr><th>Created</th><th>Instrument</th><th>Type</th><th>Order</th><th class="r">Trigger</th><th class="r">LTP</th><th>Status</th><th></th></tr></thead>';
  return `<div class="row" style="justify-content:space-between;margin-bottom:8px"><h3 class="pp-h" style="margin:0">Active GTTs <span class="sub">${act.length}</span></h3><button class="btn sm" data-pp-gtt-new>＋ New GTT</button></div>
    ${act.length ? `<div class="table-wrap"><table class="tbl pp-tbl">${head}<tbody>${act.map(row).join('')}</tbody></table></div>` : '<div class="empty-sm">No active GTTs. Add a stoploss / target in the order window, or create one here.</div>'}
    ${old.length ? `<h3 class="pp-h" style="margin-top:18px">Triggered, deleted & expired</h3><div class="table-wrap"><table class="tbl pp-tbl">${head}<tbody>${old.map(row).join('')}</tbody></table></div>` : ''}`;
}

function tabHoldings() {
  const d = P.data;
  if (!d.holdings.length) return '<div class="empty-sm">No holdings. Delivery (CNC) buys move here after the close.</div>';
  let inv = 0; let cur = 0;
  const rows = d.holdings.map((h) => { const l = ltp(h) ?? h.avg; const pl = (l - h.avg) * h.qty; inv += h.avg * h.qty; cur += l * h.qty; const q = P.data.quotes[kOf(h)]; const day = q?.prevClose ? (l - q.prevClose) * h.qty : null;
    return `<tr><td><b>${esc(h.symbol)}</b> <small class="muted">${esc(h.exchange)}</small></td><td class="r mono" data-l="Qty">${h.qty}</td><td class="r mono" data-l="Avg">${nf2.format(h.avg)}</td><td class="r mono" data-l="LTP">${nf2.format(l)}</td><td class="r mono" data-l="Value">${rs0(l * h.qty)}</td><td class="r mono ${cls(pl)}" data-l="P&L"><b>${rs(pl)}</b><div class="sub">${((pl / (h.avg * h.qty)) * 100).toFixed(2)}%</div></td><td class="r mono ${cls(day)}" data-l="Day">${day == null ? '—' : rs0(day)}</td>
    <td class="r pp-act"><button class="btn sm danger" data-pp-sellhold="${esc(kOf(h))}">Exit</button><button class="btn sm ghost" data-pp-gtt-hold="${esc(kOf(h))}">GTT</button></td></tr>`; }).join('');
  return `<div class="kpis k4" style="margin-bottom:12px"><div class="kpi"><div class="k">Invested</div><div class="v mono">${rs0(inv)}</div></div><div class="kpi"><div class="k">Current value</div><div class="v mono">${rs0(cur)}</div></div><div class="kpi"><div class="k">P&L</div><div class="v mono ${cls(cur - inv)}">${rs0(cur - inv)}</div></div><div class="kpi"><div class="k">Return</div><div class="v mono ${cls(cur - inv)}">${inv ? (((cur - inv) / inv) * 100).toFixed(2) : '0.00'}%</div></div></div>
    <div class="table-wrap"><table class="tbl pp-tbl"><thead><tr><th>Instrument</th><th class="r">Qty</th><th class="r">Avg</th><th class="r">LTP</th><th class="r">Value</th><th class="r">P&L</th><th class="r">Day</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function tabStats() {
  const d = P.data; const s = d.stats; const f = d.funds;
  const k = (l, v, sub = '', c = '') => `<div class="kpi"><div class="k">${l}</div><div class="v mono ${c}">${v}</div><div class="s">${sub}</div></div>`;
  const closed = d.trades.filter((t) => t.closedAt).reverse().slice(0, 100);
  return `<div class="kpis k4" style="margin-bottom:12px">
      ${k('Net P&L (closed)', rs0(s.net), `${s.trades} trades · ${rs0(s.charges)} charges`, cls(s.net))}
      ${k('Win rate', s.winRate == null ? '—' : `${Math.round(s.winRate * 100)}%`, `${s.wins} wins · ${s.losses} losses`)}
      ${k('Avg win / loss', `${s.avgWin == null ? '—' : rs0(s.avgWin)} / ${s.avgLoss == null ? '—' : rs0(s.avgLoss)}`, s.profitFactor == null ? '' : `profit factor ${s.profitFactor}`)}
      ${k('Avg R', s.avgR == null ? '—' : `${s.avgR >= 0 ? '+' : ''}${s.avgR}R`, s.totalR == null ? 'set a stoploss to measure R' : `total ${s.totalR >= 0 ? '+' : ''}${s.totalR}R`, cls(s.avgR))}
    </div>
    ${closed.length ? `<div class="table-wrap"><table class="tbl pp-tbl"><thead><tr><th>Closed</th><th>Instrument</th><th>Side</th><th class="r">Qty</th><th class="r">Entry</th><th class="r">Exit</th><th class="r">Net P&L</th><th class="r">R</th></tr></thead><tbody>${closed.map((t) => `<tr><td class="mono" data-l="Closed">${dt(t.closedAt)}</td><td><b>${esc(t.symbol)}</b> <span class="pill">${esc(t.product)}</span></td><td data-l="Side" class="${t.side === 'LONG' ? 'pos' : 'neg'}">${t.side}</td><td class="r mono" data-l="Qty">${t.qty}</td><td class="r mono" data-l="Entry">${nf2.format(t.entryValue / t.qty)}</td><td class="r mono" data-l="Exit">${nf2.format(t.exitValue / Math.max(1, t.exitQty))}</td><td class="r mono ${cls(t.net)}" data-l="Net"><b>${rs0(t.net)}</b></td><td class="r mono ${cls(t.r)}" data-l="R">${t.r == null ? '—' : `${t.r >= 0 ? '+' : ''}${t.r}R`}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-sm">Closed trades and their results show here.</div>'}
    <h3 class="pp-h" style="margin-top:18px">Funds</h3>
    <div class="pp-fund-tbl"><span>Starting capital</span><b class="mono">${rs(f.capital)}</b><span>Cash (capital + realised P&L − charges)</span><b class="mono">${rs(f.cash)}</b><span>Margin used by positions & holdings</span><b class="mono">${rs(f.blockedPos)}</b><span>Margin blocked by open orders</span><b class="mono">${rs(f.blockedOrders)}</b><span>Open P&L (positions · holdings)</span><b class="mono">${rs(f.mtm)} · ${rs(f.unrealHold)}</b><span>Charges paid</span><b class="mono">${rs(f.charges)}</b><span><b>Available margin</b></span><b class="mono">${rs(f.available)}</b></div>
    <h3 class="pp-h" style="margin-top:18px">Settings</h3>
    <div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-end">
      <label class="fld"><span>Risk per trade (% of capital)</span><input id="pp-risk" type="number" step="0.1" min="0.1" max="10" value="${d.riskPct}" style="width:110px"></label>
      <button class="btn sm" data-pp-save-risk>Save</button>
      <span style="flex:1"></span>
      <label class="fld"><span>Start over with capital (₹)</span><input id="pp-cap" type="number" step="10000" min="10000" value="${d.capital}" style="width:140px"></label>
      <button class="btn sm danger" data-pp-reset>Reset paper account</button>
    </div>
    <p class="faint" style="font-size:11.5px;margin-top:12px">How fills work: market orders take the best bid/ask from Kite's live quote; limit orders fill when the market reaches your price; SL / SL-M trigger on the last traded price. If no page was open, the missed minutes are replayed from Kite's 1-minute candles (the hosted site also checks every minute on its own). Margins come from Kite's margin calculator when it answers, otherwise Zerodha's usual levels. Charges are Zerodha's (${esc('Nov 2026')} rates); MIS positions are squared off at 15:20 (equity), 15:25 (F&O) and 23:05 (MCX) with the ₹59 auto square-off charge. Futures are settled at the close on expiry day.</p>`;
}

// ---------------------------------------------------------------- order window
function findInst(key) {
  const w = watch().find((x) => kOf(x) === key); if (w) return w;
  const p = [...(P.data?.positions || []), ...(P.data?.holdings || []), ...(P.data?.orders || [])].find((x) => kOf(x) === key);
  return p ? { exchange: p.exchange, symbol: p.symbol, token: p.token, segment: p.segment || 'EQ', lotSize: p.lotSize || 1, tickSize: p.tickSize || 0.05, expiry: p.expiry || null } : null;
}

function marketOpenFor(inst) { return P.data?.groups?.[groupOf(inst.exchange)]?.open; }

export function openOrderWindow(inst, side, preset = {}) {
  if (!inst) return;
  const fo = inst.segment !== 'EQ';
  const open = marketOpenFor(inst);
  const o = { variety: open ? 'regular' : 'amo', product: fo ? 'NRML' : 'CNC', type: 'LIMIT', qty: fo ? inst.lotSize : 1, validity: 'DAY', ...preset };
  if (!open && o.variety !== 'amo') o.variety = 'amo';
  S.ow = { inst, side, o, modify: preset.modifyId || null };
  const l = ltp(inst);
  if (o.price == null && o.type === 'LIMIT' && l) o.price = l;
  const el = openModal(`<div class="modal ow ${side === 'BUY' ? 'ow-buy' : 'ow-sell'}" id="ow">
    <div class="ow-h"><div><div class="ow-t"><span id="ow-side-label">${side === 'BUY' ? 'Buy' : 'Sell'}</span> <b>${esc(inst.symbol)}</b> <small>${esc(inst.exchange)}${fo ? ` · lot ${inst.lotSize}` : ''}${inst.expiry ? ` · exp ${esc(inst.expiry)}` : ''}</small></div><div class="ow-q mono" id="ow-quote">—</div></div>
      ${preset.modifyId ? '' : `<label class="ow-switch" title="Switch Buy / Sell"><input type="checkbox" id="ow-flip" ${side === 'SELL' ? 'checked' : ''}><span></span></label>`}</div>
    <div class="ow-tabs">${preset.modifyId ? `<span class="on">Modify ${esc(preset.modifyId)}</span>` : [['regular', 'Regular'], ['co', 'Cover'], ['iceberg', 'Iceberg'], ['amo', 'AMO']].map(([v, lb]) => `<button type="button" data-ow-var="${v}" class="${o.variety === v ? 'on' : ''}" ${(!open && v !== 'amo') || (open && v === 'amo') ? 'disabled title="' + (open ? 'AMO is for after market hours' : 'Market closed — AMO only') + '"' : ''}>${lb}</button>`).join('')}</div>
    <form class="ow-b" id="ow-form" autocomplete="off">
      <div class="ow-prod" id="ow-prod"></div>
      <div class="ow-row">
        <label class="fld"><span>${fo ? 'Lots' : 'Qty.'}</span><input name="qty" type="number" min="1" step="1" value="${fo ? Math.max(1, o.qty / inst.lotSize) : o.qty}" ${preset.lockQty ? 'readonly' : ''}><small id="ow-qty-hint" class="sub"></small></label>
        <label class="fld"><span>Price</span><input name="price" type="number" step="${inst.tickSize || 0.05}" value="${o.price ?? ''}"></label>
        <label class="fld"><span>Trigger price</span><input name="trigger" type="number" step="${inst.tickSize || 0.05}" value="${o.trigger ?? ''}"></label>
      </div>
      <div class="ow-types">${['MARKET', 'LIMIT', 'SL', 'SL-M'].map((t) => `<label><input type="radio" name="type" value="${t}" ${o.type === t ? 'checked' : ''}><span>${t === 'MARKET' ? 'Market' : t === 'LIMIT' ? 'Limit' : t}</span></label>`).join('')}</div>
      <div class="ow-extra" id="ow-co" hidden><label class="fld"><span>Stoploss trigger price (cover order)</span><input name="coTrigger" type="number" step="${inst.tickSize || 0.05}" value="${o.coTrigger ?? ''}"></label></div>
      <div class="ow-extra" id="ow-ice" hidden><label class="fld"><span>Number of legs</span><input name="legs" type="number" min="2" max="50" value="${o.legs || 2}"></label><small class="sub" id="ow-ice-hint"></small></div>
      <div class="ow-extra" id="ow-slt" ${preset.modifyId ? 'hidden' : ''}>
        <label class="ow-chk"><input type="checkbox" name="useStop" ${o.stop ? 'checked' : ''}> Stoploss</label><input name="stop" type="number" step="${inst.tickSize || 0.05}" placeholder="price" value="${o.stop ?? ''}">
        <label class="ow-chk"><input type="checkbox" name="useTarget" ${o.target ? 'checked' : ''}> Target</label><input name="target" type="number" step="${inst.tickSize || 0.05}" placeholder="price" value="${o.target ?? ''}">
        <small class="sub" style="grid-column:1/-1">Placed as a GTT (OCO) once the order fills — like Kite's stoploss / target.</small>
      </div>
      <details class="ow-more" ${o.validity !== 'DAY' || o.disclosed || o.tag ? 'open' : ''}><summary>More options</summary>
        <div class="ow-row">
          <div class="fld"><span>Validity</span><div class="seg seg-sm">${[['DAY', 'Day'], ['IOC', 'Immediate'], ['TTL', 'Minutes']].map(([v, lb]) => `<label><input type="radio" name="validity" value="${v}" ${o.validity === v ? 'checked' : ''}><span>${lb}</span></label>`).join('')}</div></div>
          <label class="fld" id="ow-ttl"><span>Minutes</span><input name="ttl" type="number" min="1" max="365" value="${o.ttl || 5}"></label>
          ${fo ? '' : `<label class="fld"><span>Disclosed qty.</span><input name="disclosed" type="number" min="0" value="${o.disclosed ?? ''}"></label>`}
          <label class="fld"><span>Tag</span><input name="tag" maxlength="20" value="${esc(o.tag || '')}" placeholder="optional"></label>
        </div>
      </details>
      <div class="ow-foot" id="ow-foot"><span class="sub">Margin…</span></div>
      <div class="ow-risk" id="ow-risk"></div>
      <div class="modal-f"><button type="button" class="btn ghost" data-ow-close>Cancel</button><button type="submit" class="btn ow-go" id="ow-go">${preset.modifyId ? 'Modify' : side === 'BUY' ? 'Buy' : 'Sell'}</button></div>
    </form></div>`, { dismissable: true });
  owSync(); owQuote(); owPreview();
  setTimeout(() => el.querySelector(o.type === 'MARKET' ? 'input[name="qty"]' : 'input[name="price"]')?.focus(), 30);
}

function owForm() { return $('#ow-form'); }
function owRead() {
  const f = owForm(); const w = S.ow; const fd = new FormData(f); const fo = w.inst.segment !== 'EQ';
  const n = (k) => (fd.get(k) === '' || fd.get(k) == null ? null : Number(fd.get(k)));
  const o = w.o;
  o.qty = (n('qty') || 0) * (fo ? w.inst.lotSize : 1);
  o.type = fd.get('type') || o.type; o.price = n('price'); o.trigger = n('trigger');
  o.validity = fd.get('validity') || 'DAY'; o.ttl = n('ttl'); o.disclosed = n('disclosed'); o.tag = fd.get('tag') || null;
  o.coTrigger = n('coTrigger'); o.legs = n('legs');
  o.stop = fd.get('useStop') ? n('stop') : null; o.target = fd.get('useTarget') ? n('target') : null;
  return o;
}
function owSync() {
  const w = S.ow; const f = owForm(); if (!w || !f) return;
  const o = owRead(); const fo = w.inst.segment !== 'EQ';
  const prods = w.o.variety === 'co' ? ['MIS'] : fo ? ['MIS', 'NRML'] : ['MIS', 'CNC', 'MTF'];
  if (!prods.includes(o.product)) o.product = prods[prods.length > 1 ? 1 : 0];
  $('#ow-prod').innerHTML = w.modify ? `<span class="pill">${esc(PROD_LABEL[o.product])}</span>` : prods.map((p) => `<label><input type="radio" name="product" value="${p}" ${o.product === p ? 'checked' : ''}><span>${PROD_LABEL[p]}</span></label>`).join('');
  const t = o.type;
  f.price.disabled = t === 'MARKET' || t === 'SL-M'; if (f.price.disabled) f.price.value = '';
  f.trigger.disabled = !(t === 'SL' || t === 'SL-M'); if (f.trigger.disabled) f.trigger.value = '';
  const coTypes = w.o.variety === 'co' ? ['MARKET', 'LIMIT'] : w.o.variety === 'iceberg' ? ['LIMIT', 'SL'] : ['MARKET', 'LIMIT', 'SL', 'SL-M'];
  for (const r of f.querySelectorAll('input[name="type"]')) { r.disabled = !coTypes.includes(r.value); r.parentElement.classList.toggle('dis', r.disabled); }
  if (!coTypes.includes(t)) { f.querySelector(`input[name="type"][value="${coTypes[0]}"]`).checked = true; return owSync(); }
  $('#ow-co').hidden = w.o.variety !== 'co';
  $('#ow-ice').hidden = w.o.variety !== 'iceberg';
  $('#ow-slt').hidden = !!w.modify || w.o.variety === 'co';
  $('#ow-ttl').hidden = o.validity !== 'TTL';
  for (const r of f.querySelectorAll('input[name="validity"]')) { const dis = w.o.variety === 'amo' && r.value !== 'DAY'; r.disabled = dis; r.parentElement.classList.toggle('dis', dis); }
  f.stop.disabled = !f.useStop.checked; f.target.disabled = !f.useTarget.checked;
  $('#ow-qty-hint').textContent = fo ? `= ${o.qty} qty` : '';
  if (w.o.variety === 'iceberg') { const legs = o.legs || 2; $('#ow-ice-hint').textContent = `≈ ${Math.ceil(o.qty / legs)} per leg`; }
}
function owQuote() {
  const w = S.ow; const el = $('#ow-quote'); if (!w || !el) return;
  const q = P.data?.quotes?.[kOf(w.inst)] || w.quote;
  if (!q?.ltp) { el.textContent = 'waiting for price…'; return; }
  const ch = q.changePct != null ? q.changePct * 100 : null;
  el.innerHTML = `₹${nf2.format(q.ltp)} <span class="${cls(ch)}">${ch == null ? '' : `${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%`}</span>${q.bid ? ` <small>bid ${nf2.format(q.bid)} · ask ${nf2.format(q.ask)}</small>` : ''}`;
}
let prevT = null;
function owPreview() {
  clearTimeout(prevT);
  prevT = setTimeout(async () => {
    const w = S.ow; if (!w || !owForm()) return;
    const o = owRead();
    try {
      const r = await api('/api/paper/preview', { method: 'POST', body: { ...w.inst, side: w.side, ...o } });
      w.quote = r.quote; owQuote();
      const foot = $('#ow-foot'); if (!foot) return;
      const short = r.margin > r.available;
      foot.innerHTML = `<span>Margin <b class="mono ${short ? 'neg' : ''}">${rs(r.margin)}</b> <small class="sub">${r.source === 'kite' ? 'Kite' : 'est.'}</small></span><span>Charges <b class="mono">${rs(r.charges)}</b></span><span>Available <b class="mono">${rs(r.available)}</b></span>`;
      const k = r.risk; const rk = $('#ow-risk');
      if (k.risk == null) rk.innerHTML = `<span class="sub">ⓘ ${esc(k.note)}</span>`;
      else rk.innerHTML = k.over
        ? `<div class="note warn"><span>⚠ Risk <b>${rs0(k.risk)}</b> (${k.pct.toFixed(2)}% of capital) is over your ${P.data.riskPct}% limit of ${rs0(k.budget)}. For this stoploss, ${w.inst.segment !== 'EQ' ? 'lots' : 'qty'} up to <b>${w.inst.segment !== 'EQ' ? k.maxQty / w.inst.lotSize : k.maxQty}</b> stays within it. You can still place it.</span></div>`
        : `<span class="pos">✓ Risk ${rs0(k.risk)} · ${k.pct.toFixed(2)}% of capital (limit ${rs0(k.budget)})</span>`;
    } catch (e) { const foot = $('#ow-foot'); if (foot) foot.innerHTML = `<span class="neg">${esc(e.message)}</span>`; }
  }, 250);
}
async function owSubmit() {
  const w = S.ow; const o = owRead(); const btn = $('#ow-go'); btn.disabled = true;
  try {
    if (w.modify) {
      await api(`/api/paper/orders/${w.modify}`, { method: 'PUT', body: { qty: o.qty, price: o.price, trigger: o.trigger, type: o.type, validity: o.validity, ttl: o.ttl, disclosed: o.disclosed } });
      toast(`✏️ Order ${esc(w.modify)} modified`);
    } else {
      const body = { ...w.inst, side: w.side, ...o };
      const r = await api('/api/paper/orders', { method: 'POST', body });
      const x = r.order;
      toast(x.status === 'COMPLETE' ? `✅ ${x.side === 'BUY' ? 'Bought' : 'Sold'} ${x.qty} ${esc(x.symbol)} @ ₹${nf2.format(x.avgPrice)}` : x.status === 'CANCELLED' ? `Order ${esc(x.id)} cancelled — ${esc(x.message || '')}` : `🕓 Order ${esc(x.id)} placed · ${esc(x.status.toLowerCase())}`, x.status === 'COMPLETE' ? 'ok' : '');
    }
    S.ow = null; closeModal(); refresh(true);
  } catch (e) { btn.disabled = false; toast(`❌ ${esc(e.message)}`, 'err'); }
}

// ---------------------------------------------------------------- GTT window
function openGttWindow(inst, { side = 'SELL', qty, product, type = 'oco' } = {}) {
  const fo = inst.segment !== 'EQ'; const l = ltp(inst);
  const el = openModal(`<div class="modal narrow"><div class="modal-h"><h2>New GTT · ${esc(inst.symbol)}</h2><span class="sub mono">${l ? `LTP ₹${nf2.format(l)}` : ''}</span></div>
    <form class="modal-b" id="gtt-form">
      <div class="seg seg-sm" style="margin-bottom:10px">${[['single', 'Single'], ['oco', 'OCO (stoploss + target)']].map(([v, lb]) => `<label><input type="radio" name="type" value="${v}" ${type === v ? 'checked' : ''}><span>${lb}</span></label>`).join('')}</div>
      <div class="seg seg-sm" style="margin-bottom:10px">${['BUY', 'SELL'].map((v) => `<label><input type="radio" name="side" value="${v}" ${side === v ? 'checked' : ''}><span>${v === 'BUY' ? 'Buy' : 'Sell'}</span></label>`).join('')}</div>
      <div class="ow-row">
        <label class="fld"><span>${fo ? 'Lots' : 'Qty.'}</span><input name="qty" type="number" min="1" value="${fo ? (qty || inst.lotSize) / inst.lotSize : qty || 1}"></label>
        <label class="fld"><span>Product</span><select name="product">${(fo ? ['NRML', 'MIS'] : ['CNC', 'MIS']).map((p) => `<option ${p === product ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
      </div>
      <div class="ow-row" data-g="single"><label class="fld"><span>Trigger price</span><input name="trigger" type="number" step="${inst.tickSize || 0.05}"></label><label class="fld"><span>Limit price</span><input name="price" type="number" step="${inst.tickSize || 0.05}" placeholder="= trigger"></label></div>
      <div class="ow-row" data-g="oco"><label class="fld"><span>Stoploss trigger</span><input name="stop" type="number" step="${inst.tickSize || 0.05}"></label><label class="fld"><span>Target trigger</span><input name="target" type="number" step="${inst.tickSize || 0.05}"></label></div>
      <p class="sub" style="font-size:11.5px">A single GTT places a limit order when the price crosses the trigger. An OCO exits a position at the stoploss or the target, whichever comes first, and cancels the other. Valid for a year.</p>
      <div class="modal-f"><button type="button" class="btn ghost" data-ow-close>Cancel</button><button class="btn" type="submit">Create GTT</button></div>
    </form></div>`, { dismissable: true });
  const f = el.querySelector('#gtt-form');
  const sync = () => { const t = f.type.value; f.querySelectorAll('[data-g]').forEach((r) => { r.hidden = r.dataset.g !== t; }); };
  f.addEventListener('change', sync); sync();
  f.addEventListener('submit', async (e) => {
    e.preventDefault(); const fd = new FormData(f); const n = (k) => (fd.get(k) ? Number(fd.get(k)) : null);
    try {
      await api('/api/paper/gtt', { method: 'POST', body: { ...inst, type: fd.get('type'), side: fd.get('side'), product: fd.get('product'), qty: (n('qty') || 0) * (fo ? inst.lotSize : 1), trigger: n('trigger'), price: n('price'), stop: n('stop'), target: n('target') } });
      closeModal(); toast('🎯 GTT created'); refresh(true);
    } catch (err) { toast(`❌ ${esc(err.message)}`, 'err'); }
  });
}

// ---------------------------------------------------------------- events
let wired = false;
function wire() {
  if (wired) return; wired = true;
  document.addEventListener('input', (e) => {
    if (e.target.id === 'pp-q') { clearTimeout(searchT); searchT = setTimeout(() => doSearch(e.target.value), 200); }
    if (e.target.closest?.('#ow-form')) { owSync(); owPreview(); }
  });
  document.addEventListener('change', (e) => {
    if (e.target.closest?.('#ow-form')) {
      if (e.target.name === 'product') S.ow.o.product = e.target.value;
      owSync(); owPreview();
    }
    if (e.target.id === 'ow-flip') { S.ow.side = e.target.checked ? 'SELL' : 'BUY'; const m = $('#ow'); m.classList.toggle('ow-buy', !e.target.checked); m.classList.toggle('ow-sell', e.target.checked); $('#ow-side-label').textContent = e.target.checked ? 'Sell' : 'Buy'; $('#ow-go').textContent = e.target.checked ? 'Sell' : 'Buy'; owPreview(); }
  });
  document.addEventListener('submit', (e) => { if (e.target.id === 'ow-form') { e.preventDefault(); owSubmit(); } });
  document.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-ow-close]')) { S.ow = null; closeModal(); return; }
    const v = t.closest('[data-ow-var]'); if (v && !v.disabled) { S.ow.o.variety = v.dataset.owVar; $$('[data-ow-var]').forEach((b) => b.classList.toggle('on', b === v)); owSync(); owPreview(); return; }
    if (!$('#pp-body')) return;
    const tab = t.closest('[data-pp-tab]'); if (tab) { P.tab = tab.dataset.ppTab; put(TKEY, P.tab); $$('[data-pp-tab]').forEach((b) => b.classList.toggle('on', b === tab)); paintTab(); return; }
    const add = t.closest('[data-pp-add]');
    if (add) { const h = $('#pp-results')._hits[Number(add.dataset.ppAdd)]; const list = watch(); if (!list.some((x) => kOf(x) === kOf(h))) { list.unshift({ exchange: h.exchange, symbol: h.symbol, token: h.token, segment: h.segment, lotSize: h.lotSize, tickSize: h.tickSize || 0.05, expiry: h.expiry, name: h.name }); put(WKEY, list.slice(0, 50)); } $('#pp-results').hidden = true; $('#pp-q').value = ''; P.sel = kOf(h); refresh(); return; }
    if (!t.closest('.pp-search')) { const r = $('#pp-results'); if (r) r.hidden = true; }
    const row = t.closest('[data-pp-row]'); if (row && !t.closest('button')) { P.sel = row.dataset.ppRow; paintWatch(); return; }
    const b = t.closest('[data-pp-buy]'); if (b) return openOrderWindow(findInst(b.dataset.ppBuy), 'BUY');
    const s = t.closest('[data-pp-sell]'); if (s) return openOrderWindow(findInst(s.dataset.ppSell), 'SELL');
    const un = t.closest('[data-pp-unwatch]'); if (un) { put(WKEY, watch().filter((x) => kOf(x) !== un.dataset.ppUnwatch)); paintWatch(); return; }
    const ex = t.closest('[data-pp-exit]');
    if (ex) { const [k, prod] = ex.dataset.ppExit.split('|'); const [exchange, symbol] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)]; try { await api('/api/paper/exit', { method: 'POST', body: { exchange, symbol, product: prod } }); toast(`Exited ${esc(symbol)}`); refresh(true); } catch (err) { toast(`❌ ${esc(err.message)}`, 'err'); } return; }
    const ap = t.closest('[data-pp-add-pos]');
    if (ap) { const [k, prod] = ap.dataset.ppAddPos.split('|'); const p = P.data.positions.find((x) => kOf(x) === k && x.product === prod); return openOrderWindow(findInst(k), p.qty > 0 ? 'BUY' : 'SELL', { product: prod }); }
    const cv = t.closest('[data-pp-convert]');
    if (cv) {
      const [k, prod] = cv.dataset.ppConvert.split('|'); const p = P.data.positions.find((x) => kOf(x) === k && x.product === prod);
      const to = p.segment === 'EQ' ? (prod === 'MIS' ? 'CNC' : 'MIS') : (prod === 'MIS' ? 'NRML' : 'MIS');
      if (!(await confirmBox('Convert position', `Convert ${Math.abs(p.qty)} ${esc(p.symbol)} from <b>${prod}</b> to <b>${to}</b>?`, 'Convert'))) return;
      try { await api('/api/paper/convert', { method: 'POST', body: { exchange: p.exchange, symbol: p.symbol, from: prod, to } }); toast(`Converted to ${to}`); refresh(true); } catch (err) { toast(`❌ ${esc(err.message)}`, 'err'); }
      return;
    }
    const gp = t.closest('[data-pp-gtt-pos]');
    if (gp) { const [k, prod] = gp.dataset.ppGttPos.split('|'); const p = P.data.positions.find((x) => kOf(x) === k && x.product === prod); return openGttWindow(findInst(k), { side: p.qty > 0 ? 'SELL' : 'BUY', qty: Math.abs(p.qty), product: prod }); }
    const gh = t.closest('[data-pp-gtt-hold]'); if (gh) { const h = P.data.holdings.find((x) => kOf(x) === gh.dataset.ppGttHold); return openGttWindow(findInst(kOf(h)), { side: 'SELL', qty: h.qty, product: 'CNC' }); }
    const sh = t.closest('[data-pp-sellhold]'); if (sh) { const h = P.data.holdings.find((x) => kOf(x) === sh.dataset.ppSellhold); return openOrderWindow(findInst(kOf(h)), 'SELL', { product: 'CNC', qty: h.qty }); }
    if (t.closest('[data-pp-gtt-new]')) { const w = findInst(P.sel) || watch()[0]; if (!w) return toast('Add an instrument to the watchlist first'); return openGttWindow(w, { side: 'BUY', type: 'single' }); }
    const gd = t.closest('[data-pp-gtt-del]'); if (gd) { try { await api(`/api/paper/gtt/${gd.dataset.ppGttDel}`, { method: 'DELETE' }); refresh(true); } catch (err) { toast(`❌ ${esc(err.message)}`, 'err'); } return; }
    const cn = t.closest('[data-pp-cancel]'); if (cn) { try { await api(`/api/paper/orders/${cn.dataset.ppCancel}`, { method: 'DELETE' }); toast('Order cancelled'); refresh(true); } catch (err) { toast(`❌ ${esc(err.message)}`, 'err'); } return; }
    const md = t.closest('[data-pp-modify]');
    if (md) { const o = P.data.orders.find((x) => x.id === md.dataset.ppModify); return openOrderWindow(findInst(kOf(o)), o.side, { modifyId: o.id, variety: o.variety, product: o.product, type: o.type, qty: o.qty, price: o.price, trigger: o.trigger, validity: o.validity, ttl: o.ttl, disclosed: o.disclosed, tag: o.tag, lockQty: !!o.coLeg }); }
    const rp = t.closest('[data-pp-repeat]');
    if (rp) { const o = P.data.orders.find((x) => x.id === rp.dataset.ppRepeat); return openOrderWindow(findInst(kOf(o)), o.side, { product: o.product, type: o.type === 'SL-M' || o.type === 'SL' ? o.type : o.type, qty: o.qty, price: o.price, trigger: o.trigger }); }
    if (t.closest('[data-pp-save-risk]')) { try { await api('/api/paper/settings', { method: 'PUT', body: { riskPct: Number($('#pp-risk').value) } }); toast('Risk per trade saved'); refresh(true); } catch (err) { toast(`❌ ${esc(err.message)}`, 'err'); } return; }
    if (t.closest('[data-pp-reset]')) {
      const cap = Number($('#pp-cap').value) || 600000;
      if (!(await confirmBox('Reset the paper account?', `All paper orders, positions, holdings and stats are deleted and you start again with <b>₹${nf0.format(cap)}</b>. Your real journal isn't touched.`, 'Reset'))) return;
      try { await api('/api/paper/reset', { method: 'POST', body: { capital: cap, riskPct: P.data.riskPct } }); toast('Paper account reset'); refresh(true); } catch (err) { toast(`❌ ${esc(err.message)}`, 'err'); }
    }
  });
  document.addEventListener('keydown', (e) => {
    if (!$('#pp-body') || S.ow || $('#modal-root').children.length) return;
    if (e.target.matches?.('input, textarea, select')) { if (e.key === 'Escape') e.target.blur(); return; }
    if (e.key === '/') { e.preventDefault(); $('#pp-q').focus(); return; }
    const k = P.sel || kOf(watch()[0] || {});
    if ((e.key === 'b' || e.key === 'B') && findInst(k)) { e.preventDefault(); openOrderWindow(findInst(k), 'BUY'); }
    if ((e.key === 's' || e.key === 'S') && findInst(k)) { e.preventDefault(); openOrderWindow(findInst(k), 'SELL'); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { const w = watch(); const i = w.findIndex((x) => kOf(x) === P.sel); const j = Math.max(0, Math.min(w.length - 1, (i < 0 ? 0 : i) + (e.key === 'ArrowDown' ? 1 : -1))); P.sel = kOf(w[j]); paintWatch(); e.preventDefault(); }
  });
}
