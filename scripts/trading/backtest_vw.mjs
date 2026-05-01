/**
 * backtest_vw.mjs — Walk-forward backtest for Strategy V and W
 *
 * Strategy V: Trend Catcher Switch (NAS100/SPX500, 75% WR LuxAlgo backtest on NAS100 15M)
 *   — SmartTrail direction flip (-1→+1) in last 5 bars
 *   + EMA stack aligned (8>21>50)
 *   + RSI < 55 (not overextended)
 *
 * Strategy W: SPX500 Contrarian FVG (70.51% WR LuxAlgo backtest on SPX500 15M)
 *   — Bearish FVG in last 10 bars (gap down = imbalance)
 *   + MFI(14) < 50 (bearish money flow)
 *   + RSI < 35 (extreme oversold = institutional reversal zone)
 *
 * Tests on NAS100 15M and SPX500 15M with 500 bars.
 * SL: 1.5×ATR | TP: 3×ATR (2R) | Walk-forward bar-by-bar
 *
 * Run on VM:
 *   DISPLAY=:1 node scripts/trading/backtest_vw.mjs
 */

import { runAllStrategies, getBars, setChart } from './setup_finder.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const WARMUP        = 100;  // 100-bar warmup leaves ~200 bars to walk on a 300-bar chart
const SL_ATR_MULT   = 1.5;
const TP_R          = 2.0;
const MAX_BARS_HELD = 40;   // shorter hold cap works better on H1

// Test on H1 for broader history (300 H1 bars ≈ 60 trading days vs 300 15M bars ≈ 3 days)
// V condition logic is timeframe-agnostic — SmartTrail flip is valid on any TF
// autoShort: false instruments use long-only to match live scanner behaviour
const TARGETS = [
  { sym: 'BLACKBULL:NAS100', label: 'NAS100', tf: '60', dirs: ['long'],          focusStrat: 'V', requireTU: true },
  { sym: 'BLACKBULL:SPX500', label: 'SPX500', tf: '60', dirs: ['long'],          focusStrat: 'W', requireTU: true },
  { sym: 'BLACKBULL:NAS100', label: 'NAS100', tf: '30', dirs: ['long'],          focusStrat: 'V', requireTU: true },
  { sym: 'BLACKBULL:SPX500', label: 'SPX500', tf: '30', dirs: ['long'],          focusStrat: 'W', requireTU: true },
  { sym: 'BLACKBULL:NAS100', label: 'NAS100', tf: '15', dirs: ['long'],          focusStrat: 'V', requireTU: true },
  { sym: 'BLACKBULL:SPX500', label: 'SPX500', tf: '15', dirs: ['long'],          focusStrat: 'W', requireTU: true },
  // Strategy X — Fibonacci OTE on instruments that allow shorts
  { sym: 'BLACKBULL:XAUUSD', label: 'XAUUSD', tf: '60', dirs: ['long', 'short'], focusStrat: 'X', requireTU: true },
  { sym: 'BLACKBULL:XAUUSD', label: 'XAUUSD', tf: '30', dirs: ['long', 'short'], focusStrat: 'X', requireTU: true },
  { sym: 'BLACKBULL:NAS100', label: 'NAS100', tf: '60', dirs: ['long'],          focusStrat: 'X', requireTU: true },
  { sym: 'BLACKBULL:WTI',    label: 'WTI',    tf: '60', dirs: ['long', 'short'], focusStrat: 'X', requireTU: true },
  { sym: 'BLACKBULL:WTI',    label: 'WTI',    tf: '30', dirs: ['long', 'short'], focusStrat: 'X', requireTU: true },
];

function simulateTrade(bars, idx, dir, atrVal) {
  const entry  = bars[idx].c;
  const slDist = atrVal * SL_ATR_MULT;
  const sl     = dir === 'long' ? entry - slDist : entry + slDist;
  const tp     = dir === 'long' ? entry + slDist * TP_R : entry - slDist * TP_R;
  const limit  = Math.min(idx + MAX_BARS_HELD, bars.length - 1);

  for (let i = idx + 1; i <= limit; i++) {
    const { h, l } = bars[i];
    if (dir === 'long') {
      if (l <= sl) return { outcome: 'loss', r: -1, held: i - idx };
      if (h >= tp) return { outcome: 'win',  r: TP_R, held: i - idx };
    } else {
      if (h >= sl) return { outcome: 'loss', r: -1, held: i - idx };
      if (l <= tp) return { outcome: 'win',  r: TP_R, held: i - idx };
    }
  }
  const exit = bars[limit].c;
  const r    = dir === 'long' ? (exit - entry) / slDist : (entry - exit) / slDist;
  return { outcome: r > 0 ? 'win' : 'loss', r: Math.round(r * 100) / 100, held: limit - idx };
}

function stats(trades) {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, netR: 0, avgHeld: 0 };
  const wins   = trades.filter(t => t.outcome === 'win');
  const losses = trades.filter(t => t.outcome === 'loss');
  const grossW = wins.reduce((s, t) => s + t.r, 0);
  const grossL = Math.abs(losses.reduce((s, t) => s + t.r, 0));
  return {
    n:       trades.length,
    wr:      Math.round((wins.length / trades.length) * 1000) / 10,
    pf:      grossL > 0 ? Math.round((grossW / grossL) * 100) / 100 : (grossW > 0 ? 99 : 0),
    netR:    Math.round((grossW - grossL) * 10) / 10,
    avgHeld: Math.round(trades.reduce((s, t) => s + t.held, 0) / trades.length),
  };
}

function printTable(label, rows) {
  const w = [18, 8, 7, 7, 8, 9];
  const line = `╠${'═'.repeat(w[0]+2)}╬${'═'.repeat(w[1]+2)}╬${'═'.repeat(w[2]+2)}╬${'═'.repeat(w[3]+2)}╬${'═'.repeat(w[4]+2)}╬${'═'.repeat(w[5]+2)}╣`;
  console.log(`\n  ┌─ ${label}`);
  console.log(`  ╔${'═'.repeat(w[0]+2)}╦${'═'.repeat(w[1]+2)}╦${'═'.repeat(w[2]+2)}╦${'═'.repeat(w[3]+2)}╦${'═'.repeat(w[4]+2)}╦${'═'.repeat(w[5]+2)}╗`);
  console.log(`  ║ ${'Filter'.padEnd(w[0])} ║ ${'Trades'.padEnd(w[1])} ║ ${'WR%'.padEnd(w[2])} ║ ${'PF'.padEnd(w[3])} ║ ${'NetR'.padEnd(w[4])} ║ ${'AvgHeld'.padEnd(w[5])} ║`);
  console.log(`  ${line}`);
  for (const r of rows) {
    const dwr = r.baseline != null ? ` (${r.wr - r.baseline >= 0 ? '+' : ''}${(r.wr - r.baseline).toFixed(1)}%)` : '';
    console.log(`  ║ ${r.name.padEnd(w[0])} ║ ${String(r.n).padEnd(w[1])} ║ ${(r.wr.toFixed(1)+'%').padEnd(w[2])} ║ ${String(r.pf).padEnd(w[3])} ║ ${String(r.netR).padEnd(w[4])} ║ ${(String(r.avgHeld)+' bars').padEnd(w[5])} ║${dwr}`);
  }
  console.log(`  ╚${'═'.repeat(w[0]+2)}╩${'═'.repeat(w[1]+2)}╩${'═'.repeat(w[2]+2)}╩${'═'.repeat(w[3]+2)}╩${'═'.repeat(w[4]+2)}╩${'═'.repeat(w[5]+2)}╝`);
}

async function backtestTarget(target) {
  console.log(`\n  ▶ ${target.label} ${target.tf}M — fetching 500 bars...`);
  await setChart(target.sym, target.tf);
  await sleep(2500);

  const bars = await getBars(500);
  if (!bars || bars.length < WARMUP + 20) {
    console.log(`    ✗ Insufficient bars (${bars?.length ?? 0}), skipping.`);
    return;
  }
  console.log(`    ${bars.length} bars loaded. Walking forward...`);

  const allTrades   = [];   // all qualifying trades (score ≥ 8)
  const withStrat   = [];   // trades where focus strategy fired
  const withoutStrat = [];  // trades where focus strategy did NOT fire

  for (let i = WARMUP; i < bars.length - 1; i++) {
    const utcHour  = new Date(bars[i].t * 1000).getUTCHours();
    const slice    = bars.slice(0, i + 1);

    for (const dir of target.dirs) {
      const { score, strategies, atrVal } = runAllStrategies(slice, dir, utcHour, target.label, target.tf);
      if (score < 8) continue;
      // Apply T+U mandatory gate (mirrors scanForSetups — weekly trend + daily zone required)
      if (target.requireTU && (!strategies.includes('T') || !strategies.includes('U'))) continue;

      const outcome = simulateTrade(bars, i, dir, atrVal);
      const trade   = {
        dir, score,
        hasStrat: strategies.includes(target.focusStrat),
        strategies,
        ts: bars[i].t,
        utcHour,
        ...outcome,
      };
      allTrades.push(trade);
      if (trade.hasStrat) withStrat.push(trade); else withoutStrat.push(trade);
    }
  }

  if (allTrades.length === 0) {
    console.log(`    No qualifying trades found (score ≥ 8).`);
    return;
  }

  const sAll     = stats(allTrades);
  const sWith    = stats(withStrat);
  const sWithout = stats(withoutStrat);

  const rows = [
    { name: `All (score ≥ 8)`,             ...sAll,     baseline: null },
    { name: `With Strat ${target.focusStrat}`,     ...sWith,    baseline: sAll.wr },
    { name: `Without Strat ${target.focusStrat}`,  ...sWithout, baseline: sAll.wr },
  ];

  printTable(`${target.label} 15M — Strategy ${target.focusStrat} Impact`, rows);

  // Direction breakdown for the focus strategy
  if (withStrat.length > 0) {
    const longs  = withStrat.filter(t => t.dir === 'long');
    const shorts = withStrat.filter(t => t.dir === 'short');
    const dirRows = [];
    if (longs.length)  dirRows.push({ name: `${target.focusStrat} Longs`,  ...stats(longs),  baseline: null });
    if (shorts.length) dirRows.push({ name: `${target.focusStrat} Shorts`, ...stats(shorts), baseline: null });
    if (dirRows.length > 1) printTable(`${target.label} — Direction split (Strat ${target.focusStrat} only)`, dirRows);
  }

  // Score breakdown for the focus strategy
  if (withStrat.length > 0) {
    const scoreGroups = {};
    for (const t of withStrat) {
      const bucket = t.score <= 9 ? '8-9' : t.score <= 11 ? '10-11' : '12+';
      if (!scoreGroups[bucket]) scoreGroups[bucket] = [];
      scoreGroups[bucket].push(t);
    }
    const scoreRows = Object.entries(scoreGroups).map(([b, ts]) => ({ name: `Score ${b}`, ...stats(ts), baseline: sWith.wr }));
    if (scoreRows.length > 1) printTable(`${target.label} — Score buckets (Strat ${target.focusStrat} only)`, scoreRows);
  }

  // Most common strategy combos when focus strategy fires
  if (withStrat.length > 0) {
    const comboCount = {};
    for (const t of withStrat) {
      const key = [...t.strategies].sort().join('');
      comboCount[key] = (comboCount[key] || 0) + 1;
    }
    const topCombos = Object.entries(comboCount).sort((a,b) => b[1]-a[1]).slice(0, 5);
    console.log(`\n  Top strategy combos when ${target.focusStrat} fires:`);
    for (const [combo, count] of topCombos) {
      console.log(`    [${combo}]  ×${count}`);
    }
  }
}

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Backtest — Strategy V (NAS100) & W (SPX500)');
  console.log(`  SL: ${SL_ATR_MULT}×ATR | TP: ${TP_R}R | Warmup: ${WARMUP} bars | TF: 15M`);
  console.log('  LuxAlgo reference: V=75% WR (NAS100 15M) | W=70.51% WR (SPX500 15M)');
  console.log('═══════════════════════════════════════════════════════════════');

  for (const target of TARGETS) {
    try {
      await backtestTarget(target);
    } catch (e) {
      console.error(`  ✗ ${target.label} error: ${e.message}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Backtest complete.');
  console.log('═══════════════════════════════════════════════════════════════\n');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
