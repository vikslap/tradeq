import test from 'node:test';
import assert from 'node:assert/strict';
import { _internal } from '../worker/index.js';
import { parseExchange, searchInstruments } from '../public/instruments.js';

const { explode, implode, chunk } = _internal;
const rows = (m) => [...m].map(([id, d]) => ({ id, ...d }));

test('journal survives the trip into per-record rows and back, in order', () => {
  const s = { version: 1, settings: { capital: 5 }, trades: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], reviews: [], groups: [{ id: 'g' }], ledger: [{ id: 'l1', date: '2026-01-01' }], practice: { sessions: [{ id: 'p1' }] } };
  const m = explode(s, new Map());
  assert.deepEqual(implode(rows(m)), s);
});

test('appends, newest-first inserts and deletes keep order without rewriting other rows', () => {
  const s = { version: 1, settings: {}, trades: [{ id: 'a' }, { id: 'b' }], reviews: [], groups: [], ledger: [], practice: { sessions: [{ id: 'p1' }, { id: 'p2' }] } };
  const m1 = explode(s, new Map());
  const s2 = { ...s, trades: [{ id: 'b' }, { id: 'c' }], practice: { sessions: [{ id: 'p0' }, { id: 'p1' }, { id: 'p2' }] } };
  const m2 = explode(s2, m1);
  assert.equal(m2.get('trades/b').seq, m1.get('trades/b').seq);
  assert.equal(m2.get('practice/p1').seq, m1.get('practice/p1').seq);
  assert.deepEqual(implode(rows(m2)), s2);
});

test('writes are chunked by size', () => {
  const big = Array.from({ length: 10 }, (_, i) => ({ id: String(i), body: 'x'.repeat(400_000) }));
  const parts = chunk(big);
  assert.ok(parts.length >= 3);
  assert.equal(parts.flat().length, 10);
});

test('instrument CSV parse + search (shared by server and browser)', () => {
  const csv = 'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange\n'
    + '408065,1594,INFY,INFOSYS,0,,0,0.05,1,EQ,NSE,NSE\n'
    + '738561,2885,RELIANCE,RELIANCE INDUSTRIES,0,,0,0.05,1,EQ,NSE,NSE\n';
  const list = parseExchange('NSE', csv);
  assert.equal(list.length, 2);
  const [hit] = searchInstruments(list, 'reli');
  assert.equal(hit.symbol, 'RELIANCE'); assert.equal(hit.segment, 'EQ');
  assert.equal(list.find((i) => i.s === 'INFY').k, 408065);
});
