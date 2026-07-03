/**
 * eod_agent.mjs — Claude-powered EOD parameter optimization agent.
 *
 * Runs at 20:30 UTC Mon-Fri after EOD close. Replaces the static rule engine
 * in review_params.mjs with Claude reasoning over actual trade data.
 *
 * Writes pending_params.json (same format as review_params.mjs for apply_params compatibility).
 * Pass --auto-apply to also call apply_params.mjs automatically.
 *
 * Requires: ANTHROPIC_API_KEY env var
 * Fallback: If API unavailable, falls back to static review_params.mjs rules.
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { analyzePerformance } from './performance_tracker.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const IS_LINUX  = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX
  ? '/home/ubuntu/trading-data'
  : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const REPO_ROOT = IS_LINUX
  ? '/home/ubuntu/tradingview-mcp-jackson'
  : 'C:/Users/Tda-d/tradingview-mcp-jackson';

const TRADES_CSV   = join(DATA_ROOT, 'trade_log', 'trades.csv');
const PARAMS_FILE  = join(DATA_ROOT, 'trading_params.json');
const PENDING_FILE = join(DATA_ROOT, 'pending_params.json');
const REVIEWS_DIR  = join(DATA_ROOT, 'reviews');
const SCANNER_LOG  = join(DATA_ROOT, 'scanner.log');

const LOOKBACK_DAYS = 30;
const MIN_TRADES    = 20;
const AUTO_APPLY    = process.argv.includes('--auto-apply');

function log(msg) {
  // stdout only — cron redirects stdout to eod_agent.log, so appendFileSync would double-write
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

// ── Data loading ─────────────────────────────────────────────────────────────

function loadParams() {
  if (!existsSync(PARAMS_FILE)) {
    return {
      scoreThreshold: 6, stopRuleLosses: 2, riskPct: [5.0, 3.5, 2.5],
      slAtrMult: 1.5, tp1Mult: 1.0, tp2Mult: 2.0, maxConcurrent: 4,
      blockedSessions: [], blockedSymbols: [], blockedSymbolExpiry: {},
    };
  }
  return JSON.parse(readFileSync(PARAMS_FILE, 'utf8'));
}

function parseCsv() {
  if (!existsSync(TRADES_CSV)) return [];
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - LOOKBACK_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  return readFileSync(TRADES_CSV, 'utf8').trim().split('\n').slice(1)
    .filter(l => l.trim() && l >= cutoffStr)
    .map(l => {
      const p = l.split(',');
      return {
        date:    (p[0]  || '').trim(),
        session: (p[1]  || '').trim(),
        symbol:  (p[2]  || '').trim(),
        tf:      (p[3]  || '').trim(),
        dir:     (p[4]  || '').trim(),
        score:   parseFloat(p[5]  || 0) || 0,
        entry:   parseFloat(p[6]  || 0) || 0,
        sl:      parseFloat(p[7]  || 0) || 0,
        tp:      (p[8]  || '').trim(),
        rr:      parseFloat(p[9]  || 0) || 0,
        result:  (p[10] || '').trim(),
        pnl:     parseFloat(p[11] || 0) || 0,
      };
    })
    .filter(t => t.symbol && t.symbol !== 'NONE' && t.result && t.pnl !== 0);
}

// Preferred source: replayed outcomes from edge_replay.mjs (setups re-run against
// real cTrader M5 bars). trades.csv result/pnl are VOID-corrupted, so csv is only
// a loud fallback. pnl here is in R-MULTIPLES, not dollars.
const REPLAY_FILE = join(DATA_ROOT, 'replay_results.json');
const REPLAY_MAX_AGE_H = 24;

function loadReplayTrades() {
  if (!existsSync(REPLAY_FILE)) return null;
  try {
    const rep = JSON.parse(readFileSync(REPLAY_FILE, 'utf8'));
    const ageH = (Date.now() - Date.parse(rep.generated)) / 3600e3;
    if (!isFinite(ageH) || ageH > REPLAY_MAX_AGE_H) return null; // stale — wrapper should have regenerated it
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - LOOKBACK_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const trades = (rep.setups || [])
      .filter(s => s.date >= cutoffStr && isFinite(s.r))
      .map(s => ({
        date: s.date, session: s.session, symbol: s.symbol, tf: '',
        dir: s.dir, score: s.score || 0, entry: 0, sl: 0, tp: '', rr: 0,
        result: s.r > 0 ? 'WIN' : 'LOSS',
        pnl: s.r, // R-multiples
      }));
    return trades.length ? trades : null;
  } catch (_) { return null; }
}

function computeBreakdown(trades, key) {
  const map = {};
  for (const t of trades) {
    const k = t[key] || 'UNKNOWN';
    if (!map[k]) map[k] = { wins: 0, losses: 0, pnl: 0 };
    if (t.pnl > 0) map[k].wins++;
    else map[k].losses++;
    map[k].pnl += t.pnl;
  }
  for (const k of Object.keys(map)) {
    const d = map[k];
    d.total  = d.wins + d.losses;
    d.wr     = d.total > 0 ? Math.round((d.wins / d.total) * 1000) / 10 : 0;
    d.pnl    = Math.round(d.pnl * 100) / 100;
  }
  return map;
}

function recentScannerActivity() {
  if (!existsSync(SCANNER_LOG)) return 'no scanner log';
  try {
    const lines = readFileSync(SCANNER_LOG, 'utf8').split('\n');
    // Last 60 lines — captures recent scan cycles
    return lines.slice(-60).filter(l => l.includes('no setup') || l.includes('Found') || l.includes('→')).slice(-30).join('\n');
  } catch (_) { return 'unreadable'; }
}

function buildSummary(trades, params, source) {
  const overall    = trades.length ? analyzePerformance(trades) : { total: 0, wr: 0, pf: 0, totalPnl: 0 };
  const bySymbol   = computeBreakdown(trades, 'symbol');
  const bySession  = computeBreakdown(trades, 'session');
  const byScore    = computeBreakdown(trades, 'score');

  // Rolling 7-day vs 30-day WR to detect momentum
  const cutoff7 = new Date();
  cutoff7.setUTCDate(cutoff7.getUTCDate() - 7);
  const recent7  = trades.filter(t => t.date >= cutoff7.toISOString().slice(0, 10));
  const perf7    = recent7.length ? analyzePerformance(recent7) : null;

  // Consecutive losses
  let streak = 0;
  for (const t of [...trades].sort((a, b) => b.date.localeCompare(a.date))) {
    if (t.pnl < 0) streak++;
    else break;
  }

  return {
    dataSource: source,
    pnlUnits: source === 'replay' ? 'R-multiples (replayed against real M5 bars)' : 'dollars (VOID-corrupted log — unreliable)',
    currentParams: params,
    overall: {
      trades: overall.total || trades.length,
      winRate: overall.wr,
      profitFactor: overall.pf,
      totalPnl: overall.totalPnl,
    },
    last7Days: perf7 ? { trades: perf7.total, winRate: perf7.wr, pf: perf7.pf } : null,
    currentLossStreak: streak,
    bySymbol,
    bySession,
    byScore,
    scannerRecentActivity: recentScannerActivity(),
  };
}

// ── Claude agent ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the EOD optimization agent for an automated day-trading algorithm.

The system trades CFDs/forex/indices via BlackBull Markets, using TradingView chart analysis.
All positions close at 20:00 UTC — no overnight holds.

INSTRUMENTS: XAUUSD, NAS100, SPX500, US30, GER40, UK100, GBPUSD, EURUSD, USDJPY, GBPJPY, BTCUSD, ETHUSD, WTI, XAGUSD, and others.

STRATEGY FAMILIES:
- TREND: SmartTrail flip (A), EMA stack 20/50/200 (B), Daily trend gate (S), Weekly trend gate (T)
- S&R: ATR-width zones (C), Break-and-retest/Zone flip (M), PDH/PDL levels (U)
- FVG: 3-candle fair value gap (F, +2 fresh / +1 old), Order Block bonus (G)
- T (weekly trend) AND U (PDH/PDL zone) are MANDATORY gates — setups without both are rejected.

TUNABLE PARAMETERS (your job is to recommend changes to these):
- scoreThreshold (int, 4–12): min score to take a trade. Current default 6.
- slAtrMult (float, 1.0–3.0): ATR multiplier for stop-loss.
- tp1Mult / tp2Mult (float): TP R-multiples. Defaults 1.0 / 2.0.
- riskPct (array): [first trade%, second trade%, 3rd+trade%]. Defaults [5.0, 3.5, 2.5].
- blockedSymbols (string array): instruments paused for 30 days.
- blockedSymbolExpiry (object): expiry dates for blocked symbols.
- blockedSessions (string array): sessions paused. Valid names (must match exactly): ASIAN, LONDON, LONDON-NY-OVERLAP, NY.
- blockedSessionExpiry (object): expiry dates for blocked sessions (e.g. {"NY": "2026-08-02"}).
- stopRuleLosses (int, 1–5): consecutive losses before stopping today.

DATA SOURCE — the summary's dataSource field tells you what the pnl numbers mean:
- "replay": pnl values are R-MULTIPLES from replaying each setup against real M5 price
  data (edge_replay.mjs). This is the trustworthy source — reason from it normally.
- "trades.csv": pnl values are dollars from a log whose result/pnl columns are corrupted
  by broker VOIDs. Treat every per-symbol/per-session stat as suspect; recommend changes
  only on overwhelming evidence, and say in your analysis that the source was degraded.

RULES — follow these strictly when making recommendations:
1. Only recommend changes the data justifies. No changes without sufficient trade count.
2. scoreThreshold: raise by 1 if WR < 40% AND total trades ≥ 20. Lower by 1 if WR > 70% AND PF > 2 AND trades ≥ 20. Max 12, min 4.
3. slAtrMult: increase by 0.1–0.2 if PF < 1.2 (stops too tight). Decrease by 0.1 if PF > 2.5. Max 3.0, min 1.0.
4. blockedSymbols: block for 30 days if WR < 30% over 15+ trades for that symbol AND its net outcome is materially negative (worse than -1.5R in replay mode, or a loss exceeding 1% of account equity in dollar mode). Unblock on expiry.
5. blockedSessions: block for 30 days if WR < 35% over 15+ trades for that session AND its net outcome is materially negative (same thresholds as rule 4). Record the expiry in blockedSessionExpiry (same shape as blockedSymbolExpiry) and recommend unblocking when it passes. A handful of small losing trades is noise, not a signal — never block on it.
6. riskPct: DO NOT change. Requires explicit user approval.
7. tp1Mult / tp2Mult: DO NOT change without strong missed-runner evidence.
8. stopRuleLosses: only suggest changing if loss streak shows a clear pattern.
9. If total trades < 20, only unblock expired symbols — do not adjust scoring params.
10. Never recommend parameter changes that would exceed the stated bounds.

Be analytical. Look at momentum (7-day vs 30-day trends), per-symbol patterns, session patterns,
and score-band analysis (do high-score trades outperform low-score ones as expected?).`;

const TOOL_DEF = {
  name: 'submit_recommendations',
  description: 'Submit parameter change recommendations after analysis',
  input_schema: {
    type: 'object',
    required: ['analysis', 'recommendations'],
    properties: {
      analysis: {
        type: 'string',
        description: '2-4 sentence summary of what the data shows and why you are (or are not) recommending changes.',
      },
      recommendations: {
        type: 'array',
        description: 'List of parameter changes. Empty array if no changes needed.',
        items: {
          type: 'object',
          required: ['param', 'current', 'proposed', 'reason', 'confidence'],
          properties: {
            param:      { type: 'string', description: 'Parameter name from trading_params.json' },
            current:    { description: 'Current value' },
            proposed:   { description: 'Proposed new value' },
            reason:     { type: 'string', description: 'One-sentence justification with data' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            condition:  { type: 'string', description: 'Data condition that triggered this (e.g. WR=38% over 25 trades)' },
          },
        },
      },
      risk_flag: {
        type: 'string',
        description: 'Optional warning if current exposure looks dangerous (e.g. loss streak, concentrated risk).',
      },
    },
  },
};

async function runClaudeAgent(trades, params, source) {
  const client  = new Anthropic();
  const summary = buildSummary(trades, params, source);

  const response = await client.messages.create({
    model:       'claude-opus-4-8',
    max_tokens:  2048,
    system:      SYSTEM_PROMPT,
    messages:    [{ role: 'user', content: `Analyze today's trading performance and recommend parameter adjustments:\n\n${JSON.stringify(summary, null, 2)}` }],
    tools:       [TOOL_DEF],
    tool_choice: { type: 'tool', name: 'submit_recommendations' },
  });

  const toolUse = response.content.find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('No tool_use block in Claude response');
  // tool input can come back slightly malformed (missing recommendations array,
  // or values JSON-stringified: '["NY"]' instead of ["NY"]) — normalize hard
  if (!Array.isArray(toolUse.input.recommendations)) toolUse.input.recommendations = [];
  const coerce = v => {
    if (typeof v !== 'string') return v;
    try { const p = JSON.parse(v); return typeof p === 'string' ? v : p; } catch { return v; }
  };
  for (const r of toolUse.input.recommendations) {
    r.current = coerce(r.current);
    r.proposed = coerce(r.proposed);
  }
  return toolUse.input;
}

// ── Static fallback (mirrors review_params.mjs logic) ────────────────────────

function staticFallback(trades, params) {
  const recs = [];
  const today = new Date().toISOString().slice(0, 10);
  const overall = analyzePerformance(trades);

  if (overall.total >= MIN_TRADES) {
    if (overall.wr < 40) {
      const proposed = Math.min(12, (params.scoreThreshold || 6) + 1);
      if (proposed !== params.scoreThreshold)
        recs.push({ param: 'scoreThreshold', current: params.scoreThreshold, proposed, reason: `WR ${overall.wr}% < 40% over ${overall.total} trades`, confidence: 'high', condition: `WR=${overall.wr}%` });
    } else if (overall.wr > 70 && overall.pf > 2) {
      const proposed = Math.max(4, (params.scoreThreshold || 6) - 1);
      if (proposed !== params.scoreThreshold)
        recs.push({ param: 'scoreThreshold', current: params.scoreThreshold, proposed, reason: `WR ${overall.wr}% > 70% + PF ${overall.pf} > 2 over ${overall.total} trades`, confidence: 'medium', condition: `WR=${overall.wr}% PF=${overall.pf}` });
    }
    if (overall.pf < 1.2 && overall.pf > 0) {
      const proposed = Math.round(Math.min(3.0, (params.slAtrMult || 1.5) + 0.1) * 10) / 10;
      if (proposed !== params.slAtrMult)
        recs.push({ param: 'slAtrMult', current: params.slAtrMult, proposed, reason: `PF ${overall.pf} < 1.2 — stops too tight`, confidence: 'medium', condition: `PF=${overall.pf}` });
    }
  }

  const bySymbol = computeBreakdown(trades, 'symbol');
  const blocked  = [...(params.blockedSymbols || [])];
  const expiry   = { ...(params.blockedSymbolExpiry || {}) };

  for (const [sym, d] of Object.entries(bySymbol)) {
    if (d.total >= 5 && d.wr < 30 && !blocked.includes(sym)) {
      const exp = new Date(); exp.setUTCDate(exp.getUTCDate() + 30);
      const expStr = exp.toISOString().slice(0, 10);
      blocked.push(sym); expiry[sym] = expStr;
      recs.push({ param: 'blockedSymbols', current: params.blockedSymbols, proposed: [...blocked], reason: `${sym} WR ${d.wr}% < 30% over ${d.total} trades`, confidence: 'high', condition: `${sym} WR=${d.wr}%` });
      recs.push({ param: 'blockedSymbolExpiry', current: params.blockedSymbolExpiry, proposed: { ...expiry }, reason: `Expiry for ${sym}`, condition: 'companion' });
    }
  }

  const unblocked = (params.blockedSymbols || []).filter(s => (params.blockedSymbolExpiry || {})[s] <= today);
  if (unblocked.length) {
    const newBlocked = blocked.filter(s => !unblocked.includes(s));
    const newExpiry  = { ...expiry }; for (const s of unblocked) delete newExpiry[s];
    recs.push({ param: 'blockedSymbols', current: blocked, proposed: newBlocked, reason: `Unblocking ${unblocked.join(', ')} — 30d cooloff expired`, confidence: 'high', condition: 'expiry reached' });
    recs.push({ param: 'blockedSymbolExpiry', current: expiry, proposed: newExpiry, reason: 'Remove expired entries', condition: 'companion' });
  }

  // Session blocking disabled — losses were caused by missing TP/SL, not bad sessions.
  // Blocking LONDON costs more than it saves. Symbol blocking handles persistent underperformers.

  return { analysis: `Static fallback: WR=${overall.wr}% PF=${overall.pf} over ${overall.total} trades.`, recommendations: recs, risk_flag: null };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log('=== EOD AGENT (Claude-powered) ===');

  if (!process.env.ANTHROPIC_API_KEY) {
    log('⚠  ANTHROPIC_API_KEY not set — running static fallback only');
  }

  const replayTrades = loadReplayTrades();
  const source = replayTrades ? 'replay' : 'trades.csv';
  const trades = replayTrades || parseCsv();
  const params = loadParams();
  if (source === 'trades.csv') {
    log('⚠  replay_results.json missing/stale — falling back to VOID-corrupted trades.csv stats');
  }
  log(`Trades: ${trades.length} (last ${LOOKBACK_DAYS} days, source=${source}) | Params: threshold=${params.scoreThreshold} slMult=${params.slAtrMult}`);

  let result;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      log('Calling Claude claude-opus-4-8 for analysis...');
      result = await runClaudeAgent(trades, params, source);
      log(`Claude analysis: ${result.analysis}`);
      if (result.risk_flag) log(`⚠  Risk flag: ${result.risk_flag}`);
    } catch (err) {
      log(`⚠  Claude API error: ${err.message} — falling back to static rules`);
      result = staticFallback(trades, params);
    }
  } else {
    result = staticFallback(trades, params);
  }

  const overall = trades.length ? analyzePerformance(trades) : { total: 0, wr: 0, pf: 0, totalPnl: 0 };

  const report = {
    generatedAt:     new Date().toISOString(),
    generatedBy:     process.env.ANTHROPIC_API_KEY ? 'eod_agent.mjs (claude-opus-4-8)' : 'eod_agent.mjs (static fallback)',
    dataSource:      source,
    analysisWindow:  `last ${LOOKBACK_DAYS} days`,
    tradeCount:      trades.length,
    overall:         overall.total ? { wr: overall.wr, pf: overall.pf, totalPnl: overall.totalPnl } : 'insufficient data',
    analysisSummary: result.analysis,
    riskFlag:        result.risk_flag || null,
    recommendations: result.recommendations,
    noChanges:       result.recommendations.length === 0,
    applyCommand:    'node scripts/trading/apply_params.mjs --apply',
    previewCommand:  'node scripts/trading/apply_params.mjs --preview',
  };

  mkdirSync(REVIEWS_DIR, { recursive: true });
  writeFileSync(PENDING_FILE, JSON.stringify(report, null, 2), 'utf8');
  log(`Wrote → ${PENDING_FILE}`);

  if (result.recommendations.length === 0) {
    log('✓ No parameter changes recommended.');
  } else {
    log(`⚠  ${result.recommendations.length} recommendation(s):`);
    for (const r of result.recommendations) {
      log(`  → ${r.param}: ${JSON.stringify(r.current)} → ${JSON.stringify(r.proposed)} [${r.confidence}]`);
      log(`    ${r.reason}`);
    }
  }

  if (AUTO_APPLY && result.recommendations.length > 0) {
    log('Auto-applying recommendations...');
    try {
      execSync(`node scripts/trading/apply_params.mjs --apply`, { cwd: REPO_ROOT, stdio: 'inherit' });
      log('✓ Params applied.');
    } catch (err) {
      log(`✗ apply_params.mjs failed: ${err.message}`);
    }
  } else if (!AUTO_APPLY && result.recommendations.length > 0) {
    log(`To apply: node scripts/trading/apply_params.mjs --apply`);
  }

  log('=== EOD AGENT COMPLETE ===');
}

main().catch(err => { log(`FATAL: ${err.stack}`); process.exit(1); });
