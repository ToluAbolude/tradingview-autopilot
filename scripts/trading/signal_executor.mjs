/**
 * signal_executor.mjs — closes the detection→execution gap (2026-07-07).
 *
 * market_scanner runs --scan-only (writes live_signals.json every 15 min, never
 * trades) and session_runner wakes only 4×/day at session opens — but a 15M
 * signal expires after 30 min, so most fresh signals died before any executor
 * looked at them (the EURGBP complaint). This cron (every 5 min) reads
 * live_signals.json and routes each FRESH, not-yet-attempted signal through
 * attemptInlineTrade — the exact same gate stack the scanner used when inline
 * trading was on (weekend-crypto policy, EOD/Friday cutoffs, news, sentiment,
 * trifecta/score gates, sibling/with-trend bias, cooldowns, concurrent +
 * correlated-group caps, anti-stack via cTrader open volume, fib veto,
 * assertOrderSafety, bracket attach). No policy lives here.
 *
 * One attempt per signal EMISSION (id@ts ledger, persisted): attempts count
 * toward caps (2026-06-11 lesson) and a gate-blocked signal is not hammered
 * every 5 min. If the setup is still valid after the signal expires, the next
 * scan re-emits it with a fresh ts and it earns exactly one more attempt —
 * inline_trader's own 30-min symbol+dir cooldown and 24h identical entry+SL
 * dup block bound the worst case.
 *
 * NOTE: live_signals records carry no INST_PROFILE, so per-instrument
 * asianBlock/cooldown overrides don't apply on this path (defaults do).
 */
import { attemptInlineTrade, resetCycleState } from './inline_trader.mjs';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import os from 'os';

const IS_LINUX   = os.platform() === 'linux';
const DATA_ROOT  = IS_LINUX ? '/home/ubuntu/trading-data' : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const SIGNALS_FILE = join(DATA_ROOT, 'live_signals.json');
const STATE_FILE   = join(DATA_ROOT, 'signal_executor_state.json');
const LOCK_FILE    = join(DATA_ROOT, 'signal_executor.lock');
const LEDGER_TTL_MS = 48 * 3600 * 1000;

function log(msg) { process.stdout.write(`[${new Date().toISOString()}] [signal_executor] ${msg}\n`); }

// Single instance — a slow broker call must not overlap the next cron tick
if (existsSync(LOCK_FILE)) {
  const pid = parseInt(readFileSync(LOCK_FILE, 'utf8').trim(), 10);
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch (_) {}
  if (alive) { log(`another instance running (pid ${pid}) — exit`); process.exit(0); }
  unlinkSync(LOCK_FILE); // stale lock
}
writeFileSync(LOCK_FILE, String(process.pid));
process.on('exit', () => { try { unlinkSync(LOCK_FILE); } catch (_) {} });

if (!existsSync(SIGNALS_FILE)) { log('no live_signals.json yet — exit'); process.exit(0); }

let data;
try { data = JSON.parse(readFileSync(SIGNALS_FILE, 'utf8')); }
catch (e) { log(`live_signals.json unreadable (${e.message}) — exit`); process.exit(1); }

const now = Date.now();
let ledger = {};
try { if (existsSync(STATE_FILE)) ledger = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch (_) {}
for (const k of Object.keys(ledger)) if (now - ledger[k] > LEDGER_TTL_MS) delete ledger[k];

const fresh = (data.active || [])
  .filter(s => new Date(s.expires).getTime() > now)
  .filter(s => !ledger[`${s.id}@${s.ts}`])
  .sort((a, b) => b.score - a.score);

if (fresh.length === 0) {
  log(`nothing to do (active=${(data.active || []).length}, all expired or already attempted)`);
  writeFileSync(STATE_FILE, JSON.stringify(ledger));
  process.exit(0);
}

log(`${fresh.length} fresh signal(s): ${fresh.map(s => `${s.label}-${s.tf}M-${s.dir}[${s.score}]`).join(', ')}`);
resetCycleState();   // per-run concurrent/correlated-group tracking

for (const sig of fresh) {
  ledger[`${sig.id}@${sig.ts}`] = now;   // mark BEFORE attempting — attempts count
  try {
    await attemptInlineTrade(sig);
  } catch (e) {
    log(`${sig.id}: executor error — ${e.message}`);
  }
}

writeFileSync(STATE_FILE, JSON.stringify(ledger));
log('done');
process.exit(0);
