/**
 * apply_params.mjs — Applies approved parameter changes from pending_params.json.
 *
 * Usage:
 *   node scripts/trading/apply_params.mjs --preview   (show diff, no changes)
 *   node scripts/trading/apply_params.mjs --apply     (write + archive)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { clampBlockExpiry } from './params_blocks.mjs';

const IS_LINUX   = os.platform() === 'linux';
const DATA_ROOT  = IS_LINUX
  ? '/home/ubuntu/trading-data'
  : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';

const PARAMS_FILE  = join(DATA_ROOT, 'trading_params.json');
const PENDING_FILE = join(DATA_ROOT, 'pending_params.json');
const REVIEWS_DIR  = join(DATA_ROOT, 'reviews');

const mode = process.argv.includes('--apply') ? 'apply'
           : process.argv.includes('--preview') ? 'preview'
           : null;

if (!mode) {
  console.error('Usage: node apply_params.mjs --preview | --apply');
  process.exit(1);
}

if (!existsSync(PENDING_FILE)) {
  console.log('No pending_params.json found. Run review_params.mjs first.');
  process.exit(0);
}

const pending = JSON.parse(readFileSync(PENDING_FILE, 'utf8'));
const current = existsSync(PARAMS_FILE)
  ? JSON.parse(readFileSync(PARAMS_FILE, 'utf8'))
  : {};

console.log('\n╔══════════════════════════════════════════════════════╗');
console.log('║   PARAMETER CHANGE REVIEW                            ║');
console.log('╚══════════════════════════════════════════════════════╝');
console.log(`  Generated: ${pending.generatedAt}`);
console.log(`  Analysis:  ${pending.analysisWindow} (${pending.tradeCount} trades)`);
if (pending.overall && typeof pending.overall === 'object') {
  console.log(`  Overall:   WR=${pending.overall.wr}% | PF=${pending.overall.pf} | Net £${pending.overall.totalPnl}`);
}

const recs = pending.recommendations || [];

if (recs.length === 0) {
  console.log('\n  ✓ No changes recommended — performance within acceptable range.');
  process.exit(0);
}

console.log(`\n  ${recs.length} recommended change(s):\n`);

// Deduplicate recs by param (last write wins, for companion pairs like blockedSymbols + blockedSymbolExpiry)
const seen = new Set();
const dedupedRecs = recs.filter(r => {
  if (seen.has(r.param)) return false;
  seen.add(r.param);
  return true;
});

for (const r of dedupedRecs) {
  const currentVal = JSON.stringify(current[r.param] ?? '(unset)', null, 2);
  const proposedVal = JSON.stringify(r.proposed, null, 2);
  console.log(`  PARAM: ${r.param}`);
  console.log(`    Current:  ${currentVal}`);
  console.log(`    Proposed: ${proposedVal}`);
  console.log(`    Reason:   ${r.reason}`);
  console.log();
}

if (mode === 'preview') {
  console.log('  (preview only — no changes made)');
  console.log('  To apply: node scripts/trading/apply_params.mjs --apply\n');
  process.exit(0);
}

// ── Apply mode ──
const updated = { ...current };

// Params the nightly agent may never move (operator directive 2026-08-27).
//
// The entry bar is set by hand against the live score distribution, not by a
// win-rate rule. eod_agent had ratcheted scoreThreshold 6 -> 9 by 2026-08-19 and
// blocked five of the eight core plan instruments; combined with a hardcoded
// Pass-1 bar of 5 that left the account unable to take a single planned trade for
// six days. A rule that only ever tightens on a losing sample is a ratchet: it
// cannot tell "no edge" from "no trades", and it reads the second as the first.
// riskPct is frozen for the same reason — scale_risk_to_goal used to rail it to
// the cap chasing a date, and that scaler is gone.
//
// This is the chokepoint every recommendation funnels through (LLM and static
// fallback alike), so one guard here covers both paths. Recommendations are still
// printed — the reasoning stays visible, it just no longer binds.
const FROZEN = new Set(['scoreThreshold', 'pass1MinScore', 'planScoreFloor', 'planScoreRelief', 'riskPct']);

// Apply all recs (last write per param wins)
for (const r of recs) {
  if (FROZEN.has(r.param)) {
    console.log(`  ⊘ ${r.param} is operator-frozen — logged, not applied (${JSON.stringify(current[r.param])} → ${JSON.stringify(r.proposed)})`);
    continue;
  }
  updated[r.param] = r.proposed;
}
updated._lastUpdated = new Date().toISOString().slice(0, 10);
updated._updatedBy   = 'review_params.mjs';

// Every block gets a week-capped expiry on the way in. This is the chokepoint each
// recommendation funnels through, so a 30-day block cannot enter the file regardless of
// what the nightly agent proposes, and a block can never arrive without an expiry (which
// is what made all 7 symbol blocks permanent).
const clamped = clampBlockExpiry(updated);
for (const key of ['blockedSymbolExpiry', 'blockedSessionExpiry']) {
  if (JSON.stringify(clamped[key]) !== JSON.stringify(updated[key] ?? {}))
    console.log(`  ⓘ ${key} capped to the trading week: ${JSON.stringify(clamped[key])}`);
}

writeFileSync(PARAMS_FILE, JSON.stringify(clamped, null, 2), 'utf8');
console.log(`  ✓ trading_params.json updated.`);

// Archive pending_params.json
if (!existsSync(REVIEWS_DIR)) mkdirSync(REVIEWS_DIR, { recursive: true });
const archiveName = `review_${new Date().toISOString().slice(0, 10)}_${Date.now()}.json`;
const archivePath = join(REVIEWS_DIR, archiveName);
renameSync(PENDING_FILE, archivePath);
console.log(`  ✓ Archived to: ${archivePath}`);
console.log(`\n  Changes active from next scan cycle.\n`);
