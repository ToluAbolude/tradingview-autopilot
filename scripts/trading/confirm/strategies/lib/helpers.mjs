/**
 * helpers.mjs — shared signal-construction utilities for strategy modules.
 * Keeps the per-strategy files focused on their actual entry logic.
 */
import { utcMinutes, dayKeyUTC } from '../../indicators.mjs';

// Re-export so strategy modules can pull candle/body helpers from one place.
export { bodyRatio } from '../../indicators.mjs';

/** Stop price `mult`×ATR away from entry, on the protective side for `dir`. */
export function slFromAtr(entry, dir, atr, mult) {
  return dir === 'long' ? entry - mult * atr : entry + mult * atr;
}

/** R:R check — true when the (entry,sl,tpPrice) triplet meets minRR. */
export function meetsRR(entry, sl, tpPrice, minRR) {
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return false;
  return Math.abs(tpPrice - entry) / risk >= minRR;
}

/** Parse a "HH:MM" UTC session open into minutes-of-day. */
export function openMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

/** Group ascending bars by UTC calendar day → Map<'YYYY-MM-DD', bars[]>. */
export function groupByUtcDay(bars) {
  const m = new Map();
  for (const b of bars) {
    const k = dayKeyUTC(b.t);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(b);
  }
  return m;
}

/** True if bar `b` falls within [openMin, openMin+windowMin) minutes UTC. */
export function inWindow(b, openMin, windowMin) {
  const t = utcMinutes(b.t);
  return t >= openMin && t < openMin + windowMin;
}

/** Bullish/bearish engulfing or pin-bar signal at index i (1 = bull, -1 = bear, 0 = none). */
export function candleSignal(bars, i) {
  if (i < 1) return 0;
  const b = bars[i], p = bars[i - 1];
  const range = b.h - b.l || 1e-9;
  const body = Math.abs(b.c - b.o);
  const upWick = b.h - Math.max(b.o, b.c);
  const dnWick = Math.min(b.o, b.c) - b.l;
  // Engulfing
  const bullEng = b.c > b.o && p.c < p.o && b.c >= p.o && b.o <= p.c;
  const bearEng = b.c < b.o && p.c > p.o && b.c <= p.o && b.o >= p.c;
  // Pin bars (rejection)
  const bullPin = dnWick > body * 2 && dnWick / range > 0.5;
  const bearPin = upWick > body * 2 && upWick / range > 0.5;
  if (bullEng || bullPin) return 1;
  if (bearEng || bearPin) return -1;
  return 0;
}
