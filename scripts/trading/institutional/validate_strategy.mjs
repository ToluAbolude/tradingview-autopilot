#!/usr/bin/env node
// validate_strategy.mjs — run the video's validation battery (Sharpe + Monte
// Carlo + entry-edge significance) over a book of trades and print a verdict.
//
// Usage:
//   node validate_strategy.mjs --file trades.json          # JSON array of trades
//   node validate_strategy.mjs --jsonl confirm_signals.jsonl
//   node validate_strategy.mjs --demo                      # synthetic self-check
//
// Trade field auto-detection (first match wins):
//   R multiple : netR | r | R | rMultiple | pnlR | rr
//   entry time : entryTs | ts | openTs | openTime | timestamp | time  (sec→ms auto)
// Options: --min-sharpe --max-p --min-trades --min-span-years --iters --seed --json

import { readFileSync } from 'node:fs';
import { validate } from './robustness.mjs';

function parseArgs(argv) {
  const a = { iters: 5000 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--file') a.file = next();
    else if (k === '--jsonl') a.jsonl = next();
    else if (k === '--demo') a.demo = true;
    else if (k === '--json') a.json = true;
    else if (k === '--min-sharpe') a.minSharpe = Number(next());
    else if (k === '--max-p') a.maxPValue = Number(next());
    else if (k === '--min-trades') a.minTrades = Number(next());
    else if (k === '--min-span-years') a.minSpanYears = Number(next());
    else if (k === '--iters') a.iters = Number(next());
    else if (k === '--seed') a.seed = Number(next());
  }
  return a;
}

const R_KEYS = ['netR', 'r', 'R', 'rMultiple', 'pnlR', 'rr'];
const TS_KEYS = ['entryTs', 'ts', 'openTs', 'openTime', 'timestamp', 'time'];

function pick(obj, keys) {
  for (const k of keys) if (obj[k] != null && Number.isFinite(Number(obj[k]))) return Number(obj[k]);
  return undefined;
}
function normalizeTs(v) {
  if (v == null) return 0;
  // treat 10-digit values as unix seconds
  return v < 1e12 ? v * 1000 : v;
}
function toTrades(rows) {
  const out = [];
  let dropped = 0;
  for (const row of rows) {
    const netR = pick(row, R_KEYS);
    if (netR === undefined) { dropped++; continue; }
    out.push({ netR, entryTs: normalizeTs(pick(row, TS_KEYS)) });
  }
  return { trades: out, dropped };
}

function loadRows(a) {
  if (a.file) return JSON.parse(readFileSync(a.file, 'utf8'));
  if (a.jsonl) {
    return readFileSync(a.jsonl, 'utf8').split('\n')
      .map(l => l.trim()).filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }
  if (a.demo) {
    const YEAR = 365.25 * 24 * 3600 * 1000;
    return Array.from({ length: 260 }, (_, i) =>
      ({ netR: (i % 20) < 13 ? 2 : -1, entryTs: Date.now() - 2 * YEAR + (i / 260) * 2 * YEAR }));
  }
  return null;
}

function fmt(x, d = 2) { return Number.isFinite(x) ? x.toFixed(d) : String(x); }

function main() {
  const a = parseArgs(process.argv.slice(2));
  const rows = loadRows(a);
  if (!rows) {
    console.error('No input. Use --file <json> | --jsonl <path> | --demo');
    process.exit(2);
  }
  const { trades, dropped } = toTrades(Array.isArray(rows) ? rows : [rows]);
  if (trades.length < 30) {
    console.error(`Only ${trades.length} usable trades (dropped ${dropped}). Need >= 30 to say anything.`);
    process.exit(2);
  }

  const opts = { iters: a.iters };
  for (const k of ['minSharpe', 'maxPValue', 'minTrades', 'minSpanYears', 'seed']) if (a[k] != null) opts[k] = a[k];
  const v = validate(trades, opts);

  if (a.json) { console.log(JSON.stringify(v, null, 2)); process.exit(v.pass ? 0 : 1); }

  const { metrics: m, monteCarlo: mc, permutation: p } = v;
  console.log(`\n=== Strategy robustness validation (${trades.length} trades${dropped ? `, ${dropped} dropped` : ''}) ===`);
  console.log(`  span ${fmt(m.spanYears)}y  |  Sharpe (annualized) ${fmt(m.sharpeAnnualized)}`);
  console.log(`  Monte Carlo (${mc.iters} resamples):`);
  console.log(`    Sharpe/tr observed ${fmt(mc.sharpe.observed)}  median ${fmt(mc.sharpe.median)}  best5% ${fmt(mc.sharpe.best5pct)}  → observed at ${fmt(mc.sharpe.percentile * 100, 1)} pct`);
  console.log(`    TotalR   observed ${fmt(mc.totalR.observed)}  median ${fmt(mc.totalR.median)}  p05 ${fmt(mc.totalR.p05)}`);
  console.log(`    MaxDD    observed ${fmt(mc.maxDD.observed)}R  plan-for(p95) ${fmt(mc.maxDD.p95)}R`);
  console.log(`  Entry-edge significance: p = ${fmt(p.pValue, 4)}  (observed mean ${fmt(p.observedMeanR)}R)`);
  console.log('  Gates:');
  for (const [name, ok] of Object.entries(v.checks)) console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`\n  VERDICT: ${v.pass ? 'PASS — robust enough to consider' : 'FAIL — do not trust live yet'}\n`);
  process.exit(v.pass ? 0 : 1);
}

main();
