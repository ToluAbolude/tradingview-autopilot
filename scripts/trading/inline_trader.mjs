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
  if (!existsSync(PARAMS_FILE)) return { scoreThreshold: 6, stopRuleLosses: 4, riskPct: [6.0, 4.2, 3.0], maxConcurrent: 4, blockedSessions: [], blockedSymbols: [] };
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

// ── Loss cooldown — 60 min per symbol+dir ─────────────────────────────────────
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
    const dir    = (cols[4] || '').trim();
    const result = (cols[10] || '').trim();
    if (!ts || !symbol || !dir || result !== 'L') continue;
    try { if (new Date(ts).getTime() >= cutoff) cooldowns.add(`${symbol}:${dir}`); } catch (_) {}
  }
  return cooldowns;
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
  } else if (/WTI|USOIL|CRUDE|OIL/.test(sym)) {
    const slPips = slDist / 0.01;
    let lots = riskAmt / (10.0 * slPips);
    return Math.min(Math.max(Math.floor(lots / LOT_STEP) * LOT_STEP, MIN_LOT), MAX_LOTS);
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

  // ── 3. Score gate ──────────────────────────────────────────────────────────
  const threshold = PARAMS.scoreThreshold || 6;
  if (setup.score < threshold) { log(`Score ${setup.score} < ${threshold}. Skip.`); return; }

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

  // ── 6. Loss cooldown ───────────────────────────────────────────────────────
  const cooldowns = getRecentLossCooldowns();
  if (cooldowns.has(`${setup.label}:${setup.dir}`)) {
    log(`60-min loss cooldown active for ${setup.label} ${setup.dir}. Skip.`); return;
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
  log(`✅ All guards passed. Placing trade (score=${setup.score} dir=${setup.dir.toUpperCase()})`);

  const equityData = await getEquity().catch(() => ({}));
  const equity     = equityData.equity || equityData.balance || 10000;

  const [r1, r2, r3] = PARAMS.riskPct || [6.0, 4.2, 3.0];
  // Risk scales with how many concurrent trades are already running this cycle
  const alreadyPlaced = _cyclePlacedCount;
  const baseRisk = alreadyPlaced === 0 ? r1 : alreadyPlaced === 1 ? r2 : r3;
  const riskPct  = setup.score >= 8 ? baseRisk + 0.5 : baseRisk;

  const LOT_STEP  = 0.01;
  const totalLots = calcLots(setup.label, riskPct, equity, setup.entry, setup.sl);
  const halfLots  = Math.max(0.01, Math.floor((totalLots / 2) / LOT_STEP) * LOT_STEP);

  log(`Risk:${riskPct}% | Equity:${equity} | ${halfLots}×2 lots | O1:${setup.tp2} O2:${setup.tp3} SL:${setup.sl}`);

  let placed = 0;
  try {
    await placeOrder({ symbol: setup.label, direction: setup.dir, units: halfLots,
      tpPrice: setup.tp2, slPrice: setup.sl, screenshot: false });
    log(`✓ O1 placed (TP=${setup.tp2} SL=${setup.sl})`);
    placed++;
  } catch(e) { log(`✗ O1 error: ${e.message}`); }

  try {
    await placeOrder({ symbol: setup.label, direction: setup.dir, units: halfLots,
      tpPrice: setup.tp3, slPrice: setup.sl, screenshot: true });
    log(`✓ O2 placed (TP=${setup.tp3} SL=${setup.sl})`);
    placed++;
  } catch(e) { log(`✗ O2 error: ${e.message}`); }

  if (placed > 0) {
    _cyclePlacedCount++;
    if (groupIdx !== -1) _cycleUsedGroups.add(groupIdx);

    const tradeTime = logTrade({
      session,
      symbol: setup.label,
      tf: setup.tf,
      direction: setup.dir,
      score: setup.score,
      entry: setup.entry,
      sl: setup.sl,
      tp: `${setup.tp2}/${setup.tp3}`,
      rr: setup.rr,
      notes: (setup.reasons || []).join(';') + ` lots=${halfLots}x2 placed=${placed} inline`,
    });

    // Launch position monitor (detached — runs independently until position closes)
    const monitorPath = join(__dirname, 'position_monitor.mjs');
    const monitorLog  = join(DATA_ROOT, `monitor_${setup.label}.log`);
    const logFd = openSync(monitorLog, 'a');
    const monitor = spawn(process.execPath, [
      monitorPath,
      `--entry=${setup.entry}`,
      `--tp1=${setup.tp2}`,
      `--tp2=${setup.tp3}`,
      `--tp3=${setup.tp3}`,
      `--symbol=${setup.label}`,
      `--numOrders=${placed}`,
      `--tradeTime=${tradeTime}`,
    ], { detached: true, stdio: ['ignore', logFd, logFd] });
    monitor.unref();
    log(`Monitor launched (pid ${monitor.pid})`);
  }

  // Brief pause so the broker panel settles before the next instrument is scanned
  await new Promise(r => setTimeout(r, 1500));
}
