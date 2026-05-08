/**
 * setup_finder.mjs — Three-Family Strategy Scanner
 *
 * Scans the FULL BlackBull symbol universe across 8 timeframes.
 * Three focused strategy families vote on direction — only high-conviction
 * setups where all three families agree are emitted.
 *
 * STRATEGY FAMILIES:
 *  TREND     A(SmartTrail) B(EMA stack) S(Daily trend) T(Weekly trend — REQUIRED)
 *  S&R ZONES C(ATR-width S/R region) M(Break & Retest / Zone Flip) U(PDH/PDL — REQUIRED)
 *  FVG       F(3-candle imbalance zone, +2 fresh/+1 old) G(Order Block bonus)
 *
 * SCORING: threshold 6. FVG tightens SL → bigger lots for same £ risk → larger profits.
 * Minimum 2:1 R:R enforced — one loss never overshadows 2-3 winning trades.
 */
import { evaluate } from '../../src/connection.js';
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



// ── Fair Value Gap (FVG) Zone Detection — 3-candle institutional imbalance ───
// Bullish FVG: bars[i].low > bars[i-2].high  → gap UP, demand zone forms
//   Zone: { bottom: bars[i-2].high, top: bars[i].low }
//   Fills when price retraces back into the zone (long entry opportunity)
// Bearish FVG: bars[i].high < bars[i-2].low  → gap DOWN, supply zone forms
//   Zone: { bottom: bars[i].high, top: bars[i-2].low }
//   Fills when price rallies back into the zone (short entry opportunity)
//
// fresh:     impulse candle body > 1.2×ATR — strong institutional participation
// mitigated: price has entered the zone since formation (first fill is strongest)
// orderBlock: last opposing candle before the impulse (institutional origin zone)
function detectFVGZones(bars, atr, lookback = 30) {
  const zones = [];
  const n = bars.length - 1;
  const start = Math.max(2, n - lookback);

  for (let i = start; i <= n; i++) {
    const curATR = atr[i] || atr[n] || 1;

    // Bullish FVG
    if (bars[i].l > bars[i - 2].h) {
      const bottom = bars[i - 2].h;
      const top    = bars[i].l;
      if (top - bottom < curATR * 0.1) continue;  // ignore micro-gaps

      const impulseBody = Math.abs(bars[i - 1].c - bars[i - 1].o);
      const fresh = impulseBody > curATR * 1.2;

      let mitigated = false;
      for (let j = i + 1; j <= n; j++) {
        if (bars[j].l <= top && bars[j].h >= bottom) { mitigated = true; break; }
      }

      let orderBlock = null;
      for (let k = i - 2; k >= Math.max(0, i - 12); k--) {
        if (bars[k].c < bars[k].o) { orderBlock = { high: bars[k].h, low: bars[k].l }; break; }
      }

      zones.push({ type: 'bullish', top, bottom, barIdx: i, fresh, mitigated, orderBlock });
    }

    // Bearish FVG
    if (bars[i].h < bars[i - 2].l) {
      const bottom = bars[i].h;
      const top    = bars[i - 2].l;
      if (top - bottom < curATR * 0.1) continue;

      const impulseBody = Math.abs(bars[i - 1].c - bars[i - 1].o);
      const fresh = impulseBody > curATR * 1.2;

      let mitigated = false;
      for (let j = i + 1; j <= n; j++) {
        if (bars[j].l <= top && bars[j].h >= bottom) { mitigated = true; break; }
      }

      let orderBlock = null;
      for (let k = i - 2; k >= Math.max(0, i - 12); k--) {
        if (bars[k].c > bars[k].o) { orderBlock = { high: bars[k].h, low: bars[k].l }; break; }
      }

      zones.push({ type: 'bearish', top, bottom, barIdx: i, fresh, mitigated, orderBlock });
    }
  }

  return zones;
}

// ── S/R Zones — wick-to-body supply/demand zones matching the Pine indicator ──
// Resistance: zone top = pivot wick high, zone bottom = closest body top below it
// Support:    zone top = closest body bottom above it, zone bottom = pivot wick low
// Retest dedup: new pivot inside existing zone increments retests instead of new zone
// Break: body close beyond wick tip; Flip: retest + hold from other side
function buildSRZones(bars, atr, {
  pivotLen = 5,
  maxSR    = 5,
} = {}) {
  const n = bars.length - 1;
  const currentATR = atr[n] || 1;

  // Strictly highest/lowest in full [i-L .. i+L] window (matches ta.pivothigh/ta.pivotlow)
  const pivotHighs = [], pivotLows = [];
  for (let i = pivotLen; i <= n - pivotLen; i++) {
    const ph = bars[i].h;
    let hi = true;
    for (let j = i - pivotLen; j <= i + pivotLen; j++) {
      if (j !== i && bars[j].h >= ph) { hi = false; break; }
    }
    if (hi) pivotHighs.push({ wickTip: ph, idx: i });

    const pl = bars[i].l;
    let lo = true;
    for (let j = i - pivotLen; j <= i + pivotLen; j++) {
      if (j !== i && bars[j].l <= pl) { lo = false; break; }
    }
    if (lo) pivotLows.push({ wickTip: pl, idx: i });
  }

  // Build zones from oldest to newest; most-recent zones end up first after reversal
  function buildZones(pivots, type, cap) {
    const zones = [];
    for (let p = 0; p < pivots.length; p++) {
      const { wickTip, idx } = pivots[p];

      if (type === 'resistance') {
        // Check retest: pivot high falls inside existing resistance zone
        const hit = zones.find(z => !z.broken && wickTip >= z.bodyLevel && wickTip <= z.wickTip);
        if (hit) { hit.retests++; continue; }

        // Find closest body top below wick tip among bars from pivot to n
        let bodyLevel = null, minDist = Infinity;
        for (let k = idx; k <= n; k++) {
          const bt = Math.max(bars[k].o, bars[k].c);
          const d  = wickTip - bt;
          if (d >= 0 && d < minDist) { minDist = d; bodyLevel = bt; }
        }
        if (bodyLevel === null) bodyLevel = Math.max(bars[idx].o, bars[idx].c);
        if (zones.filter(z => !z.broken).length < cap)
          zones.push({ wickTip, bodyLevel, type, bar: idx, retests: 0, broken: false, flipped: false });

      } else {
        // Support: check retest — pivot low falls inside existing support zone
        const hit = zones.find(z => !z.broken && wickTip >= z.wickTip && wickTip <= z.bodyLevel);
        if (hit) { hit.retests++; continue; }

        // Find closest body bottom above wick tip among bars from pivot to n
        let bodyLevel = null, minDist = Infinity;
        for (let k = idx; k <= n; k++) {
          const bb = Math.min(bars[k].o, bars[k].c);
          const d  = bb - wickTip;
          if (d >= 0 && d < minDist) { minDist = d; bodyLevel = bb; }
        }
        if (bodyLevel === null) bodyLevel = Math.min(bars[idx].o, bars[idx].c);
        if (zones.filter(z => !z.broken).length < cap)
          zones.push({ wickTip, bodyLevel, type, bar: idx, retests: 0, broken: false, flipped: false });
      }
    }
    return zones;
  }

  const capR = Math.ceil(maxSR / 2);
  const capS = maxSR - capR;
  const resZones  = buildZones(pivotHighs, 'resistance', capR);
  const suppZones = buildZones(pivotLows,  'support',    capS);

  // Break detection: body close beyond wick tip
  for (const z of resZones) {
    for (let i = z.bar + 1; i <= n; i++) {
      if (Math.min(bars[i].o, bars[i].c) > z.wickTip) { z.broken = true; break; }
    }
  }
  for (const z of suppZones) {
    for (let i = z.bar + 1; i <= n; i++) {
      if (Math.max(bars[i].o, bars[i].c) < z.wickTip) { z.broken = true; break; }
    }
  }

  // Flip confirmation: price retests broken zone from other side and close holds
  for (const z of resZones) {
    if (!z.broken) continue;
    for (let i = z.bar + 1; i <= n; i++) {
      if (bars[i].l <= z.wickTip && bars[i].c > z.bodyLevel) { z.flipped = true; break; }
    }
  }
  for (const z of suppZones) {
    if (!z.broken) continue;
    for (let i = z.bar + 1; i <= n; i++) {
      if (bars[i].h >= z.wickTip && bars[i].c < z.bodyLevel) { z.flipped = true; break; }
    }
  }

  const all = [...resZones, ...suppZones];
  return {
    active: all.filter(z => !z.broken),
    broken: all.filter(z =>  z.broken && !z.flipped),
    flipped: all.filter(z => z.flipped),
    currentATR,
  };
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
// STRATEGY ENGINE — three families vote on direction
//
//  TREND (direction gate — determines buy/sell bias):
//    A  SmartTrail aligned            (+1 when trail direction matches trade)
//    B  EMA stack (8 > 21 > 50)      (+1 — stacked EMAs confirm trend)
//    S  Daily trend alignment         (+1 — D1 EMA proxy)
//    T  Weekly trend alignment        (+1 — W1 EMA proxy, REQUIRED gate)
//
//  SUPPORT & RESISTANCE ZONES (as regions, not lines):
//    C  Adaptive S/R zone (ATR-wide)  (+1 fresh / +2 multi-touch)
//    M  Break & Retest / Zone Flip    (+1 — broken level role reversal)
//    U  Daily PDH/PDL zone            (+1 — yesterday's high/low region, REQUIRED gate)
//
//  FAIR VALUE GAP — institutional imbalance zones:
//    F  FVG zone hit (3-candle gap)   (+2 fresh+unmitigated / +1 old or mitigated)
//    G  Order Block within FVG        (+1 bonus — institutional demand/supply origin)
//
//  Convergence bonus: 4+ distinct strategy codes → +1
// ────────────────────────────────────────────────────────────────
export function runAllStrategies(bars, dir, utcHour, label, tf = '15') {
  const n      = bars.length - 1;
  const atr    = calcATR(bars);
  const ema8   = calcEMA(bars, 8);
  const ema21  = calcEMA(bars, 21);
  const ema50  = calcEMA(bars, 50);
  const rsi    = calcRSI(bars);
  const st     = calcSmartTrail(bars);
  const isT1   = ['WTI','NAS100','US30','XAUUSD','XAGUSD','SPX500'].includes(label);
  const srZones = buildSRZones(bars, atr, isT1 ? { pivotLen: 3, minStrength: 0.05 } : {});
  const last   = bars[n];

  let score = 0;
  const reasons = [];
  const strats  = [];
  let activeFVG = null;

  // EMA flatness gate — dead-ranging market, no edge (8-14% WR in backtests)
  const emaSpread = Math.max(ema8[n], ema21[n], ema50[n]) - Math.min(ema8[n], ema21[n], ema50[n]);
  const emaFlat   = emaSpread / ema50[n] < 0.004;
  if (emaFlat) {
    return { score: 2, reasons: ['EMA flat (ranging — no edge)'], strategies: [], rsi: rsi[n], atrVal: atr[n], activeFVG: null };
  }

  // ── A. SmartTrail direction ──
  if (st.dir[n] !== null) {
    const aligned = (dir === 'long' && st.dir[n] === 1) || (dir === 'short' && st.dir[n] === -1);
    if (aligned) { score++; reasons.push('SmartTrail aligned'); strats.push('A'); }
  }

  // ── B. EMA trend stack (8 > 21 > 50 for longs, reversed for shorts) ──
  const emaLong  = ema8[n] > ema21[n] && ema21[n] > ema50[n];
  const emaShort = ema8[n] < ema21[n] && ema21[n] < ema50[n];
  if ((dir === 'long' && emaLong) || (dir === 'short' && emaShort)) {
    score++; reasons.push('EMA stack aligned'); strats.push('B');
  }

  // ── C. S/R Zone (wick-to-body) — price inside supply/demand zone ──
  // +2 for fresh zone, +3 for zone with retests (proven institutional level)
  // Matches the Pine indicator: resistance=[bodyLevel, wickTip], support=[wickTip, bodyLevel]
  {
    const activeZone = srZones.active.find(z => {
      if (z.type === 'support'    && dir === 'long')  return last.c >= z.wickTip    && last.c <= z.bodyLevel;
      if (z.type === 'resistance' && dir === 'short') return last.c >= z.bodyLevel  && last.c <= z.wickTip;
      return false;
    });
    if (activeZone) {
      const pts = activeZone.retests > 0 ? 3 : 2;
      const strength = activeZone.retests > 0 ? `${activeZone.retests}-retest` : 'fresh';
      score += pts;
      reasons.push(`S/R zone (${activeZone.type}) wick=${activeZone.wickTip.toFixed(4)} body=${activeZone.bodyLevel.toFixed(4)} ${strength}`);
      strats.push('C');
    }
  }

  // ── M. Break & Retest + Broken Zone Flip ──
  // Two signals:
  //   1. Classic B&R: major level broken 5-20 bars ago, price now retesting it
  //   2. Zone flip: broken support → new resistance; broken resistance → new support
  {
    const tolerance = atr[n] * 0.5;
    const lookH = bars.slice(n-30, n-8).map(b=>b.h);
    const lookL = bars.slice(n-30, n-8).map(b=>b.l);
    const majorH = Math.max(...lookH);
    const majorL = Math.min(...lookL);
    const brokeMajorH = bars.slice(n-8, n-1).some(b => b.c > majorH);
    const retestingH  = Math.abs(last.c - majorH) < tolerance && dir === 'long';
    const brokeMajorL = bars.slice(n-8, n-1).some(b => b.c < majorL);
    const retestingL  = Math.abs(last.c - majorL) < tolerance && dir === 'short';
    if (brokeMajorH && retestingH) { score++; reasons.push(`B&R: broken resistance → support @${majorH.toFixed(4)}`); strats.push('M'); }
    if (brokeMajorL && retestingL) { score++; reasons.push(`B&R: broken support → resistance @${majorL.toFixed(4)}`); strats.push('M'); }

    if (!strats.includes('M')) {
      const flipZone = srZones.broken.find(z =>
        Math.abs(last.c - z.wickTip) < tolerance &&
        ((z.type === 'resistance' && dir === 'long') || (z.type === 'support' && dir === 'short'))
      );
      if (flipZone) {
        const role = flipZone.type === 'resistance' ? 'flipped → support' : 'flipped → resistance';
        score++; reasons.push(`Zone flip: ${role} @${flipZone.wickTip.toFixed(4)}`); strats.push('M');
      }
    }
  }

  // ── S. Daily Trend Alignment — D1 EMA proxy from current-TF bars ──
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

  // ── T. Weekly Trend Alignment — W1 EMA proxy (5× daily lookback) ──
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

  // ── U. Daily PDH/PDL Zone — yesterday's high/low as S&R region ──
  {
    const dc = buildDailyContext(bars);
    if (dc) {
      const { PDH, PDL, PDC, pricePos, bias } = dc;
      const nearPDL = pricePos < 0.40 && dir === 'long';
      const nearPDH = pricePos > 0.60 && dir === 'short';
      if (nearPDL) {
        score++;
        reasons.push(`PDL support zone (${(pricePos*100).toFixed(0)}% of range, PDL=${PDL.toFixed(4)})`);
        strats.push('U');
      }
      if (nearPDH) {
        score++;
        reasons.push(`PDH resistance zone (${(pricePos*100).toFixed(0)}% of range, PDH=${PDH.toFixed(4)})`);
        strats.push('U');
      }
      const biasMatch = (dir === 'long' && bias === 'bullish') || (dir === 'short' && bias === 'bearish');
      if (biasMatch) reasons.push(`Daily bias ${bias}`);
      else if (bias !== 'neutral') reasons.push(`⚠ Daily bias ${bias} (counter-trend)`);
    }
  }

  // ── F. Fair Value Gap (FVG) — institutional imbalance zone ────────────────
  // 3-candle pattern: price moved so fast an untraded gap was left behind.
  // These zones act as magnets — institutions return to fill the imbalance.
  // Enter when price retraces INTO the zone (not after it passes through).
  // SL sits just outside the FVG boundary (tighter SL → larger lots for same £ risk).
  //
  // G. Order Block (OB): the last opposing candle before the impulse.
  //    If price is simultaneously inside the OB and the FVG → +1 bonus.
  {
    const fvgZones = detectFVGZones(bars, atr);
    const relevantType = dir === 'long' ? 'bullish' : 'bearish';
    const hitZones = fvgZones
      .filter(z => z.type === relevantType && last.c >= z.bottom && last.c <= z.top)
      .sort((a, b) => b.barIdx - a.barIdx);

    if (hitZones.length > 0) {
      activeFVG = hitZones[0];
      const pts = (activeFVG.fresh && !activeFVG.mitigated) ? 2 : 1;
      score += pts;
      reasons.push(`FVG ${activeFVG.fresh ? 'fresh' : 'old'}/${activeFVG.mitigated ? 'mitigated' : 'unmitigated'} [${activeFVG.bottom.toFixed(4)}–${activeFVG.top.toFixed(4)}]`);
      strats.push('F');

      if (activeFVG.orderBlock) {
        const ob = activeFVG.orderBlock;
        if (last.c >= ob.low && last.c <= ob.high) {
          score++;
          reasons.push(`Order Block [${ob.low.toFixed(4)}–${ob.high.toFixed(4)}]`);
          strats.push('G');
        }
      }
    }
  }

  // Convergence bonus: 4+ distinct strategy codes → +1
  const uniqueStrats = [...new Set(strats.map(s => s[0]))].length;
  if (uniqueStrats >= 4) { score++; reasons.push(`${uniqueStrats} strategies converge`); }

  return { score, reasons, strategies: [...new Set(strats)], rsi: rsi[n], atrVal: atr[n], activeFVG };
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

      // ── Day-trade caps: all levels must be reachable in 15–20 fifteen-minute candles ──
      // Max SL = 0.75×ATR, Max TP = 2.0×ATR. Directional 15M moves cover ~0.15–0.4 ATR/candle,
      // so TP at 2×ATR hits in 5–13 candles (1–3 hours). Always a day trade.
      const MAX_SL_ATR = 0.75;
      const MAX_TP_ATR = 2.0;

      // SL: nearest S/R zone within 0.5–0.75×ATR; fall back to 0.75×ATR
      let sl;
      if (dir === 'long') {
        const supportsBelow = sr15.active
          .filter(z => z.type === 'support' && z.wickTip < entry
                    && (entry - z.wickTip) >= atrVal * 0.25
                    && (entry - z.wickTip) <= atrVal * MAX_SL_ATR)
          .sort((a, b) => b.wickTip - a.wickTip);
        sl = supportsBelow.length > 0
          ? supportsBelow[0].wickTip - slBuf
          : entry - atrVal * MAX_SL_ATR;
      } else {
        const resistsAbove = sr15.active
          .filter(z => z.type === 'resistance' && z.wickTip > entry
                    && (z.wickTip - entry) >= atrVal * 0.25
                    && (z.wickTip - entry) <= atrVal * MAX_SL_ATR)
          .sort((a, b) => a.wickTip - b.wickTip);
        sl = resistsAbove.length > 0
          ? resistsAbove[0].wickTip + slBuf
          : entry + atrVal * MAX_SL_ATR;
      }

      // FVG-based SL: tighter if available (min 0.2×ATR so not stopped by spread noise)
      if (check15.activeFVG) {
        const fvg = check15.activeFVG;
        const fvgSL = dir === 'long' ? fvg.bottom - slBuf : fvg.top + slBuf;
        const fvgDist = Math.abs(entry - fvgSL);
        const curDist = Math.abs(entry - sl);
        if (fvgDist < curDist && fvgDist >= atrVal * 0.2) sl = fvgSL;
      }

      // Hard cap: SL must not exceed MAX_SL_ATR × ATR from entry
      if (dir === 'long' && entry - sl > atrVal * MAX_SL_ATR) sl = entry - atrVal * MAX_SL_ATR;
      if (dir === 'short' && sl - entry > atrVal * MAX_SL_ATR) sl = entry + atrVal * MAX_SL_ATR;

      const slDist = Math.abs(entry - sl);

      // TP1 (tp2): nearest opposing S/R zone (0.5–2.0×slDist away); fall back to 1R
      let tp2;
      if (dir === 'long') {
        const resistsAhead = sr15.active
          .filter(z => z.type === 'resistance' && z.wickTip > entry
                    && (z.wickTip - entry) >= slDist * 0.5
                    && (z.wickTip - entry) <= atrVal * MAX_TP_ATR)
          .sort((a, b) => a.wickTip - b.wickTip);
        tp2 = resistsAhead.length > 0 ? resistsAhead[0].wickTip : entry + slDist;
      } else {
        const supportsAhead = sr15.active
          .filter(z => z.type === 'support' && z.wickTip < entry
                    && (entry - z.wickTip) >= slDist * 0.5
                    && (entry - z.wickTip) <= atrVal * MAX_TP_ATR)
          .sort((a, b) => b.wickTip - a.wickTip);
        tp2 = supportsAhead.length > 0 ? supportsAhead[0].wickTip : entry - slDist;
      }

      // Hard cap TP1 at MAX_TP_ATR × ATR from entry
      if (dir === 'long'  && tp2 - entry  > atrVal * MAX_TP_ATR) tp2 = entry + atrVal * MAX_TP_ATR;
      if (dir === 'short' && entry  - tp2  > atrVal * MAX_TP_ATR) tp2 = entry - atrVal * MAX_TP_ATR;

      // TP2 (tp3): runner — next zone beyond tp2, capped at 2.5×ATR (still same-day reachable)
      let tp3;
      if (dir === 'long') {
        const resistsBeyond = sr15.active
          .filter(z => z.type === 'resistance' && z.wickTip > tp2 + slDist * 0.3
                    && z.wickTip - entry <= atrVal * 2.5)
          .sort((a, b) => a.wickTip - b.wickTip);
        tp3 = resistsBeyond.length > 0 ? resistsBeyond[0].wickTip : Math.min(entry + slDist * 2.0, entry + atrVal * 2.5);
      } else {
        const supportsBeyond = sr15.active
          .filter(z => z.type === 'support' && z.wickTip < tp2 - slDist * 0.3
                    && entry - z.wickTip <= atrVal * 2.5)
          .sort((a, b) => b.wickTip - a.wickTip);
        tp3 = supportsBeyond.length > 0 ? supportsBeyond[0].wickTip : Math.max(entry - slDist * 2.0, entry - atrVal * 2.5);
      }

      let actualRR = Math.round((Math.abs(tp2 - entry) / slDist) * 10) / 10;

      // Enforce minimum 2:1 R:R — push TP2 to 2×slDist if current zone is too close
      if (actualRR < 2.0) {
        const minTP = dir === 'long' ? entry + slDist * 2.0 : entry - slDist * 2.0;
        // Only extend if it still stays within the day-trade cap
        const minTPDist = Math.abs(minTP - entry);
        if (minTPDist <= atrVal * MAX_TP_ATR) {
          tp2 = minTP;
        } else {
          // Can't reach 2:1 within cap — take best possible within cap
          tp2 = dir === 'long' ? entry + atrVal * MAX_TP_ATR : entry - atrVal * MAX_TP_ATR;
        }
        actualRR = Math.round((Math.abs(tp2 - entry) / slDist) * 10) / 10;
        if (actualRR < 2.0) {
          process.stdout.write(`\n  ⏭ ${inst.label} ${dir.toUpperCase()} — R:R ${actualRR.toFixed(1)} < 2.0, no viable TP, skipping\n`);
          continue;
        }
      }

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
