/**
 * chart_lock.mjs — one writer at a time on the shared TradingView chart tab.
 *
 * market_scanner (continuous, every 15 min) and daily_selector (05:10 UTC) both drive
 * the SAME chart tab via setChart/getBars. Nothing coordinated them, so they overlapped
 * by luck. When they do overlap, one process's setChart lands while the other is reading
 * bars, and prices get attributed to the wrong instrument — observed live on 2026-08-21:
 *
 *     GBPUSD ... nearest support 4583.81    <- gold's price   (cable is 1.36)
 *     XAUUSD ... nearest support 76643.5    <- bitcoin's price (gold is 4540)
 *
 * A contaminated selector run writes wrong biasScore/zoneLevel for the whole trading day,
 * silently. This is advisory locking around the chart-touching phase of each job.
 *
 * Atomic by construction: acquire is open(..,'wx'), which fails if the file exists — no
 * read-then-write window for two processes to both pass. A holder that dies without
 * releasing is reclaimed via PID liveness plus a hard age cap, so the lock cannot wedge
 * the scanner permanently (the failure mode this whole stack is most allergic to).
 */
import { openSync, closeSync, writeSync, readFileSync, unlinkSync, existsSync } from 'fs';

const LOCK_FILE = '/tmp/.tv_chart_lock';
const STALE_MS  = 5 * 60 * 1000;   // longest plausible scan; beyond this the holder is gone

const read = () => { try { return JSON.parse(readFileSync(LOCK_FILE, 'utf8')); } catch (_) { return null; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };

/** Current holder, or null when free / dead / stale (reclaiming the file as a side effect). */
export function chartLockHolder() {
  if (!existsSync(LOCK_FILE)) return null;
  const l = read();
  if (!l) { try { unlinkSync(LOCK_FILE); } catch (_) {} return null; }   // corrupt = not a holder
  if (!alive(l.pid) || Date.now() - l.at > STALE_MS) {
    try { unlinkSync(LOCK_FILE); } catch (_) {}
    return null;
  }
  return l;
}

/** Take the lock, waiting up to maxWaitMs. Returns true if held, false on timeout. */
export async function acquireChartLock(who, maxWaitMs = 90000, log = () => {}) {
  const deadline = Date.now() + maxWaitMs;
  let announced = false;
  for (;;) {
    const holder = chartLockHolder();            // also reclaims a dead/stale lock
    if (!holder) {
      try {
        const fd = openSync(LOCK_FILE, 'wx');     // atomic: EEXIST if another process won
        writeSync(fd, JSON.stringify({ who, pid: process.pid, at: Date.now() }));
        closeSync(fd);
        if (announced) log(`  [chart-lock] acquired by ${who} after waiting`);
        return true;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;         // lost the race — fall through and retry
      }
    } else if (!announced) {
      log(`  [chart-lock] waiting — held by ${holder.who} (pid ${holder.pid})`);
      announced = true;
    }
    if (Date.now() >= deadline) {
      log(`  [chart-lock] TIMEOUT after ${Math.round(maxWaitMs / 1000)}s waiting for ${chartLockHolder()?.who ?? 'unknown'} (${who})`);
      return false;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

/** Release, but only if we actually hold it — never steal another process's lock. */
export function releaseChartLock() {
  try { const l = read(); if (l && l.pid === process.pid) unlinkSync(LOCK_FILE); } catch (_) {}
}
