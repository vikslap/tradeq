import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTradebook, buildTrips, planImport } from '../public/tradebook.js';
import { computeGame } from '../public/game.js';

const HEAD = 'symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time';
const row = (sym, date, side, qty, price, id, time = '10:00:00', ex = 'NSE', seg = 'EQ') => `${sym},INE000,${date},${ex},${seg},EQ,${side},false,${qty},${price},${id},O${id},${date}T${time}`;
const csv = (...rows) => [HEAD, ...rows].join('\n');

test('parses Console CSV with IST times', () => {
  const f = parseTradebook(csv(row('ITC', '2026-03-12', 'buy', 100, 400, 1, '09:20:15')));
  assert.equal(f[0].side, 'BUY');
  assert.equal(f[0].time, '2026-03-12T03:50:15.000Z');
  assert.throws(() => parseTradebook('a,b,c\n1,2,3'), /tradebook/);
});

test('scale-in + full exit = one trade with weighted prices', () => {
  const { trips } = buildTrips(parseTradebook(csv(
    row('ITC', '2026-03-02', 'buy', 100, 400, 1), row('ITC', '2026-03-05', 'buy', 100, 410, 2), row('ITC', '2026-03-20', 'sell', 200, 450, 3))));
  assert.equal(trips.length, 1);
  assert.equal(trips[0].qty, 200);
  assert.equal(trips[0].entryPrice, 405);
  assert.equal(trips[0].status, 'CLOSED');
});

test('partial exit at end of file = one open trade with a partial exit', () => {
  const { trips } = buildTrips(parseTradebook(csv(row('TCS', '2026-03-02', 'buy', 10, 3000, 1), row('TCS', '2026-03-09', 'sell', 4, 3100, 2))));
  assert.equal(trips.length, 1);
  assert.equal(trips[0].status, 'OPEN'); assert.equal(trips[0].qty, 10);
  assert.deepEqual(trips[0].exits.map((e) => [e.qty, e.price]), [[4, 3100]]);
});

test('exit orders are kept separate; entry orders counted (for per-order brokerage)', () => {
  const { trips } = buildTrips(parseTradebook(csv(
    row('ITC', '2026-03-02', 'buy', 50, 400, 1), row('ITC', '2026-03-03', 'buy', 50, 410, 2),
    row('ITC', '2026-03-10', 'sell', 60, 450, 3), row('ITC', '2026-03-12', 'sell', 40, 460, 4))));
  assert.equal(trips[0].entryOrders, 2);
  assert.deepEqual(trips[0].exits.map((e) => e.qty), [60, 40]);
});

test('intraday equity short vs sale of shares bought earlier', () => {
  const { trips, orphans } = buildTrips(parseTradebook(csv(
    row('SBIN', '2026-03-02', 'sell', 50, 800, 1, '09:30:00'), row('SBIN', '2026-03-02', 'buy', 50, 790, 2, '14:00:00'),
    row('HDFCBANK', '2026-03-03', 'sell', 20, 1000, 3))));
  assert.equal(trips.length, 1);
  assert.equal(trips[0].side, 'SHORT');
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].symbol, 'HDFCBANK');
});

test('futures flip from long to short in one fill', () => {
  const { trips } = buildTrips(parseTradebook(csv(
    row('NIFTY26DECFUT', '2026-11-02', 'buy', 75, 25900, 1, '10:00:00', 'NFO', 'FO'),
    row('NIFTY26DECFUT', '2026-11-03', 'sell', 150, 26000, 2, '10:00:00', 'NFO', 'FO'))));
  assert.deepEqual(trips.map((t) => [t.side, t.status, t.qty]), [['LONG', 'CLOSED', 75], ['SHORT', 'OPEN', 75]]);
  assert.equal(trips[0].segment, 'FUT');
});

test('planImport: date fix, close sold trade, skip duplicate, new trades, re-import is a no-op', () => {
  const j = [
    { id: 'a', symbol: 'ITC', exchange: 'NSE', side: 'LONG', qty: 100, entryPrice: 405, entryTime: '2026-11-18T04:00:00.000Z', status: 'OPEN' },
    { id: 'b', symbol: 'HDFCBANK', exchange: 'NSE', side: 'LONG', qty: 20, entryPrice: 950, entryTime: '2026-11-18T04:00:00.000Z', status: 'OPEN' },
    { id: 'c', symbol: 'TCS', exchange: 'NSE', side: 'LONG', qty: 5, entryPrice: 3000, entryTime: '2026-03-02T04:30:00.000Z', status: 'CLOSED', exitPrice: 3100, exitTime: '2026-03-09T04:30:00.000Z' },
  ];
  const fills = parseTradebook(csv(
    row('ITC', '2026-06-01', 'buy', 100, 404.5, 1),
    row('HDFCBANK', '2026-07-01', 'sell', 20, 1010, 2),
    row('TCS', '2026-03-02', 'buy', 5, 3000, 3), row('TCS', '2026-03-09', 'sell', 5, 3100, 4),
    row('INFY', '2026-04-01', 'buy', 10, 1500, 5), row('INFY', '2026-04-01', 'sell', 10, 1520, 6, '15:00:00')));
  const p = planImport(j, fills);
  assert.equal(p.dateFixes.length, 1);
  assert.equal(p.dateFixes[0].trade.id, 'a');
  assert.equal(p.closes.length, 1);
  assert.equal(p.closes[0].trade.id, 'b');
  assert.equal(p.dupes.length, 1);
  assert.equal(p.newTrades.length, 1);
  assert.equal(p.newTrades[0].horizon, 'INTRADAY');
  const after = [...j, { id: 'n', symbol: 'INFY', exchange: 'NSE', status: 'CLOSED', fillIds: ['5', '6'] }];
  after[0] = { ...after[0], fillIds: ['1'] };
  after[1] = { ...after[1], fillIds: ['2'] };
  const again = planImport(after, fills);
  assert.equal(again.alreadyImported, 4);
  assert.equal(again.newTrades.length, 0);
});

test('imported trades never earn or lose XP', () => {
  const t = { id: 'i', imported: true, symbol: 'X', exchange: 'NSE', segment: 'EQ', side: 'LONG', qty: 999, entryPrice: 100, entryTime: '2026-03-02T04:30:00.000Z', status: 'CLOSED', exitPrice: 50, exitTime: '2026-03-09T04:30:00.000Z', horizon: 'SWING' };
  const g = computeGame({ trades: [t], reviews: [], settings: {} });
  assert.equal(g.xp, 0);
  assert.equal(g.events.length, 0);
  assert.equal(g.discipline, null);
});

const FOHEAD = 'symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time,expiry_date';
const fo = (sym, date, side, qty, price, id, expiry) => `${sym},,${date},NSE,FO,,${side},false,${qty},${price},${id},O${id},${date}T10:00:00,${expiry}`;

test('Console F&O rows (exchange NSE, segment FO) import as NFO options, both legs of a spread', () => {
  const fills = parseTradebook([FOHEAD,
    fo('NIFTY26N1723400CE', '2026-10-23', 'buy', 65, 103.9, 1, '2026-11-17'),
    fo('NIFTY26N1723600CE', '2026-10-23', 'sell', 65, 60.2, 2, '2026-11-17'),
    fo('NIFTY26N1723400CE', '2026-11-10', 'sell', 65, 1805.3, 3, '2026-11-17'),
    fo('NIFTY26N1723600CE', '2026-11-10', 'buy', 65, 1620.1, 4, '2026-11-17')].join('\n'));
  assert.equal(fills[0].exchange, 'NFO');
  const p = planImport([], fills, '2026-11-18');
  assert.deepEqual(p.newTrades.map((t) => [t.symbol, t.side, t.segment, t.status]).sort(), [
    ['NIFTY26N1723400CE', 'LONG', 'OPT', 'CLOSED'], ['NIFTY26N1723600CE', 'SHORT', 'OPT', 'CLOSED']]);
  assert.equal(p.unmatched.length, 0);
});

test('options left open past expiry are proposed as expired at 0', () => {
  const fills = parseTradebook([FOHEAD, fo('BANKNIFTY26NOV58000PE', '2026-11-02', 'buy', 35, 210, 1, '2026-11-25')].join('\n'));
  assert.equal(planImport([], fills, '2026-11-20').newTrades[0].status, 'OPEN');
  const t = planImport([], fills, '2026-11-26').newTrades[0];
  assert.equal(t.expired, true);
  assert.equal(t.exitPrice, 0);
});

test('re-import repairs a short leg the old importer dropped (your 23300 CE case)', () => {
  const fills = parseTradebook([FOHEAD,
    fo('NIFTY26N1723300CE', '2026-10-23', 'sell', 65, 126, 'S1', '2026-11-17'),
    fo('NIFTY26N1723300CE', '2026-11-10', 'buy', 65, 1918.3, 'B1', '2026-11-17')].join('\n'));
  // What the buggy import left behind: an imported OPEN LONG built from the buy-back only (labelled NSE).
  const bogus = { id: 'bad', imported: true, symbol: 'NIFTY26N1723300CE', exchange: 'NSE', segment: 'EQ', side: 'LONG', qty: 65, entryPrice: 1918.3, entryTime: fills[1].time, status: 'OPEN', fillIds: ['B1'] };
  const p = planImport([bogus], fills, '2026-11-18');
  assert.equal(p.closes.length, 0);
  assert.equal(p.repairs.length, 1);
  assert.equal(p.repairs[0].replaces[0].id, 'bad');
  assert.deepEqual(p.repairs[0].trips.map((t) => [t.side, t.status, t.qty, t.entryPrice, t.exitPrice]), [['SHORT', 'CLOSED', 65, 126, 1918.3]]);
});

test('renamed company: old-symbol buy pairs with new-symbol sell', () => {
  const text = csv(row('ACRYSIL', '2023-03-02', 'buy', 10, 500, 1), row('CARYSIL', '2024-03-09', 'sell', 10, 700, 2));
  const before = buildTrips(parseTradebook(text)).trips;
  assert.ok(before.some((t) => t.symbol === 'ACRYSIL' && t.status === 'OPEN'));
  const { trips } = buildTrips(parseTradebook(text, [{ from: 'ACRYSIL', to: 'CARYSIL' }]));
  assert.deepEqual(trips.map((t) => [t.symbol, t.status, t.qty]), [['CARYSIL', 'CLOSED', 10]]);
});
