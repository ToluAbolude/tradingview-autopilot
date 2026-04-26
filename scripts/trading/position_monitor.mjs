/**
 * position_monitor.mjs
 * Polls open positions every 60s. When a position closes (TP or SL hit),
 * updates trades.csv with result (W/L) and pnl.
 *
 * Spawned by session_runner.mjs after a trade is placed (detached, logs to file).
 * Can also be run manually: node scripts/trading/position_monitor.mjs
 */
import { evaluate } from '../../src/connection.js';
import { closeAllPositions } from './execute_trade.mjs';
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Cross-platform path resolution
const IS_LINUX  = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX
  ? '/home/ubuntu/trading-data'
  : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const TRADES_CSV    = join(DATA_ROOT, 'trade_log', 'trades.csv');
const MONITOR_LOG   = join(DATA_ROOT, 'position_monitor.log');

const POLL_MS        = 60_000;
const MAX_HOURS      = 12;
const MAX_TICKS      = (MAX_HOURS * 60 * 60 * 1000) / POLL_MS;
const FIRST_DELAY_MS = 30_000;
const EOD_CLOSE_HOUR = 22;  // UTC — force-close any open position at 22:00 (day trading rule)

// Args: --entry=PRICE --numOrders=N (passed by session_runner for multi-TP BE detection)
const args       = Object.fromEntries(process.argv.slice(2).map(a => a.replace('--','').split('=')));
const ENTRY_PRICE = parseFloat(args.entry) || null;
const NUM_ORDERS  = parseInt(args.numOrders) || 1;

// Ensure log dir exists
try { mkdirSync(join(DATA_ROOT, 'trade_log'), { recursive: true }); } catch(_) {}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { appendFileSync(MONITOR_LOG, line); } catch(_) {}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Reliable position detection via body text (works with hashed CSS class names) ──
// Two-step: click tab first, sleep, then read — avoids capturing stale pre-click text
async function getPositionState() {
  // Step 1: click Positions tab
  await evaluate(`(function() {
    try {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        if ((btns[i].textContent || '').trim() === 'Positions') { btns[i].click(); break; }
      }
    } catch(e) {}
  })()`);
  await sleep(800);

  // Step 2: read values from DIV[class*="value-"] siblings of title elements
  return evaluate(`(function() {
    var balance = null, equity = null;

    // Primary: title-* elements have value-* siblings in the same parent
    var titles = document.querySelectorAll('[class*="title-"]');
    for (var i = 0; i < titles.length; i++) {
      var label = (titles[i].textContent || '').trim();
      var row   = titles[i].parentElement;
      if (!row) continue;
      var valEl = row.querySelector('[class*="value-"]');
      if (!valEl) continue;
      var v = parseFloat((valEl.textContent || '').replace(/,/g, ''));
      if (isNaN(v)) continue;
      if (label === 'Account Balance') balance = v;
      else if (label === 'Equity')     equity  = v;
    }

    // Fallback: value-* elements whose parent text starts with known labels
    if (balance === null || equity === null) {
      var valEls = document.querySelectorAll('[class*="value-"]');
      for (var i = 0; i < valEls.length; i++) {
        var p = valEls[i].parentElement;
        if (!p) continue;
        var pt = (p.textContent || '').trim();
        var v  = parseFloat((valEls[i].textContent || '').replace(/,/g, ''));
        if (isNaN(v)) continue;
        if (balance === null && /^Account Balance/.test(pt)) balance = v;
        if (equity  === null && /^Equity/.test(pt))          equity  = v;
      }
    }

    // Open position: equity differs from balance by >£1
    var hasOpenPosition = equity !== null && balance !== null && Math.abs(equity - balance) > 1;
    var openPnl         = (equity !== null && balance !== null)
                          ? Math.round((equity - balance) * 100) / 100
                          : null;

    // Secondary: explicit "no positions" text overrides
    var text        = document.body.innerText || '';
    var noPositions = /there are no open po/i.test(text) || /no open position/i.test(text);
    if (noPositions) hasOpenPosition = false;

    return { hasOpenPosition, openPnl, balance, equity, noPositionsText: noPositions };
  })()`);
}

// ── Update the last unresolved trade in CSV ──
function updateLastTrade(result, pnl, note) {
  if (!existsSync(TRADES_CSV)) { log(`CSV not found: ${TRADES_CSV}`); return false; }
  const lines = readFileSync(TRADES_CSV, 'utf8').split('\n');

  for (let i = lines.length - 1; i >= 1; i--) {
    const cols = lines[i].split(',');
    if (cols.length < 10 || !cols[0].trim()) continue;
    if (cols[10] && cols[10].trim() !== '') continue; // already recorded

    cols[10] = result;
    cols[11] = pnl != null ? String(pnl) : '';
    cols[12] = (cols[12] || '').trim() + `;monitor_${note}_${new Date().toISOString()}`;
    lines[i] = cols.join(',');
    writeFileSync(TRADES_CSV, lines.join('\n'), 'utf8');
    log(`✓ CSV row ${i} updated → result=${result} pnl=${pnl}`);
    return true;
  }
  log('No unresolved trade row found to update.');
  return false;
}

// ── Main ──
async function main() {
  log('=== POSITION MONITOR START ===');
  log(`CSV: ${TRADES_CSV}`);
  log(`Log: ${MONITOR_LOG}`);
  log(`Polling every ${POLL_MS / 1000}s, max ${MAX_HOURS}h, first check in ${FIRST_DELAY_MS / 1000}s`)
  log(`Multi-TP mode: ${NUM_ORDERS >= 2 ? 'ON' : 'OFF'} | BE price: ${ENTRY_PRICE ?? 'N/A'}`);

  log(`Entry: ${ENTRY_PRICE ?? 'unknown'} | Orders: ${NUM_ORDERS}`);

  let prevHasPosition = null;
  let prevPnl         = null;
  let prevBalance     = null;
  let ticks           = 0;
  let tp1Triggered    = false;  // tracks whether we've already logged BE trigger

  while (ticks < MAX_TICKS) {
    ticks++;
    await sleep(ticks === 1 ? FIRST_DELAY_MS : POLL_MS);

    let state;
    try {
      state = await getPositionState();
    } catch(e) {
      log(`Poll error: ${e.message}`);
      continue;
    }

    log(`tick=${ticks} hasPos=${state.hasOpenPosition} noText=${state.noPositionsText} pnl=${state.openPnl} bal=${state.balance} eq=${state.equity}`);

    // EOD hard close — day trading rule: all trades must close by 22:00 UTC
    if (state.hasOpenPosition && new Date().getUTCHours() >= EOD_CLOSE_HOUR) {
      log(`⏰ EOD CLOSE triggered (UTC ${new Date().getUTCHours()}:${String(new Date().getUTCMinutes()).padStart(2,'0')} ≥ ${EOD_CLOSE_HOUR}:00) — closing position`);
      try {
        const closeResult = await closeAllPositions();
        log(`EOD close result: ${closeResult}`);
      } catch(e) { log(`EOD close error: ${e.message}`); }
      await sleep(3000);
      const finalState = await getPositionState().catch(() => state);
      const delta  = finalState.balance != null && prevBalance != null
        ? Math.round((finalState.balance - prevBalance) * 100) / 100
        : (state.openPnl ?? null);
      const result = delta != null ? (delta >= 0 ? 'W' : 'L') : '?';
      updateLastTrade(result, delta, 'eod_close');
      log('EOD close complete. Exiting.');
      return;
    }

    // First tick — establish baseline
    if (prevHasPosition === null) {
      prevHasPosition = state.hasOpenPosition;
      prevBalance     = state.balance;
      if (!state.hasOpenPosition) {
        log('No open positions detected at start. Waiting 2 more ticks before giving up...');
        // Give it 2 more ticks in case broker panel hasn't updated yet
        if (ticks >= 3) {
          log('Still no positions after 3 ticks. Exiting.');
          return;
        }
        continue;
      }
      log(`Position confirmed open. Monitoring...`);
    }

    // Partial close detection — when balance increases mid-session = TP1 hit
    if (NUM_ORDERS >= 2 && !tp1Triggered && prevBalance !== null
        && state.balance !== null && state.hasOpenPosition
        && state.balance > prevBalance + 1) {
      tp1Triggered = true;
      const gain = Math.round((state.balance - prevBalance) * 100) / 100;
      log(`⚡ TP1 HIT (partial close detected, balance +${gain})`);
      if (ENTRY_PRICE !== null) {
        log(`⚡ BE TRIGGER — manually move SL to entry (${ENTRY_PRICE}) on remaining order`);
      }
    }

    // Position just closed
    if (prevHasPosition && !state.hasOpenPosition) {
      // Determine W/L from P&L or balance delta
      let pnl    = prevPnl;
      let result = '?';

      if (pnl != null) {
        result = pnl >= 0 ? 'W' : 'L';
      } else if (prevBalance != null && state.balance != null) {
        const delta = state.balance - prevBalance;
        pnl    = Math.round(delta * 100) / 100;
        result = delta >= 0 ? 'W' : 'L';
      }

      log(`POSITION CLOSED → result=${result} pnl=${pnl}`);
      updateLastTrade(result, pnl, 'closed');
      log('Done. Exiting.');
      return;
    }

    prevHasPosition = state.hasOpenPosition;
    prevPnl         = state.openPnl;
    if (state.balance != null) prevBalance = state.balance;
  }

  log(`Max time (${MAX_HOURS}h) reached. Recording result=? for safety.`);
  updateLastTrade('?', null, 'timeout');
}

main().catch(e => {
  log(`Fatal: ${e.message}`);
  process.exit(1);
});
