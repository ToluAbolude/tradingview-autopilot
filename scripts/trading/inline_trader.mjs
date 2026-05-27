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
    const result = (cols[10] || '').trim();
    // Only count placed trades (W or L), not VOID/?
    if (!symbol || symbol === 'NONE' || !['W', 'L'].includes(result)) continue;
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
    const result = (cols[10] || '').trim();
    if (['W', 'L'].includes(result)) count++;
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
  const MAX_LOTS = 10;
  const riskAmt  = accountEquity * (riskPct / 100);
  const slDist   = Math.abs(entryPrice - slPrice);
  if (slDist === 0) return MIN_LOT;
  const sym = symbol.toUpperCase();

  if (/XAU|GOLD/.test(sym)) {
    let lots = riskAmt / (100 * slDist);
    return Math.min(Math.max(Math.floor(lots / LOT_STEP) * LOT_STEP, MIN_LOT), MAX_LOTS);
  } else if (/NAS100|NAS|NDX|NQ/.test(sym) || /US30|DOW|YM/.test(sym)) {
    let lots = riskAmt / slDist;
    return Math.min(Math.max(Math.floor(lots / LOT_STEP) * LOT_STEP, MIN_LOT), MAX_LOTS);
  } else if (/BTC|ETH|SOL|ADA|XRP|BNB|LTC/.test(sym)) {
    let lots = riskAmt / slDist;
    // Crypto risk cap at 1%
    const maxRisk = accountEquity * 0.01;
    const maxLots = Math.floor((maxRisk / slDist) / LOT_STEP) * LOT_STEP;
    lots = Math.min(lots, maxLots);
    return Math.min(Math.max(Math.floor(lots / LOT_STEP) * LOT_STEP, MIN_LOT), MAX_LOTS);
  } else if (/WTI|USOIL|CRUDE|BRENT|UKOIL/.test(sym)) {
    // BlackBull oil contracts (WTI + BRENT) accept WHOLE-NUMBER lots only, min 1.0
    // per submit. Bot now thirds total into three legs (O1+O2+O3), so total must
    // be >=3.0 and divisible by 3 so each leg is an integer >= 1.0.
    const OIL_MIN_TOTAL_LOTS = 3.0;
    const OIL_LOT_STEP       = 3.0;   // step in 3s so each third is an integer
    const slPips = slDist / 0.01;
    let lots = riskAmt / (10.0 * slPips);
    lots = Math.floor(lots / OIL_LOT_STEP) * OIL_LOT_STEP;
    return Math.min(Math.max(lots, OIL_MIN_TOTAL_LOTS), MAX_LOTS);
  } else if (/GER40|UK100|DAX|FTSE|SPX500|AUS200|JP225|HK50|EUSTX50/.test(sym)) {
    let lots = riskAmt / slDist;
    return Math.min(Math.max(Math.floor(lots / LOT_STEP) * LOT_STEP, MIN_LOT), MAX_LOTS);
  } else if (/JPY/.test(sym)) {
    const slPips = slDist / 0.01;
    let lots = riskAmt / (6.50 * slPips);
    return Math.min(Math.max(Math.floor(lots / LOT_STEP) * LOT_STEP, MIN_LOT), MAX_LOTS);
  } else if (/XAG|SILVER/.test(sym)) {
    // XAGUSD: 1 lot = 5000 oz
    let lots = riskAmt / (5000 * slDist);
    return Math.min(Math.max(Math.floor(lots / LOT_STEP) * LOT_STEP, MIN_LOT), MAX_LOTS);
  } else {
    // Standard forex
    const slPips = slDist / 0.0001;
    let lots = riskAmt / (10.0 * slPips);
    return Math.min(Math.max(Math.floor(lots / LOT_STEP) * LOT_STEP, MIN_LOT), MAX_LOTS);
  }
}

// ── Per-scan-cycle state — tracks which correlated groups were traded this cycle ─
// Reset by market_scanner at the start of each scan cycle via resetCycleState().
let _cycleUsedGroups  = new Set();
let _cyclePlacedCount = 0;

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

function loadBrokerBlocks() {
  if (!existsSync(BROKER_BLOCK_FILE)) return {};
  try { return JSON.parse(readFileSync(BROKER_BLOCK_FILE, 'utf8')); }
  catch (_) { return {}; }
}

function saveBrokerBlocks(map) {
  try { writeFileSync(BROKER_BLOCK_FILE, JSON.stringify(map, null, 2)); } catch (_) {}
}

function blockSymbolTemporarily(symbol, reason) {
  const blocks = loadBrokerBlocks();
  blocks[symbol] = { until: Date.now() + BROKER_BLOCK_TTL_MS, reason, blockedAt: new Date().toISOString() };
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

  if (day === 0 && h < 22) { log('Sunday market not open. Skip.'); return; }
  if (h >= 20 && day !== 0) { log('Past 20:00 UTC EOD cutoff. Skip.'); return; }
  if (day !== 0 && h === 19 && now.getUTCMinutes() >= 30) { log('Past 19:30 last-entry cutoff. Skip.'); return; }
  if (day === 5 && utcMins >= 21 * 60) { log('Friday 21:00 UTC cutoff. Skip.'); return; }

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
  // If today's realised PnL is a loss worse than 3% of equity, halt for the day.
  if (existsSync(LOG_FILE)) {
    const todayStr = now.toISOString().slice(0, 10);
    const todayPnl = readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(1)
      .filter(l => l.startsWith(todayStr))
      .reduce((sum, l) => {
        const p = l.split(',');
        const result = (p[10] || '').trim();
        if (!['W', 'L'].includes(result)) return sum;
        return sum + (parseFloat(p[11] || 0) || 0);
      }, 0);
    const equityData = await getEquity().catch(() => ({}));
    const equity     = equityData.equity || equityData.balance || 10000;
    const drawdownPct = (todayPnl / equity) * 100;
    const MAX_DAILY_DRAWDOWN_PCT = PARAMS.maxDailyDrawdownPct || 3;
    if (drawdownPct <= -MAX_DAILY_DRAWDOWN_PCT) {
      log(`Daily drawdown halt: today P&L ${todayPnl.toFixed(0)} = ${drawdownPct.toFixed(1)}% (limit -${MAX_DAILY_DRAWDOWN_PCT}%). No more trades today.`); return;
    }
  }

  // ── 6. Loss cooldown ───────────────────────────────────────────────────────
  const cooldowns = getRecentLossCooldowns();
  if (cooldowns.has(setup.label)) {
    log(`60-min loss cooldown active for ${setup.label} (any direction). Skip.`); return;
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

  // ── 12. Already-open position (live CDP check) ─────────────────────────────
  const openSymbols = await getOpenSymbols();
  if (openSymbols.has(setup.label)) {
    log(`${setup.label} already has an open position. Skip.`); return;
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
  const totalLots = calcLots(setup.label, riskPct, equity, setup.entry, setup.sl);
  // Split into 3 equal legs, each rounded to symbol's leg step and at least perLegMin.
  const legLotsRaw = totalLots / 3;
  const thirdLots  = Math.max(perLegMin, Math.floor(legLotsRaw / legStep) * legStep);

  // tp1 = ~1R near scalp (added 2026-05-26 to restore 3-leg ladder)
  // tp2 = first opposing S/R zone, ≥2R (existing logic)
  // tp3 = far runner cap; placed as a safety-net TP until chandelier trailing ships
  log(`Risk:${riskPct}% | Equity:${equity} | ${thirdLots}×3 lots | TP1:${setup.tp1} TP2:${setup.tp2} TP3:${setup.tp3} SL:${setup.sl}`);

  const legs = [
    { name: 'O1', tp: setup.tp1, minRR: 1.0, reanchor: false, screenshot: false },
    { name: 'O2', tp: setup.tp2, minRR: 2.0, reanchor: true,  screenshot: false },
    { name: 'O3', tp: setup.tp3, minRR: 2.0, reanchor: true,  screenshot: true  },
  ];

  let placed = 0;
  for (const leg of legs) {
    if (!leg.tp) { log(`⚠ ${leg.name} skipped — no TP value`); continue; }
    try {
      await placeOrder({
        symbol: setup.label, direction: setup.dir, units: thirdLots,
        entry: setup.entry,   // cTrader path uses this for relative SL/TP; TV path ignores
        tpPrice: leg.tp, slPrice: setup.sl,
        minRR: leg.minRR, reanchorTpAtMinRR: leg.reanchor,
        screenshot: leg.screenshot,
      });
      log(`✓ ${leg.name} placed (TP=${leg.tp} SL=${setup.sl})`);
      placed++;
    } catch(e) {
      log(`✗ ${leg.name} error: ${e.message}`);
      // One retry after a short pause — covers transient ticket/DOM hiccups.
      await new Promise(r => setTimeout(r, 2000));
      try {
        await placeOrder({
          symbol: setup.label, direction: setup.dir, units: thirdLots,
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

  if (placed > 0) {
    _cyclePlacedCount++;
    if (groupIdx !== -1) _cycleUsedGroups.add(groupIdx);

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
        notes: (setup.reasons || []).join(';') + ` lots=${thirdLots}x3 placed=${placed} inline Trifecta=${trif}/3 [${conf}] BROKER_SILENT_REJECT_verified`,
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
        notes: (setup.reasons || []).join(';') + ` lots=${thirdLots}x3 placed=${placed} inline Trifecta=${trif}/3 [${conf}] verify=${brokerOk === true ? 'ok' : 'skipped'}`,
      });

      // Launch position monitor (detached — runs independently until position closes)
      const monitorPath = join(__dirname, 'position_monitor.mjs');
      const monitorLog  = join(DATA_ROOT, `monitor_${setup.label}.log`);
      const logFd = openSync(monitorLog, 'a');
      const monitor = spawn(process.execPath, [
        monitorPath,
        `--entry=${setup.entry}`,
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
