import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../public/sync.js';
import { chartPlan, excursionsFromCandles, parseKiteCandles, kiteDate } from '../lib/chart.js';

const tr = (o) => ({ status: 'OPEN', side: 'LONG', segment: 'EQ', exchange: 'NSE', entryTime: '2026-11-10T05:00:00.000Z', entryPrice: 100, ...o });

test('reconcile: match, unlogged, closed, qty mismatch, NSE/BSE treated as one', () => {
  const trades = [
    tr({ id: 'a', symbol: 'ITC', qty: 100 }),
    tr({ id: 'b', symbol: 'SBIN26DECFUT', exchange: 'NFO', segment: 'FUT', qty: 750 }),
    tr({ id: 'c', symbol: 'GOLDM26DECFUT', exchange: 'MCX', segment: 'COM', side: 'SHORT', qty: 10 }),
    tr({ id: 'd', symbol: 'TCS', exchange: 'BSE', qty: 5 }),
  ];
  const r = reconcile(trades, {
    holdings: [{ symbol: 'ITC', exchange: 'NSE', qty: 100 }, { symbol: 'TATAPOWER', exchange: 'NSE', qty: 50, avgPrice: 400 }, { symbol: 'TCS', exchange: 'NSE', qty: 5 }],
    positions: [
      { symbol: 'SBIN26DECFUT', exchange: 'NFO', product: 'NRML', qty: 0, sellPrice: 880, buyPrice: 870 },
      { symbol: 'GOLDM26DECFUT', exchange: 'MCX', product: 'NRML', qty: -20 },
    ],
  });
  const by = Object.fromEntries(r.rows.map((x) => [x.symbol, x]));
  assert.equal(by.ITC.status, 'match');
  assert.equal(by.TCS.status, 'match');
  assert.equal(by.TATAPOWER.status, 'unlogged');
  assert.equal(by.SBIN26DECFUT.status, 'closed');
  assert.equal(by.SBIN26DECFUT.exitPrice, 880);
  assert.equal(by.GOLDM26DECFUT.status, 'qty');
  assert.equal(r.issues, 3);
});

test('chartPlan picks interval by holding period', () => {
  const now = Date.parse('2026-11-18T05:00:00Z');
  assert.equal(chartPlan(tr({ entryTime: '2026-11-17T05:00:00Z' }), now).interval, '5minute');
  assert.equal(chartPlan(tr({ entryTime: '2026-11-08T05:00:00Z' }), now).interval, '60minute');
  assert.equal(chartPlan(tr({ entryTime: '2026-08-01T05:00:00Z' }), now).interval, 'day');
});

test('Kite candle parsing and IST date format', () => {
  const [c] = parseKiteCandles([['2026-11-17T09:15:00+0530', 1, 2, 0.5, 1.5, 100]]);
  assert.equal(new Date(c[0]).toISOString(), '2026-11-17T03:45:00.000Z');
  assert.equal(kiteDate(Date.parse('2026-11-17T03:45:00Z')), '2026-11-17 09:15:00');
});

test('excursions: intraday bars inside the trade only; daily bars skip entry/exit days', () => {
  const t = tr({ status: 'CLOSED', entryTime: '2026-11-17T04:00:00Z', exitTime: '2026-11-17T06:00:00Z', exitPrice: 98 });
  const H = 3600000; const e = Date.parse('2026-11-17T04:00:00Z');
  const candles = [[e - H, 100, 130, 90, 100], [e, 100, 112, 97, 105], [e + H, 105, 108, 96, 99], [e + 3 * H, 99, 140, 80, 100]];
  assert.deepEqual(excursionsFromCandles(t, candles, '60minute'), { mfe: 112, mae: 96 });
  const D = 86400000; const td = tr({ status: 'CLOSED', entryTime: '2026-11-10T05:00:00Z', exitTime: '2026-11-13T05:00:00Z', exitPrice: 101 });
  const day = (d) => Date.parse(`2026-11-${d}T00:00:00+05:30`);
  const daily = [[day(10), 0, 150, 50, 0], [day(11), 0, 109, 99, 0], [day(12), 0, 104, 95, 0], [day(13), 0, 160, 40, 0]];
  assert.deepEqual(excursionsFromCandles(td, daily, 'day'), { mfe: 109, mae: 95 });
  void D;
});

test('ignored holdings are skipped unless journaled', () => {
  const r = reconcile([], { holdings: [{ symbol: 'HDFCBANK', exchange: 'NSE', qty: 10 }, { symbol: 'TCS', exchange: 'NSE', qty: 2 }] }, ['EQ:HDFCBANK']);
  assert.equal(r.rows.length, 1);
  assert.equal(r.ignored, 1);
});

test('xirr: doubling in a year ≈ 100%', async () => {
  const { xirr } = await import('../public/stats.js');
  const y = 365 * 86400000;
  assert.ok(Math.abs(xirr([{ t: 0, v: -100 }, { t: y, v: 200 }]) - 1) < 1e-6);
});
