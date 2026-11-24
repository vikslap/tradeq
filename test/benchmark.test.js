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
