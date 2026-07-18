// Tests for smorb.mjs — synthetic sessions. Run: node --test scripts/trading/institutional/
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSmorbSignal, resolveSmorbEntry, ENTRY_WINDOW_MS } from './smorb.mjs';

const OPEN = Date.UTC(2026, 6, 15, 0, 0); // Asia session open
const M5 = 5 * 60_000;
const bar = (i, o, h, l, c, v) => ({ t: OPEN + i * M5, o, h, l, c, v });

// OR bars (i = 0,1,2): range 100–101, volume 300 total
const OR_BARS = [bar(0, 100.5, 101, 100, 100.6, 100), bar(1, 100.6, 100.9, 100.2, 100.4, 100), bar(2, 100.4, 100.8, 100.1, 100.7, 100)];
const HIST = { vols: Array(20).fill(150), ranges: Array(20).fill(0.9) }; // relVol=2.0, relRange≈1.11 → gates pass

test('gate: quiet session (low relVol) produces no trade', () => {
  const hist = { vols: Array(20).fill(400), ranges: Array(20).fill(0.9) }; // relVol = 0.75
  const r = computeSmorbSignal({ bars5m: [...OR_BARS, bar(3, 100.7, 101.5, 100.6, 101.4, 80)], sessionOpenMs: OPEN, priorOrStats: hist });
  assert.equal(r.status, 'no_gate');
  assert.equal(r.reason, 'rel_vol');
});

test('gate: fewer than 10 history sessions produces no trade', () => {
  const r = computeSmorbSignal({ bars5m: OR_BARS, sessionOpenMs: OPEN, priorOrStats: { vols: [1, 2], ranges: [1, 2] } });
  assert.equal(r.status, 'no_gate');
  assert.equal(r.reason, 'insufficient_history');
});

test('long breakout: entry at OR high, SL at OR low, TP at 2R', () => {
  const bars = [...OR_BARS, bar(3, 100.7, 101.3, 100.6, 101.2, 80)];
  const r = computeSmorbSignal({ bars5m: bars, sessionOpenMs: OPEN, priorOrStats: HIST });
  assert.equal(r.status, 'signal');
  assert.equal(r.direction, 'long');
  assert.equal(r.entry, 101);
  assert.equal(r.sl, 100);
  assert.ok(Math.abs(r.tp - 103) < 1e-9); // 101 + 2×(101−100)
});

test('short breakout mirrors correctly', () => {
  const bars = [...OR_BARS, bar(3, 100.3, 100.4, 99.6, 99.7, 80)];
  const r = computeSmorbSignal({ bars5m: bars, sessionOpenMs: OPEN, priorOrStats: HIST });
  assert.equal(r.status, 'signal');
  assert.equal(r.direction, 'short');
  assert.equal(r.entry, 100);
  assert.equal(r.sl, 101);
  assert.ok(Math.abs(r.tp - 98) < 1e-9);
});

test('gap open beyond entry fills at bar open (stop-order slippage)', () => {
  const bars = [...OR_BARS, bar(3, 101.6, 101.9, 101.5, 101.8, 80)];
  const r = computeSmorbSignal({ bars5m: bars, sessionOpenMs: OPEN, priorOrStats: HIST });
  assert.equal(r.status, 'signal');
  assert.equal(r.entry, 101.6); // worse than the 101 stop level
});

test('one bar crossing BOTH sides before entry = ambiguous, no trade', () => {
  const bars = [...OR_BARS, bar(3, 100.5, 101.4, 99.5, 100.2, 200)];
  const r = computeSmorbSignal({ bars5m: bars, sessionOpenMs: OPEN, priorOrStats: HIST });
  assert.equal(r.status, 'ambiguous');
});

test('breakout after the 3h entry window is ignored', () => {
  const lateIdx = ENTRY_WINDOW_MS / M5; // first bar at/after expiry
  const bars = [...OR_BARS, bar(lateIdx, 100.7, 101.5, 100.6, 101.4, 80)];
  const r = computeSmorbSignal({ bars5m: bars, sessionOpenMs: OPEN, priorOrStats: HIST });
  assert.equal(r.status, 'no_breakout');
});

test('missing OR bars (data gap) = no trade', () => {
  const r = computeSmorbSignal({ bars5m: [OR_BARS[0]], sessionOpenMs: OPEN, priorOrStats: HIST });
  assert.equal(r.status, 'no_or_data');
});

test('resolveSmorbEntry: first breakout wins across bars', () => {
  const postBars = [
    { t: OPEN + 3 * M5, o: 100.4, h: 100.6, l: 100.3, c: 100.5 }, // no touch
    { t: OPEN + 4 * M5, o: 100.5, h: 100.6, l: 99.9, c: 100.0 },  // short side first
    { t: OPEN + 5 * M5, o: 100.0, h: 101.5, l: 99.9, c: 101.4 },  // long side later
  ];
  const r = resolveSmorbEntry({ postBars, longEntry: 101, shortEntry: 100, expiryMs: OPEN + ENTRY_WINDOW_MS });
  assert.equal(r.direction, 'short');
});
