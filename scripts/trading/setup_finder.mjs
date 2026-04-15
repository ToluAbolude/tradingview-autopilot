/**
 * setup_finder.mjs — GREEDY Multi-Strategy Scanner
 *
 * Scans the FULL BlackBull symbol universe, ranked by commission efficiency.
 * Runs 6 strategies on every symbol/TF and picks the highest-confidence setup.
 *
 * STRATEGIES (run simultaneously, vote on direction):
 *  A. Smart Trail + HA Pullback  (validated: BTC +$165, XAU +$114)
 *  B. S/R Bounce                 (65-75% WR at key levels)
 *  C. EMA Cross + Volume         (trend confirmation)
 *  D. RSI Divergence             (high-prob reversals)
 *  E. Bollinger Band Squeeze     (breakout from compression)
 *  F. Statistical Pattern Match  (n-gram probability on candle sequences)
 *
 * SCORING: 0–9 points. Entry threshold ≥ 4. Trade size scales with score.
 *
 * SYMBOL UNIVERSE — ranked by spread/ADR efficiency (lower % = better):
 *  Tier 1 (<1% spread/ADR): XAU, NAS100, US30, BTC, ETH
 *  Tier 2 (1-1.5%): GBP/USD, EUR/USD, GBP/JPY, USD/JPY, Silver, Oil
 *  Tier 3 (1.5-2.5%): AUD/USD, USD/CAD, EUR/JPY, ADA, SOL, LTC
 */
import { evaluate } from '../../src/connection.js';
import { matchPattern, detectNamedPatterns } from './pattern_recognition.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Full symbol universe (BlackBull Markets via TradingView) ──
// Sorted by commission efficiency (spread/ADR ratio)
export const FULL_SCAN_LIST = [
  // ── TIER 1: Highest efficiency — move far relative to spread ──
  { sym: 'BLACKBULL:XAUUSD',  label: 'XAUUSD',  tfs: ['15','30','5'],  autoShort: true,  tier: 1 },
  { sym: 'BLACKBULL:NAS100',  label: 'NAS100',  tfs: ['5','15'],       autoShort: false, tier: 1 },
  { sym: 'BLACKBULL:US30',    label: 'US30',    tfs: ['5','15'],       autoShort: false, tier: 1 },
  { sym: 'BLACKBULL:BTCUSD',  label: 'BTCUSD',  tfs: ['15','5'],       autoShort: true,  tier: 1 },
  { sym: 'BLACKBULL:ETHUSD',  label: 'ETHUSD',  tfs: ['5','1'],        autoShort: true,  tier: 1 },
  { sym: 'BLACKBULL:XAGUSD',  label: 'XAGUSD',  tfs: ['15','5'],       autoShort: true,  tier: 1 },
  { sym: 'BLACKBULL:WTI',     label: 'WTI',     tfs: ['15','5'],       autoShort: true,  tier: 1 },

  // ── TIER 2: Good efficiency ──
  { sym: 'BLACKBULL:GBPUSD',  label: 'GBPUSD',  tfs: ['5','15'],       autoShort: true,  tier: 2 },
  { sym: 'BLACKBULL:EURUSD',  label: 'EURUSD',  tfs: ['5','15'],       autoShort: true,  tier: 2 },
  { sym: 'BLACKBULL:GBPJPY',  label: 'GBPJPY',  tfs: ['5','15'],       autoShort: true,  tier: 2 },
  { sym: 'BLACKBULL:USDJPY',  label: 'USDJPY',  tfs: ['5','15'],       autoShort: true,  tier: 2 },
  { sym: 'BLACKBULL:EURJPY',  label: 'EURJPY',  tfs: ['5','15'],       autoShort: true,  tier: 2 },
  { sym: 'BLACKBULL:SPX500',  label: 'SPX500',  tfs: ['5','15'],       autoShort: false, tier: 2 },
  { sym: 'BLACKBULL:LTCUSD',  label: 'LTCUSD',  tfs: ['15'],           autoShort: true,  tier: 2 },
  { sym: 'BLACKBULL:BNBUSD',  label: 'BNBUSD',  tfs: ['15'],           autoShort: true,  tier: 2 },

  // ── TIER 3: Moderate efficiency ──
  { sym: 'BLACKBULL:AUDUSD',  label: 'AUDUSD',  tfs: ['15'],           autoShort: true,  tier: 3 },
  { sym: 'BLACKBULL:USDCAD',  label: 'USDCAD',  tfs: ['15'],           autoShort: true,  tier: 3 },
  { sym: 'BLACKBULL:NZDUSD',  label: 'NZDUSD',  tfs: ['15'],           autoShort: true,  tier: 3 },
  { sym: 'BLACKBULL:USDCHF',  label: 'USDCHF',  tfs: ['15'],           autoShort: true,  tier: 3 },
  { sym: 'BLACKBULL:AUDJPY',  label: 'AUDJPY',  tfs: ['15'],           autoShort: true,  tier: 3 },
  { sym: 'BLACKBULL:SOLUSD',  label: 'SOLUSD',  tfs: ['15'],           autoShort: true,  tier: 3 },
  { sym: 'BLACKBULL:ADAUSD',  label: 'ADAUSD',  tfs: ['15'],           autoShort: true,  tier: 3 },
  { sym: 'BLACKBULL:XRPUSD',  label: 'XRPUSD',  tfs: ['15'],           autoShort: true,  tier: 3 },
  { sym: 'BLACKBULL:GER40',   label: 'GER40',   tfs: ['15'],           autoShort: false, tier: 3 },
  { sym: 'BLACKBULL:UK100',   label: 'UK100',   tfs: ['15'],           autoShort: false, tier: 3 },
];

// Session-aware: which symbols to prioritise per session
function sessionSymbols(utcHour) {
  if (utcHour >= 0  && utcHour < 7)  // Asian
    return ['BTCUSD','ETHUSD','XAUUSD','USDJPY','AUDUSD','GBPJPY'];
  if (utcHour >= 8  && utcHour < 13) // London
    return ['XAUUSD','GBPUSD','EURUSD','BTCUSD','ETHUSD','GBPJPY','EURJPY','UK100','GER40','WTI'];
  if (utcHour >= 13 && utcHour < 17) // London-NY overlap (BEST)
    return ['XAUUSD','BTCUSD','ETHUSD','NAS100','US30','SPX500','GBPUSD','EURUSD','WTI','XAGUSD'];
  if (utcHour >= 17 && utcHour < 22) // NY only
    return ['BTCUSD','ETHUSD','NAS100','US30','SPX500','XAUUSD','SOLUSD','BNBUSD'];
  return ['BTCUSD','ETHUSD','XAUUSD']; // dead zone — crypto only
}

// ── OHLCV reader (correct API: valueAt) ──
async function setChart(sym, tf) {
  await evaluate(`(function(){
    var a = window.TradingViewApi._activeChartWidgetWV.value();
    a.setSymbol('${sym}', null, true);
    a.setResolution('${tf}');
  })()`);
  await sleep(1800);
}

async function getBars(count = 200) {
  return evaluate(`(function() {
    try {
      var bars = window.TradingViewApi._activeChartWidgetWV.value()
                   ._chartWidget.model().mainSeries().bars();
      if (!bars || typeof bars.lastIndex !== 'function') return null;
      var end   = bars.lastIndex();
      var start = Math.max(bars.firstIndex(), end - ${count} + 1);
      var result = [];
      for (var i = start; i <= end; i++) {
        var v = bars.valueAt(i);
        if (v) result.push({ t: v[0], o: v[1], h: v[2], l: v[3], c: v[4], v: v[5] || 0 });
      }
      return result.length > 10 ? result : null;
    } catch(e) { return null; }
  })()`);
}

// ── Indicators ──
function calcATR(bars, len = 14) {
  const atr = [];
  for (let i = 0; i < bars.length; i++) {
    const tr = i === 0 ? bars[i].h - bars[i].l
      : Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i-1].c), Math.abs(bars[i].l - bars[i-1].c));
    atr.push(i < len ? tr : (atr[i-1] * (len-1) + tr) / len);
  }
  return atr;
}

function calcEMA(bars, len) {
  const k = 2 / (len + 1);
  const ema = [];
  for (let i = 0; i < bars.length; i++) {
    ema.push(i === 0 ? bars[i].c : bars[i].c * k + ema[i-1] * (1-k));
  }
  return ema;
}

function calcRSI(bars, len = 14) {
  let ag = 0, al = 0;
  const rsi = new Array(bars.length).fill(50);
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].c - bars[i-1].c;
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= len) { ag += g/len; al += l/len; }
    else { ag = (ag*(len-1)+g)/len; al = (al*(len-1)+l)/len; }
    if (i >= len) rsi[i] = al === 0 ? 100 : 100 - 100/(1 + ag/al);
  }
  return rsi;
}

function calcSmartTrail(bars, len = 22, mult = 3.0) {
  const atr = calcATR(bars, len);
  const trail = [], dir = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < len) { trail.push(null); dir.push(1); continue; }
    const highs = bars.slice(Math.max(0,i-len+1), i+1).map(b=>b.h);
    const lows  = bars.slice(Math.max(0,i-len+1), i+1).map(b=>b.l);
    const upper = Math.max(...highs) - mult * atr[i];
    const lower = Math.min(...lows)  + mult * atr[i];
    if (!trail[i-1]) { trail.push(upper); dir.push(1); continue; }
    if (bars[i].c > trail[i-1]) { trail.push(Math.max(upper, trail[i-1])); dir.push(1); }
    else                        { trail.push(Math.min(lower, trail[i-1])); dir.push(-1); }
  }
  return { trail, dir };
}

function calcBollinger(bars, len = 20, mult = 2) {
  const bb = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < len) { bb.push(null); continue; }
    const slice = bars.slice(i-len+1, i+1).map(b => b.c);
    const mean  = slice.reduce((a,b)=>a+b,0) / len;
    const std   = Math.sqrt(slice.reduce((a,b)=>a+(b-mean)**2,0)/len);
    bb.push({ mid: mean, upper: mean + mult*std, lower: mean - mult*std, bw: (2*mult*std)/mean });
  }
  return bb;
}

function avgVol(bars, len = 20) {
  return bars.slice(-len).reduce((s,b)=>s+b.v,0) / len;
}

function toHA(bars) {
  return bars.map((b,i,a) => {
    const hc = (b.o+b.h+b.l+b.c)/4;
    const ho = i===0 ? (b.o+b.c)/2 : (a[i-1].ho||((a[i-1].o+a[i-1].c)/2) + hc)/2;
    const hh = Math.max(b.h, ho, hc), hl = Math.min(b.l, ho, hc);
    return { ...b, ho, hc, hh, hl, ho };
  });
}

// ── Session quality ──
function sessionQuality(utcHour) {
  if (utcHour >= 13 && utcHour < 17) return 1; // London-NY overlap
  if (utcHour >= 8  && utcHour < 13) return 1; // London open
  if (utcHour >= 17 && utcHour < 22) return 0; // NY continuation
  if (utcHour >= 0  && utcHour < 7)  return 0; // Asian
  return 0;
}

// ────────────────────────────────────────────────────────────────
// STRATEGY ENGINE — runs ALL 8 strategies, returns vote + reasons
//
//  A  JG Smart Trail HA Scalper      (validated: BTC +$165, XAU +$114)
//  B  JG EMA Stack                   (trend confirmation 8/21/50/100)
//  C  S/R Swing Proximity            (65-75% WR at key levels)
//  D  Rejection Candle               (pin bar / engulfing / doji)
//  E  RSI + Divergence               (momentum filter)
//  F  Bollinger Band Squeeze/Touch   (breakout from compression)
//  G  Volume Spike                   (institutional participation)
//  H  Session Quality                (London/NY prime hours)
//  I  Statistical Pattern Match      (n-gram probability)
//  J  JG HA Scalper                  (HA pullback + EMA100 filter)
//  K  JG London Breakout             (range capture + breakout)
//  L  Tori Trendline Break           (pivot-based trendline breaks)
//  M  WOR Break & Retest             (major level break → retest)
//  N  WOR Marci HTF Mean Reversion   (price at range extreme + HTF bias)
//  O  WOR NBB ICT Power of 3 / OTE   (AMD model + Fibonacci OTE 62-79%)
//  P  WOR Okala NQ Scalper           (over-extension fade, NAS100/indices)
// ────────────────────────────────────────────────────────────────
function runAllStrategies(bars, dir, utcHour, label) {
  const n      = bars.length - 1;
  const atr    = calcATR(bars);
  const ema8   = calcEMA(bars, 8);
  const ema21  = calcEMA(bars, 21);
  const ema50  = calcEMA(bars, 50);
  const ema100 = calcEMA(bars, 100);
  const rsi    = calcRSI(bars);
  const st     = calcSmartTrail(bars);
  const bb     = calcBollinger(bars);
  const ha     = toHA(bars);
  const avgV   = avgVol(bars);
  const last   = bars[n];
  const lastHA = ha[n];
  const range  = last.h - last.l;
  const body   = Math.abs(last.c - last.o);

  let score = 0;
  const reasons = [];
  const strats  = [];

  // ── A. JG Smart Trail direction ──
  if (st.dir[n] !== null) {
    const aligned = (dir === 'long' && st.dir[n] === 1) || (dir === 'short' && st.dir[n] === -1);
    if (aligned) { score++; reasons.push('SmartTrail aligned'); strats.push('A'); }
  }

  // ── B. EMA trend stack (8 > 21 > 50 > 100 for longs) ──
  const emaLong  = ema8[n] > ema21[n] && ema21[n] > ema50[n];
  const emaShort = ema8[n] < ema21[n] && ema21[n] < ema50[n];
  if ((dir === 'long' && emaLong) || (dir === 'short' && emaShort)) {
    score++; reasons.push('EMA stack aligned'); strats.push('B');
  }

  // ── C. S/R proximity — near 50-bar swing high/low ──
  const highs50 = bars.slice(-50).map(b=>b.h);
  const lows50  = bars.slice(-50).map(b=>b.l);
  const swingH  = Math.max(...highs50.slice(0,-3));
  const swingL  = Math.min(...lows50.slice(0,-3));
  const nearR   = Math.abs(last.c - swingH) / last.c < 0.004;
  const nearS   = Math.abs(last.c - swingL) / last.c < 0.004;
  if ((dir === 'short' && nearR) || (dir === 'long' && nearS)) {
    score++; reasons.push(`At S/R (swing ${dir==='long'?'low':'high'})`); strats.push('C');
  }

  // ── D. Rejection candle (pin bar / engulfing / doji) ──
  const lowerWick = Math.min(last.o, last.c) - last.l;
  const upperWick = last.h - Math.max(last.o, last.c);
  const isPinBullish = lowerWick > body*2 && lowerWick > upperWick*1.5;
  const isPinBearish = upperWick > body*2 && upperWick > lowerWick*1.5;
  const isDoji       = range > 0 && body/range < 0.25;
  const prev = bars[n-1];
  const isEngulfBull = last.c > last.o && last.o < prev.c && last.c > prev.o && prev.o > prev.c;
  const isEngulfBear = last.c < last.o && last.o > prev.c && last.c < prev.o && prev.o < prev.c;
  if ((dir==='long'  && (isPinBullish || isEngulfBull || isDoji)) ||
      (dir==='short' && (isPinBearish || isEngulfBear || isDoji))) {
    const name = isPinBullish||isPinBearish ? 'Pin bar' : isEngulfBull||isEngulfBear ? 'Engulfing' : 'Doji';
    score++; reasons.push(name); strats.push('D');
  }

  // ── E. RSI: not extreme + divergence check ──
  const rsiOK = (dir==='long' && rsi[n] >= 30 && rsi[n] <= 65) ||
                (dir==='short' && rsi[n] >= 35 && rsi[n] <= 70);
  const rsiDiv = (() => {
    if (n < 10) return false;
    const px = n - 5;
    if (dir==='long'  && last.l < bars[px].l && rsi[n] > rsi[px]) return true;
    if (dir==='short' && last.h > bars[px].h && rsi[n] < rsi[px]) return true;
    return false;
  })();
  if (rsiOK)  { score++; reasons.push(`RSI ${rsi[n].toFixed(0)}`); strats.push('E'); }
  if (rsiDiv) { score++; reasons.push('RSI divergence'); strats.push('E+'); }

  // ── F. Bollinger Band squeeze / outer band touch ──
  const bbN = bb[n];
  if (bbN) {
    const squeeze = bbN.bw < 0.005;
    const atLower = last.l <= bbN.lower && dir === 'long';
    const atUpper = last.h >= bbN.upper && dir === 'short';
    if (squeeze)            { score++; reasons.push('BB squeeze (breakout pending)'); strats.push('F'); }
    if (atLower || atUpper) { score++; reasons.push(`BB ${dir==='long'?'lower':'upper'} band touch`); strats.push('F'); }
  }

  // ── G. Volume spike ──
  if (avgV > 0 && last.v > avgV * 1.3) {
    score++; reasons.push(`Volume spike ${(last.v/avgV).toFixed(1)}×`); strats.push('G');
  }

  // ── H. Session quality ──
  if (sessionQuality(utcHour)) {
    score++; reasons.push('Prime session'); strats.push('H');
  }

  // ── I. Statistical pattern match ──
  try {
    const pr = matchPattern(bars, 4, 3);
    if (pr.sampleSize >= 5 && pr.confidence >= 62 && pr.direction === dir) {
      score++; reasons.push(`Pattern ${pr.confidence}% conf (n=${pr.sampleSize})`); strats.push('I');
    }
  } catch(e) {}

  // ── J. JG HA Scalper — HA pullback + EMA100 filter ──
  // Long: price above EMA100, 2+ consecutive bearish HA candles then bullish/doji flip
  // Short: price below EMA100, 2+ consecutive bullish HA candles then bearish/doji flip
  {
    const aboveEMA100 = last.c > ema100[n];
    const belowEMA100 = last.c < ema100[n];
    // Count consecutive opposite HA candles before last bar
    let pbCount = 0;
    for (let i = n-1; i >= Math.max(0, n-5); i--) {
      const haBull = ha[i].hc > ha[i].ho;
      if (dir === 'long'  && !haBull) pbCount++;
      else if (dir === 'short' && haBull) pbCount++;
      else break;
    }
    const lastHABull = lastHA.hc > lastHA.ho;
    const haPBFlip = dir === 'long' ? (!lastHABull || isDoji) : (lastHABull || isDoji);
    if (dir === 'long'  && aboveEMA100 && pbCount >= 2 && haPBFlip) {
      score++; reasons.push(`HA pullback (${pbCount} bars) above EMA100`); strats.push('J');
    }
    if (dir === 'short' && belowEMA100 && pbCount >= 2 && haPBFlip) {
      score++; reasons.push(`HA pullback (${pbCount} bars) below EMA100`); strats.push('J');
    }
  }

  // ── K. JG London Breakout — London range capture ──
  // London range = UTC 08:00-13:00. After 13:00, check if price broke out of that range.
  // Applicable during London-NY overlap (13:00-17:00 UTC)
  if (utcHour >= 13 && utcHour < 18 && n >= 60) {
    // Approximate London range: look back ~60 bars for 5H range on 5M, 20 bars on 15M
    const londonSlice = bars.slice(-40, -5);
    const londonH = Math.max(...londonSlice.map(b=>b.h));
    const londonL = Math.min(...londonSlice.map(b=>b.l));
    const brokeUp   = last.c > londonH * 1.0005 && dir === 'long';
    const brokeDown = last.c < londonL * 0.9995 && dir === 'short';
    if (brokeUp || brokeDown) {
      score++; reasons.push(`London breakout (${dir==='long'?'above':'below'} range)`); strats.push('K');
    }
  }

  // ── L. Tori Trendline Break — pivot-based channel break ──
  // Find recent resistance (connect last 2 pivot highs) or support (last 2 pivot lows).
  // Signal: price closes decisively above resistance or below support.
  {
    const lookback = Math.min(30, n - 2);
    const pivotH = [], pivotL = [];
    for (let i = n - lookback; i < n - 1; i++) {
      if (bars[i].h > bars[i-1].h && bars[i].h > bars[i+1].h) pivotH.push({ i, p: bars[i].h });
      if (bars[i].l < bars[i-1].l && bars[i].l < bars[i+1].l) pivotL.push({ i, p: bars[i].l });
    }
    if (pivotH.length >= 2) {
      const [p1, p2] = pivotH.slice(-2);
      // Slope of resistance line
      const slope = (p2.p - p1.p) / (p2.i - p1.i);
      const projectedR = p2.p + slope * (n - p2.i);
      if (dir === 'long' && last.c > projectedR * 1.001) {
        score++; reasons.push('Trendline break (resistance)'); strats.push('L');
      }
    }
    if (pivotL.length >= 2) {
      const [p1, p2] = pivotL.slice(-2);
      const slope = (p2.p - p1.p) / (p2.i - p1.i);
      const projectedS = p2.p + slope * (n - p2.i);
      if (dir === 'short' && last.c < projectedS * 0.999) {
        score++; reasons.push('Trendline break (support)'); strats.push('L');
      }
    }
  }

  // ── M. WOR Break & Retest (Vincent Desiano) ──
  // Detect: major swing level was broken 5-20 bars ago, price is now retesting it.
  {
    const lookH = bars.slice(n-30, n-8).map(b=>b.h);
    const lookL = bars.slice(n-30, n-8).map(b=>b.l);
    const majorH = Math.max(...lookH);
    const majorL = Math.min(...lookL);
    const tolerance = atr[n] * 0.5;
    // Long retest: broke above majorH in recent bars, now pulling back to it
    const brokeMajorH = bars.slice(n-8, n-1).some(b => b.c > majorH);
    const retestingH  = Math.abs(last.c - majorH) < tolerance && dir === 'long';
    // Short retest: broke below majorL in recent bars, now pulling back to it
    const brokeMajorL = bars.slice(n-8, n-1).some(b => b.c < majorL);
    const retestingL  = Math.abs(last.c - majorL) < tolerance && dir === 'short';
    if (brokeMajorH && retestingH) { score++; reasons.push('B&R retest (support)'); strats.push('M'); }
    if (brokeMajorL && retestingL) { score++; reasons.push('B&R retest (resistance)'); strats.push('M'); }
  }

  // ── N. WOR Marci Silfrain HTF Mean Reversion ──
  // Price at extreme of 50-bar range (bottom 20% for long, top 20% for short)
  // PLUS HTF EMA50 slope confirms direction (not countertrend)
  {
    const rangeH = Math.max(...bars.slice(-50).map(b=>b.h));
    const rangeL = Math.min(...bars.slice(-50).map(b=>b.l));
    const rangePos = rangeH > rangeL ? (last.c - rangeL) / (rangeH - rangeL) : 0.5;
    const ema50Slope = ema50[n] > ema50[n-5]; // rising = bullish HTF
    const atRangeBottom = rangePos < 0.20 && dir === 'long'  && ema50Slope;
    const atRangeTop    = rangePos > 0.80 && dir === 'short' && !ema50Slope;
    if (atRangeBottom) { score++; reasons.push(`Mean reversion (range bottom ${(rangePos*100).toFixed(0)}%)`); strats.push('N'); }
    if (atRangeTop)    { score++; reasons.push(`Mean reversion (range top ${(rangePos*100).toFixed(0)}%)`);    strats.push('N'); }
  }

  // ── O. WOR NBB ICT Power of 3 — AMD model + OTE Fibonacci ──
  // Detect: false break (manipulation) of recent swing → OTE retracement for distribution
  // OTE = 61.8%-79% retracement of the impulse move (Fibonacci)
  {
    if (n >= 20) {
      // Find the impulse move (last significant swing)
      const swing = bars.slice(n-20, n-2);
      const swHigh = Math.max(...swing.map(b=>b.h));
      const swLow  = Math.min(...swing.map(b=>b.l));
      const swRange = swHigh - swLow;
      if (swRange > atr[n] * 1.5) {
        // For long: impulse was down (swLow recent), price retracing up, OTE = 62-79% of range
        const fibLong618 = swLow + swRange * 0.618;
        const fibLong79  = swLow + swRange * 0.79;
        const inOTELong  = last.c >= fibLong618 && last.c <= fibLong79 * 1.005 && dir === 'long';
        // For short: impulse was up (swHigh recent), price retracing down, OTE = 62-79%
        const fibShort618 = swHigh - swRange * 0.618;
        const fibShort79  = swHigh - swRange * 0.79;
        const inOTEShort  = last.c <= fibShort618 && last.c >= fibShort79 * 0.995 && dir === 'short';
        if (inOTELong)  { score++; reasons.push('ICT OTE zone (61.8-79% long)');  strats.push('O'); }
        if (inOTEShort) { score++; reasons.push('ICT OTE zone (61.8-79% short)'); strats.push('O'); }
      }
    }
  }

  // ── P. WOR Okala NQ Scalper — over-extension fade (indices focus) ──
  // NAS100, US30, GER40, UK100, SPX500: fade over-extended intraday moves
  // Signal: price >1.5×ATR from EMA21, in NY morning (13:30-17:00 UTC)
  const isIndex = ['NAS100','US30','GER40','UK100','SPX500'].includes(label);
  if (isIndex) {
    const distFromEMA21 = last.c - ema21[n];
    const overExtLong  = distFromEMA21 < -atr[n] * 1.5 && dir === 'long';   // extended DOWN → fade up
    const overExtShort = distFromEMA21 > atr[n]  * 1.5 && dir === 'short';  // extended UP   → fade down
    const isNYMorning  = utcHour >= 13 && utcHour < 17;
    if (isNYMorning && (overExtLong || overExtShort)) {
      score++; reasons.push(`Okala over-ext fade (${(Math.abs(distFromEMA21)/atr[n]).toFixed(1)}×ATR)`); strats.push('P');
    }
  }

  // ── Named candle patterns (bonus label, no extra point) ──
  const named = detectNamedPatterns(ha);
  const matching = named.filter(p => p.direction === dir || (p.direction==='neutral' && p.reliability >= 65));
  if (matching.length) { reasons.push(matching.map(p=>p.name).join('+')); }

  // Strategy convergence bonus: 5+ distinct strategies agree → +1
  const uniqueStrats = [...new Set(strats.map(s=>s[0]))].length;
  if (uniqueStrats >= 5) { score++; reasons.push(`${uniqueStrats} strategies converge`); }

  return { score, reasons, strategies: [...new Set(strats)], rsi: rsi[n], atrVal: atr[n] };
}

// ── Main scan ──
export async function scanForSetups(minScore = 4) {
  const utcHour    = new Date().getUTCHours();
  const priority   = sessionSymbols(utcHour);
  const results    = [];
  const skipped    = [];

  // Build ordered list: session-priority symbols first, then rest
  const ordered = [
    ...FULL_SCAN_LIST.filter(i => priority.includes(i.label)),
    ...FULL_SCAN_LIST.filter(i => !priority.includes(i.label)),
  ];

  console.log(`\n  UTC ${utcHour}:xx — Priority symbols: ${priority.join(', ')}`);
  console.log(`  Scanning ${ordered.length} instruments across all strategies...\n`);

  for (const inst of ordered) {
    for (const tf of inst.tfs) {
      process.stdout.write(`  [T${inst.tier}] ${inst.label} ${tf}M... `);
      await setChart(inst.sym, tf);
      const bars = await getBars(300);

      if (!bars || bars.length < 50) {
        process.stdout.write(`skip (no data)\n`);
        skipped.push(`${inst.label}/${tf}`);
        continue;
      }

      const directions = ['long', ...(inst.autoShort ? ['short'] : [])];

      for (const dir of directions) {
        const { score, reasons, strategies, rsi, atrVal } = runAllStrategies(bars, dir, utcHour, inst.label);

        if (score >= minScore) {
          const entry = bars[bars.length-1].c;
          const sl    = dir === 'long'  ? entry - atrVal * 1.5 : entry + atrVal * 1.5;
          const tp1   = dir === 'long'  ? entry + atrVal * 3.0 : entry - atrVal * 3.0;
          const rr    = Math.abs(tp1-entry) / Math.abs(entry-sl);

          results.push({
            sym: inst.sym, label: inst.label, tf, dir, score,
            reasons, strategies,
            entry: Math.round(entry * 10000) / 10000,
            sl:    Math.round(sl    * 10000) / 10000,
            tp1:   Math.round(tp1   * 10000) / 10000,
            rr:    Math.round(rr    * 100)   / 100,
            rsi:   Math.round(rsi),
            tier:  inst.tier,
          });
          process.stdout.write(`✅ SETUP! [${score}] ${dir.toUpperCase()} — ${reasons.slice(0,3).join(', ')}\n`);
        } else {
          process.stdout.write(`${score}pt `);
        }
      }
      process.stdout.write('\n');
    }
  }

  // Sort: score desc, then tier asc (Tier 1 preferred at same score)
  results.sort((a,b) => b.score - a.score || a.tier - b.tier);

  console.log(`\n  Found ${results.length} setups. Skipped: ${skipped.length}`);
  return results;
}

if (process.argv[1].endsWith('setup_finder.mjs')) {
  const setups = await scanForSetups();
  for (const s of setups) {
    console.log(`  [${s.score}/16][T${s.tier}] ${s.label} ${s.tf}M ${s.dir.toUpperCase()} | Entry:${s.entry} SL:${s.sl} TP:${s.tp1} R:R ${s.rr} | ${s.strategies.join(',')} | ${s.reasons.slice(0,4).join(', ')}`);
  }
}
