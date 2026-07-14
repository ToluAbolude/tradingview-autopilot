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
 *     Since 2026-07-14 a LOSING bracketed position can also carry if its entry
 *     thesis still holds (thesisIntact: <50% of the way to SL + AutoTL 4H trend
 *     still in the trade direction + H1 fib leg not retraced ≥61.8%) — re-judged
 *     every 30-min tick, any gate failing or erroring closes it. Kill switch:
 *     EOD_CARRY_THESIS=off restores close-all-losers.
 * cTrader Open API only at runtime — no CDP connection is ever opened (the
 * setup_finder import below is for its pure autoTrendlineTrend function).
 * Demo-only by env. Safe to run often (it no-ops outside the close windows).
 *
 * Cron: every ~30 min on Fri/Sat/Sun (the script decides whether to act).
 */
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { autoTrendlineTrend } from './setup_finder.mjs';
import { fibVetoState, pContinue, VETO_DEPTH } from './fib_veto.mjs';

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

/**
 * Re-run the entry thesis for a LOSING bracketed position at daily EOD.
 * Returns a human-readable reason string when the thesis still holds
 * (position carries), or null when it doesn't (position closes).
 * ALL gates must pass; any error fails safe to null (close):
 *   1. Drawdown < EOD_THESIS_MAX_LOSS_FRAC (default 0.5) of the SL distance —
 *      more than halfway to the stop means the market already voted no.
 *   2. AutoTL 4H×180 (broker H4 bars, same geometry the daily selector uses):
 *      a line AGAINST the trade always closes. A line WITH the trade affirms.
 *      Null (no validated line — common: the JS replica is stricter than the
 *      chart Pine, esp. on 1H noise) defers to the fib gate.
 *   3. H1 fib leg: reversed in-direction leg or depth ≥ VETO_DEPTH (61.8% —
 *      continuation odds collapse per the fib study) closes; a fresh OPPOSING
 *      impulse (tracking, retraced <50%) closes. To CARRY: either the 4H trend
 *      affirms (fib merely not vetoing), or — with no 4H line — the in-direction
 *      leg must be SHALLOW (depth ≤ 0.5, P(cont) ≥ ~47%) to count as evidence.
 *      No trend line AND no in-direction leg = no evidence = close.
 */
const THESIS_MAX_LOSS_FRAC = Number(process.env.EOD_THESIS_MAX_LOSS_FRAC ?? 0.5);
export async function thesisIntact(b, name, p, cur) {
  try {
    const slDist = Math.abs(p.entryPrice - p.stopLoss);
    if (!(slDist > 0)) return null;
    const lossFrac = (p.direction === 'long' ? p.entryPrice - cur : cur - p.entryPrice) / slDist;
    if (lossFrac >= THESIS_MAX_LOSS_FRAC) return null;

    const h4 = await b.getTrendbars(name, { period: 'H4', fromMs: Date.now() - 60 * 86400000, windowDays: 15 });
    if (h4.length < 100) return null;
    const trend = autoTrendlineTrend(h4.slice(-180));
    if (trend.dir && trend.dir !== p.direction) return null;   // 4H line against the trade
    const trendAffirms = trend.dir === p.direction;

    const h1 = await b.getTrendbars(name, { period: 'H1', fromMs: Date.now() - 14 * 86400000, windowDays: 7 });
    const fib = fibVetoState(h1);
    const legDir = fib.dir === 1 ? 'long' : fib.dir === -1 ? 'short' : null;
    let fibAffirms = false;
    let fibNote = 'fib: no active leg';
    if (legDir === p.direction) {
      if (fib.status === 'reversed') return null;
      if (fib.status === 'tracking' && fib.depth >= VETO_DEPTH) return null;
      fibAffirms = fib.status !== 'tracking' || fib.depth <= 0.5;   // shallow enough to stand alone
      fibNote = `fib depth ${(fib.depth * 100).toFixed(0)}% (P(cont)≈${pContinue(fib.depth)}%)`;
    } else if (legDir && fib.status === 'tracking' && fib.depth < 0.5) {
      return null;   // fresh impulse against the trade, barely retraced — thesis broken
    }

    if (!trendAffirms && !fibAffirms) return null;   // no positive evidence left — close
    return `AutoTL 4H ${trend.dir ? trend.detail : 'neutral (no line)'}; ${fibNote}; drawdown ${(Math.max(lossFrac, 0) * 100).toFixed(0)}% of SL dist`;
  } catch (e) {
    log(`thesis check ${name} failed: ${e.message} — closing (fail-safe)`);
    return null;
  }
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
    // A position born AFTER today's EOD window opened (late crypto entries —
    // CRYPTO_LATE in inline_trader) hasn't had a day to work; culling it on the
    // next 30-min tick would be churn. It gets judged at the NEXT day's EOD.
    const _t = new Date();
    const eodStartMs = Date.UTC(_t.getUTCFullYear(), _t.getUTCMonth(), _t.getUTCDate(), DAILY_EOD_UTC ?? 20);
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
        const bornInWindow = (p.openTimestamp || 0) >= eodStartMs;
        carry = bracketed && (inProfit || bornInWindow);
        // Loser with the entry thesis still intact → carry (EOD_CARRY_THESIS=off disables).
        let thesisWhy = null;
        const CARRY_THESIS = (process.env.EOD_CARRY_THESIS ?? 'on') !== 'off';
        if (!carry && bracketed && cur != null && CARRY_THESIS) {
          thesisWhy = await thesisIntact(b, name, p, cur);
          if (thesisWhy) carry = true;
        }
        why = `${name} ${p.direction} entry=${p.entryPrice} cur=${cur ?? 'unpriceable'} — ` +
              (!bracketed ? 'NAKED (no SL/TP)'
               : bornInWindow ? 'fresh late entry — judged at next EOD'
               : inProfit ? 'in profit + bracketed'
               : thesisWhy ? `loser but thesis intact: ${thesisWhy}`
               : 'not in profit (thesis broken or unverifiable)');
      } catch (e) { why = `pos ${p.positionId}: price check failed (${e.message})`; }
      if (carry) { carried++; log(`daily-eod CARRY: ${why}`); continue; }
      try {
        await b.closePosition(p.positionId, p.volumeCents);
        closed++; log(`daily-eod close: ${why}`);
        // Sweep partial-close TP LIMIT children — cTrader does NOT auto-cancel
        // them on a full flatten (2026-07-14: this loop left 3 AUDUSD + 3 AUDNZD
        // sell limits resting; each would open an SL-less short if price hit it).
        try {
          const { cancelled } = await b.cancelOrphanLimits(p.positionId);
          if (cancelled) log(`daily-eod: cancelled ${cancelled} orphan TP limit(s) for ${p.positionId}`);
        } catch (e) { log(`daily-eod orphan sweep ${p.positionId} failed: ${e.message}`); }
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

// Run only when executed directly — importing the module (e.g. to test
// thesisIntact) must not trigger a flatten pass.
if (process.argv[1] && process.argv[1].endsWith('confirm_eod_close.mjs')) {
  main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
}
