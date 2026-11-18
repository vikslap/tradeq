import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeToLogical, logicalToTime, measure } from '../public/drawing.js';

const D = 86400000;
const T = [0, D, 2 * D, 5 * D, 6 * D]; // a weekend gap between bars 2 and 3

test('time ⇄ bar index round-trips, including gaps and the future', () => {
  for (const l of [-2, 0, 0.5, 2, 2.25, 3, 4, 7.5]) assert.ok(Math.abs(timeToLogical(T, logicalToTime(T, l)) - l) < 1e-9);
  assert.equal(timeToLogical(T, 5 * D), 3);
  assert.equal(timeToLogical(T, 8 * D), 6); // two bars past the last one
});

test('anchors by time survive a change of candle size', () => {
  const hourly = Array.from({ length: 48 }, (_, i) => i * 3600000);
  const t = logicalToTime(hourly, 30); // a point drawn on the hourly chart
  const daily = [0, D];
  assert.ok(Math.abs(timeToLogical(daily, t) - 30 / 24) < 1e-9);
});

test('ruler measures change, % and bars', () => {
  const m = measure(T, { t: 0, p: 100 }, { t: 5 * D, p: 112.5 });
  assert.equal(m.dp, 12.5); assert.equal(m.pct, 0.125); assert.equal(m.bars, 3); assert.equal(m.ms, 5 * D);
});
