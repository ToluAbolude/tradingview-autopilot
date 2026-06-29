/**
 * confirm_report.mjs — Per-strategy attribution for the live-confirm test.
 *
 * Reads confirm_signals.jsonl (each placed demo trade tagged with its strategy +
 * positionId), reconciles every positionId against the cTrader ledger
 * (getAllClosedDeals), and reports each STRATEGY's realised performance in R.
 *
 * R per trade = realisedNet / riskDollars, where riskDollars = equity * riskPct/100
 * at placement (that's the 1R we sized to). A clean -1R (SL) / +2R (TP) test.
 *
 * Usage: node scripts/trading/confirm_report.mjs [--days N]   (default 30)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import os from 'os';

const IS_LINUX  = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX ? '/home/ubuntu/trading-data' : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const SIGNALS_LOG = join(DATA_ROOT, 'confirm_signals.jsonl');
const OUT_MD      = join(DATA_ROOT, 'confirm_results.md');
const DAYS = Number((process.argv.find(a => a.startsWith('--days=')) || '').split('=')[1]
  || (process.argv.includes('--days') ? process.argv[process.argv.indexOf('--days') + 1] : '') || 30);

// Only count trades AFTER the fixes (1h combos + placement-bug fix). The earlier
// week was the immediate-close bug — not a valid test. Same cutoff as the weekly review.
const EXP_START = Date.parse(process.env.EXPERIMENT_START || '2026-06-27T00:00:00Z');
function loadPlaced() {
  if (!existsSync(SIGNALS_LOG)) return [];
  return readFileSync(SIGNALS_LOG, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    // A captured positionId means the order opened — attribute by that, NOT the
    // `placed` flag (early versions set placed=false when the SL/TP amend hadn't
    // settled within the naked-check window even though the trade ran fine).
    .filter(r => r && r.mode === 'live-demo' && r.positionId && Date.parse(r.ts) >= EXP_START);
}

async function main() {
  const placed = loadPlaced();
  if (!placed.length) {
    console.log('No placed live-demo trades in confirm_signals.jsonl yet.');
    return;
  }
  const bridge = await import('./broker_ctrader.mjs');
  await bridge.connect();

  const fromMs = Date.now() - DAYS * 86400000;
  const deals = await bridge.getAllClosedDeals(fromMs);
  const netByPos = new Map();   // positionId -> summed realised net
  for (const d of deals) netByPos.set(d.positionId, (netByPos.get(d.positionId) || 0) + d.net);

  // Aggregate per strategy
  const agg = {};   // strategy -> { closed, open, wins, sumR, grossWin, grossLoss, trades:[] }
  for (const t of placed) {
    const a = agg[t.strategy] ||= { closed: 0, open: 0, wins: 0, sumR: 0, grossWin: 0, grossLoss: 0, symbols: new Set() };
    a.symbols.add(t.symbol);
    const risk$ = (t.equity * t.riskPct) / 100;
    if (netByPos.has(t.positionId)) {
      const net = netByPos.get(t.positionId);
      const R = risk$ > 0 ? net / risk$ : 0;
      a.closed++; a.sumR += R;
      if (R > 0) { a.wins++; a.grossWin += R; } else { a.grossLoss += Math.abs(R); }
    } else {
      a.open++;   // position not closed yet (still running)
    }
  }

  const rows = Object.entries(agg).map(([strategy, a]) => ({
    strategy, symbols: [...a.symbols].join(','),
    closed: a.closed, open: a.open,
    wr: a.closed ? Math.round((a.wins / a.closed) * 100) : 0,
    expR: a.closed ? a.sumR / a.closed : 0,
    totalR: a.sumR,
    pf: a.grossLoss > 0 ? a.grossWin / a.grossLoss : (a.grossWin > 0 ? Infinity : 0),
  })).sort((x, y) => y.expR - x.expR);

  const fmt = n => (n >= 0 ? '+' : '') + n.toFixed(2);
  const lines = [];
  lines.push(`# Live-Confirm Results (per strategy) — ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push('DEMO forward-test. R = realised net / risk$ (1R sized at placement). Single 2R bracket.');
  lines.push('');
  lines.push('| Strategy | Instrument | Closed | Open | WR | ExpR | TotalR | PF |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    lines.push(`| ${r.strategy} | ${r.symbols} | ${r.closed} | ${r.open} | ${r.wr}% | ${fmt(r.expR)}R | ${fmt(r.totalR)}R | ${r.pf === Infinity ? '∞' : r.pf.toFixed(2)} |`);
  }
  const totClosed = rows.reduce((s, r) => s + r.closed, 0);
  const totOpen   = rows.reduce((s, r) => s + r.open, 0);
  lines.push('');
  lines.push(`_Totals: ${totClosed} closed, ${totOpen} open. Window: last ${DAYS} days. Min ~20-30 closed/strategy before drawing conclusions._`);

  const out = lines.join('\n') + '\n';
  console.log('\n' + out);
  if (!existsSync(DATA_ROOT)) mkdirSync(DATA_ROOT, { recursive: true });
  writeFileSync(OUT_MD, out);
  console.log(`Wrote ${OUT_MD}`);
}

main().then(() => process.exit(0)).catch(e => { console.error('confirm_report failed:', e); process.exit(1); });
