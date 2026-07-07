/**
 * confirm_eod_close.mjs — cTrader-only weekend/EOD flatten for the confirm daemon.
 *
 * Closes open positions to avoid weekend gap risk on the demo account:
 *   - Any time on Sat/Sun.
 *   - Friday at/after CONFIRM_FRIDAY_CLOSE_UTC (default 20:00 UTC).
 *   - Optionally daily at/after CONFIRM_DAILY_EOD_UTC (unset = disabled; the 2R
 *     brackets otherwise run until TP/SL across days). Since 2026-07-07 the
 *     daily close spares WINNERS: a position in unrealized profit with a full
 *     SL+TP bracket carries overnight to its natural end (H1-scale geometry
 *     needs more than a day). Losers, naked, and unpriceable positions still
 *     close. Kill switch: EOD_CARRY_WINNERS=off restores the full flatten.
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

  // Weekend crypto carry: crypto trades 24/7, so there is no weekend gap to
  // flatten against. Keep CRYPTO open through the weekend and the Friday cutoff
  // (it rides its own SL/TP bracket); still flatten crypto on a weekday daily-eod.
  // Kill switch: WEEKEND_CRYPTO=off restores the full flatten.
  const WEEKEND_CRYPTO = (process.env.WEEKEND_CRYPTO ?? 'on') !== 'off';
  const keepClasses = (WEEKEND_CRYPTO && (reason === 'weekend' || reason === 'friday-cutoff')) ? ['CRYPTO'] : [];

  const b = await import('./broker_ctrader.mjs');
  await b.connect();
  const open = await b.getPositions();
  if (!open.length) { log(`${reason}: no open positions`); process.exit(0); }

  // Daily EOD only: close LOSERS, carry bracketed winners overnight so H1-scale
  // trades reach their natural TP/SL. Weekend + friday-cutoff paths below are
  // deliberately untouched — they flatten regardless of profit because cTrader
  // queues closes for shut markets to Monday (a carried FX/index winner would
  // be unmanageable over the weekend). Note the cron re-fires every 30 min
  // until midnight UTC, so a carried winner that turns negative before 24:00
  // is closed on a later tick — "in profit" must hold through the evening.
  const CARRY_WINNERS = (process.env.EOD_CARRY_WINNERS ?? 'on') !== 'off';
  if (reason === 'daily-eod' && CARRY_WINNERS) {
    let closed = 0, carried = 0, failed = 0;
    for (const p of open) {
      let carry = false, why = '';
      try {
        const sym  = await b.getSymbolNameById(p.symbolId);
        const name = sym?.name || String(p.symbolId);
        const bars = await b.getTrendbars(name, { period: 'M1', fromMs: Date.now() - 2 * 3600 * 1000 });
        const cur  = bars.length ? bars[bars.length - 1].c : null;
        const inProfit  = cur != null && (p.direction === 'long' ? cur > p.entryPrice : cur < p.entryPrice);
        const bracketed = p.stopLoss > 0 && p.takeProfit > 0;   // never carry a naked position
        carry = inProfit && bracketed;
        why = `${name} ${p.direction} entry=${p.entryPrice} cur=${cur ?? 'unpriceable'} — ` +
              (carry ? 'in profit + bracketed' : !inProfit ? 'not in profit' : 'NAKED (no SL/TP)');
      } catch (e) { why = `pos ${p.positionId}: price check failed (${e.message})`; }
      if (carry) { carried++; log(`daily-eod CARRY: ${why}`); continue; }
      try {
        await b.closePosition(p.positionId, p.volumeCents);
        closed++; log(`daily-eod close: ${why}`);
      } catch (e) { failed++; log(`daily-eod close ${p.positionId} FAILED: ${e.message}`); }
    }
    log(`daily-eod: closed ${closed}, carried ${carried}, failed ${failed}`);
    process.exit(0);
  }

  log(`${reason}: ${open.length} open position(s)${keepClasses.length ? ` — keeping ${keepClasses.join(',')}` : ' — flattening'}`);
  const res = await b.closeAllPositions({ keepClasses });
  log(`closed ${res.closed}, kept ${res.skipped || 0}, remaining ${res.remaining}`);
  process.exit(0);
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
