import test from 'node:test';
import assert from 'node:assert/strict';
import { isoDate, parseNseRows, parsePeCsv, mergeSeries, valuationSummary, windowStats, yearChunks, nseDate, zone } from '../public/valuation.js';

test('dates in NSE formats', () => {
  assert.equal(isoDate('20 Nov 2026'), '2026-11-20');
  assert.equal(isoDate('05-Jan-2024'), '2024-01-05');
  assert.equal(isoDate('5-1-2024'), '2024-01-05');
  assert.equal(isoDate('2024-01-05'), '2024-01-05');
  assert.equal(nseDate('2024-01-05'), '05-Jan-2024');
});

test('parses the niftyindices JSON reply', () => {
  const d = JSON.stringify([{ 'Index Name': 'Nifty 50', HistoricalDate: '20 Nov 2026', pe: '22.15', pb: '3.51', divYield: '1.24' }, { HistoricalDate: '19 Nov 2026', pe: '-' }]);
  assert.deepEqual(parseNseRows({ d }), [{ date: '2026-11-20', pe: 22.15, pb: 3.51, dy: 1.24 }]);
});

test('parses the downloadable CSV', () => {
  const csv = '﻿"Index Name","Date","P/E","P/B","Div Yield %"\n"Nifty 50","20 Nov 2026","22.15","3.51","1.24"\n"Nifty 50","19 Nov 2026","21.9","3.48","1.25"\n';
  const rows = parsePeCsv(csv);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { date: '2026-11-20', pe: 22.15, pb: 3.51, dy: 1.24 });
});

test('merge sorts and overwrites same day', () => {
  const a = mergeSeries(null, [{ date: '2024-01-02', pe: 20 }, { date: '2024-01-01', pe: 19 }]);
  const b = mergeSeries(a, [{ date: '2024-01-02', pe: 21 }, { date: '2024-01-03', pe: 22 }]);
  assert.deepEqual(b.dates, ['2024-01-01', '2024-01-02', '2024-01-03']);
  assert.deepEqual(b.pe, [19, 21, 22]);
});

test('median, quartiles and percentile', () => {
  const rows = []; for (let i = 0; i < 101; i++) rows.push({ date: new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10), pe: 10 + i * 0.1 });
  const s = mergeSeries(null, rows);
  const w = windowStats(s, '0000', 15);
  assert.equal(w.median, 15);
  assert.equal(w.q1, 12.5);
  assert.equal(w.percentile, 50);
  assert.deepEqual(zone(20, w), ['neg', 'expensive vs its history']);
  assert.deepEqual(zone(11, w), ['pos', 'cheap vs its history']);
  const sum = valuationSummary(s);
  assert.equal(sum.pe, 20);
  assert.ok(sum.windows.some((x) => x.key === 'all'));
});

test('year chunks cover the range', () => {
  assert.deepEqual(yearChunks('2024-11-01', '2026-02-03'), [['2024-11-01', '2024-12-31'], ['2025-01-01', '2025-12-31'], ['2026-01-01', '2026-02-03']]);
});
