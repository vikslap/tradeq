import test from 'node:test';
import assert from 'node:assert/strict';
import { alignBench, rsLine, rsReadout, addStockToBreadth, finishBreadth, breadthOn, intradayBreadth } from '../public/market.js';

const D = 86400000;
const day = (i) => Date.UTC(2026, 0, 1) + i * D - 330 * 60000; // midnight IST
const bars = (closes) => closes.map((c, i) => [day(i), c, c, c, c, 0]);

test('relative strength: outperforming the index shows up', () => {
  const stock = bars(Array.from({ length: 60 }, (_, i) => 100 + i)); // +59%
  const nifty = bars(Array.from({ length: 60 }, (_, i) => 1000 + i)); // +5.9%
  const rs = rsLine(stock, nifty);
  assert.equal(rs[0], 100);
  assert.ok(rs[59] > rs[0]);
  const r = rsReadout(stock, nifty, 59, 20);
  assert.ok(r.stockPct > r.benchPct && r.edge > 0);
  assert.ok(r.atHigh);
});

test('bench aligns to the latest bar at or before each stock bar', () => {
  const stock = bars([1, 2, 3]);
  const nifty = [[day(0), 0, 0, 0, 10, 0], [day(2), 0, 0, 0, 30, 0]];
  assert.deepEqual(alignBench(stock, nifty), [10, 10, 30]);
});

test('daily breadth tallies advances, declines and moving-average counts', () => {
  const days = {};
  const mk = (arr) => arr.map((c, i) => [`2026-01-${String(i + 1).padStart(2, '0')}`, c]);
  addStockToBreadth(days, mk([10, 11, 12]));
  addStockToBreadth(days, mk([10, 9, 9]));
  const b = finishBreadth(days);
  assert.deepEqual(b.dates, ['2026-01-01', '2026-01-02', '2026-01-03']);
  assert.deepEqual([b.adv[1], b.dec[1]], [1, 1]);
  assert.deepEqual([b.adv[2], b.dec[2], b.unch[2]], [1, 0, 1]);
  const x = breadthOn(b, '2026-01-03'); assert.equal(x.adv, 1);
  const p = breadthOn(b, '2026-01-03', { before: true }); assert.equal(p.date, '2026-01-02');
  assert.equal(breadthOn(b, '2026-03-01'), null); // far outside the data
});

test('intraday breadth compares each bar with the previous day close', () => {
  const H = 3600000;
  const d0 = Date.UTC(2026, 0, 5, 4); const d1 = d0 + D;
  const up = [[d0, 0, 0, 0, 100, 0], [d1, 0, 0, 0, 101, 0], [d1 + H, 0, 0, 0, 99, 0]];
  const dn = [[d0, 0, 0, 0, 50, 0], [d1, 0, 0, 0, 49, 0], [d1 + H, 0, 0, 0, 49, 0]];
  const m = intradayBreadth({ A: up, B: dn }, [d1, d1 + H]);
  assert.deepEqual(m.get(d1), { adv: 1, dec: 1, n: 2 });
  assert.deepEqual(m.get(d1 + H), { adv: 0, dec: 2, n: 2 });
});

test('rolling breadth measures: A/D line, 10-day net, McClellan, % above averages', async () => {
  const { breadthMeasures, breadthValue } = await import('../public/market.js');
  const dates = Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10));
  const b = { dates, adv: dates.map(() => 300), dec: dates.map(() => 200), unch: dates.map(() => 0), a50: dates.map(() => 250), n50: dates.map(() => 500), a200: dates.map(() => 0), n200: dates.map(() => 0) };
  const m = breadthMeasures(b);
  assert.equal(m.adline[59], 100 * 60);
  assert.equal(m.net10[8], null); assert.equal(m.net10[9], 100);
  assert.ok(Math.abs(m.mcclellan[50]) < 1e-9); // steady breadth → oscillator flat at 0
  assert.equal(breadthValue(b, 'pct50', dates[10]), 50);
  assert.equal(breadthValue(b, 'pct200', dates[10]), null);
});

test('live breadth from quotes + stored tails, and appending the day after the close', async () => {
  const { liveBreadth, appendToday } = await import('../public/market.js');
  const tails = { asOf: '2026-11-20', closes: { UP: Array(199).fill(100), DOWN: Array(199).fill(100), SHORT: Array(10).fill(50) } };
  const quotes = { 'NSE:UP': { last: 110, prevClose: 100 }, 'NSE:DOWN': { last: 90, prevClose: 100 }, 'NSE:SHORT': { last: 50, prevClose: 50 } };
  const dates = Array.from({ length: 50 }, (_, i) => new Date(Date.UTC(2026, 8, 1) + i * 86400000).toISOString().slice(0, 10));
  const history = { dates, adv: dates.map(() => 2), dec: dates.map(() => 1), unch: dates.map(() => 0), a50: dates.map(() => 1), n50: dates.map(() => 2), a200: dates.map(() => 1), n200: dates.map(() => 2) };
  const L = liveBreadth(history, tails, quotes, '2026-11-21');
  assert.deepEqual([L.adv, L.dec, L.unch, L.n], [1, 1, 1, 3]);
  assert.equal(L.pct50, 50); assert.equal(L.pct200, 50); // UP above both averages, DOWN below; SHORT too new
  assert.ok(L.mcclellan < 0); // today's net (0) is below the steady +1
  const next = appendToday(history, tails, L, '2026-11-21');
  assert.equal(next.history.dates.at(-1), '2026-11-21');
  assert.equal(next.tails.closes.UP.at(-1), 110); assert.equal(next.tails.closes.UP.length, 200);
  assert.equal(appendToday(next.history, next.tails, L, '2026-11-21'), null); // not twice
});

import { subsetHistory, subsetTails, swings } from '../public/market.js';

test('subset breadth from tails', () => {
  const dates = Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10));
  const up = Array.from({ length: 60 }, (_, i) => 100 + i); const dn = Array.from({ length: 60 }, (_, i) => 200 - i);
  const tails = { asOf: dates.at(-1), closes: { A: up, B: dn, C: up.slice(-10), X: up } };
  const h = subsetHistory({ dates }, tails, ['A', 'B', 'C']);
  assert.equal(h.dates.length, 59); assert.equal(h.dates.at(-1), dates.at(-1));
  assert.equal(h.adv.at(-1), 2); assert.equal(h.dec.at(-1), 1);
  assert.equal(h.n50.at(-1), 2); assert.equal(h.a50.at(-1), 1); // C too short for a 50-DMA
  assert.equal(h.adv[0], 1); // only A and B exist then; C starts later
  assert.deepEqual(Object.keys(subsetTails(tails, ['A', 'Z']).closes), ['A']);
});

test('swings find alternating peaks and troughs plus the day high/low', () => {
  const v = [100, 101, 102, 101, 100.5, 101.5, 103, 102, 100, 99, 99.5, 100.6];
  const s = swings(v.map((p, i) => [i, p]), 1);
  assert.deepEqual(s.map((x) => [x.i, x.type, !!x.extreme]), [[4, 'trough', false], [6, 'peak', true], [9, 'trough', true]]);
});

import { squarify, heatColor, groupSectors } from '../public/heatmap.js';

test('squarify fills the box exactly, keeps order and proportions', () => {
  const v = [6, 6, 4, 3, 2, 2, 1];
  const r = squarify(v, 0, 0, 600, 400);
  const area = r.reduce((s, x) => s + x.w * x.h, 0);
  assert.ok(Math.abs(area - 240000) < 1e-6);
  r.forEach((x, i) => { assert.ok(Math.abs((x.w * x.h) / 240000 - v[i] / 24) < 1e-9); assert.ok(x.x >= -1e-9 && x.y >= -1e-9 && x.x + x.w <= 600 + 1e-6 && x.y + x.h <= 400 + 1e-6); });
  // no overlaps
  for (let a = 0; a < r.length; a++) for (let b = a + 1; b < r.length; b++) {
    const A = r[a]; const B = r[b];
    const ov = Math.max(0, Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x)) * Math.max(0, Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y));
    assert.ok(ov < 1e-6, `${a} overlaps ${b}`);
  }
});

test('heat colours and sector groups', () => {
  assert.equal(heatColor(0), 'rgb(90,98,112)');
  assert.equal(heatColor(5), 'rgb(22,163,74)');
  assert.equal(heatColor(-3), 'rgb(220,38,38)');
  const g = groupSectors([{ sym: 'A', pct: 2, value: 3, sector: 'IT' }, { sym: 'B', pct: -1, value: 1, sector: 'IT' }, { sym: 'C', pct: 1, value: 1, sector: 'Banks' }]);
  assert.equal(g[0].name, 'IT'); assert.equal(g[0].pct, 1.25); assert.equal(g[0].up, 1); assert.equal(g[0].down, 1);
});

import { currentContract } from '../public/instruments.js';
test('current futures contract rolls two days before expiry', () => {
  const L = [{ n: 'GOLD', t: 'FUT', x: '2026-12-04', s: 'GOLD26DECFUT' }, { n: 'GOLD', t: 'FUT', x: '2027-02-05', s: 'GOLD27FEBFUT' }, { n: 'GOLDM', t: 'FUT', x: '2026-12-01', s: 'GOLDM' }, { n: 'GOLD', t: 'FUT', x: '2026-10-05', s: 'OLD' }];
  assert.equal(currentContract(L, 'GOLD', '2026-11-28').s, 'GOLD26DECFUT');
  assert.equal(currentContract(L, 'GOLD', '2026-12-03').s, 'GOLD27FEBFUT');
  assert.equal(currentContract(L, 'CRUDEOIL', '2026-12-03'), null);
});
