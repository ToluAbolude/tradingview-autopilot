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
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import os from 'os';

const IS_LINUX   = os.platform() === 'linux';
const DATA_ROOT  = IS_LINUX ? '/home/ubuntu/trading-data' : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const CTX_DIR    = join(DATA_ROOT, 'daily_context');

function logDailyContext(label, tf, dc) {
  try {
    if (!existsSync(CTX_DIR)) mkdirSync(CTX_DIR, { recursive: true });
    const date = new Date().toISOString().split('T')[0];
    const file = join(CTX_DIR, `${date}.jsonl`);
    const entry = JSON.stringify({
      ts: new Date().toISOString(), sym: label, tf,
      PDH: Math.round(dc.PDH * 10000) / 10000,
      PDL: Math.round(dc.PDL * 10000) / 10000,
      PDC: Math.round(dc.PDC * 10000) / 10000,
      adr: Math.round(dc.adr * 10000) / 10000,
      rangeConsumed: Math.round(dc.rangeConsumed * 1000) / 1000,
      pricePos: Math.round(dc.pricePos * 1000) / 1000,
      bias: dc.bias,
    });
    appendFileSync(file, entry + '\n');
  } catch (_) {}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Full symbol universe (BlackBull Markets via TradingView) ──
// Sorted by commission efficiency (spread/ADR ratio)
// Scan order = WR performance rank from weekly_review.mjs audit.
// All instruments kept — none permanently removed. Low-WR ones sit at the bottom
// and only win if they post a genuinely high score (which requires EMA trend alignment).
// The EMA flatness gate blocks ranging-market entries regardless of tier.

// All instruments scan all 8 timeframes: 1M, 5M, 15M, 30M, H1, H4, D, W
// 22 instruments × 8 TFs = 176 chart switches per cycle (~9 min), fits within session window.
// Higher TFs carry more weight in the MTF bonus — weekly/daily confluence is far more reliable.
const ALL_TFS = ['1', '5', '15', '30', '60', '240', 'D', 'W'];

// TF display labels and confluence weights (higher TF = more signal weight, less noise)
const TF_LABEL  = { '1':'1M', '5':'5M', '15':'15M', '30':'30M', '60':'1H', '240':'4H', 'D':'D', 'W':'W' };
const TF_WEIGHT = { '1': 0.25, '5': 0.5, '15': 1, '30': 1, '60': 1.5, '240': 2.5, 'D': 3, 'W': 4 };

export const FULL_SCAN_LIST = [
  // ── TIER 1: Proven high WR — ranked by 2-week audit (Apr 13-25) ──
  // WTI 58%H1 | NAS100 48%H1 | US30 42%H1 | XAUUSD 34%H1 | EURUSD 40%H1 (rising)
  { sym: 'BLACKBULL:WTI',     label: 'WTI',     tfs: ALL_TFS, autoShort: true,  tier: 1 },
  { sym: 'BLACKBULL:NAS100',  label: 'NAS100',  tfs: ALL_TFS, autoShort: false, tier: 1 },
  { sym: 'BLACKBULL:US30',    label: 'US30',    tfs: ALL_TFS, autoShort: false, tier: 1 },
  { sym: 'BLACKBULL:XAUUSD',  label: 'XAUUSD',  tfs: ALL_TFS, autoShort: true,  tier: 1 },
  { sym: 'BLACKBULL:SPX500',  label: 'SPX500',  tfs: ALL_TFS, autoShort: false, tier: 1 },
  { sym: 'BLACKBULL:XAGUSD',  label: 'XAGUSD',  tfs: ALL_TFS, autoShort: true,  tier: 1 },

  // ── TIER 2: Situational — good in trending weeks ──
  // EURUSD improved to 40% this week | JPY pairs consistent mid-20s
  { sym: 'BLACKBULL:EURUSD',  label: 'EURUSD',  tfs: ALL_TFS, autoShort: true,  tier: 2 },
  { sym: 'BLACKBULL:USDJPY',  label: 'USDJPY',  tfs: ALL_TFS, autoShort: true,  tier: 2 },
  { sym: 'BLACKBULL:EURJPY',  label: 'EURJPY',  tfs: ALL_TFS, autoShort: true,  tier: 2 },
  { sym: 'BLACKBULL:GBPJPY',  label: 'GBPJPY',  tfs: ALL_TFS, autoShort: true,  tier: 2 },
  { sym: 'BLACKBULL:GBPUSD',  label: 'GBPUSD',  tfs: ALL_TFS, autoShort: true,  tier: 2 },

  // ── TIER 3: Deprioritised — low recent WR, kept for trending opportunities ──
  { sym: 'BLACKBULL:BTCUSD',  label: 'BTCUSD',  tfs: ALL_TFS, autoShort: true,  tier: 3 },
  { sym: 'BLACKBULL:ETHUSD',  label: 'ETHUSD',  tfs: ALL_TFS, autoShort: true,  tier: 3 },
  { sym: 'BLACKBULL:LTCUSD',  label: 'LTCUSD',  tfs: ALL_TFS, autoShort: true,  tier: 3 },
  { sym: 'BLACKBULL:XRPUSD',  label: 'XRPUSD',  tfs: ALL_TFS, autoShort: true,  tier: 3 },
  { sym: 'BLACKBULL:AUDUSD',  label: 'AUDUSD',  tfs: ALL_TFS, autoShort: true,  tier: 3 },
  { sym: 'BLACKBULL:USDCAD',  label: 'USDCAD',  tfs: ALL_TFS, autoShort: true,  tier: 3 },
  { sym: 'BLACKBULL:NZDUSD',  label: 'NZDUSD',  tfs: ALL_TFS, autoShort: true,  tier: 3 },
  { sym: 'BLACKBULL:USDCHF',  label: 'USDCHF',  tfs: ALL_TFS, autoShort: true,  tier: 3 },
  { sym: 'BLACKBULL:AUDJPY',  label: 'AUDJPY',  tfs: ALL_TFS, autoShort: true,  tier: 3 },
  { sym: 'BLACKBULL:GER40',   label: 'GER40',   tfs: ALL_TFS, autoShort: false, tier: 3 },
  { sym: 'BLACKBULL:UK100',   label: 'UK100',   tfs: ALL_TFS, autoShort: false, tier: 3 },
];

// Session-aware: which symbols to prioritise per session
// Ordered by 2-week audit WR: WTI(58%) > NAS100(48%) > US30(42%) > EURUSD(40%H1) > XAUUSD(34%)
// BTC/ETH deprioritised — 2-6% WR week of Apr 21-25 (crypto bear conditions)
function sessionSymbols(utcHour) {
  if (utcHour >= 0  && utcHour < 7)  // Asian
    return ['BTCUSD','ETHUSD','XAUUSD','USDJPY','EURJPY'];
  if (utcHour >= 8  && utcHour < 13) // London
    return ['XAUUSD','WTI','BTCUSD','ETHUSD','EURJPY','USDJPY','UK100','GER40'];
  if (utcHour >= 13 && utcHour < 17) // London-NY overlap (BEST) — indices dominate
    return ['NAS100','US30','SPX500','WTI','XAUUSD','BTCUSD','ETHUSD','XAGUSD'];
  if (utcHour >= 17 && utcHour < 22) // NY only
    return ['NAS100','US30','SPX500','BTCUSD','ETHUSD','XAUUSD','SOLUSD','BNBUSD'];
  return ['BTCUSD','ETHUSD','XAUUSD']; // dead zone — crypto only
}

// ── OHLCV reader (correct API: valueAt) ──
export async function setChart(sym, tf) {
  await evaluate(`(function(){
    var a = window.TradingViewApi._activeChartWidgetWV.value();
    a.setSymbol('${sym}', null, true);
    a.setResolution('${tf}');
  })()`);
  await sleep(1800);
}

export async function getBars(count = 200) {
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

function calcMFI(bars, len = 14) {
  const tp  = bars.map(b => (b.h + b.l + b.c) / 3);
  const mfi = new Array(bars.length).fill(50);
  for (let i = len; i < bars.length; i++) {
    let posFlow = 0, negFlow = 0;
    for (let j = i - len + 1; j <= i; j++) {
      const raw = tp[j] * (bars[j].v || 1);
      if (tp[j] > tp[j - 1]) posFlow += raw; else negFlow += raw;
    }
    mfi[i] = negFlow === 0 ? 100 : 100 - (100 / (1 + posFlow / negFlow));
  }
  return mfi;
}

function detectRecentFVG(bars, lookback = 10) {
  let bullishFVG = false, bearishFVG = false;
  const start = Math.max(2, bars.length - lookback);
  for (let i = start; i < bars.length; i++) {
    if (bars[i].l > bars[i - 2].h) bullishFVG = true; // gap up (bullish imbalance)
    if (bars[i].h < bars[i - 2].l) bearishFVG = true; // gap down (bearish imbalance)
  }
  return { bullishFVG, bearishFVG };
}

// ── Fibonacci OTE with BOS/CHoCH and Order Block (SMC/Harmonic) ──────────────
// Identifies: swing A (low) → swing B (high) impulse, then retracement into 0.618-0.88 zone.
// BOS: the B swing broke above the prior confirmed swing high (trend confirmation).
// Order Block: last opposing candle before the impulse — institutional demand/supply zone.
// CHoCH: minor structure shift inside the retracement confirming reversal timing.
// Extension targets: ext27 = B + 0.27×range (TP1), ext618 = B + 0.618×range (TP2).
function calcFibOTE(bars, dir) {
  const n = bars.length - 1;
  const pivotLen = 5;
  const highs = [], lows = [];

  // Confirmed pivots — need pivotLen bars on BOTH sides (walk-forward safe, requires n ≥ 2×pivotLen)
  for (let i = pivotLen; i <= n - pivotLen; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= pivotLen; j++) {
      if (bars[i].h <= bars[i-j].h || bars[i].h <= bars[i+j].h) isH = false;
      if (bars[i].l >= bars[i-j].l || bars[i].l >= bars[i+j].l) isL = false;
    }
    if (isH) highs.push(i);
    if (isL)  lows.push(i);
  }

  if (highs.length < 1 || lows.length < 1) return null;
  const cur = bars[n].c;

  if (dir === 'long') {
    const hiIdx = highs[highs.length - 1];       // most recent swing high = B
    const loIdx = [...lows].reverse().find(l => l < hiIdx); // swing low before B = A
    if (loIdx === undefined) return null;

    const A = bars[loIdx].l, B = bars[hiIdx].h;
    if (B <= A) return null;
    const range = B - A;

    const f618 = B - 0.618 * range;
    const f786 = B - 0.786 * range;
    const f88  = B - 0.88  * range;
    const ext27 = B + 0.27  * range;   // TP1: -0.27 extension
    const ext618 = B + 0.618 * range;  // TP2: -0.618 extension

    if (cur < f88 || cur > f618) return null;  // not in OTE zone
    const inDeep = cur <= f786;                // golden pocket 0.786-0.88

    // BOS: the impulse high B broke above the previous confirmed swing high
    const prevHiIdx = highs.length >= 2 ? highs[highs.length - 2] : null;
    const hasBOS    = prevHiIdx !== null && B > bars[prevHiIdx].h;

    // Order Block: last bearish candle in the 10 bars before the impulse low (A)
    let obHigh = null, obLow = null;
    for (let i = loIdx - 1; i >= Math.max(0, loIdx - 10); i--) {
      if (bars[i].c < bars[i].o) { obHigh = bars[i].h; obLow = bars[i].l; break; }
    }
    const atOB = obHigh !== null && cur >= obLow && cur <= obHigh;

    // CHoCH (Change of Character): within the retracement, last 3 bars show a bullish shift
    // Proxy: current close is higher than 2 bars ago (mini-structure flip confirming OTE entry)
    const choch = n >= 2 && bars[n].c > bars[n-2].c && bars[n].c > bars[n-1].l;

    return { inDeep, hasBOS, atOB, choch, f618, f786, f88, ext27, ext618, A, B };
  }

  if (dir === 'short') {
    const loIdx = lows[lows.length - 1];         // most recent swing low = B
    const hiIdx = [...highs].reverse().find(h => h < loIdx); // swing high before B = A
    if (hiIdx === undefined) return null;

    const A = bars[hiIdx].h, B = bars[loIdx].l;
    if (A <= B) return null;
    const range = A - B;

    const f618 = B + 0.618 * range;
    const f786 = B + 0.786 * range;
    const f88  = B + 0.88  * range;
    const ext27 = B - 0.27  * range;   // TP1: -0.27 extension
    const ext618 = B - 0.618 * range;  // TP2: -0.618 extension

    if (cur > f88 || cur < f618) return null;   // not in OTE zone
    const inDeep = cur >= f786;                 // golden pocket 0.786-0.88

    const prevLoIdx = lows.length >= 2 ? lows[lows.length - 2] : null;
    const hasBOS    = prevLoIdx !== null && B < bars[prevLoIdx].l;

    let obHigh = null, obLow = null;
    for (let i = hiIdx - 1; i >= Math.max(0, hiIdx - 10); i--) {
      if (bars[i].c > bars[i].o) { obHigh = bars[i].h; obLow = bars[i].l; break; }
    }
    const atOB = obHigh !== null && cur >= obLow && cur <= obHigh;

    const choch = n >= 2 && bars[n].c < bars[n-2].c && bars[n].c < bars[n-1].h;

    return { inDeep, hasBOS, atOB, choch, f618, f786, f88, ext27, ext618, A, B };
  }

  return null;
}

function toHA(bars) {
  return bars.map((b,i,a) => {
    const hc = (b.o+b.h+b.l+b.c)/4;
    const ho = i===0 ? (b.o+b.c)/2 : (a[i-1].ho||((a[i-1].o+a[i-1].c)/2) + hc)/2;
    const hh = Math.max(b.h, ho, hc), hl = Math.min(b.l, ho, hc);
    return { ...b, ho, hc, hh, hl, ho };
  });
}

// ── Adaptive S/R Zones — faithful JS port of BigBeluga's Pine algorithm ──────
// Params match BigBeluga defaults: pivotLen=5, minStrength=0.1, mergeThresh=0.5,
// maxLevels=5 per type, maxAgeBars=300, breakSens=0.1
function buildSRZones(bars, atr, {
  pivotLen    = 5,
  minStrength = 0.1,
  maxAgeBars  = 300,
  maxLevels   = 5,
  mergeThresh = 0.5,
  breakSens   = 0.1,
} = {}) {
  const n = bars.length - 1;
  const currentATR = atr[n] || 1;
  const breakBuf   = breakSens * currentATR;

  // f_pivotStrong: BigBeluga checks only the two bars immediately adjacent to the
  // pivot (high[pivotLen-1] and high[pivotLen+1] in Pine), not the full window.
  function isStrong(price, type, idx) {
    if (idx <= 0 || idx >= n) return false;
    const localATR = atr[idx] || currentATR;
    if (type === 'resistance') {
      const nearHigh = Math.max(bars[idx - 1].h, bars[idx + 1].h);
      return (price - nearHigh) >= minStrength * localATR;
    }
    const nearLow = Math.min(bars[idx - 1].l, bars[idx + 1].l);
    return (nearLow - price) >= minStrength * localATR;
  }

  // ta.pivothigh / ta.pivotlow: strictly highest/lowest in the full [i-L .. i+L] window
  const pivotHighs = [], pivotLows = [];
  for (let i = pivotLen; i <= n - pivotLen; i++) {
    const ph = bars[i].h;
    let hi = true;
    for (let j = i - pivotLen; j <= i + pivotLen; j++) {
      if (j !== i && bars[j].h >= ph) { hi = false; break; }
    }
    if (hi && isStrong(ph, 'resistance', i)) pivotHighs.push({ price: ph, idx: i });

    const pl = bars[i].l;
    let lo = true;
    for (let j = i - pivotLen; j <= i + pivotLen; j++) {
      if (j !== i && bars[j].l <= pl) { lo = false; break; }
    }
    if (lo && isStrong(pl, 'support', i)) pivotLows.push({ price: pl, idx: i });
  }

  // f_isTooClose / f_addLevel: reject new pivot if within mergeThresh×ATR of any
  // active level of the same type; otherwise add (respecting maxLevels cap).
  // When rejected, increment the nearby level's touch count — that's multi-test strength.
  function buildLevels(pivots, type) {
    const levels = [];

    for (const piv of pivots) {
      const active = levels.filter(z => !z.broken);
      const nearby = active.find(z => Math.abs(z.price - piv.price) < mergeThresh * currentATR);
      if (nearby) {
        nearby.touches++;
        if (piv.idx > nearby.idx) nearby.idx = piv.idx;
      } else if (active.length < maxLevels) {
        levels.push({ price: piv.price, idx: piv.idx, type, touches: 1, broken: false });
      }
    }

    // Breakout + age pruning (BigBeluga: close crosses price by breakSens×ATR)
    for (const lvl of levels) {
      if (n - lvl.idx > maxAgeBars) { lvl.broken = true; continue; }
      for (let i = lvl.idx + 1; i <= n; i++) {
        if (type === 'resistance' && bars[i].c > lvl.price + breakBuf) { lvl.broken = true; break; }
        if (type === 'support'    && bars[i].c < lvl.price - breakBuf) { lvl.broken = true; break; }
      }
    }

    return levels;
  }

  const allRes = buildLevels(pivotHighs, 'resistance');
  const allSup = buildLevels(pivotLows,  'support');
  const all    = [...allRes, ...allSup];

  return {
    active: all.filter(z => !z.broken),
    broken: all.filter(z =>  z.broken),
    currentATR,
  };
}

// ── Session quality ──
function sessionQuality(utcHour) {
  if (utcHour >= 13 && utcHour < 17) return 1; // London-NY overlap
  if (utcHour >= 8  && utcHour < 13) return 1; // London open
  if (utcHour >= 17 && utcHour < 22) return 0; // NY continuation
  if (utcHour >= 0  && utcHour < 7)  return 0; // Asian
  return 0;
}

// ── Daily price range context ──
// Segments bars by UTC day. Returns PDH/PDL/PDC, today's range, ADR, and bias.
function buildDailyContext(bars) {
  const dayOf = t => Math.floor(t / 86400);
  const byDay = new Map();
  for (const b of bars) {
    const d = dayOf(b.t);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(b);
  }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  if (days.length < 2) return null;

  const todayDay = days[days.length - 1];
  const ydayDay  = days[days.length - 2];
  const todayBars = byDay.get(todayDay);
  const ydayBars  = byDay.get(ydayDay);

  const PDH = Math.max(...ydayBars.map(b => b.h));
  const PDL = Math.min(...ydayBars.map(b => b.l));
  const PDC = ydayBars[ydayBars.length - 1].c;

  const todayH = Math.max(...todayBars.map(b => b.h));
  const todayL = Math.min(...todayBars.map(b => b.l));

  // ADR from last 5 complete days
  const completeDays = days.slice(-6, -1);
  const adr = completeDays.length > 0
    ? completeDays.reduce((sum, d) => {
        const db = byDay.get(d);
        return sum + Math.max(...db.map(b => b.h)) - Math.min(...db.map(b => b.l));
      }, 0) / completeDays.length
    : PDH - PDL;

  const lastClose    = bars[bars.length - 1].c;
  const rangeConsumed = adr > 0 ? (todayH - todayL) / adr : 0;
  const pricePos     = (PDH > PDL) ? (lastClose - PDL) / (PDH - PDL) : 0.5;
  const bias         = lastClose > PDC ? 'bullish' : lastClose < PDC ? 'bearish' : 'neutral';

  return { PDH, PDL, PDC, todayH, todayL, adr, rangeConsumed, pricePos, bias };
}

// ────────────────────────────────────────────────────────────────
// STRATEGY ENGINE — runs ALL strategies, returns vote + reasons
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
  //  Q  Alpha Kill v1 BOS+Retest       (XAUUSD H1 only — PF=1.209, +2 pts)
  //  R  Ironclad MTF Market Structure  (D1 trend + 15M MSS, 72% WR backtested)
  //  S  Daily Trend Alignment          (D1 EMA proxy — filters counter-trend day trades)
  //  T  Weekly Trend Alignment         (W1 EMA proxy — macro direction confirmation)
  //  U  Daily Extreme Zone             (price in favorable half of PDH-PDL — +1 bonus)
  //  V  Trend Catcher Switch           (NAS100/SPX500 — SmartTrail flip+stack+RSI, 75% WR)
  //  W  SPX500 Contrarian FVG          (bearish FVG + MFI + RSI extreme, 70.51% WR)
  //  X  Fibonacci OTE + BOS/CHoCH     (SMC/Harmonic: 0.786-0.88 golden pocket + BOS + OB; ext -0.27/-0.618)
// ────────────────────────────────────────────────────────────────
export function runAllStrategies(bars, dir, utcHour, label, tf = '15') {
  const n      = bars.length - 1;
  const atr    = calcATR(bars);
  const ema8   = calcEMA(bars, 8);
  const ema21  = calcEMA(bars, 21);
  const ema50  = calcEMA(bars, 50);
  const ema100 = calcEMA(bars, 100);
  const rsi    = calcRSI(bars);
  const st     = calcSmartTrail(bars);
  const bb     = calcBollinger(bars);
  const ha      = toHA(bars);
  const avgV    = avgVol(bars);
  // T1 commodities/indices have wider ATR — shorter pivotLen finds more structure
  const isT1 = ['WTI','NAS100','US30','XAUUSD','XAGUSD','SPX500'].includes(label);
  const srZones = buildSRZones(bars, atr, isT1 ? { pivotLen: 3, minStrength: 0.05 } : {});
  const last    = bars[n];
  const lastHA = ha[n];
  const range  = last.h - last.l;
  const body   = Math.abs(last.c - last.o);

  let score = 0;
  const reasons = [];
  const strats  = [];

  // ── Flatness gate: if EMA8/21/50 are all within 0.4% of each other the market
  //    is dead-ranging — weekly audit showed 8–14% WR in those conditions.
  //    Hard-cap score at 2 so it never reaches the 11-point threshold.
  const emaSpread = Math.max(ema8[n], ema21[n], ema50[n]) - Math.min(ema8[n], ema21[n], ema50[n]);
  const emaFlat   = emaSpread / ema50[n] < 0.004;
  if (emaFlat) {
    return { score: 2, reasons: ['EMA flat (ranging market — no edge)'], strategies: [], rsi: 50, atrVal: atr[n] };
  }

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

  // ── C. Adaptive S/R Zone proximity (BigBeluga algorithm) ──
  // Uses ATR-filtered pivot levels merged into zones — far more precise than raw swing H/L.
  // Touch distance = 0.5×ATR; multi-touch zones (touches≥2) scored as stronger levels.
  {
    const touchDist = srZones.currentATR * 0.5;
    const activeZone = srZones.active.find(z =>
      Math.abs(last.c - z.price) < touchDist &&
      ((z.type === 'support' && dir === 'long') || (z.type === 'resistance' && dir === 'short'))
    );
    if (activeZone) {
      const strength = activeZone.touches >= 2 ? 'tested' : 'fresh';
      score++; reasons.push(`At adaptive S/R zone @${activeZone.price.toFixed(4)} (${activeZone.touches}T ${strength})`); strats.push('C');
    }
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

  // ── H. Session quality — informational only, no score.
  // Backtest: -65% lift even as conditional amplifier. Removed from scoring entirely.
  if (sessionQuality(utcHour)) { reasons.push('Prime session'); }

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

  // ── M. WOR Break & Retest + Broken Zone Flip (BigBeluga mechanism) ──
  // Two signals:
  //   1. Classic swing B&R: major level broken 5-20 bars ago, now retesting it
  //   2. Broken zone flip: broken support → new resistance (short); broken resistance → new support (long)
  {
    const tolerance = atr[n] * 0.5;
    // Classic swing B&R
    const lookH = bars.slice(n-30, n-8).map(b=>b.h);
    const lookL = bars.slice(n-30, n-8).map(b=>b.l);
    const majorH = Math.max(...lookH);
    const majorL = Math.min(...lookL);
    const brokeMajorH = bars.slice(n-8, n-1).some(b => b.c > majorH);
    const retestingH  = Math.abs(last.c - majorH) < tolerance && dir === 'long';
    const brokeMajorL = bars.slice(n-8, n-1).some(b => b.c < majorL);
    const retestingL  = Math.abs(last.c - majorL) < tolerance && dir === 'short';
    if (brokeMajorH && retestingH) { score++; reasons.push('B&R retest (support)'); strats.push('M'); }
    if (brokeMajorL && retestingL) { score++; reasons.push('B&R retest (resistance)'); strats.push('M'); }

    // Broken zone flip (BigBeluga: broken levels become opposite S/R)
    if (!strats.includes('M')) {
      const flipZone = srZones.broken.find(z =>
        Math.abs(last.c - z.price) < tolerance &&
        ((z.type === 'resistance' && dir === 'long') ||   // broken resistance → now support
         (z.type === 'support'    && dir === 'short'))     // broken support → now resistance
      );
      if (flipZone) {
        const role = flipZone.type === 'resistance' ? 'flipped support' : 'flipped resistance';
        score++; reasons.push(`Broken zone flip: ${role} @${flipZone.price.toFixed(4)}`); strats.push('M');
      }
    }
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

  // ── O. WOR NBB ICT Power of 3 — AMD model + OTE Fibonacci (two-stage) ──
  // Stage 1 (depth):  price entered the 61.8–79% zone within the last 15 bars
  // Stage 2 (retest): current candle is at the zone boundary with a rejection body
  // Both stages must pass independently — prevents firing on pass-through moves
  {
    if (n >= 20) {
      const swing   = bars.slice(n-20, n-2);
      const swHigh  = Math.max(...swing.map(b=>b.h));
      const swLow   = Math.min(...swing.map(b=>b.l));
      const swRange = swHigh - swLow;

      if (swRange > atr[n] * 1.5) {
        // Fib levels — long: retracement up from swLow; short: retracement down from swHigh
        const fibLong618  = swLow  + swRange * 0.618;
        const fibLong79   = swLow  + swRange * 0.79;
        const fibShort618 = swHigh - swRange * 0.618;
        const fibShort79  = swHigh - swRange * 0.79;

        // Stage 1: did any bar in the last 15 candles touch inside the OTE zone?
        const recent = bars.slice(n-15, n);
        const zoneEnteredLong  = recent.some(b => b.l <= fibLong79  * 1.002 && b.h >= fibLong618  * 0.998);
        const zoneEnteredShort = recent.some(b => b.h >= fibShort79 * 0.998 && b.l <= fibShort618 * 1.002);

        // Stage 2a: current close is at or near zone boundary (not blown through)
        const atBoundaryLong  = last.c >= fibLong618  * 0.998 && last.c <= fibLong79  * 1.003;
        const atBoundaryShort = last.c <= fibShort618 * 1.002 && last.c >= fibShort79 * 0.997;

        // Stage 2b: rejection body — candle body < 45% of its full range (pin bar / doji character)
        const candleRange = last.h - last.l;
        const hasRejection = candleRange > 0 && Math.abs(last.c - last.o) / candleRange < 0.45;

        const inOTELong  = dir === 'long'  && zoneEnteredLong  && atBoundaryLong  && hasRejection;
        const inOTEShort = dir === 'short' && zoneEnteredShort && atBoundaryShort && hasRejection;

        if (inOTELong)  { score++; reasons.push(`ICT OTE long (${fibLong618.toFixed(1)}–${fibLong79.toFixed(1)})`);   strats.push('O'); }
        if (inOTEShort) { score++; reasons.push(`ICT OTE short (${fibShort79.toFixed(1)}–${fibShort618.toFixed(1)})`); strats.push('O'); }
      }
    }
  }

  // ── Q. Alpha Kill v1 — H1 BOS+Retest, XAUUSD only (PF=1.209, best config 2026-04-20) ──
  // D1 proxy: EMA200 slope on H1 (200 H1 bars ≈ 8 trading days)
  // H4 proxy: EMA50 slope on H1  (50 H1 bars  ≈ 2 trading days)
  // BOS: 2-bar pivot high/low broken, then price retests within 0.5×ATR
  if (label === 'XAUUSD' && n >= 60) {
    const ema200 = calcEMA(bars, 200);
    const d1Bull = ema200[n] > ema200[Math.max(0, n - 20)];
    const d1Bear = ema200[n] < ema200[Math.max(0, n - 20)];
    const h4Bull = ema50[n]  > ema50[Math.max(0, n - 4)];
    const h4Bear = ema50[n]  < ema50[Math.max(0, n - 4)];
    const trendOk = dir === 'long' ? (d1Bull && h4Bull) : (d1Bear && h4Bear);

    if (trendOk) {
      let bosLevel = null;
      for (let i = Math.max(3, n - 60); i <= n - 3; i++) {
        const isPH = bars[i].h >= bars[i-1].h && bars[i].h >= bars[i-2].h &&
                     bars[i].h >= bars[i+1].h && bars[i].h >= bars[i+2].h;
        const isPL = bars[i].l <= bars[i-1].l && bars[i].l <= bars[i-2].l &&
                     bars[i].l <= bars[i+1].l && bars[i].l <= bars[i+2].l;
        if (dir === 'long'  && isPH) bosLevel = bars[i].h;
        if (dir === 'short' && isPL) bosLevel = bars[i].l;
      }
      if (bosLevel !== null) {
        const broken    = dir === 'long'
          ? bars.slice(Math.max(0, n - 30), n).some(b => b.c > bosLevel)
          : bars.slice(Math.max(0, n - 30), n).some(b => b.c < bosLevel);
        const retesting = Math.abs(last.c - bosLevel) < atr[n] * 0.5;
        if (broken && retesting) {
          score += 2; reasons.push(`AK v1 BOS retest @${bosLevel.toFixed(0)}`); strats.push('Q');
        }
      }
    }
  }

  // ── R. Ironclad MTF Market Structure (YouTube: s9HV_jyeUDk) ──
  // Optimal from 8,700-combination backtest: Daily trend + 15M MSS, 72% WR, 957% over 10yr
  // D1 trend proxy : EMA200 slope on current bars (rising = D1 uptrend)
  // MSS            : close breaks above/below last confirmed swing high/low (N=6 lookback)
  // No order blocks, no premium/discount zones
  if (n >= 200) {
    const ema200 = calcEMA(bars, 200);
    const d1Up   = ema200[n] > ema200[n - 48];  // 48 × 15M ≈ 12 hours (daily slope proxy)
    const d1Dn   = ema200[n] < ema200[n - 48];
    const trendOk = dir === 'long' ? d1Up : d1Dn;

    if (trendOk) {
      // Find swing highs/lows with N=6 lookback (must be highest/lowest of 13-bar window)
      let lastSwingH = null, lastSwingL = null;
      const ltfN = 6;
      for (let i = ltfN; i <= n - ltfN; i++) {
        let isPH = true, isPL = true;
        for (let k = i - ltfN; k <= i + ltfN; k++) {
          if (k === i) continue;
          if (bars[k].h >= bars[i].h) isPH = false;
          if (bars[k].l <= bars[i].l) isPL = false;
        }
        if (isPH) lastSwingH = bars[i].h;
        if (isPL) lastSwingL = bars[i].l;
      }
      // MSS: current close breaks above last swing high (bull) or below last swing low (bear)
      const prevClose = bars[n - 1].c;
      const mssBull = lastSwingH !== null && prevClose <= lastSwingH && last.c > lastSwingH;
      const mssBear = lastSwingL !== null && prevClose >= lastSwingL && last.c < lastSwingL;
      if (dir === 'long'  && mssBull) { score += 2; reasons.push(`Ironclad MSS break @${lastSwingH.toFixed(0)}`); strats.push('R'); }
      if (dir === 'short' && mssBear) { score += 2; reasons.push(`Ironclad MSS break @${lastSwingL.toFixed(0)}`); strats.push('R'); }
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

  // ── S. Daily Trend Alignment — D1 bias proxy from current bars ──
  // EMA lookback = 1 trading day worth of bars on current TF
  // Long: D1 EMA rising (bulls in control for the day) | Short: D1 EMA falling
  {
    const bpd = tf === '60' ? 24 : tf === '30' ? 48 : tf === '15' ? 96 : tf === '5' ? 288 : 96;
    const lookback = Math.min(Math.floor(bars.length * 0.8), bpd);
    if (lookback >= 20) {
      const emaD1 = calcEMA(bars, lookback);
      const shift = Math.max(1, Math.floor(lookback / 6));
      const d1Bull = emaD1[n] > emaD1[n - shift];
      const d1Bear = emaD1[n] < emaD1[n - shift];
      if ((dir === 'long' && d1Bull) || (dir === 'short' && d1Bear)) {
        score++; reasons.push('D1 trend aligned'); strats.push('S');
      }
    }
  }

  // ── T. Weekly Trend Alignment — W1 bias proxy (5× daily lookback) ──
  // Long: weekly EMA rising (macro bull) | Short: weekly EMA falling (macro bear)
  {
    const bpd  = tf === '60' ? 24 : tf === '30' ? 48 : tf === '15' ? 96 : tf === '5' ? 288 : 96;
    const bpw  = bpd * 5;
    const lookback = Math.min(Math.floor(bars.length * 0.9), bpw);
    if (lookback >= 40) {
      const emaW = calcEMA(bars, lookback);
      const shift = Math.max(1, Math.floor(lookback / 10));
      const wkBull = emaW[n] > emaW[n - shift];
      const wkBear = emaW[n] < emaW[n - shift];
      if ((dir === 'long' && wkBull) || (dir === 'short' && wkBear)) {
        score++; reasons.push('W1 trend aligned'); strats.push('T');
      }
    }
  }

  // ── U. Daily price range context — favorable half of yesterday's range ──
  // +1 when price is in the lower 40% of PDH-PDL for longs (near PDL support)
  // or upper 40% for shorts (near PDH resistance). Backtest: V (ADR room) hurt
  // BTC/NAS100 WR so removed; U kept as directional bias bonus.
  {
    const dc = buildDailyContext(bars);
    if (dc) {
      const { PDH, PDL, PDC, pricePos, bias } = dc;
      const nearPDL = pricePos < 0.40 && dir === 'long';
      const nearPDH = pricePos > 0.60 && dir === 'short';
      if (nearPDL) {
        score++;
        reasons.push(`At PDL zone (${(pricePos*100).toFixed(0)}% of PDH-PDL, PDL=${PDL.toFixed(4)})`);
        strats.push('U');
      }
      if (nearPDH) {
        score++;
        reasons.push(`At PDH zone (${(pricePos*100).toFixed(0)}% of PDH-PDL, PDH=${PDH.toFixed(4)})`);
        strats.push('U');
      }
      // Daily bias note — informational only, no score (S/T already cover trend)
      const biasMatch = (dir === 'long' && bias === 'bullish') || (dir === 'short' && bias === 'bearish');
      if (biasMatch) {
        reasons.push(`Daily bias ${bias} (vs PDC ${PDC.toFixed(4)})`);
      } else if (bias !== 'neutral') {
        reasons.push(`⚠ Daily bias ${bias} (counter-trend)`);
      }
    }
  }

  // ── V. Trend Catcher Switch Gate — NAS100/SPX500 (75% WR on NAS100 15M backtest) ──
  // Replicates LuxAlgo Oscillator Matrix LUCID connectors (backtester script):
  //   {switch_bullish_catcher}  → SmartTrail flipped -1→+1 in last 5 bars
  //   {confirmation_uptrend}    → EMA stack: ema8 > ema21 > ema50
  //   {hyperwave_below_50}      → RSI < 55 (not overextended into bullish extreme)
  // (short leg mirrors: flip +1→-1, stack reversed, RSI > 45)
  if (['NAS100', 'SPX500'].includes(label)) {
    let switchBull = false, switchBear = false;
    for (let i = Math.max(1, n - 5); i <= n; i++) {
      if (st.dir[i] === 1  && st.dir[i - 1] === -1) switchBull = true;
      if (st.dir[i] === -1 && st.dir[i - 1] === 1)  switchBear = true;
    }
    if (dir === 'long'  && switchBull && emaLong  && rsi[n] < 55) {
      score++; reasons.push(`Trend Catcher switch bullish (RSI=${rsi[n].toFixed(0)})`); strats.push('V');
    }
    if (dir === 'short' && switchBear && emaShort && rsi[n] > 45) {
      score++; reasons.push(`Trend Catcher switch bearish (RSI=${rsi[n].toFixed(0)})`); strats.push('V');
    }
  }

  // ── W. SPX500 Contrarian FVG — institutional imbalance reversal (70.51% WR backtest 15M) ──
  // Approximates: New Bearish FVG (trigger) + Money Flow < 50 + HyperWave < 20
  // Long logic (contrarian): bearish FVG just formed + MFI oversold + RSI extreme
  // Bearish FVG ≈ candle[i].high < candle[i-2].low (gap down / unmitigated imbalance)
  // Money Flow  ≈ MFI(14); HyperWave < 20 ≈ RSI < 35
  if (label === 'SPX500') {
    const mfi14 = calcMFI(bars);
    const { bullishFVG, bearishFVG } = detectRecentFVG(bars);
    if (dir === 'long'  && bearishFVG && mfi14[n] < 50 && rsi[n] < 35) {
      score++; reasons.push(`SPX FVG contrarian long (MFI=${mfi14[n].toFixed(0)}, RSI=${rsi[n].toFixed(0)})`); strats.push('W');
    }
    if (dir === 'short' && bullishFVG && mfi14[n] > 50 && rsi[n] > 65) {
      score++; reasons.push(`SPX FVG contrarian short (MFI=${mfi14[n].toFixed(0)}, RSI=${rsi[n].toFixed(0)})`); strats.push('W');
    }
  }

  // ── X. Fibonacci OTE + BOS/CHoCH — SMC/Harmonic trend continuation ──────────
  // Swing A→B impulse confirmed by BOS; price retracing into 0.618-0.88 OTE zone.
  // Golden pocket (0.786-0.88) + Order Block confluence = highest-probability reversal zone.
  // Extensions: TP1=-0.27 (1.27 target), TP2=-0.618 (1.618 target) beyond the swing.
  // Settings from Harmonic/SMC: 0.786, 0.88 for entry; -0.27, -0.618 for profit targets.
  const fibOTE = calcFibOTE(bars, dir);
  if (fibOTE && fibOTE.hasBOS) {
    let pts = 0;
    const tags = [];
    if (fibOTE.inDeep) {
      pts = 2; tags.push(`Fib golden pocket 0.786-0.88`);
    } else {
      pts = 1; tags.push(`Fib OTE 0.618-0.786`);
    }
    if (fibOTE.atOB)    { pts++; tags.push(`+OB confluence`); }
    if (fibOTE.choch)   { tags.push(`CHoCH`); }
    tags.push(`BOS | TP1=${fibOTE.ext27.toFixed(2)} TP2=${fibOTE.ext618.toFixed(2)}`);
    score += pts;
    reasons.push(tags.join(' '));
    strats.push('X');
  } else if (fibOTE && !fibOTE.hasBOS) {
    // In OTE zone but no BOS — weaker signal, 1 point only, no CHoCH flag
    score += 1;
    reasons.push(`Fib OTE ${fibOTE.inDeep ? '0.786-0.88' : '0.618-0.786'} (no BOS)`);
    strats.push('X');
  }

  // ── Named candle patterns (bonus label, no extra point) ──
  const named = detectNamedPatterns(ha);
  const matching = named.filter(p => p.direction === dir || (p.direction==='neutral' && p.reliability >= 65));
  if (matching.length) { reasons.push(matching.map(p=>p.name).join('+')); }

  // Strategy convergence bonus: 5+ distinct strategies agree → +1
  const uniqueStrats = [...new Set(strats.map(s=>s[0]))].length;
  if (uniqueStrats >= 5) { score++; reasons.push(`${uniqueStrats} strategies converge`); }

  // NAS100 gate — Okala (P) OR Trend Catcher (V) must be present.
  // Without either, WR drops to near 0% (Run 3/4 audit). V adds the 75%-WR trend-switch filter.
  if (label === 'NAS100' && !strats.includes('P') && !strats.includes('V')) {
    return { score: Math.min(score, 8), reasons, strategies: [...new Set(strats)], rsi: rsi[n], atrVal: atr[n] };
  }

  // SPX500 gate — Contrarian FVG (W) or Okala (P) must be present.
  // Pure trend-following on SPX500 underperforms; contrarian FVG approach yields 70.51% WR.
  if (label === 'SPX500' && !strats.includes('W') && !strats.includes('P')) {
    return { score: Math.min(score, 8), reasons, strategies: [...new Set(strats)], rsi: rsi[n], atrVal: atr[n] };
  }

  return { score, reasons, strategies: [...new Set(strats)], rsi: rsi[n], atrVal: atr[n] };
}

// ── Main scan ──
//
// Two-pass MTF approach:
//  Pass 1 — scan all TFs (1M, 5M, 15M, 30M, 1H, 4H, D, W) for direction confluence
//  Pass 2 — once confluence is found, switch to 15M and calculate entry/SL/TP from
//            the 15M chart (tighter, more precise levels regardless of which TF triggered)
//
// One setup is emitted per instrument+direction, not per TF.
// MTF bonus: +1 if 2 TFs agree, +2 if 3+ TFs agree.
export async function scanForSetups(minScore = 8, slAtrMult = 1.5) {
  const utcHour  = new Date().getUTCHours();
  const priority = sessionSymbols(utcHour);
  const results  = [];
  const skipped  = [];

  const ordered = [
    ...FULL_SCAN_LIST.filter(i => priority.includes(i.label)),
    ...FULL_SCAN_LIST.filter(i => !priority.includes(i.label)),
  ];

  console.log(`\n  UTC ${utcHour}:xx — Priority symbols: ${priority.join(', ')}`);
  console.log(`  Scanning ${ordered.length} instruments (MTF confluence → 15M entry)\n`);

  for (const inst of ordered) {
    const candidates = [];   // { tf, dir, score, strategies, reasons, rsi }

    // ── Pass 1: scan every TF, collect any that pass threshold ──────────────
    process.stdout.write(`  [T${inst.tier}] ${inst.label} `);

    for (const tf of inst.tfs) {
      process.stdout.write(`${TF_LABEL[tf]||tf}:`);
      await setChart(inst.sym, tf);
      const bars = await getBars(300);

      if (!bars || bars.length < 50) {
        process.stdout.write(`? `);
        skipped.push(`${inst.label}/${tf}`);
        continue;
      }

      const dcSnap = buildDailyContext(bars);
      if (dcSnap) logDailyContext(inst.label, tf, dcSnap);

      const directions = ['long', ...(inst.autoShort ? ['short'] : [])];
      for (const dir of directions) {
        const { score, reasons, strategies, rsi } = runAllStrategies(bars, dir, utcHour, inst.label, tf);
        // D and W bars: U (daily range context) is meaningless — price is always "somewhere in yesterday's range"
        // on a daily/weekly chart. Only require T (macro trend alignment) for these higher TFs.
        const isHigherTF = tf === 'D' || tf === 'W';
        const hasTU = strategies.includes('T') && (isHigherTF || strategies.includes('U'));
        if (score >= minScore && hasTU) {
          candidates.push({ tf, dir, score, reasons, strategies, rsi });
          process.stdout.write(`✓ `);
        } else {
          process.stdout.write(`${score} `);
        }
      }
    }

    if (candidates.length === 0) {
      process.stdout.write(`→ no setup\n`);
      continue;
    }

    // ── Pass 2: group by direction, fetch 15M once, emit one setup per dir ──
    const byDir = {};
    for (const c of candidates) {
      if (!byDir[c.dir]) byDir[c.dir] = [];
      byDir[c.dir].push(c);
    }

    await setChart(inst.sym, '15');
    const bars15 = await getBars(200);

    for (const [dir, cands] of Object.entries(byDir)) {
      if (!bars15 || bars15.length < 50) {
        process.stdout.write(`\n  → 15M fetch failed for ${inst.label}\n`);
        continue;
      }

      // ── 15M alignment gate ──────────────────────────────────────────────────
      // Higher TFs confirmed the trend — now verify the 15M chart is also trending
      // in the SAME direction before entering. If the 15M is ranging or pointing
      // the other way, the trade is counter-trend on the entry TF — skip it.
      // Require: SmartTrail (A) OR EMA stack (B) aligned on 15M.
      const check15 = runAllStrategies(bars15, dir, utcHour, inst.label, '15');
      const is15mAligned = check15.strategies.includes('A') || check15.strategies.includes('B');
      if (!is15mAligned) {
        process.stdout.write(`\n  ⏭ ${inst.label} ${dir.toUpperCase()} — 15M not aligned (score=${check15.score}), waiting\n`);
        continue;
      }

      const tfList      = [...new Set(cands.map(c => TF_LABEL[c.tf] || c.tf))].join('+');
      const maxScore    = Math.max(...cands.map(c => c.score));
      const totalWeight = cands.reduce((s, c) => s + (TF_WEIGHT[c.tf] || 1), 0);
      // Higher TF confluence earns bigger bonus: W+D = 7pts → +3; D+4H = 5.5pts → +3; 1H alone = +1
      const mtfBonus  = totalWeight >= 5 ? 3 : totalWeight >= 3 ? 2 : totalWeight >= 1.5 ? 1 : 0;
      const finalScore = maxScore + mtfBonus;

      const allStrats  = [...new Set([...cands.flatMap(c => c.strategies), ...check15.strategies])];
      const allReasons = [`MTF(${tfList}) + 15M aligned`, ...[...new Set(cands.flatMap(c => c.reasons))]].slice(0, 8);
      const avgRsi     = Math.round(cands.reduce((s, c) => s + c.rsi, 0) / cands.length);

      const atr15  = calcATR(bars15);
      const n15    = bars15.length - 1;
      const entry  = bars15[n15].c;
      const atrVal = atr15[n15];

      // Build 15M S/R zones so SL and TP can snap to real structure
      const sr15 = buildSRZones(bars15, atr15);
      const slBuf = atrVal * 0.10;   // 10% ATR buffer outside the zone

      // SL: prefer nearest active S/R level beyond entry (0.5–2.5×ATR away); fall back to 1.5×ATR
      let sl;
      if (dir === 'long') {
        const supportsBelow = sr15.active
          .filter(z => z.type === 'support' && z.price < entry
                    && (entry - z.price) >= atrVal * 0.5
                    && (entry - z.price) <= atrVal * 2.5)
          .sort((a, b) => b.price - a.price);
        sl = supportsBelow.length > 0
          ? supportsBelow[0].price - slBuf
          : entry - atrVal * slAtrMult;
      } else {
        const resistsAbove = sr15.active
          .filter(z => z.type === 'resistance' && z.price > entry
                    && (z.price - entry) >= atrVal * 0.5
                    && (z.price - entry) <= atrVal * 2.5)
          .sort((a, b) => a.price - b.price);
        sl = resistsAbove.length > 0
          ? resistsAbove[0].price + slBuf
          : entry + atrVal * slAtrMult;
      }
      const slDist = Math.abs(entry - sl);

      // TP1 (tp2): nearest opposing S/R level ahead of entry (0.5–4×slDist away); fall back to 1R
      let tp2;
      if (dir === 'long') {
        const resistsAhead = sr15.active
          .filter(z => z.type === 'resistance' && z.price > entry
                    && (z.price - entry) >= slDist * 0.5
                    && (z.price - entry) <= slDist * 4.0)
          .sort((a, b) => a.price - b.price);
        tp2 = resistsAhead.length > 0 ? resistsAhead[0].price : entry + slDist;
      } else {
        const supportsAhead = sr15.active
          .filter(z => z.type === 'support' && z.price < entry
                    && (entry - z.price) >= slDist * 0.5
                    && (entry - z.price) <= slDist * 4.0)
          .sort((a, b) => b.price - a.price);
        tp2 = supportsAhead.length > 0 ? supportsAhead[0].price : entry - slDist;
      }

      // TP2 (tp3): next S/R level beyond tp2 (runner); fall back to 2R
      let tp3;
      if (dir === 'long') {
        const resistsBeyond = sr15.active
          .filter(z => z.type === 'resistance' && z.price > tp2 + slDist * 0.3)
          .sort((a, b) => a.price - b.price);
        tp3 = resistsBeyond.length > 0 ? resistsBeyond[0].price : entry + slDist * 2.0;
      } else {
        const supportsBeyond = sr15.active
          .filter(z => z.type === 'support' && z.price < tp2 - slDist * 0.3)
          .sort((a, b) => b.price - a.price);
        tp3 = supportsBeyond.length > 0 ? supportsBeyond[0].price : entry - slDist * 2.0;
      }

      const actualRR = Math.round((Math.abs(tp2 - entry) / slDist) * 10) / 10;

      const setup = {
        sym:        inst.sym,
        label:      inst.label,
        tf:         '15',
        dir,
        score:      finalScore,
        reasons:    allReasons,
        strategies: allStrats,
        entry:      Math.round(entry   * 10000) / 10000,
        sl:         Math.round(sl      * 10000) / 10000,
        tpQuick:    Math.round((dir === 'long' ? entry + slDist * 0.5 : entry - slDist * 0.5) * 10000) / 10000,
        tp2:        Math.round(tp2     * 10000) / 10000,
        tp3:        Math.round(tp3     * 10000) / 10000,
        rr:         actualRR,
        rsi:        avgRsi,
        tier:       inst.tier,
      };

      results.push(setup);
      process.stdout.write(`\n  ✅ ${inst.label} 15M ${dir.toUpperCase()} [${finalScore}] | MTF:${tfList} | Entry:${setup.entry} SL:${setup.sl} TP:${setup.tp2}\n`);
    }
  }

  results.sort((a, b) => b.score - a.score || a.tier - b.tier);
  console.log(`\n  Found ${results.length} setups. Skipped: ${skipped.length}`);
  return results;
}

if (process.argv[1].endsWith('setup_finder.mjs')) {
  const setups = await scanForSetups();
  for (const s of setups) {
    console.log(`  [${s.score}/9][T${s.tier}] ${s.label} ${s.tf}M ${s.dir.toUpperCase()} | Entry:${s.entry} SL:${s.sl} TP1:${s.tpQuick}/TP2:${s.tp2}/TP3:${s.tp3} RR:${s.rr} | ${s.strategies.join(',')} | ${s.reasons.slice(0,4).join(', ')}`);
  }
}
