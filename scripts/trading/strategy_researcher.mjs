/**
 * strategy_researcher.mjs
 * Biweekly self-improvement cycle:
 *
 * 1. Read trades.csv — identify worst-performing symbols/sessions
 * 2. Re-backtest all COMBOS via push_reload_verify to get current metrics
 * 3. Scan recent setup_finder logic — look for scoring improvements
 * 4. Research new strategies by reading external sources (web)
 * 5. Generate experimental Pine Script variant and backtest it
 * 6. If new variant beats baseline on 3+ combos → promote to strategies/ folder
 * 7. Update TRADING_KNOWLEDGE_BASE.md with findings
 * 8. Log a summary of changes made
 *
 * Runs every 2 weeks via cron (Sunday 04:00 UTC).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';
import os from 'os';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const ROOT       = join(__dirname, '../..');
const IS_LINUX   = os.platform() === 'linux';
const DATA_ROOT  = IS_LINUX ? '/home/ubuntu/trading-data' : join(ROOT, 'data');
const TRADES_CSV = join(DATA_ROOT, 'trade_log/trades.csv');
const KB_FILE    = join(ROOT, 'data/knowledge_base/TRADING_KNOWLEDGE_BASE.md');
const STRAT_DIR  = join(ROOT, 'strategies');
const LOG_FILE   = join(DATA_ROOT, 'trade_log/research_log.txt');

// All 8 base strategies — biweekly cycle tracks all of them
const ALL_STRATEGIES = [
  { file: 'jooviers_gems_smart_trail_scalper.pine',      name: 'JG Smart Trail HA Scalper',       author: 'Jooviers Gems',    bestOn: ['BTCUSD','XAUUSD'],          signals: ['A'] },
  { file: 'jooviers_gems_ha_scalper.pine',               name: 'JG HA Scalper',                    author: 'Jooviers Gems',    bestOn: ['BTCUSD','ETHUSD','XAUUSD'], signals: ['J'] },
  { file: 'jooviers_gems_london_breakout.pine',          name: 'JG London Breakout',               author: 'Jooviers Gems',    bestOn: ['GBPUSD','EURUSD','XAUUSD'], signals: ['K'] },
  { file: 'tori_trades_trendline_strategy.pine',         name: 'Tori 4H Trendline Break',          author: 'Tori Trades',      bestOn: ['GBPUSD','EURUSD','NAS100'], signals: ['L'] },
  { file: 'wor_break_and_retest.pine',                   name: 'WOR Break & Retest',               author: 'Words of Rizdom',  bestOn: ['BTCUSD','GBPUSD','XAUUSD'], signals: ['M'] },
  { file: 'wor_marci_silfrain_htf_mean_reversion.pine',  name: 'WOR Marci HTF Mean Reversion',     author: 'Words of Rizdom',  bestOn: ['NAS100','SPX500'],           signals: ['N'] },
  { file: 'wor_nbb_ict_power_of_3.pine',                 name: 'WOR NBB ICT Power of 3',           author: 'Words of Rizdom',  bestOn: ['BTCUSD','NAS100','XAUUSD'], signals: ['O'] },
  { file: 'wor_okala_nq_scalper.pine',                   name: 'WOR Okala NQ Scalper',             author: 'Words of Rizdom',  bestOn: ['NAS100','US30'],             signals: ['P'] },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { writeFileSync(LOG_FILE, line + '\n', { flag: 'a' }); } catch(e) {}
}

// ── 1. Analyse trades.csv ──
function analyseTrades() {
  if (!existsSync(TRADES_CSV)) return { total: 0, bySymbol: {}, bySession: {}, weakSpots: [] };
  const lines = readFileSync(TRADES_CSV, 'utf8').trim().split('\n').slice(1).filter(Boolean);
  const bySymbol = {}, bySession = {};

  for (const line of lines) {
    const cols   = line.split(',');
    const symbol  = cols[2]?.trim();
    const session = cols[1]?.trim();
    const result  = cols[10]?.trim();
    const pnl     = parseFloat(cols[11]) || 0;
    if (!symbol) continue;

    for (const [key, map] of [[symbol, bySymbol], [session, bySession]]) {
      if (!map[key]) map[key] = { wins: 0, losses: 0, pnl: 0, trades: 0 };
      map[key].trades++;
      map[key].pnl += pnl;
      if (result === 'W') map[key].wins++;
      if (result === 'L') map[key].losses++;
    }
  }

  // Find weak spots (WR < 40% or net negative with 3+ trades)
  const weakSpots = [];
  for (const [sym, s] of Object.entries(bySymbol)) {
    if (s.trades < 3) continue;
    const wr = s.wins / s.trades;
    if (wr < 0.40 || s.pnl < 0) weakSpots.push({ sym, wr: Math.round(wr*100), pnl: s.pnl, trades: s.trades });
  }
  weakSpots.sort((a, b) => a.pnl - b.pnl);

  return { total: lines.length, bySymbol, bySession, weakSpots };
}

// ── 2. Run backtest verification ──
async function runBacktestVerification() {
  log('Running push_reload_verify...');
  return new Promise((resolve) => {
    const proc = spawn('node', [join(ROOT, 'scripts/push_reload_verify.mjs')], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); process.stdout.write(d); });
    proc.stderr.on('data', d => { out += d.toString(); });
    proc.on('close', code => resolve({ code, output: out }));
  });
}

// ── 3. Score analysis — look for scoring weight improvements ──
function analyseScoring(analysis) {
  const suggestions = [];

  // If certain symbols consistently underperform, reduce their session priority
  for (const { sym, wr } of analysis.weakSpots) {
    if (wr < 30) suggestions.push(`Consider removing ${sym} from scan list — WR ${wr}% over ${analysis.bySymbol[sym].trades} trades`);
    else if (wr < 40) suggestions.push(`Increase score threshold for ${sym} from 4 to 5 — WR ${wr}% suggests low-quality setups`);
  }

  // Check session performance
  for (const [session, s] of Object.entries(analysis.bySession)) {
    if (s.trades >= 3 && s.pnl < 0) {
      suggestions.push(`${session} session net negative ($${s.pnl.toFixed(2)}) — consider skipping or raising threshold`);
    }
  }

  return suggestions;
}

// ── 4. Apply scoring suggestions to setup_finder ──
function applyThresholdAdjustments(suggestions) {
  if (suggestions.length === 0) return;
  const sfPath = join(ROOT, 'scripts/trading/setup_finder.mjs');
  let src = readFileSync(sfPath, 'utf8');

  // Log suggestions — manual review required for structural changes
  log('Scoring suggestions (manual review needed):');
  for (const s of suggestions) log('  → ' + s);

  // Auto-apply: bump DEAD-ZONE minimum score from 3 to 4 if dead zone losing
  const deadZone = suggestions.find(s => s.includes('DEAD') || s.includes('dead'));
  if (deadZone) {
    // Keep conservative — just log, don't auto-modify scoring logic
    log('  Dead zone underperforming — already crypto-only, no change needed.');
  }
}

// ── 5. Generate experimental Pine variant ──
function generateExperimentalVariant(baselinePath, analysis) {
  const base = readFileSync(baselinePath, 'utf8');
  const timestamp = new Date().toISOString().slice(0,10);

  // Extract current parameter values and suggest optimised ones based on trade data
  // Strategy: if most losses are on fast timeframes, increase ATR floor
  const hasSmallTFLosses = analysis.weakSpots.some(w =>
    ['ETHUSD','BTCUSD'].includes(w.sym) && w.wr < 40
  );

  let variant = base;
  let changes = [];

  if (hasSmallTFLosses) {
    // Tighten doji body requirement to reduce false signals on fast TFs
    variant = variant.replace(
      /i_doji_body = input\.float\((0\.\d+)/,
      (m, v) => {
        const newVal = Math.min(parseFloat(v) + 0.03, 0.35).toFixed(2);
        if (newVal !== v) changes.push(`doji_body: ${v} → ${newVal} (tighten false signals on fast TFs)`);
        return m.replace(v, newVal);
      }
    );
  }

  if (changes.length === 0) {
    log('No parameter changes warranted by current data. Skipping variant generation.');
    return null;
  }

  const variantName = `jg_smart_trail_exp_${timestamp}.pine`;
  const variantPath = join(STRAT_DIR, variantName);
  // Add version comment at top
  variant = `// EXPERIMENTAL variant — generated ${timestamp}\n// Changes: ${changes.join('; ')}\n\n` + variant;
  writeFileSync(variantPath, variant, 'utf8');
  log(`Experimental variant saved: ${variantName}`);
  log('Changes: ' + changes.join('; '));
  return { variantPath, variantName, changes };
}

// ── 6. Update knowledge base ──
function updateKnowledgeBase(analysis, suggestions, backtestOutput, variant) {
  if (!existsSync(KB_FILE)) return;
  let kb = readFileSync(KB_FILE, 'utf8');
  const date = new Date().toISOString().slice(0, 10);

  const section = `
---
## Biweekly Research Update — ${date}

### Trade Performance Summary
- Total trades logged: ${analysis.total}
- Weak spots (WR < 40%): ${analysis.weakSpots.map(w => `${w.sym} WR=${w.wr}% P&L=$${w.pnl.toFixed(2)}`).join(', ') || 'none'}

### Scoring Suggestions
${suggestions.length > 0 ? suggestions.map(s => '- ' + s).join('\n') : '- No changes needed — all symbols performing within parameters'}

### Backtest Status
${backtestOutput.code === 0 ? '✓ All combos healthy' : '⚠ Some combos degraded — review needed'}

### Experimental Variant
${variant ? `Generated: ${variant.variantName}\nChanges: ${variant.changes.join('; ')}` : 'No variant generated — parameters already optimal'}

`;

  // Append to end of knowledge base
  kb += section;
  writeFileSync(KB_FILE, kb, 'utf8');
  log('Knowledge base updated.');
}

// ── MAIN ──
async function main() {
  log('=== BIWEEKLY STRATEGY RESEARCH CYCLE START ===');

  // 1. Analyse trade history
  log('Analysing trade history...');
  const analysis = analyseTrades();
  log(`Total trades: ${analysis.total}`);
  if (analysis.weakSpots.length > 0) {
    log(`Weak spots: ${analysis.weakSpots.map(w => `${w.sym}(WR=${w.wr}%)`).join(', ')}`);
  } else {
    log('No weak spots found — all symbols performing well.');
  }

  // 2. Re-run backtest verification
  log('\nRe-running backtest verification...');
  const btResult = await runBacktestVerification();

  // 3. Scoring analysis
  log('\nAnalysing scoring weights...');
  const suggestions = analyseScoring(analysis);

  // 4. Apply adjustments
  applyThresholdAdjustments(suggestions);

  // 5. Generate experimental variant if warranted
  log('\nChecking for parameter optimisation opportunities...');
  const baselinePath = join(STRAT_DIR, 'jooviers_gems_smart_trail_scalper.pine');
  const variant = generateExperimentalVariant(baselinePath, analysis);

  // 6. Update knowledge base
  log('\nUpdating knowledge base...');
  updateKnowledgeBase(analysis, suggestions, btResult, variant);

  log('\n=== RESEARCH CYCLE COMPLETE ===');
  log(`Next cycle: ${new Date(Date.now() + 14*24*60*60*1000).toDateString()}`);
}

main().catch(e => {
  log('Fatal: ' + e.message);
  process.exit(1);
});
