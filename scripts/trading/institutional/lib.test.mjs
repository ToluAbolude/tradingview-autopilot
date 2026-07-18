// Unit tests for institutional/lib.mjs — run: node --test scripts/trading/institutional/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COST_RT_BPS, roundTripCostPrice, nyOpenUtcMs, ema, atr, median,
  simulateBracket, netR,
} from './lib.mjs';

test('cost table: measured EURUSD round-trip is 2 bps', () => {
  assert.equal(roundTripCostPrice('EURUSD', 1.0), 0.0002);
  assert.equal(COST_RT_BPS.BTCUSD, 15);
});

test('cost table: unknown symbol throws (no silent free trading)', () => {
  assert.throws(() => roundTripCostPrice('WTI', 70), /No cost entry/);
});

test('NY open is 13:30 UTC in summer (EDT) and 14:30 UTC in winter (EST)', () => {
  assert.equal(nyOpenUtcMs(2026, 7, 15), Date.UTC(2026, 6, 15, 13, 30));
  assert.equal(nyOpenUtcMs(2026, 1, 15), Date.UTC(2026, 0, 15, 14, 30));
});

test('ema: returns null below period, converges toward constant series value', () => {
  assert.equal(ema([1, 2], 5), null);
  const e = ema(Array(200).fill(7), 20);
  assert.ok(Math.abs(e - 7) < 1e-9);
});

test('atr: constant 1-point range bars give ATR 1', () => {
  const bars = [];
  for (let i = 0; i < 30; i++) bars.push({ o: 100, h: 100.5, l: 99.5, c: 100 });
  assert.ok(Math.abs(atr(bars, 14) - 1) < 1e-9);
});

test('median: odd and even lengths', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

const mkBar = (o, h, l, c, t = 0) => ({ o, h, l, c, t });

test('bracket: long TP hit cleanly at +2R', () => {
  const r = simulateBracket({
    direction: 'long', entry: 100, sl: 99, tp: 102,
    bars: [mkBar(100.2, 101, 99.5, 100.8), mkBar(100.8, 102.5, 100.5, 102, 5)],
  });
  assert.equal(r.outcome, 'tp');
  assert.equal(r.grossR, 2);
});

test('bracket: bar touching BOTH levels counts as a LOSS (house rule)', () => {
  const r = simulateBracket({
    direction: 'long', entry: 100, sl: 99, tp: 102,
    bars: [mkBar(100, 102.5, 98.5, 101)],
  });
  assert.equal(r.outcome, 'sl');
  assert.equal(r.grossR, -1);
});

test('bracket: weekend gap through SL fills at the OPEN, worse than -1R', () => {
  const r = simulateBracket({
    direction: 'long', entry: 100, sl: 99, tp: 102,
    bars: [mkBar(97, 98, 96, 97.5, 42)],
  });
  assert.equal(r.outcome, 'sl');
  assert.equal(r.exitPrice, 97);
  assert.equal(r.grossR, -3);
});

test('bracket: gap through TP fills at the open, better than target', () => {
  const r = simulateBracket({
    direction: 'short', entry: 100, sl: 101, tp: 98,
    bars: [mkBar(97, 97.5, 96.5, 97)],
  });
  assert.equal(r.outcome, 'tp');
  assert.equal(r.grossR, 3);
});

test('bracket: unresolved stays open', () => {
  const r = simulateBracket({
    direction: 'long', entry: 100, sl: 99, tp: 102,
    bars: [mkBar(100, 100.5, 99.5, 100.2)],
  });
  assert.equal(r.outcome, 'open');
});

test('netR: EURUSD 10-pip risk costs 0.2R round-trip (2 bps at 1.0000)', () => {
  const n = netR({ grossR: 2, entry: 1.0, sl: 0.9990, symbol: 'EURUSD' });
  assert.ok(Math.abs(n - 1.8) < 1e-9);
});
