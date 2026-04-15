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
import { placeOrder } from './execute_trade.mjs';
import { fetchTwitterSignals, aggregateSignals } from './twitter_feed.mjs';
import { analyzePerformance } from './performance_tracker.mjs';
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LOG_DIR  = 'C:/Users/Tda-d/tradingview-autopilot/data/trade_log';
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

// Position size: units based on % risk
function calcUnits(symbol, riskPct, accountEquity, entryPrice, slPrice) {
  const riskAmount = accountEquity * (riskPct / 100);
  const priceDiff  = Math.abs(entryPrice - slPrice);
  if (priceDiff === 0) return 1;

  // Units: riskAmount / priceDiff (for most instruments)
  // For crypto/gold, price is in USD so 1 unit = $1 at that price
  let units = Math.floor(riskAmount / priceDiff);
  return Math.max(1, Math.min(units, 100)); // cap at 100 units
}

async function main() {
  const session = currentSession();
  log(`=== SESSION START: ${session} ===`);

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
  const LOG_FILE = 'C:/Users/Tda-d/tradingview-autopilot/data/trade_log/trades.csv';
  if (existsSync(LOG_FILE)) {
    const trades = readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(1)
      .map(l => { const p = l.split(','); return { pnl: parseFloat(p[10] || 0) }; });
    const perf = analyzePerformance(trades.map((t,i) => ({ ...t, result: t.pnl > 0 ? 'W' : t.pnl < 0 ? 'L' : '' })));
    if (perf.currentConsecLoss >= 2) {
      log(`⚠ STOP RULE: ${perf.currentConsecLoss} consecutive losses. Skipping session.`);
      return;
    }
  }

  // 1c. Twitter sentiment check
  log('Checking X/Twitter signals...');
  let twitterBias = {};
  try {
    const twitterSignals = await fetchTwitterSignals();
    twitterBias = aggregateSignals(twitterSignals);
    if (Object.keys(twitterBias).length) {
      log(`Twitter bias: ${JSON.stringify(twitterBias)}`);
    }
  } catch(e) { log(`Twitter check skipped: ${e.message}`); }

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
    log('No qualifying setups found (score < 4/9). Skipping session — no token waste.');
    logTrade({ session, symbol: 'NONE', tf: '-', direction: '-', score: 0, entry: 0, sl: 0, tp: 0, rr: 0, notes: 'no setup' });
    return;
  }

  log(`Found ${setups.length} qualifying setup(s).`);

  // 3. Filter out any instrument with news <30 min
  const viableSetups = setups.filter(s => {
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

  // 4. Pick best setup (highest score, then best R:R)
  const best = viableSetups[0];
  log(`\nBest setup: [${best.score}/16] ${best.label} ${best.tf}M ${best.dir.toUpperCase()}`);
  log(`  Entry: ${best.entry} | SL: ${best.sl} | TP: ${best.tp1} | R:R: ${best.rr}`);
  log(`  Reasons: ${best.reasons.join(', ')}`);

  // 5. Calculate position size
  // Risk scales with score: 1% base, +0.5% per tier above threshold (max 2%)
  const riskPct = best.score >= 12 ? 2.0 : best.score >= 9 ? 1.5 : 1.0;
  const equity  = 10000; // demo account £10,000
  const units   = calcUnits(best.label, riskPct, equity, best.entry, best.sl);
  log(`  Risk: ${riskPct}% | Units: ${units}`);

  // 6. Place trade
  try {
    const result = await placeOrder({
      symbol:    best.sym.replace('BLACKBULL:', ''),
      direction: best.dir,
      units,
      tpPrice:   best.tp1,   // always required — 2R target
      slPrice:   best.sl,    // always required — ATR-based stop
      screenshot: true,
    });

    log(`✓ Trade placed: ${JSON.stringify(result)}`);
    logTrade({
      session, symbol: best.label, tf: best.tf, direction: best.dir,
      score: best.score, entry: best.entry, sl: best.sl, tp: best.tp1, rr: best.rr,
      notes: best.reasons.join(';'),
    });

    // Launch position monitor in background to capture result when trade closes
    const monitorPath = join(__dirname, 'position_monitor.mjs');
    const monitor = spawn(process.execPath, [monitorPath], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    monitor.unref();
    log(`Position monitor launched (pid ${monitor.pid}) — will update CSV on close.`);

  } catch(e) {
    log(`✗ Trade error: ${e.message}`);
  }

  log('=== SESSION END ===\n');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
