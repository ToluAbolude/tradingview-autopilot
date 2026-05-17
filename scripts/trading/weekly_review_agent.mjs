/**
 * weekly_review_agent.mjs — Self-improving trading system
 *
 * Runs every Saturday 00:00 UTC. Full loop:
 *   1. Backtest last week using the LIVE scoring engine (runAllStrategies)
 *   2. Detect MISSED trades — big moves the scanner ignored, and why
 *   3. Detect AVOIDABLE losses — patterns shared by all losing trades
 *   4. Send everything to Claude Opus with scanner_config.json + previous week's changes
 *   5. Claude outputs: narrative analysis + JSON config patch
 *   6. Agent validates + applies the patch to scanner_config.json
 *   7. Restarts the live scanner so changes take effect immediately
 *
 * Goal: more trades, bigger profits, fewer losses, lower drawdown — every week.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

import {
  setChart,
  getBars,
  runAllStrategies,
  FULL_SCAN_LIST,
} from './setup_finder.mjs';

const __dir    = dirname(fileURLToPath(import.meta.url));
const IS_LINUX = os.platform() === 'linux';
const REPO_ROOT  = IS_LINUX ? '/home/ubuntu/tradingview-mcp-jackson' : join(__dir, '../..');
const DATA_ROOT  = IS_LINUX ? '/home/ubuntu/trading-data' : join(REPO_ROOT, 'data');
const CONFIG_FILE  = join(REPO_ROOT, 'scanner_config.json');
const REVIEW_DIR   = join(DATA_ROOT, 'weekly_reviews');
const SCANNER_LOG  = join(DATA_ROOT, 'weekly_review.log');

if (!existsSync(REVIEW_DIR)) mkdirSync(REVIEW_DIR, { recursive: true });

// ── ATR helper (standalone, no import dependency) ─────────────────────────────
function atrAt(bars, i, len = 14) {
  let val = bars[0].h - bars[0].l;
  for (let k = 1; k <= Math.min(i, bars.length - 1); k++) {
    const tr = Math.max(bars[k].h - bars[k].l,
      Math.abs(bars[k].h - bars[k-1].c), Math.abs(bars[k].l - bars[k-1].c));
    val = k < len ? tr : (val * (len - 1) + tr) / len;
  }
  return val;
}

// ── Auto date window: last Mon 00:00 UTC → Fri 22:00 UTC ─────────────────────
function lastWeekWindow() {
  const now = new Date();
  const fri = new Date(now);
  fri.setUTCHours(22, 0, 0, 0);
  fri.setUTCDate(fri.getUTCDate() - 1);
  const mon = new Date(fri);
  mon.setUTCHours(0, 0, 0, 0);
  mon.setUTCDate(mon.getUTCDate() - 4);
  return {
    start: Math.floor(mon.getTime() / 1000),
    end:   Math.floor(fri.getTime() / 1000),
    label: `${mon.toISOString().slice(0,10)} → ${fri.toISOString().slice(0,10)}`,
  };
}

// ── Simulate trade outcome from entry bar ────────────────────────────────────
// Uses ATR-based SL/TP matching live scanner defaults
function tradeOutcome(bars, entryIdx, dir, slMult = 0.6, tpMult = 1.5) {
  const atr   = atrAt(bars, entryIdx);
  const entry = bars[entryIdx].c;
  const sl    = dir === 'long' ? entry - atr * slMult : entry + atr * slMult;
  const tp    = dir === 'long' ? entry + atr * tpMult : entry - atr * tpMult;
  const max   = Math.min(bars.length - entryIdx - 1, 96);

  for (let k = 1; k <= max; k++) {
    const b = bars[entryIdx + k];
    if (!b) break;
    if (dir === 'long'  ? b.h >= tp : b.l <= tp) return { result: 'WIN',  bars: k };
    if (dir === 'long'  ? b.l <= sl : b.h >= sl) return { result: 'LOSS', bars: k };
  }
  return { result: 'OPEN', bars: max };
}

// ── Detect missed trades: big directional move with no signal fired ────────────
// A "missed trade" = price moved ≥ 1.5×ATR within 24 bars but score was below threshold
function detectMissed(bars, weekStart, weekEnd, threshold) {
  const missed = [];
  for (let i = 80; i < bars.length - 25; i++) {
    if (bars[i].t < weekStart || bars[i].t > weekEnd) continue;
    const atr = atrAt(bars, i);
    const fwd24H = Math.max(...bars.slice(i+1, i+25).map(b => b.h));
    const fwd24L = Math.min(...bars.slice(i+1, i+25).map(b => b.l));
    const bullMove = fwd24H - bars[i].c;
    const bearMove = bars[i].c - fwd24L;

    for (const dir of ['long', 'short']) {
      const move = dir === 'long' ? bullMove : bearMove;
      if (move < atr * 1.5) continue;  // not a meaningful move

      const utcHour = new Date(bars[i].t * 1000).getUTCHours();
      // We don't have inst.label here — pass empty string (scoring logic doesn't need it for EMA gate)
      const { score, strategies } = runAllStrategies(bars.slice(0, i + 1), dir, utcHour, '', '15');
      if (score >= threshold && strategies.includes('T')) continue;  // scanner would have caught it

      missed.push({
        ts:       new Date(bars[i].t * 1000).toISOString().slice(0, 16),
        dir,
        score,
        strategies: strategies.join(''),
        moveAtr:  +(move / atr).toFixed(1),
        missingBy: threshold - score,
      });
    }
  }
  return missed;
}

// ── Full backtest loop ────────────────────────────────────────────────────────
async function runBacktest(window, config) {
  const threshold = config?.thresholds?.pass1_min_score ?? 6;
  const trades    = [];   // { label, tf, dir, score, strategies, result, bars, utcHour }
  const missed    = [];   // near-miss setups per instrument

  const REVIEW_TFS = ['15', '60', '240'];

  for (const inst of FULL_SCAN_LIST) {
    for (const tf of REVIEW_TFS) {
      process.stdout.write(`  ${inst.label}/${tf}M `);
      await setChart(inst.sym, tf);
      const bars = await getBars(500);
      if (!bars || bars.length < 80) { process.stdout.write('?\n'); continue; }

      const dirs = ['long', ...(inst.autoShort ? ['short'] : [])];

      // Fired signals
      for (let i = 80; i < bars.length - 10; i++) {
        if (bars[i].t < window.start || bars[i].t > window.end) continue;
        const utcHour = new Date(bars[i].t * 1000).getUTCHours();
        for (const dir of dirs) {
          const { score, strategies } = runAllStrategies(bars.slice(0, i + 1), dir, utcHour, inst.label, tf);
          if (score < threshold || !strategies.includes('T')) continue;
          const outcome = tradeOutcome(bars, i, dir);
          trades.push({ label: inst.label, tier: inst.tier, tf, dir, score, strategies: strategies.join(''), result: outcome.result, bars: outcome.bars, utcHour });
        }
      }

      // Missed trades on 15M only (main entry TF)
      if (tf === '15') {
        const m = detectMissed(bars, window.start, window.end, threshold);
        for (const x of m) missed.push({ label: inst.label, ...x });
      }

      process.stdout.write('\n');
    }
  }

  return { trades, missed };
}

// ── Build analysis tables for Claude ────────────────────────────────────────
function buildAnalysis(trades, missed) {
  const completed = trades.filter(t => t.result !== 'OPEN');

  // Win rate by instrument+TF
  const byKey = {};
  for (const t of completed) {
    const k = `${t.label}/${t.tf}M`;
    if (!byKey[k]) byKey[k] = { wins:0, losses:0, bars:0, tier: t.tier };
    if (t.result === 'WIN') { byKey[k].wins++; byKey[k].bars += t.bars; }
    else byKey[k].losses++;
  }
  const instTable = Object.entries(byKey)
    .map(([k, s]) => {
      const tot = s.wins + s.losses;
      const wr  = tot > 0 ? Math.round(s.wins/tot*100) : 0;
      const avg = s.wins > 0 ? Math.round(s.bars/s.wins) : '-';
      return `${k.padEnd(14)} T${s.tier} | ${tot} trades | WR:${wr}% | avgWinDur:${avg}bars`;
    })
    .sort()
    .join('\n');

  // Win rate by strategy combo
  const byStrat = {};
  for (const t of completed) {
    const k = t.strategies || 'none';
    if (!byStrat[k]) byStrat[k] = { wins:0, losses:0 };
    if (t.result === 'WIN') byStrat[k].wins++; else byStrat[k].losses++;
  }
  const stratTable = Object.entries(byStrat)
    .map(([k, s]) => {
      const tot = s.wins + s.losses;
      const wr  = tot > 0 ? Math.round(s.wins/tot*100) : 0;
      return `${k.padEnd(8)} | ${tot} trades | WR:${wr}%`;
    })
    .filter(r => { const [,v] = r.split('|'); return parseInt(v) >= 2; })
    .sort((a, b) => {
      const wrA = parseInt(a.split('WR:')[1]);
      const wrB = parseInt(b.split('WR:')[1]);
      return wrB - wrA;
    })
    .join('\n');

  // Win rate by raw score
  const byScore = {};
  for (const t of completed) {
    const k = `score_${t.score}`;
    if (!byScore[k]) byScore[k] = { wins:0, losses:0 };
    if (t.result === 'WIN') byScore[k].wins++; else byScore[k].losses++;
  }
  const scoreTable = Object.entries(byScore)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, s]) => {
      const tot = s.wins + s.losses;
      const wr  = tot > 0 ? Math.round(s.wins/tot*100) : 0;
      return `${k.padEnd(10)} | ${tot} | WR:${wr}%`;
    }).join('\n');

  // Win rate by UTC session
  const bySession = {};
  for (const t of completed) {
    const session = t.utcHour < 7 ? 'Asian(0-7)' : t.utcHour < 13 ? 'London(8-13)' : t.utcHour < 17 ? 'Overlap(13-17)' : 'NY(17-22)';
    if (!bySession[session]) bySession[session] = { wins:0, losses:0 };
    if (t.result === 'WIN') bySession[session].wins++; else bySession[session].losses++;
  }
  const sessionTable = Object.entries(bySession)
    .map(([k, s]) => {
      const tot = s.wins + s.losses;
      const wr  = tot > 0 ? Math.round(s.wins/tot*100) : 0;
      return `${k.padEnd(16)} | ${tot} | WR:${wr}%`;
    }).join('\n');

  // Losing trade patterns
  const losers = completed.filter(t => t.result === 'LOSS');
  const loserStratFreq = {};
  for (const t of losers) {
    for (const s of t.strategies) {
      loserStratFreq[s] = (loserStratFreq[s] || 0) + 1;
    }
  }

  // Missed trade summary
  const missedByGap = {};
  for (const m of missed) {
    const k = `gap_${m.missingBy}`;
    if (!missedByGap[k]) missedByGap[k] = { count:0, examples:[] };
    missedByGap[k].count++;
    if (missedByGap[k].examples.length < 3) missedByGap[k].examples.push(`${m.label} ${m.dir} ${m.ts} score=${m.score} strats=${m.strategies} move=${m.moveAtr}xATR`);
  }
  const missedTable = Object.entries(missedByGap)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}: ${v.count} missed\n    e.g. ${v.examples.join('\n    e.g. ')}`)
    .join('\n');

  const long  = completed.filter(t => t.dir === 'long');
  const short = completed.filter(t => t.dir === 'short');

  return {
    totalSignals: trades.length,
    totalCompleted: completed.length,
    totalMissed: missed.length,
    longWR:  long.length  ? Math.round(long.filter(t=>t.result==='WIN').length/long.length*100) : 0,
    shortWR: short.length ? Math.round(short.filter(t=>t.result==='WIN').length/short.length*100) : 0,
    longCount: long.length, shortCount: short.length,
    instTable, stratTable, scoreTable, sessionTable,
    missedTable,
    loserStratFreq,
    loserCount: losers.length,
  };
}

// ── Claude API: deep analysis + config patch ──────────────────────────────────
async function runClaudeAnalysis(window, analysis, currentConfig, rawTrades) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const systemPrompt = `You are the trading algorithm's self-improvement engine. You have one job: make it more profitable every week.

Your guiding principle: GREEDY and EFFICIENT.
- More trades per day = more compounded profit
- Shorter winning trade duration = capital freed faster
- Higher win rate = less drawdown, more confidence to size up
- Bigger R:R on winners = one win covers multiple losses

You control the scoring engine via scanner_config.json. The system runs live 24/5. Changes you make this week get backtested again next week — you will see the results of every decision you make.

THE SCORING SYSTEM (current values shown in config):
  A = SmartTrail direction (+A_smarttrail pts)
  C = S/R wick-to-body zone (+C_sr_fresh fresh, +C_sr_retested retested)
  T = Weekly trend EMA alignment (+T_weekly_trend, REQUIRED gate — must be present)
  U = PDH/PDL daily zone (+U_pdh_pdl)
  F = Fair Value Gap 3-candle imbalance (+F_fvg_fresh fresh+unmitigated, +F_fvg_other otherwise)
  Bias penalty: -bias_penalty if daily bias is counter-trade direction

Pass-1 threshold: any TF must score ≥ pass1_min_score with T present to become a candidate.
MTF bonus: added to candidate's score based on how many TFs agreed (weight sum).
Final: must also have 15M aligned (SmartTrail or T) and R:R ≥ rr_min.

WHAT YOU CAN CHANGE (in scanner_config.json):
  scoring.*          — point values for each strategy signal
  thresholds.pass1_min_score — how strict the entry bar is
  thresholds.ema_flat_pct    — ranging market gate (higher = filter more ranging markets)
  thresholds.rr_min          — minimum risk:reward ratio required
  mtf_bonus                  — tier thresholds and bonus values for multi-TF confluence
  tf_weights                 — how much each timeframe contributes to MTF weight
  inst_profiles.*            — per-instrument SL (maxSlAtr/minSlAtr) and TP (tpCap/tp3Cap)

CONSTRAINTS:
  - Never set any scoring value below 0
  - pass1_min_score must be between 4 and 8
  - maxSlAtr must not exceed 1.0 (catastrophic losses)
  - tpCap must be ≥ 0.5 (need room to profit)
  - rr_min must be ≥ 1.5

YOUR OUTPUT FORMAT — you MUST follow this exactly:

First write your analysis under these headings:
## WHAT WORKED
## WHAT FAILED
## MISSED TRADES ROOT CAUSE
## AVOIDABLE LOSSES ROOT CAUSE
## NEXT WEEK CHANGES

Then output exactly one JSON block (no other JSON in your response):
\`\`\`json
{
  "scoring": { ...only keys you want to change... },
  "thresholds": { ...only keys you want to change... },
  "mtf_bonus": [ ...full array if changing, omit if not... ],
  "tf_weights": { ...only keys you want to change... },
  "inst_profiles": { ...only instruments you want to change... },
  "change_summary": "one sentence explaining what you changed and why"
}
\`\`\`

Only include keys you are actually changing. Omit everything you are keeping the same.`;

  const configStr   = JSON.stringify(currentConfig, null, 2);
  const tradeSample = rawTrades
    .filter(t => t.result !== 'OPEN')
    .slice(0, 100)
    .map(t => `${t.ts||''} ${t.label}/${t.tf}M ${t.dir.toUpperCase()} score=${t.score} strats=${t.strategies} → ${t.result} in ${t.bars}bars`)
    .join('\n');

  const prevChanges = (currentConfig.change_history || []).slice(0, 4)
    .map(h => `${h.date}: ${h.summary} (prev WR: ${h.wr_before}% → ${h.wr_after || '?'}%)`)
    .join('\n') || 'No previous changes (first run).';

  const userMsg = `WEEK: ${window.label}

CURRENT SCANNER CONFIG:
${configStr}

PREVIOUS WEEKLY CHANGES (what was tried and what happened):
${prevChanges}

BACKTEST RESULTS THIS WEEK:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total signals fired:  ${analysis.totalSignals}
Completed trades:     ${analysis.totalCompleted}  (OPEN positions excluded)
Longs:  WR ${analysis.longWR}%  (${analysis.longCount} trades)
Shorts: WR ${analysis.shortWR}% (${analysis.shortCount} trades)

INSTRUMENT × TIMEFRAME (sorted by key):
${analysis.instTable || '(no data)'}

STRATEGY COMBINATION WIN RATES:
(A=SmartTrail C=S/R T=WeeklyTrend U=PDH/PDL F=FVG)
${analysis.stratTable || '(no data)'}

WIN RATE BY SIGNAL SCORE:
${analysis.scoreTable || '(no data)'}

WIN RATE BY SESSION (UTC):
${analysis.sessionTable || '(no data)'}

LOSING TRADE STRATEGY FREQUENCY (which strategies were present on losing trades):
${JSON.stringify(analysis.loserStratFreq)}
Total losers: ${analysis.loserCount}

MISSED TRADES (big moves ≥1.5×ATR that the scanner did NOT signal, grouped by how many points short):
${analysis.missedTable || '(no missed trades detected)'}
Total missed: ${analysis.totalMissed}

INDIVIDUAL TRADE SAMPLE (first 100 completed):
${tradeSample || '(no completed trades)'}

Now give me your full analysis and the JSON config patch.`;

  console.log('\n  Calling Claude Opus for deep analysis...');

  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 5000,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMsg }],
  });

  return response.content[0].text;
}

// ── Parse and validate Claude's JSON patch ────────────────────────────────────
function parseConfigPatch(claudeText) {
  const match = claudeText.match(/```json\s*([\s\S]*?)\s*```/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch(e) {
    console.error('  Failed to parse Claude JSON patch:', e.message);
    return null;
  }
}

function validatePatch(patch) {
  const errors = [];
  if (patch.scoring) {
    for (const [k, v] of Object.entries(patch.scoring)) {
      if (typeof v !== 'number' || v < 0) errors.push(`scoring.${k} must be ≥ 0 (got ${v})`);
    }
  }
  if (patch.thresholds) {
    const { pass1_min_score, ema_flat_pct, rr_min } = patch.thresholds;
    if (pass1_min_score !== undefined && (pass1_min_score < 4 || pass1_min_score > 8))
      errors.push(`pass1_min_score must be 4-8 (got ${pass1_min_score})`);
    if (rr_min !== undefined && rr_min < 1.5)
      errors.push(`rr_min must be ≥ 1.5 (got ${rr_min})`);
  }
  if (patch.inst_profiles) {
    for (const [inst, p] of Object.entries(patch.inst_profiles)) {
      if (p.maxSlAtr !== undefined && p.maxSlAtr > 1.0)
        errors.push(`${inst}.maxSlAtr must be ≤ 1.0 (got ${p.maxSlAtr})`);
      if (p.tpCap !== undefined && p.tpCap < 0.5)
        errors.push(`${inst}.tpCap must be ≥ 0.5 (got ${p.tpCap})`);
    }
  }
  return errors;
}

// ── Apply patch to config ─────────────────────────────────────────────────────
function applyPatch(config, patch, weekLabel, wrBefore) {
  const updated = JSON.parse(JSON.stringify(config));

  if (patch.scoring)       Object.assign(updated.scoring, patch.scoring);
  if (patch.thresholds)    Object.assign(updated.thresholds, patch.thresholds);
  if (patch.mtf_bonus)     updated.mtf_bonus = patch.mtf_bonus;
  if (patch.tf_weights)    Object.assign(updated.tf_weights, patch.tf_weights);
  if (patch.inst_profiles) {
    for (const [inst, p] of Object.entries(patch.inst_profiles)) {
      if (updated.inst_profiles[inst]) Object.assign(updated.inst_profiles[inst], p);
      else updated.inst_profiles[inst] = p;
    }
  }

  updated.version   = (config.version || 1) + 1;
  updated.updated   = new Date().toISOString().slice(0, 10);
  updated.notes     = 'Auto-updated weekly by weekly_review_agent.mjs';

  updated.change_history = [
    {
      date:      updated.updated,
      week:      weekLabel,
      summary:   patch.change_summary || 'No summary provided',
      wr_before: wrBefore,
      wr_after:  null,  // filled in next week
      patch:     patch,
    },
    ...(config.change_history || []).slice(0, 7),  // keep last 8 weeks
  ];

  return updated;
}

// ── Restart scanner process on VM ─────────────────────────────────────────────
function restartScanner() {
  if (!IS_LINUX) { console.log('  [local] Skipping scanner restart (not on VM)'); return; }
  try {
    execSync(`tmux send-keys -t tradingview C-c '' && sleep 2 && tmux send-keys -t tradingview 'DISPLAY=:1 node ${REPO_ROOT}/scripts/trading/market_scanner.mjs' Enter`);
    console.log('  Scanner restarted with new config.');
  } catch(e) {
    console.error('  Failed to restart scanner:', e.message);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
const window_  = lastWeekWindow();
const dateTag  = new Date().toISOString().slice(0, 10);
const outFile  = join(REVIEW_DIR, `review_${dateTag}.txt`);

console.log('\n══════════════════════════════════════════════════════════');
console.log('  Weekly Review Agent — Self-Improving Trading System');
console.log(`  Week: ${window_.label}`);
console.log(`  Config: ${CONFIG_FILE}`);
console.log('══════════════════════════════════════════════════════════\n');

let currentConfig = {};
try { currentConfig = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); }
catch(_) { console.log('  No existing config — using defaults.'); }

let report = `WEEKLY REVIEW AGENT — ${window_.label}\nGenerated: ${new Date().toISOString()}\n\n`;

try {
  // 1. Backtest
  console.log('  Running backtest...');
  const { trades, missed } = await runBacktest(window_, currentConfig);

  // 2. Analyse
  const analysis = buildAnalysis(trades, missed);
  const combinedWR = analysis.totalCompleted > 0
    ? Math.round((analysis.longWR * analysis.longCount + analysis.shortWR * analysis.shortCount) / analysis.totalCompleted)
    : 0;

  report += `BACKTEST SUMMARY\n${'═'.repeat(55)}\n`;
  report += `Signals: ${analysis.totalSignals} | Completed: ${analysis.totalCompleted} | Missed: ${analysis.totalMissed}\n`;
  report += `Long WR: ${analysis.longWR}% (${analysis.longCount}) | Short WR: ${analysis.shortWR}% (${analysis.shortCount})\n`;
  report += `Combined WR: ${combinedWR}%\n\n`;
  report += `INSTRUMENT BREAKDOWN\n${analysis.instTable}\n\n`;
  report += `STRATEGY COMBOS\n${analysis.stratTable}\n\n`;
  report += `SCORE ANALYSIS\n${analysis.scoreTable}\n\n`;
  report += `SESSION ANALYSIS\n${analysis.sessionTable}\n\n`;
  report += `MISSED TRADES\n${analysis.missedTable}\n\n`;

  // Save raw data
  const rawFile = join(REVIEW_DIR, `raw_${dateTag}.json`);
  writeFileSync(rawFile, JSON.stringify({ window: window_, analysis, trades, missed }, null, 2));
  console.log(`  Raw data → ${rawFile}`);

  // 3. Claude deep analysis
  const claudeText = await runClaudeAnalysis(window_, analysis, currentConfig, trades);
  report += `\nCLAUDE ANALYSIS\n${'═'.repeat(55)}\n${claudeText}\n`;
  console.log('\n' + '═'.repeat(60) + '\n' + claudeText + '\n' + '═'.repeat(60));

  // 4. Parse + validate + apply patch
  const patch = parseConfigPatch(claudeText);
  if (patch) {
    const errors = validatePatch(patch);
    if (errors.length > 0) {
      report += `\nCONFIG PATCH REJECTED — validation errors:\n${errors.join('\n')}\n`;
      console.log(`\n  Config patch rejected:\n  ${errors.join('\n  ')}`);
    } else {
      const newConfig = applyPatch(currentConfig, patch, window_.label, combinedWR);
      writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2));
      report += `\nCONFIG UPDATED — v${newConfig.version}\n`;
      report += `Changes: ${patch.change_summary}\n`;
      console.log(`\n  Config updated to v${newConfig.version}: ${patch.change_summary}`);

      // 5. Restart scanner
      restartScanner();
    }
  } else {
    report += '\nNo config patch found in Claude output — config unchanged.\n';
    console.log('\n  No config patch found — config unchanged.');
  }

} catch(err) {
  report += `\nERROR: ${err.message}\n${err.stack}\n`;
  console.error('Weekly review agent error:', err);
}

writeFileSync(outFile, report);
console.log(`\n  Report → ${outFile}`);
console.log('  Weekly review complete.\n');
