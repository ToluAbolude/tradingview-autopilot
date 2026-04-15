/**
 * performance_tracker.mjs
 * Reads trade_log/trades.csv and computes running performance stats.
 * Outputs daily summary and adjusts strategy confidence based on recent results.
 *
 * Run at end of each session to review and learn.
 */
import { readFileSync, existsSync } from 'fs';

const LOG_FILE = 'C:/Users/Tda-d/tradingview-autopilot/data/trade_log/trades.csv';

function parseCsv(file) {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const vals = line.split(',');
    const obj = {};
    headers.forEach((h, i) => obj[h.trim()] = vals[i]?.trim() || '');
    return obj;
  });
}

export function analyzePerformance(trades) {
  if (!trades.length) return { message: 'No trades logged yet.' };

  const completed = trades.filter(t => t.result && t.pnl);
  const wins   = completed.filter(t => t.result === 'W' || parseFloat(t.pnl) > 0);
  const losses = completed.filter(t => t.result === 'L' || parseFloat(t.pnl) < 0);

  const totalPnl = completed.reduce((s, t) => s + parseFloat(t.pnl || 0), 0);
  const avgWin   = wins.length   ? wins.reduce((s,t)=>s+parseFloat(t.pnl||0),0)/wins.length   : 0;
  const avgLoss  = losses.length ? Math.abs(losses.reduce((s,t)=>s+parseFloat(t.pnl||0),0)/losses.length) : 0;
  const pf       = avgLoss > 0 ? (wins.length * avgWin) / (losses.length * avgLoss) : Infinity;
  const wr       = completed.length ? (wins.length / completed.length) * 100 : 0;

  // Best / worst setups
  const byScore = {};
  for (const t of completed) {
    const k = `score_${t.score}`;
    if (!byScore[k]) byScore[k] = { wins: 0, total: 0 };
    byScore[k].total++;
    if (parseFloat(t.pnl) > 0) byScore[k].wins++;
  }

  // Best sessions
  const bySession = {};
  for (const t of completed) {
    const s = t.session || 'UNKNOWN';
    if (!bySession[s]) bySession[s] = { wins: 0, total: 0, pnl: 0 };
    bySession[s].total++;
    bySession[s].pnl += parseFloat(t.pnl || 0);
    if (parseFloat(t.pnl) > 0) bySession[s].wins++;
  }

  // Best symbols
  const bySymbol = {};
  for (const t of completed) {
    const s = t.symbol || 'UNKNOWN';
    if (!bySymbol[s]) bySymbol[s] = { wins: 0, total: 0, pnl: 0 };
    bySymbol[s].total++;
    bySymbol[s].pnl += parseFloat(t.pnl || 0);
    if (parseFloat(t.pnl) > 0) bySymbol[s].wins++;
  }

  // Consecutive losses (for stop rule)
  let maxConsecLoss = 0, curConsecLoss = 0;
  for (const t of [...completed].reverse()) {
    if (parseFloat(t.pnl) < 0) { curConsecLoss++; maxConsecLoss = Math.max(maxConsecLoss, curConsecLoss); }
    else break;
  }

  // Recommendations
  const recs = [];
  if (wr < 50 && completed.length >= 10) recs.push('WR below 50% — tighten entry criteria, require score ≥5');
  if (pf < 1.5 && completed.length >= 10) recs.push('PF below 1.5 — widen TP or tighten SL');
  if (curConsecLoss >= 2) recs.push('⚠ 2+ consecutive losses — STOP TRADING this session');
  if (bySession['ASIAN']?.total > 3 && bySession['ASIAN'].pnl < 0) recs.push('Asian session losing — skip it, focus on London-NY');

  return {
    total: completed.length,
    wins:  wins.length,
    losses: losses.length,
    wr:    Math.round(wr * 10) / 10,
    pf:    Math.round(pf * 100) / 100,
    totalPnl: Math.round(totalPnl * 100) / 100,
    avgWin:   Math.round(avgWin  * 100) / 100,
    avgLoss:  Math.round(avgLoss * 100) / 100,
    currentConsecLoss: curConsecLoss,
    maxConsecLoss,
    byScore,
    bySession,
    bySymbol,
    recommendations: recs,
  };
}

// ── CLI usage ──
if (process.argv[1].endsWith('performance_tracker.mjs')) {
  const trades = parseCsv(LOG_FILE);
  console.log(`\nLoaded ${trades.length} trade log entries.`);

  const stats = analyzePerformance(trades);
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   PERFORMANCE SUMMARY                    ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`  Trades: ${stats.total} | WR: ${stats.wr}% | PF: ${stats.pf}`);
  console.log(`  Net P&L: £${stats.totalPnl} | Avg Win: £${stats.avgWin} | Avg Loss: £${stats.avgLoss}`);
  console.log(`  Consec Losses: ${stats.currentConsecLoss}`);

  if (stats.bySession && Object.keys(stats.bySession).length) {
    console.log('\n  By Session:');
    for (const [s, d] of Object.entries(stats.bySession)) {
      console.log(`    ${s}: ${d.wins}/${d.total} wins | £${Math.round(d.pnl*100)/100}`);
    }
  }

  if (stats.bySymbol && Object.keys(stats.bySymbol).length) {
    console.log('\n  By Symbol:');
    for (const [s, d] of Object.entries(stats.bySymbol)) {
      console.log(`    ${s}: ${d.wins}/${d.total} wins | £${Math.round(d.pnl*100)/100}`);
    }
  }

  if (stats.recommendations?.length) {
    console.log('\n  RECOMMENDATIONS:');
    for (const r of stats.recommendations) console.log(`    → ${r}`);
  }

  if (stats.message) console.log('  ' + stats.message);
}
