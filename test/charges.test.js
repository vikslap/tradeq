import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderCharges, tradeCharges } from '../public/charges.js';
import { metrics } from '../public/game.js';

const near = (a, b, tol = 0.02) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

test('equity delivery buy of ₹60,000 (cross-checked with a published worked example)', () => {
  const c = orderCharges('EQ_DELIVERY', 'NSE', 'BUY', 60000);
  assert.equal(c.brokerage, 0); assert.equal(c.stt, 60); assert.equal(c.stamp, 9);
  near(c.txn, 1.84); near(c.sebi, 0.06); near(c.gst, 0.34);
  near(c.total, 71.24);
});

test('intraday brokerage is 0.03% capped at ₹20; STT only on the sell', () => {
  assert.equal(orderCharges('EQ_INTRADAY', 'NSE', 'BUY', 20000).brokerage, 6);
  assert.equal(orderCharges('EQ_INTRADAY', 'NSE', 'BUY', 500000).brokerage, 20);
  assert.equal(orderCharges('EQ_INTRADAY', 'NSE', 'BUY', 100000).stt, 0);
  assert.equal(orderCharges('EQ_INTRADAY', 'NSE', 'SELL', 100000).stt, 25);
});

test('options: ₹20 flat, STT 0.15% on sell premium (Budget 2026), stamp on buy', () => {
  const sell = orderCharges('OPT', 'NFO', 'SELL', 65 * 1805.3);
  assert.equal(sell.brokerage, 20); near(sell.stt, 176.02); assert.equal(sell.stamp, 0);
  const buy = orderCharges('OPT', 'NFO', 'BUY', 65 * 103.9);
  near(buy.stamp, 0.2); assert.equal(buy.stt, 0);
});

test('futures STT 0.05% sell; MCX CTT 0.01% sell', () => {
  near(orderCharges('FUT', 'NFO', 'SELL', 1000000).stt, 500);
  near(orderCharges('COM_FUT', 'MCX', 'SELL', 1000000).stt, 100);
});

test('trade charges: same-day equity = intraday rates; later exit = delivery + DP', () => {
  const t = { side: 'LONG', segment: 'EQ', exchange: 'NSE', qty: 100, entryPrice: 400, entryTime: '2026-11-02T04:00:00Z' };
  const intra = tradeCharges({ ...t, exits: [{ qty: 100, price: 410, time: '2026-11-02T08:00:00Z' }] });
  assert.equal(intra.dp, 0); near(intra.stt, 10.25);
  const deliv = tradeCharges({ ...t, exits: [{ qty: 100, price: 410, time: '2026-11-05T08:00:00Z' }] });
  assert.equal(deliv.dp, 15.34); near(deliv.stt, 81);
});

test('partial exits: realised net + unrealised on the rest; R on full risk', () => {
  const t = { side: 'LONG', segment: 'EQ', exchange: 'NSE', qty: 100, entryPrice: 400, initialStop: 380, entryTime: '2026-11-02T04:00:00Z', status: 'OPEN',
    exits: [{ qty: 40, price: 440, time: '2026-11-06T05:00:00Z' }], charges: 0 };
  const m = metrics(t, 430);
  assert.equal(m.exQty, 40); assert.equal(m.openQty, 60);
  assert.equal(m.realised, 1600); assert.equal(m.unrealised, 1800); assert.equal(m.net, 3400);
  assert.equal(m.r, 3400 / 2000);
  assert.equal(metrics({ ...t, charges: null }, 430).realised < 1600, true); // auto charges reduce realised
});
