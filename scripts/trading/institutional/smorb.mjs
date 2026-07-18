// SMORB — Session Momentum Opening Range Breakout (SPEC.md §1). Family B.
// PURE module: bars in, signal out. The backtest and the live runner both call
// computeSmorbSignal — one code path, per the Stage-2 fidelity requirement.
import { median } from './lib.mjs';

export const OR_MINUTES = 15;           // first 15 min of session = 3 × M5
export const ENTRY_WINDOW_MS = 3 * 3600_000; // stop orders expire 3h after open
export const REL_VOL_MIN = 1.5;         // in-play gates (calibratable IN-SAMPLE ONLY)
export const REL_RANGE_MIN = 1.0;
export const MIN_HISTORY_SESSIONS = 10;

/** Extract the opening-range from M5 bars. Requires ≥2 of the 3 OR bars. */
export function orWindow(bars5m, sessionOpenMs) {
  const end = sessionOpenMs + OR_MINUTES * 60_000;
  const orBars = bars5m.filter(b => b.t >= sessionOpenMs && b.t < end);
  if (orBars.length < 2) return { complete: false, orBars };
  return {
    complete: true, orBars,
    orHigh: Math.max(...orBars.map(b => b.h)),
    orLow: Math.min(...orBars.map(b => b.l)),
    orVol: orBars.reduce((s, b) => s + (b.v || 0), 0),
  };
}

/** The "in play" filter — session must be abnormally active (SPEC §1). */
export function smorbGate({ orVol, orRange, priorVols, priorRanges }) {
  if (priorVols.length < MIN_HISTORY_SESSIONS) return { pass: false, reason: 'insufficient_history' };
  const mv = median(priorVols), mr = median(priorRanges);
  if (!(mv > 0) || !(mr > 0)) return { pass: false, reason: 'bad_history' };
  const relVol = orVol / mv, relRange = orRange / mr;
  if (relVol < REL_VOL_MIN) return { pass: false, reason: 'rel_vol', relVol, relRange };
  if (relRange < REL_RANGE_MIN) return { pass: false, reason: 'rel_range', relVol, relRange };
  return { pass: true, relVol, relRange };
}

/**
 * Walk post-OR bars for the FIRST breakout (stop-order semantics; gap fills at
 * bar open). A single bar crossing BOTH entry levels before either fired is
 * unknowable at M5 granularity → ambiguous, no trade (conservative).
 */
export function resolveSmorbEntry({ postBars, longEntry, shortEntry, expiryMs }) {
  for (let i = 0; i < postBars.length; i++) {
    const b = postBars[i];
    if (b.t >= expiryMs) return { status: 'no_breakout' };
    const hitLong = b.h >= longEntry;
    const hitShort = b.l <= shortEntry;
    if (hitLong && hitShort) return { status: 'ambiguous', t: b.t };
    if (hitLong) return { status: 'entered', direction: 'long', entryPrice: Math.max(longEntry, b.o), entryTs: b.t, entryIdx: i };
    if (hitShort) return { status: 'entered', direction: 'short', entryPrice: Math.min(shortEntry, b.o), entryTs: b.t, entryIdx: i };
  }
  return { status: 'no_breakout' };
}

/**
 * Full SMORB evaluation for one symbol-session.
 * bars5m must cover the session; priorOrStats = { vols: [], ranges: [] } from the
 * prior 20 sessions (caller assembles — keeps this pure).
 * Returns { status, ... } — status 'signal' carries direction/entry/sl/tp.
 */
export function computeSmorbSignal({ bars5m, sessionOpenMs, priorOrStats, tickSize = 0, rMultiple = 2 }) {
  const or = orWindow(bars5m, sessionOpenMs);
  if (!or.complete) return { status: 'no_or_data' };
  const orRange = or.orHigh - or.orLow;
  if (!(orRange > 0)) return { status: 'zero_range' };

  const gate = smorbGate({ orVol: or.orVol, orRange, priorVols: priorOrStats.vols, priorRanges: priorOrStats.ranges });
  if (!gate.pass) return { status: 'no_gate', reason: gate.reason, relVol: gate.relVol, relRange: gate.relRange };

  const longEntry = or.orHigh + tickSize;
  const shortEntry = or.orLow - tickSize;
  const orEnd = sessionOpenMs + OR_MINUTES * 60_000;
  const postBars = bars5m.filter(b => b.t >= orEnd);
  const res = resolveSmorbEntry({ postBars, longEntry, shortEntry, expiryMs: sessionOpenMs + ENTRY_WINDOW_MS });
  if (res.status !== 'entered') return { status: res.status, relVol: gate.relVol, relRange: gate.relRange };

  const long = res.direction === 'long';
  const sl = long ? or.orLow : or.orHigh;
  const risk = Math.abs(res.entryPrice - sl);
  if (!(risk > 0)) return { status: 'zero_risk' };
  const tp = long ? res.entryPrice + rMultiple * risk : res.entryPrice - rMultiple * risk;

  return {
    status: 'signal', direction: res.direction,
    entry: res.entryPrice, sl, tp,
    entryTs: res.entryTs, entryIdx: res.entryIdx,
    orHigh: or.orHigh, orLow: or.orLow,
    relVol: gate.relVol, relRange: gate.relRange,
  };
}
