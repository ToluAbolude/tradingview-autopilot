// Tests for trendpb.mjs — synthetic series. Run: node --test scripts/trading/institutional/
import test from 'node:test';
import assert from 'node:assert/strict';
import { trendScore, detectPullback, detectResumption, computeTrendPbSignal } from './trendpb.mjs';

const D = 86400_000;
// Steady uptrend: 300 D1 bars, +0.5/day, tight 0.4 ranges
function uptrendD1({ n = 300, dipLastBars = 0, dipDepth = 0 } = {}) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const base = 100 + i * 0.5;
    let l = base - 0.2, h = base + 0.2, c = base, o = base - 0.1;
    if (dipLastBars && i >= n - dipLastBars) { l -= dipDepth; c -= dipDepth * 0.6; o -= dipDepth * 0.5; }
    bars.push({ t: i * D, o, h, l, c });
  }
  return bars;
}

test('trendScore: steady uptrend is unanimous long', () => {
  const r = trendScore(uptrendD1().map(b => b.c));
  assert.equal(r.direction, 'long');
});

test('trendScore: recent 1-month dump breaks unanimity → no trend', () => {
  const closes = uptrendD1().map(b => b.c);
  for (let i = closes.length - 21; i < closes.length; i++) closes[i] = closes[closes.length - 22] - (i - (closes.length - 22)) * 0.8;
  const r = trendScore(closes);
  assert.equal(r.direction, null);
  assert.equal(r.reason, 'not_unanimous');
});

test('trendScore: short history refuses to trade', () => {
  const r = trendScore(uptrendD1({ n: 100 }).map(b => b.c));
  assert.equal(r.direction, null);
  assert.equal(r.reason, 'insufficient_history');
});

test('detectPullback: no dip in a grinding uptrend → not in pullback', () => {
  const r = detectPullback({ d1Bars: uptrendD1(), direction: 'long' });
  assert.equal(r.inPullback, false);
});

test('detectPullback: ≥1×ATR dip from 20d high IS a pullback, extreme recorded', () => {
  const bars = uptrendD1({ dipLastBars: 3, dipDepth: 3 }); // dip ≫ ATR (~0.7)
  const r = detectPullback({ d1Bars: bars, direction: 'long' });
  assert.equal(r.inPullback, true);
  assert.ok(r.pullbackExtreme < bars[bars.length - 4].l, 'extreme below pre-dip lows');
});

test('detectResumption: bullish H4 close above prior close resumes long', () => {
  const h4 = [
    { t: 0, o: 100, h: 101, l: 99.5, c: 100.2 },
    { t: 1, o: 100.2, h: 101.5, l: 100, c: 101.2 },
  ];
  assert.equal(detectResumption({ h4Bars: h4, direction: 'long' }).resumed, true);
  assert.equal(detectResumption({ h4Bars: h4, direction: 'short' }).resumed, false);
});

test('computeTrendPbSignal: full long setup produces bracket with SL beyond pullback extreme and 2R TP', () => {
  const d1 = uptrendD1({ dipLastBars: 3, dipDepth: 3 });
  const h4 = [
    { t: 1000, o: 246, h: 247, l: 245.5, c: 246.2 },
    { t: 1001, o: 246.2, h: 248, l: 246, c: 247.5 }, // bullish resumption
  ];
  const r = computeTrendPbSignal({ d1Bars: d1, h4Bars: h4 });
  assert.equal(r.status, 'signal');
  assert.equal(r.direction, 'long');
  assert.equal(r.entry, 247.5);
  assert.ok(r.sl <= r.pullbackExtreme, 'SL at/below pullback extreme');
  const risk = r.entry - r.sl;
  assert.ok(Math.abs(r.tp - (r.entry + 2 * risk)) < 1e-9, 'TP is 2R');
});

test('computeTrendPbSignal: pullback without resumption stays flat', () => {
  const d1 = uptrendD1({ dipLastBars: 3, dipDepth: 3 });
  const h4 = [
    { t: 1000, o: 247, h: 247.2, l: 245.5, c: 246 },
    { t: 1001, o: 246, h: 246.4, l: 245, c: 245.4 }, // still falling
  ];
  const r = computeTrendPbSignal({ d1Bars: d1, h4Bars: h4 });
  assert.equal(r.status, 'no_resumption');
});

test('computeTrendPbSignal: no trend means no evaluation of entries', () => {
  const d1 = uptrendD1({ n: 100 });
  const r = computeTrendPbSignal({ d1Bars: d1, h4Bars: [] });
  assert.equal(r.status, 'no_trend');
});
