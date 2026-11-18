import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metrics, entryChecks, exitChecks, computeGame, levelFor } from '../public/game.js';
import { computeStats } from '../public/stats.js';

const settings = { maxRiskPerTrade: 2000, maxTradesPerDay: 3, revengeWindowMins: 30, capital: 200000 };
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

const day = (h, d = 2) => `2026-11-0${d}T0${h}:00:00.000Z`;

test('averaging down a loser is caught', () => {
  const first = base({ id: 'f', entryTime: day(4) });
  const add = base({ id: 'g', entryPrice: 390, initialStop: 375, stopLoss: 375, qty: 50, entryTime: day(6) });
  const c = entryChecks(add, { settings, trades: [first, add], dayIndex: 2 });
  assert.equal(c.find((x) => x.id === 'averageDown').xp, -15);
});

test('chasing past the planned trigger is caught; entering at it earns XP', () => {
  const chased = entryChecks(base({ plannedEntry: 390 }), { settings, trades: [], dayIndex: 1 });
  assert.equal(chased.find((x) => x.id === 'chase').xp, -10);
  const ok = entryChecks(base({ plannedEntry: 399 }), { settings, trades: [], dayIndex: 1 });
  assert.equal(ok.find((x) => x.id === 'chase').xp, 5);
});

test('impulse, concentration, daily loss limit, portfolio heat', () => {
  const s = { ...settings, maxDailyLoss: 3000, maxPortfolioHeatPct: 1.5 };
  const impulse = entryChecks(base({ thesis: '', setup: '' }), { settings: s, trades: [], dayIndex: 1 });
  assert.equal(impulse.find((x) => x.id === 'impulse').xp, -10);
  const big = entryChecks(base({ qty: 100, entryPrice: 400, initialStop: 395 }), { settings: { ...s, capital: 100000, maxPositionPct: 20 }, trades: [], dayIndex: 1 });
  assert.equal(big.find((x) => x.id === 'concentration').xp, -10); // ₹40k of ₹1L
  const bigLoss = base({ id: 'L', qty: 200, status: 'CLOSED', exitPrice: 380, exitTime: day(5) });
  const after = base({ id: 'A', entryTime: day(8) });
  assert.equal(entryChecks(after, { settings: s, trades: [bigLoss, after], dayIndex: 2 }).find((x) => x.id === 'dailyLoss').xp, -15);
  const o1 = base({ id: 'o1', symbol: 'TCS', entryTime: day(3) });
  const nw = base({ id: 'nw', entryTime: day(7) });
  assert.equal(entryChecks(nw, { settings: s, trades: [o1, nw], dayIndex: 2 }).find((x) => x.id === 'heat').xp, -10);
});

test('sizing up after two losses = tilt', () => {
  const l1 = base({ id: 'l1', entryTime: day(1), status: 'CLOSED', exitPrice: 380, exitTime: day(2) });
  const l2 = base({ id: 'l2', entryTime: day(3), status: 'CLOSED', exitPrice: 380, exitTime: day(4) });
  const big = base({ id: 'b', qty: 200, entryTime: '2026-11-03T05:00:00.000Z' });
  assert.equal(entryChecks(big, { settings, trades: [l1, l2, big], dayIndex: 1 }).find((x) => x.id === 'sizeUp').xp, -15);
});

test('winner turned loser, cut short, self-reported mistakes', () => {
  const gave = exitChecks(base({ status: 'CLOSED', exitPrice: 395, exitTime: day(9), mfePrice: 425 }));
  assert.equal(gave.find((x) => x.id === 'gaveBack').xp, -15);
  const cut = exitChecks(base({ status: 'CLOSED', exitPrice: 405, exitTime: day(9), exitReason: 'Discretionary' }));
  assert.equal(cut.find((x) => x.id === 'cutEarly').xp, -10);
  const self = exitChecks(base({ status: 'CLOSED', exitPrice: 420, exitTime: day(9), mistakes: ['chased', 'news'] }));
  assert.equal(self.filter((x) => x.self).length, 2);
});

test('multiple mistakes stack, and repeats cost extra', () => {
  const sloppy = (id, h) => base({ id, thesis: '', setup: '', target: null, stopLoss: null, initialStop: null, stopSetAtEntry: false, entryTime: `2026-11-0${h}T05:00:00.000Z` });
  const g = computeGame({ trades: [sloppy('s1', 3), sloppy('s2', 4)], reviews: [], settings });
  const p2 = g.perTrade.s2.penalties;
  assert.ok(p2.find((x) => x.id === 'stack').xp <= -10);
  assert.ok(p2.some((x) => x.id.startsWith('repeat:')));
});

test('long-term investments use investing rules and stay out of trading stats/discipline', () => {
  const lt = base({ id: 'lt', horizon: 'LONGTERM', stopLoss: null, initialStop: null, stopSetAtEntry: false, target: null, setup: '',
    sellCondition: 'Sell if margins fall two years running', entryTime: '2026-01-05T05:00:00.000Z' });
  const c = entryChecks(lt, { settings, trades: [lt], dayIndex: 1 });
  assert.equal(c.find((x) => x.id === 'stop'), undefined);
  assert.equal(c.reduce((s, x) => s + x.xp, 0), 35); // logged 10 + thesis 15 + sell condition 10
  const sold = { ...lt, status: 'CLOSED', exitPrice: 500, exitTime: '2026-10-01T05:00:00.000Z' };
  assert.equal(exitChecks(sold).find((x) => x.id === 'sellNoReason').xp, -10);
  const g = computeGame({ trades: [sold], reviews: [], settings });
  assert.equal(g.discipline, null);           // no trading trades → no score
  assert.equal(g.streak.current, 0);
});

test('thesis reviews earn XP at most every 60 days; overdue costs XP', () => {
  const now = Date.now(); const d = (n) => new Date(now - n * 86400000).toISOString();
  const t = base({ id: 'x', horizon: 'LONGTERM', stopLoss: null, initialStop: null, stopSetAtEntry: false, entryTime: d(400), sellCondition: 'Sell if thesis breaks badly',
    thesisReviews: [{ id: 'r1', at: d(350), note: 'ok', thesisIntact: true }, { id: 'r2', at: d(340), note: 'again', thesisIntact: true }, { id: 'r3', at: d(250), note: 'fine', thesisIntact: true }] });
  const g = computeGame({ trades: [t], reviews: [], settings });
  assert.equal(g.events.filter((e) => e.label.startsWith('Thesis review') && e.xp > 0).length, 2);
  assert.ok(g.events.some((e) => e.label === 'Thesis review overdue'));
  assert.ok(g.badges.find((b) => b.id === 'longgame').earned);
});

test('equity curve is daily: spread legs closed the same day net out (no fake drawdown)', () => {
  const leg = (id, side, entry, exit, hour) => base({ id, symbol: id, side, qty: 65, entryPrice: entry, initialStop: null, stopLoss: null,
    entryTime: '2026-10-23T05:00:00.000Z', status: 'CLOSED', exitPrice: exit, exitTime: `2026-11-10T0${hour}:00:00.000Z` });
  const s = computeStats([leg('short', 'SHORT', 126, 1918.3, 4), leg('long', 'LONG', 103.9, 1805.3, 5)]);
  assert.equal(s.curve.length, 2);               // zero point + one day
  assert.ok(Math.abs(s.curve[1].v - (1701.4 - 1792.3) * 65) < 1e-6);
  assert.ok(s.maxDD < 6000);                     // not the ~₹1.16L intra-day sequence
});

test('backdated long-term holdings are not instantly overdue; CAGR/XIRR wait a year', async () => {
  const { reviewStatus } = await import('../public/game.js');
  const { investmentStats } = await import('../public/stats.js');
  const now = Date.now(); const d = (n) => new Date(now - n * 86400000).toISOString();
  const t = { id: 'g', horizon: 'LONGTERM', symbol: 'ITC', qty: 70, entryPrice: 280.9, entryTime: d(170), createdAt: d(1), status: 'OPEN', side: 'LONG' };
  assert.equal(reviewStatus(t).overdue, false);
  const short = { ...t, id: 'gw', entryTime: d(49), entryPrice: 183.14, qty: 50 };
  const inv = investmentStats([short, { ...t, id: 'gs', symbol: '725GS2063', qty: 500, entryPrice: 95.88 }], (x) => (x.id === 'gw' ? 228.75 : null), now);
  assert.equal(inv.holdings[0].cagr, null);        // 49 days: no annualising
  assert.equal(inv.xirr, null);                    // < 1 year of history
  assert.equal(inv.unpriced, 1);
  assert.ok(Math.abs(inv.value - (228.75 * 50 + 95.88 * 500)) < 1e-6); // unpriced counted at cost
});

test('linked legs count as one unit in stats (best trade, win rate, curve)', async () => {
  const { computeStats } = await import('../public/stats.js');
  const leg = (id, side, entry, exit, day) => base({ id, symbol: id, side, qty: 65, entryPrice: entry, initialStop: null, stopLoss: null, groupId: 'G',
    entryTime: '2026-10-23T05:00:00.000Z', status: 'CLOSED', exitPrice: exit, exitTime: `2026-11-${day}T05:00:00.000Z` });
  const legs = [leg('L', 'LONG', 103.9, 1805.3, 10), leg('S', 'SHORT', 126, 1918.3, 12)];
  const other = base({ id: 'o', status: 'CLOSED', exitPrice: 420, exitTime: '2026-11-05T05:00:00.000Z' });
  const st = computeStats([...legs, other], [{ id: 'G', name: 'NIFTY spread' }]);
  assert.equal(st.count, 2);
  assert.equal(st.best.t.id, 'o');                 // the +₹1.1L long leg no longer wins "best trade"
  assert.equal(st.worst.t.symbol, 'NIFTY spread');
  assert.ok(Math.abs(st.worst.m.net - ((1805.3 - 103.9) - (1918.3 - 126)) * 65) < 1e-6);
  assert.ok(st.maxDD < 6000);                      // booked on the last leg's day, no ₹1L+ swing
  const open = computeStats([legs[0], { ...legs[1], status: 'OPEN', exitPrice: null, exitTime: null }], [{ id: 'G', name: 'x' }]);
  assert.equal(open.count, 0);                     // half-closed group stays out of closed stats
});
