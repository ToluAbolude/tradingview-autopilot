/**
 * eod_close.mjs — End-of-day position closer
 *
 * Runs at 21:45 UTC Mon-Fri via cron.
 * Closes any remaining open positions to enforce the day-trade rule:
 *   "No carryover positions with real risk — only break-even runners stay."
 *
 * Since Order 2 already has SL=entry (break-even), the main purpose here
 * is to collect any remaining P&L and start the next day clean.
 */
import { closeAllPositions, getEquity } from './execute_trade.mjs';
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import os from 'os';

const DATA_ROOT = os.platform() === 'linux'
  ? '/home/ubuntu/trading-data'
  : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const LOG_DIR  = join(DATA_ROOT, 'trade_log');
const EOD_LOG  = join(LOG_DIR, 'eod_closes.csv');

const now = new Date();
const log = msg => console.log(`[${now.toISOString()}] ${msg}`);

log('═══ EOD CLOSE — 21:45 UTC day-trade enforcer ═══');

// Only run on weekdays
const dayOfWeek = now.getUTCDay(); // 0=Sun, 6=Sat
if (dayOfWeek === 0 || dayOfWeek === 6) {
  log('Weekend — skipping');
  process.exit(0);
}

const eqBefore = await getEquity().catch(() => ({}));
log(`Equity before: £${eqBefore.equity} | Balance: £${eqBefore.balance} | Float P&L: £${eqBefore.unrealisedPnl}`);

if (eqBefore.unrealisedPnl === 0 || eqBefore.equity === eqBefore.balance) {
  log('No open positions — nothing to close');
} else {
  const result = await closeAllPositions();
  log(`Close result: ${result}`);

  await new Promise(r => setTimeout(r, 3000));

  const eqAfter = await getEquity().catch(() => ({}));
  const realised = eqBefore.unrealisedPnl != null
    ? Math.round(eqBefore.unrealisedPnl * 100) / 100
    : 'unknown';
  log(`Equity after: £${eqAfter.equity} | Realised P&L: £${realised}`);

  // Append to EOD log
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    if (!existsSync(EOD_LOG)) appendFileSync(EOD_LOG, 'date,equity_before,balance_before,float_pnl,equity_after,result\n');
    appendFileSync(EOD_LOG, [
      now.toISOString(),
      eqBefore.equity, eqBefore.balance, eqBefore.unrealisedPnl,
      eqAfter.equity, result,
    ].join(',') + '\n');
  } catch (_) {}
}

log('═══ EOD CLOSE done ═══');
