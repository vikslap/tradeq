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

import { exitEvents, monthlyReturns } from '../public/report.js';
test('monthly returns compound on the running account, after sweeps', () => {
  const ev = [{ day: '2025-01-10', pnl: 10000 }, { day: '2025-03-05', pnl: -5500 }, { day: '2026-01-20', pnl: 2000 }];
  const r = monthlyReturns(ev, { capital: 100000, sweeps: [{ date: '2025-02-01', amount: 0 }] });
  assert.deepEqual(r.years, ['2026', '2025']);
  assert.ok(Math.abs(r.cells['2025'][0].pct - 0.1) < 1e-12);
  assert.equal(r.cells['2025'][1].pct, 0); assert.equal(r.cells['2025'][1].traded, false);
  assert.ok(Math.abs(r.cells['2025'][2].pct - -0.05) < 1e-12); // -5,500 on 1,10,000
  assert.ok(Math.abs(r.totals['2025'].pct - (1.1 * 0.95 - 1)) < 1e-12);
  const s = monthlyReturns(ev, { capital: 100000, sweeps: [{ date: '2025-02-10', amount: 10000 }] });
  assert.ok(Math.abs(s.cells['2025'][2].pct - -0.055) < 1e-12); // swept back to 1,00,000 before March
  const fy = monthlyReturns(ev, { capital: 100000, basis: 'fy' });
  assert.deepEqual(fy.years, ['FY25-26', 'FY24-25']); assert.ok(fy.cells['FY24-25'][9].pct > 0); // January sits in slot 9
  const t = { exchange: 'NSE', segment: 'EQ', horizon: 'SWING', side: 'LONG', status: 'CLOSED', qty: 10, entryPrice: 100, entryTime: '2025-01-02T04:00:00Z', charges: 0, exits: [{ qty: 10, price: 110, time: '2025-01-09T05:00:00Z' }] };
  assert.deepEqual(exitEvents([t], 'eq-tr'), [{ day: '2025-01-09', pnl: 100 }]);
  assert.deepEqual(exitEvents([t], 'fno'), []);
});
