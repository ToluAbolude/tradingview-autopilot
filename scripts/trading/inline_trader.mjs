/**
 * inline_trader.mjs
 * Called by market_scanner.mjs immediately when a setup is found.
 * Applies all trading guards and places the order without waiting for the
 * current scan cycle to finish — eliminating the signal-staleness gap.
 *
 * Guards applied (same as session_runner.mjs):
 *   - Time gates: Sunday, EOD, last-entry cutoff, Friday cutoff
 *   - Session block (blockedSessions param)
 *   - News safety (global + per-symbol)
 *   - Daily stop rule (consecutive losses)
 *   - Loss cooldown (60-min per symbol+dir)
 *   - Already-open position (same symbol or correlated group)
 *   - Max concurrent positions
 *   - Correlated group dedup
 *   - Price sanity check
 *   - CRYPTO_ASIAN min-score gate
 */
import { placeOrder, getEquity, closeAllPositions } from './execute_trade.mjs';
import { getTodayRealizedPnl } from './broker_ctrader.mjs';
import { evaluate } from '../../src/connection.js';
import { fetchHighImpactNews, isSafeToTrade, filterForSymbol } from './news_checker.mjs';
import { analyzePerformance } from './performance_tracker.mjs';
import { trifectaCount, describeConfluence, hasTrifecta } from './confluence.mjs';
import { verifyOrderLanded } from './broker_history.mjs';
import { readFileSync, appendFileSync, existsSync, mkdirSync, openSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

const IS_LINUX  = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX ? '/home/ubuntu/trading-data' : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const LOG_DIR   = join(DATA_ROOT, 'trade_log');
const LOG_FILE  = join(LOG_DIR, 'trades.csv');
const PARAMS_FILE = join(DATA_ROOT, 'trading_params.json');

const CORRELATED_GROUPS = [
  ['NAS100', 'US30', 'SPX500'],
  ['BTCUSD', 'ETHUSD', 'SOLUSD', 'ADAUSD', 'XRPUSD', 'BNBUSD', 'LTCUSD'],
  ['XAUUSD', 'XAGUSD'],
  ['EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDCHF'],
  ['USDJPY', 'EURJPY', 'GBPJPY', 'AUDJPY'],
  ['WTI', 'USOIL'],
  ['GER40', 'UK100'],
];

const CRYPTO_SYMBOLS       = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'ADAUSD', 'XRPUSD', 'BNBUSD', 'LTCUSD'];
const CRYPTO_ASIAN_MIN_SCORE = 10;

const PRICE_RANGES = {
  WTI: [40, 200], USOIL: [40, 200],
  XAUUSD: [1000, 4000], XAGUSD: [10, 100],
  GER40: [10000, 30000], UK100: [6000, 13000],
  NAS100: [10000, 30000], US30: [25000, 55000], SPX500: [3000, 7000],
  BTCUSD: [10000, 200000], ETHUSD: [500, 15000], SOLUSD: [10, 1000],
  XRPUSD: [0.1, 20], BNBUSD: [100, 2000], LTCUSD: [20, 500],
};

// ── News cache — re-fetch once per hour so each per-setup call is fast ────────
let _newsCache      = null;
let _newsCacheAt    = 0;
const NEWS_TTL_MS   = 60 * 60 * 1000;

async function getNews() {
  if (_newsCache && Date.now() - _newsCacheAt < NEWS_TTL_MS) return _newsCache;
  _newsCache   = await fetchHighImpactNews();
  _newsCacheAt = Date.now();
  return _newsCache;
}

// ── Param loader — reads trading_params.json each call (hot-reload) ────────────
function loadParams() {
  if (!existsSync(PARAMS_FILE)) return { scoreThreshold: 8, stopRuleLosses: 4, riskPct: [6.0, 4.2, 3.0], maxConcurrent: 3, blockedSessions: [], blockedSymbols: [] };
  return JSON.parse(readFileSync(PARAMS_FILE, 'utf8'));
}

// ── Session helper ─────────────────────────────────────────────────────────────
function currentSession() {
  const h   = new Date().getUTCHours();
  const day = new Date().getUTCDay();
  if (day === 0 && h >= 22) return 'ASIAN';
  if (h >= 12 && h < 16) return 'LONDON-NY-OVERLAP';
  if (h >= 7  && h < 12) return 'LONDON';
  if (h >= 16 && h < 20) return 'NY';
  if (h >= 0  && h < 7)  return 'ASIAN';
  return 'DEAD-ZONE';
}

// ── Loss cooldown — 60 min per symbol (both directions blocked after any loss) ──
function getRecentLossCooldowns() {
  const cooldowns = new Set();
  if (!existsSync(LOG_FILE)) return cooldowns;
  const cutoff = Date.now() - 60 * 60 * 1000;
  const lines = readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols   = line.split(',');
    const ts     = (cols[0] || '').trim();
    const symbol = (cols[2] || '').trim();
    const result = (cols[10] || '').trim();
    if (!ts || !symbol || result !== 'L') continue;
    try { if (new Date(ts).getTime() >= cutoff) cooldowns.add(symbol); } catch (_) {}
  }
  return cooldowns;
}

// ── Per-symbol daily trade count ───────────────────────────────────────────────
function getDailySymbolCounts() {
  const counts = {};
  if (!existsSync(LOG_FILE)) return counts;
  const todayStr = new Date().toISOString().slice(0, 10);
  const lines = readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(1);
  for (const line of lines) {
    if (!line.trim() || !line.startsWith(todayStr)) continue;
    const cols   = line.split(',');
    const symbol = (cols[2] || '').trim();
    // Count EVERY placement attempt — W, L, VOID, and still-open (blank result).
    // The 2026-06-06 USDCHF loop fired 11 times in one day because each attempt
    // got marked VOID ~90s later and VOIDs never hit the caps. An attempt that
    // reached the broker consumed real spread/slippage whether or not the
    // monitor could match it afterwards.
    if (!symbol || symbol === 'NONE') continue;
    counts[symbol] = (counts[symbol] || 0) + 1;
  }
  return counts;
}

// ── Daily total trade count ────────────────────────────────────────────────────
function getDailyTotalCount() {
  if (!existsSync(LOG_FILE)) return 0;
  const todayStr = new Date().toISOString().slice(0, 10);
  const lines = readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(1);
  let count = 0;
  for (const line of lines) {
    if (!line.trim() || !line.startsWith(todayStr)) continue;
    const cols   = line.split(',');
    const symbol = (cols[2] || '').trim();
    // Every attempt counts (incl. VOID and still-open) — see getDailySymbolCounts.
    if (symbol && symbol !== 'NONE') count++;
  }
  return count;
}

// ── Open positions via BlackBull CDP panel ─────────────────────────────────────
async function getOpenSymbols() {
  try {
    await evaluate(`(function(){
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        if ((btns[i].textContent||'').trim() === 'Positions') { btns[i].click(); break; }
      }
    })()`);
    await new Promise(r => setTimeout(r, 800));

    const json = await evaluate(`(function(){
      if (/there are no open po/i.test(document.body.innerText||'')) return '[]';
      var rows = Array.from(document.querySelectorAll('tr'));
      var syms = [];
      rows.forEach(function(row) {
        var text = (row.innerText||'').replace(/\\s+/g,' ').trim();
        if (!/(Short|Long)/i.test(text) || text.length < 10) return;
        var m = text.match(/^([A-Z0-9]{3,10})/);
        if (m) {
          var raw = m[1];
          var sym = (raw.length > 6 && /^[SL]$/.test(raw.slice(-1))) ? raw.slice(0, -1) : raw;
          syms.push(sym);
        }
      });
      return JSON.stringify([...new Set(syms)]);
    })()`);
    return new Set(JSON.parse(json || '[]'));
  } catch(e) {
    console.log(`  [inline_trader] getOpenSymbols error: ${e.message} — using empty set`);
    return new Set();
  }
}

// ── CSV logging ────────────────────────────────────────────────────────────────
function logTrade(entry) {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  if (!existsSync(LOG_FILE)) {
    appendFileSync(LOG_FILE, 'date,session,symbol,tf,direction,score,entry,sl,tp,rr,result,pnl,notes\n');
  }
  const ts  = new Date().toISOString();
  const row = [
    ts,
    entry.session, entry.symbol, entry.tf, entry.direction,
    entry.score, entry.entry, entry.sl, entry.tp, entry.rr,
    entry.result || '', entry.pnl || '', entry.notes || '',
  ].join(',');
  appendFileSync(LOG_FILE, row + '\n');
  return ts;
}

// ── Lot sizing — identical to session_runner.mjs ───────────────────────────────
function calcLots(symbol, riskPct, accountEquity, entryPrice, slPrice) {
  const MIN_LOT  = 0.01;
  const LOT_STEP = 0.01;
  // Per-class hard caps (mirrors broker_ctrader assertOrderSafety). The old flat
  // cap of 10 let a collapsed-SL signal size to $1M FX notional on a $7k account.
  const MAX_FX     = 3;
  const MAX_METAL  = 2;
  const MAX_OIL    = 5;
  const MAX_INDEX  = 10;
  const MAX_CRYPTO = 3;
  const riskAmt  = accountEquity * (riskPct / 100);
  const slDist   = Math.abs(entryPrice - slPrice);
  if (slDist === 0) return MIN_LOT;
  const sym = symbol.toUpperCase();

  if (/XAU|GOLD/.test(sym)) {
    let lots = riskAmt / (100 * slDist);
    return Math.min(Math.max(Math.floor(lots / LOT_STEP) * LOT_STEP, MIN_LOT), MAX_METAL);
  } else if (/NAS100|NAS|NDX|NQ/.test(sym) || /US30|DOW|YM/.test(sym)) {
    let lots = riskAmt / slDist;
    return Math.min(Math.max(Math.floor(lots / LOT_STEP) * LOT_STEP, MIN_LOT), MAX_INDEX);
  } else if (/BTC|ETH|SOL|ADA|XRP|BNB|LTC/.test(sym)) {
    let lots = riskAmt / slDist;
    // Crypto risk cap at 1%
    const maxRisk = accountEquity * 0.01;
    const maxLots = Math.floor((maxRisk / slDist) / LOT_STEP) * LOT_STEP;
    lots = Math.min(lots, maxLots);
    return Math.min(Math.max(Math.floor(lots / LOT_STEP) * LOT_STEP, MIN_LOT), MAX_CRYPTO);
  } else if (/WTI|USOIL|CRUDE|BRENT|UKOIL/.test(sym)) {
    // BlackBull oil: whole-integer lots only, min 1.0 per leg. We run 3 legs so
    // total must be ≥3, but the total itself can be any integer (3,4,5,…); legs
    // are split unevenly via splitLegs() — e.g. 5 → [1,2,2], 10 → [3,3,4].
    const OIL_MIN_TOTAL_LOTS = 3.0;
    const OIL_STEP           = 1.0;
    const slPips = slDist / 0.01;
    let lots = riskAmt / (10.0 * slPips);
    lots = Math.floor(lots / OIL_STEP) * OIL_STEP;
    return Math.min(Math.max(lots, OIL_MIN_TOTAL_LOTS), MAX_OIL);
  } else if (/GER40|UK100|DAX|FTSE|SPX500|AUS200|JP225|HK50|EUSTX50/.test(sym)) {
    let lots = riskAmt / slDist;
    return Math.min(Math.max(Math.floor(lots / LOT_STEP) * LOT_STEP, MIN_LOT), MAX_INDEX);
  } else if (/JPY/.test(sym)) {
    const slPips = slDist / 0.01;
    let lots = riskAmt / (6.50 * slPips);
    return Math.min(Math.max(Math.floor(lots / LOT_STEP) * LOT_STEP, MIN_LOT), MAX_FX);
  } else if (/XAG|SILVER/.test(sym)) {
    // XAGUSD: 1 lot = 5000 oz
    let lots = riskAmt / (5000 * slDist);
    return Math.min(Math.max(Math.floor(lots / LOT_STEP) * LOT_STEP, MIN_LOT), MAX_METAL);
  } else {
    // Standard forex
    const slPips = slDist / 0.0001;
    let lots = riskAmt / (10.0 * slPips);
    return Math.min(Math.max(Math.floor(lots / LOT_STEP) * LOT_STEP, MIN_LOT), MAX_FX);
  }
}

// Split a total lot count into N legs, each ≥ minLeg, in `step` increments,
// distributing any remainder to the tail legs. Returns null if N legs at minLeg
// can't fit (caller should fall back to fewer legs).
//   splitLegs(5, 3, 1, 1)     → [1, 2, 2]
//   splitLegs(10, 3, 1, 1)    → [3, 3, 4]
//   splitLegs(0.06, 3, 0.01, 0.01) → [0.02, 0.02, 0.02]
function splitLegs(totalLots, n, minLeg, step) {
  const totalUnits = Math.round(totalLots / step);
  const minUnits   = Math.round(minLeg / step);
  if (totalUnits < minUnits * n) return null;
  const base = Math.floor(totalUnits / n);
  const legs = Array(n).fill(base);
  let rem = totalUnits - base * n;
  for (let i = n - 1; i >= 0 && rem > 0; i--, rem--) legs[i] += 1;
  return legs.map(u => Number((u * step).toFixed(4)));
}

// ── Per-scan-cycle state — tracks which correlated groups were traded this cycle ─
// Reset by market_scanner at the start of each scan cycle via resetCycleState().
let _cycleUsedGroups  = new Set();
let _cyclePlacedCount = 0;

// Last attempted entry per symbol+direction (persists across cycles within this
// scanner process). Used by the 30-min same-symbol+dir cooldown.
const _lastAttempt = new Map();
const ATTEMPT_COOLDOWN_MS = 30 * 60 * 1000;

export function resetCycleState() {
  _cycleUsedGroups  = new Set();
  _cyclePlacedCount = 0;
}

// ── Broker-reject temporary block list ─────────────────────────────────────────
// When verifyOrderLanded reports MISSING for a symbol, that symbol is added here
// for BROKER_BLOCK_TTL_MS so we stop spamming submit clicks the broker drops.
// Persisted to disk so the block survives scanner restarts.
const BROKER_BLOCK_FILE   = join(DATA_ROOT, 'broker_rejects.json');
const BROKER_BLOCK_TTL_MS = 4 * 60 * 60 * 1000;  // 4 hours — long enough to outlast a transient session/liquidity issue
// A symbol the broker doesn't carry on this account ("not in account symbol list")
// is effectively permanent — block it for 30d so we stop re-attempting it every
// scan cycle. Still auto-expires in case the account later enables the symbol.
const BROKER_UNSUPPORTED_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days

function loadBrokerBlocks() {
  if (!existsSync(BROKER_BLOCK_FILE)) return {};
  try { return JSON.parse(readFileSync(BROKER_BLOCK_FILE, 'utf8')); }
  catch (_) { return {}; }
}

function saveBrokerBlocks(map) {
  try { writeFileSync(BROKER_BLOCK_FILE, JSON.stringify(map, null, 2)); } catch (_) {}
}

function blockSymbolTemporarily(symbol, reason, ttlMs = BROKER_BLOCK_TTL_MS) {
  const blocks = loadBrokerBlocks();
  blocks[symbol] = { until: Date.now() + ttlMs, reason, blockedAt: new Date().toISOString() };
  saveBrokerBlocks(blocks);
}

function isBrokerBlocked(symbol) {
  const blocks = loadBrokerBlocks();
  const rec = blocks[symbol];
  if (!rec) return null;
  if (Date.now() >= rec.until) {
    // Expired — clean up
    delete blocks[symbol];
    saveBrokerBlocks(blocks);
    return null;
  }
  return rec;
}

// ── Main entry — called inline by scanForSetups for each qualifying setup ─────
export async function attemptInlineTrade(setup) {
  const tag = `[inline_trader][${setup.label}]`;
  const log  = msg => process.stdout.write(`  ${tag} ${msg}\n`);

  const PARAMS = loadParams();
  const MAX_CONCURRENT = PARAMS.maxConcurrent || 4;

  // ── 1. Time gates ──────────────────────────────────────────────────────────
  const now     = new Date();
  const h       = now.getUTCHours();
  const day     = now.getUTCDay();
  const utcMins = h * 60 + now.getUTCMinutes();

  // Weekend = Saturday all day + Sunday before ~22:00 UTC. FX/metals/indices are
  // closed then and cTrader QUEUES market orders to the illiquid Sunday open (the
  // 2026-06-06 USDCHF frozen-chart fills were swept for −$5,659 this way). CRYPTO
  // trades 24/7 with a live feed, so it is exempt from the weekend block. The
  // weekday EOD/last-entry/Friday cutoffs still apply to crypto (day-trade rule).
  // Kill switch: WEEKEND_CRYPTO=off blocks crypto on weekends too.
  const cryptoOK  = (process.env.WEEKEND_CRYPTO ?? 'on') !== 'off'
    && /BTC|ETH|SOL|ADA|XRP|BNB|LTC|DOT|AVAX|DOGE/i.test(setup.label || setup.symbol || '');
  const isWeekend = day === 6 || (day === 0 && h < 22);

  if (isWeekend) {
    if (!cryptoOK) { log('Weekend — markets closed (crypto-only). Skip.'); return; }
  } else {
    if (h >= 20 && day !== 0) { log('Past 20:00 UTC EOD cutoff. Skip.'); return; }
    if (day !== 0 && h === 19 && now.getUTCMinutes() >= 30) { log('Past 19:30 last-entry cutoff. Skip.'); return; }
    if (day === 5 && utcMins >= 21 * 60) { log('Friday 21:00 UTC cutoff. Skip.'); return; }
  }

  // ── 2. Session block ───────────────────────────────────────────────────────
  const session = currentSession();
  if (PARAMS.blockedSessions?.includes(session)) {
    log(`Session '${session}' is blocked. Skip.`); return;
  }

  // ── 2b. Broker-reject temporary block ──────────────────────────────────────
  // If this symbol's last submit was silently dropped by BlackBull, skip it
  // until the TTL expires (default 4h). Prevents the kind of 6-WTI-VOIDs-in-a-row
  // scenario seen on 2026-05-22.
  const brokerBlock = isBrokerBlocked(setup.label);
  if (brokerBlock) {
    const minsLeft = Math.round((brokerBlock.until - Date.now()) / 60000);
    log(`Broker-rejecting cooldown active for ${setup.label} (${brokerBlock.reason}, ${minsLeft}m left). Skip.`);
    return;
  }

  // ── 3. Score gate — Trifecta-aware ─────────────────────────────────────────
  // Trifecta: Trend + Level + Signal families (see confluence.mjs).
  //   3/3 (full)     → standard score threshold applies
  //   2/3 (partial)  → +1 score required (compensate the missing leg)
  //   1/3 (weak)     → +2 score required (almost always reject)
  //   0/3            → reject unconditionally (no structure backing)
  //
  // requireTrifecta=true in params forces a hard reject of anything < 3/3.
  const threshold = PARAMS.scoreThreshold || 8;
  const trif = trifectaCount(setup.strategies || []);
  const conf = describeConfluence(setup.strategies || []);

  if (PARAMS.requireTrifecta && trif < 3) {
    log(`Trifecta required but only ${trif}/3 (${conf}). Skip.`); return;
  }

  // Soft Trifecta gate — adjust effective threshold based on family coverage
  const effectiveThreshold =
    trif === 3 ? threshold :
    trif === 2 ? threshold + (PARAMS.trifectaPartialBonus ?? 1) :
    trif === 1 ? threshold + (PARAMS.trifectaWeakBonus    ?? 2) :
                 Infinity; // no families → cannot meet threshold, reject

  if (setup.score < effectiveThreshold) {
    log(`Score ${setup.score} < ${effectiveThreshold} (Trifecta ${trif}/3 → ${conf}). Skip.`); return;
  }

  // ── 3b. MTF depth gate — reject pure short-TF signals (15M/30M only) ───────
  // A setup with no ≥1H confluence is a single-timeframe signal with no macro backing.
  const SENIOR_TFS = new Set(['60', '240', 'D', 'W']);
  const mtfTFs = setup.mtfTFs || [];
  if (!mtfTFs.some(tf => SENIOR_TFS.has(tf))) {
    log(`No ≥1H TF confluence — MTF TFs: [${mtfTFs.join(',') || 'none'}]. Skip.`); return;
  }

  // ── 4. News safety ─────────────────────────────────────────────────────────
  let allNews = [];
  try { allNews = await getNews(); } catch (e) { log(`News fetch error: ${e.message}`); }
  const globalSafe = isSafeToTrade(allNews);
  if (!globalSafe.safe) { log(`Global news unsafe: ${globalSafe.reason}. Skip.`); return; }
  const symNews = filterForSymbol(allNews, setup.label);
  const symSafe = isSafeToTrade(symNews);
  if (!symSafe.safe) { log(`Symbol news unsafe: ${symSafe.reason}. Skip.`); return; }

  // ── 5. Daily stop rule ─────────────────────────────────────────────────────
  if (existsSync(LOG_FILE)) {
    const todayStr = now.toISOString().slice(0, 10);
    const trades = readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(1)
      .filter(l => l.startsWith(todayStr))
      .map(l => { const p = l.split(','); return { result: (p[10]||'').trim(), pnl: parseFloat(p[11]||0)||0 }; });
    const perf = analyzePerformance(trades);
    if (perf.consecLossSameSymbol >= PARAMS.stopRuleLosses) {
      log(`Stop rule: ${perf.consecLossSameSymbol} consecutive losses (limit ${PARAMS.stopRuleLosses}). Skip.`); return;
    }
  }

  // ── 5b. Per-symbol daily trade cap ────────────────────────────────────────
  // Max 2 executed (W/L) trades per symbol per day — prevents overtrading one instrument.
  const MAX_DAILY_PER_SYMBOL = PARAMS.maxDailyPerSymbol || 2;
  const symbolCounts = getDailySymbolCounts();
  if ((symbolCounts[setup.label] || 0) >= MAX_DAILY_PER_SYMBOL) {
    log(`Daily cap: ${symbolCounts[setup.label]}/${MAX_DAILY_PER_SYMBOL} trades already taken on ${setup.label} today. Skip.`); return;
  }

  // ── 5c. Daily total trades cap ────────────────────────────────────────────
  // Absolute ceiling on trades per day across all symbols.
  const MAX_DAILY_TOTAL = PARAMS.maxDailyTotal || 5;
  const dailyTotal = getDailyTotalCount();
  if (dailyTotal >= MAX_DAILY_TOTAL) {
    log(`Daily total cap reached (${dailyTotal}/${MAX_DAILY_TOTAL} trades today). Skip.`); return;
  }

  // ── 5d. Daily drawdown halt ───────────────────────────────────────────────
  // Halt for the day if today's REALISED P&L is a loss worse than the limit.
  // Reads the cTrader ledger (not trades.csv, whose P&L column is mostly VOID/0
  // and left this kill-switch blind through a -9% day on 2026-06-01).
  try {
    const todayPnl   = await getTodayRealizedPnl();
    const equityData = await getEquity().catch(() => ({}));
    const equity     = equityData.equity || equityData.balance || 10000;
    const drawdownPct = (todayPnl / equity) * 100;
    const MAX_DAILY_DRAWDOWN_PCT = PARAMS.maxDailyDrawdownPct || 3;
    if (drawdownPct <= -MAX_DAILY_DRAWDOWN_PCT) {
      log(`Daily drawdown halt: today realised P&L ${todayPnl.toFixed(0)} = ${drawdownPct.toFixed(1)}% (limit -${MAX_DAILY_DRAWDOWN_PCT}%). No more trades today.`); return;
    }
  } catch (e) {
    // Fail-open on a transient cTrader read error so a hiccup doesn't block all
    // trading — but log loudly so a persistently-blind halt is visible.
    log(`⚠ drawdown-halt check failed (${e.message}) — proceeding without it this cycle`);
  }

  // ── 5e. Sibling-symbol daily-bias gates ────────────────────────────────────
  // Some instruments follow a "parent" symbol's macro bias. Trading against it
  // historically destroys edge:
  //   XAGUSD → follows XAUUSD (silver follows gold ~80%; XAG shorts vs XAU
  //              long bias accounted for −$3,554 of XAG's lifetime drag)
  //   LTCUSD → follows BTCUSD (small-cap crypto tracks BTC; LTC went 0/14
  //              long over May 19–26 while BTC was bearish)
  // Daily bias comes from daily_watchlist.json (06:30 UTC computation).
  const SIBLING_BIAS = { XAGUSD: 'XAUUSD', LTCUSD: 'BTCUSD' };
  const parentSym = SIBLING_BIAS[setup.label];
  if (parentSym) {
    try {
      const WATCHLIST_FILE = join(DATA_ROOT, 'daily_watchlist.json');
      if (existsSync(WATCHLIST_FILE)) {
        const wl = JSON.parse(readFileSync(WATCHLIST_FILE, 'utf8'));
        const today = new Date().toISOString().slice(0, 10);
        if (wl.date === today && Array.isArray(wl.instruments)) {
          const parent = wl.instruments.find(i => i.label === parentSym);
          if (parent && parent.biasDir && parent.biasDir !== setup.dir) {
            log(`${setup.label} ${setup.dir} rejected — ${parentSym} daily bias is ${parent.biasDir} (sibling-bias gate). Skip.`);
            return;
          }
        }
      }
    } catch (e) { log(`${parentSym} bias check error: ${e.message} (continuing — fail-open)`); }
  }

  // ── 5f. With-trend bias gate ───────────────────────────────────────────────
  // edge_replay.mjs (2026-06-05, 481 real setups): counter-trend longs = −0.194R
  // (PF 0.68) vs with-trend = +0.246R (PF 1.63). Reject any setup that fights the
  // symbol's own daily bias when conviction is meaningful. Generalises the
  // "shorts win" regime finding into "don't fade the trend". Behind a flag so it
  // can be disabled; fail-open if the watchlist is missing/stale.
  if (PARAMS.requireWithTrendBias) {
    try {
      const WL_FILE = join(DATA_ROOT, 'daily_watchlist.json');
      if (existsSync(WL_FILE)) {
        const wl = JSON.parse(readFileSync(WL_FILE, 'utf8'));
        const today = new Date().toISOString().slice(0, 10);
        if (wl.date === today && Array.isArray(wl.instruments)) {
          const inst = wl.instruments.find(i => i.label === setup.label);
          const minBias = PARAMS.minBiasScore ?? 4;
          if (inst && inst.biasDir && (inst.biasScore ?? 0) >= minBias && inst.biasDir !== setup.dir) {
            log(`Counter-trend: ${setup.label} ${setup.dir} fights daily bias ${inst.biasDir} (score ${inst.biasScore} ≥ ${minBias}). Skip.`);
            return;
          }
        }
      }
    } catch (e) { log(`with-trend bias gate error: ${e.message} (fail-open)`); }
  }

  // ── 6. Loss cooldown ───────────────────────────────────────────────────────
  const cooldowns = getRecentLossCooldowns();
  if (cooldowns.has(setup.label)) {
    log(`60-min loss cooldown active for ${setup.label} (any direction). Skip.`); return;
  }

  // ── 6b. Per-instrument session block (asianBlock window) ───────────────────
  // Set in setup_finder's INST_PROFILE (e.g. WTI: asianBlockStart=22, end=7).
  // 11/11 losses on 2026-05-29 between 00:10 and 03:40 UTC made this concrete:
  // WTI is directionally right in Asian but stops get chopped 100% of the time.
  // Reject entries within the block window, regardless of score.
  const instProf = setup.profile || {};
  if (instProf.asianBlockStart != null && instProf.asianBlockEnd != null) {
    const utcH = h;
    const inWindow = instProf.asianBlockStart < instProf.asianBlockEnd
      ? (utcH >= instProf.asianBlockStart && utcH < instProf.asianBlockEnd)
      : (utcH >= instProf.asianBlockStart || utcH < instProf.asianBlockEnd);  // wraps midnight
    if (inWindow) {
      log(`${setup.label} ${setup.dir} blocked — inside asianBlock window ${instProf.asianBlockStart}-${instProf.asianBlockEnd} UTC. Skip.`);
      return;
    }
  }

  // ── 6c. Same-symbol+direction attempt cooldown ─────────────────────────────
  // Even before a loss is closed, block re-firing the same symbol+direction.
  // Per-instrument override via INST_PROFILE.cooldownMin (WTI uses 60min).
  // Stops the cluster-into-stop-pool pattern.
  const attemptKey = `${setup.label}|${setup.dir}`;
  const last = _lastAttempt.get(attemptKey);
  const cooldownMs = (instProf.cooldownMin ?? 30) * 60 * 1000;
  if (last && Date.now() - last < cooldownMs) {
    const minsLeft = Math.ceil((cooldownMs - (Date.now() - last)) / 60000);
    log(`Same-symbol+dir attempt cooldown active (${minsLeft}m left). Skip.`); return;
  }

  // ── 6d. Identical-signal 24h block (frozen-data guard, persisted) ──────────
  // A signal with the exact same entry AND SL hours later means the chart feed
  // is frozen, not that the market revisited the level to the pip. On
  // 2026-06-06 the same USDCHF 0.7958/0.7957 signal fired 11 times over 7h.
  // Persisted to disk so it survives scanner restarts (the in-memory cooldown
  // above does not).
  const dupKey  = `${setup.label}|${setup.dir}|${setup.entry}|${setup.sl}`;
  const dupFile = join(DATA_ROOT, 'attempted_orders.json');
  let dupMap = {};
  try { if (existsSync(dupFile)) dupMap = JSON.parse(readFileSync(dupFile, 'utf8')); } catch (_) {}
  const DUP_TTL_MS = 24 * 60 * 60 * 1000;
  for (const k of Object.keys(dupMap)) if (Date.now() - dupMap[k] > DUP_TTL_MS) delete dupMap[k];
  if (dupMap[dupKey]) {
    const hrsAgo = ((Date.now() - dupMap[dupKey]) / 3600000).toFixed(1);
    log(`Identical signal (entry=${setup.entry} sl=${setup.sl}) already attempted ${hrsAgo}h ago — frozen chart data suspected. Skip.`);
    return;
  }

  // ── 7. Blocked symbols ─────────────────────────────────────────────────────
  if (PARAMS.blockedSymbols?.includes(setup.label)) {
    log(`${setup.label} is blocked by params. Skip.`); return;
  }

  // ── 8. Crypto Asian gate ───────────────────────────────────────────────────
  if (session === 'ASIAN' && CRYPTO_SYMBOLS.includes(setup.label) && setup.score < CRYPTO_ASIAN_MIN_SCORE) {
    log(`Crypto score ${setup.score} < ${CRYPTO_ASIAN_MIN_SCORE} required in Asian. Skip.`); return;
  }

  // ── 9. Max concurrent ─────────────────────────────────────────────────────
  if (_cyclePlacedCount >= MAX_CONCURRENT) {
    log(`Max concurrent (${MAX_CONCURRENT}) reached this cycle. Skip.`); return;
  }

  // ── 10. Correlated group dedup (within this cycle) ─────────────────────────
  const groupIdx = CORRELATED_GROUPS.findIndex(g => g.includes(setup.label));
  if (groupIdx !== -1 && _cycleUsedGroups.has(groupIdx)) {
    log(`Correlated group already traded this cycle. Skip.`); return;
  }

  // ── 11. Price sanity ───────────────────────────────────────────────────────
  const priceRange = PRICE_RANGES[setup.label.toUpperCase()];
  if (priceRange && (setup.entry < priceRange[0] || setup.entry > priceRange[1])) {
    log(`Entry ${setup.entry} outside expected range [${priceRange[0]}–${priceRange[1]}] — corrupt signal. Skip.`); return;
  }

  // ── 12. Already-open position ──────────────────────────────────────────────
  // cTrader is a NETTING account: a 2nd order on a symbol that already has an
  // open position collapses into ONE net position and ORPHANS the per-leg SL/TP
  // limit orders → naked position (the 2026-05-29 NZDCAD incident). The DOM
  // scrape lags the broker, so for cTrader we use the API (source of truth) to
  // hard-block ANY new order while the symbol has open volume.
  const openSymbols = await getOpenSymbols();
  let symbolAlreadyOpen = openSymbols.has(setup.label);
  if (process.env.BROKER_PROVIDER === 'ctrader') {
    try {
      const bridge = await import('./broker_ctrader.mjs');
      symbolAlreadyOpen = (await bridge.getOpenVolumeForSymbol(setup.label)) > 0;
    } catch (e) {
      log(`cTrader open-volume check failed (${e.message}) — using DOM result (${symbolAlreadyOpen}).`);
    }
  }
  if (symbolAlreadyOpen) {
    log(`${setup.label} already has an open position. Skip (avoids netting into a naked position).`); return;
  }
  if (groupIdx !== -1) {
    const correlatedOpen = [...openSymbols].find(sym => CORRELATED_GROUPS[groupIdx].includes(sym));
    if (correlatedOpen) {
      log(`Correlated position already open: ${correlatedOpen}. Skip.`); return;
    }
  }

  // ── ALL GUARDS PASSED — place trade ───────────────────────────────────────
  log(`✅ All guards passed. Placing trade (score=${setup.score} dir=${setup.dir.toUpperCase()} Trifecta=${trif}/3 ${conf})`);

  const equityData = await getEquity().catch(() => ({}));
  const equity     = equityData.equity || equityData.balance || 10000;

  const [r1, r2, r3] = PARAMS.riskPct || [6.0, 4.2, 3.0];
  // Risk scales with how many concurrent trades are already running this cycle
  const alreadyPlaced = _cyclePlacedCount;
  const baseRisk = alreadyPlaced === 0 ? r1 : alreadyPlaced === 1 ? r2 : r3;
  const riskPct  = setup.score >= 8 ? baseRisk + 0.5 : baseRisk;

  // Per-broker minimum lot per leg. Oil contracts require whole integers ≥ 1.0;
  // everything else accepts 0.01 micro. A leg below its min is silently rejected,
  // so we round UP to the floor rather than down.
  const sym = setup.label.toUpperCase();
  const perLegMin = /WTI|USOIL|CRUDE|BRENT|UKOIL/.test(sym) ? 1.0 : 0.01;
  const legStep   = perLegMin;

  // ── Pre-submit SL sanity (also enforced broker-side in broker_ctrader's
  // assertOrderSafety; duplicated here so the TV-DOM fallback path is covered).
  // A collapsed SL distance (frozen ATR) explodes risk-based sizing — the
  // 2026-06-06 USDCHF signal had a 1-pip SL → 10 lots → −$5,659.
  const _minSlFrac =
    /XAU|GOLD|XAG|SILVER|COPPER/.test(sym) ? 0.0012 :
    /WTI|USOIL|CRUDE|BRENT|UKOIL/.test(sym) ? 0.004 :
    /NAS100|US30|SPX500|UK100|GER40|JP225|AUS200|HK50|DAX|FTSE/.test(sym) ? 0.0015 :
    /BTC|ETH|SOL|ADA|XRP|BNB|LTC|DOT|AVAX/.test(sym) ? 0.003 : 0.0008;
  const _slFrac = Math.abs(setup.entry - setup.sl) / setup.entry;
  if (!Number.isFinite(_slFrac) || _slFrac < _minSlFrac) {
    log(`REJECT: SL distance ${(_slFrac * 100).toFixed(3)}% of price < min ${(_minSlFrac * 100).toFixed(2)}% — collapsed/stale SL, sizing would explode. Skip.`);
    return;
  }

  // Record this exact signal so an identical re-fire is refused for 24h (6d).
  try {
    dupMap[dupKey] = Date.now();
    writeFileSync(dupFile, JSON.stringify(dupMap, null, 2));
  } catch (e) { log(`attempted_orders.json write failed: ${e.message}`); }

  const totalLots = calcLots(setup.label, riskPct, equity, setup.entry, setup.sl);
  // Split into 3 legs; for oil this may be uneven (e.g. 5 → [1,2,2]).
  // If 3 legs at minLeg won't fit (shouldn't happen — calcLots enforces ≥ 3 for oil
  // and ≥ 0.03 elsewhere), fall back to a single leg of totalLots.
  const legLots = splitLegs(totalLots, 3, perLegMin, legStep)
                  ?? [Math.max(perLegMin, totalLots)];
  const thirdLots = legLots[0]; // legacy: used in some log strings; per-leg uses legLots[i]

  // tp1 = ~1R near scalp (added 2026-05-26 to restore 3-leg ladder)
  // tp2 = first opposing S/R zone, ≥2R (existing logic)
  // tp3 = far runner cap; placed as a safety-net TP until chandelier trailing ships
  const lotsLabel = legLots.length === 3 && legLots[0] === legLots[2]
    ? `${legLots[0]}×3`
    : `[${legLots.join('+')}]=${legLots.reduce((a,b)=>a+b,0)}`;
  log(`Risk:${riskPct}% | Equity:${equity} | ${lotsLabel} lots | TP1:${setup.tp1} TP2:${setup.tp2} TP3:${setup.tp3} SL:${setup.sl}`);

  const legs = [
    { name: 'O1', tp: setup.tp1, minRR: 1.0, reanchor: false, screenshot: false },
    { name: 'O2', tp: setup.tp2, minRR: 2.0, reanchor: true,  screenshot: false },
    { name: 'O3', tp: setup.tp3, minRR: 2.0, reanchor: true,  screenshot: true  },
  ];

  let placed = 0;

  // ── cTrader path (Approach B) — 1 position + N limit-close orders ──────────
  // Switched from Approach A (3 separate positions) so we have a single SL/PnL
  // surface to manage. Cleaner deal history, simpler synthetic-BE (one modify
  // call instead of three).
  if (process.env.BROKER_PROVIDER === 'ctrader') {
    try {
      const bridge = await import('./broker_ctrader.mjs');
      const validTps = legs.filter(l => l.tp).map(l => l.tp);
      const totalUnits = legLots.reduce((a, b) => a + b, 0);
      // Pass per-leg lot sizes so oil can split unevenly (e.g. 5 → [1,2,2]).
      const legUnits = legLots.slice(0, validTps.length);
      const r = await bridge.placeMultiTpPosition({
        symbol:    setup.label,
        direction: setup.dir,
        totalUnits,
        legUnits,
        entry:     setup.entry,
        slPrice:   setup.sl,
        tpPrices:  validTps,
      });
      placed = validTps.length - r.failedTps.length;
      log(`✓ cTrader Approach B: position ${r.positionId} (${totalUnits} lots, SL=${setup.sl}) + ${r.tpOrderIds.length}/${validTps.length} TP limits placed at ${validTps.join(', ')}`);
      if (r.failedTps.length) log(`⚠ failed TP limits: ${r.failedTps.map(f => `${f.tpPrice}(${f.error})`).join('; ')}`);
    } catch (e) {
      // Symbol not enabled on the cTrader account is a permanent condition — block + bail.
      if (/not in account symbol list/i.test(e.message)) {
        blockSymbolTemporarily(setup.label, 'cTrader: symbol not in account symbol list', BROKER_UNSUPPORTED_TTL_MS);
        log(`✗ cTrader rejects ${setup.label} (not in account symbol list) — blocked ${BROKER_UNSUPPORTED_TTL_MS / 86400000}d, skipping DOM fallback`);
        return;
      }
      // Transient failure — almost always a request timeout on a stalled
      // long-lived connection. Force a reconnect and retry ONCE. We must NOT fall
      // through to the TV-DOM per-leg loop: on the cTrader provider it reports
      // "placed" without actually filling (the phantom-fill / silent-reject bug
      // that lost ~90% of orders). A clean skip is correct — the setup re-prints
      // next scan and we retry on a healthy connection.
      log(`⚠ cTrader placement error (${e.message}) — reconnecting + retrying once`);
      try {
        const bridge = await import('./broker_ctrader.mjs');
        try { await bridge.reconnect(); } catch (re) { log(`reconnect failed: ${re.message}`); }
        const validTps  = legs.filter(l => l.tp).map(l => l.tp);
        const totalUnits = legLots.reduce((a, b) => a + b, 0);
        const legUnits   = legLots.slice(0, validTps.length);
        const r = await bridge.placeMultiTpPosition({
          symbol: setup.label, direction: setup.dir, totalUnits, legUnits,
          entry: setup.entry, slPrice: setup.sl, tpPrices: validTps,
        });
        placed = validTps.length - r.failedTps.length;
        log(`✓ cTrader Approach B (after reconnect): position ${r.positionId} + ${r.tpOrderIds.length}/${validTps.length} TP limits`);
        if (r.failedTps.length) log(`⚠ failed TP limits: ${r.failedTps.map(f => `${f.tpPrice}(${f.error})`).join('; ')}`);
      } catch (e2) {
        if (/not in account symbol list/i.test(e2.message)) {
          blockSymbolTemporarily(setup.label, 'cTrader: symbol not in account symbol list', BROKER_UNSUPPORTED_TTL_MS);
        }
        log(`✗ cTrader placement failed after reconnect+retry (${e2.message}) — SKIPPING (no DOM phantom-fill).`);
        return;
      }
    }
  }

  // ── Per-leg loop (TV-DOM path, or cTrader fallback) ────────────────────────
  if (placed === 0) {
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const legUnits = legLots[i] ?? legLots[legLots.length - 1];
      if (!leg.tp) { log(`⚠ ${leg.name} skipped — no TP value`); continue; }
      try {
        await placeOrder({
          symbol: setup.label, direction: setup.dir, units: legUnits,
          entry: setup.entry,
          tpPrice: leg.tp, slPrice: setup.sl,
          minRR: leg.minRR, reanchorTpAtMinRR: leg.reanchor,
          screenshot: leg.screenshot,
        });
        log(`✓ ${leg.name} placed (${legUnits} lots, TP=${leg.tp} SL=${setup.sl})`);
        placed++;
      } catch(e) {
        log(`✗ ${leg.name} error: ${e.message}`);
        await new Promise(r => setTimeout(r, 2000));
        try {
          await placeOrder({
            symbol: setup.label, direction: setup.dir, units: legUnits,
            entry: setup.entry,
            tpPrice: leg.tp, slPrice: setup.sl,
            minRR: leg.minRR, reanchorTpAtMinRR: leg.reanchor,
            screenshot: false,
          });
          log(`✓ ${leg.name} placed on retry (TP=${leg.tp} SL=${setup.sl})`);
          placed++;
        } catch(e2) {
          log(`✗ ${leg.name} retry also failed: ${e2.message}`);
        }
      }
    }
  }

  if (placed > 0) {
    _cyclePlacedCount++;
    if (groupIdx !== -1) _cycleUsedGroups.add(groupIdx);
    _lastAttempt.set(`${setup.label}|${setup.dir}`, Date.now());

    // ── Post-submit broker verification (TV-DOM path only) ──
    // The TradingView submit click can silently fail to route to BlackBull
    // (observed on WTI 2026-05-22: bot logged ✓ placed but broker never received).
    // We scrape Order History to detect silent rejects.
    // When BROKER_PROVIDER=ctrader, the cTrader API returns synchronous accept/
    // reject — the scrape is redundant AND wrong (it may miss the just-placed
    // order if TV's panel hasn't synced yet, then false-mark VOID).
    const submitTs = new Date().toISOString();
    let brokerOk = process.env.BROKER_PROVIDER === 'ctrader' ? true : null;
    if (process.env.BROKER_PROVIDER !== 'ctrader') {
      try {
        await new Promise(r => setTimeout(r, 4000));
        brokerOk = await verifyOrderLanded(setup.label, setup.dir, submitTs, 120);
        log(`Broker verify: ${brokerOk ? '✓ order found in broker history' : '✗ order MISSING from broker history (silent reject)'}`);
      } catch (e) {
        log(`Broker verify error: ${e.message} (treating as inconclusive)`);
      }
    } else {
      log(`Broker verify: ✓ skipped (cTrader synchronous confirm covers this)`);
    }

    if (brokerOk === false) {
      // Silent reject — record VOID, do NOT launch monitor, block symbol short-term
      logTrade({
        session, symbol: setup.label, tf: setup.tf, direction: setup.dir,
        score: setup.score, entry: setup.entry, sl: setup.sl,
        tp: `${setup.tp1}/${setup.tp2}/${setup.tp3}`, rr: setup.rr,
        result: 'VOID', pnl: 0,
        notes: (setup.reasons || []).join(';') + ` lots=${lotsLabel} placed=${placed} inline Trifecta=${trif}/3 [${conf}] BROKER_SILENT_REJECT_verified`,
      });
      blockSymbolTemporarily(setup.label, 'broker silent reject');
      _cyclePlacedCount--; // rollback — this trade didn't actually open
      if (groupIdx !== -1) _cycleUsedGroups.delete(groupIdx);
    } else {
      // Either verified OK or check inconclusive — treat as live trade
      const tradeTime = logTrade({
        session, symbol: setup.label, tf: setup.tf, direction: setup.dir,
        score: setup.score, entry: setup.entry, sl: setup.sl,
        tp: `${setup.tp1}/${setup.tp2}/${setup.tp3}`, rr: setup.rr,
        notes: (setup.reasons || []).join(';') + ` lots=${lotsLabel} placed=${placed} inline Trifecta=${trif}/3 [${conf}] verify=${brokerOk === true ? 'ok' : 'skipped'}`,
      });

      // Launch position monitor (detached — runs independently until position closes)
      const monitorPath = join(__dirname, 'position_monitor.mjs');
      const monitorLog  = join(DATA_ROOT, `monitor_${setup.label}.log`);
      const logFd = openSync(monitorLog, 'a');
      const monitor = spawn(process.execPath, [
        monitorPath,
        `--entry=${setup.entry}`,
        `--sl=${setup.sl}`,
        `--tp1=${setup.tp1}`,
        `--tp2=${setup.tp2}`,
        `--tp3=${setup.tp3}`,
        `--symbol=${setup.label}`,
        `--numOrders=${placed}`,
        `--tradeTime=${tradeTime}`,
      ], { detached: true, stdio: ['ignore', logFd, logFd] });
      monitor.unref();
      log(`Monitor launched (pid ${monitor.pid})`);
    }
  }

  // Brief pause so the broker panel settles before the next instrument is scanned
  await new Promise(r => setTimeout(r, 1500));
}
