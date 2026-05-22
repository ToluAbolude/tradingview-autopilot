/**
 * decision_runner.mjs — Decision maker for trading signals
 *
 * Runs every 15 minutes via systemd timer.
 * Reads live_signals.json from market scanner.
 * Validates against Strategy Overhaul rules + Trifecta confluence.
 * Writes trade/skip decisions to trading_decisions.json.
 *
 * Usage:
 *   node scripts/trading/decision_runner.mjs
 *
 * NOTE: This file LOGS decisions for monitoring/audit. The actual trade
 * execution path is market_scanner → inline_trader (called inline during
 * each scan). Keeping the rule set here in sync with inline_trader's gates
 * makes the decision log a faithful mirror of what the executor will do.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { familiesFor, hasTrifecta, describeConfluence, trifectaCount } from './confluence.mjs';

const IS_LINUX = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX ? '/home/ubuntu/trading-data' : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const SIGNALS_FILE = join(DATA_ROOT, 'live_signals.json');
const DECISIONS_FILE = join(DATA_ROOT, 'trading_decisions.json');
const PARAMS_FILE = join(DATA_ROOT, 'trading_params.json');

// Default rules (overridable via trading_params.json)
const DEFAULT_MIN_SCORE = 6;
const DEFAULT_MIN_RR    = 2.0;
const DEFAULT_REQUIRE_TRIFECTA = false; // matches inline_trader default

function load(filepath) {
  if (!existsSync(filepath)) return null;
  try { return JSON.parse(readFileSync(filepath, 'utf8')); }
  catch (e) { console.error(`Error reading ${filepath}: ${e.message}`); return null; }
}

function save(filepath, data) {
  if (!existsSync(DATA_ROOT)) mkdirSync(DATA_ROOT, { recursive: true });
  writeFileSync(filepath, JSON.stringify(data, null, 2));
}

function loadParams() {
  const p = load(PARAMS_FILE) || {};
  return {
    minScore:        p.scoreThreshold ?? DEFAULT_MIN_SCORE,
    minRR:           p.minRR ?? DEFAULT_MIN_RR,
    requireTrifecta: p.requireTrifecta ?? DEFAULT_REQUIRE_TRIFECTA,
    trifectaBonus:   p.trifectaScoreBonus ?? 1, // when missing Trifecta, require score + bonus
  };
}

function validateSignal(sig, params) {
  const issues = [];
  const fams = familiesFor(sig.strategies || []);
  const trif = trifectaCount(sig.strategies || []);

  if (sig.score < params.minScore) issues.push(`Score ${sig.score} < ${params.minScore}`);
  if (sig.rr < params.minRR)       issues.push(`R:R ${sig.rr} < ${params.minRR}:1`);

  if (params.requireTrifecta && trif < 3) {
    issues.push(`Missing Trifecta (${trif}/3 families — ${describeConfluence(sig.strategies)})`);
  } else if (trif === 0) {
    // No structure backing at all — never trade regardless of score
    issues.push(`Zero Trifecta families (no Trend/Level/Signal — ${describeConfluence(sig.strategies)})`);
  } else if (trif < 3) {
    // Soft gate: partial Trifecta needs higher effective score (matches inline_trader)
    const need = params.minScore + (trif === 2 ? 1 : 2);
    if (sig.score < need) issues.push(`Partial Trifecta (${trif}/3) needs score ≥ ${need} (got ${sig.score})`);
  }

  return { valid: issues.length === 0, issues, fams, trif };
}

function makeDecision(sig, params) {
  const { valid, issues, fams, trif } = validateSignal(sig, params);
  const conf = describeConfluence(sig.strategies || []);

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
    trifecta: `${trif}/3`,
    confluence: conf,
    reasoning: valid
      ? `✅ Score ${sig.score}, R:R ${sig.rr}:1, Trifecta ${trif}/3. ${conf}. Execute tier-${sig.tier} (${[5, 3.5, 2.5][sig.tier - 1]}%).`
      : `❌ ${issues.join('. ')}`,
    validation: {
      score_check:    `${sig.score} >= ${params.minScore}: ${sig.score >= params.minScore ? 'PASS' : 'FAIL'}`,
      rr_check:       `${sig.rr} >= ${params.minRR}:1: ${sig.rr >= params.minRR ? 'PASS' : 'FAIL'}`,
      trifecta_check: `${trif}/3 families (Trend:${fams.trend.length}, Level:${fams.level.length}, Signal:${fams.signal.length}): ${trif === 3 ? 'FULL' : trif === 2 ? 'PARTIAL' : 'WEAK'}`,
    },
    action: valid ? 'EXECUTE' : 'DO_NOT_EXECUTE'
  };
}

async function runDecisionCycle() {
  const cycleTs = new Date().toISOString();
  const params = loadParams();
  console.log(`\n[${cycleTs}] Decision cycle starting... (minScore=${params.minScore} minRR=${params.minRR} requireTrifecta=${params.requireTrifecta})`);

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
  const decision = makeDecision(topSignal, params);

  console.log(`  ${decision.decision} [${decision.symbol} ${decision.tf}M ${decision.direction}] Trifecta=${decision.trifecta}`);
  console.log(`  Confluence: ${decision.confluence}`);
  console.log(`  Reasoning: ${decision.reasoning.slice(0, 120)}...`);

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
