/**
 * structure.mjs — market-structure helpers shared by the ported .pine strategies.
 * BOS/swings, S/R flip retest, ICT OTE fib zone, trendline fit, ET session gating.
 * All bars ascending {t,o,h,l,c,v}; indices align to the bars array passed in.
 */
import { findPivots } from '../../indicators.mjs';

// ── Session timezones ────────────────────────────────────────────────────────
// The .pine scripts gate on US Eastern kill-zones. We approximate ET = UTC−4
// (EDT, correct for ~Mar–Nov; ~1h off in deep winter). Documented + acceptable
// for a comparative lab. Returns minutes-of-day in ET.
export function etMinutes(tsMs) {
  const d = new Date(tsMs);
  const h = (d.getUTCHours() - 4 + 24) % 24;
  return h * 60 + d.getUTCMinutes();
}
export function inEtWindow(tsMs, startH, startM, endH, endM) {
  const m = etMinutes(tsMs);
  return m >= startH * 60 + startM && m <= endH * 60 + endM;
}

/**
 * Running confirmed-pivot arrays for the whole series. Each pivot is only "known"
 * at idx+len (no lookahead). Returns { highs, lows, lastHighAt(i), lastLowAt(i) }.
 */
export function swings(bars, len = 5) {
  const { highs, lows } = findPivots(bars, len);
  const lastAt = (arr) => (i) => {
    let best = null;
    for (const pv of arr) { if (pv.idx <= i - len) best = pv; else break; }
    return best;
  };
  return { highs, lows, lastHighAt: lastAt(highs), lastLowAt: lastAt(lows), len };
}

/**
 * Break of Structure at bar i: a close beyond the most recent confirmed swing.
 * Returns { dir:'long'|'short', level } when the CURRENT bar is the breaking bar.
 */
export function bosAt(bars, i, sw) {
  const ph = sw.lastHighAt(i), pl = sw.lastLowAt(i);
  const c = bars[i].c, cPrev = bars[i - 1]?.c;
  if (ph && cPrev != null && cPrev <= ph.price && c > ph.price) return { dir: 'long', level: ph.price };
  if (pl && cPrev != null && cPrev >= pl.price && c < pl.price) return { dir: 'short', level: pl.price };
  return null;
}

/** ICT OTE band [0.62,0.79] retracement of the last impulse leg, for `dir`. */
export function oteZone(swingLow, swingHigh, dir) {
  const range = swingHigh - swingLow;
  if (!(range > 0)) return null;
  if (dir === 'long') return { lo: swingHigh - range * 0.79, hi: swingHigh - range * 0.62 };
  return { lo: swingLow + range * 0.62, hi: swingLow + range * 0.79 };
}

/**
 * Fit a trendline through the last `count` confirmed pivots of one kind and test
 * for a breaking close at bar i. `kind`='high' (resistance, needs ≥minTouch lower
 * highs) or 'low' (support). Returns { value } projected level at i, or null.
 */
export function trendlineBreak(bars, i, pivots, kind, { count = 3, slopeMaxBars = 400 } = {}) {
  const recent = pivots.filter(p => p.idx <= i - 1).slice(-count);
  if (recent.length < count) return null;
  const a = recent[0], b = recent[recent.length - 1];
  if (b.idx - a.idx <= 0 || b.idx - a.idx > slopeMaxBars) return null;
  const slope = (b.price - a.price) / (b.idx - a.idx);
  const value = b.price + slope * (i - b.idx); // projected line level at bar i
  const c = bars[i].c, cPrev = bars[i - 1]?.c;
  if (kind === 'high' && slope <= 0 && cPrev != null && cPrev <= value && c > value) return { value, dir: 'long' };
  if (kind === 'low' && slope >= 0 && cPrev != null && cPrev >= value && c < value) return { value, dir: 'short' };
  return null;
}

/** Session high/low built from bars within an ET window on the same ET day. */
export function etSessionRange(dayBars, startH, startM, endH, endM) {
  const inWin = dayBars.filter(b => inEtWindow(b.t, startH, startM, endH, endM));
  if (!inWin.length) return null;
  return { high: Math.max(...inWin.map(b => b.h)), low: Math.min(...inWin.map(b => b.l)), bars: inWin };
}
