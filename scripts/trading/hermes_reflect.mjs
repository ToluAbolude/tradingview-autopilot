/**
 * hermes_reflect.mjs — One-variable-per-cycle reflection wrapper.
 *
 * Workflow:
 *   1. Run review_params.mjs (writes data/pending_params.json)
 *   2. Score current performance vs data/goal.json
 *   3. Pick the SINGLE highest-priority recommendation
 *   4. Snapshot current trading_params.json to params_history/v{NNNN}.json
 *   5. Apply just that one change (bump _version, _updatedBy=hermes)
 *   6. Append hypothesis to hypotheses.jsonl
 *   7. Defer the rest to deferred_hypotheses.jsonl
 *
 * Usage:
 *   node scripts/trading/hermes_reflect.mjs --dry-run   (score + show pick, no writes)
 *   node scripts/trading/hermes_reflect.mjs --apply     (snapshot + mutate + log)
 *
 *   Add --use-existing to skip regenerating pending_params.json (consume what
 *   eod_agent.mjs or review_params.mjs already wrote). Without it, this script
 *   re-runs review_params.mjs to refresh recommendations.
 *
 * Pairs companion params (blockedSymbols + blockedSymbolExpiry) — they count as one variable.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync, copyFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import os from 'os';
import { scorePerformance, loadGoal } from './score.mjs';

const IS_LINUX  = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX
  ? '/home/ubuntu/trading-data'
  : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';

const PARAMS_FILE     = join(DATA_ROOT, 'trading_params.json');
const PENDING_FILE    = join(DATA_ROOT, 'pending_params.json');
const HISTORY_DIR     = join(DATA_ROOT, 'params_history');
const HYPOTHESES_LOG  = join(DATA_ROOT, 'hypotheses.jsonl');
const DEFERRED_LOG    = join(DATA_ROOT, 'deferred_hypotheses.jsonl');
const TRADES_CSV      = join(DATA_ROOT, 'trade_log', 'trades.csv');
const LOOKBACK_DAYS   = 30;

// Priority order — most-impactful levers first.
// Companion params (blockedSymbols ↔ blockedSymbolExpiry) move together as ONE pick.
const PRIORITY = ['blockedSymbols', 'scoreThreshold', 'slAtrMult', 'requireTrifecta', 'riskPct'];
const COMPANIONS = { blockedSymbols: ['blockedSymbolExpiry'] };

const mode = process.argv.includes('--apply') ? 'apply'
           : process.argv.includes('--dry-run') ? 'dry-run'
           : null;
const useExisting = process.argv.includes('--use-existing');

if (!mode) {
  console.error('Usage: node hermes_reflect.mjs --dry-run | --apply [--use-existing]');
  process.exit(1);
}

function parseTradesCsv() {
  if (!existsSync(TRADES_CSV)) return [];
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - LOOKBACK_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return readFileSync(TRADES_CSV, 'utf8').trim().split('\n').slice(1)
    .filter(l => l.trim() && l >= cutoffStr)
    .map(l => {
      const p = l.split(',');
      return {
        date: p[0], session: p[1], symbol: p[2], tf: p[3], dir: p[4],
        score: parseFloat(p[5]) || 0, entry: parseFloat(p[6]) || 0, sl: parseFloat(p[7]) || 0,
        tp: p[8], rr: parseFloat(p[9]) || 0, result: (p[10] || '').trim(),
        pnl: parseFloat(p[11]) || 0,
      };
    })
    .filter(t => t.symbol && t.result && t.pnl !== 0);
}

function nextVersionNumber() {
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
  const existing = readdirSync(HISTORY_DIR).filter(f => /^v\d{4}\.json$/.test(f));
  if (!existing.length) return 1;
  return Math.max(...existing.map(f => parseInt(f.slice(1, 5), 10))) + 1;
}

function pickOne(recs) {
  if (!recs.length) return { pick: null, deferred: [] };
  // Dedupe by param (last wins — matches apply_params.mjs behaviour)
  const byParam = new Map();
  for (const r of recs) byParam.set(r.param, r);
  const unique = [...byParam.values()];

  // Pull companion params out of the priority race — they ride with their parent
  const companionSet = new Set(Object.values(COMPANIONS).flat());
  const primaries = unique.filter(r => !companionSet.has(r.param));

  // Sort by priority; unknown params sort last
  primaries.sort((a, b) => {
    const ai = PRIORITY.indexOf(a.param); const bi = PRIORITY.indexOf(b.param);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  const winner = primaries[0];
  const winnerGroup = [winner, ...(COMPANIONS[winner.param] || [])
    .map(p => unique.find(r => r.param === p))
    .filter(Boolean)];

  const winnerNames = new Set(winnerGroup.map(r => r.param));
  const deferred = unique.filter(r => !winnerNames.has(r.param));

  return { pick: winnerGroup, deferred };
}

function applyPick(currentParams, pickGroup) {
  const updated = { ...currentParams };
  for (const rec of pickGroup) updated[rec.param] = rec.proposed;
  updated._lastUpdated = new Date().toISOString().slice(0, 10);
  updated._updatedBy = 'hermes';
  updated._version = (parseInt(currentParams._version, 10) || 0) + 1;
  return updated;
}

function main() {
  console.log('=== HERMES REFLECTION ===');
  console.log(`Mode: ${mode}`);

  // 1. Generate recommendations via existing engine (unless caller already has pending_params)
  if (useExisting) {
    if (!existsSync(PENDING_FILE)) {
      console.error('--use-existing set but no pending_params.json found. Run eod_agent.mjs or review_params.mjs first.');
      process.exit(1);
    }
    console.log('Using existing pending_params.json (skipping review_params.mjs regen).');
  } else {
    try {
      execSync('node scripts/trading/review_params.mjs', { stdio: 'pipe' });
    } catch (e) {
      console.error('review_params.mjs failed:', e.message);
      process.exit(1);
    }
  }

  if (!existsSync(PENDING_FILE)) {
    console.log('No pending_params.json after review — nothing to reflect on.');
    process.exit(0);
  }
  const pending = JSON.parse(readFileSync(PENDING_FILE, 'utf8'));
  const params  = JSON.parse(readFileSync(PARAMS_FILE, 'utf8'));

  // 2. Score current performance vs goal
  const trades = parseTradesCsv();
  const goal   = loadGoal();
  const scored = scorePerformance(trades, goal.startingEquity || 10000, goal);
  console.log(`\nScore: ${scored.score}  Verdict: ${scored.verdict}  Trades: ${scored.components?.tradeCount ?? 0}`);
  if (scored.components) {
    console.log(`  Return: ${(scored.components.realisedReturn * 100).toFixed(2)}% (target ${(goal.targetReturn30d*100).toFixed(1)}%)`);
    console.log(`  Drawdown: ${(scored.components.observedDrawdown * 100).toFixed(2)}% (max ${(goal.maxDrawdown*100).toFixed(1)}%)`);
    console.log(`  PF: ${scored.components.profitFactor}  WR: ${scored.components.winRate}%`);
  }

  // 3. Pick one
  const recs = pending.recommendations || [];
  const { pick, deferred } = pickOne(recs);

  if (!pick) {
    console.log('\nNo recommendations — strategy holds at v' + (params._version ?? 0));
    process.exit(0);
  }

  console.log(`\nPick (one variable per cycle):`);
  for (const r of pick) {
    console.log(`  → ${r.param}: ${JSON.stringify(r.current)} → ${JSON.stringify(r.proposed)}`);
    console.log(`    ${r.reason}`);
  }
  if (deferred.length) {
    console.log(`\nDeferred to next cycle (${deferred.length}):`);
    for (const r of deferred) console.log(`  · ${r.param}`);
  }

  if (mode === 'dry-run') {
    console.log('\n[dry-run] No files written.');
    return;
  }

  // 4. Snapshot
  const vNum = nextVersionNumber();
  const vTag = 'v' + String(vNum).padStart(4, '0');
  const snapPath = join(HISTORY_DIR, `${vTag}.json`);
  copyFileSync(PARAMS_FILE, snapPath);
  console.log(`\n✓ Snapshot: ${snapPath}`);

  // 5. Apply
  const next = applyPick(params, pick);
  writeFileSync(PARAMS_FILE, JSON.stringify(next, null, 2), 'utf8');
  console.log(`✓ Applied → trading_params.json v${next._version}`);

  // 6. Log hypothesis
  const hypothesis = {
    ts: new Date().toISOString(),
    version: next._version,
    snapshotOf: vTag,
    score: scored.score,
    verdict: scored.verdict,
    change: pick.map(r => ({ param: r.param, from: r.current, to: r.proposed, reason: r.reason })),
    deferred: deferred.map(r => r.param),
  };
  appendFileSync(HYPOTHESES_LOG, JSON.stringify(hypothesis) + '\n');
  console.log(`✓ Hypothesis logged: ${HYPOTHESES_LOG}`);

  // 7. Log deferred
  if (deferred.length) {
    for (const d of deferred) {
      appendFileSync(DEFERRED_LOG, JSON.stringify({
        ts: new Date().toISOString(), forVersion: next._version + 1,
        param: d.param, proposed: d.proposed, reason: d.reason,
      }) + '\n');
    }
  }

  console.log('=== DONE ===');
}

main();
