// TREND-PB — multi-lookback time-series momentum with pullback entries
// (research/institutional_algo/SPEC.md §2). Family A.
// PURE module: bars in, signal out. Same code path for backtest and live.
import { ema, atr } from './lib.mjs';

export const LOOKBACKS_D = [21, 63, 252]; // 1m / 3m / 12m (HOP 2017 blend)
export const EMA_PERIOD = 20;
export const ATR_PERIOD = 14;
export const PULLBACK_ATR_MULT = 1.0;
export const SL_ATR_MULT = 2.0;
export const R_MULTIPLE = 2;
export const PULLBACK_WINDOW_D = 5; // pullback touch must be within last 5 D1 bars
export const EXTREME_LOOKBACK_D = 20;
// Family A redesign cycle 2: retraces deeper than 50% of the 20d range are
// treated as reversal risk, not pullbacks (house fib backtest: ≥61.8% depth
// discriminates reversal; 50% is the conservative side of that finding).
export const MAX_PULLBACK_DEPTH = 0.5;

/**
 * Unanimous multi-lookback trend (SPEC: |mean of signs| = 1).
 * d1Closes ascending. Needs 253+ closes.
 */
export function trendScore(d1Closes) {
  if (d1Closes.length < LOOKBACKS_D[2] + 1) return { direction: null, reason: 'insufficient_history' };
  const last = d1Closes[d1Closes.length - 1];
  const signs = LOOKBACKS_D.map(n => Math.sign(last - d1Closes[d1Closes.length - 1 - n]));
  if (signs.every(s => s === 1)) return { direction: 'long', signs };
  if (signs.every(s => s === -1)) return { direction: 'short', signs };
  return { direction: null, signs, reason: 'not_unanimous' };
}

/**
 * Pullback state on D1: within the last PULLBACK_WINDOW_D bars, price touched
 * EMA20 or retraced ≥ 1×ATR14 from the EXTREME_LOOKBACK_D-day extreme.
 * Returns { inPullback, pullbackExtreme, atr } (extreme = lowest low of the
 * window for longs / highest high for shorts — the invalidation anchor).
 */
export function detectPullback({ d1Bars, direction }) {
  if (d1Bars.length < EXTREME_LOOKBACK_D + ATR_PERIOD + 1) return { inPullback: false, reason: 'insufficient_history' };
  const closes = d1Bars.map(b => b.c);
  const e = ema(closes, EMA_PERIOD);
  const a = atr(d1Bars, ATR_PERIOD);
  if (e == null || a == null) return { inPullback: false, reason: 'indicator_null' };
  // Retrace is measured against the extreme AS OF each bar (bars up to and
  // including it) — using the global window extreme would false-flag every
  // grinding trend, since older bars sit naturally below the latest high.
  const window = d1Bars.slice(-PULLBACK_WINDOW_D);
  let touched = false;
  for (let k = d1Bars.length - PULLBACK_WINDOW_D; k < d1Bars.length; k++) {
    const b = d1Bars[k];
    const ref = d1Bars.slice(Math.max(0, k - EXTREME_LOOKBACK_D + 1), k + 1);
    if (direction === 'long') {
      const refHigh = Math.max(...ref.map(x => x.h));
      if (b.l <= e || (refHigh - b.l) >= PULLBACK_ATR_MULT * a) { touched = true; break; }
    } else {
      const refLow = Math.min(...ref.map(x => x.l));
      if (b.h >= e || (b.h - refLow) >= PULLBACK_ATR_MULT * a) { touched = true; break; }
    }
  }
  const pullbackExtreme = direction === 'long'
    ? Math.min(...window.map(b => b.l))
    : Math.max(...window.map(b => b.h));
  // depth of the retrace relative to the 20d range (0 = none, 1 = full give-back)
  const ref20 = d1Bars.slice(-EXTREME_LOOKBACK_D);
  const hi = Math.max(...ref20.map(b => b.h)), lo = Math.min(...ref20.map(b => b.l));
  const depth = hi > lo
    ? (direction === 'long' ? (hi - pullbackExtreme) : (pullbackExtreme - lo)) / (hi - lo)
    : 1;
  return { inPullback: touched, pullbackExtreme, depth, atr: a, ema: e };
}

/**
 * Resumption on H4: the LATEST closed H4 bar closes back in trend direction —
 * directional body (c>o for long) AND progress vs prior close.
 */
export function detectResumption({ h4Bars, direction }) {
  if (h4Bars.length < 2) return { resumed: false };
  const b = h4Bars[h4Bars.length - 1], p = h4Bars[h4Bars.length - 2];
  const resumed = direction === 'long'
    ? (b.c > b.o && b.c > p.c)
    : (b.c < b.o && b.c < p.c);
  return { resumed, entry: b.c, entryTs: b.t };
}

/**
 * Full TREND-PB evaluation at one point in time (call on each H4 close).
 * d1Bars/h4Bars ascending, both ending at "now". Returns { status, ... };
 * status 'signal' carries direction/entry/sl/tp.
 */
export function computeTrendPbSignal({ d1Bars, h4Bars }) {
  const ts = trendScore(d1Bars.map(b => b.c));
  if (!ts.direction) return { status: 'no_trend', reason: ts.reason };

  const pb = detectPullback({ d1Bars, direction: ts.direction });
  if (!pb.inPullback) return { status: 'no_pullback', direction: ts.direction, reason: pb.reason };
  if (pb.depth > MAX_PULLBACK_DEPTH) return { status: 'pullback_too_deep', direction: ts.direction, depth: pb.depth };

  const rs = detectResumption({ h4Bars, direction: ts.direction });
  if (!rs.resumed) return { status: 'no_resumption', direction: ts.direction };

  const long = ts.direction === 'long';
  const slAtr = long ? rs.entry - SL_ATR_MULT * pb.atr : rs.entry + SL_ATR_MULT * pb.atr;
  const sl = long ? Math.min(slAtr, pb.pullbackExtreme) : Math.max(slAtr, pb.pullbackExtreme);
  const risk = Math.abs(rs.entry - sl);
  if (!(risk > 0)) return { status: 'zero_risk' };
  const tp = long ? rs.entry + R_MULTIPLE * risk : rs.entry - R_MULTIPLE * risk;

  return {
    status: 'signal', direction: ts.direction,
    entry: rs.entry, sl, tp, entryTs: rs.entryTs,
    atr: pb.atr, pullbackExtreme: pb.pullbackExtreme,
  };
}
