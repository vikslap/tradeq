import test from 'node:test';
import assert from 'node:assert/strict';
import { bucketOf, summarize, yearsWithActivity } from '../public/report.js';

const T = (o) => ({ id: Math.random().toString(36), exchange: 'NSE', segment: 'EQ', side: 'LONG', status: 'CLOSED', qty: 10, entryPrice: 100, entryTime: '2025-05-02T04:00:00Z', entryOrders: 1, charges: 0, ...o });

test('buckets: strategy for equity, segment for derivatives and commodities', () => {
  assert.equal(bucketOf(T({ horizon: 'LONGTERM' })), 'eq-lt');
  assert.equal(bucketOf(T({ horizon: 'SWING' })), 'eq-tr');
  assert.equal(bucketOf(T({ horizon: 'POSITIONAL' })), 'eq-tr');
  assert.equal(bucketOf(T({ horizon: 'SWING', exchange: 'NFO', segment: 'FUT' })), 'fno');
  assert.equal(bucketOf(T({ horizon: 'SWING', exchange: 'MCX', segment: 'COM' })), 'com');
  assert.equal(bucketOf(T({ exchange: 'MF' })), null);
});

test('summary by year: partial exits land in their own year; totals add up', () => {
  const lt = T({ horizon: 'LONGTERM', qty: 10, exits: [{ qty: 5, price: 120, time: '2025-06-01T05:00:00Z' }, { qty: 5, price: 150, time: '2026-05-01T05:00:00Z' }], exitTime: '2026-05-01T05:00:00Z', initialStop: 90 });
  const sw = T({ horizon: 'SWING', exits: [{ qty: 10, price: 95, time: '2025-07-01T05:00:00Z' }], exitTime: '2025-07-01T05:00:00Z', initialStop: 95 });
  const fu = T({ horizon: 'SWING', exchange: 'NFO', segment: 'FUT', exits: [{ qty: 10, price: 130, time: '2025-08-01T05:00:00Z' }], exitTime: '2025-08-01T05:00:00Z' });
  const open = T({ horizon: 'POSITIONAL', status: 'OPEN', entryTime: '2026-10-01T04:00:00Z', exits: [] });
  const ltp = (t) => (t === open ? 110 : null);
  const y1 = summarize([lt, sw, fu, open], { fy: 'FY25-26', ltpFor: ltp, today: '2026-11-28' });
  assert.equal(y1['eq-lt'].booked, 100); assert.equal(y1['eq-lt'].closed, 0); // final exit is next year
  assert.equal(y1['eq-tr'].net, -50); assert.equal(y1['eq-tr'].avgR, -1); assert.equal(y1['eq-tr'].winRate, 0);
  assert.equal(y1.fno.net, 300);
  assert.equal(y1.eq.net, 50); assert.equal(y1.all.net, 350);
  const y2 = summarize([lt, sw, fu, open], { fy: 'FY26-27', ltpFor: ltp, today: '2026-11-28' });
  assert.equal(y2['eq-lt'].booked, 250); assert.equal(y2['eq-lt'].closed, 1);
  assert.equal(y2['eq-tr'].open, 100); assert.equal(y2['eq-tr'].openTrades, 1);
  const all = summarize([lt, sw, fu, open], { ltpFor: ltp, today: '2026-11-28' });
  assert.equal(all.all.net, 350 + 250 + 100);
  assert.deepEqual(yearsWithActivity([lt, sw, fu, open], '2026-11-28'), ['FY26-27', 'FY25-26']);
});
