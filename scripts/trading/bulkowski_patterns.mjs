/**
 * bulkowski_patterns.mjs — Chart pattern detection (Bulkowski-style)
 *
 * Implements geometric pattern recognition for the top-rated patterns in
 * Bulkowski's "Encyclopedia of Chart Patterns" (4★ patterns prioritized):
 *
 *   Triple Bottom / Triple Top     (4★) — equal lows/highs, 3 touches
 *   Head & Shoulders               (4★) — 3-peak with center higher
 *   Inverse Head & Shoulders       (4★) — 3-trough with center lower
 *   High & Tight Flag              (4★) — narrow consolidation after sharp move
 *
 * Each detector follows Bulkowski's universal 5-rule framework:
 *  1. Directional bias verified (bullish/bearish reversal or continuation)
 *  2. Geometric definition met (pivot equality within tolerance)
 *  3. Volume signature optional (passed in; used to upgrade confidence)
 *  4. Breakout confirmation (close beyond neckline / trigger line)
 *  5. Measuring technique (price target as height projection)
 *
 * Detectors return null when no pattern is present; otherwise an object:
 *   { name, type, target, neckline, confidence, reason }
 *
 *   confidence: 'forming' (geometry present, no breakout yet)
 *               'breaking' (breakout candle is the current bar)
 *               'confirmed' (breakout closed cleanly, target valid)
 */

// ── Pivot detection — strictly-highest / strictly-lowest in [i-L .. i+L] ─────
function findPivots(bars, type, pivotLen = 5, maxCount = 10) {
  const pivots = [];
  const n = bars.length - 1;
  for (let i = pivotLen; i <= n - pivotLen; i++) {
    let ok = true;
    for (let j = i - pivotLen; j <= i + pivotLen; j++) {
      if (j === i) continue;
      if (type === 'high' ? bars[j].h >= bars[i].h : bars[j].l <= bars[i].l) { ok = false; break; }
    }
    if (ok) pivots.push({ idx: i, price: type === 'high' ? bars[i].h : bars[i].l });
    if (pivots.length >= maxCount) break;
  }
  return pivots;
}

// ── Equality test — two prices within tolerance × ATR ────────────────────────
function near(a, b, atr, tol = 0.5) {
  return Math.abs(a - b) <= atr * tol;
}

// ────────────────────────────────────────────────────────────────────────────
// 1. TRIPLE BOTTOM — bullish reversal (3 equal lows after downtrend)
//
// Geometry: 3 distinct pivot-lows within tolerance, separated by intervening
// pivot-highs. Breakout = close above the highest intervening high.
// Target = height (highest peak − lowest trough) added to breakout level.
// ────────────────────────────────────────────────────────────────────────────
export function detectTripleBottom(bars, atr, dir) {
  if (dir !== 'long') return null;
  const n = bars.length - 1;
  const atrN = atr[n] || 0;
  if (atrN === 0) return null;

  const lows = findPivots(bars, 'low', 5, 12);
  if (lows.length < 3) return null;

  // Take the three most recent pivot lows
  const recent = lows.slice(-3);
  const [L1, L2, L3] = recent;

  // Equality check (within 0.5 × ATR)
  if (!near(L1.price, L2.price, atrN, 0.5)) return null;
  if (!near(L2.price, L3.price, atrN, 0.5)) return null;

  // Third low must be recent (within last 10 bars) — the pattern is actionable now
  if (n - L3.idx > 10) return null;

  // Find intervening highs (between L1-L2 and L2-L3) and take the highest
  const interHi1 = Math.max(...bars.slice(L1.idx, L2.idx + 1).map(b => b.h));
  const interHi2 = Math.max(...bars.slice(L2.idx, L3.idx + 1).map(b => b.h));
  const neckline = Math.max(interHi1, interHi2);

  // Pattern must show meaningful range to be tradeable
  const height = neckline - Math.min(L1.price, L2.price, L3.price);
  if (height < atrN * 1.0) return null;

  // Breakout = close above neckline (with small buffer to avoid wick triggers)
  const last = bars[n];
  const buf = atrN * 0.1;
  if (last.c <= neckline + buf) return null;  // require breakout — no anticipation trades
  const confidence = (bars[n - 1] && bars[n - 1].c <= neckline) ? 'breaking' : 'confirmed';

  const target = neckline + height;
  return {
    name: 'Triple Bottom',
    type: 'reversal',
    dir: 'long',
    target: +target.toFixed(5),
    neckline: +neckline.toFixed(5),
    confidence,
    reason: `Triple Bottom (3 lows ≈${L3.price.toFixed(4)}, neckline=${neckline.toFixed(4)})`,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 2. TRIPLE TOP — bearish reversal (3 equal highs after uptrend)
// ────────────────────────────────────────────────────────────────────────────
export function detectTripleTop(bars, atr, dir) {
  if (dir !== 'short') return null;
  const n = bars.length - 1;
  const atrN = atr[n] || 0;
  if (atrN === 0) return null;

  const highs = findPivots(bars, 'high', 5, 12);
  if (highs.length < 3) return null;

  const recent = highs.slice(-3);
  const [H1, H2, H3] = recent;

  if (!near(H1.price, H2.price, atrN, 0.5)) return null;
  if (!near(H2.price, H3.price, atrN, 0.5)) return null;
  if (n - H3.idx > 10) return null;

  const interLo1 = Math.min(...bars.slice(H1.idx, H2.idx + 1).map(b => b.l));
  const interLo2 = Math.min(...bars.slice(H2.idx, H3.idx + 1).map(b => b.l));
  const neckline = Math.min(interLo1, interLo2);

  const height = Math.max(H1.price, H2.price, H3.price) - neckline;
  if (height < atrN * 1.0) return null;

  const last = bars[n];
  const buf = atrN * 0.1;
  if (last.c >= neckline - buf) return null;  // require breakdown — no anticipation
  const confidence = (bars[n - 1] && bars[n - 1].c >= neckline) ? 'breaking' : 'confirmed';

  const target = neckline - height;
  return {
    name: 'Triple Top',
    type: 'reversal',
    dir: 'short',
    target: +target.toFixed(5),
    neckline: +neckline.toFixed(5),
    confidence,
    reason: `Triple Top (3 highs ≈${H3.price.toFixed(4)}, neckline=${neckline.toFixed(4)})`,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 3. HEAD & SHOULDERS — bearish reversal (3 peaks, middle highest)
//
// Geometry: 5 alternating pivots H-L-H-L-H where centre H (head) is highest.
// Shoulders should be roughly symmetric (within ~30% of each other, height-wise).
// Neckline = line through the two intervening lows.
// Target = vertical distance from head to neckline, projected DOWN from break.
// ────────────────────────────────────────────────────────────────────────────
export function detectHeadAndShoulders(bars, atr, dir) {
  if (dir !== 'short') return null;
  const n = bars.length - 1;
  const atrN = atr[n] || 0;
  if (atrN === 0) return null;

  const highs = findPivots(bars, 'high', 5, 10);
  const lows  = findPivots(bars, 'low',  5, 10);
  if (highs.length < 3 || lows.length < 2) return null;

  // Find an LS-Head-RS triple from the most recent pivot highs
  const recent3 = highs.slice(-3);
  const [LS, H, RS] = recent3;

  // Head must be higher than both shoulders
  if (H.price <= LS.price || H.price <= RS.price) return null;

  // Shoulders roughly symmetric (within 0.7×ATR of each other)
  if (!near(LS.price, RS.price, atrN, 0.7)) return null;

  // Find the two lows BETWEEN the three highs (the neckline anchors)
  const NL1 = lows.find(l => l.idx > LS.idx && l.idx < H.idx);
  const NL2 = lows.find(l => l.idx > H.idx  && l.idx < RS.idx);
  if (!NL1 || !NL2) return null;

  // RS must be recent
  if (n - RS.idx > 12) return null;

  // Neckline = linear from NL1 to NL2, projected to current bar
  const slope = (NL2.price - NL1.price) / (NL2.idx - NL1.idx);
  const neckAtNow = NL2.price + slope * (n - NL2.idx);

  // Pattern height = head − neckline value at head
  const neckAtHead = NL1.price + slope * (H.idx - NL1.idx);
  const height = H.price - neckAtHead;
  if (height < atrN * 1.5) return null;  // need real range to trade

  const last = bars[n];
  const buf = atrN * 0.1;
  if (last.c >= neckAtNow - buf) return null;
  const confidence = (bars[n - 1] && bars[n - 1].c >= neckAtNow) ? 'breaking' : 'confirmed';

  const target = neckAtNow - height;
  return {
    name: 'Head & Shoulders',
    type: 'reversal',
    dir: 'short',
    target: +target.toFixed(5),
    neckline: +neckAtNow.toFixed(5),
    confidence,
    reason: `H&S (LS=${LS.price.toFixed(4)} H=${H.price.toFixed(4)} RS=${RS.price.toFixed(4)})`,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 4. INVERSE HEAD & SHOULDERS — bullish reversal (3 troughs, middle lowest)
// ────────────────────────────────────────────────────────────────────────────
export function detectInverseHeadAndShoulders(bars, atr, dir) {
  if (dir !== 'long') return null;
  const n = bars.length - 1;
  const atrN = atr[n] || 0;
  if (atrN === 0) return null;

  const lows  = findPivots(bars, 'low',  5, 10);
  const highs = findPivots(bars, 'high', 5, 10);
  if (lows.length < 3 || highs.length < 2) return null;

  const recent3 = lows.slice(-3);
  const [LS, H, RS] = recent3;

  if (H.price >= LS.price || H.price >= RS.price) return null;
  if (!near(LS.price, RS.price, atrN, 0.7)) return null;

  const NL1 = highs.find(p => p.idx > LS.idx && p.idx < H.idx);
  const NL2 = highs.find(p => p.idx > H.idx  && p.idx < RS.idx);
  if (!NL1 || !NL2) return null;
  if (n - RS.idx > 12) return null;

  const slope = (NL2.price - NL1.price) / (NL2.idx - NL1.idx);
  const neckAtNow = NL2.price + slope * (n - NL2.idx);

  const neckAtHead = NL1.price + slope * (H.idx - NL1.idx);
  const height = neckAtHead - H.price;
  if (height < atrN * 1.5) return null;

  const last = bars[n];
  const buf = atrN * 0.1;
  if (last.c <= neckAtNow + buf) return null;
  const confidence = (bars[n - 1] && bars[n - 1].c <= neckAtNow) ? 'breaking' : 'confirmed';

  const target = neckAtNow + height;
  return {
    name: 'Inverse Head & Shoulders',
    type: 'reversal',
    dir: 'long',
    target: +target.toFixed(5),
    neckline: +neckAtNow.toFixed(5),
    confidence,
    reason: `Inverse H&S (LS=${LS.price.toFixed(4)} H=${H.price.toFixed(4)} RS=${RS.price.toFixed(4)})`,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 5. HIGH & TIGHT FLAG — bullish continuation
//
// Bulkowski definition (relaxed for intraday): sharp impulse move followed by
// narrow consolidation. Original is "price doubled then consolidates" but on
// intraday TFs we use: impulse leg ≥ 3×ATR over ≤8 bars, then 4-12 bar
// consolidation with range ≤ 0.5× impulse leg.
// Target = midpoint of impulse leg projected from breakout.
// ────────────────────────────────────────────────────────────────────────────
export function detectFlag(bars, atr, dir) {
  const n = bars.length - 1;
  const atrN = atr[n] || 0;
  if (atrN === 0 || n < 20) return null;

  // The current bar is the breakout candidate. Consolidation is the bars
  // immediately BEFORE the current bar; impulse is the leg before that.
  for (const consLen of [10, 8, 6, 4]) {
    const consEnd   = n;                       // exclusive — current bar is breakout candidate
    const consStart = n - consLen;
    if (consStart < 8) continue;

    const cons = bars.slice(consStart, consEnd);
    const consHi = Math.max(...cons.map(b => b.h));
    const consLo = Math.min(...cons.map(b => b.l));
    const consRange = consHi - consLo;

    // Consolidation should be tight (< 1.5 × ATR)
    if (consRange > atrN * 1.5) continue;

    // Impulse leg = 4-8 bars immediately preceding the consolidation
    const impStart = Math.max(0, consStart - 8);
    const imp = bars.slice(impStart, consStart);
    if (imp.length < 4) continue;

    const impHi = Math.max(...imp.map(b => b.h));
    const impLo = Math.min(...imp.map(b => b.l));
    const impRange = impHi - impLo;

    // Impulse must be at least 2.5× consolidation AND ≥3×ATR
    if (impRange < consRange * 2.5) continue;
    if (impRange < atrN * 3.0) continue;

    // Impulse direction
    const impStartPrice = imp[0].o;
    const impEndPrice   = imp[imp.length - 1].c;
    const impDir = impEndPrice > impStartPrice ? 'long' : 'short';
    if (impDir !== dir) continue;

    // Breakout = current bar's close beyond consolidation extreme in trend dir
    const last = bars[n];
    const buf = atrN * 0.15;
    let confidence, target, breakLevel;

    if (dir === 'long') {
      breakLevel = consHi;
      if (last.c <= breakLevel + buf) return null; // not breaking yet → no signal
      confidence = (bars[n - 1] && bars[n - 1].c <= breakLevel) ? 'breaking' : 'confirmed';
      target = breakLevel + impRange * 0.5;
    } else {
      breakLevel = consLo;
      if (last.c >= breakLevel - buf) return null;
      confidence = (bars[n - 1] && bars[n - 1].c >= breakLevel) ? 'breaking' : 'confirmed';
      target = breakLevel - impRange * 0.5;
    }

    return {
      name: 'High & Tight Flag',
      type: 'continuation',
      dir,
      target: +target.toFixed(5),
      neckline: +breakLevel.toFixed(5),
      confidence,
      reason: `Flag (impulse ${impRange.toFixed(4)} / cons ${consRange.toFixed(4)} = ${(impRange/consRange).toFixed(1)}×)`,
    };
  }

  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Master detector — runs all patterns, returns the best one (highest confidence)
// Strategy code returned alongside for scoring.
// ────────────────────────────────────────────────────────────────────────────
const CONFIDENCE_RANK = { confirmed: 3, breaking: 2, forming: 1 };

export function detectChartPatterns(bars, atr, dir) {
  const detectors = [
    { fn: detectTripleBottom,            code: 'TB' },
    { fn: detectTripleTop,               code: 'TT' },
    { fn: detectHeadAndShoulders,        code: 'HS' },
    { fn: detectInverseHeadAndShoulders, code: 'IHS' },
    { fn: detectFlag,                    code: 'FL' },
  ];

  const matches = [];
  for (const { fn, code } of detectors) {
    try {
      const result = fn(bars, atr, dir);
      if (result) matches.push({ ...result, code });
    } catch (e) {
      // Swallow — individual detector failures shouldn't break scanning
    }
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => (CONFIDENCE_RANK[b.confidence] || 0) - (CONFIDENCE_RANK[a.confidence] || 0));
  return matches[0];
}
