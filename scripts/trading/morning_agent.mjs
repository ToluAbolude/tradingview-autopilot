/**
 * morning_agent.mjs — Claude-powered morning session prep agent.
 *
 * Runs at 08:45 UTC Mon-Fri before the London open scan.
 * Reads overnight signals + recent scanner activity, calls Claude to:
 *   - Set a daily session bias (LONG / SHORT / NEUTRAL)
 *   - Flag any instruments to avoid today (high-impact news, poor recent behaviour)
 *   - Optionally tighten/loosen score threshold for today only
 *
 * Writes: trading-data/daily_context/YYYY-MM-DD.json
 * Consumed by: session_runner.mjs at startup
 *
 * Requires: ANTHROPIC_API_KEY env var
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

const IS_LINUX  = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX
  ? '/home/ubuntu/trading-data'
  : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';

const SIGNALS_FILE   = join(DATA_ROOT, 'live_signals.json');
const PARAMS_FILE    = join(DATA_ROOT, 'trading_params.json');
const SCANNER_LOG    = join(DATA_ROOT, 'scanner.log');
const CONTEXT_DIR    = join(DATA_ROOT, 'daily_context');
const AGENT_LOG      = join(DATA_ROOT, 'morning_agent.log');

const TODAY = new Date().toISOString().slice(0, 10);
const CONTEXT_FILE = join(CONTEXT_DIR, `${TODAY}.json`);

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { appendFileSync(AGENT_LOG, line); } catch (_) {}
}

// ── Data collection ───────────────────────────────────────────────────────────

function loadSignalsHistory(maxItems = 30) {
  if (!existsSync(SIGNALS_FILE)) return [];
  try {
    const data = JSON.parse(readFileSync(SIGNALS_FILE, 'utf8'));
    const history = (data.history || []).slice(-maxItems);
    // Return compact form — avoid sending full nested objects to Claude
    return history.map(s => ({
      ts:         s.ts,
      label:      s.label,
      tf:         s.tf,
      dir:        s.dir,
      score:      s.score,
      strategies: s.strategies,
      rr:         s.rr,
      status:     s.status,
    }));
  } catch (_) { return []; }
}

function loadParams() {
  if (!existsSync(PARAMS_FILE)) return null;
  try { return JSON.parse(readFileSync(PARAMS_FILE, 'utf8')); } catch (_) { return null; }
}

function recentScannerLines(n = 80) {
  if (!existsSync(SCANNER_LOG)) return 'no scanner log';
  try {
    const lines = readFileSync(SCANNER_LOG, 'utf8').split('\n');
    return lines.slice(-n).join('\n');
  } catch (_) { return 'unreadable'; }
}

// ── Claude agent ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the morning prep agent for an automated day-trading algorithm.

Your job: analyze overnight signal history and recent scan activity, then output a daily trading context
that the live scanner will read before each session.

The system trades CFDs/forex/indices on BlackBull Markets via TradingView. All positions close 20:00 UTC.

SESSIONS (UTC times):
- ASIAN:    00:00 – 09:00
- LONDON:   07:00 – 16:00  ← primary session
- NEWYORK:  12:00 – 20:00  ← primary session
- OVERLAP:  13:00 – 16:00  ← highest liquidity

INSTRUMENTS: XAUUSD (gold), NAS100, SPX500, US30 (Dow), GER40 (DAX), UK100 (FTSE),
GBPUSD, EURUSD, USDJPY, GBPJPY, BTCUSD, ETHUSD, WTI (oil), XAGUSD (silver).

STRATEGY GATES: Weekly trend (T) + PDH/PDL zone (U) are MANDATORY for any setup.

WHAT YOU OUTPUT:
- session_bias: overall market lean today (LONG / SHORT / NEUTRAL / SKIP_TODAY)
- skip_today: true only for clear skip conditions (major macro event risk, cascading losses, etc.)
- skip_reason: explain if skip_today is true
- score_threshold_override: integer or null (null = use trading_params.json value)
  Use this to tighten (raise by 1) if recent signals have been low quality,
  or loosen (lower by 1) if setups are rare and quality has been high.
  Only override if you have clear evidence. Most days: null.
- instruments_to_focus: top 3 instruments showing best alignment (per scanner data)
- instruments_to_avoid_today: instruments to skip today only (e.g. major news event, erratic recent behaviour)
- market_notes: 2-3 sentences on overall market context, what to watch for

RULES:
1. Don't skip sessions just because there were no recent signals — that's normal.
2. Only set skip_today=true for genuine risk-off events (e.g. major macro surprise, 3+ loss streak today).
3. score_threshold_override should be null in the majority of cases.
4. instruments_to_avoid_today is for TODAY only — do not add instruments to the permanent blocklist.
5. Be concise and data-driven. Base everything on what the scanner data shows.`;

const TOOL_DEF = {
  name: 'submit_daily_context',
  description: 'Submit the daily trading context for today',
  input_schema: {
    type: 'object',
    required: ['session_bias', 'skip_today', 'instruments_to_focus', 'instruments_to_avoid_today', 'market_notes'],
    properties: {
      session_bias:              { type: 'string', enum: ['LONG', 'SHORT', 'NEUTRAL', 'SKIP_TODAY'] },
      skip_today:                { type: 'boolean' },
      skip_reason:               { type: 'string' },
      score_threshold_override:  { type: ['integer', 'null'] },
      instruments_to_focus:      { type: 'array', items: { type: 'string' }, maxItems: 5 },
      instruments_to_avoid_today:{ type: 'array', items: { type: 'string' } },
      market_notes:              { type: 'string' },
    },
  },
};

async function runClaudeAgent(signals, params, scannerLines) {
  const client = new Anthropic();

  const userMsg = `Today is ${TODAY} (UTC). Here is the overnight signal history and recent scanner activity.

RECENT SIGNALS (last 30):
${JSON.stringify(signals, null, 2)}

CURRENT PARAMS:
${JSON.stringify(params, null, 2)}

RECENT SCANNER LOG (last 80 lines):
${scannerLines}

Based on this, output today's trading context using the submit_daily_context tool.`;

  const response = await client.messages.create({
    model:       'claude-haiku-4-5-20251001',
    max_tokens:  1024,
    system:      SYSTEM_PROMPT,
    messages:    [{ role: 'user', content: userMsg }],
    tools:       [TOOL_DEF],
    tool_choice: { type: 'tool', name: 'submit_daily_context' },
  });

  const toolUse = response.content.find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('No tool_use block in Claude response');
  return toolUse.input;
}

// ── Static fallback ───────────────────────────────────────────────────────────

function staticFallback() {
  return {
    session_bias:               'NEUTRAL',
    skip_today:                 false,
    skip_reason:                null,
    score_threshold_override:   null,
    instruments_to_focus:       [],
    instruments_to_avoid_today: [],
    market_notes:               'Static fallback (no API key). Using default params.',
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log(`=== MORNING AGENT ${TODAY} ===`);

  if (!process.env.ANTHROPIC_API_KEY) {
    log('⚠  ANTHROPIC_API_KEY not set — writing neutral fallback context');
  }

  mkdirSync(CONTEXT_DIR, { recursive: true });

  const signals     = loadSignalsHistory();
  const params      = loadParams();
  const scannerLines = recentScannerLines();

  log(`Signals history: ${signals.length} entries | Params loaded: ${!!params}`);

  let ctx;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      log('Calling Claude Haiku for morning context...');
      ctx = await runClaudeAgent(signals, params, scannerLines);
    } catch (err) {
      log(`⚠  Claude API error: ${err.message} — using static fallback`);
      ctx = staticFallback();
    }
  } else {
    ctx = staticFallback();
  }

  const output = {
    date:               TODAY,
    generatedAt:        new Date().toISOString(),
    generatedBy:        process.env.ANTHROPIC_API_KEY ? 'morning_agent.mjs (claude-haiku-4-5-20251001)' : 'morning_agent.mjs (static fallback)',
    session_bias:               ctx.session_bias,
    skip_today:                 ctx.skip_today || false,
    skip_reason:                ctx.skip_reason || null,
    score_threshold_override:   ctx.score_threshold_override ?? null,
    instruments_to_focus:       ctx.instruments_to_focus || [],
    instruments_to_avoid_today: ctx.instruments_to_avoid_today || [],
    market_notes:               ctx.market_notes || '',
  };

  writeFileSync(CONTEXT_FILE, JSON.stringify(output, null, 2), 'utf8');
  log(`Wrote → ${CONTEXT_FILE}`);

  log(`Bias: ${output.session_bias} | Skip: ${output.skip_today} | Threshold override: ${output.score_threshold_override ?? 'none'}`);
  if (output.instruments_to_focus.length)       log(`Focus: ${output.instruments_to_focus.join(', ')}`);
  if (output.instruments_to_avoid_today.length) log(`Avoid today: ${output.instruments_to_avoid_today.join(', ')}`);
  log(`Notes: ${output.market_notes}`);

  log('=== MORNING AGENT COMPLETE ===');
}

main().catch(err => { log(`FATAL: ${err.stack}`); process.exit(1); });
