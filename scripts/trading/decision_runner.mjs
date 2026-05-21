/**
 * decision_runner.mjs — Decision maker for trading signals
 *
 * Runs every 15 minutes via systemd timer.
 * Reads live_signals.json from market scanner.
 * Validates against Strategy Overhaul rules.
 * Writes trade/skip decisions to trading_decisions.json.
 *
 * Usage:
 *   node scripts/trading/decision_runner.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import os from 'os';

const IS_LINUX = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX ? '/home/ubuntu/trading-data' : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const SIGNALS_FILE = join(DATA_ROOT, 'live_signals.json');
const DECISIONS_FILE = join(DATA_ROOT, 'trading_decisions.json');

// Strategy Overhaul rules (non-negotiable)
const MIN_SCORE = 6;
const MIN_RR = 2.0;

function load(filepath) {
  if (!existsSync(filepath)) return null;
  try { return JSON.parse(readFileSync(filepath, 'utf8')); }
  catch (e) { console.error(`Error reading ${filepath}: ${e.message}`); return null; }
}

function save(filepath, data) {
  if (!existsSync(DATA_ROOT)) mkdirSync(DATA_ROOT, { recursive: true });
  writeFileSync(filepath, JSON.stringify(data, null, 2));
}

function validateSignal(sig) {
  const issues = [];

  if (sig.score < MIN_SCORE) issues.push(`Score ${sig.score} < ${MIN_SCORE}`);
  if (sig.rr < MIN_RR) issues.push(`R:R ${sig.rr} < ${MIN_RR}:1`);

  const hasAllStrategies = sig.strategies && sig.strategies.includes('Trend') &&
                           sig.strategies.includes('S&R') &&
                           sig.strategies.includes('FVG');
  if (!hasAllStrategies) issues.push('Missing Trend/S&R/FVG');

  return { valid: issues.length === 0, issues };
}

function makeDecision(sig) {
  const { valid, issues } = validateSignal(sig);

  return {
    timestamp: new Date().toISOString(),
    decision: valid ? 'TRADE' : 'SKIP',
    symbol: sig.label,
    tf: sig.tf,
    direction: sig.dir.toUpperCase(),
    entry: sig.entry,
    sl: sig.sl,
    tp: sig.tp2,
    rr: sig.rr,
    score: sig.score,
    tier: sig.tier,
    reasoning: valid
      ? `✅ All rules met. Score ${sig.score}, R:R ${sig.rr}:1, strategies: ${sig.strategies.join('+')}. Execute tier-${sig.tier} (${[5, 3.5, 2.5][sig.tier - 1]}%).`
      : `❌ ${issues.join('. ')}`,
    validation: {
      score_check: `${sig.score} >= ${MIN_SCORE}: ${sig.score >= MIN_SCORE ? 'PASS' : 'FAIL'}`,
      rr_check: `${sig.rr} >= ${MIN_RR}:1: ${sig.rr >= MIN_RR ? 'PASS' : 'FAIL'}`,
      strategy_check: sig.strategies.join('+') + (validateSignal(sig).valid ? ': PASS' : ': FAIL'),
    },
    action: valid ? 'EXECUTE' : 'DO_NOT_EXECUTE'
  };
}

async function runDecisionCycle() {
  const cycleTs = new Date().toISOString();
  console.log(`\n[${cycleTs}] Decision cycle starting...`);

  // Load signals
  const signalsData = load(SIGNALS_FILE);
  if (!signalsData || !signalsData.active || signalsData.active.length === 0) {
    console.log('  No active signals. Skipping cycle.');
    return;
  }

  // Load existing decisions
  let decisionsData = load(DECISIONS_FILE) || {
    meta: { started: cycleTs, total_decisions: 0, trades_approved: 0, trades_rejected: 0 },
    recent_decisions: [],
    history: []
  };

  // Process top signal (highest score)
  const topSignal = signalsData.active[0];
  const decision = makeDecision(topSignal);

  console.log(`  ${decision.decision} [${decision.symbol} ${decision.tf}M ${decision.direction}]`);
  console.log(`  Reasoning: ${decision.reasoning.slice(0, 80)}...`);

  // Update metadata
  decisionsData.meta.last_decision = cycleTs;
  decisionsData.meta.total_decisions = (decisionsData.meta.total_decisions || 0) + 1;
  if (decision.decision === 'TRADE') {
    decisionsData.meta.trades_approved = (decisionsData.meta.trades_approved || 0) + 1;
  } else {
    decisionsData.meta.trades_rejected = (decisionsData.meta.trades_rejected || 0) + 1;
  }

  // Keep last 10 decisions + move older ones to history
  decisionsData.recent_decisions.push(decision);
  if (decisionsData.recent_decisions.length > 10) {
    const oldDecision = decisionsData.recent_decisions.shift();
    decisionsData.history.unshift(oldDecision);
    decisionsData.history = decisionsData.history.slice(0, 100); // keep 100 history
  }

  save(DECISIONS_FILE, decisionsData);
  console.log(`  Saved → ${DECISIONS_FILE}`);
  console.log(`  Stats: ${decisionsData.meta.trades_approved} approved, ${decisionsData.meta.trades_rejected} rejected`);
}

// Entry point
runDecisionCycle().catch(e => {
  console.error(`[Decision Runner] Error: ${e.message}`);
  process.exit(1);
});
