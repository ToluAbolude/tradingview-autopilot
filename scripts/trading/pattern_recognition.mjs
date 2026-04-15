/**
 * pattern_recognition.mjs
 * Statistical pattern matching on OHLCV data.
 *
 * How it works (mirrors how LLMs predict next tokens from context):
 *  1. Encode the last N candles as a "fingerprint" (sequence of up/down/doji + relative size)
 *  2. Scan ALL historical bars to find the same fingerprint pattern
 *  3. Count what happened AFTER each historical match (up / down / flat)
 *  4. Return probability of next move direction + expected magnitude
 *
 * This is essentially n-gram probability on price action sequences.
 */

// Encode a single candle into a compact descriptor
function encodeCandle(candle, atr) {
  const body = candle.c - candle.o;
  const range = candle.h - candle.l;
  const bodyRatio = range > 0 ? Math.abs(body) / range : 0;

  let type;
  if (bodyRatio < 0.25)       type = 'D'; // Doji / indecision
  else if (body > 0)          type = 'B'; // Bullish
  else                        type = 'S'; // Bearish (short)

  // Size relative to ATR
  let size;
  const rel = range / (atr || 1);
  if (rel < 0.5)      size = 's'; // small
  else if (rel < 1.2) size = 'm'; // medium
  else                size = 'L'; // large

  return type + size;
}

// Build ATR array (EMA of true range)
function buildATR(bars, len = 14) {
  const atr = [];
  for (let i = 0; i < bars.length; i++) {
    const tr = i === 0 ? bars[i].h - bars[i].l :
      Math.max(bars[i].h - bars[i].l,
               Math.abs(bars[i].h - bars[i - 1].c),
               Math.abs(bars[i].l - bars[i - 1].c));
    atr.push(i < len ? tr : (atr[i - 1] * (len - 1) + tr) / len);
  }
  return atr;
}

// Encode bars into pattern sequence
export function encodePattern(bars, lookback = 4) {
  const atr = buildATR(bars);
  const encoded = bars.map((b, i) => encodeCandle(b, atr[i]));
  // Return the last `lookback` candles as a pattern string
  return encoded.slice(-lookback).join('');
}

// Scan history for matching patterns and compute outcome probabilities
export function matchPattern(bars, lookback = 4, forwardBars = 3) {
  if (bars.length < lookback + forwardBars + 20) {
    return { probability: null, sampleSize: 0, reason: 'insufficient data' };
  }

  const atr = buildATR(bars);
  const encoded = bars.map((b, i) => encodeCandle(b, atr[i]));

  // Current pattern = last `lookback` candles
  const currentPattern = encoded.slice(-lookback).join('');
  const currentPrice   = bars[bars.length - 1].c;

  const outcomes = { up: 0, down: 0, flat: 0, totalMove: 0 };
  const matchedMoves = [];

  // Scan history (exclude last lookback+1 bars to avoid self-match)
  for (let i = lookback; i < bars.length - forwardBars - 1; i++) {
    const histPattern = encoded.slice(i - lookback, i).join('');
    if (histPattern !== currentPattern) continue;

    // What happened in the next `forwardBars` bars?
    const entryPrice = bars[i].c;
    const maxHigh    = Math.max(...bars.slice(i, i + forwardBars).map(b => b.h));
    const minLow     = Math.min(...bars.slice(i, i + forwardBars).map(b => b.l));
    const exitPrice  = bars[i + forwardBars].c;

    const move = exitPrice - entryPrice;
    const movePct = (move / entryPrice) * 100;

    outcomes.totalMove += movePct;
    matchedMoves.push(movePct);

    if (Math.abs(movePct) < 0.05) outcomes.flat++;
    else if (move > 0)            outcomes.up++;
    else                          outcomes.down++;
  }

  const total = outcomes.up + outcomes.down + outcomes.flat;
  if (total < 3) return { probability: null, sampleSize: total, pattern: currentPattern, reason: 'too few matches' };

  const probUp   = outcomes.up   / total;
  const probDown = outcomes.down / total;
  const avgMove  = outcomes.totalMove / total;

  // Median move for expected magnitude
  matchedMoves.sort((a, b) => a - b);
  const medianMove = matchedMoves[Math.floor(matchedMoves.length / 2)];

  const direction  = probUp > probDown ? 'long' : 'short';
  const confidence = Math.max(probUp, probDown); // 0.5 = coin flip, 1.0 = certain

  return {
    pattern:     currentPattern,
    sampleSize:  total,
    probUp:      Math.round(probUp   * 100),
    probDown:    Math.round(probDown * 100),
    avgMovePct:  Math.round(avgMove  * 100) / 100,
    medianMovePct: Math.round(medianMove * 100) / 100,
    direction,
    confidence:  Math.round(confidence * 100), // as %
    edge:        Math.round((confidence - 0.5) * 200), // 0 = no edge, 100 = perfect edge
    currentPrice,
  };
}

// ── Multi-timeframe pattern score ──
// Returns +1 if pattern says long, -1 if short, 0 if unclear
export function patternScore(bars, minConfidence = 60, minSamples = 5) {
  const result = matchPattern(bars, 4, 3);
  if (!result.probability === null && result.sampleSize < minSamples) return { score: 0, result };
  if (result.confidence < minConfidence) return { score: 0, result };
  return {
    score:  result.direction === 'long' ? 1 : -1,
    result,
  };
}

// ── Candle pattern library (named patterns) ──
export function detectNamedPatterns(bars) {
  if (bars.length < 3) return [];
  const patterns = [];
  const n = bars.length - 1;
  const c = bars[n], p1 = bars[n - 1], p2 = bars[n - 2];
  const atr = buildATR(bars)[n];

  // Pin bar (hammer / shooting star)
  const cRange = c.h - c.l;
  const cBody  = Math.abs(c.c - c.o);
  if (cRange > 0) {
    const lowerWick = Math.min(c.o, c.c) - c.l;
    const upperWick = c.h - Math.max(c.o, c.c);
    if (lowerWick > cBody * 2 && lowerWick > upperWick * 2)
      patterns.push({ name: 'Hammer', direction: 'long', reliability: 68 });
    if (upperWick > cBody * 2 && upperWick > lowerWick * 2)
      patterns.push({ name: 'Shooting Star', direction: 'short', reliability: 65 });
  }

  // Engulfing
  const prevBull = p1.c > p1.o, prevBear = p1.c < p1.o;
  const currBull = c.c > c.o,   currBear = c.c < c.o;
  if (prevBear && currBull && c.o < p1.c && c.c > p1.o)
    patterns.push({ name: 'Bullish Engulfing', direction: 'long',  reliability: 71 });
  if (prevBull && currBear && c.o > p1.c && c.c < p1.o)
    patterns.push({ name: 'Bearish Engulfing', direction: 'short', reliability: 69 });

  // Doji
  if (cRange > 0 && cBody / cRange < 0.2)
    patterns.push({ name: 'Doji', direction: 'neutral', reliability: 60 });

  // Morning / Evening Star
  const p1Range = p1.h - p1.l;
  const p1Body  = Math.abs(p1.c - p1.o);
  if (p1Range > 0 && p1Body / p1Range < 0.3) { // middle doji
    if (p2.c < p2.o && c.c > c.o && c.c > (p2.o + p2.c) / 2)
      patterns.push({ name: 'Morning Star', direction: 'long',  reliability: 68 });
    if (p2.c > p2.o && c.c < c.o && c.c < (p2.o + p2.c) / 2)
      patterns.push({ name: 'Evening Star', direction: 'short', reliability: 66 });
  }

  // Inside bar
  if (c.h <= p1.h && c.l >= p1.l)
    patterns.push({ name: 'Inside Bar', direction: 'neutral', reliability: 58 });

  // Three consecutive candles (strong momentum)
  if (p2.c > p2.o && p1.c > p1.o && c.c > c.o)
    patterns.push({ name: '3 Bull Run', direction: 'long',  reliability: 62 });
  if (p2.c < p2.o && p1.c < p1.o && c.c < c.o)
    patterns.push({ name: '3 Bear Run', direction: 'short', reliability: 62 });

  return patterns;
}

// ── CLI usage ──
if (process.argv[1].endsWith('pattern_recognition.mjs')) {
  // Demo with synthetic data
  console.log('Pattern Recognition module loaded. Import and use matchPattern(bars) with real OHLCV data.');
}
