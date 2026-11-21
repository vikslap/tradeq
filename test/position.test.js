import test from 'node:test';
import assert from 'node:assert/strict';
import { sizePosition, roundTripCharges } from '../public/position.js';

const S = { capital: 100000, riskPctPerTrade: 1, maxRiskPerTrade: 2000, maxPositionPct: 30, maxPortfolioHeatPct: 6 };
const base = { symbol: 'INFY', exchange: 'NSE', segment: 'EQ', side: 'LONG', intraday: false, slippagePct: 0.1, lotSize: 1 };

test('1% of capital, loss at the stop includes slippage and charges and stays within budget', () => {
  const r = sizePosition({ ...base, entry: 100, stop: 95 }, S);
  assert.equal(r.budget, 1000);
  assert.ok(r.risk.total <= 1000, `risk ${r.risk.total}`);
  // one more share would break the budget
  const one = sizePosition({ ...base, entry: 100, stop: 95 }, { ...S, riskPctPerTrade: 100, maxRiskPerTrade: 1e9, maxPositionPct: 0, maxPortfolioHeatPct: 0 });
  assert.ok(r.qty < 1000 / 5, 'charges+slippage reduce qty below the naive 200');
  assert.ok(r.qty >= 180);
  assert.ok(one.qty > r.qty);
});

test('the ₹ cap wins when it is smaller than the % budget', () => {
  const r = sizePosition({ ...base, entry: 100, stop: 95 }, { ...S, riskPctPerTrade: 5 });
  assert.equal(r.budget, 2000); assert.equal(r.budgetBy, 'cap');
});

test('max position % caps the quantity and is flagged', () => {
  const r = sizePosition({ ...base, entry: 1000, stop: 995 }, S); // tight stop → risk allows ~190 shares = ₹1.9L
  assert.equal(r.qty, 30); // 30% of ₹1L at ₹1,000
  assert.ok(r.limits.some((l) => l.rule === 'position'));
});

test('open-risk limit cuts the size, or blocks it when used up', () => {
  const r = sizePosition({ ...base, entry: 100, stop: 95 }, S, 5500); // ₹500 room left
  assert.ok(r.risk.total <= 500 && r.qty > 0);
  assert.ok(r.limits.some((l) => l.rule === 'heat'));
  const z = sizePosition({ ...base, entry: 100, stop: 95 }, S, 6500);
  assert.equal(z.qty, 0);
});

test('F&O rounds down to whole lots; bought options risk the whole premium', () => {
  const f = sizePosition({ ...base, symbol: 'NIFTY26DECFUT', exchange: 'NFO', segment: 'FUT', lotSize: 65, entry: 26000, stop: 25990 }, { ...S, maxPositionPct: 0 });
  assert.equal(f.qty % 65, 0);
  const o = sizePosition({ ...base, symbol: 'NIFTY26DEC26000CE', exchange: 'NFO', segment: 'OPT', lotSize: 65, entry: 5, stop: 3 }, S);
  assert.ok(o.premiumRisk);
  assert.equal(o.qty % 65, 0);
  assert.ok(o.risk.total <= 1000 && o.qty * 5 <= 1000);
});

test('stops on the wrong side, missing stops and overnight shorts are refused', () => {
  assert.ok(sizePosition({ ...base, entry: 100, stop: 105 }, S).errors.length);
  assert.ok(sizePosition({ ...base, entry: 100, stop: '' }, S).errors.length);
  assert.ok(sizePosition({ ...base, side: 'SHORT', entry: 100, stop: 105 }, S).errors.length);
  assert.equal(sizePosition({ ...base, side: 'SHORT', intraday: true, entry: 100, stop: 105 }, S).errors.length, 0);
});

test('reward:risk is after charges; overnight gap warning present', () => {
  const r = sizePosition({ ...base, entry: 100, stop: 95, target: 115 }, S);
  assert.ok(r.rr > 2.5 && r.rr < 3);
  assert.ok(r.warnings.some((w) => w.includes('gap')));
  assert.ok(roundTripCharges({ ...base, entry: 100 }, 100, 100) > 0);
});
