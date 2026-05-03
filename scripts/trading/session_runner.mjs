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
import { placeOrder, getEquity, closeAllPositions } from './execute_trade.mjs';
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

// Load tunable parameters from config file (falls back to safe defaults if missing)
const PARAMS_FILE = join(DATA_ROOT, 'trading_params.json');
const PARAMS = existsSync(PARAMS_FILE)
  ? JSON.parse(readFileSync(PARAMS_FILE, 'utf8'))
  : { scoreThreshold: 8, stopRuleLosses: 2, riskPct: [3.5, 2.5, 1.75], slAtrMult: 1.5, maxConcurrent: 4, blockedSessions: [], blockedSymbols: [], blockedSymbolExpiry: {} };

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function logTrade(entry) {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  if (!existsSync(LOG_FILE)) {
    appendFileSync(LOG_FILE, 'date,session,symbol,tf,direction,score,entry,sl,tp,rr,result,pnl,notes\n');
  }
  const ts = new Date().toISOString();
  const row = [
    ts,
    entry.session, entry.symbol, entry.tf, entry.direction,
    entry.score, entry.entry, entry.sl, entry.tp, entry.rr,
    entry.result || '', entry.pnl || '', entry.notes || '',
  ].join(',');
  appendFileSync(LOG_FILE, row + '\n');
  return ts;
}

// Determine current session name
function currentSession() {
  const now = new Date();
  const h   = now.getUTCHours();
  const day = now.getUTCDay();
  if (day === 0 && h >= 22) return 'ASIAN'; // Sunday night market open
  if (h >= 13 && h < 17) return 'LONDON-NY-OVERLAP';
  if (h >= 8  && h < 13) return 'LONDON';
  if (h >= 17 && h < 20) return 'NY';
  if (h >= 0  && h < 8)  return 'ASIAN';
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
  } else if (/BTC|ETH|SOL|ADA|XRP|BNB|LTC/.test(sym)) {
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

  // Per-instrument risk caps — volatile assets get a lower effective risk ceiling
  // regardless of the session-level riskPct setting, to prevent outsized dollar losses
  const INSTRUMENT_RISK_CAP_PCT = { BTC: 1.0, ETH: 1.0, SOL: 1.0, ADA: 1.0, XRP: 1.0 };
  const capKey = Object.keys(INSTRUMENT_RISK_CAP_PCT).find(k => sym.includes(k));
  if (capKey) {
    const maxRiskAmt = accountEquity * (INSTRUMENT_RISK_CAP_PCT[capKey] / 100);
    const maxLots = Math.floor((maxRiskAmt / (contractSize * pipSize * slDist)) / LOT_STEP) * LOT_STEP;
    if (lots > maxLots) {
      log(`  [risk cap] ${sym}: ${lots} → ${maxLots} lots (capped at ${INSTRUMENT_RISK_CAP_PCT[capKey]}%)`);
      lots = maxLots;
    }
  }

  return Math.min(Math.max(lots, MIN_LOT), MAX_LOTS);
}

// Legacy alias — kept so nothing else breaks
function calcUnits(symbol, riskPct, accountEquity, entryPrice, slPrice) {
  return calcLots(symbol, riskPct, accountEquity, entryPrice, slPrice);
}

// Returns symbols that have an unresolved (no result recorded) trade in the CSV
function getOpenSymbols() {
  if (!existsSync(LOG_FILE)) return new Set();
  const lines = readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(1);
  const open = new Set();
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split(',');
    const symbol = (cols[2] || '').trim();
    const result = (cols[10] || '').trim();
    if (symbol && symbol !== 'NONE' && !result) open.add(symbol);
  }
  return open;
}

async function main() {
  const session = currentSession();
  log(`=== SESSION START: ${session} ===`);

  const now     = new Date();
  const isSun   = now.getUTCDay() === 0;
  const isFri   = now.getUTCDay() === 5;
  const utcMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const h       = now.getUTCHours();

  // 0a. Sunday gate — Forex opens ~22:00 UTC Sunday; skip everything before that
  if (isSun && h < 22) {
    log('Sunday market not yet open (opens ~22:00 UTC). Skipping.');
    return;
  }

  // 0b. EOD close — 20:00 UTC Mon-Fri: close any open positions and stop for the day
  // Exempt on Sunday — market just opened at 22:00, there are no positions to close.
  if (h >= 20 && !isSun) {
    log('20:00 UTC EOD close — closing any open positions.');
    try { await closeAllPositions(); log('  All positions closed.'); }
    catch(e) { log(`  closeAllPositions: ${e.message}`); }
    return;
  }

  // 0c. Last-entry cutoff — stop opening new trades 30 min before EOD force-close
  // Not applicable Sunday (market just opened; no same-day close at 20:00).
  if (!isSun && h === 19 && now.getUTCMinutes() >= 30) {
    log('19:30 UTC last-entry cutoff — no new trades before EOD close at 20:00.');
    return;
  }

  // 0d. Friday cutoff — markets close ~22:00 UTC Friday; no new entries after 21:00
  if (isFri && utcMins >= 21 * 60) {
    log('Friday 21:00 UTC cutoff reached — markets closing, no new trades.');
    return;
  }

  // 0e. Session block — skip if current session is blocked by performance review
  if (PARAMS.blockedSessions?.includes(session)) {
    log(`⚠ Session '${session}' is blocked by performance review. Run apply_params.mjs to unblock.`);
    return;
  }

  // 0f. Equity check — informational only (multi-instrument: positions are expected to be open)
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

  // 1b. Check performance — stop if 2+ consecutive losses TODAY only (resets each new trading day)
  // CSV cols: date(0),session(1),symbol(2),tf(3),direction(4),score(5),entry(6),sl(7),tp(8),rr(9),result(10),pnl(11),notes(12)
  if (existsSync(LOG_FILE)) {
    const todayStr = new Date().toISOString().slice(0, 10);
    const trades = readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(1)
      .filter(l => l.startsWith(todayStr))
      .map(l => { const p = l.split(','); return { result: (p[10]||'').trim(), pnl: parseFloat(p[11]||0)||0, score: p[5], session: p[1], symbol: p[2] }; });
    const perf = analyzePerformance(trades);
    if (perf.currentConsecLoss >= PARAMS.stopRuleLosses) {
      log(`⚠ STOP RULE: ${perf.currentConsecLoss} consecutive losses today (limit: ${PARAMS.stopRuleLosses}). Skipping session.`);
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
    setups = await scanForSetups(PARAMS.scoreThreshold || 8, PARAMS.slAtrMult || 1.5);
  } catch(e) {
    log(`Scan error: ${e.message}`);
    return;
  }

  if (setups.length === 0) {
    log('No qualifying setups found (score < 9 or T+U gate not met). Skipping.');
    logTrade({ session, symbol: 'NONE', tf: '-', direction: '-', score: 0, entry: 0, sl: 0, tp: 0, rr: 0, notes: 'no setup' });
    return;
  }

  log(`Found ${setups.length} qualifying setup(s).`);

  // 3. Session filter — London and London-NY overlap both accepted (already gated above)
  const sessionFiltered = setups;

  if (sessionFiltered.length === 0) {
    log('All setups filtered by session gate. Skipping.');
    return;
  }

  // 3b. Filter: blocked symbols + news <30 min + session-specific score gates
  const CRYPTO_SYMBOLS = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'ADAUSD', 'XRPUSD', 'BNBUSD', 'LTCUSD'];
  const CRYPTO_ASIAN_MIN_SCORE = 10; // Asian session is thin/noisy — require higher conviction for crypto

  const viableSetups = sessionFiltered.filter(s => {
    if (PARAMS.blockedSymbols?.includes(s.label)) {
      log(`  Skipping ${s.label}: temporarily blocked by performance review`);
      return false;
    }
    if (session === 'ASIAN' && CRYPTO_SYMBOLS.includes(s.label) && s.score < CRYPTO_ASIAN_MIN_SCORE) {
      log(`  Skipping ${s.label}: score ${s.score} < ${CRYPTO_ASIAN_MIN_SCORE} required for crypto in Asian session`);
      return false;
    }
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
  const MAX_CONCURRENT = PARAMS.maxConcurrent || 4;

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

  // 5. Deduplication — skip if same symbol OR a correlated-group member is already open
  const openSymbols = getOpenSymbols();
  if (openSymbols.size > 0) log(`  Already open: ${[...openSymbols].join(', ')}`);
  const dedupedSelected = selected.filter(s => {
    if (openSymbols.has(s.label)) {
      log(`  ⏭ ${s.label} — position already open, skipping`);
      return false;
    }
    const groupIdx = CORRELATED_GROUPS.findIndex(g => g.includes(s.label));
    if (groupIdx !== -1) {
      const correlatedOpen = [...openSymbols].find(sym => CORRELATED_GROUPS[groupIdx].includes(sym));
      if (correlatedOpen) {
        log(`  ⏭ ${s.label} — correlated position already open (${correlatedOpen}), skipping`);
        return false;
      }
    }
    return true;
  });

  if (dedupedSelected.length === 0) {
    log('All selected setups already have open positions. Nothing to place.');
    return;
  }

  // 6. Risk scaling — reduce per-trade risk as more instruments trade simultaneously
  // 1 trade=3.5% | 2 trades=2.5% each | 3+=1.75% each
  const equityData = await getEquity().catch(() => ({}));
  const equity = equityData.equity || equityData.balance || 10000;
  log(`  Account equity: £${equity}`);

  const [r1, r2, r3] = PARAMS.riskPct || [3.5, 2.5, 1.75];
  const baseRisk = dedupedSelected.length === 1 ? r1 : dedupedSelected.length === 2 ? r2 : r3;
  const LOT_STEP = 0.01;

  // 6. Place 2 orders per selected instrument (day-trade — EOD close at 20:00 UTC is the backstop)
  //    O1: 1/2 risk at 1.0R main target
  //    O2: 1/2 risk at 2.0R runner (closed at EOD if not hit — never overnight)
  let totalPlaced = 0;
  for (const best of dedupedSelected) {
    const riskPct  = best.score >= 12 ? baseRisk + 0.5 : baseRisk;
    const totalLots = calcLots(best.label, riskPct, equity, best.entry, best.sl);
    const halfLots  = Math.max(0.01, Math.floor((totalLots / 2) / LOT_STEP) * LOT_STEP);
    const sym       = best.sym.replace('BLACKBULL:', '');

    log(`\n── ${best.label} ${best.dir.toUpperCase()} | Risk:${riskPct}% | ${halfLots}×2 lots ──`);
    log(`   O1(1.0R):${best.tp2} | O2(2.0R):${best.tp3} | SL:${best.sl}`);

    let placed = 0;
    try {
      await placeOrder({ symbol: sym, direction: best.dir, units: halfLots,
        tpPrice: best.tp2, slPrice: best.sl, screenshot: false });
      log(`  ✓ O1 (1.0R main target, SL=${best.sl})`); placed++;
    } catch(e) { log(`  ✗ O1 error: ${e.message}`); }

    try {
      await placeOrder({ symbol: sym, direction: best.dir, units: halfLots,
        tpPrice: best.tp3, slPrice: best.sl,
        screenshot: dedupedSelected.indexOf(best) === dedupedSelected.length - 1 });
      log(`  ✓ O2 (2.0R runner, EOD close backstop, SL=${best.sl})`); placed++;
    } catch(e) { log(`  ✗ O2 error: ${e.message}`); }

    if (placed > 0) {
      totalPlaced += placed;
      const tradeTime = logTrade({
        session, symbol: best.label, tf: best.tf, direction: best.dir,
        score: best.score, entry: best.entry, sl: best.sl,
        tp: `${best.tp2}/${best.tp3}`, rr: best.rr,
        notes: best.reasons.join(';') + ` lots=${halfLots}x2 placed=${placed}`,
      });

      // Launch position monitor per instrument
      const monitorPath = join(__dirname, 'position_monitor.mjs');
      const monitorLog  = join(DATA_ROOT, `monitor_${best.label}.log`);
      const logFd = openSync(monitorLog, 'a');
      const monitor = spawn(process.execPath, [
        monitorPath,
        `--entry=${best.entry}`, `--tp1=${best.tp2}`, `--tp2=${best.tp3}`, `--tp3=${best.tp3}`,
        `--symbol=${best.label}`, `--numOrders=${placed}`,
        `--tradeTime=${tradeTime}`,
      ], { detached: true, stdio: ['ignore', logFd, logFd] });
      monitor.unref();
      log(`  Monitor launched (pid ${monitor.pid}) → ${monitorLog}`);
    }

    await new Promise(r => setTimeout(r, 1500));
  }

  log(`\n=== SESSION END — ${totalPlaced} orders placed across ${dedupedSelected.length} instrument(s) ===\n`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
