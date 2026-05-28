/**
 * setup_finder.mjs — Three-Family Strategy Scanner
 *
 * Scans the FULL BlackBull symbol universe across 8 timeframes.
 * Five focused strategies vote on direction — only high-conviction setups
 * where T (weekly trend) + U (PDH/PDL) are met and score ≥ 6 are emitted.
 *
 * STRATEGY FAMILIES:
 *  TREND     A(SmartTrail +1) T(Weekly trend +1 — REQUIRED)
 *  S&R ZONES C(S/R zone +2 fresh / +3 retested) U(PDH/PDL +1 — REQUIRED)
 *  FVG       F(3-candle imbalance zone +2)
 *
 * SCORING: max = 8, threshold = 6.
 * Minimum 2:1 R:R enforced — one loss never overshadows 2-3 winning trades.
 */
import CDP from '/home/ubuntu/tradingview-mcp-jackson/node_modules/chrome-remote-interface/index.js';
import { appendFileSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { detectChartPatterns } from './bulkowski_patterns.mjs';

// ── Load tunable config (auto-updated weekly by weekly_review_agent) ──────────
const __dir = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(__dir, '../../scanner_config.json');
let SC = {};  // scoring config
let TC = {};  // threshold config
let MTFC = [];
let TFW = {};
let INST_CFG = {};
try {
  const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  SC    = cfg.scoring       || {};
  TC    = cfg.thresholds    || {};
  MTFC  = cfg.mtf_bonus     || [];
  TFW   = cfg.tf_weights    || {};
  INST_CFG = cfg.inst_profiles || {};
} catch (_) {
  // config missing — all defaults below apply
}

// ── CDP client — scans directly on the main (broker-connected) chart tab ──────
// Single-tab approach: the scanner controls TradingView's main chart tab.
// A second background tab is unreliable because Chrome throttles JS in background
// tabs, making TradingViewApi unresponsive when VNC is closed.
const CDP_HOST = 'localhost';
const CDP_PORT = 9222;

let _scannerClient    = null;
let _lastScannedSym   = null;   // tracks loaded symbol so setSymbol is skipped for same-instrument TF changes
let _consecutiveNulls = 0;
const MAX_CONSECUTIVE_NULLS = 10;

// ── Timeout helpers — prevent indefinite hangs when Chrome is down/restarting ─
// Without these, a fetch() to localhost:9222 mid-restart can hang forever and
// accumulate zombie processes that exhaust RAM and eventually OOM-kill Chrome.
const CDP_TIMEOUT_MS = 8000;

function withTimeout(promise, label = 'CDP operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${CDP_TIMEOUT_MS}ms`)), CDP_TIMEOUT_MS)
    ),
  ]);
}

async function fetchWithTimeout(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CDP_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function scannerEval(expression) {
  const c = await _getScannerClient();
  try {
    const r = await withTimeout(
      c.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: false }),
      'Runtime.evaluate'
    );
    if (r.exceptionDetails) return null;
    return r.result?.value ?? null;
  } catch(e) {
    // CDP dropped or timed out — reconnect on next call
    _scannerClient  = null;
    _lastScannedSym = null;
    return null;
  }
}

async function _getScannerClient() {
  // Fast path: reuse existing client if TradingViewApi is still ready
  if (_scannerClient) {
    try {
      const ready = await withTimeout(
        _scannerClient.Runtime.evaluate({
          expression: 'typeof window.TradingViewApi !== "undefined" && !!window.TradingViewApi._activeChartWidgetWV ? "ready" : "no"',
          returnByValue: true
        }),
        'readiness check'
      );
      if (ready.result?.value === 'ready') return _scannerClient;
    } catch (_) {}
    _scannerClient  = null;
    _lastScannedSym = null;
  }

  // Connect to the main TradingView chart tab (broker-connected, always foreground)
  const resp    = await fetchWithTimeout(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const mainTab  = targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
  if (!mainTab) throw new Error('TradingView chart tab not found on port 9222');

  _scannerClient = await withTimeout(
    CDP({ host: CDP_HOST, port: CDP_PORT, target: mainTab.id }),
    'CDP connect'
  );
  await withTimeout(_scannerClient.Runtime.enable(), 'Runtime.enable');
  console.log('  [Scanner] Connected to main chart tab:', mainTab.id);
  return _scannerClient;
}

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

// ── Wait for chart to settle with enough bars loaded ─────────────────────────
// TradingView fetches bars asynchronously after a symbol/TF switch. A fixed sleep
// sometimes returns too few bars (e.g. 60 instead of 300), making EMA-50/200 and
// the weekly trend proxy (needs ~270 bars on 15M) completely inaccurate.
// This polls until minRequired bars are available, retrying up to maxRetries times.
export async function waitForBars(count = 300, minRequired = 200, maxRetries = 4, retryMs = 600) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const bars = await getBars(count);
    if (bars && bars.length >= minRequired) return bars;
    if (attempt < maxRetries - 1) await sleep(retryMs);
  }
  return null;
}

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
const TF_WEIGHT = Object.keys(TFW).length > 0
  ? TFW
  : { '1': 0.25, '5': 0.5, '15': 1, '30': 1, '60': 1.5, '240': 2.5, 'D': 3, 'W': 4 };;

export const FULL_SCAN_LIST = [
  // ── TIER 1: Proven high WR — ranked by 2-week audit (Apr 13-25) ──
  // WTI 58%H1 | NAS100 48%H1 | US30 42%H1 | XAUUSD 34%H1 | EURUSD 40%H1 (rising)
  { sym: 'BLACKBULL:WTI',     label: 'WTI',     tfs: ALL_TFS, autoShort: true,  tier: 1 },
  { sym: 'BLACKBULL:NAS100',  label: 'NAS100',  tfs: ALL_TFS, autoShort: true,  tier: 1 },
  { sym: 'BLACKBULL:US30',    label: 'US30',    tfs: ALL_TFS, autoShort: true,  tier: 1 },
  { sym: 'BLACKBULL:XAUUSD',  label: 'XAUUSD',  tfs: ALL_TFS, autoShort: true,  tier: 1 },
  { sym: 'BLACKBULL:SPX500',  label: 'SPX500',  tfs: ALL_TFS, autoShort: true,  tier: 1 },
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
  { sym: 'BLACKBULL:GER40',   label: 'GER40',   tfs: ALL_TFS, autoShort: true,  tier: 3 },
  { sym: 'BLACKBULL:UK100',   label: 'UK100',   tfs: ALL_TFS, autoShort: true,  tier: 3 },
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
  if (sym !== _lastScannedSym) {
    // Symbol change — load new instrument (takes longer, give it more time)
    await scannerEval(`(function(){
      var a = window.TradingViewApi._activeChartWidgetWV.value();
      a.setSymbol('${sym}', null, true);
      a.setResolution('${tf}');
    })()`);
    await sleep(2500);
    _lastScannedSym = sym;
  } else {
    // Same instrument, TF change only — no setSymbol, chart stays stable
    await scannerEval(`(function(){
      var a = window.TradingViewApi._activeChartWidgetWV.value();
      a.setResolution('${tf}');
    })()`);
    await sleep(1500);
  }
}

export async function getBars(count = 200) {
  const result = await scannerEval(`(function() {
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

  if (result === null) {
    _consecutiveNulls++;
    if (_consecutiveNulls >= MAX_CONSECUTIVE_NULLS) {
      console.log(`\n  [Scanner] ${MAX_CONSECUTIVE_NULLS} consecutive null reads — forcing reconnect`);
      if (_scannerClient) { try { await _scannerClient.close(); } catch(_) {} }
      _scannerClient    = null;
      _lastScannedSym   = null;
      _consecutiveNulls = 0;
    }
    return null;
  }

  _consecutiveNulls = 0;
  return result;
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

// ── Heiken Ashi candles ───────────────────────────────────────────────────────
function calcHA(bars) {
  const ha = [];
  for (let i = 0; i < bars.length; i++) {
    const haC = (bars[i].o + bars[i].h + bars[i].l + bars[i].c) / 4;
    const haO = i === 0 ? (bars[i].o + bars[i].c) / 2 : (ha[i-1].o + ha[i-1].c) / 2;
    ha.push({ o: haO, h: Math.max(bars[i].h, haO, haC), l: Math.min(bars[i].l, haO, haC), c: haC });
  }
  return ha;
}

// ── Bollinger Bands ───────────────────────────────────────────────────────────
function calcBB(bars, len = 20, mult = 2.0) {
  return bars.map((_, i) => {
    if (i < len) return null;
    const slice = bars.slice(i - len, i);
    const sma = slice.reduce((s, b) => s + b.c, 0) / len;
    const std = Math.sqrt(slice.reduce((s, b) => s + (b.c - sma) ** 2, 0) / len);
    return { upper: sma + mult * std, lower: sma - mult * std, bw: std * 2 * mult / sma };
  });
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
// STRATEGY ENGINE — five strategies vote on direction
//
//  TREND:
//    A  SmartTrail aligned            (+1 when trail direction matches trade)
//    T  Weekly trend alignment        (+1 — W1 EMA proxy, REQUIRED gate)
//
//  SUPPORT & RESISTANCE ZONES:
//    C  S/R zone (wick-to-body)       (+2 fresh / +3 retested)
//    U  Daily PDH/PDL zone            (+1 — yesterday's high/low, REQUIRED gate)
//
//  FAIR VALUE GAP — institutional imbalance zones:
//    F  FVG zone hit (3-candle gap)   (+2 fresh+unmitigated / +1 old or mitigated)
//
//  Max score = 8, threshold = 6.
// ────────────────────────────────────────────────────────────────

// ── Opening Range Breakout (Crabel-style) ───────────────────────────────────
// Session start times (UTC) per instrument — when the "opening range" begins.
// Crypto is omitted: 24/7 markets have no canonical session open.
const ORB_SESSION_OPEN_UTC = {
  NAS100: '13:30', US30: '13:30', SPX500: '13:30',
  GER40: '07:00', UK100: '07:00', EUSTX50: '07:00',
  AUS200: '00:00', JP225: '00:00', HK50: '01:00',
  XAUUSD: '07:00', XAGUSD: '07:00', BRENT: '07:00', WTI: '13:00',
  EURUSD: '07:00', GBPUSD: '07:00', USDCHF: '07:00',
  EURGBP: '07:00', EURJPY: '07:00', GBPJPY: '07:00',
  AUDUSD: '00:00', NZDUSD: '00:00', USDJPY: '00:00', AUDJPY: '00:00',
  USDCAD: '13:30',
};
const ORB_DURATION_MIN = 30;

// Returns { boundary, orHigh, orLow } if the latest bar is the FIRST close
// beyond the session's opening range in `dir`; null otherwise.
function detectORB(bars, label, tf, dir) {
  const start = ORB_SESSION_OPEN_UTC[(label || '').toUpperCase()];
  if (!start) return null;
  const tfMin = parseInt(tf, 10);
  if (!tfMin || tfMin > 60) return null;       // skip 4H/D/W

  const nBarsInOR = Math.max(1, Math.ceil(ORB_DURATION_MIN / tfMin));
  const lastBar   = bars[bars.length - 1];
  if (!lastBar || !lastBar.t) return null;

  const d = new Date(lastBar.t);
  const [oh, om] = start.split(':').map(Number);
  const sessionStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), oh, om);
  const orEnd        = sessionStart + ORB_DURATION_MIN * 60 * 1000;

  if (lastBar.t < orEnd) return null;          // OR window not yet closed

  const orBars = bars.filter(b => b.t >= sessionStart && b.t < orEnd);
  if (orBars.length < nBarsInOR) return null;  // bars missing — wait

  const orHigh = Math.max(...orBars.map(b => b.h));
  const orLow  = Math.min(...orBars.map(b => b.l));

  const postOR = bars.filter(b => b.t >= orEnd);
  if (postOR.length === 0) return null;

  const prev = postOR.slice(0, -1);
  const last = postOR[postOR.length - 1];

  if (dir === 'long'  && last.c > orHigh && !prev.some(b => b.c > orHigh)) {
    return { boundary: 'high', orHigh, orLow };
  }
  if (dir === 'short' && last.c < orLow  && !prev.some(b => b.c < orLow)) {
    return { boundary: 'low',  orHigh, orLow };
  }
  return null;
}

// ── Opportunity-type classifier ────────────────────────────────────────────
// Looks at the current bars + indicators and decides which kind of setup is
// in front of us. Returns null when none of the four types match cleanly,
// in which case scoring falls back to the generic strategy sum (legacy).
//
// Types:
//   'continuation' — trend is clearly directional AND price pulled back to
//                    dynamic support (EMA21/50 or trendline) before resuming.
//   'breakout'     — price spent the last N bars in a tight range (low ATR
//                    relative to recent), and the current bar closes outside
//                    that range with above-average volume.
//   'reversal'     — RSI divergence vs price OR pin/engulf at PDH/PDL/FVG with
//                    the bar showing rejection (long wick into the zone,
//                    closing back). Trend may oppose — that's the point.
//   'retest'       — price broke a swing-high (for shorts) or swing-low (for
//                    longs) within the last 5 bars, then returned to the
//                    broken level and rejected (S→R or R→S flip).
//
// The classifier is conservative — only fires when conditions are clear, so
// many setups will return null and use the legacy scoring untouched.
export function classifySetup(bars, dir, ema8, ema21, ema50, rsi, atr) {
  const n = bars.length - 1;
  if (n < 30) return null;
  const last = bars[n];
  const recent = bars.slice(Math.max(0, n - 20), n + 1);

  // ── 1. CONTINUATION — trend strong + pullback to EMA ─────────────────────
  // EMA stack ordered AND price within 0.3 ATR of EMA21 (pullback zone).
  const emaSpread = Math.abs(ema8[n] - ema50[n]);
  const trendDirected = emaSpread / ema50[n] > 0.003;  // EMAs spread > 0.3% of price
  const stackUp   = ema8[n] > ema21[n] && ema21[n] > ema50[n];
  const stackDown = ema50[n] > ema21[n] && ema21[n] > ema8[n];
  const inPullback = Math.abs(last.c - ema21[n]) <= atr[n] * 0.3;
  if (trendDirected && inPullback &&
      ((dir === 'long' && stackUp) || (dir === 'short' && stackDown))) {
    return 'continuation';
  }

  // ── 2. BREAKOUT — recent range + this bar breaks out with volume ─────────
  const rangeBars = bars.slice(Math.max(0, n - 10), n);   // prior 10 bars
  if (rangeBars.length >= 8) {
    const rangeHigh = Math.max(...rangeBars.map(b => b.h));
    const rangeLow  = Math.min(...rangeBars.map(b => b.l));
    const rangeATR  = (rangeHigh - rangeLow) / atr[n];
    const tight     = rangeATR < 2.0;  // 10-bar range is < 2 ATR = consolidation
    const avgVol    = rangeBars.reduce((s, b) => s + (b.v || 0), 0) / rangeBars.length;
    const volSpike  = last.v && avgVol > 0 && last.v > avgVol * 1.4;
    const brokeUp   = dir === 'long'  && last.c > rangeHigh;
    const brokeDown = dir === 'short' && last.c < rangeLow;
    if (tight && volSpike && (brokeUp || brokeDown)) return 'breakout';
  }

  // ── 3. REVERSAL — RSI divergence OR pin/engulf rejection at zone ─────────
  // RSI divergence: price prints new extreme but RSI fails to confirm.
  if (n >= 20) {
    const window = bars.slice(n - 20, n + 1);
    const rsiWin = rsi.slice(n - 20, n + 1);
    if (dir === 'short') {
      // Bearish divergence: price higher high, RSI lower high
      const prevHighIdx = window.slice(0, -3).reduce((mx, b, i) => b.h > window[mx].h ? i : mx, 0);
      if (last.h > window[prevHighIdx].h && rsiWin[rsiWin.length - 1] < rsiWin[prevHighIdx] - 5) {
        return 'reversal';
      }
    } else {
      // Bullish divergence: price lower low, RSI higher low
      const prevLowIdx = window.slice(0, -3).reduce((mn, b, i) => b.l < window[mn].l ? i : mn, 0);
      if (last.l < window[prevLowIdx].l && rsiWin[rsiWin.length - 1] > rsiWin[prevLowIdx] + 5) {
        return 'reversal';
      }
    }
  }
  // Pin-at-extreme-of-range
  const range = last.h - last.l;
  if (range > 0) {
    const body = Math.abs(last.c - last.o);
    const upperWick = last.h - Math.max(last.c, last.o);
    const lowerWick = Math.min(last.c, last.o) - last.l;
    const swingH = Math.max(...recent.slice(0, -1).map(b => b.h));
    const swingL = Math.min(...recent.slice(0, -1).map(b => b.l));
    if (dir === 'short' && upperWick > 2 * body && last.h >= swingH) return 'reversal';
    if (dir === 'long'  && lowerWick > 2 * body && last.l <= swingL) return 'reversal';
  }

  // ── 4. RETEST — broke a swing level within last 5 bars, returned and rejected ─
  if (n >= 10) {
    const tail = bars.slice(n - 5, n + 1);
    if (dir === 'long') {
      const recentHigh = Math.max(...bars.slice(n - 15, n - 5).map(b => b.h));
      // Did we break above recentHigh, then come back to test it?
      const brokeAbove = tail.slice(0, -1).some(b => b.h > recentHigh);
      const retestedAndHeld = last.l <= recentHigh * 1.002 && last.c > recentHigh;
      if (brokeAbove && retestedAndHeld) return 'retest';
    } else {
      const recentLow = Math.min(...bars.slice(n - 15, n - 5).map(b => b.l));
      const brokeBelow = tail.slice(0, -1).some(b => b.l < recentLow);
      const retestedAndHeld = last.h >= recentLow * 0.998 && last.c < recentLow;
      if (brokeBelow && retestedAndHeld) return 'retest';
    }
  }

  return null;
}

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
  const emaFlat   = emaSpread / ema50[n] < (TC.ema_flat_pct ?? 0.004);
  if (emaFlat) {
    return { score: 2, reasons: ['EMA flat (ranging — no edge)'], strategies: [], rsi: rsi[n], atrVal: atr[n], activeFVG: null };
  }

  // ── A. SmartTrail direction ──
  if (st.dir[n] !== null) {
    const aligned = (dir === 'long' && st.dir[n] === 1) || (dir === 'short' && st.dir[n] === -1);
    if (aligned) {
      score += (SC.A_smarttrail ?? 1);
      reasons.push('SmartTrail aligned'); strats.push('A');
    }
  }

  // ── C. S/R Zone (wick-to-body) — price inside supply/demand zone ──
  //    Strict (C): price currently inside the wick-to-body zone — full score.
  //    Near  (C-near): price reversed within 0.4×ATR of a fresh/retested zone
  //      without entering it. This captures the Candlestick-Bible scenario where
  //      sellers/buyers front-run the zone (banks defending the level early).
  //      Awarded smaller score so it can't replace a strict touch but it stops
  //      the algo from being blind to S/R that is visibly respected on chart.
  {
    const atrLast = atr[n] || 0;
    const nearThresh = atrLast * (SC.C_near_atr ?? 0.4);

    const activeZone = srZones.active.find(z => {
      if (z.type === 'support'    && dir === 'long')  return last.c >= z.wickTip    && last.c <= z.bodyLevel;
      if (z.type === 'resistance' && dir === 'short') return last.c >= z.bodyLevel  && last.c <= z.wickTip;
      return false;
    });
    if (activeZone) {
      const pts = activeZone.retests > 0 ? (SC.C_sr_retested ?? 3) : (SC.C_sr_fresh ?? 2);
      const strength = activeZone.retests > 0 ? `${activeZone.retests}-retest` : 'fresh';
      score += pts;
      reasons.push(`S/R zone (${activeZone.type}) wick=${activeZone.wickTip.toFixed(4)} body=${activeZone.bodyLevel.toFixed(4)} ${strength}`);
      strats.push('C');
    } else if (nearThresh > 0) {
      // No strict zone touch — check proximity to recent zone instead.
      // Support for longs: zone wickTip is below entry, gap ≤ nearThresh.
      // Resistance for shorts: zone wickTip is above entry, gap ≤ nearThresh.
      const nearZone = srZones.active
        .filter(z => {
          if (z.type === 'support'    && dir === 'long')  return last.l <= z.bodyLevel + nearThresh && last.l > z.wickTip - nearThresh;
          if (z.type === 'resistance' && dir === 'short') return last.h >= z.bodyLevel - nearThresh && last.h < z.wickTip + nearThresh;
          return false;
        })
        .sort((a, b) => Math.abs(last.c - a.wickTip) - Math.abs(last.c - b.wickTip))[0];

      if (nearZone) {
        const pts = nearZone.retests > 0 ? (SC.C_near_retested ?? 2) : (SC.C_near_fresh ?? 1);
        const strength = nearZone.retests > 0 ? `${nearZone.retests}-retest` : 'fresh';
        score += pts;
        const dist = Math.abs(last.c - nearZone.wickTip);
        reasons.push(`Near S/R (${nearZone.type}) ${dist.toFixed(4)} from wick=${nearZone.wickTip.toFixed(4)} ${strength}`);
        strats.push('C-near');
      }
    }
  }

  // ── T. Weekly Trend Alignment — EMA proxy over one week of bars ──
  // BARS_PER_WEEK: how many bars of each TF span one trading week (5 × bpd).
  // W TF uses 13 bars (one quarter) — "weekly trend" on a weekly chart = multi-week direction.
  // For TFs where bpw > available bars (1M, 5M, some 15M), lookback < bpw and
  // the gate measures a shorter trend — labelled "trend aligned" rather than "W1 trend".
  {
    const BARS_PER_WEEK = { '1': 7200, '5': 1440, '15': 480, '30': 240, '60': 120, '240': 30, 'D': 5, 'W': 13 };
    const bpw = BARS_PER_WEEK[tf] ?? 480;
    const maxLookback = Math.floor(bars.length * 0.9);
    const lookback = Math.min(maxLookback, bpw);
    const isFullWeek = bpw <= maxLookback;
    if (lookback >= 5) {
      const emaW = calcEMA(bars, lookback);
      const shift = Math.max(1, Math.floor(lookback / 10));
      const wkBull = emaW[n] > emaW[n - shift];
      const wkBear = emaW[n] < emaW[n - shift];
      if ((dir === 'long' && wkBull) || (dir === 'short' && wkBear)) {
        score += (SC.T_weekly_trend ?? 1);
        reasons.push(isFullWeek ? 'W1 trend aligned' : 'Trend aligned (partial week)');
        strats.push('T');
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
        score += (SC.U_pdh_pdl ?? 1);
        reasons.push(`PDL support zone (${(pricePos*100).toFixed(0)}% of range, PDL=${PDL.toFixed(4)})`);
        strats.push('U');
      }
      if (nearPDH) {
        score += (SC.U_pdh_pdl ?? 1);
        reasons.push(`PDH resistance zone (${(pricePos*100).toFixed(0)}% of range, PDH=${PDH.toFixed(4)})`);
        strats.push('U');
      }
      const biasMatch = (dir === 'long' && bias === 'bullish') || (dir === 'short' && bias === 'bearish');
      if (biasMatch) {
        score += (SC.D_daily_bias ?? 1);
        reasons.push(`Daily bias ${bias}`); strats.push('D');
      } else if (bias !== 'neutral') {
        score -= (SC.bias_penalty ?? 1);
        reasons.push(`⚠ Daily bias ${bias} (counter-trend, -${SC.bias_penalty ?? 1})`);
      }
    }
  }

  // ── F. Fair Value Gap (FVG) — institutional imbalance zone ──
  {
    const fvgZones = detectFVGZones(bars, atr);
    const relevantType = dir === 'long' ? 'bullish' : 'bearish';
    const hitZones = fvgZones
      .filter(z => z.type === relevantType && last.c >= z.bottom && last.c <= z.top)
      .sort((a, b) => b.barIdx - a.barIdx);

    if (hitZones.length > 0) {
      activeFVG = hitZones[0];
      const pts = (activeFVG.fresh && !activeFVG.mitigated)
        ? (SC.F_fvg_fresh ?? 2)
        : (SC.F_fvg_other ?? 1);
      score += pts;
      reasons.push(`FVG ${activeFVG.fresh ? 'fresh' : 'old'}/${activeFVG.mitigated ? 'mitigated' : 'unmitigated'} [${activeFVG.bottom.toFixed(4)}–${activeFVG.top.toFixed(4)}]`);
      strats.push('F');
    }
  }

  // ── B. EMA Stack — three EMAs in clean trend order ──
  {
    const stacked = dir === 'long'
      ? ema8[n] > ema21[n] && ema21[n] > ema50[n]
      : ema50[n] > ema21[n] && ema21[n] > ema8[n];
    if (stacked) {
      score += (SC.B_ema_stack ?? 1);
      reasons.push('EMA stack aligned'); strats.push('B');
    }
  }

  // ── P. Prime session — London open + NY overlap (highest liquidity) ──
  {
    if (utcHour >= 8 && utcHour < 17) {
      score += (SC.P_prime_session ?? 1);
      reasons.push('Prime session'); strats.push('P');
    }
  }

  // ── R. RSI extreme — oversold for longs, overbought for shorts ──
  {
    const rsiVal = rsi[n];
    if ((dir === 'long' && rsiVal < 45) || (dir === 'short' && rsiVal > 55)) {
      score += (SC.R_rsi_extreme ?? 1);
      reasons.push(`RSI ${Math.round(rsiVal)}`); strats.push('R');
    }
  }

  // ── K. Candlestick pattern — pin bar, doji, engulfing ──
  {
    if (n >= 1) {
      const cur = last, prev = bars[n - 1];
      const body       = Math.abs(cur.c - cur.o);
      const range      = cur.h - cur.l;
      const upperWick  = cur.h - Math.max(cur.c, cur.o);
      const lowerWick  = Math.min(cur.c, cur.o) - cur.l;
      let pattern = null;
      if (range > 0) {
        if (body / range < 0.1) {
          pattern = 'Doji';
        } else if (dir === 'long'  && lowerWick > 2 * body && lowerWick > upperWick) {
          pattern = 'Pin bar';
        } else if (dir === 'short' && upperWick > 2 * body && upperWick > lowerWick) {
          pattern = 'Pin bar';
        } else if (dir === 'long'  && cur.c > cur.o && cur.o <= prev.c && cur.c >= prev.o) {
          pattern = 'Engulfing';
        } else if (dir === 'short' && cur.c < cur.o && cur.o >= prev.c && cur.c <= prev.o) {
          pattern = 'Engulfing';
        }
      }
      if (pattern) {
        score += (SC.K_candle_pattern ?? 1);
        reasons.push(pattern); strats.push('K');
      }
    }
  }

  // ── H. Heiken Ashi pullback — 2-4 opposing HA candles then flip with trend ──
  {
    const ha = calcHA(bars);
    const haDir = c => c.c >= c.o ? 1 : -1;
    const wantDir = dir === 'long' ? 1 : -1;
    if (ha.length >= 5 && haDir(ha[n]) === wantDir) {
      let pullLen = 0;
      for (let k = n - 1; k >= Math.max(0, n - 4); k--) {
        if (haDir(ha[k]) === -wantDir) pullLen++;
        else break;
      }
      if (pullLen >= 2) {
        score += (SC.H_ha_pullback ?? 1);
        reasons.push(`HA pullback (${pullLen} bars)`); strats.push('H');
      }
    }
  }

  // ── V. Volume spike — current bar 1.5× the 20-bar average ──
  {
    const slice = bars.slice(Math.max(0, n - 20), n);
    const avgVol = slice.reduce((s, b) => s + (b.v || 0), 0) / slice.length;
    if (avgVol > 0 && last.v > avgVol * 1.5) {
      score += (SC.V_volume_spike ?? 1);
      reasons.push(`Volume spike ${(last.v / avgVol).toFixed(1)}×`); strats.push('V');
    }
  }

  // ── O. ICT Optimal Trade Entry — 61.8–79% Fibonacci retracement zone ──
  {
    const lookback = bars.slice(Math.max(0, n - 30), n);
    const swingH = Math.max(...lookback.map(b => b.h));
    const swingL = Math.min(...lookback.map(b => b.l));
    const range  = swingH - swingL;
    if (range > 0) {
      if (dir === 'long') {
        const oteHigh = swingH - range * 0.618;
        const oteLow  = swingH - range * 0.79;
        if (last.c >= oteLow && last.c <= oteHigh) {
          score += (SC.O_ict_ote ?? 1);
          reasons.push(`ICT OTE long (${oteLow.toFixed(2)}–${oteHigh.toFixed(2)})`); strats.push('O');
        }
      } else {
        const oteLow  = swingL + range * 0.618;
        const oteHigh = swingL + range * 0.79;
        if (last.c >= oteLow && last.c <= oteHigh) {
          score += (SC.O_ict_ote ?? 1);
          reasons.push(`ICT OTE short (${oteLow.toFixed(2)}–${oteHigh.toFixed(2)})`); strats.push('O');
        }
      }
    }
  }

  // ── L. Trendline break/bounce — two-pivot structural line ──
  // Break  (+2): price crossed a trendline (reversal signal — higher conviction)
  // Bounce (+1): price touching but still inside a trendline (continuation signal)
  {
    const pivLen = 5;
    const findPivots = (type) => {
      const pivots = [];
      for (let i = n - pivLen - 1; i >= pivLen && pivots.length < 2; i--) {
        let ok = true;
        for (let j = i - pivLen; j <= i + pivLen; j++) {
          if (j !== i && (type === 'high' ? bars[j].h >= bars[i].h : bars[j].l <= bars[i].l)) { ok = false; break; }
        }
        if (ok) pivots.push({ idx: i, price: type === 'high' ? bars[i].h : bars[i].l });
      }
      return pivots;
    };

    if (dir === 'long') {
      // Break: price broke above a downward-sloping resistance trendline
      const highs = findPivots('high');
      if (highs.length === 2) {
        const slope = (highs[0].price - highs[1].price) / (highs[0].idx - highs[1].idx);
        const proj  = highs[0].price + slope * (n - highs[0].idx);
        if (slope < 0 && last.c > proj) {
          score += (SC.L_trendline_break ?? 2);
          reasons.push('Trendline break (resistance)'); strats.push('L');
        }
      }
      // Bounce: price near an upward-sloping support trendline (trend continuation)
      const lows = findPivots('low');
      if (lows.length === 2 && !strats.includes('L')) {
        const slope = (lows[0].price - lows[1].price) / (lows[0].idx - lows[1].idx);
        const proj  = lows[0].price + slope * (n - lows[0].idx);
        if (slope > 0 && last.l >= proj && last.l <= proj + atr[n] * 0.5) {
          score += (SC.L_trendline_bounce ?? 1);
          reasons.push('Trendline support (continuation)'); strats.push('L');
        }
      }
    } else {
      // Break: price broke below an upward-sloping support trendline
      const lows = findPivots('low');
      if (lows.length === 2) {
        const slope = (lows[0].price - lows[1].price) / (lows[0].idx - lows[1].idx);
        const proj  = lows[0].price + slope * (n - lows[0].idx);
        if (slope > 0 && last.c < proj) {
          score += (SC.L_trendline_break ?? 2);
          reasons.push('Trendline break (support)'); strats.push('L');
        }
      }
      // Bounce: price near a downward-sloping resistance trendline (trend continuation)
      const highs = findPivots('high');
      if (highs.length === 2 && !strats.includes('L')) {
        const slope = (highs[0].price - highs[1].price) / (highs[0].idx - highs[1].idx);
        const proj  = highs[0].price + slope * (n - highs[0].idx);
        if (slope < 0 && last.h <= proj && last.h >= proj - atr[n] * 0.5) {
          score += (SC.L_trendline_bounce ?? 1);
          reasons.push('Trendline resistance (continuation)'); strats.push('L');
        }
      }
    }
  }

  // ── BB. Bollinger Band touch or squeeze ──
  {
    const bb = calcBB(bars);
    const bbN = bb[n];
    if (bbN) {
      if (dir === 'long'  && last.l <= bbN.lower * 1.001) {
        score += (SC.BB_band_touch ?? 1);
        reasons.push('BB lower band touch'); strats.push('BB');
      } else if (dir === 'short' && last.h >= bbN.upper * 0.999) {
        score += (SC.BB_band_touch ?? 1);
        reasons.push('BB upper band touch'); strats.push('BB');
      }
      if (bbN.bw < 0.005) {
        score += (SC.BB_squeeze ?? 1);
        reasons.push('BB squeeze (breakout pending)'); strats.push('BB');
      }
    }
  }

  // ── OR. Opening Range Breakout — first close beyond session OR-high/OR-low ──
  // The OR boundary itself is a structural level (LEVEL family) and the breakout
  // candle is the trigger (SIGNAL family). High-edge setup — scored at +2.
  {
    const orb = detectORB(bars, label, tf, dir);
    if (orb) {
      score += (SC.OR_breakout ?? 2);
      const level = orb.boundary === 'high' ? orb.orHigh.toFixed(4) : orb.orLow.toFixed(4);
      reasons.push(`ORB ${dir} break of ${orb.boundary} @${level} (range ${orb.orLow.toFixed(4)}-${orb.orHigh.toFixed(4)})`);
      strats.push('OR');
    }
  }

  // ── Bulkowski chart patterns — only score CONFIRMED breakouts ──
  //   Triple Top/Bottom, Head & Shoulders (both), High & Tight Flag
  //   Each scores +2; the pattern itself implies Level + Signal confluence
  //   (see families in confluence.mjs — TB/TT and HS/IHS land in both families).
  {
    const pattern = detectChartPatterns(bars, atr, dir);
    if (pattern) {
      score += (SC.X_pattern_break ?? 2);
      reasons.push(`${pattern.name} [${pattern.confidence}] neck=${pattern.neckline} tgt=${pattern.target}`);
      strats.push(pattern.code);
    }
  }

  // ── Opportunity-type classifier + type-specific boost ────────────────────
  // Detect which kind of setup this is (continuation/breakout/reversal/retest)
  // and add a bonus when the strategies that fired actually match that type.
  // No type is preferred over another — we trade whichever opportunity
  // currently has the cleanest signature.
  //
  // For reversal and breakout setups the daily-bias penalty is refunded:
  // those types are EXPECTED to go against the prevailing daily bias, so
  // penalising for it is a category error.
  const setupType = classifySetup(bars, dir, ema8, ema21, ema50, rsi, atr);
  if (setupType) {
    const TYPE_BOOST = SC.setup_type_boost ?? 3;
    const typeStrategies = {
      continuation: ['A','B','T','L','H'],
      breakout:     ['OR','BB','V','L'],
      reversal:     ['K','H','R','F','U','BB','C','C-near'],
      retest:       ['C','C-near','F','U','K','H'],
    }[setupType] || [];
    const matched = [...new Set(strats)].filter(s => typeStrategies.includes(s));

    // Refund daily-bias penalty for setups that go against the bias (reversal / breakout).
    if (setupType === 'reversal' || setupType === 'breakout') {
      const penaltyMsg = reasons.findIndex(r => /counter-trend, -/.test(r));
      if (penaltyMsg >= 0) {
        score += (SC.bias_penalty ?? 1);
        reasons[penaltyMsg] = reasons[penaltyMsg] + ' (refunded — ' + setupType + ' setup)';
      }
    }

    // Add type-fit bonus only when at least 2 strategies of that family fired.
    if (matched.length >= 2) {
      score += TYPE_BOOST;
      reasons.push(`Setup type: ${setupType} (+${TYPE_BOOST} — ${matched.length} matching: ${matched.join(',')})`);
      strats.push(`TYPE_${setupType.toUpperCase()}`);
    } else {
      reasons.push(`Setup type: ${setupType} (no boost — only ${matched.length} matching strategies)`);
    }
  }

  return { score, reasons, strategies: [...new Set(strats)], setupType, rsi: rsi[n], atrVal: atr[n], activeFVG };
}

// ── Per-instrument SL/TP profiles ───────────────────────────────────────────
// slMode:   'fvg_sr' → FVG boundary first, then S&R zone, ATR fallback
//           'sr'     → S&R zone first, FVG secondary, ATR fallback
//           'atr'    → pure ATR (indices gap through zones, no snapping)
// maxSlAtr: max SL distance as ATR multiple (hard cap)
// minSlAtr: min SL distance as ATR multiple (avoids spread noise)
// tpCap:    max TP1 distance as ATR multiple
// tp3Cap:   max runner (TP2) distance as ATR multiple
const INST_PROFILE = {
  // Commodities: FVG + S&R zones — wide SL to survive institutional sweeps before trend resumes
  XAUUSD: { slMode: 'fvg_sr', maxSlAtr: 1.50, minSlAtr: 0.20, tpCap: 3.50, tp3Cap: 6.00 },
  XAGUSD: { slMode: 'fvg_sr', maxSlAtr: 1.50, minSlAtr: 0.20, tpCap: 3.50, tp3Cap: 6.00 },
  // WTI: ASIAN-session chop was clipping 0.2×ATR stops (4W/16L over recent
  // weeks, 13 of 16 losses in ASIAN). Force SL ≥1×ATR(15m) so noise can't
  // reap the stop on the retrace; lot sizing compensates by shrinking volume.
  WTI:    { slMode: 'fvg_sr', maxSlAtr: 2.00, minSlAtr: 1.00, tpCap: 3.50, tp3Cap: 6.00, tp1FloorR: 1.5 },

  // Crypto: wide SL required — liquidity sweeps below OBs are routine before continuation
  BTCUSD: { slMode: 'fvg_sr', maxSlAtr: 0.80, minSlAtr: 0.15, tpCap: 2.00, tp3Cap: 3.50 },
  ETHUSD: { slMode: 'fvg_sr', maxSlAtr: 0.80, minSlAtr: 0.15, tpCap: 2.00, tp3Cap: 3.50 },
  LTCUSD: { slMode: 'fvg_sr', maxSlAtr: 0.60, minSlAtr: 0.15, tpCap: 1.50, tp3Cap: 2.50 },
  XRPUSD: { slMode: 'fvg_sr', maxSlAtr: 0.60, minSlAtr: 0.15, tpCap: 1.50, tp3Cap: 2.50 },

  // Indices: ATR-based SL — gap through zones at open; 0.30 was smaller than spread causing instant stops
  NAS100: { slMode: 'atr',    maxSlAtr: 1.20, minSlAtr: 0.25, tpCap: 2.50, tp3Cap: 4.00 },
  US30:   { slMode: 'atr',    maxSlAtr: 1.20, minSlAtr: 0.25, tpCap: 2.50, tp3Cap: 4.00 },
  SPX500: { slMode: 'atr',    maxSlAtr: 1.20, minSlAtr: 0.25, tpCap: 2.50, tp3Cap: 4.00 },
  GER40:  { slMode: 'atr',    maxSlAtr: 1.50, minSlAtr: 0.25, tpCap: 3.00, tp3Cap: 5.00 },
  UK100:  { slMode: 'atr',    maxSlAtr: 1.20, minSlAtr: 0.25, tpCap: 2.50, tp3Cap: 4.00 },
  AUS200: { slMode: 'atr',    maxSlAtr: 1.20, minSlAtr: 0.25, tpCap: 2.50, tp3Cap: 4.00 },
  JP225:  { slMode: 'atr',    maxSlAtr: 1.50, minSlAtr: 0.25, tpCap: 3.00, tp3Cap: 5.00 },
  HK50:   { slMode: 'atr',    maxSlAtr: 1.50, minSlAtr: 0.25, tpCap: 3.00, tp3Cap: 5.00 },

  // Forex majors: wick-to-body S&R zones are reliable; moderate ATR, tight intraday ranges
  EURUSD: { slMode: 'sr',     maxSlAtr: 0.30, minSlAtr: 0.05, tpCap: 0.70, tp3Cap: 1.10 },
  GBPUSD: { slMode: 'sr',     maxSlAtr: 0.30, minSlAtr: 0.05, tpCap: 0.70, tp3Cap: 1.10 },
  AUDUSD: { slMode: 'sr',     maxSlAtr: 0.25, minSlAtr: 0.05, tpCap: 0.60, tp3Cap: 0.90 },
  NZDUSD: { slMode: 'sr',     maxSlAtr: 0.25, minSlAtr: 0.05, tpCap: 0.60, tp3Cap: 0.90 },
  USDCAD: { slMode: 'sr',     maxSlAtr: 0.30, minSlAtr: 0.05, tpCap: 0.70, tp3Cap: 1.10 },
  USDCHF: { slMode: 'sr',     maxSlAtr: 0.25, minSlAtr: 0.05, tpCap: 0.60, tp3Cap: 0.90 },

  // JPY pairs: strong trending behaviour with large pip moves; S&R respected but need more room
  USDJPY: { slMode: 'sr',     maxSlAtr: 0.40, minSlAtr: 0.08, tpCap: 0.90, tp3Cap: 1.40 },
  EURJPY: { slMode: 'sr',     maxSlAtr: 0.40, minSlAtr: 0.08, tpCap: 0.90, tp3Cap: 1.40 },
  GBPJPY: { slMode: 'sr',     maxSlAtr: 0.45, minSlAtr: 0.08, tpCap: 1.00, tp3Cap: 1.60 },
  AUDJPY: { slMode: 'sr',     maxSlAtr: 0.40, minSlAtr: 0.08, tpCap: 0.90, tp3Cap: 1.40 },
};
const DEFAULT_PROFILE = { slMode: 'sr', maxSlAtr: 0.30, minSlAtr: 0.05, tpCap: 0.70, tp3Cap: 1.10 };

// ── Main scan ──
//
// Two-pass MTF approach:
//  Pass 1 — scan all TFs (1M, 5M, 15M, 30M, 1H, 4H, D, W) for direction confluence
//  Pass 2 — once confluence is found, switch to 15M and calculate entry/SL/TP from
//            the 15M chart (tighter, more precise levels regardless of which TF triggered)
//
// One setup is emitted per instrument+direction, not per TF.
// MTF bonus: +1 if 2 TFs agree, +2 if 3+ TFs agree.
export async function scanForSetups(minScore = 6, slAtrMult = 1.5, onSetup = null) {
  const utcHour  = new Date().getUTCHours();
  const priority = sessionSymbols(utcHour);
  const results  = [];
  const skipped  = [];

  // ── Load today's daily watchlist if available (written by daily_selector.mjs at 06:30 UTC) ──
  const WATCHLIST_FILE = join(DATA_ROOT, 'daily_watchlist.json');
  let scanList = FULL_SCAN_LIST;
  try {
    if (existsSync(WATCHLIST_FILE)) {
      const wl = JSON.parse(readFileSync(WATCHLIST_FILE, 'utf8'));
      const today = new Date().toISOString().slice(0, 10);
      if (wl.date === today && Array.isArray(wl.instruments) && wl.instruments.length > 0) {
        scanList = wl.instruments;
        console.log(`  [daily_selector] Using today's watchlist: ${scanList.map(i => i.label).join(', ')}`);
      }
    }
  } catch (_) {}

  // ── Drop scan list down by blockedSymbols + broker_rejects ───────────────────
  // No point scanning symbols we can't trade — wastes ~8 chart switches per inst.
  // WTI in particular was killing scans with CDP timeouts (2026-05-24).
  let scanBlocked = new Set();
  try {
    const PARAMS_FILE = join(DATA_ROOT, 'trading_params.json');
    if (existsSync(PARAMS_FILE)) {
      const p = JSON.parse(readFileSync(PARAMS_FILE, 'utf8'));
      (p.blockedSymbols || []).forEach(s => scanBlocked.add(s));
    }
    const REJECT_FILE = join(DATA_ROOT, 'broker_rejects.json');
    if (existsSync(REJECT_FILE)) {
      const r = JSON.parse(readFileSync(REJECT_FILE, 'utf8'));
      const now = Date.now();
      for (const [sym, rec] of Object.entries(r)) {
        if (rec && rec.until && rec.until > now) scanBlocked.add(sym);
      }
    }
  } catch (_) {}
  if (scanBlocked.size > 0) {
    scanList = scanList.filter(i => !scanBlocked.has(i.label));
    console.log(`  [scan-block] Skipping ${[...scanBlocked].join(',')} (blockedSymbols / broker_rejects)`);
  }

  // Priority: put session-relevant symbols first, then the rest (preserving watchlist bias order)
  const ordered = [
    ...scanList.filter(i => priority.includes(i.label)),
    ...scanList.filter(i => !priority.includes(i.label)),
  ];

  console.log(`\n  UTC ${utcHour}:xx — Priority symbols: ${priority.join(', ')}`);
  console.log(`  Scanning ${ordered.length} instruments (MTF confluence → 15M entry)\n`);

  for (const inst of ordered) {
    const candidates = [];   // { tf, dir, score, strategies, reasons, rsi }

    // ── Pass 1: scan every TF, collect any that pass threshold ──────────────
    process.stdout.write(`  [T${inst.tier}] ${inst.label} `);

    let instrumentBroken = false;
    for (const tf of inst.tfs) {
      if (instrumentBroken) break;
      process.stdout.write(`${TF_LABEL[tf]||tf}:`);
      // Isolate per-TF errors so a single CDP timeout (e.g. Runtime.enable
      // exceeded 8000ms) doesn't kill the entire scan cycle. Skip the rest of
      // this instrument and move on.
      let bars = null;
      try {
        await setChart(inst.sym, tf);
        // Require ≥250 bars. 500-bar request gives 15M ~450 bars (4.7 days → near-weekly T gate),
        // 30M/1H/4H full-week coverage, D/W trivially covered. Retries 4× with 600ms gaps.
        bars = await waitForBars(500, 250);
      } catch (e) {
        process.stdout.write(`!${(e.message || 'err').slice(0, 12)} `);
        skipped.push(`${inst.label}/${tf}/${e.message}`);
        instrumentBroken = true;
        continue;
      }

      if (!bars) {
        process.stdout.write(`? `);
        skipped.push(`${inst.label}/${tf}`);
        continue;
      }

      const dcSnap = buildDailyContext(bars);
      if (dcSnap) logDailyContext(inst.label, tf, dcSnap);

      const directions = ['long', ...(inst.autoShort ? ['short'] : [])];
      for (const dir of directions) {
        const { score, reasons, strategies, rsi } = runAllStrategies(bars, dir, utcHour, inst.label, tf);
        if (score >= minScore) {
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
    const bars15 = await waitForBars(200, 150);

    for (const [dir, cands] of Object.entries(byDir)) {
      if (!bars15) {
        process.stdout.write(`\n  → 15M fetch failed for ${inst.label}\n`);
        continue;
      }

      // ── 15M alignment gate ──────────────────────────────────────────────────
      // Higher TFs confirmed the trend — now verify the 15M chart is also trending
      // in the SAME direction before entering. If the 15M is ranging or pointing
      // the other way, the trade is counter-trend on the entry TF — skip it.
      // Require: SmartTrail (A) OR EMA stack (B) aligned on 15M.
      const check15 = runAllStrategies(bars15, dir, utcHour, inst.label, '15');
      const is15mAligned = ['A', 'B', 'T', 'L'].some(s => check15.strategies.includes(s));
      if (!is15mAligned) {
        process.stdout.write(`\n  ⏭ ${inst.label} ${dir.toUpperCase()} — 15M not aligned (score=${check15.score}), waiting\n`);
        continue;
      }

      const tfList      = [...new Set(cands.map(c => TF_LABEL[c.tf] || c.tf))].join('+');
      const maxScore    = Math.max(...cands.map(c => c.score));
      const totalWeight = cands.reduce((s, c) => s + (TF_WEIGHT[c.tf] || 1), 0);
      // Higher TF confluence earns bigger bonus: W+D = 7pts → +3; D+4H = 5.5pts → +3; 1H alone = +1
      const mtfTiers  = MTFC.length > 0 ? MTFC : [
        { min_weight: 5, bonus: 3 }, { min_weight: 3, bonus: 2 },
        { min_weight: 1.5, bonus: 1 }, { min_weight: 0, bonus: 0 }
      ];
      const mtfBonus  = (mtfTiers.find(t => totalWeight >= t.min_weight) || { bonus: 0 }).bonus;
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

      // ── Per-instrument SL/TP strategy ────────────────────────────────────────────
      const prof = INST_CFG[inst.label] || INST_PROFILE[inst.label] || DEFAULT_PROFILE;
      const { slMode, maxSlAtr, minSlAtr, tpCap, tp3Cap } = prof;

      // ── SL placement ─────────────────────────────────────────────────────────────
      let sl;

      if (slMode === 'fvg_sr') {
        // 1. FVG boundary (tightest structural SL — institutions defend these)
        if (check15.activeFVG) {
          const fvg    = check15.activeFVG;
          const fvgSL  = dir === 'long' ? fvg.bottom - slBuf : fvg.top + slBuf;
          const fvgDist = Math.abs(entry - fvgSL);
          if (fvgDist >= atrVal * minSlAtr && fvgDist <= atrVal * maxSlAtr) sl = fvgSL;
        }
        // 2. Nearest S&R zone (if FVG not available or out of range)
        if (sl === undefined) {
          if (dir === 'long') {
            const z = sr15.active.filter(z => z.type === 'support' && z.wickTip < entry
              && (entry - z.wickTip) >= atrVal * minSlAtr
              && (entry - z.wickTip) <= atrVal * maxSlAtr).sort((a, b) => b.wickTip - a.wickTip);
            sl = z.length > 0 ? z[0].wickTip - slBuf : entry - atrVal * maxSlAtr;
          } else {
            const z = sr15.active.filter(z => z.type === 'resistance' && z.wickTip > entry
              && (z.wickTip - entry) >= atrVal * minSlAtr
              && (z.wickTip - entry) <= atrVal * maxSlAtr).sort((a, b) => a.wickTip - b.wickTip);
            sl = z.length > 0 ? z[0].wickTip + slBuf : entry + atrVal * maxSlAtr;
          }
        }

      } else if (slMode === 'atr') {
        // Pure ATR — indices gap through zones at session opens, no zone snapping
        sl = dir === 'long' ? entry - atrVal * maxSlAtr : entry + atrVal * maxSlAtr;

      } else {
        // 'sr' — S&R zone primary, FVG secondary, ATR fallback (forex + JPY pairs)
        if (dir === 'long') {
          const z = sr15.active.filter(z => z.type === 'support' && z.wickTip < entry
            && (entry - z.wickTip) >= atrVal * minSlAtr
            && (entry - z.wickTip) <= atrVal * maxSlAtr).sort((a, b) => b.wickTip - a.wickTip);
          sl = z.length > 0 ? z[0].wickTip - slBuf : entry - atrVal * maxSlAtr;
        } else {
          const z = sr15.active.filter(z => z.type === 'resistance' && z.wickTip > entry
            && (z.wickTip - entry) >= atrVal * minSlAtr
            && (z.wickTip - entry) <= atrVal * maxSlAtr).sort((a, b) => a.wickTip - b.wickTip);
          sl = z.length > 0 ? z[0].wickTip + slBuf : entry + atrVal * maxSlAtr;
        }
        // Secondary: FVG tighter override (only if valid and tighter than current SL)
        if (check15.activeFVG) {
          const fvg    = check15.activeFVG;
          const fvgSL  = dir === 'long' ? fvg.bottom - slBuf : fvg.top + slBuf;
          const fvgDist = Math.abs(entry - fvgSL);
          const curDist = Math.abs(entry - sl);
          if (fvgDist < curDist && fvgDist >= atrVal * minSlAtr) sl = fvgSL;
        }
      }

      // Hard cap at maxSlAtr regardless of mode
      if (dir === 'long'  && entry - sl > atrVal * maxSlAtr) sl = entry - atrVal * maxSlAtr;
      if (dir === 'short' && sl - entry > atrVal * maxSlAtr) sl = entry + atrVal * maxSlAtr;

      const slDist = Math.abs(entry - sl);

      // ── TP1 (tp2): nearest opposing S/R zone within tpCap × ATR ─────────────────
      let tp2;
      if (dir === 'long') {
        const z = sr15.active.filter(z => z.type === 'resistance' && z.wickTip > entry
          && (z.wickTip - entry) >= slDist * 0.5
          && (z.wickTip - entry) <= atrVal * tpCap).sort((a, b) => a.wickTip - b.wickTip);
        tp2 = z.length > 0 ? z[0].wickTip : entry + slDist;
      } else {
        const z = sr15.active.filter(z => z.type === 'support' && z.wickTip < entry
          && (entry - z.wickTip) >= slDist * 0.5
          && (entry - z.wickTip) <= atrVal * tpCap).sort((a, b) => b.wickTip - a.wickTip);
        tp2 = z.length > 0 ? z[0].wickTip : entry - slDist;
      }
      if (dir === 'long'  && tp2 - entry  > atrVal * tpCap) tp2 = entry + atrVal * tpCap;
      if (dir === 'short' && entry  - tp2  > atrVal * tpCap) tp2 = entry - atrVal * tpCap;

      // ── TP2 (tp3): runner beyond tp2, capped at tp3Cap × ATR ────────────────────
      let tp3;
      if (dir === 'long') {
        const z = sr15.active.filter(z => z.type === 'resistance'
          && z.wickTip > tp2 + slDist * 0.3
          && z.wickTip - entry <= atrVal * tp3Cap).sort((a, b) => a.wickTip - b.wickTip);
        tp3 = z.length > 0 ? z[0].wickTip : Math.min(entry + slDist * 3.0, entry + atrVal * tp3Cap);
      } else {
        const z = sr15.active.filter(z => z.type === 'support'
          && z.wickTip < tp2 - slDist * 0.3
          && entry - z.wickTip <= atrVal * tp3Cap).sort((a, b) => b.wickTip - a.wickTip);
        tp3 = z.length > 0 ? z[0].wickTip : Math.max(entry - slDist * 3.0, entry - atrVal * tp3Cap);
      }

      // ── 2:1 R:R enforcement ──────────────────────────────────────────────────────
      let actualRR = Math.round((Math.abs(tp2 - entry) / slDist) * 10) / 10;
      if (actualRR < 2.0) {
        const minTP    = dir === 'long' ? entry + slDist * 2.0 : entry - slDist * 2.0;
        const minTPDist = Math.abs(minTP - entry);
        tp2 = minTPDist <= atrVal * tpCap
          ? minTP
          : (dir === 'long' ? entry + atrVal * tpCap : entry - atrVal * tpCap);
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
        // tp1 = 1R take-profit for the near scalp leg of the 3-leg ladder.
        // Snaps to the nearest opposing zone within 1.5R if one exists; else exactly 1R.
        tp1:        (function(){
          // Per-instrument TP1 floor (multiple of SL distance). Default 1R; WTI
          // uses 1.5R so grazed-then-SL outcomes turn flat instead of -R.
          const floorR = prof.tp1FloorR ?? 1.0;
          const r1 = dir === 'long' ? entry + slDist * floorR : entry - slDist * floorR;
          // Snap to nearest opposing zone in the window [floor, floor+1R] — never
          // closer than the floor.
          const winMax = slDist * (floorR + 1.0);
          const nearby = sr15.active.filter(z =>
            (dir === 'long'  && z.type === 'resistance' && z.wickTip - entry >= slDist * floorR && z.wickTip - entry <= winMax) ||
            (dir === 'short' && z.type === 'support'    && entry - z.wickTip >= slDist * floorR && entry - z.wickTip <= winMax)
          );
          if (nearby.length) {
            nearby.sort((a,b) => dir === 'long' ? a.wickTip - b.wickTip : b.wickTip - a.wickTip);
            return Math.round(nearby[0].wickTip * 10000) / 10000;
          }
          return Math.round(r1 * 10000) / 10000;
        })(),
        tp2:        Math.round(tp2     * 10000) / 10000,
        tp3:        Math.round(tp3     * 10000) / 10000,
        rr:         actualRR,
        rsi:        avgRsi,
        tier:       inst.tier,
        mtfTFs:     cands.map(c => c.tf),
      };

      results.push(setup);
      process.stdout.write(`\n  ✅ ${inst.label} 15M ${dir.toUpperCase()} [${finalScore}] | MTF:${tfList} | Entry:${setup.entry} SL:${setup.sl} TP:${setup.tp2}\n`);

      // Inline trade callback — scanner pauses here while the trade is placed,
      // then continues to the next instrument without waiting for the position to close.
      if (onSetup) {
        try { await onSetup(setup); } catch (e) { process.stdout.write(`  [inline_trader] ${e.message}\n`); }
      }
    }
  }

  results.sort((a, b) => b.score - a.score || a.tier - b.tier);
  console.log(`\n  Found ${results.length} setups. Skipped: ${skipped.length}`);
  return results;
}

if (process.argv[1]?.endsWith('setup_finder.mjs')) {
  const setups = await scanForSetups();
  for (const s of setups) {
    console.log(`  [${s.score}/9][T${s.tier}] ${s.label} ${s.tf}M ${s.dir.toUpperCase()} | Entry:${s.entry} SL:${s.sl} TP1:${s.tpQuick}/TP2:${s.tp2}/TP3:${s.tp3} RR:${s.rr} | ${s.strategies.join(',')} | ${s.reasons.slice(0,4).join(', ')}`);
  }
}
