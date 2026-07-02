/**
 * market_scanner.mjs — Continuous 15-minute market scanner
 *
 * Runs scanForSetups() across all 27 instruments every 15 minutes.
 * Writes every signal to live_signals.json — a persistent file that
 * Claude can read at any time to report current market opportunities.
 *
 * Output file:
 *   Linux:   /home/ubuntu/trading-data/live_signals.json
 *   Windows: C:/Users/Tda-d/tradingview-mcp-jackson/data/live_signals.json
 *
 * Usage (on VM):
 *   node scripts/trading/market_scanner.mjs
 *
 * Signal lifecycle:
 *   new → active (within TTL window) → expired (moved to history)
 *   60M signals expire after 2 hours | 15M signals expire after 30 min
 */

import { scanForSetups } from './setup_finder.mjs';
import { attemptInlineTrade, resetCycleState } from './inline_trader.mjs';
import { captureOrderHistory } from './broker_history.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import os from 'os';

const IS_LINUX        = os.platform() === 'linux';
const DATA_ROOT       = IS_LINUX ? '/home/ubuntu/trading-data' : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const SIGNALS_FILE    = join(DATA_ROOT, 'live_signals.json');
const SCAN_INTERVAL   = 15 * 60 * 1000;   // 15 minutes
const MAX_HISTORY     = 500;               // keep last 500 expired signals
const MIN_SCORE       = 6;                 // per-TF Pass 1 threshold (MTF bonus adds up to +3 on top)
// --scan-only: look at charts + write live_signals.json every 15 min, but place
// NO trades (pass no executor to scanForSetups). Visibility/planning without the
// overtrading risk of continuous auto-execution.
const SCAN_ONLY       = process.argv.includes('--scan-only');

// How long a signal stays "active" before auto-expiring
const TTL = { '15': 30 * 60 * 1000, '60': 2 * 60 * 60 * 1000 };
const DEFAULT_TTL = 60 * 60 * 1000;

// ── File I/O ──────────────────────────────────────────────────────────────────
function load() {
  if (!existsSync(SIGNALS_FILE)) return { meta: {}, active: [], history: [] };
  try { return JSON.parse(readFileSync(SIGNALS_FILE, 'utf8')); }
  catch(_) { return { meta: {}, active: [], history: [] }; }
}

function save(state) {
  if (!existsSync(DATA_ROOT)) mkdirSync(DATA_ROOT, { recursive: true });
  writeFileSync(SIGNALS_FILE, JSON.stringify(state, null, 2));
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const sigId = s => `${s.label}-${s.tf}-${s.dir}`;

function partition(active) {
  const now = Date.now();
  return {
    live:    active.filter(s => new Date(s.expires).getTime() > now),
    expired: active.filter(s => new Date(s.expires).getTime() <= now),
  };
}

function buildSummary(active) {
  if (active.length === 0) return 'No active signals.';
  return active
    .map(s => `${s.label} ${s.tf}M ${s.dir.toUpperCase()} [${s.score}] entry:${s.entry} tp:${s.tp2} sl:${s.sl}`)
    .join(' | ');
}

// ── Scan cycle ────────────────────────────────────────────────────────────────
async function runScan(state) {
  const scanTs = new Date().toISOString();
  const scanNo = (state.meta.scan_count || 0) + 1;
  console.log(`\n[${scanTs}] Scan #${scanNo}...`);

  // Reset per-cycle trade state so correlated-group and concurrent limits apply
  // within each scan cycle independently.
  resetCycleState();

  let fresh = [];
  try {
    fresh = await scanForSetups(MIN_SCORE, 1.5, SCAN_ONLY ? null : attemptInlineTrade);
  } catch (e) {
    console.error(`  Scan error: ${e.message}`);
    return state;
  }

  const now = Date.now();
  const { live, expired } = partition(state.active || []);
  const liveIds = new Set(live.map(sigId));

  // Add only genuinely new signals (not already active for this instrument/tf/dir)
  const added = [];
  for (const s of fresh) {
    const id = sigId(s);
    if (liveIds.has(id)) continue;

    const ttl     = TTL[s.tf] ?? DEFAULT_TTL;
    const expires = new Date(now + ttl).toISOString();

    const record = {
      id,
      ts:         scanTs,
      expires,
      label:      s.label,
      tf:         s.tf,
      dir:        s.dir,
      score:      s.score,
      strategies: s.strategies,
      entry:      s.entry,
      sl:         s.sl,
      tp1:        s.tpQuick,
      tp2:        s.tp2,
      tp3:        s.tp3,
      rr:         s.rr,
      rsi:        Math.round(s.rsi),
      tier:       s.tier,
      reasons:    (s.reasons || []).slice(0, 5),
    };

    live.push(record);
    liveIds.add(id);
    added.push(record);

    console.log(`  ✅ NEW [${s.score}] ${s.label} ${s.tf}M ${s.dir.toUpperCase()} | Entry:${s.entry} SL:${s.sl} TP:${s.tp2} | ${s.strategies.join(',')}`);
  }

  if (added.length === 0) console.log('  No new setups this cycle.');

  // Roll expired into history (newest first), cap at MAX_HISTORY
  const newHistory = [
    ...expired.map(s => ({ ...s, status: 'expired' })),
    ...(state.history || []),
  ].slice(0, MAX_HISTORY);

  const nextDue = new Date(now + SCAN_INTERVAL).toISOString();

  const newState = {
    // ── Meta (I read this first for a quick market overview) ──
    meta: {
      started:        state.meta.started || scanTs,
      last_scan:      scanTs,
      next_scan_due:  nextDue,
      scan_count:     scanNo,
      total_signals:  (state.meta.total_signals || 0) + added.length,
      active_count:   live.length,
    },

    // ── One-line summary — readable at a glance ──
    summary: buildSummary(live.sort((a, b) => b.score - a.score)),

    // ── Active signals (within TTL, sorted score desc) ──
    active: live.sort((a, b) => b.score - a.score || a.tier - b.tier),

    // ── Rolling history ──
    history: newHistory,
  };

  save(newState);

  console.log(`  Active: ${live.length} | New: ${added.length} | History: ${newHistory.length}`);
  console.log(`  Saved → ${SIGNALS_FILE}`);

  // ── Mirror BlackBull's actual Order History to CSV ─────────────────────────
  // The broker panel is settled now (no chart navigation happens after this
  // point in the cycle), so the Order history tab can be safely opened.
  // Captures any new orders since the previous scan — including ones the bot
  // didn't place (manual trades, scheduled, etc.) — and serves as ground-truth
  // for reconciling against trades.csv to detect silent submit failures.
  try {
    const r = await captureOrderHistory();
    if (r && !r.skipped && !r.error) {
      console.log(`  [broker_history] scraped=${r.scraped} added=${r.added}`);
    } else if (r && r.error) {
      console.log(`  [broker_history] error: ${r.error}`);
    }
  } catch (e) {
    console.log(`  [broker_history] capture error: ${e.message}`);
  }

  console.log(`  Next scan: ${nextDue}`);

  return newState;
}

// ── Entry point ───────────────────────────────────────────────────────────────
// Single-instance lock — prevents two scanners racing on the same Chrome tab
const SCANNER_LOCK = join(DATA_ROOT, 'market_scanner.lock');
if (existsSync(SCANNER_LOCK)) {
  const pid = parseInt(readFileSync(SCANNER_LOCK, 'utf8').trim(), 10);
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch (_) {}
  if (alive) {
    console.error(`[market_scanner] Another instance is running (PID ${pid}). Exiting.`);
    process.exit(1);
  }
  unlinkSync(SCANNER_LOCK); // stale lock
}
writeFileSync(SCANNER_LOCK, String(process.pid));
process.on('exit', () => { try { unlinkSync(SCANNER_LOCK); } catch (_) {} });
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

console.log('\n══════════════════════════════════════════════════════');
console.log('  Market Scanner — 15-min continuous scan');
console.log(`  Threshold ≥${MIN_SCORE} | 27 instruments | All sessions`);
console.log(`  Output: ${SIGNALS_FILE}`);
console.log('══════════════════════════════════════════════════════');

let state = load();
let _stopping = false;

// Chain scans with setTimeout so the next scan only starts after the previous
// one fully completes — setInterval would fire a new scan while the previous is
// still running (now that waitForBars adds retry delays), causing two scans to
// compete for the same Chrome tab simultaneously.
async function loop() {
  const start = Date.now();
  state = await runScan(state);
  if (_stopping) return;
  const elapsed = Date.now() - start;
  const wait = Math.max(0, SCAN_INTERVAL - elapsed);
  if (elapsed > SCAN_INTERVAL) {
    console.log(`  [Scanner] Scan took ${Math.round(elapsed / 1000)}s (>${SCAN_INTERVAL / 60000} min) — next scan starting immediately`);
  }
  setTimeout(loop, wait);
}

// Run immediately on start, then chain
loop();

// Clean exit on Ctrl+C
process.on('SIGINT', () => {
  _stopping = true;
  console.log(`\n  Scanner stopped after ${state.meta.scan_count} scans.`);
  console.log(`  Signals preserved in ${SIGNALS_FILE}\n`);
  process.exit(0);
});
