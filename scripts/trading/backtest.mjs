/**
 * backtest.mjs — Walk-forward backtest of the GREEDY multi-strategy engine
 *
 * Loads ~500 historical bars per instrument from TradingView (via CDP),
 * then walks forward bar-by-bar running the full strategy engine.
 * Every bar that scores ≥ MIN_COLLECT has its trade outcome simulated
 * (SL = 1.5×ATR, TP = 3×ATR = 2R).
 *
 * Outputs:
 *   1. Threshold sweep  — WR / profit factor at every threshold 7-14
 *   2. Per-instrument   — WR at optimal threshold
 *   3. Strategy attribution — lift each strategy contributes to WR
 *   4. Mandatory combos — best 2-strategy "must have both" pairs
 *
 * Usage (on VM):
 *   node --input-type=module < scripts/trading/backtest.mjs
 *   node scripts/trading/backtest.mjs
 *
 * Requires TradingView running on CDP port 9222.
 */

import { runAllStrategies, getBars, setChart, FULL_SCAN_LIST } from './setup_finder.mjs';
import { writeFileSync } from 'fs';
import { join } from 'path';
import os from 'os';

const IS_LINUX  = os.platform() === 'linux';
const OUT_DIR   = IS_LINUX ? '/home/ubuntu/trading-data' : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const WARMUP    = 200;  // bars needed to warm up all indicators
const MIN_COLLECT = 7;  // collect all signals at this score or above
const THRESHOLDS  = [7, 8, 9, 10, 11, 12, 13, 14];
const SL_ATR_MULT = 1.5;
const TP_R        = 2.0; // target in R multiples (TP = SL_dist × TP_R)
const MAX_BARS_HELD = 60; // bars before force-closing (timeout)

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Trade outcome simulator ────────────────────────────────────────────────
function simulateTrade(bars, signalIdx, dir, atrVal) {
  const entry  = bars[signalIdx].c;
  const slDist = atrVal * SL_ATR_MULT;
  const sl     = dir === 'long' ? entry - slDist : entry + slDist;
  const tp     = dir === 'long' ? entry + slDist * TP_R : entry - slDist * TP_R;

  const limit = Math.min(signalIdx + MAX_BARS_HELD, bars.length - 1);
  for (let i = signalIdx + 1; i <= limit; i++) {
    const { h, l } = bars[i];
    if (dir === 'long') {
      if (l <= sl) return { outcome: 'loss', r: -1,    held: i - signalIdx };
      if (h >= tp) return { outcome: 'win',  r: TP_R,  held: i - signalIdx };
    } else {
      if (h >= sl) return { outcome: 'loss', r: -1,    held: i - signalIdx };
      if (l <= tp) return { outcome: 'win',  r: TP_R,  held: i - signalIdx };
    }
  }
  // Timeout — close at last bar's close
  const exit = bars[limit].c;
  const r    = dir === 'long'
    ? (exit - entry) / slDist
    : (entry - exit) / slDist;
  return { outcome: r > 0 ? 'win' : 'loss', r: Math.round(r * 100) / 100, held: limit - signalIdx };
}

// ── Per-instrument walk-forward ────────────────────────────────────────────
async function backtestInstrument(inst, tf) {
  await setChart(inst.sym, tf);
  await sleep(2200);

  const bars = await getBars(500);
  if (!bars || bars.length < WARMUP + 20) {
    console.log(`    skip (${bars?.length ?? 0} bars — need ${WARMUP + 20})`);
    return [];
  }

  const trades = [];
  const directions = ['long', ...(inst.autoShort ? ['short'] : [])];

  for (let i = WARMUP; i < bars.length - 1; i++) {
    const utcHour  = new Date(bars[i].t * 1000).getUTCHours();
    const barsSlice = bars.slice(0, i + 1);

    for (const dir of directions) {
      const { score, strategies, atrVal } = runAllStrategies(barsSlice, dir, utcHour, inst.label, tf);
      if (score < MIN_COLLECT) continue;

      const outcome = simulateTrade(bars, i, dir, atrVal);
      trades.push({
        label:      inst.label,
        tf,
        tier:       inst.tier,
        dir,
        score,
        strategies: [...strategies],
        timestamp:  bars[i].t,
        utcHour,
        ...outcome,
      });
    }
  }

  return trades;
}

// ── Analysis helpers ───────────────────────────────────────────────────────
function stats(trades) {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, netR: 0 };
  const wins   = trades.filter(t => t.outcome === 'win');
  const losses = trades.filter(t => t.outcome === 'loss');
  const grossW = wins.reduce((s, t) => s + t.r, 0);
  const grossL = Math.abs(losses.reduce((s, t) => s + t.r, 0));
  return {
    n:    trades.length,
    wr:   Math.round((wins.length / trades.length) * 100),
    pf:   grossL > 0 ? Math.round((grossW / grossL) * 100) / 100 : grossW > 0 ? 99 : 0,
    netR: Math.round((grossW - grossL) * 10) / 10,
  };
}

function thresholdSweep(allTrades) {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║           THRESHOLD SWEEP (all instruments)          ║');
  console.log('╠══════════╦════════╦═══════╦════════╦════════╦════════╣');
  console.log('║ Threshold║ Trades ║  WR%  ║   PF   ║  NetR  ║  Rec?  ║');
  console.log('╠══════════╬════════╬═══════╬════════╬════════╬════════╣');

  let best = { pf: 0, threshold: 11 };
  for (const t of THRESHOLDS) {
    const subset = allTrades.filter(tr => tr.score >= t);
    const s = stats(subset);
    const rec = s.pf > 1.2 && s.n >= 10 ? '  ✓' : '';
    if (s.pf > best.pf && s.n >= 10) best = { pf: s.pf, threshold: t };
    console.log(
      `║   ${String(t).padEnd(7)} ║  ${String(s.n).padEnd(5)} ║  ${String(s.wr).padEnd(4)} ║  ${String(s.pf).padEnd(5)} ║  ${String(s.netR).padEnd(5)} ║${rec.padEnd(7)}║`
    );
  }
  console.log('╚══════════╩════════╩═══════╩════════╩════════╩════════╝');
  console.log(`  Recommended threshold: ${best.threshold} (PF ${best.pf})\n`);
  return best.threshold;
}

function perInstrument(allTrades, threshold) {
  const byLabel = {};
  for (const t of allTrades) {
    if (t.score < threshold) continue;
    if (!byLabel[t.label]) byLabel[t.label] = [];
    byLabel[t.label].push(t);
  }

  const rows = Object.entries(byLabel)
    .map(([label, ts]) => ({ label, ...stats(ts) }))
    .sort((a, b) => b.pf - a.pf);

  console.log(`\n╔═══════════════════════════════════════════════════╗`);
  console.log(`║         PER-INSTRUMENT (threshold ≥ ${threshold})          ║`);
  console.log(`╠═══════════╦════════╦═══════╦════════╦═══════════╣`);
  console.log(`║ Instrument║ Trades ║  WR%  ║   PF   ║   NetR    ║`);
  console.log(`╠═══════════╬════════╬═══════╬════════╬═══════════╣`);
  for (const r of rows) {
    console.log(
      `║ ${r.label.padEnd(9)} ║  ${String(r.n).padEnd(5)} ║  ${String(r.wr).padEnd(4)} ║  ${String(r.pf).padEnd(5)} ║  ${String(r.netR).padEnd(8)} ║`
    );
  }
  console.log(`╚═══════════╩════════╩═══════╩════════╩═══════════╝`);
}

function strategyAttribution(allTrades, threshold) {
  const tradeset = allTrades.filter(t => t.score >= threshold);
  if (tradeset.length === 0) { console.log('\nNo trades at threshold', threshold); return; }

  const allStrats = [...new Set(tradeset.flatMap(t => t.strategies.map(s => s[0])))].sort();

  const rows = allStrats.map(s => {
    const withS    = tradeset.filter(t => t.strategies.some(x => x[0] === s));
    const withoutS = tradeset.filter(t => !t.strategies.some(x => x[0] === s));
    const sw = stats(withS);
    const so = stats(withoutS);
    return { s, withN: sw.n, withWR: sw.wr, withPF: sw.pf, withoutWR: so.wr, liftWR: sw.wr - so.wr };
  }).sort((a, b) => b.liftWR - a.liftWR);

  console.log(`\n╔═══════════════════════════════════════════════════════════╗`);
  console.log(`║         STRATEGY ATTRIBUTION (threshold ≥ ${threshold})          ║`);
  console.log(`╠═══╦════════╦═══════════╦═══════════╦══════════════════════╣`);
  console.log(`║ S ║ Trades ║WR with(%) ║WR w/out(%)║  Lift (better=higher)║`);
  console.log(`╠═══╬════════╬═══════════╬═══════════╬══════════════════════╣`);
  for (const r of rows) {
    const arrow = r.liftWR > 5 ? ' ↑↑' : r.liftWR > 0 ? ' ↑' : r.liftWR < -5 ? ' ↓↓' : '';
    console.log(
      `║ ${r.s} ║  ${String(r.withN).padEnd(5)} ║    ${String(r.withWR).padEnd(6)} ║    ${String(r.withoutWR).padEnd(6)} ║  ${String(r.liftWR).padStart(4)}%${arrow.padEnd(16)}║`
    );
  }
  console.log(`╚═══╩════════╩═══════════╩═══════════╩══════════════════════╝`);
}

function mandatoryCombos(allTrades, threshold) {
  const tradeset = allTrades.filter(t => t.score >= threshold);
  if (tradeset.length < 10) { console.log('\nNot enough trades for combo analysis.'); return; }

  const allStrats = [...new Set(tradeset.flatMap(t => t.strategies.map(s => s[0])))].sort();
  const combos = [];

  for (let i = 0; i < allStrats.length; i++) {
    for (let j = i + 1; j < allStrats.length; j++) {
      const s1 = allStrats[i], s2 = allStrats[j];
      const both    = tradeset.filter(t => t.strategies.some(x => x[0]===s1) && t.strategies.some(x => x[0]===s2));
      const neither = tradeset.filter(t => !t.strategies.some(x => x[0]===s1) || !t.strategies.some(x => x[0]===s2));
      if (both.length < 5) continue;
      const sb = stats(both);
      const sn = stats(neither);
      combos.push({ pair: `${s1}+${s2}`, withN: sb.n, withWR: sb.wr, withPF: sb.pf, withoutWR: sn.wr, liftWR: sb.wr - sn.wr });
    }
  }

  combos.sort((a, b) => b.withPF - a.withPF);
  const top = combos.slice(0, 10);

  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║    TOP MANDATORY 2-STRATEGY COMBOS (threshold ≥ ${threshold})    ║`);
  console.log(`╠═══════╦════════╦═══════╦════════╦══════════════════════╣`);
  console.log(`║ Combo ║ Trades ║  WR%  ║   PF   ║     WR Lift          ║`);
  console.log(`╠═══════╬════════╬═══════╬════════╬══════════════════════╣`);
  for (const r of top) {
    console.log(
      `║ ${r.pair.padEnd(5)} ║  ${String(r.withN).padEnd(5)} ║  ${String(r.withWR).padEnd(4)} ║  ${String(r.withPF).padEnd(5)} ║  +${String(r.liftWR).padEnd(17)}║`
    );
  }
  console.log(`╚═══════╩════════╩═══════╩════════╩══════════════════════╝`);
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  GREEDY Backtest — Walk-Forward Strategy Analysis');
  console.log(`  SL: ${SL_ATR_MULT}×ATR | TP: ${TP_R}R | Warm-up: ${WARMUP} bars | Min collect score: ${MIN_COLLECT}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const allTrades = [];

  for (const inst of FULL_SCAN_LIST) {
    for (const tf of inst.tfs) {
      process.stdout.write(`  [T${inst.tier}] ${inst.label} ${tf}M ... `);
      try {
        const trades = await backtestInstrument(inst, tf);
        allTrades.push(...trades);
        const atThreshold = trades.filter(t => t.score >= 11);
        const s = stats(atThreshold);
        console.log(`${trades.length} signals | @≥11: ${s.n} trades, WR=${s.wr}%, PF=${s.pf}`);
      } catch(e) {
        console.log(`ERROR: ${e.message}`);
      }
    }
  }

  if (allTrades.length === 0) {
    console.log('\nNo trades collected — check TradingView connection.');
    return;
  }

  console.log(`\n  Total signals collected (score ≥ ${MIN_COLLECT}): ${allTrades.length}`);

  // Save raw data
  const outFile = join(OUT_DIR, `backtest_${new Date().toISOString().split('T')[0]}.json`);
  try {
    writeFileSync(outFile, JSON.stringify(allTrades, null, 2));
    console.log(`  Raw data saved: ${outFile}`);
  } catch(e) {
    console.log(`  (Could not save to ${outFile}: ${e.message})`);
  }

  // Analysis
  const optThreshold = thresholdSweep(allTrades);
  perInstrument(allTrades, optThreshold);
  strategyAttribution(allTrades, optThreshold);
  mandatoryCombos(allTrades, optThreshold);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Backtest complete.');
  console.log('═══════════════════════════════════════════════════════════\n');
}

main().catch(e => { console.error('Backtest error:', e); process.exit(1); });
