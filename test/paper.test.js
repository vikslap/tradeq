import test from 'node:test';
import assert from 'node:assert/strict';
import { newAccount, placeOrder, cancelOrder, modifyOrder, advance, funds, istMs, riskCheck, stats, createGtt, PaperError } from '../public/paper/engine.js';

const D = '2026-11-25'; // a Wednesday
const at = (hhmm, day = D) => { const [h, m] = hhmm.split(':').map(Number); return istMs(day, h * 60 + m); };
const EQ = { exchange: 'NSE', symbol: 'INFY', token: 408065, segment: 'EQ', lotSize: 1, tickSize: 0.05 };
const FUT = { exchange: 'NFO', symbol: 'NIFTY26DECFUT', token: 1, segment: 'FUT', lotSize: 75, tickSize: 0.1, expiry: '2026-12-29' };
const Q = (ltp, d = 0.5) => ({ ltp, bid: ltp - d, ask: ltp + d });
const candle = (hhmm, o, h, l, c, day = D) => ({ t: at(hhmm, day), o, h, l, c });
const throwsMsg = (fn, re) => assert.throws(fn, (e) => e instanceof PaperError && re.test(e.message));

test('market CNC buy fills at the ask, blocks the full value, charges deducted', () => {
  const a = newAccount();
  const o = placeOrder(a, { ...EQ, side: 'BUY', product: 'CNC', type: 'MARKET', qty: 100 }, { now: at('10:00'), quote: Q(1500) });
  assert.equal(o.status, 'COMPLETE'); assert.equal(o.avgPrice, 1500.5);
  const f = funds(a, () => 1500.5);
  assert.ok(Math.abs(f.blockedPos - 150000) < 1e-6); // blocked at the order's reference price
  assert.ok(a.cash < 600000 && a.cash > 599800); // stamp + txn etc. on delivery
});

test('closed market rejects regular orders; AMO goes in at the open', () => {
  const a = newAccount();
  throwsMsg(() => placeOrder(a, { ...EQ, side: 'BUY', product: 'CNC', type: 'MARKET', qty: 1 }, { now: at('08:00'), quote: Q(1500) }), /market is closed/);
  const o = placeOrder(a, { ...EQ, variety: 'amo', side: 'BUY', product: 'CNC', type: 'LIMIT', price: 1490, qty: 10 }, { now: at('08:00'), quote: Q(1500) });
  assert.equal(o.status, 'AMO REQ RECEIVED');
  throwsMsg(() => placeOrder(a, { ...EQ, variety: 'amo', side: 'BUY', product: 'CNC', type: 'MARKET', qty: 1 }, { now: at('10:00'), quote: Q(1500) }), /after market hours/);
  advance(a, { now: at('09:20'), candles: { 'NSE:INFY': [candle('09:15', 1500, 1502, 1495, 1497), candle('09:16', 1497, 1498, 1488, 1492)] } });
  assert.equal(o.status, 'COMPLETE'); assert.equal(o.avgPrice, 1490);
});

test('stoploss orders: trigger rules, SL-M fill on a candle, IOC and TTL', () => {
  const a = newAccount();
  placeOrder(a, { ...EQ, side: 'BUY', product: 'MIS', type: 'MARKET', qty: 50 }, { now: at('10:00'), quote: Q(1500, 0) });
  throwsMsg(() => placeOrder(a, { ...EQ, side: 'SELL', product: 'MIS', type: 'SL-M', trigger: 1510, qty: 50 }, { now: at('10:01'), quote: Q(1500) }), /lower than the last traded price/);
  const sl = placeOrder(a, { ...EQ, side: 'SELL', product: 'MIS', type: 'SL-M', trigger: 1480, qty: 50 }, { now: at('10:01'), quote: Q(1500) });
  assert.equal(sl.status, 'TRIGGER PENDING');
  advance(a, { now: at('10:10'), candles: { 'NSE:INFY': [candle('10:05', 1490, 1491, 1470, 1475)] } });
  assert.equal(sl.status, 'COMPLETE'); assert.equal(sl.avgPrice, 1480);
  const t = a.trades[0]; assert.ok(t.closedAt); assert.ok(Math.abs(t.pnl - -1000) < 1e-6);
  const ioc = placeOrder(a, { ...EQ, side: 'BUY', product: 'MIS', type: 'LIMIT', price: 1400, qty: 1, validity: 'IOC' }, { now: at('10:20'), quote: Q(1475) });
  assert.equal(ioc.status, 'CANCELLED');
  const ttl = placeOrder(a, { ...EQ, side: 'BUY', product: 'MIS', type: 'LIMIT', price: 1400, qty: 1, validity: 'TTL', ttl: 5 }, { now: at('10:20'), quote: Q(1475) });
  advance(a, { now: at('10:26'), quotes: { 'NSE:INFY': Q(1470) } });
  assert.equal(ttl.status, 'CANCELLED'); assert.match(ttl.message, /TTL/);
});

test('MIS is squared off at 15:20 with the auto square-off charge; new MIS blocked after', () => {
  const a = newAccount();
  placeOrder(a, { ...EQ, side: 'SELL', product: 'MIS', type: 'MARKET', qty: 10 }, { now: at('14:00'), quote: Q(1500, 0) });
  advance(a, { now: at('15:21'), quotes: { 'NSE:INFY': Q(1490, 0) } });
  assert.equal(a.positions.find((p) => p.symbol === 'INFY').qty, 0);
  assert.ok(a.ledger.some((l) => l.kind === 'fee'));
  assert.ok(Math.abs(a.trades[0].pnl - 100) < 1e-6);
  throwsMsg(() => placeOrder(a, { ...EQ, side: 'BUY', product: 'MIS', type: 'MARKET', qty: 1 }, { now: at('15:22'), quote: Q(1490) }), /blocked after the square-off/);
});

test('CNC buys become holdings after the close; CNC sell needs holdings', () => {
  const a = newAccount();
  throwsMsg(() => placeOrder(a, { ...EQ, side: 'SELL', product: 'CNC', type: 'MARKET', qty: 5 }, { now: at('10:00'), quote: Q(1500) }), /CNC sells need holdings/);
  placeOrder(a, { ...EQ, side: 'BUY', product: 'CNC', type: 'MARKET', qty: 5 }, { now: at('10:00'), quote: Q(1500, 0) });
  advance(a, { now: at('15:35'), quotes: { 'NSE:INFY': Q(1510, 0) } });
  assert.equal(a.holdings.length, 1); assert.equal(a.holdings[0].qty, 5);
  assert.equal(a.positions.length, 0);
  const s = placeOrder(a, { ...EQ, side: 'SELL', product: 'CNC', type: 'MARKET', qty: 5 }, { now: at('10:00', '2026-11-26'), quote: Q(1520, 0) });
  assert.equal(s.status, 'COMPLETE'); assert.equal(a.holdings.length, 0);
  assert.ok(Math.abs(a.trades[0].pnl - 100) < 1e-6);
});

test('cover order places its stop leg; futures need whole lots; insufficient funds', () => {
  const a = newAccount();
  const co = placeOrder(a, { ...EQ, variety: 'co', side: 'BUY', product: 'MIS', type: 'MARKET', qty: 100, coTrigger: 1480 }, { now: at('11:00'), quote: Q(1500, 0) });
  const leg = a.orders.find((x) => x.coLeg);
  assert.equal(co.status, 'COMPLETE'); assert.equal(leg.status, 'TRIGGER PENDING'); assert.equal(leg.trigger, 1480);
  placeOrder(a, { ...EQ, side: 'SELL', product: 'MIS', type: 'MARKET', qty: 100 }, { now: at('11:05'), quote: Q(1505, 0) });
  assert.equal(leg.status, 'CANCELLED');
  throwsMsg(() => placeOrder(a, { ...FUT, side: 'BUY', product: 'NRML', type: 'MARKET', qty: 50 }, { now: at('11:00'), quote: Q(24000) }), /multiple of the lot size/);
  throwsMsg(() => placeOrder(a, { ...FUT, side: 'BUY', product: 'NRML', type: 'MARKET', qty: 75 * 4 }, { now: at('11:00'), quote: Q(24000), margin: 900000 }), /Insufficient funds/);
  const f = placeOrder(a, { ...FUT, side: 'BUY', product: 'NRML', type: 'MARKET', qty: 75 }, { now: at('11:00'), quote: Q(24000, 1) });
  assert.equal(f.status, 'COMPLETE');
});

test('iceberg fills leg by leg; stop/target become a GTT OCO that exits', () => {
  const a = newAccount();
  const ice = placeOrder(a, { ...EQ, variety: 'iceberg', side: 'BUY', product: 'CNC', type: 'LIMIT', price: 1500, qty: 300, legs: 3 }, { now: at('10:00'), quote: Q(1510) });
  advance(a, { now: at('10:05'), candles: { 'NSE:INFY': [candle('10:01', 1505, 1506, 1499, 1500), candle('10:02', 1500, 1501, 1498, 1499), candle('10:03', 1499, 1500, 1497, 1498)] } });
  assert.equal(ice.status, 'COMPLETE'); assert.equal(ice.filled, 300);
  assert.equal(a.orders.filter((o) => o.icebergOf === ice.id).length, 3);
  const b = newAccount();
  placeOrder(b, { ...EQ, side: 'BUY', product: 'CNC', type: 'MARKET', qty: 10, stop: 1450, target: 1600 }, { now: at('10:00'), quote: Q(1500, 0) });
  assert.equal(b.gtts.length, 1); assert.equal(b.gtts[0].type, 'oco');
  advance(b, { now: at('12:00'), candles: { 'NSE:INFY': [candle('11:00', 1520, 1601, 1519, 1600)] } });
  assert.equal(b.gtts[0].status, 'triggered');
  assert.equal(b.positions[0].qty, 0);
  assert.ok(b.trades[0].closedAt); assert.ok(b.trades[0].r > 1.9);
});

test('futures settle on expiry; risk check warns over 1%', () => {
  const a = newAccount();
  placeOrder(a, { ...FUT, expiry: D, side: 'SELL', product: 'NRML', type: 'MARKET', qty: 75 }, { now: at('10:00'), quote: Q(24000, 0) });
  advance(a, { now: at('15:31'), quotes: { 'NFO:NIFTY26DECFUT': Q(23900, 0) } });
  assert.equal(a.positions.length, 0);
  assert.ok(Math.abs(a.trades[0].pnl - 7500) < 1e-6);
  const r = riskCheck(a, { ...EQ, qty: 200, price: 1500, stop: 1460, lotSize: 1 }, 1500);
  assert.equal(r.risk, 8000); assert.equal(r.over, true); assert.equal(r.maxQty, 150);
  assert.equal(stats(a).trades, 1);
});

test('modify and cancel', () => {
  const a = newAccount();
  const o = placeOrder(a, { ...EQ, side: 'BUY', product: 'CNC', type: 'LIMIT', price: 1450, qty: 10 }, { now: at('10:00'), quote: Q(1500) });
  modifyOrder(a, o.id, { price: 1460 }, { now: at('10:01'), quote: Q(1500) });
  assert.equal(o.price, 1460);
  modifyOrder(a, o.id, { price: 1510 }, { now: at('10:02'), quote: Q(1500, 0) });
  assert.equal(o.status, 'COMPLETE');
  const o2 = placeOrder(a, { ...EQ, side: 'BUY', product: 'CNC', type: 'LIMIT', price: 1400, qty: 10 }, { now: at('10:03'), quote: Q(1500) });
  cancelOrder(a, o2.id, at('10:04')); assert.equal(o2.status, 'CANCELLED');
  const g = createGtt(a, { type: 'single', ...EQ, side: 'BUY', product: 'CNC', qty: 5, trigger: 1400, price: 1400, ltpAtCreate: 1500 }, at('10:05'));
  assert.equal(g.dir, 'down');
});

import { positionRiskFree } from '../public/paper/engine.js';
test('a paper position is risk-free once its stop locks in at least the charges', () => {
  const a = newAccount();
  placeOrder(a, { ...EQ, side: 'BUY', product: 'MIS', type: 'MARKET', qty: 100 }, { now: at('10:00'), quote: Q(1500, 0) });
  const p = a.positions[0];
  assert.equal(positionRiskFree(a, p), null); // no stop yet
  const sl = placeOrder(a, { ...EQ, side: 'SELL', product: 'MIS', type: 'SL-M', trigger: 1480, qty: 100 }, { now: at('10:01'), quote: Q(1500) });
  assert.equal(positionRiskFree(a, p).free, false);
  modifyOrder(a, sl.id, { trigger: 1500 }, { now: at('10:30'), quote: Q(1520) });
  assert.equal(positionRiskFree(a, p).free, false); // stop at entry still loses the charges
  modifyOrder(a, sl.id, { trigger: 1502 }, { now: at('10:31'), quote: Q(1520) });
  const rf = positionRiskFree(a, p); assert.equal(rf.free, true); assert.ok(rf.locked > 0 && rf.locked < 200);
});
