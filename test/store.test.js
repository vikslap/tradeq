import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../lib/store.js';
import { init as initFileStore } from '../lib/store-file.js';

initFileStore(mkdtempSync(path.join(os.tmpdir(), 'tq-')));
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

test('options can close at 0 (expired worthless); stocks cannot', () => {
  const o = store.createTrade({ ...t0, symbol: 'NIFTY26N1723400CE', exchange: 'NFO', segment: 'OPT', entryPrice: 100, stopLoss: null });
  assert.equal(store.updateTrade(o.id, { status: 'CLOSED', exitPrice: 0, exitTime: '2026-11-17T10:00:00.000Z' }).status, 'CLOSED');
  const e = store.createTrade(t0);
  assert.throws(() => store.updateTrade(e.id, { status: 'CLOSED', exitPrice: 0, exitTime: '2026-11-17T10:00:00.000Z' }), /Exit price/);
});

test('tradebook import only removes imported trades, never journaled ones', () => {
  const mine = store.createTrade(t0);
  const imp = store.createTrade(t0); imp.imported = true;
  const res = store.importTradebook({ remove: [mine.id, imp.id] });
  assert.equal(res.removed, 1);
  assert.ok(store.getState().trades.some((t) => t.id === mine.id));
});

test('groups: link, relink moves a leg, unlink prunes groups under 2 legs', () => {
  const a = store.createTrade(t0); const b = store.createTrade(t0); const c = store.createTrade(t0);
  const g1 = store.createGroup({ tradeIds: [a.id, b.id], name: 'Pair' });
  assert.equal(store.getState().trades.find((t) => t.id === a.id).groupId, g1.id);
  const g2 = store.createGroup({ tradeIds: [b.id, c.id] });    // b moves → g1 left with one leg → pruned
  assert.ok(!store.getState().groups.some((g) => g.id === g1.id));
  assert.equal(store.getState().trades.find((t) => t.id === a.id).groupId, undefined);
  store.unlinkTrade(c.id);                                    // g2 left with one leg → pruned
  assert.ok(!store.getState().groups.some((g) => g.id === g2.id));
  assert.throws(() => store.createGroup({ tradeIds: [a.id] }), /two trades/);
});

test('partial exits: book part, then close the rest; reopen clears exits', () => {
  const t = store.createTrade({ ...t0, qty: 100 });
  let u = store.updateTrade(t.id, { addExit: { qty: 40, price: 440, time: '2026-11-04T05:00:00.000Z' } });
  assert.equal(u.status, 'OPEN'); assert.equal(u.exits.length, 1);
  assert.throws(() => store.updateTrade(t.id, { addExit: { qty: 80, price: 450, time: '2026-11-05T05:00:00.000Z' } }), /more than/);
  u = store.updateTrade(t.id, { addExit: { price: 460, time: '2026-11-05T05:00:00.000Z' } }); // rest (60)
  assert.equal(u.status, 'CLOSED'); assert.equal(u.exitPrice, 452); assert.equal(u.exitTime, '2026-11-05T05:00:00.000Z');
  u = store.updateTrade(t.id, { status: 'OPEN' });
  assert.equal(u.exits.length, 0); assert.equal(u.exitPrice, null);
});

test('legacy close (status + exitPrice) still works and edits a single exit', () => {
  const t = store.createTrade(t0);
  store.updateTrade(t.id, { status: 'CLOSED', exitPrice: 410, exitTime: '2026-11-03T05:00:00.000Z' });
  const u = store.updateTrade(t.id, { status: 'CLOSED', exitPrice: 412, exitTime: '2026-11-03T05:00:00.000Z' });
  assert.equal(u.exits.length, 1); assert.equal(u.exitPrice, 412);
});

test('delete imported trades keeps manual ones; reset empties the journal', () => {
  const manual = store.createTrade({ symbol: 'KEEP', exchange: 'NSE', side: 'LONG', qty: 1, entryPrice: 100, entryTime: '2026-03-02T04:00:00Z' });
  store.importTradebook({ create: [{ symbol: 'IMP', exchange: 'NSE', side: 'LONG', qty: 1, entryPrice: 50, entryTime: '2026-03-02T04:00:00Z', fillIds: ['zz1'], exits: [] }] });
  assert.ok(store.getState().trades.some((t) => t.imported));
  store.deleteImported();
  assert.ok(!store.getState().trades.some((t) => t.imported));
  assert.ok(store.getState().trades.some((t) => t.id === manual.id));
  store.resetJournal();
  assert.equal(store.getState().trades.length, 0);
});

test('renameSymbol renames cash-equity trades and remembers the mapping', () => {
  const t = store.createTrade({ symbol: 'ACRYSIL', exchange: 'NSE', side: 'LONG', qty: 5, entryPrice: 500, entryTime: '2023-03-02T04:00:00Z' });
  const r = store.renameSymbol({ from: 'acrysil', to: 'carysil' });
  assert.equal(r.renamed, 1);
  assert.equal(store.getState().trades.find((x) => x.id === t.id).symbol, 'CARYSIL');
  assert.deepEqual(store.getState().settings.symbolRenames, [{ from: 'ACRYSIL', to: 'CARYSIL' }]);
  assert.throws(() => store.renameSymbol({ from: 'X', to: 'X' }));
});

test('importLedger skips entries already imported (overlapping files)', () => {
  const row = { date: '2025-04-23', particulars: 'Funds added using UPI', debit: 0, credit: 5000, balance: 5100 };
  const a = store.importLedger({ rows: [row, { ...row, date: '2025-04-24', balance: 5200 }] });
  assert.equal(a.added, 2);
  const b = store.importLedger({ rows: [row] });
  assert.equal(b.added, 0); assert.equal(b.skipped, 1);
  store.clearLedger();
  assert.equal(store.getState().ledger.length, 0);
});

test('bulkUpdate sets the type of several trades', () => {
  const a = store.createTrade({ symbol: 'AAA', exchange: 'NSE', side: 'LONG', qty: 1, entryPrice: 10, entryTime: '2026-01-02T04:00:00Z' });
  const b = store.createTrade({ symbol: 'BBB', exchange: 'NSE', side: 'LONG', qty: 1, entryPrice: 10, entryTime: '2026-01-02T04:00:00Z' });
  const r = store.bulkUpdate({ ids: [a.id, b.id], horizon: 'LONGTERM' });
  assert.equal(r.updated, 2);
  assert.ok(store.getState().trades.filter((t) => [a.id, b.id].includes(t.id)).every((t) => t.horizon === 'LONGTERM'));
  assert.throws(() => store.bulkUpdate({ ids: [a.id], horizon: 'NOPE' }));
});

test('one-time migration: imported trades held over a year become Long-term', () => {
  const st = store.load({ trades: [
    { id: 'm1', symbol: 'OLD', exchange: 'NSE', side: 'LONG', qty: 1, entryPrice: 10, entryTime: '2022-01-03T04:00:00Z', status: 'CLOSED', exitPrice: 12, exitTime: '2024-01-03T04:00:00Z', horizon: 'POSITIONAL', imported: true },
    { id: 'm2', symbol: 'MAN', exchange: 'NSE', side: 'LONG', qty: 1, entryPrice: 10, entryTime: '2022-01-03T04:00:00Z', status: 'CLOSED', exitPrice: 12, exitTime: '2024-01-03T04:00:00Z', horizon: 'POSITIONAL' },
  ] });
  assert.equal(st.trades.find((t) => t.id === 'm1').horizon, 'LONGTERM');
  assert.equal(st.trades.find((t) => t.id === 'm2').horizon, 'POSITIONAL'); // your own choice is kept
  assert.equal(st.migrations.longTermOverAYear.count, 1);
});
