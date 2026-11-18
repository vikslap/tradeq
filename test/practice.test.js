import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepBar, tradeResult, scoreTrade, randomStart, practiceStats } from '../public/practice.js';

const pos = (o = {}) => ({ side: 'LONG', qty: 100, entryPrice: 100, stop: 95, initialStop: 95, target: 110, ...o });
const bar = (o, h, l, c) => [Date.parse('2026-03-02T03:45:00Z'), o, h, l, c, 1000];

test('stop hit intrabar fills at the stop', () => {
  const { closed } = stepBar(pos(), bar(99, 101, 94, 96), 5);
  assert.equal(closed.exitPrice, 95); assert.equal(closed.exitReason, 'Stop');
});

test('gap through the stop fills at the open (worse than the stop)', () => {
  const { closed } = stepBar(pos(), bar(90, 92, 88, 91), 5);
  assert.equal(closed.exitPrice, 90); assert.equal(closed.exitReason, 'Stop (gap)');
  assert.ok(tradeResult(closed).r < -1);
});

test('target hit; gap above target fills at the open (better)', () => {
  assert.equal(stepBar(pos(), bar(105, 111, 104, 109), 5).closed.exitPrice, 110);
  assert.equal(stepBar(pos(), bar(113, 115, 112, 114), 5).closed.exitPrice, 113);
});

test('bar touching both stop and target assumes the stop (conservative)', () => {
  assert.equal(stepBar(pos(), bar(100, 112, 94, 105), 5).closed.exitReason, 'Stop');
});

test('shorts mirror; manual exit fills at the open; no hit keeps the position', () => {
  const s = pos({ side: 'SHORT', stop: 105, initialStop: 105, target: 90 });
  assert.equal(stepBar(s, bar(101, 106, 100, 104), 5).closed.exitPrice, 105);
  assert.equal(stepBar(pos(), bar(101, 103, 99, 102), 5, { pendingExit: true }).closed.exitPrice, 101);
  assert.equal(stepBar(pos(), bar(101, 103, 99, 102), 5).closed, null);
});

test('scoring rewards the same habits as the journal', () => {
  const win3 = { ...pos(), exitPrice: 116 };
  assert.equal(tradeResult(win3).r, 3.2);
  const xp = scoreTrade(win3, 2000).reduce((a, b) => a + b.xp, 0);
  assert.equal(xp, 10 + 3 + 5 + 15); // stop, target, risk within limit, 3R+
  const sloppy = { ...pos({ stop: null, initialStop: null, target: null }), exitPrice: 90 };
  assert.ok(scoreTrade(sloppy, 2000).reduce((a, b) => a + b.xp, 0) < 0);
});

test('random start is a past weekday with room for the future', () => {
  for (const iv of ['day', '60minute', '15minute', '5minute']) {
    const d = new Date(randomStart(iv, Date.parse('2026-11-18T12:00:00Z'), () => 0.5));
    assert.ok(d.getDay() !== 0 && d.getDay() !== 6);
    assert.ok(d < new Date('2026-11-01'));
  }
});

test('practice stats aggregate across sessions', () => {
  const s = { status: 'done', startIndex: 10, cursor: 60, risk: 2000, trades: [{ ...pos(), exitPrice: 110 }, { ...pos(), exitPrice: 95 }] };
  const st = practiceStats([s], 2000);
  assert.equal(st.trades, 2); assert.equal(st.wins, 1); assert.equal(st.totalR, 1);
  assert.ok(st.xp > 0);
});
