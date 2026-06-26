/**
 * confirm_eod_close.mjs — cTrader-only weekend/EOD flatten for the confirm daemon.
 *
 * Closes ALL open positions to avoid weekend gap risk on the demo account:
 *   - Any time on Sat/Sun.
 *   - Friday at/after CONFIRM_FRIDAY_CLOSE_UTC (default 20:00 UTC).
 *   - Optionally daily at/after CONFIRM_DAILY_EOD_UTC (unset = disabled; the 2R
 *     brackets otherwise run until TP/SL across days).
 * Pure cTrader Open API — NO Chrome/CDP. Demo-only by env. Safe to run often
 * (it no-ops outside the close windows).
 *
 * Cron: every ~30 min on Fri/Sat/Sun (the script decides whether to act).
 */
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import os from 'os';

const DATA_ROOT = os.platform() === 'linux'
  ? '/home/ubuntu/trading-data'
  : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const LOG = join(DATA_ROOT, 'confirm_eod_close.jsonl');

const FRIDAY_CLOSE_UTC = Number(process.env.CONFIRM_FRIDAY_CLOSE_UTC ?? 20);
const DAILY_EOD_UTC    = process.env.CONFIRM_DAILY_EOD_UTC != null
  ? Number(process.env.CONFIRM_DAILY_EOD_UTC) : null;

function log(obj) {
  const line = `[${new Date().toISOString()}] ${typeof obj === 'string' ? obj : JSON.stringify(obj)}`;
  process.stdout.write(line + '\n');
  if (!existsSync(DATA_ROOT)) mkdirSync(DATA_ROOT, { recursive: true });
  appendFileSync(LOG, line + '\n');
}

function shouldClose(now) {
  const dow = now.getUTCDay();          // 0=Sun .. 6=Sat
  const hr  = now.getUTCHours();
  if (dow === 0 || dow === 6) return 'weekend';
  if (dow === 5 && hr >= FRIDAY_CLOSE_UTC) return 'friday-cutoff';
  if (DAILY_EOD_UTC != null && hr >= DAILY_EOD_UTC) return 'daily-eod';
  return null;
}

async function main() {
  const env = (process.env.CTRADER_ENV || 'demo').toLowerCase();
  if (env !== 'demo') { log(`refusing: CTRADER_ENV=${env} (demo-only)`); process.exit(0); }

  const reason = shouldClose(new Date());
  if (!reason) { process.exit(0); }     // outside close window — silent no-op

  const b = await import('./broker_ctrader.mjs');
  await b.connect();
  const open = await b.getPositions();
  if (!open.length) { log(`${reason}: no open positions`); process.exit(0); }

  log(`${reason}: flattening ${open.length} open position(s)`);
  const res = await b.closeAllPositions();
  log(`closed ${res.closed}, remaining ${res.remaining}`);
  process.exit(0);
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
