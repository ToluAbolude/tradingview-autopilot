// Unit tests for scripts/trading/lib — run: node --test scripts/trading/lib/
import test from 'node:test';
import assert from 'node:assert/strict';
import { instrumentClass, isCrypto, CORE_UNIVERSE } from './instruments.mjs';
import { isCalendarWeekend, isFxWeekend, isSundayReopen, inTradeWindow, entryCutoff, currentSession } from './clock.mjs';
import { calcLots, splitLegs, legVolumes, backstopPrice } from './sizing.mjs';
import { signalErrors } from './contracts.mjs';

const utc = s => new Date(`${s}Z`);                 // 2026-09-13 is a Sunday
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('instrument classes for the core universe', () => {
  assert.deepEqual(CORE_UNIVERSE.map(instrumentClass),
    ['METAL', 'INDEX', 'INDEX', 'INDEX', 'FX', 'FX', 'FX', 'CRYPTO']);
  assert.equal(isCrypto('ethusd'), true);
  assert.equal(isCrypto('USDCAD'), false);           // "CAD" must not read as ADA
  assert.equal(instrumentClass('USTEC'), 'INDEX');   // broker alias of NAS100
});

test('calendar weekend vs FX weekend vs Sunday reopen', () => {
  assert.equal(isCalendarWeekend(utc('2026-09-13T23:00:00')), true);
  assert.equal(isFxWeekend(utc('2026-09-13T21:59:00')), true);
  assert.equal(isFxWeekend(utc('2026-09-13T22:00:00')), false);
  assert.equal(isSundayReopen(utc('2026-09-13T21:00:00')), true);
  assert.equal(isFxWeekend(utc('2026-09-14T09:00:00')), false);
});

test('trade windows are half-open [start, end)', () => {
  assert.equal(inTradeWindow(utc('2026-09-15T07:00:00')), true);
  assert.equal(inTradeWindow(utc('2026-09-15T10:00:00')), false);
  assert.equal(inTradeWindow(utc('2026-09-15T12:30:00')), true);
  assert.equal(inTradeWindow(utc('2026-09-15T17:45:00')), false);
});

test('entry cutoffs and session labels', () => {
  assert.equal(entryCutoff(utc('2026-09-15T19:29:00')), null);
  assert.equal(entryCutoff(utc('2026-09-15T19:30:00')), 'Past 19:30 last-entry cutoff');
  assert.equal(entryCutoff(utc('2026-09-15T20:00:00')), 'Past 20:00 UTC EOD cutoff');
  assert.equal(currentSession(utc('2026-09-15T13:00:00')), 'LONDON-NY-OVERLAP');
  assert.equal(currentSession(utc('2026-09-13T22:30:00')), 'ASIAN');
});

test('sizing risks the right amount per asset class', () => {
  near(calcLots('EURUSD', 1, 10250, 1.1000, 1.0950), 0.2);    // $102.50 over 50 pips
  near(calcLots('XAUUSD', 1, 10000, 4300, 4292), 0.12);       // $100 / (100 oz × $8)
  near(calcLots('NAS100', 1, 10000, 24000, 23970), 3.33);     // $100 / 30 pts
  near(calcLots('USDJPY', 1, 10000, 147.0, 146.6), 0.38);     // $100 / (6.5 × 40 pips)
  assert.equal(calcLots('NAS100', 5, 10000, 24000, 23995), 10); // index cap
  assert.equal(calcLots('WTI', 5, 100000, 70, 69), 5);          // oil: whole lots, at budget
  assert.equal(calcLots('WTI', 0.1, 10000, 70, 69), 0);         // $10 budget, 3-lot floor = $3,000 → refuse
  assert.equal(calcLots('EURUSD', 1, 10000, 1.1, 1.1), 0.01);   // zero stop distance
});

test('crypto risk is capped at 1% of equity', () => {
  assert.equal(calcLots('BTCUSD', 5, 10000, 60000, 59550), calcLots('BTCUSD', 1, 10000, 60000, 59550));
});

test('sizing refuses trades a floor would over-risk, and only those', () => {
  // A minimum-lot floor that forces more than 2x the budget: skip, don't trade it.
  assert.equal(calcLots('XAUUSD', 0.01, 10000, 4300, 4292), 0);   // $1 budget, 0.01 lot = $8
  // Exactly 2x is allowed: $5 budget, 100-pip stop, 0.01 lot = $10.
  assert.equal(calcLots('EURUSD', 0.05, 10000, 1.1, 1.09), 0.01);
  // No contract size we trust: refuse rather than size platinum as forex (was 16-22x).
  assert.equal(calcLots('XPTUSD', 1, 10000, 1585, 1583), 0);
  // Under-sizing still trades — a cap binding risks less, never more.
  assert.equal(calcLots('ADAUSD', 1, 10000, 0.18, 0.1782), 3);
});

test('splitLegs spreads remainders onto the tail legs', () => {
  assert.deepEqual(splitLegs(5, 3, 1, 1), [1, 2, 2]);
  assert.deepEqual(splitLegs(10, 3, 1, 1), [3, 3, 4]);
  assert.deepEqual(splitLegs(0.06, 3, 0.01, 0.01), [0.02, 0.02, 0.02]);
  assert.equal(splitLegs(0.02, 3, 0.01, 0.01), null);
});

test('the runner backstop sits far out, on the right side of entry', () => {
  near(backstopPrice('long',  1.1000, 1.0950, 6), 1.13);
  near(backstopPrice('short', 1.1000, 1.1050, 6), 1.07);   // BELOW entry, or it fills instantly
  near(backstopPrice('buy',   1.1000, 1.0950, 2), 1.11);   // 2R is where the old cap sat
  assert.ok(backstopPrice('short', 100, 101, 6) < 100, 'a short backstop must be below entry');
});

test('leg volumes leave a deliberate partial partial (the runner exit)', () => {
  const p = { totalVol: 300, lotSize: 100, step: 1, minV: 1 };   // 3 lots, 1 lot = 100 cents
  // The runner exit: ONE leg covering 1/3 of a 3-lot position stays 1 lot. If the
  // remainder were reconciled here it would close all 3 lots at the 2R target.
  assert.deepEqual(legVolumes({ ...p, totalUnits: 3, legUnits: [1], n: 1 }), [100]);
  // A 3-leg split that IS meant to cover the position still reconciles.
  assert.deepEqual(legVolumes({ ...p, totalUnits: 3, legUnits: [1, 1, 1], n: 3 }), [100, 100, 100]);
  // Oil's uneven whole-lot split survives untouched.
  assert.deepEqual(legVolumes({ totalVol: 5, lotSize: 1, step: 1, minV: 1, totalUnits: 5, legUnits: [1, 2, 2], n: 3 }), [1, 2, 2]);
  // No legUnits: divide evenly in step units.
  assert.deepEqual(legVolumes({ ...p, totalUnits: 3, legUnits: null, n: 3 }), [100, 100, 100]);
  // Closing legs never add up to more than the position.
  const over = legVolumes({ ...p, totalUnits: 3, legUnits: [2, 2], n: 2 });
  assert.ok(over.reduce((a, b) => a + b, 0) <= 300, `${over} exceeds the position`);
});

test('scanner_confluence emits valid Signals, and nothing without bars', async () => {
  const { default: scanner, toSignal } = await import('../confirm/strategies/scanner_confluence.mjs');
  assert.deepEqual(scanner.generateSignals([], { symbol: 'EURUSD' }), []);
  const setup = { label: 'EURUSD', tf: '15', dir: 'short', entry: 1.17, sl: 1.1715, tp1: 1.1685, tp2: 1.167, tp3: 1.1655, score: 7, reasons: [] };
  const sig = toSignal(setup, 1);
  assert.deepEqual(signalErrors(sig), []);
  assert.deepEqual(sig.targets, [1.1685, 1.167, 1.1655]);   // nearest first for a short
});

test('signal validation rejects stops and targets on the wrong side', () => {
  const ok = { strategyId: 'x', symbol: 'EURUSD', tf: '60', dir: 'long', ts: 1, entry: 1.1, sl: 1.09, targets: [1.12] };
  assert.deepEqual(signalErrors(ok), []);
  assert.match(signalErrors({ ...ok, sl: 1.11 }).join(), /wrong side/);
  assert.match(signalErrors({ ...ok, targets: [1.05] }).join(), /not beyond entry/);
  assert.match(signalErrors({ ...ok, strategyId: '' }).join(), /strategyId/);
});
