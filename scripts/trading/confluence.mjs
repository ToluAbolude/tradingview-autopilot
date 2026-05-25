/**
 * confluence.mjs — Trifecta family mapper shared by decision_runner + inline_trader.
 *
 * The setup_finder emits strategies as single-letter codes (A, T, C, U, F, …).
 * For a decision-making algorithm to reason about confluence the same way a
 * human price-action trader does, those codes need to be grouped into the
 * three families taught in the Candlestick Bible:
 *
 *   TREND  → directional context (with-the-trend or counter-trend rejection)
 *   LEVEL  → price IS AT a meaningful structural level (S/R, FVG, OTE Fib, BB)
 *   SIGNAL → a confirming candle pattern printed at that level
 *
 * Plus a BONUS family for confirmations that strengthen — but don't replace — the
 * three core families: volume, session, RSI extreme, daily bias alignment.
 *
 * High-quality entries satisfy all three. Mediocre signals miss one or more.
 */

export const FAMILIES = {
  TREND:  ['A', 'T', 'B', 'L', 'FL'],                                    // SmartTrail, Weekly, EMA stack, Trendline, Flag (continuation)
  LEVEL:  ['C', 'C-near', 'U', 'F', 'O', 'BB', 'TB', 'TT', 'OR'],       // S/R zone, PDH/PDL, FVG, OTE Fib, BB; Triple Top/Bottom; Opening Range boundary
  SIGNAL: ['K', 'H', 'HS', 'IHS', 'TB', 'TT', 'OR'],                    // Candle pattern, HA pullback; chart-pattern reversals; OR breakout candle
  BONUS:  ['V', 'P', 'R', 'D'],                                          // Volume, Prime session, RSI extreme, Daily bias
};

/**
 * Map a list of strategy codes to family hits.
 * @param {string[]} strategies
 * @returns {{trend:string[], level:string[], signal:string[], bonus:string[]}}
 */
export function familiesFor(strategies = []) {
  const result = { trend: [], level: [], signal: [], bonus: [] };
  for (const s of strategies) {
    if (FAMILIES.TREND.includes(s))   result.trend.push(s);
    if (FAMILIES.LEVEL.includes(s))   result.level.push(s);
    if (FAMILIES.SIGNAL.includes(s))  result.signal.push(s);
    if (FAMILIES.BONUS.includes(s))   result.bonus.push(s);
  }
  return result;
}

/**
 * Does this signal satisfy the Trifecta (Trend + Level + Signal)?
 */
export function hasTrifecta(strategies = []) {
  const f = familiesFor(strategies);
  return f.trend.length > 0 && f.level.length > 0 && f.signal.length > 0;
}

/**
 * Human-readable confluence summary, e.g. "Trend:A,T | Level:C,F | Signal:K".
 */
export function describeConfluence(strategies = []) {
  const f = familiesFor(strategies);
  const parts = [];
  parts.push(`Trend:${f.trend.join(',') || '—'}`);
  parts.push(`Level:${f.level.join(',') || '—'}`);
  parts.push(`Signal:${f.signal.join(',') || '—'}`);
  if (f.bonus.length) parts.push(`Bonus:${f.bonus.join(',')}`);
  return parts.join(' | ');
}

/**
 * Trifecta count (how many of the 3 families have at least one hit).
 * 3 = full Trifecta, 2 = partial, 1 = weak, 0 = no structure.
 */
export function trifectaCount(strategies = []) {
  const f = familiesFor(strategies);
  return (f.trend.length > 0 ? 1 : 0) + (f.level.length > 0 ? 1 : 0) + (f.signal.length > 0 ? 1 : 0);
}
