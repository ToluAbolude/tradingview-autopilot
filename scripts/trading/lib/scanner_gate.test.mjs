// The scanner's 15M alignment gate reads trend facts, not vote codes — run: node --test scripts/trading/lib/
// Regression test for the 2026-08-21 → 2026-09-15 starvation: the gate asked for vote
// codes A/B/T that had stopped being emitted, so it rejected almost every setup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAllStrategies } from '../setup_finder.mjs';

// 300 M15 bars (unix seconds) drifting `step` per bar from 100, with a small range.
function bars(step) {
  let c = 100;
  return Array.from({ length: 300 }, (_, i) => {
    const o = c;
    c = c * (1 + step);
    return { t: 1_780_000_000 + i * 900, o, h: Math.max(o, c) * 1.0004, l: Math.min(o, c) * 0.9996, c, v: 1000 };
  });
}

test('a clean uptrend is aligned for longs and not for shorts', () => {
  const up = bars(0.002);
  const long = runAllStrategies(up, 'long', 14, 'EURUSD', '15').alignment;
  const short = runAllStrategies(up, 'short', 14, 'EURUSD', '15').alignment;
  assert.equal(long.emaStack && long.smartTrail && long.weeklyTrend, true);
  assert.equal(short.emaStack || short.smartTrail || short.weeklyTrend, false);
});

test('a clean downtrend is aligned for shorts', () => {
  const a = runAllStrategies(bars(-0.002), 'short', 14, 'EURUSD', '15').alignment;
  assert.equal(a.emaStack && a.smartTrail && a.weeklyTrend, true);
});

test('alignment never leaks back into the vote codes', () => {
  const r = runAllStrategies(bars(0.002), 'long', 14, 'EURUSD', '15');
  for (const code of ['A', 'B', 'T']) assert.equal(r.strategies.includes(code), false);
});

test('a flat market returns no alignment, so the gate stays shut', () => {
  const flat = Array.from({ length: 300 }, (_, i) => ({ t: 1_780_000_000 + i * 900, o: 100, h: 100.2, l: 99.8, c: 100 + (i % 2 ? 0.05 : -0.05), v: 1000 }));
  const r = runAllStrategies(flat, 'long', 14, 'EURUSD', '15');
  assert.equal(r.alignment, undefined);   // early "EMA flat" return; buildSetups reads it as not aligned
});
