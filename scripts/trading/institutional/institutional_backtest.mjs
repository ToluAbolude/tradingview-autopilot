// Institutional Algorithm — walk-forward backtest engine (SPEC.md §4).
// Two phases:
//   --fetch  (VM only): pull M5/H4/D1 bars via the cTrader bridge → cache JSON
//   --run    (anywhere): load cache, run BOTH families through the SAME pure
//            signal modules, resolve via simulateBracket, net of SPEC §3 costs,
//            grade vs the FROZEN §5 thresholds. Emits summary JSON + trades jsonl.
// READ-ONLY with respect to the broker: this engine never places orders.
import fs from 'node:fs';
import path from 'node:path';
import { SESSIONS, nyOpenUtcMs, roundTripCostPrice, simulateBracket, netR, median } from './lib.mjs';
import { computeSmorbSignal, orWindow, OR_MINUTES } from './smorb.mjs';
import { computeTrendPbSignal, trendScore, LOOKBACKS_D } from './trendpb.mjs';
import { computeMetrics, splitFolds, gradeStage1 } from './metrics.mjs';

const DAY = 86400_000;
const SMORB_SYMBOLS = ['XAUUSD', 'US30', 'NAS100', 'SPX500', 'BTCUSD', 'ETHUSD'];
const TREND_SYMBOLS = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDCHF',
  'EURGBP', 'GBPJPY', 'AUDJPY', 'EURJPY', 'NZDCAD', 'GBPNZD',
  'XAUUSD', 'US30', 'NAS100', 'SPX500', 'BTCUSD', 'ETHUSD',
];
const M5_YEARS = 3, DEEP_YEARS = 6;
const CACHE_DIR = process.env.IA_CACHE_DIR
  || (fs.existsSync('/home/ubuntu/trading-data') ? '/home/ubuntu/trading-data/ia_cache' : path.join(process.cwd(), 'data', 'ia_cache'));
const OUT_DIR = process.env.IA_OUT_DIR || CACHE_DIR;

// Swap placeholder for multi-day holds (SPEC §3): bps of entry price per night.
const SWAP_BPS_PER_NIGHT = sym =>
  ['BTCUSD', 'ETHUSD'].includes(sym) ? 3 : ['US30', 'NAS100', 'SPX500'].includes(sym) ? 2 : 1;

const cachePath = (sym, tf) => path.join(CACHE_DIR, `${sym}_${tf}.json`);
const loadBars = (sym, tf) => JSON.parse(fs.readFileSync(cachePath(sym, tf), 'utf8'));
const isSaturdayUtc = ms => new Date(ms).getUTCDay() === 6;

// ---------------- fetch phase (VM) ----------------
async function fetchPhase() {
  const { getTrendbars } = await import('../broker_ctrader.mjs');
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const jobs = [];
  for (const s of SMORB_SYMBOLS) jobs.push([s, 'M5', M5_YEARS]);
  for (const s of TREND_SYMBOLS) { jobs.push([s, 'H4', DEEP_YEARS]); jobs.push([s, 'D1', DEEP_YEARS]); }
  for (const [sym, tf, years] of jobs) {
    const p = cachePath(sym, tf);
    if (fs.existsSync(p)) { console.log(`skip ${sym} ${tf} (cached)`); continue; }
    const t0 = Date.now();
    const bars = await getTrendbars(sym, {
      period: tf, fromMs: Date.now() - years * 365 * DAY, toMs: Date.now(),
      windowDays: tf === 'M5' ? 5 : tf === 'H4' ? 60 : 300,
    });
    fs.writeFileSync(p, JSON.stringify(bars));
    console.log(`fetched ${sym} ${tf}: ${bars.length} bars in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  console.log('FETCH DONE');
}

// ---------------- SMORB simulation ----------------
function sessionOpensFor(sym, dayStartMs) {
  const opens = [];
  for (const s of SESSIONS) {
    if (!s.symbols.includes(sym)) continue;
    if (s.openUTC) {
      const [hh, mm] = s.openUTC.split(':').map(Number);
      opens.push({ name: s.name, openMs: dayStartMs + (hh * 60 + mm) * 60_000 });
    } else if (s.openNY) {
      const d = new Date(dayStartMs);
      opens.push({ name: s.name, openMs: nyOpenUtcMs(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()) });
    }
  }
  return opens;
}

function runSmorb() {
  const trades = [];
  let sessions = 0, gated = 0;
  for (const sym of SMORB_SYMBOLS) {
    let bars;
    try { bars = loadBars(sym, 'M5'); } catch { console.error(`no M5 cache for ${sym}`); continue; }
    if (bars.length < 5000) continue;
    // Index bars by UTC day for fast slicing
    const byDay = new Map();
    for (const b of bars) {
      const day = Math.floor(b.t / DAY) * DAY;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(b);
    }
    const days = [...byDay.keys()].sort((a, b) => a - b);
    const orHistory = []; // rolling {vol, range} per completed session (per symbol)
    for (const day of days) {
      for (const { name, openMs } of sessionOpensFor(sym, day)) {
        const dayBars = [...(byDay.get(day) || []), ...(byDay.get(day + DAY) || [])]
          .filter(b => b.t >= openMs - DAY && b.t <= openMs + DAY);
        const or = orWindow(dayBars, openMs);
        if (!or.complete) continue;
        sessions++;
        const priorOrStats = {
          vols: orHistory.slice(-20).map(h => h.vol),
          ranges: orHistory.slice(-20).map(h => h.range),
        };
        // record BEFORE trading decision so history never peeks ahead
        const sig = isSaturdayUtc(openMs) ? { status: 'saturday' } : computeSmorbSignal({
          bars5m: dayBars, sessionOpenMs: openMs, priorOrStats,
        });
        orHistory.push({ vol: or.orVol, range: or.orHigh - or.orLow });
        if (sig.status !== 'signal') { if (sig.status === 'no_gate') gated++; continue; }
        // resolve: bars after entry until 20:00 UTC same day (SPEC §1 EOD)
        const eodMs = day + 20 * 3600_000;
        const walk = dayBars.filter(b => b.t > sig.entryTs && b.t < eodMs);
        let res = simulateBracket({ bars: walk, direction: sig.direction, entry: sig.entry, sl: sig.sl, tp: sig.tp });
        if (res.outcome === 'open') {
          const last = walk[walk.length - 1];
          if (!last) continue;
          const gross = (sig.direction === 'long' ? last.c - sig.entry : sig.entry - last.c) / Math.abs(sig.entry - sig.sl);
          res = { outcome: 'eod', exitPrice: last.c, exitTs: last.t, grossR: gross };
        }
        trades.push({
          family: 'SMORB', sym, session: name, direction: sig.direction,
          entry: sig.entry, sl: sig.sl, tp: sig.tp, entryTs: sig.entryTs,
          exitTs: res.exitTs, outcome: res.outcome, grossR: res.grossR,
          netR: netR({ grossR: res.grossR, entry: sig.entry, sl: sig.sl, symbol: sym }),
          relVol: sig.relVol, relRange: sig.relRange,
        });
      }
    }
  }
  return { trades, sessions, gated };
}

// ---------------- TREND-PB simulation ----------------
function fridayAsOf(ms) { // most recent Friday 21:00 UTC at/before ms
  const d = new Date(ms);
  const dow = d.getUTCDay();
  const daysBack = (dow + 2) % 7; // Fri=5 → 0, Sat=6 → 1, Sun=0 → 2, ...
  const fri = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - daysBack * DAY + 21 * 3600_000;
  return fri <= ms ? fri : fri - 7 * DAY;
}

function runTrendPb() {
  const candidates = [];
  for (const sym of TREND_SYMBOLS) {
    let d1, h4;
    try { d1 = loadBars(sym, 'D1'); h4 = loadBars(sym, 'H4'); } catch { continue; }
    if (d1.length < LOOKBACKS_D[2] + 30 || h4.length < 100) continue;
    let openUntil = 0; // one position per symbol: skip signals while a trade is open
    const weekDir = new Map(); // fridayTs → direction (weekly recompute, SPEC §2)
    for (let i = 60; i < h4.length; i++) {
      const now = h4[i].t + 4 * 3600_000; // H4 bar close time
      if (now <= openUntil) continue;
      if (isSaturdayUtc(now)) continue;
      const fri = fridayAsOf(now);
      if (!weekDir.has(fri)) {
        const closes = d1.filter(b => b.t + DAY <= fri).map(b => b.c);
        weekDir.set(fri, trendScore(closes).direction);
      }
      if (!weekDir.get(fri)) continue;
      const d1Closed = d1.filter(b => b.t + DAY <= now);
      const h4Closed = h4.slice(0, i + 1);
      const sig = computeTrendPbSignal({ d1Bars: d1Closed, h4Bars: h4Closed });
      if (sig.status !== 'signal' || sig.direction !== weekDir.get(fri)) continue;
      // resolve on subsequent H4 bars — brackets ride nights/weekends (Gate D→B decision)
      const walk = h4.slice(i + 1);
      const res = simulateBracket({ bars: walk, direction: sig.direction, entry: sig.entry, sl: sig.sl, tp: sig.tp });
      if (res.outcome === 'open') continue; // still running at data end — drop
      const nights = Math.max(0, Math.floor((res.exitTs - sig.entryTs) / DAY));
      const swapR = (sig.entry * SWAP_BPS_PER_NIGHT(sym) / 10000) * nights / Math.abs(sig.entry - sig.sl);
      candidates.push({
        family: 'TREND-PB', sym, direction: sig.direction,
        entry: sig.entry, sl: sig.sl, tp: sig.tp, entryTs: sig.entryTs,
        exitTs: res.exitTs, outcome: res.outcome, grossR: res.grossR,
        netR: netR({ grossR: res.grossR, entry: sig.entry, sl: sig.sl, symbol: sym }) - swapR,
        nights,
      });
      openUntil = res.exitTs;
    }
  }
  // Portfolio caps (SPEC §2): max 6 concurrent, ≤2 per currency, chronological
  candidates.sort((a, b) => a.entryTs - b.entryTs);
  const open = [];
  const ccyOf = sym => sym.length === 6 ? [sym.slice(0, 3), sym.slice(3)] : [sym];
  const trades = [];
  for (const t of candidates) {
    for (let j = open.length - 1; j >= 0; j--) if (open[j].exitTs <= t.entryTs) open.splice(j, 1);
    if (open.length >= 6) continue;
    const ccys = ccyOf(t.sym);
    if (ccys.some(c => open.flatMap(o => ccyOf(o.sym)).filter(x => x === c).length >= 2)) continue;
    open.push(t); trades.push(t);
  }
  return { trades, candidates: candidates.length };
}

// ---------------- run phase ----------------
function runPhase() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const smorb = runSmorb();
  const trend = runTrendPb();
  const all = [...smorb.trades, ...trend.trades];
  fs.writeFileSync(path.join(OUT_DIR, 'ia_backtest_trades.jsonl'), all.map(t => JSON.stringify(t)).join('\n') + '\n');

  const summary = {};
  for (const [family, trades] of [['SMORB', smorb.trades], ['TREND-PB', trend.trades]]) {
    if (!trades.length) { summary[family] = { note: 'no trades' }; continue; }
    const tStart = Math.min(...trades.map(t => t.entryTs));
    const tEnd = Math.max(...trades.map(t => t.entryTs)) + 1;
    const { is, oos, folds } = splitFolds(trades, { tStart, tEnd });
    summary[family] = {
      window: { from: new Date(tStart).toISOString().slice(0, 10), to: new Date(tEnd).toISOString().slice(0, 10) },
      IS: computeMetrics(is),
      stage1: gradeStage1({ oos, folds }),
    };
  }
  summary.SMORB_funnel = { sessions: smorb.sessions, gatedOut: smorb.gated, trades: smorb.trades.length };
  summary.TRENDPB_funnel = { candidates: trend.candidates, afterPortfolioCaps: trend.trades.length };
  const outPath = path.join(OUT_DIR, 'ia_backtest_summary.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nwritten: ${outPath}`);
}

// ---------------- main ----------------
const mode = process.argv.includes('--fetch') ? 'fetch' : process.argv.includes('--run') ? 'run' : null;
if (!mode) { console.log('usage: institutional_backtest.mjs --fetch | --run'); process.exit(1); }
if (mode === 'fetch') await fetchPhase();
else runPhase();
process.exit(0);
