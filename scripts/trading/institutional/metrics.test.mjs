// Tests for metrics.mjs. Run: node --test scripts/trading/institutional/
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, splitFolds, gradeStage1 } from './metrics.mjs';

const tr = (netR, entryTs = 0) => ({ netR, entryTs });

test('computeMetrics: known small set', () => {
  const m = computeMetrics([tr(2), tr(-1), tr(2), tr(-1)]);
  assert.equal(m.n, 4);
  assert.equal(m.wr, 0.5);
  assert.equal(m.expR, 0.5);
  assert.equal(m.pf, 2);      // 4 win / 2 loss
  assert.equal(m.payoff, 2);  // avg 2 vs avg 1
  assert.equal(m.totalR, 2);
});

test('computeMetrics: max drawdown tracks peak-to-trough on cumulative R', () => {
  const m = computeMetrics([tr(3), tr(-1), tr(-1), tr(-1), tr(2)]);
  assert.equal(m.maxDD, 3); // peak 3 → trough 0
  assert.equal(m.totalR, 2);
});

test('splitFolds: time boundaries respected (60/40, 4 folds)', () => {
  const trades = Array.from({ length: 10 }, (_, i) => tr(1, i * 10)); // ts 0..90
  const { is, oos, folds } = splitFolds(trades, { tStart: 0, tEnd: 100 });
  assert.equal(is.length, 6);   // ts < 60
  assert.equal(oos.length, 4);
  assert.equal(folds.flat().length, 4);
  assert.equal(folds[0].length, 1); // ts 60
});

test('gradeStage1: a clearly passing book passes every check', () => {
  // 120 OOS trades: 50% WR at +2R/−1R; folds are CONTIGUOUS blocks of 30 so
  // each fold gets 15 wins / 15 losses (i%4 would dump all losses in odd folds)
  const oos = [], folds = [[], [], [], []];
  for (let i = 0; i < 120; i++) {
    const t = tr(i % 2 === 0 ? 2 : -1, i);
    oos.push(t); folds[Math.floor(i / 30)].push(t);
  }
  const g = gradeStage1({ oos, folds });
  assert.equal(g.pass, true);
});

test('gradeStage1: one bleeding fold fails the every-fold checks', () => {
  const mkFold = (win) => Array.from({ length: 30 }, (_, i) => tr(win ? (i % 2 ? 2 : -1) : -1, i));
  const folds = [mkFold(true), mkFold(true), mkFold(false), mkFold(true)];
  const g = gradeStage1({ oos: folds.flat(), folds });
  assert.equal(g.pass, false);
  assert.equal(g.checks['PF >= 1.25 in EVERY fold'], false);
  assert.equal(g.checks['equity growth in every fold'], false);
});
