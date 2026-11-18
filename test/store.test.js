import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../lib/store.js';

store.init(mkdtempSync(path.join(os.tmpdir(), 'tq-')));
const t0 = { symbol: 'itc', side: 'LONG', qty: 100, entryPrice: 400, stopLoss: 380, entryTime: '2026-11-02T05:00:00.000Z' };

test('create normalises and records initial stop', () => {
  const t = store.createTrade(t0);
  assert.equal(t.symbol, 'ITC');
  assert.equal(t.initialStop, 380);
  assert.equal(t.stopSetAtEntry, true);
});

test('rejects stop on the wrong side of entry', () => {
  assert.throws(() => store.createTrade({ ...t0, stopLoss: 420 }), /below entry/);
});

test('widening a stop is counted, trailing is not', () => {
  const t = store.createTrade(t0);
  store.updateTrade(t.id, { stopLoss: 370 });
  assert.equal(store.getState().trades.find((x) => x.id === t.id).stopWidenCount, 1);
  store.updateTrade(t.id, { stopLoss: 410 });
  const after = store.getState().trades.find((x) => x.id === t.id);
  assert.equal(after.stopWidenCount, 1);
  assert.equal(after.initialStop, 380);
});

test('correction changes the initial stop without penalty', () => {
  const t = store.createTrade(t0);
  store.updateTrade(t.id, { stopLoss: 385, correction: true });
  const after = store.getState().trades.find((x) => x.id === t.id);
  assert.equal(after.initialStop, 385);
  assert.equal(after.stopWidenCount, 0);
});

test('closing requires exit price and time after entry', () => {
  const t = store.createTrade(t0);
  assert.throws(() => store.updateTrade(t.id, { status: 'CLOSED' }), /Exit price/);
  assert.throws(() => store.updateTrade(t.id, { status: 'CLOSED', exitPrice: 410, exitTime: '2026-11-01T05:00:00.000Z' }), /before entry/);
  const c = store.updateTrade(t.id, { status: 'CLOSED', exitPrice: 410, exitTime: '2026-11-03T05:00:00.000Z', followedPlan: true });
  assert.equal(c.status, 'CLOSED');
});

test('existing trades get a type from holding period', async () => {
  const { guessHorizon } = await import('../lib/store.js');
  const now = Date.parse('2026-11-18T05:00:00Z');
  assert.equal(guessHorizon({ status: 'CLOSED', entryTime: '2026-11-10T04:00:00Z', exitTime: '2026-11-10T08:00:00Z' }, now), 'INTRADAY');
  assert.equal(guessHorizon({ status: 'CLOSED', entryTime: '2026-11-01T04:00:00Z', exitTime: '2026-11-10T08:00:00Z' }, now), 'SWING');
  assert.equal(guessHorizon({ status: 'OPEN', entryTime: '2026-09-01T04:00:00Z' }, now), 'POSITIONAL');
});

test('thesis reviews are stored and validated', () => {
  const t = store.createTrade({ ...t0, horizon: 'LONGTERM', stopLoss: null });
  assert.throws(() => store.addThesisReview(t.id, { note: 'short' }), /sentence/);
  const after = store.addThesisReview(t.id, { note: 'Results in line, thesis intact.', thesisIntact: true });
  assert.equal(after.thesisReviews.length, 1);
  assert.equal(after.horizon, 'LONGTERM');
});
