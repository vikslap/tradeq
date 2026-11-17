import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metrics, entryChecks, exitChecks, computeGame, levelFor } from '../public/game.js';
import { computeStats } from '../public/stats.js';

const settings = { maxRiskPerTrade: 2000, maxTradesPerDay: 3, revengeWindowMins: 30, capital: 100000 };
const base = (o = {}) => ({
  id: 'a', symbol: 'ITC', exchange: 'NSE', segment: 'EQ', side: 'LONG', qty: 100, entryPrice: 400,
  stopLoss: 380, initialStop: 380, stopSetAtEntry: true, target: 450, setup: 'Breakout',
  thesis: 'Range breakout on strong volume, sector flows positive', entryTime: '2026-11-02T05:00:00.000Z', status: 'OPEN', ...o,
});

test('metrics: R and risk for a long winner', () => {
  const m = metrics(base({ status: 'CLOSED', exitPrice: 440, exitTime: '2026-11-05T05:00:00.000Z', charges: 0 }));
  assert.equal(m.riskAmt, 2000);
  assert.equal(m.net, 4000);
  assert.equal(m.r, 2);
  assert.equal(m.plannedRR, 2.5);
});

test('metrics: short trade P&L sign', () => {
  const m = metrics(base({ side: 'SHORT', entryPrice: 400, initialStop: 410, stopLoss: 410, status: 'CLOSED', exitPrice: 380, exitTime: '2026-11-03T05:00:00.000Z' }));
  assert.equal(m.net, 2000);
  assert.equal(m.r, 2);
});

test('entry rules: perfect plan earns 60 XP', () => {
  const xp = entryChecks(base(), { settings, trades: [], dayIndex: 1 }).reduce((s, c) => s + c.xp, 0);
  assert.equal(xp, 60);
});

test('entry rules: no stop and oversized penalised', () => {
  const noStop = entryChecks(base({ stopLoss: null, initialStop: null, stopSetAtEntry: false }), { settings, trades: [], dayIndex: 1 });
  assert.equal(noStop.find((c) => c.id === 'stop').xp, -10);
  const big = entryChecks(base({ qty: 500 }), { settings, trades: [], dayIndex: 1 });
  assert.equal(big.find((c) => c.id === 'risk').xp, -20);
});

test('revenge entry detected within window after a loss', () => {
  const loss = base({ id: 'l', status: 'CLOSED', exitPrice: 380, exitTime: '2026-11-02T06:00:00.000Z' });
  const next = base({ id: 'n', entryTime: '2026-11-02T06:10:00.000Z' });
  const c = entryChecks(next, { settings, trades: [loss, next], dayIndex: 2 });
  assert.equal(c.find((x) => x.id === 'revenge').xp, -15);
});

test('exit rules: honoured stop vs loss that ran', () => {
  const ok = exitChecks(base({ status: 'CLOSED', exitPrice: 380, exitTime: '2026-11-03T05:00:00.000Z', followedPlan: true }));
  assert.equal(ok.find((c) => c.id === 'honour').xp, 15);
  const ran = exitChecks(base({ status: 'CLOSED', exitPrice: 360, exitTime: '2026-11-03T05:00:00.000Z', followedPlan: false }));
  assert.equal(ran.find((c) => c.id === 'honour').xp, -20);
});

test('computeGame: totals, badges, streaks, never negative', () => {
  const t = base({ status: 'CLOSED', exitPrice: 460, exitTime: '2026-11-10T05:00:00.000Z', exitReason: 'Target hit', followedPlan: true, lessons: 'Held to target as planned.' });
  const g = computeGame({ trades: [t], reviews: [], settings });
  assert.ok(g.xp > 100);
  assert.equal(g.streak.current, 1);
  assert.ok(g.badges.find((b) => b.id === 'first').earned);
  assert.ok(g.badges.find((b) => b.id === 'runner').earned); // 3R
  assert.equal(g.discipline, 100);
  const bad = computeGame({ trades: [base({ stopLoss: null, initialStop: null, stopSetAtEntry: false, thesis: '', setup: '', target: null })], reviews: [], settings });
  assert.ok(bad.xp >= 0);
});

test('levels progress', () => {
  assert.equal(levelFor(0).lvl, 1);
  assert.equal(levelFor(150).lvl, 2);
  assert.equal(levelFor(9000).title, 'Zen Trader');
  assert.equal(levelFor(12000).lvl, 11);
});

test('stats: drawdown and win rate', () => {
  const mk = (id, exit, day) => base({ id, status: 'CLOSED', exitPrice: exit, exitTime: `2026-11-0${day}T05:00:00.000Z` });
  const s = computeStats([mk('1', 420, 3), mk('2', 380, 4), mk('3', 390, 5)]);
  assert.equal(s.count, 3);
  assert.equal(s.maxDD, 3000);
  assert.ok(Math.abs(s.winRate - 1 / 3) < 1e-9);
});
