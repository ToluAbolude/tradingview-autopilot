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

// Apply all recs (last write per param wins)
for (const r of recs) {
  updated[r.param] = r.proposed;
}
updated._lastUpdated = new Date().toISOString().slice(0, 10);
updated._updatedBy   = 'review_params.mjs';

writeFileSync(PARAMS_FILE, JSON.stringify(updated, null, 2), 'utf8');
console.log(`  ✓ trading_params.json updated.`);

// Archive pending_params.json
if (!existsSync(REVIEWS_DIR)) mkdirSync(REVIEWS_DIR, { recursive: true });
const archiveName = `review_${new Date().toISOString().slice(0, 10)}_${Date.now()}.json`;
const archivePath = join(REVIEWS_DIR, archiveName);
renameSync(PENDING_FILE, archivePath);
console.log(`  ✓ Archived to: ${archivePath}`);
console.log(`\n  Changes active from next scan cycle.\n`);
