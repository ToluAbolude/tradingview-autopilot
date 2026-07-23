// Tests for robustness.mjs. Run: node --test scripts/trading/institutional/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sharpe, sharpeAnnualized, tradesPerYear, monteCarloBootstrap,
  signPermutationTest, validate, mulberry32,
} from './robustness.mjs';

const YEAR = 365.25 * 24 * 3600 * 1000;
const tr = (netR, entryTs = 0) => ({ netR, entryTs });

test('sharpe: zero mean → 0, constant series → 0 (no variance)', () => {
  assert.equal(sharpe([1, -1, 1, -1]), 0);   // mean 0
  assert.equal(sharpe([2, 2, 2]), 0);        // sd 0
});

test('sharpe: positive-drift series is positive and matches hand calc', () => {
  const s = sharpe([1, 2, 3]); // mean 2, sample sd 1 → 2
  assert.ok(Math.abs(s - 2) < 1e-9);
});

test('tradesPerYear: 52 trades one week apart ≈ 52/yr', () => {
  const trades = Array.from({ length: 52 }, (_, i) => tr(1, i * 7 * 24 * 3600 * 1000));
  const tpy = tradesPerYear(trades);
  assert.ok(tpy > 51 && tpy < 54, `got ${tpy}`);
});

test('sharpeAnnualized: scales per-trade sharpe by sqrt(trades/year)', () => {
  // 100 trades spread over exactly 1 year → tpy≈100 → ann ≈ perTrade*10
  const trades = Array.from({ length: 100 }, (_, i) => tr(i % 2 ? 2 : -1, (i / 100) * YEAR));
  const perTrade = sharpe(trades.map(t => t.netR));
  const ann = sharpeAnnualized(trades);
  assert.ok(Math.abs(ann - perTrade * Math.sqrt(tradesPerYear(trades))) < 1e-9);
  assert.ok(ann > perTrade); // annualization amplifies
});

test('monteCarloBootstrap: is deterministic under a fixed seed', () => {
  const trades = Array.from({ length: 80 }, (_, i) => tr(i % 3 === 0 ? -1 : 1.2, i));
  const a = monteCarloBootstrap(trades, { iters: 1000, seed: 42 });
  const b = monteCarloBootstrap(trades, { iters: 1000, seed: 42 });
  assert.deepEqual(a.sharpe, b.sharpe);
  assert.deepEqual(a.maxDD, b.maxDD);
});

test('monteCarloBootstrap: observed Sharpe lands near the distribution median', () => {
  // Bootstrap of the SAME book: the observed statistic should sit mid-distribution,
  // i.e. percentile near 0.5 — this is the "not a lucky tail" property.
  const trades = Array.from({ length: 200 }, (_, i) => tr(i % 2 ? 1.5 : -1, i));
  const mc = monteCarloBootstrap(trades, { iters: 3000, seed: 7 });
  assert.ok(mc.sharpe.percentile > 0.25 && mc.sharpe.percentile < 0.75,
    `percentile ${mc.sharpe.percentile}`);
  assert.ok(mc.maxDD.p95 >= mc.maxDD.observed - 1e-9); // tail DD >= typical observed
});

test('signPermutationTest: a strong real edge yields a tiny p-value', () => {
  // 70% winners at +1 / −1 → clearly directional
  const trades = Array.from({ length: 300 }, (_, i) => tr((i % 10) < 7 ? 1 : -1, i));
  const { pValue } = signPermutationTest(trades, { iters: 3000, seed: 3 });
  assert.ok(pValue < 0.01, `p=${pValue}`);
});

test('signPermutationTest: a coin-flip book is NOT significant', () => {
  const rng = mulberry32(123);
  const trades = Array.from({ length: 300 }, (_, i) => tr(rng() < 0.5 ? -1 : 1, i));
  const { pValue } = signPermutationTest(trades, { iters: 3000, seed: 5 });
  assert.ok(pValue > 0.05, `p=${pValue}`);
});

test('validate: a strong, long, significant book passes every gate', () => {
  // 65% WR at +2/−1 across ~2 years, 260 trades
  const trades = Array.from({ length: 260 }, (_, i) =>
    tr((i % 20) < 13 ? 2 : -1, (i / 260) * 2 * YEAR));
  const v = validate(trades, { iters: 2000 });
  assert.equal(v.pass, true, JSON.stringify(v.checks));
});

test('validate: a random book fails significance and Sharpe gates', () => {
  const rng = mulberry32(77);
  const trades = Array.from({ length: 260 }, (_, i) =>
    tr(rng() < 0.5 ? -1 : 1, (i / 260) * 2 * YEAR));
  const v = validate(trades, { iters: 2000 });
  assert.equal(v.pass, false);
  assert.equal(v.checks['entry edge significant (p < 0.05)'], false);
});
