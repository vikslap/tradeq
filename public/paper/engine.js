// Live paper trading — the order engine. Pure functions over one account object, shared
// by the server (which feeds it live quotes and 1-minute candles) and the tests.
//
// Behaves like Kite for cash equity (NSE/BSE), futures (NFO/BFO) and commodity futures (MCX):
//   varieties  regular · amo · co (cover order) · iceberg
//   types      MARKET · LIMIT · SL · SL-M
//   products   CNC · MIS · MTF (equity) · NRML (futures)
//   validity   DAY · IOC · TTL (minutes)
//   extras     disclosed quantity, tag, stoploss/target (GTT OCO after the entry fills),
//              GTT single and OCO, MIS auto square-off, AMO at the next open,
//              CNC → holdings after the session, futures settled on expiry day.
// Fills: market orders take the best bid/ask (LTP when there's no depth); limit orders fill
// when the market reaches the price; stop orders trigger on the last traded price. When the
// engine wasn't running (page closed), the missed minutes are replayed from 1-minute candles.
import { orderCharges } from '../charges.js';

export class PaperError extends Error { constructor(msg) { super(msg); this.status = 400; } }
const fail = (m) => { throw new PaperError(m); };
const r2 = (v) => Math.round(v * 100) / 100;

// ---------- sessions (IST minutes after midnight) ----------
export const SESSIONS = {
  EQ: { open: 555, close: 930, misCut: 920, label: 'NSE/BSE' }, // 09:15–15:30, MIS squared off 15:20
  FO: { open: 555, close: 930, misCut: 925, label: 'F&O' },     // MIS squared off 15:25
  MCX: { open: 540, close: 1410, misCut: 1385, label: 'MCX' },   // 09:00–23:30, MIS squared off 23:05
};
export const groupOf = (ex) => (ex === 'MCX' ? 'MCX' : ex === 'NFO' || ex === 'BFO' ? 'FO' : 'EQ');
export const istParts = (ms) => { const d = new Date(ms + 330 * 60000); return { day: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay() }; };
/** ms for an IST day + minute. */
export const istMs = (day, min) => Date.parse(`${day}T00:00:00Z`) - 330 * 60000 + min * 60000;
export function isOpen(group, ms, holidays = []) {
  const { day, min, dow } = istParts(ms); const S = SESSIONS[group];
  return dow !== 0 && dow !== 6 && !holidays.includes(day) && min >= S.open && min < S.close;
}

export const PRODUCTS = { EQ: ['CNC', 'MIS', 'MTF'], FUT: ['NRML', 'MIS'], COM: ['NRML', 'MIS'] };
export const AUTO_SQUAREOFF_FEE = 59; // ₹50 + 18% GST per order Zerodha squares off for you
export const AUTO_SQUAREOFF_FEE_PER_ORDER = true;

export function newAccount({ capital = 600000, riskPct = 1 } = {}) {
  return { v: 1, rev: 0, capital, riskPct, cash: capital, seq: 1, orders: [], gtts: [], positions: [], holdings: [], trades: [], fills: [], ledger: [{ t: Date.now(), kind: 'capital', amount: capital, note: 'Starting capital' }], lastCheck: null, sessionDone: {}, created: Date.now() };
}

const keyOf = (o) => `${o.exchange}:${o.symbol}`;
const posKey = (o) => `${o.exchange}:${o.symbol}:${o.product}`;
export const instrumentKeys = (acc) => {
  const s = new Set();
  for (const o of acc.orders) if (isLive(o)) s.add(keyOf(o));
  for (const g of acc.gtts) if (g.status === 'active') s.add(keyOf(g));
  for (const p of acc.positions) if (p.qty) s.add(keyOf(p));
  for (const h of acc.holdings) if (h.qty) s.add(keyOf(h));
  return [...s];
};
export const isLive = (o) => ['OPEN', 'TRIGGER PENDING', 'AMO REQ RECEIVED'].includes(o.status);

function rateKeyFor(o) {
  if (o.segment === 'COM') return 'COM_FUT';
  if (o.segment === 'FUT') return 'FUT';
  return o.product === 'MIS' ? 'EQ_INTRADAY' : 'EQ_DELIVERY';
}
export const chargesFor = (o, side, qty, price) => orderCharges(rateKeyFor(o), o.exchange, side, qty * price);

// ---------- margins ----------
/** Fallback when Kite's margin API isn't reachable: Zerodha's usual levels. */
export function approxMargin(o, price) {
  const value = o.qty * price;
  if (o.product === 'CNC') return value;
  if (o.product === 'MTF') return value * 0.5;
  if (o.segment === 'EQ') return value * 0.2;                 // MIS: 5×
  const nrml = o.segment === 'COM' ? 0.1 : /NIFTY|SENSEX|BANKEX/.test(o.symbol) ? 0.12 : 0.2;
  return value * (o.product === 'MIS' ? nrml / 2 : nrml);
}

export function positionOf(acc, o) { return acc.positions.find((p) => posKey(p) === posKey(o)); }
const holdingOf = (acc, o) => acc.holdings.find((h) => h.exchange === o.exchange && h.symbol === o.symbol);

/** How much of this order opens new exposure (the rest closes an existing position). */
export function openingQty(acc, o) {
  const p = positionOf(acc, o); const signed = o.side === 'BUY' ? o.qty : -o.qty;
  let cur = p?.qty || 0;
  if (o.product === 'CNC' && o.side === 'SELL') return 0; // CNC sells only close (holdings or today's buys)
  // Other open orders that will close the same position first.
  if (cur && Math.sign(cur) !== Math.sign(signed)) return Math.max(0, Math.abs(signed) - Math.abs(cur));
  return Math.abs(signed);
}

export function funds(acc, ltpOf = () => null) {
  const blockedPos = acc.positions.reduce((s, p) => s + (p.margin || 0), 0) + acc.holdings.reduce((s, h) => s + (h.margin || 0), 0);
  const blockedOrders = acc.orders.filter(isLive).reduce((s, o) => s + (o.margin || 0), 0);
  let mtm = 0; let unrealHold = 0;
  for (const p of acc.positions) { if (!p.qty) continue; const l = ltpOf(keyOf(p)) ?? p.avg; mtm += (l - p.avg) * p.qty * (p.mult || 1); }
  for (const h of acc.holdings) { const l = ltpOf(keyOf(h)) ?? h.avg; unrealHold += (l - h.avg) * h.qty; }
  const mtmLoss = Math.min(0, mtm);
  const used = blockedPos + blockedOrders - mtmLoss;
  const realized = acc.trades.reduce((s, t) => s + (t.pnl || 0), 0) + acc.positions.reduce((s, p) => s + (p.realized || 0), 0) + acc.holdings.reduce((s, h) => s + (h.realized || 0), 0);
  const charges = acc.fills.reduce((s, f) => s + (f.charges || 0), 0) + acc.ledger.filter((l) => l.kind === 'fee').reduce((s, l) => s - l.amount, 0);
  return { capital: acc.capital, cash: r2(acc.cash), used: r2(used), available: r2(acc.cash - used), blockedPos: r2(blockedPos), blockedOrders: r2(blockedOrders), mtm: r2(mtm), unrealHold: r2(unrealHold), charges: r2(charges), equity: r2(acc.cash + mtm + unrealHold) };
}

// ---------- placing, modifying, cancelling ----------
/**
 * req: { variety, exchange, symbol, token, segment, lotSize, tickSize, expiry, side, product, type,
 *        qty, price, trigger, validity, ttl, disclosed, tag, legs (iceberg), coTrigger (cover order),
 *        stop, target (GTT after fill) }
 * ctx: { now, quote: {ltp,bid,ask,upper,lower}, margin (₹ for the opening part), holidays }
 */
export function placeOrder(acc, req, ctx) {
  const now = ctx.now; const q = ctx.quote || {};
  const o = {
    id: `P${String(acc.seq++).padStart(6, '0')}`, variety: req.variety || 'regular', exchange: req.exchange, symbol: req.symbol, token: req.token || null,
    segment: req.segment || 'EQ', lotSize: req.lotSize || 1, tickSize: req.tickSize || 0.05, expiry: req.expiry || null,
    side: req.side, product: req.product, type: req.type || 'MARKET', qty: Math.round(Number(req.qty) || 0),
    price: req.price != null && req.price !== '' ? Number(req.price) : null, trigger: req.trigger != null && req.trigger !== '' ? Number(req.trigger) : null,
    validity: req.validity || 'DAY', ttl: req.ttl ? Number(req.ttl) : null, disclosed: req.disclosed ? Number(req.disclosed) : null, tag: (req.tag || '').slice(0, 20) || null,
    stop: req.stop ? Number(req.stop) : null, target: req.target ? Number(req.target) : null,
    placedAt: now, status: 'OPEN', filled: 0, avgPrice: null, parent: req.parent || null, legs: null, legQty: null, coTrigger: req.coTrigger ? Number(req.coTrigger) : null,
    margin: 0, history: [],
  };
  validate(acc, o, req, ctx);
  const group = groupOf(o.exchange);
  if (o.variety === 'amo') o.status = 'AMO REQ RECEIVED';
  else if (o.type === 'SL' || o.type === 'SL-M') o.status = 'TRIGGER PENDING';
  // Margin for the part that opens new exposure (Kite blocks it while the order is open).
  o.margin = openingQty(acc, o) ? (ctx.margin ?? approxMargin(o, o.price || q.ltp || o.trigger)) * (openingQty(acc, o) / o.qty) : 0;
  const f = funds(acc, () => null);
  if (o.margin > f.available + 1e-6) fail(`Insufficient funds. Required margin is ₹${r2(o.margin).toLocaleString('en-IN')} but available margin is ₹${r2(f.available).toLocaleString('en-IN')}.`);
  if (o.variety === 'iceberg') {
    const legs = Math.round(Number(req.legs) || 0);
    o.legs = legs; o.legQty = Math.ceil(o.qty / legs / o.lotSize) * o.lotSize; o.legsDone = 0;
  }
  o.history.push({ t: now, s: o.status });
  acc.orders.push(o);
  if (isOpen(group, now, ctx.holidays)) acc.lastSeen = { ...(acc.lastSeen || {}), [group]: istParts(now).day };
  if (o.variety !== 'amo' && isOpen(group, now, ctx.holidays)) matchQuote(acc, o, q, now); // market / marketable limit fills now
  if (o.validity === 'IOC' && isLive(o) && o.variety !== 'amo') setStatus(o, 'CANCELLED', now, 'IOC order not filled immediately');
  return o;
}

function validate(acc, o, req, ctx) {
  const group = groupOf(o.exchange); const open = isOpen(group, ctx.now, ctx.holidays);
  if (!['BUY', 'SELL'].includes(o.side)) fail('Choose Buy or Sell');
  if (!o.symbol || !o.exchange) fail('Pick an instrument');
  if (o.segment === 'OPT') fail('Options aren\'t part of paper trading — cash, futures and commodity futures only');
  if (!(PRODUCTS[o.segment] || []).includes(o.product)) fail(`${o.product} isn't allowed for ${o.segment === 'EQ' ? 'equity' : 'futures'}`);
  if (!['regular', 'amo', 'co', 'iceberg'].includes(o.variety)) fail('Unknown order variety');
  if (!['MARKET', 'LIMIT', 'SL', 'SL-M'].includes(o.type)) fail('Unknown order type');
  if (o.variety === 'amo' && open) fail('AMO orders can be placed only after market hours. The market is open — place a regular order.');
  if (o.variety !== 'amo' && !open) fail(`The ${SESSIONS[group].label} market is closed. Place an AMO (after-market order) to have it go in at the next open.`);
  if (o.expiry && istParts(ctx.now).day > o.expiry) fail('This contract has expired');
  if (!(o.qty > 0)) fail('Quantity should be more than zero');
  if (o.lotSize > 1 && o.qty % o.lotSize) fail(`Quantity should be a multiple of the lot size (${o.lotSize})`);
  const tick = o.tickSize || 0.05; const onTick = (v) => Math.abs(v / tick - Math.round(v / tick)) < 1e-6;
  if (o.type === 'LIMIT' || o.type === 'SL') { if (!(o.price > 0)) fail('Enter a price'); if (!onTick(o.price)) fail(`Price should be a multiple of the tick size (${tick})`); }
  if (o.type === 'SL' || o.type === 'SL-M') {
    if (!(o.trigger > 0)) fail('Enter a trigger price'); if (!onTick(o.trigger)) fail(`Trigger price should be a multiple of the tick size (${tick})`);
    const ltp = ctx.quote?.ltp;
    if (ltp && o.variety !== 'amo') {
      if (o.side === 'BUY' && o.trigger <= ltp) fail('Trigger price for stoploss buy orders should be higher than the last traded price');
      if (o.side === 'SELL' && o.trigger >= ltp) fail('Trigger price for stoploss sell orders should be lower than the last traded price');
    }
    if (o.type === 'SL' && o.side === 'BUY' && o.price < o.trigger) fail('For a stoploss buy order, the price should be at or above the trigger price');
    if (o.type === 'SL' && o.side === 'SELL' && o.price > o.trigger) fail('For a stoploss sell order, the price should be at or below the trigger price');
  }
  if (o.type === 'MARKET' || o.type === 'SL-M') o.price = null;
  const { upper, lower } = ctx.quote || {};
  for (const v of [o.price, o.trigger]) if (v != null && upper && lower && (v > upper || v < lower)) fail(`Price is outside the circuit limits (₹${lower} – ₹${upper})`);
  if (!['DAY', 'IOC', 'TTL'].includes(o.validity)) fail('Unknown validity');
  if (o.validity === 'TTL') { if (o.type !== 'LIMIT') fail('Minutes (TTL) validity is for limit orders'); if (!(o.ttl >= 1 && o.ttl <= 365)) fail('TTL should be between 1 and 365 minutes'); }
  if (o.validity === 'IOC' && (o.type === 'SL' || o.type === 'SL-M')) fail('Stoploss orders can\'t be IOC');
  if (o.variety === 'amo' && o.validity !== 'DAY') fail('AMO orders are valid for the day only');
  if (o.product === 'MIS' && open && istParts(ctx.now).min >= SESSIONS[group].misCut && openingQty(acc, o)) fail('New intraday (MIS) positions are blocked after the square-off time');
  if (o.disclosed != null) {
    if (o.segment !== 'EQ') fail('Disclosed quantity is for equity orders');
    if (o.disclosed > o.qty || o.disclosed < Math.ceil(o.qty * 0.1)) fail('Disclosed quantity should be between 10% of the quantity and the quantity');
  }
  if (o.variety === 'co') {
    if (o.product !== 'MIS') fail('Cover orders are intraday (MIS) only');
    if (!['MARKET', 'LIMIT'].includes(o.type)) fail('Cover orders are Market or Limit');
    if (!(o.coTrigger > 0)) fail('A cover order needs a stoploss trigger price');
    const ref = o.price || ctx.quote?.ltp;
    if (ref && ((o.side === 'BUY' && o.coTrigger >= ref) || (o.side === 'SELL' && o.coTrigger <= ref))) fail('Cover order stoploss should be below the price for a buy and above it for a sell');
  }
  if (o.variety === 'iceberg') {
    const legs = Math.round(Number(req.legs) || 0);
    if (legs < 2 || legs > 50) fail('Iceberg orders need 2 to 50 legs');
    if (o.qty / legs < o.lotSize) fail('Each iceberg leg needs at least one lot');
    if (o.type === 'SL-M' || o.type === 'MARKET') fail('Iceberg orders are Limit or SL');
  }
  if (o.product === 'CNC' && o.side === 'SELL') {
    const have = (holdingOf(acc, o)?.qty || 0) - (holdingOf(acc, o)?.t1 || 0) * 0 + Math.max(0, positionOf(acc, o)?.qty || 0);
    const pending = acc.orders.filter((x) => isLive(x) && x.product === 'CNC' && x.side === 'SELL' && keyOf(x) === keyOf(o)).reduce((s, x) => s + x.qty - x.filled, 0);
    if (o.qty + pending > have) fail(`You can sell at most ${Math.max(0, have - pending)} — CNC sells need holdings (short selling is intraday only)`);
  }
  if (o.product === 'MTF' && o.side === 'SELL' && !(positionOf(acc, o)?.qty > 0)) fail('MTF sells close an MTF position; short selling is intraday only');
  if (o.stop != null && o.target != null && o.side === 'BUY' && !(o.stop < (o.price || ctx.quote?.ltp || Infinity) && o.target > (o.price || ctx.quote?.ltp || 0))) fail('For a buy, the stoploss should be below and the target above the price');
  if (o.stop != null && o.target != null && o.side === 'SELL' && !(o.stop > (o.price || ctx.quote?.ltp || 0) && o.target < (o.price || ctx.quote?.ltp || Infinity))) fail('For a sell, the stoploss should be above and the target below the price');
}

function setStatus(o, s, t, msg) { o.status = s; o.history.push({ t, s, msg }); if (msg) o.message = msg; if (!isLive(o)) { o.closedAt = t; o.margin = 0; } }

export function cancelOrder(acc, id, now) {
  const o = acc.orders.find((x) => x.id === id); if (!o) fail('No such order');
  if (!isLive(o)) fail(`The order is already ${o.status.toLowerCase()}`);
  if (o.parent && o.variety === 'co' && o.coLeg) fail('Exit the cover order to cancel its stoploss leg');
  setStatus(o, 'CANCELLED', now, 'Cancelled by you');
  if (o.variety === 'iceberg') for (const c of acc.orders) if (c.parent === o.id && isLive(c)) setStatus(c, 'CANCELLED', now, 'Iceberg cancelled');
  return o;
}

export function modifyOrder(acc, id, ch, ctx) {
  const o = acc.orders.find((x) => x.id === id); if (!o) fail('No such order');
  if (!isLive(o)) fail(`The order is already ${o.status.toLowerCase()}`);
  const next = { ...o, ...Object.fromEntries(Object.entries(ch).filter(([k]) => ['qty', 'price', 'trigger', 'type', 'validity', 'ttl', 'disclosed'].includes(k))) };
  for (const k of ['qty', 'price', 'trigger', 'ttl', 'disclosed']) if (next[k] != null && next[k] !== '') next[k] = Number(next[k]); else if (next[k] === '') next[k] = null;
  if (o.coLeg && (next.type !== 'SL-M' || next.qty !== o.qty)) fail('Only the trigger price of a cover order stoploss can be changed');
  const tmp = { ...next, history: [] };
  validate({ ...acc, orders: acc.orders.filter((x) => x.id !== id) }, tmp, { legs: o.legs }, { ...ctx, quote: ctx.quote });
  Object.assign(o, { qty: next.qty, price: tmp.price, trigger: next.trigger, type: next.type, validity: next.validity, ttl: next.ttl, disclosed: next.disclosed });
  o.status = o.variety === 'amo' ? 'AMO REQ RECEIVED' : (o.type === 'SL' || o.type === 'SL-M') && !o.triggered ? 'TRIGGER PENDING' : 'OPEN';
  o.history.push({ t: ctx.now, s: 'MODIFIED' });
  if (isOpen(groupOf(o.exchange), ctx.now, ctx.holidays) && o.variety !== 'amo') matchQuote(acc, o, ctx.quote || {}, ctx.now);
  return o;
}

// ---------- GTT ----------
/** g: { type: 'single'|'oco', exchange, symbol, ..., side, product, qty, trigger (single) | stop/target (oco), price, ltpAtCreate } */
export function createGtt(acc, g, now) {
  if (!['single', 'oco'].includes(g.type)) fail('GTT type is single or OCO');
  const x = { id: `G${String(acc.seq++).padStart(6, '0')}`, status: 'active', createdAt: now, expiresAt: now + 365 * 86400000, ...g, qty: Math.round(Number(g.qty) || 0) };
  if (!(x.qty > 0)) fail('Quantity should be more than zero');
  if (x.lotSize > 1 && x.qty % x.lotSize) fail(`Quantity should be a multiple of the lot size (${x.lotSize})`);
  if (x.type === 'single') { if (!(x.trigger > 0)) fail('Enter a trigger price'); x.dir = x.trigger >= (g.ltpAtCreate || 0) ? 'up' : 'down'; }
  else { if (!(x.stop > 0 && x.target > 0)) fail('An OCO GTT needs a stoploss and a target trigger'); if (x.side === 'SELL' ? x.stop >= x.target : x.stop <= x.target) fail(x.side === 'SELL' ? 'For exiting a long, the stoploss should be below the target' : 'For exiting a short, the stoploss should be above the target'); }
  acc.gtts.push(x);
  return x;
}
export function deleteGtt(acc, id) { const g = acc.gtts.find((x) => x.id === id); if (!g) fail('No such GTT'); if (g.status !== 'active') fail('That GTT is no longer active'); g.status = 'deleted'; return g; }

// ---------- fills and positions ----------
function fill(acc, o, qty, price, t) {
  price = r2(price);
  const mult = 1;
  const ch = chargesFor(o, o.side, qty, price);
  acc.cash -= ch.total;
  acc.fills.push({ id: `F${acc.seq++}`, order: o.id, t, exchange: o.exchange, symbol: o.symbol, product: o.product, side: o.side, qty, price, charges: ch.total, tag: o.tag });
  const signed = o.side === 'BUY' ? qty : -qty;
  // CNC sells take from holdings first.
  if (o.product === 'CNC' && o.side === 'SELL') {
    let left = qty; const p = positionOf(acc, o);
    const fromPos = Math.min(left, Math.max(0, p?.qty || 0));
    if (fromPos) { applyToPosition(acc, o, -fromPos, price, t, ch.total * (fromPos / qty)); left -= fromPos; }
    if (left) {
      const h = holdingOf(acc, o); const per = h.margin / h.qty; const pnl = (price - h.avg) * left;
      h.qty -= left; h.margin -= per * left; h.realized = (h.realized || 0) + pnl; acc.cash += pnl;
      closeTradeQty(acc, o, left, price, t, ch.total * (left / qty), pnl, 'holding');
      if (!h.qty) acc.holdings.splice(acc.holdings.indexOf(h), 1);
    }
  } else applyToPosition(acc, o, signed, price, t, ch.total, mult);
  o.filled += qty; o.avgPrice = o.avgPrice == null ? price : r2((o.avgPrice * (o.filled - qty) + price * qty) / o.filled);
  if (o.filled >= o.qty) { setStatus(o, 'COMPLETE', t); afterComplete(acc, o, t); }
}

function applyToPosition(acc, o, signed, price, t, charges) {
  let p = positionOf(acc, o);
  if (!p) { p = { exchange: o.exchange, symbol: o.symbol, token: o.token, product: o.product, segment: o.segment, lotSize: o.lotSize, expiry: o.expiry, qty: 0, avg: 0, margin: 0, realized: 0, openedAt: t, day: istParts(t).day }; acc.positions.push(p); }
  const before = p.qty;
  if (before === 0 || Math.sign(before) === Math.sign(signed)) { // adding
    const perUnit = o.margin && o.qty ? o.margin / o.qty : approxMargin({ ...o, qty: 1 }, price);
    p.avg = (p.avg * Math.abs(before) + price * Math.abs(signed)) / (Math.abs(before) + Math.abs(signed));
    p.qty = before + signed; p.margin += perUnit * Math.abs(signed);
    openTradeQty(acc, o, Math.abs(signed), price, t, charges);
  } else { // reducing (maybe flipping)
    const closing = Math.min(Math.abs(signed), Math.abs(before));
    const pnl = (price - p.avg) * closing * Math.sign(before);
    p.realized += pnl; acc.cash += pnl;
    p.margin -= (p.margin / Math.abs(before)) * closing;
    p.qty = before + Math.sign(signed) * closing;
    closeTradeQty(acc, o, closing, price, t, charges * (closing / Math.abs(signed)), pnl);
    const rest = Math.abs(signed) - closing;
    if (rest) { p.avg = price; p.qty = Math.sign(signed) * rest; p.margin = approxMargin({ ...o, qty: rest }, price); openTradeQty(acc, o, rest, price, t, charges * (rest / Math.abs(signed))); }
    if (!p.qty) { p.avg = 0; p.margin = 0; }
  }
}

// Round-trip records for the stats tab: one per position from flat to flat.
function openTradeQty(acc, o, qty, price, t, charges) {
  let tr = acc.trades.find((x) => !x.closedAt && x.exchange === o.exchange && x.symbol === o.symbol && x.product === (o.product === 'CNC' ? 'CNC' : o.product));
  if (!tr) { tr = { id: `T${acc.seq++}`, exchange: o.exchange, symbol: o.symbol, segment: o.segment, product: o.product, side: o.side === 'BUY' ? 'LONG' : 'SHORT', openedAt: t, qty: 0, open: 0, entryValue: 0, exitValue: 0, exitQty: 0, charges: 0, pnl: 0, stop: null, risk: null, tag: o.tag }; acc.trades.push(tr); }
  tr.qty += qty; tr.open += qty; tr.entryValue += qty * price; tr.charges += charges;
  const st = o.stop ?? (o.variety === 'co' ? o.coTrigger : null);
  if (st != null && tr.stop == null) { tr.stop = st; tr.risk = Math.abs(price - st) * qty; }
}
function closeTradeQty(acc, o, qty, price, t, charges, pnl, from) {
  const tr = acc.trades.find((x) => !x.closedAt && x.exchange === o.exchange && x.symbol === o.symbol && (x.product === o.product || from === 'holding'));
  if (!tr) return;
  tr.open -= qty; tr.exitQty += qty; tr.exitValue += qty * price; tr.charges += charges; tr.pnl += pnl;
  if (tr.open <= 0) { tr.closedAt = t; tr.net = r2(tr.pnl - tr.charges); tr.r = tr.risk ? r2(tr.net / tr.risk) : null; }
}

function afterComplete(acc, o, t) {
  // Cover order: place its stoploss leg.
  if (o.variety === 'co' && !o.coLeg) {
    acc.orders.push({ ...baseChild(acc, o, t), side: o.side === 'BUY' ? 'SELL' : 'BUY', type: 'SL-M', trigger: o.coTrigger, price: null, status: 'TRIGGER PENDING', coLeg: true, margin: 0, history: [{ t, s: 'TRIGGER PENDING' }] });
  }
  // Iceberg child: queue the next leg.
  if (o.icebergOf) {
    const parent = acc.orders.find((x) => x.id === o.icebergOf);
    parent.filled += o.qty; parent.legsDone++;
    parent.avgPrice = r2(((parent.avgPrice || 0) * (parent.filled - o.qty) + o.avgPrice * o.qty) / parent.filled);
    if (parent.filled >= parent.qty) setStatus(parent, 'COMPLETE', t);
    else spawnLeg(acc, parent, t);
  }
  // Stoploss / target chosen in the order window → GTT OCO on the position.
  if ((o.stop || o.target) && !o.coLeg) {
    const exitSide = o.side === 'BUY' ? 'SELL' : 'BUY';
    if (o.stop && o.target) acc.gtts.push({ id: `G${String(acc.seq++).padStart(6, '0')}`, type: 'oco', status: 'active', createdAt: t, expiresAt: t + 365 * 86400000, exchange: o.exchange, symbol: o.symbol, token: o.token, segment: o.segment, lotSize: o.lotSize, tickSize: o.tickSize, expiry: o.expiry, product: o.product, side: exitSide, qty: o.qty, stop: o.stop, target: o.target, from: o.id });
    else { const trig = o.stop || o.target; acc.gtts.push({ id: `G${String(acc.seq++).padStart(6, '0')}`, type: 'single', status: 'active', createdAt: t, expiresAt: t + 365 * 86400000, exchange: o.exchange, symbol: o.symbol, token: o.token, segment: o.segment, lotSize: o.lotSize, tickSize: o.tickSize, expiry: o.expiry, product: o.product, side: exitSide, qty: o.qty, trigger: trig, dir: trig > o.avgPrice ? 'up' : 'down', from: o.id }); }
  }
  // A position that's flat no longer needs its cover-order stop.
  const p = positionOf(acc, o);
  if (p && !p.qty) for (const x of acc.orders) if (x.coLeg && isLive(x) && posKey(x) === posKey(o)) setStatus(x, 'CANCELLED', t, 'Position closed');
}
function baseChild(acc, o, t) {
  return { id: `P${String(acc.seq++).padStart(6, '0')}`, variety: o.variety, exchange: o.exchange, symbol: o.symbol, token: o.token, segment: o.segment, lotSize: o.lotSize, tickSize: o.tickSize, expiry: o.expiry, side: o.side, product: o.product, type: o.type, qty: o.qty, price: o.price, trigger: o.trigger, validity: 'DAY', ttl: null, disclosed: null, tag: o.tag, placedAt: t, filled: 0, avgPrice: null, parent: o.id, status: 'OPEN' };
}
function spawnLeg(acc, parent, t) {
  const qty = Math.min(parent.legQty, parent.qty - parent.filled);
  const c = { ...baseChild(acc, parent, t), variety: 'iceberg', qty, icebergOf: parent.id, status: parent.type === 'SL' && !parent.triggered ? 'TRIGGER PENDING' : 'OPEN', margin: parent.margin * (qty / parent.qty), history: [{ t, s: 'OPEN' }] };
  acc.orders.push(c);
  return c;
}

// ---------- matching ----------
// A price event: { ltp, bid, ask } from a quote, or { o, h, l, c } for a 1-minute candle.
function fillPrice(o, ev) {
  const buy = o.side === 'BUY';
  if (ev.c != null) { // candle
    if (o.type === 'MARKET' || (o.triggered && o.type === 'SL-M')) return ev.o;
    if (o.type === 'LIMIT' || (o.triggered && o.type === 'SL')) {
      if (buy && ev.l <= o.price) return Math.min(o.price, ev.o);
      if (!buy && ev.h >= o.price) return Math.max(o.price, ev.o);
    }
    return null;
  }
  const take = buy ? (ev.ask || ev.ltp) : (ev.bid || ev.ltp);
  if (!take) return null;
  if (o.type === 'MARKET' || (o.triggered && o.type === 'SL-M')) return take;
  if (o.type === 'LIMIT' || (o.triggered && o.type === 'SL')) {
    if (buy && take <= o.price) return take;
    if (!buy && take >= o.price) return take;
  }
  return null;
}
function triggers(o, ev) {
  const buy = o.side === 'BUY';
  if (ev.c != null) return buy ? (ev.h >= o.trigger ? Math.max(o.trigger, ev.o) : null) : (ev.l <= o.trigger ? Math.min(o.trigger, ev.o) : null);
  if (!ev.ltp) return null;
  return buy ? (ev.ltp >= o.trigger ? ev.ltp : null) : (ev.ltp <= o.trigger ? ev.ltp : null);
}

function matchOrder(acc, o, ev, t) {
  if (!isLive(o) || o.status === 'AMO REQ RECEIVED') return;
  if (o.variety === 'iceberg' && !o.icebergOf) { // parent: make sure a leg is working
    if (!acc.orders.some((c) => c.icebergOf === o.id && isLive(c))) spawnLeg(acc, o, t);
    if (o.status === 'TRIGGER PENDING') { const at = triggers(o, ev); if (at != null) { o.triggered = true; setStatus(o, 'OPEN', t, null); for (const c of acc.orders) if (c.icebergOf === o.id && isLive(c)) { c.triggered = true; c.status = 'OPEN'; } } }
    return;
  }
  if (o.status === 'TRIGGER PENDING') {
    const at = triggers(o, ev); if (at == null) return;
    o.triggered = true; o.triggeredAt = t; o.history.push({ t, s: 'TRIGGERED' }); o.status = 'OPEN';
    if (o.type === 'SL-M') { fill(acc, o, o.qty - o.filled, ev.c != null ? at : (o.side === 'BUY' ? ev.ask || ev.ltp : ev.bid || ev.ltp), t); return; }
  }
  const px = fillPrice(o, ev);
  if (px != null) fill(acc, o, o.qty - o.filled, px, t);
}
export function matchQuote(acc, o, q, t) { matchOrder(acc, o, q, t); }

function matchGtt(acc, g, ev, t) {
  if (g.status !== 'active') return;
  if (t > g.expiresAt) { g.status = 'expired'; return; }
  const hi = ev.c != null ? ev.h : ev.ltp; const lo = ev.c != null ? ev.l : ev.ltp; if (!hi) return;
  let hit = null; let isStop = false;
  if (g.type === 'single') { if (g.dir === 'up' ? hi >= g.trigger : lo <= g.trigger) { hit = g.trigger; isStop = g.side === 'SELL' ? g.dir === 'down' : g.dir === 'up'; } }
  else {
    const stopHit = g.side === 'SELL' ? lo <= g.stop : hi >= g.stop; const tgtHit = g.side === 'SELL' ? hi >= g.target : lo <= g.target;
    if (stopHit) { hit = g.stop; isStop = true; } else if (tgtHit) hit = g.target; // both in one candle: assume the worse one
  }
  if (hit == null) return;
  g.status = 'triggered'; g.triggeredAt = t;
  // Kite places a limit order at the GTT price; for exits we use a marketable limit (a little through the price).
  const p = positionOf(acc, g); const h = holdingOf(acc, g);
  const exits = g.from || g.type === 'oco' || (p?.qty && (p.qty > 0) === (g.side === 'SELL')) || (g.side === 'SELL' && h?.qty);
  const have = g.product === 'CNC' ? (h?.qty || 0) + Math.max(0, p?.qty || 0) : Math.abs(p?.qty || 0);
  if (exits && !have) { g.status = 'cancelled'; g.note = 'No position left to exit'; return; }
  const qty = exits ? Math.min(g.qty, have) : g.qty;
  const buf = hit * 0.005; const tick = g.tickSize || 0.05;
  // Stops go in as a marketable limit (a little through the trigger) so a fast move still fills; targets at the price.
  const price = g.price || (isStop ? Math.round((g.side === 'BUY' ? hit + buf : hit - buf) / tick) * tick : hit);
  const o = { ...baseChild(acc, { ...g, type: 'LIMIT', price, qty, validity: 'DAY', variety: 'regular', tag: 'GTT' }, t), parent: g.id, history: [{ t, s: 'OPEN', msg: `GTT ${g.id} triggered at ${hit}` }], margin: 0 };
  if (!exits) { // an entry GTT needs margin like any order
    const need = approxMargin(o, price);
    if (need > funds(acc).available) { o.status = 'REJECTED'; o.message = 'Insufficient funds when the GTT triggered'; o.history.push({ t, s: 'REJECTED', msg: o.message }); acc.orders.push(o); g.order = o.id; return; }
    o.margin = need;
  }
  acc.orders.push(o); g.order = o.id;
  matchOrder(acc, o, ev, t);
}

// ---------- the clock: session ends, square-offs, expiry, TTL, AMOs ----------
function housekeeping(acc, t, priceOf, holidays) {
  const { day, min } = istParts(t);
  for (const group of Object.keys(SESSIONS)) {
    const S = SESSIONS[group];
    const inGroup = (x) => groupOf(x.exchange) === group;
    const trading = isOpen(group, t, holidays);
    // AMOs go in at the open.
    if (trading) for (const o of acc.orders) if (inGroup(o) && o.status === 'AMO REQ RECEIVED') { o.status = (o.type === 'SL' || o.type === 'SL-M') ? 'TRIGGER PENDING' : 'OPEN'; o.history.push({ t, s: o.status, msg: 'Sent to the exchange at the open' }); }
    // TTL.
    for (const o of acc.orders) if (inGroup(o) && isLive(o) && o.validity === 'TTL' && t >= o.placedAt + o.ttl * 60000) setStatus(o, 'CANCELLED', t, 'TTL expired');
    // MIS auto square-off.
    if (trading && min >= S.misCut) {
      for (const o of acc.orders) if (inGroup(o) && isLive(o) && o.product === 'MIS' && o.status !== 'AMO REQ RECEIVED') setStatus(o, 'CANCELLED', t, 'Cancelled at MIS square-off time');
      for (const p of acc.positions) if (inGroup(p) && p.product === 'MIS' && p.qty) {
        const px = priceOf(`${p.exchange}:${p.symbol}`, p.qty > 0 ? 'SELL' : 'BUY'); if (px == null) continue;
        const o = { ...baseChild(acc, { ...p, side: p.qty > 0 ? 'SELL' : 'BUY', type: 'MARKET', qty: Math.abs(p.qty), variety: 'regular', tag: 'AUTO SQ-OFF', tickSize: 0.05 }, t), price: null, margin: 0, history: [{ t, s: 'OPEN', msg: 'Auto square-off (MIS)' }] };
        acc.orders.push(o); fill(acc, o, o.qty, px, t);
        acc.cash -= AUTO_SQUAREOFF_FEE; acc.ledger.push({ t, kind: 'fee', amount: -AUTO_SQUAREOFF_FEE, note: `Auto square-off charge · ${p.symbol}` });
      }
    }
    // End of session: once we're past the close of a day we saw trading, close that day out.
    if (trading) acc.lastSeen = { ...(acc.lastSeen || {}), [group]: day };
    const seen = acc.lastSeen?.[group];
    if (seen && acc.sessionDone[group] !== seen && (day > seen || min >= S.close)) endSession(acc, group, seen, t, priceOf);
  }
}
export function endSession(acc, group, day, t, priceOf) {
  const inGroup = (x) => groupOf(x.exchange) === group;
  for (const o of acc.orders) if (inGroup(o) && isLive(o) && o.status !== 'AMO REQ RECEIVED') setStatus(o, 'CANCELLED', t, 'Order validity ended (end of day)');
  for (const p of [...acc.positions]) {
    if (!inGroup(p)) continue;
    if (p.qty && p.expiry && p.expiry <= day) { // futures expiry: cash-settled at the close
      const px = priceOf(`${p.exchange}:${p.symbol}`, null) ?? p.avg;
      const o = { ...baseChild(acc, { ...p, side: p.qty > 0 ? 'SELL' : 'BUY', type: 'MARKET', qty: Math.abs(p.qty), variety: 'regular', tag: 'EXPIRY', tickSize: 0.05 }, t), price: null, margin: 0, history: [{ t, s: 'OPEN', msg: 'Settled at expiry' }] };
      acc.orders.push(o); fill(acc, o, o.qty, px, t);
    }
    if (p.product === 'CNC' && p.qty > 0) { // today's delivery buys become holdings
      let h = holdingOf(acc, p);
      if (!h) { h = { exchange: p.exchange, symbol: p.symbol, token: p.token, qty: 0, avg: 0, margin: 0, realized: 0, since: p.day }; acc.holdings.push(h); }
      h.avg = (h.avg * h.qty + p.avg * p.qty) / (h.qty + p.qty); h.qty += p.qty; h.margin += p.margin; p.qty = 0; p.margin = 0;
    }
    if (p.product === 'MTF' && p.qty > 0) continue; // MTF carries as a position
    if (!p.qty) { p.realized = 0; acc.positions.splice(acc.positions.indexOf(p), 1); } // today's realized P&L already went to cash
    else { p.day = day; p.realized = 0; }
  }
  for (const o of acc.orders) if (inGroup(o)) o.archived = o.archived || (!isLive(o) && o.closedAt <= t);
  acc.sessionDone[group] = day;
}

/**
 * Run the engine forward to `now`. events: { [key]: [{ t, o,h,l,c }] } — 1-minute candles since
 * the last check (for catch-up); quotes: { [key]: { ltp, bid, ask } } — the latest prices.
 */
export function advance(acc, { now, quotes = {}, candles = {}, holidays = [] }) {
  const lastPx = {};
  const priceOf = (k, side) => { const q = quotes[k]; if (q?.ltp) return side === 'BUY' ? q.ask || q.ltp : side === 'SELL' ? q.bid || q.ltp : q.ltp; return lastPx[k] ?? null; };
  // 1) Replay candles in time order.
  const evs = [];
  for (const [k, cs] of Object.entries(candles)) for (const c of cs) evs.push({ k, ...c });
  evs.sort((a, b) => a.t - b.t);
  for (const ev of evs) {
    lastPx[ev.k] = ev.c;
    housekeeping(acc, ev.t, (k) => lastPx[k] ?? null, holidays);
    if (!isOpen(groupOf(ev.k.split(':')[0]), ev.t, holidays)) continue;
    for (const o of acc.orders.filter((x) => isLive(x) && keyOf(x) === ev.k)) matchOrder(acc, o, ev, ev.t + 59000);
    for (const g of acc.gtts.filter((x) => x.status === 'active' && keyOf(x) === ev.k)) matchGtt(acc, g, ev, ev.t + 59000);
  }
  // 2) The live quote.
  housekeeping(acc, now, priceOf, holidays);
  for (const [k, q] of Object.entries(quotes)) {
    if (!q?.ltp || !isOpen(groupOf(k.split(':')[0]), now, holidays)) continue;
    if (q.ltt && now - q.ltt > 6 * 3600000) continue; // stale quote (holiday): no fills
    for (const o of acc.orders.filter((x) => isLive(x) && keyOf(x) === k)) matchOrder(acc, o, q, now);
    for (const g of acc.gtts.filter((x) => x.status === 'active' && keyOf(x) === k)) matchGtt(acc, g, q, now);
  }
  acc.lastCheck = now;
  return acc;
}

// ---------- the risk check (warn only) ----------
export function riskCheck(acc, o, ltp) {
  const entry = o.price || ltp; const stop = o.variety === 'co' ? o.coTrigger : o.stop;
  const budget = acc.capital * (acc.riskPct / 100);
  if (!entry) return { budget, risk: null, over: false, note: 'No price yet' };
  if (!stop) return { budget, risk: null, over: false, note: `No stoploss set — your 1% rule allows ₹${Math.round(budget).toLocaleString('en-IN')} of risk on this trade` };
  const risk = Math.abs(entry - stop) * o.qty;
  return { budget, risk, over: risk > budget, pct: (risk / acc.capital) * 100, maxQty: Math.floor(budget / Math.abs(entry - stop) / (o.lotSize || 1)) * (o.lotSize || 1) };
}

export function stats(acc) {
  const closed = acc.trades.filter((t) => t.closedAt);
  const wins = closed.filter((t) => t.net > 0); const losses = closed.filter((t) => t.net <= 0);
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
  const withR = closed.filter((t) => t.r != null);
  return {
    trades: closed.length, open: acc.trades.length - closed.length, wins: wins.length, losses: losses.length,
    winRate: closed.length ? wins.length / closed.length : null, net: r2(sum(closed, (t) => t.net)), charges: r2(sum(closed, (t) => t.charges)),
    avgWin: wins.length ? r2(sum(wins, (t) => t.net) / wins.length) : null, avgLoss: losses.length ? r2(sum(losses, (t) => t.net) / losses.length) : null,
    avgR: withR.length ? r2(sum(withR, (t) => t.r) / withR.length) : null, totalR: withR.length ? r2(sum(withR, (t) => t.r)) : null,
    profitFactor: losses.length && sum(losses, (t) => t.net) ? r2(sum(wins, (t) => t.net) / -sum(losses, (t) => t.net)) : null,
  };
}

// ---------- risk-free positions ----------
/** The protective stop on a position: the tightest live stop order (SL / SL-M / cover leg) or GTT stop. */
export function stopFor(acc, p) {
  if (!p.qty) return null;
  const long = p.qty > 0; const exitSide = long ? 'SELL' : 'BUY'; const k = `${p.exchange}:${p.symbol}`;
  const cands = [];
  for (const o of acc.orders) if (isLive(o) && keyOf(o) === k && o.side === exitSide && (o.type === 'SL' || o.type === 'SL-M') && o.trigger) cands.push(o.trigger);
  for (const g of acc.gtts) {
    if (g.status !== 'active' || keyOf(g) !== k || g.side !== exitSide) continue;
    if (g.type === 'oco') cands.push(g.stop);
    else if (long ? g.trigger < p.avg || g.dir === 'down' : g.trigger > p.avg || g.dir === 'up') cands.push(g.trigger);
  }
  if (!cands.length) return null;
  return long ? Math.max(...cands) : Math.min(...cands);
}

/** Worst case if the stop is hit: booked P&L on this trade + move to the stop − charges paid and still to pay. */
export function positionRiskFree(acc, p) {
  const stop = stopFor(acc, p); if (stop == null) return null;
  const tr = acc.trades.find((t) => !t.closedAt && t.exchange === p.exchange && t.symbol === p.symbol && t.product === p.product);
  const booked = (tr?.pnl || 0) - (tr?.charges || 0);
  const qty = Math.abs(p.qty);
  const exitCh = chargesFor(p, p.qty > 0 ? 'SELL' : 'BUY', qty, stop).total;
  const locked = booked + (stop - p.avg) * p.qty - exitCh;
  return { stop, locked: r2(locked), free: locked >= 0 };
}
