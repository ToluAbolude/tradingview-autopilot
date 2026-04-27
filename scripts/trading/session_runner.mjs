/**
 * session_runner.mjs
 * Main orchestrator — runs at each session start via cron.
 * 1. Fetch news → check safety
 * 2. Scan for setups (score ≥ 4/6)
 * 3. If best setup found → place trade
 * 4. Log result
 *
 * Token-efficient: does ONE pass per session, stops after best trade placed.
 */
import { fetchHighImpactNews, isSafeToTrade, filterForSymbol } from './news_checker.mjs';
import { scanForSetups } from './setup_finder.mjs';
import { placeOrder, getEquity } from './execute_trade.mjs';
import { fetchTwitterSignals, aggregateSignals } from './twitter_feed.mjs';
import { analyzePerformance } from './performance_tracker.mjs';
import { readFileSync, appendFileSync, existsSync, mkdirSync, openSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

const IS_LINUX = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX
  ? '/home/ubuntu/trading-data'
  : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const LOG_DIR  = join(DATA_ROOT, 'trade_log');
const LOG_FILE = join(LOG_DIR, 'trades.csv');

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function logTrade(entry) {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  if (!existsSync(LOG_FILE)) {
    appendFileSync(LOG_FILE, 'date,session,symbol,tf,direction,score,entry,sl,tp,rr,result,pnl,notes\n');
  }
  const row = [
    new Date().toISOString(),
    entry.session, entry.symbol, entry.tf, entry.direction,
    entry.score, entry.entry, entry.sl, entry.tp, entry.rr,
    entry.result || '', entry.pnl || '', entry.notes || '',
  ].join(',');
  appendFileSync(LOG_FILE, row + '\n');
}

// Determine current session name
function currentSession() {
  const h = new Date().getUTCHours();
  if (h >= 13 && h < 17) return 'LONDON-NY-OVERLAP';
  if (h >= 8  && h < 13) return 'LONDON';
  if (h >= 13 && h < 22) return 'NY';
  if (h >= 0  && h < 7)  return 'ASIAN';
  return 'DEAD-ZONE';
}

// ─────────────────────────────────────────────────────────────────────────────
// POSITION SIZING — always produces a broker-tradeable lot size
//
// BlackBull Markets limits:
//   Min lot: 0.01  |  Step: 0.01  |  Max lot: 100 (varies by instrument)
//
// Lot values per pip / per point:
//   Forex majors (GBPUSD, EURUSD, AUDUSD, USDJPY…): $10/pip per std lot
//   XAUUSD (gold):   $1/point per std lot  (1 lot = 100 oz, 1pt = $0.01/oz × 100 = $1? no)
//                    Actually 1 lot XAUUSD = 100 troy oz; price in USD/oz
//                    PnL = lots × 100 × price_diff  → riskLots = riskAmt / (100 × slDist)
//   NAS100 / US30:   $1/point per 1 lot (contract size = 1)
//   BTCUSD:          $1/point per 1 lot (contract size = 1 BTC)
//   ETHUSD:          $1/point per 1 lot
//   GBPJPY / EURJPY: pip value in JPY, converted to USD at current rate ~0.0067
//
// Formula: lots = riskAmt / (pipValue × slPips)
//          where pipValue = contractSize × pipSize  (in account currency)
// ─────────────────────────────────────────────────────────────────────────────
function calcLots(symbol, riskPct, accountEquity, entryPrice, slPrice) {
  const MIN_LOT  = 0.01;
  const LOT_STEP = 0.01;
  const MAX_LOTS = 10;   // hard safety cap — never risk blowing account on one trade

  const riskAmt  = accountEquity * (riskPct / 100);
  const slDist   = Math.abs(entryPrice - slPrice);
  if (slDist === 0) return MIN_LOT;

  const sym = symbol.toUpperCase();

  // Contract size and pip value per 1.0 lot (in USD)
  let contractSize, pipSize;

  if (/XAU|GOLD/.test(sym)) {
    // XAUUSD: 1 lot = 100 oz; P&L per lot per $1 move = $100
    contractSize = 100;
    pipSize      = 1.0;  // $1 per oz move
  } else if (/NAS100|NAS|NDX|NQ/.test(sym)) {
    // NAS100: 1 lot = 1 index point; P&L per lot per 1pt move = $1
    contractSize = 1;
    pipSize      = 1.0;
  } else if (/US30|DOW|YM/.test(sym)) {
    contractSize = 1;
    pipSize      = 1.0;
  } else if (/BTC/.test(sym)) {
    contractSize = 1;
    pipSize      = 1.0;
  } else if (/ETH/.test(sym)) {
    contractSize = 1;
    pipSize      = 1.0;
  } else if (/JPY/.test(sym)) {
    // JPY pairs: pip = 0.01; pip value ≈ $0.07 per micro lot — use $6.50/pip per std lot estimate
    contractSize = 100000;
    pipSize      = 0.01;
    const pipValuePerLot = 6.50; // approx USD
    const slPips = slDist / pipSize;
    let lots = riskAmt / (pipValuePerLot * slPips);
    lots = Math.floor(lots / LOT_STEP) * LOT_STEP;
    return Math.min(Math.max(lots, MIN_LOT), MAX_LOTS);
  } else {
    // Standard forex (GBPUSD, EURUSD, AUDUSD, NZDUSD…)
    // 1 std lot = 100,000 units; pip = 0.0001; pip value ≈ $10/lot
    const pipValuePerLot = 10.0;
    const slPips = slDist / 0.0001;
    let lots = riskAmt / (pipValuePerLot * slPips);
    lots = Math.floor(lots / LOT_STEP) * LOT_STEP;
    return Math.min(Math.max(lots, MIN_LOT), MAX_LOTS);
  }

  // For non-forex instruments: lots = riskAmt / (contractSize × pipSize × slDist)
  let lots = riskAmt / (contractSize * pipSize * slDist);
  lots = Math.floor(lots / LOT_STEP) * LOT_STEP;
  return Math.min(Math.max(lots, MIN_LOT), MAX_LOTS);
}

// Legacy alias — kept so nothing else breaks
function calcUnits(symbol, riskPct, accountEquity, entryPrice, slPrice) {
  return calcLots(symbol, riskPct, accountEquity, entryPrice, slPrice);
}

async function main() {
  const session = currentSession();
  log(`=== SESSION START: ${session} ===`);

  // 0a. Friday cutoff — no new entries after 15:30 UTC on Fridays
  const now     = new Date();
  const isFri   = now.getUTCDay() === 5;
  const utcMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (isFri && utcMins >= 15 * 60 + 30) {
    log('Friday 15:30 UTC cutoff reached — no new trades today.');
    return;
  }

  // 0b. Session gate — day trading hours: 00:00–22:00 UTC (no dead zone 22:00-00:00)
  // Priority:  London-NY overlap (BEST) > London open > NY continuation > Asian
  const h         = now.getUTCHours();
  const isOverlap = utcMins >= 13 * 60 && utcMins < 17 * 60;  // 13:00–17:00 (BEST)
  const isAsian   = h < 7;                                      // 00:00–06:59
  const isLondon  = h >= 8  && h < 13;                          // 08:00–12:59 (score ≥ 12)
  const isNYCont  = h >= 17 && h < 22;                          // 17:00–21:59 (score ≥ 12, crypto/indices only)
  if (!isOverlap && !isAsian && !isLondon && !isNYCont) {
    log(`Session gate: ${session} — dead zone (UTC ${h}:xx). Skipping.`);
    return;
  }

  // 0c. Equity check — informational only (multi-instrument: positions are expected to be open)
  try {
    const { getEquity } = await import('./execute_trade.mjs');
    const eq = await getEquity();
    if (eq?.equity != null) log(`  Equity: £${eq.equity} | Balance: £${eq.balance} | Float P&L: £${eq.unrealisedPnl ?? 0}`);
  } catch(e) { log(`Equity check skipped: ${e.message}`); }

  // 1. Check news safety
  log('Fetching high-impact news...');
  const allNews = await fetchHighImpactNews();
  const safety  = isSafeToTrade(allNews);

  if (!safety.safe) {
    log(`⚠ NOT SAFE: ${safety.reason}`);
    log(`Resume at: ${safety.resumeAt?.toISOString()}`);
    log('Exiting — no trades this session window.');
    return;
  }
  log(`✓ News clear. Safe to trade.`);

  // 1b. Check performance — stop if 2+ consecutive losses
  if (existsSync(LOG_FILE)) {
    const trades = readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(1)
      .map(l => { const p = l.split(','); return { pnl: parseFloat(p[10] || 0) }; });
    const perf = analyzePerformance(trades.map((t,i) => ({ ...t, result: t.pnl > 0 ? 'W' : t.pnl < 0 ? 'L' : '' })));
    if (perf.currentConsecLoss >= 2) {
      log(`⚠ STOP RULE: ${perf.currentConsecLoss} consecutive losses. Skipping session.`);
      return;
    }
  }

  // 1c. Market sentiment check (F&G indices + Reddit)
  log('Checking market sentiment...');
  let twitterBias = {};
  try {
    const twitterSignals = await fetchTwitterSignals();
    twitterBias = aggregateSignals(twitterSignals);
    if (Object.keys(twitterBias).length) {
      log(`Sentiment bias: ${JSON.stringify(twitterBias)}`);
    }
  } catch(e) { log(`Sentiment check skipped: ${e.message}`); }

  // Log today's news for awareness
  const today = new Date().toDateString();
  const todayNews = allNews.filter(e => new Date(e.date).toDateString() === today);
  if (todayNews.length > 0) {
    log(`Today's high-impact events: ${todayNews.map(e => `${e.time} ${e.currency} ${e.title}`).join(' | ')}`);
  }

  // 2. Scan for setups
  log('Scanning instruments for setups...');
  let setups;
  try {
    setups = await scanForSetups();
  } catch(e) {
    log(`Scan error: ${e.message}`);
    return;
  }

  if (setups.length === 0) {
    log('No qualifying setups found (score < 11). Skipping session — no token waste.');
    logTrade({ session, symbol: 'NONE', tf: '-', direction: '-', score: 0, entry: 0, sl: 0, tp: 0, rr: 0, notes: 'no setup' });
    return;
  }

  log(`Found ${setups.length} qualifying setup(s).`);

  // 3. Session filter — quality gates per session
  const NY_CONT_SYMBOLS = ['BTCUSD','ETHUSD','NAS100','US30','SPX500','XAUUSD','SOLUSD','BNBUSD'];
  const sessionFiltered = setups.filter(s => {
    if (isOverlap) return true;                                                        // London-NY: all symbols
    if (isAsian   && /BTC/i.test(s.label) && s.score >= 13) return true;              // Asian: BTC only ≥13
    if (isLondon  && s.score >= 12) return true;                                       // London: all tier 1/2 ≥12
    if (isNYCont  && NY_CONT_SYMBOLS.includes(s.label) && s.score >= 12) return true; // NY cont: crypto/indices ≥12
    log(`  Skipping ${s.label}: session gate (${session}, score=${s.score})`);
    return false;
  });

  if (sessionFiltered.length === 0) {
    log('All setups filtered by session gate. Skipping.');
    return;
  }

  // 3b. Filter out any instrument with news <30 min
  const viableSetups = sessionFiltered.filter(s => {
    const sym = s.label;
    const symNews = filterForSymbol(allNews, sym);
    const symSafe = isSafeToTrade(symNews);
    if (!symSafe.safe) { log(`  Skipping ${sym}: ${symSafe.reason}`); return false; }
    return true;
  });

  if (viableSetups.length === 0) {
    log('All setups blocked by news. Skipping.');
    return;
  }

  // 4. Select trades — one per correlated group, up to MAX_CONCURRENT
  // Correlated groups: trading two instruments from the same group = same bet
  const CORRELATED_GROUPS = [
    ['NAS100', 'US30', 'SPX500'],                                      // US indices
    ['BTCUSD', 'ETHUSD', 'SOLUSD', 'ADAUSD', 'XRPUSD', 'BNBUSD', 'LTCUSD'], // Crypto
    ['XAUUSD', 'XAGUSD'],                                              // Metals
    ['EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDCHF'],    // USD forex
    ['USDJPY', 'EURJPY', 'GBPJPY', 'AUDJPY'],                         // JPY pairs
    ['WTI', 'USOIL'],                                                  // Oil
    ['GER40', 'UK100'],                                                // EU indices
  ];
  const MAX_CONCURRENT = 4; // max simultaneous instruments

  const selected = [];
  const usedGroups = new Set();
  for (const setup of viableSetups) {
    if (selected.length >= MAX_CONCURRENT) break;
    const groupIdx = CORRELATED_GROUPS.findIndex(g => g.includes(setup.label));
    if (groupIdx === -1 || !usedGroups.has(groupIdx)) {
      selected.push(setup);
      if (groupIdx !== -1) usedGroups.add(groupIdx);
    }
  }

  log(`\nSelected ${selected.length} trade(s) (max ${MAX_CONCURRENT}, one per correlated group):`);
  selected.forEach((s, i) => log(`  ${i+1}. [${s.score}/16] ${s.label} ${s.tf}M ${s.dir.toUpperCase()} | Entry:${s.entry} SL:${s.sl} | ${s.reasons.slice(0,2).join(', ')}`));

  // 5. Risk scaling — reduce per-trade risk as more instruments trade simultaneously
  // 1 trade=1.0% | 2 trades=0.75% each | 3+=0.5% each  (total exposure capped ~2%)
  const equityData = await getEquity().catch(() => ({}));
  const equity = equityData.equity || equityData.balance || 10000;
  log(`  Account equity: £${equity}`);

  const baseRisk = selected.length === 1 ? 1.0 : selected.length === 2 ? 0.75 : 0.5;
  const LOT_STEP = 0.01;

  // 6. Place 3 orders per selected instrument
  let totalPlaced = 0;
  for (const best of selected) {
    const riskPct   = best.score >= 14 ? baseRisk + 0.5 : best.score >= 12 ? baseRisk + 0.25 : baseRisk;
    const totalLots = calcLots(best.label, riskPct, equity, best.entry, best.sl);
    const thirdLots = Math.max(0.01, Math.floor((totalLots / 3) / LOT_STEP) * LOT_STEP);
    const sym       = best.sym.replace('BLACKBULL:', '');

    log(`\n── ${best.label} ${best.dir.toUpperCase()} | Risk:${riskPct}% | ${thirdLots}×3 lots ──`);
    log(`   TP1(0.5R):${best.tpQuick} | TP2(1.0R):${best.tp2} | TP3(2.0R):${best.tp1} | SL:${best.sl}`);

    let placed = 0;
    try {
      await placeOrder({ symbol: sym, direction: best.dir, units: thirdLots,
        tpPrice: best.tpQuick, slPrice: best.sl, screenshot: false });
      log(`  ✓ O1 (0.5R, SL=${best.sl})`); placed++;
    } catch(e) { log(`  ✗ O1 error: ${e.message}`); }

    try {
      await placeOrder({ symbol: sym, direction: best.dir, units: thirdLots,
        tpPrice: best.tp2, slPrice: best.entry, screenshot: false });
      log(`  ✓ O2 (1.0R, BE stop=${best.entry})`); placed++;
    } catch(e) { log(`  ✗ O2 error: ${e.message}`); }

    try {
      await placeOrder({ symbol: sym, direction: best.dir, units: thirdLots,
        tpPrice: best.tp1, slPrice: best.entry, screenshot: selected.indexOf(best) === selected.length - 1 });
      log(`  ✓ O3 (2.0R, BE stop=${best.entry})`); placed++;
    } catch(e) { log(`  ✗ O3 error: ${e.message}`); }

    if (placed > 0) {
      totalPlaced += placed;
      logTrade({
        session, symbol: best.label, tf: best.tf, direction: best.dir,
        score: best.score, entry: best.entry, sl: best.sl,
        tp: `${best.tpQuick}/${best.tp2}/${best.tp1}`, rr: best.rr,
        notes: best.reasons.join(';') + ` lots=${thirdLots}x3 placed=${placed}`,
      });

      // Launch a position monitor per instrument
      const monitorPath = join(__dirname, 'position_monitor.mjs');
      const monitorLog  = join(DATA_ROOT, `monitor_${best.label}.log`);
      const logFd = openSync(monitorLog, 'a');
      const monitor = spawn(process.execPath, [
        monitorPath,
        `--entry=${best.entry}`, `--tp1=${best.tpQuick}`, `--tp2=${best.tp2}`,
        `--symbol=${best.label}`, `--numOrders=${placed}`,
      ], { detached: true, stdio: ['ignore', logFd, logFd] });
      monitor.unref();
      log(`  Monitor launched (pid ${monitor.pid}) → ${monitorLog}`);
    }

    await new Promise(r => setTimeout(r, 1500)); // brief pause between instruments
  }

  log(`\n=== SESSION END — ${totalPlaced} orders placed across ${selected.length} instrument(s) ===\n`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
