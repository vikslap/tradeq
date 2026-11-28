import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capitalState, capitalEvents, quarterOf, quarterRange, fyLabel, cleanSweeps } from '../public/capital.js';
import { computeGame } from '../public/game.js';
import { updateSettings, load } from '../lib/store.js';

const trade = (o = {}) => ({
  id: o.id || 'a', symbol: 'ITC', exchange: 'NSE', segment: 'EQ', side: 'LONG', qty: 100, entryPrice: 400, charges: 0,
  horizon: 'SWING', entryTime: '2026-10-01T05:00:00.000Z', status: 'CLOSED', exitPrice: 500, exitTime: '2026-10-20T05:00:00.000Z', ...o,
});
const settings = (o = {}) => ({ capital: 150000, capitalSince: '2026-10-01', killSwitchPct: 80, sweeps: [], ...o });

test('quarters follow the Indian financial year', () => {
  assert.equal(fyLabel('2026-11-28'), 'FY26-27');
  assert.equal(fyLabel('2027-02-01'), 'FY26-27');
  assert.equal(quarterOf('2026-04-01'), 'FY26-27 Q1');
  assert.equal(quarterOf('2026-11-28'), 'FY26-27 Q3');
  assert.equal(quarterOf('2027-03-31'), 'FY26-27 Q4');
  assert.deepEqual(quarterRange('2026-11-28'), ['2026-10-01', '2026-12-31']);
  assert.deepEqual(quarterRange('2027-02-10'), ['2027-01-01', '2027-03-31']);
});

test('not set up without a start date', () => {
  assert.equal(capitalState({ trades: [], settings: { capital: 150000 } }).ready, false);
});

test('booked profit above the base is sweepable after the STCG reserve', () => {
  const c = capitalState({ trades: [trade()], settings: settings(), today: '2026-11-28', openPnl: 0 });
  assert.equal(c.booked, 10000);
  assert.equal(c.equity, 160000);
  assert.equal(c.tax.stcg, 10000);
  assert.equal(c.taxReserve, 2000);
  assert.equal(c.sweepable, 8000);
  assert.equal(c.breached, false);
});

test('sweeps reduce equity and are not losses; long-term holdings and old trades are ignored', () => {
  const trades = [trade(), trade({ id: 'lt', horizon: 'LONGTERM', exitPrice: 900 }), trade({ id: 'old', entryTime: '2026-08-01T05:00:00.000Z', exitTime: '2026-09-01T05:00:00.000Z' })];
  const c = capitalState({ trades, settings: settings({ sweeps: [{ id: 's1', date: '2026-11-01', amount: 5000 }] }), today: '2026-11-28', openPnl: 0 });
  assert.equal(c.booked, 10000);
  assert.equal(c.swept, 5000);
  assert.equal(c.equity, 155000);
  assert.equal(c.quarter.swept, 5000);
  assert.equal(c.sweepable, 3000); // 10000 − 5000 swept − 2000 tax
});

test('open losses cap the sweep so equity never drops below the base', () => {
  const c = capitalState({ trades: [trade()], settings: settings(), today: '2026-11-28', openPnl: -7000 });
  assert.equal(c.equity, 153000);
  assert.equal(c.sweepable, 3000);
});

test('kill switch trips at the floor', () => {
  const c = capitalState({ trades: [trade({ exitPrice: 100 })], settings: settings(), today: '2026-11-28', openPnl: 0 });
  assert.equal(c.equity, 120000);
  assert.equal(c.floor, 120000);
  assert.equal(c.breached, true);
  assert.equal(c.sweepable, 0);
});

test('intraday and F&O are kept out of the STCG estimate', () => {
  const trades = [
    trade({ id: 'i', entryTime: '2026-10-05T04:00:00.000Z', exitTime: '2026-10-05T08:00:00.000Z' }),
    trade({ id: 'f', segment: 'FUT', exchange: 'NFO', symbol: 'NIFTY26DECFUT' }),
  ];
  const c = capitalState({ trades, settings: settings(), today: '2026-11-28', openPnl: 0 });
  assert.equal(c.tax.stcg, 0);
  assert.equal(c.tax.business, 20000);
});

test('game: +25 per sweep, −15 for a trade opened at or below the kill switch', () => {
  const trades = [
    trade({ id: 'loss', exitPrice: 100, exitTime: '2026-10-10T05:00:00.000Z' }),
    trade({ id: 'next', entryTime: '2026-10-15T05:00:00.000Z', status: 'OPEN', exitPrice: null, exitTime: null }),
  ];
  const ev = capitalEvents({ trades, settings: settings({ sweeps: [{ id: 's1', date: '2026-11-01', amount: 1000 }] }) });
  assert.deepEqual(ev.map((e) => [e.key, e.xp]).sort(), [['kill:next', -15], ['sweep:s1', 25]]);
  const g = computeGame({ trades: [], reviews: [], settings: settings({ sweeps: [{ id: 's1', date: '2026-11-01', amount: 1000 }] }) });
  assert.ok(g.events.some((e) => e.key === 'sweep:s1' && e.xp === 25));
});

test('sweeps are cleaned and settings saved by the store', () => {
  assert.deepEqual(cleanSweeps([{ id: 'x', date: '2026-11-01', amount: -5 }, { id: '', date: '2026-11-01', amount: 5 }, { id: 'y', date: '2026-11-02', amount: '7', note: 'fund' }]), [{ id: 'y', date: '2026-11-02', amount: 7, note: 'fund' }]);
  load({ settings: {}, trades: [] });
  const s = updateSettings({ capital: 150000, capitalSince: '2026-10-01', killSwitchPct: 75, sweeps: [{ id: 'a', date: '2026-11-01', amount: 2000 }] });
  assert.equal(s.capitalSince, '2026-10-01');
  assert.equal(s.killSwitchPct, 75);
  assert.equal(s.sweeps.length, 1);
  assert.equal(updateSettings({ capitalSince: 'nonsense' }).capitalSince, null);
});
