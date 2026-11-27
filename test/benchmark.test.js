import test from 'node:test';
import assert from 'node:assert/strict';
import { slicesOf, compareWithIndex, inBenchmark, marksNeeded } from '../public/benchmark.js';

// Index fund NAV: 100 until 2025-03-31, then 110 from 2025-04-01, 121 from 2026-01-01.
const nav = [['2024-01-01', 100], ['2025-03-31', 100], ['2025-04-01', 110], ['2026-01-01', 121]];
const T = (o) => ({ id: o.symbol + o.entryTime, exchange: 'NSE', segment: 'EQ', side: 'LONG', status: 'CLOSED', qty: 10, entryPrice: 100, entryOrders: 1, ...o });

test('only swing and positional stock trades count', () => {
  assert.equal(inBenchmark(T({ symbol: 'A', horizon: 'SWING' })), true);
  assert.equal(inBenchmark(T({ symbol: 'A', horizon: 'POSITIONAL' })), true);
  assert.equal(inBenchmark(T({ symbol: 'A', horizon: 'LONGTERM' })), false);
  assert.equal(inBenchmark(T({ symbol: 'A', horizon: 'INTRADAY' })), false);
  assert.equal(inBenchmark(T({ symbol: 'NIFTY', horizon: 'SWING', exchange: 'NFO', segment: 'FO' })), false);
  assert.equal(inBenchmark(T({ symbol: 'PPFAS', horizon: 'SWING', exchange: 'MF', segment: 'MF' })), false);
});

test('a trade across 31 March is split between the two years and the totals add up', () => {
  const t = T({ symbol: 'A', horizon: 'POSITIONAL', entryTime: '2025-02-01T04:00:00Z', exits: [{ qty: 10, price: 150, time: '2025-06-02T05:00:00Z' }] });
  const sl = slicesOf([t], () => null, '2026-06-01');
  assert.equal(sl.length, 1);
  assert.deepEqual([...marksNeeded(sl).get('A')], ['2025-03-31']);
  const r = compareWithIndex(sl, nav, '2026-06-01', (sym, d) => (sym === 'A' && d === '2025-03-31' ? 120 : null));
  const ch = sl[0].charges; assert.ok(ch > 0);
  assert.ok(Math.abs(r.you - (500 - ch)) < 1e-6);
  assert.ok(Math.abs(r.idx - 100) < 1e-6); // ₹1,000 in the fund: 100 → 110
  const [y1, y2] = r.years;
  assert.equal(y1.fy, 'FY24-25'); assert.equal(y2.fy, 'FY25-26');
  assert.ok(Math.abs(y1.you - 200) < 1e-6); assert.ok(Math.abs(y1.idx) < 1e-6);
  assert.ok(Math.abs(y2.you - (300 - ch)) < 1e-6); assert.ok(Math.abs(y2.idx - 100) < 1e-6);
  assert.ok(Math.abs(y1.you + y2.you - r.you) < 1e-6 && Math.abs(y1.idx + y2.idx - r.idx) < 1e-6);
});

test('partial exits and open remainder; short trades; long-term ignored', () => {
  const t = T({ symbol: 'B', horizon: 'SWING', status: 'OPEN', entryTime: '2025-05-01T04:00:00Z', exits: [{ qty: 4, price: 110, time: '2025-05-10T05:00:00Z' }] });
  const s = T({ symbol: 'C', horizon: 'SWING', side: 'SHORT', entryTime: '2025-05-01T04:00:00Z', exits: [{ qty: 10, price: 90, time: '2025-05-05T05:00:00Z' }] });
  const lt = T({ symbol: 'D', horizon: 'LONGTERM', entryTime: '2020-05-01T04:00:00Z', exits: [{ qty: 10, price: 900, time: '2025-05-05T05:00:00Z' }] });
  const sl = slicesOf([t, s, lt], (x) => (x.symbol === 'B' ? 120 : null), '2025-06-01');
  assert.equal(sl.length, 3);
  const open = sl.find((x) => x.open); assert.equal(open.qty, 6); assert.equal(open.endPrice, 120); assert.equal(open.charges, 0);
  const r = compareWithIndex(sl, nav, '2025-06-01');
  const ch = sl.reduce((a, x) => a + x.charges, 0);
  assert.ok(Math.abs(r.you - (40 + 120 + 100 - ch)) < 1e-6);
  assert.equal(r.trades, 2);
});

import { sliceResults, rollingWindows, drawdown } from '../public/benchmark.js';
import { riskFreeOf } from '../public/riskfree.js';

test('rolling 12-month windows and drawdown', () => {
  const nav2 = [['2023-01-01', 100], ['2026-12-31', 100]];
  const mk = (start, end, you) => ({ t: { id: start }, sym: 'X', side: 'LONG', start, end, qty: 10, cost: 1000, endPrice: 100 + you / 10, charges: 0 });
  const res = sliceResults([mk('2024-01-10', '2024-02-10', 100), mk('2024-06-01', '2024-07-01', -300), mk('2025-03-01', '2025-04-01', 50)], nav2);
  const r = rollingWindows(res, '2025-06-30');
  assert.equal(r.windows[0].to, '2025-01-31'); assert.equal(r.windows.at(-1).to, '2025-06-30');
  assert.ok(Math.abs(r.windows[0].you - -200) < 1e-9); // Feb-24 … Jan-25 holds the +100 and the −300
  assert.ok(Math.abs(r.windows.at(-1).you - -250) < 1e-9); // Jul-24 … Jun-25: −300 and +50
  const d = drawdown([{ t: '2024-02-10', v: 100 }, { t: '2024-07-01', v: -300 }, { t: '2025-04-01', v: 50 }]);
  assert.equal(d.max, 300); assert.equal(d.from, '2024-02-10'); assert.equal(d.current, 250);
});

test('real trade: risk-free when the stop locks in more than the charges', () => {
  const t = { id: 'a', status: 'OPEN', side: 'LONG', exchange: 'NSE', segment: 'EQ', qty: 100, entryPrice: 1000, entryTime: '2026-11-02T04:00:00Z', entryOrders: 1, stopLoss: 950, exits: [] };
  assert.equal(riskFreeOf(t).free, false);
  assert.equal(riskFreeOf({ ...t, stopLoss: 1000 }).free, false);
  assert.equal(riskFreeOf({ ...t, stopLoss: 1010 }).free, true);
  // half booked at 1100 pays for a stop below entry on the rest
  const p = { ...t, stopLoss: 990, exits: [{ qty: 50, price: 1100, time: '2026-11-10T05:00:00Z' }] };
  assert.equal(riskFreeOf(p).free, true);
});
