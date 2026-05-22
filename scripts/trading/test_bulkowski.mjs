/**
 * test_bulkowski.mjs — Sanity tests for bulkowski_patterns.mjs
 * Run: node scripts/trading/test_bulkowski.mjs
 */
import {
  detectTripleBottom, detectTripleTop,
  detectHeadAndShoulders, detectInverseHeadAndShoulders,
  detectFlag, detectChartPatterns,
} from './bulkowski_patterns.mjs';

function atrOf(len, val) { return Array(len).fill(val); }
function bar(o, h, l, c, v = 1000) { return { o, h, l, c, v }; }

let pass = 0, fail = 0;
function assert(name, cond, info = '') {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else      { console.log(`  ✗ ${name} ${info}`); fail++; }
}

// V-shaped trough: 5 declining bars, single low bar, 5 rising bars
function vTrough(out, baseLevel, troughLow) {
  const drop = (baseLevel - troughLow) / 5;
  for (let i = 0; i < 5; i++) {
    const o = baseLevel - i * drop;
    out.push(bar(o, o + 0.3, o - drop * 0.3, o - drop * 0.5));
  }
  out.push(bar(troughLow + 1, troughLow + 1.2, troughLow, troughLow + 0.5));
  for (let i = 0; i < 5; i++) {
    const o = troughLow + (i + 1) * drop;
    out.push(bar(o, o + drop * 0.3, o - 0.3, o + drop * 0.5));
  }
}

// Inverted V peak: 5 rising bars, single high bar, 5 falling bars
function vPeak(out, baseLevel, peakHigh) {
  const rise = (peakHigh - baseLevel) / 5;
  for (let i = 0; i < 5; i++) {
    const o = baseLevel + i * rise;
    out.push(bar(o, o + rise * 0.3, o - 0.3, o + rise * 0.5));
  }
  out.push(bar(peakHigh - 1, peakHigh, peakHigh - 1.2, peakHigh - 0.5));
  for (let i = 0; i < 5; i++) {
    const o = peakHigh - (i + 1) * rise;
    out.push(bar(o, o + 0.3, o - rise * 0.3, o - rise * 0.5));
  }
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Triple Bottom ===');
{
  const bars = [];
  // Downtrend lead-in
  for (let i = 0; i < 12; i++) bars.push(bar(140 - i, 141 - i, 139 - i, 140 - i));
  // Trough 1 at low=100, base 110
  vTrough(bars, 110, 100);
  // Trough 2 at low=100.2
  vTrough(bars, 110, 100.2);
  // Trough 3 at low=99.8
  vTrough(bars, 110, 99.8);
  // Breakout above neckline ~111
  bars.push(bar(110, 113, 110, 113));
  bars.push(bar(113, 117, 112, 116));

  const atr = atrOf(bars.length, 2.0);
  const result = detectTripleBottom(bars, atr, 'long');
  assert('detects Triple Bottom', !!result, JSON.stringify(result));
  if (result) {
    assert('name=Triple Bottom', result.name === 'Triple Bottom');
    assert('target > neckline', result.target > result.neckline, `tgt=${result.target} neck=${result.neckline}`);
  }
  assert('null for wrong direction', detectTripleBottom(bars, atr, 'short') === null);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Triple Top ===');
{
  const bars = [];
  for (let i = 0; i < 12; i++) bars.push(bar(60 + i, 61 + i, 59 + i, 60 + i));
  vPeak(bars, 90, 100);
  vPeak(bars, 90, 99.8);
  vPeak(bars, 90, 100.2);
  bars.push(bar(90, 90, 86, 87));
  bars.push(bar(87, 87, 82, 83));

  const atr = atrOf(bars.length, 2.0);
  const result = detectTripleTop(bars, atr, 'short');
  assert('detects Triple Top', !!result, JSON.stringify(result));
  if (result) {
    assert('target < neckline', result.target < result.neckline);
  }
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Head & Shoulders ===');
{
  const bars = [];
  // Uptrend lead-in
  for (let i = 0; i < 10; i++) bars.push(bar(80 + i, 81 + i, 79 + i, 80 + i));
  // Left shoulder peak at 100, base 90
  vPeak(bars, 90, 100);
  // Head peak at 108 (higher), back from base 92
  vPeak(bars, 92, 108);
  // Right shoulder peak at 100 (matches LS), back from base 92
  vPeak(bars, 92, 100);
  // Breakdown below neckline (~92)
  bars.push(bar(92, 92, 86, 87));
  bars.push(bar(87, 87, 82, 83));

  const atr = atrOf(bars.length, 2.0);
  const result = detectHeadAndShoulders(bars, atr, 'short');
  assert('detects H&S', !!result, JSON.stringify(result));
  if (result) assert('target < neckline', result.target < result.neckline);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== Inverse Head & Shoulders ===');
{
  const bars = [];
  for (let i = 0; i < 10; i++) bars.push(bar(120 - i, 121 - i, 119 - i, 120 - i));
  vTrough(bars, 110, 100);          // LS
  vTrough(bars, 108, 92);            // Head (lower)
  vTrough(bars, 108, 100);           // RS
  bars.push(bar(108, 113, 108, 113));
  bars.push(bar(113, 118, 112, 117));

  const atr = atrOf(bars.length, 2.0);
  const result = detectInverseHeadAndShoulders(bars, atr, 'long');
  assert('detects Inverse H&S', !!result, JSON.stringify(result));
  if (result) assert('target > neckline', result.target > result.neckline);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== High & Tight Flag ===');
{
  const bars = [];
  for (let i = 0; i < 12; i++) bars.push(bar(100, 100.5, 99.5, 100));
  // Sharp impulse of ~10 over 6 bars
  for (let i = 0; i < 6; i++) bars.push(bar(100 + i * 1.7, 102 + i * 1.7, 100 + i * 1.7, 101.7 + i * 1.7));
  // Tight consolidation (6 bars, range ~1.5)
  for (let i = 0; i < 6; i++) bars.push(bar(111, 112, 110.5, 111.5));
  // Single breakout bar = current
  bars.push(bar(111.5, 116, 111.5, 115));

  const atr = atrOf(bars.length, 1.0);
  const result = detectFlag(bars, atr, 'long');
  assert('detects bullish flag', !!result, JSON.stringify(result));
  if (result) {
    assert('confidence is confirmed or breaking', ['confirmed', 'breaking'].includes(result.confidence));
    assert('target above breakLevel', result.target > result.neckline);
  }
  // No false positive when there's no impulse leading in
  const flat = [];
  for (let i = 0; i < 30; i++) flat.push(bar(100, 100.5, 99.5, 100));
  flat.push(bar(100, 102, 100, 101.5));
  assert('null when no impulse precedes', detectFlag(flat, atrOf(flat.length, 1.0), 'long') === null);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n=== No false positive on noise ===');
{
  const bars = [];
  for (let i = 0; i < 50; i++) {
    const o = 100 + Math.sin(i * 0.7) * 0.5;
    bars.push(bar(o, o + 0.3, o - 0.3, o + (i % 2 ? 0.1 : -0.1)));
  }
  const atr = atrOf(bars.length, 0.4);
  const result = detectChartPatterns(bars, atr, 'long');
  assert('null on noise', result === null, result ? JSON.stringify(result) : '');
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail > 0 ? 1 : 0);
