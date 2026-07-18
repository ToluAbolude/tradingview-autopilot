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
const SMORB_SYMBOLS = [
  'XAUUSD', 'US30', 'NAS100', 'SPX500', 'BTCUSD', 'ETHUSD',
  // Widened universe (FINDINGS §4) — cross-sectional OOS: the frozen config
  // (relVol>=1.5, costR<=0.2, natural session) never saw these symbols.
  'UK100', 'JP225', 'AUS200', 'EUSTX50', 'FRA40', 'GER40', 'HK50',
];
// Family A redesign cycle 2 (FINAL): majors + gold only — deepest history,
// lowest measured costs; wide crosses, short-history indices and pricey crypto
// dropped. (Fetch still caches the full list for paper/fidelity use.)
const TREND_SYMBOLS = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDCHF',
  'EURGBP', 'GBPJPY', 'AUDJPY', 'EURJPY', 'XAUUSD',
];
const FETCH_TREND_SYMBOLS = [
  ...TREND_SYMBOLS, 'NZDCAD', 'GBPNZD', 'US30', 'NAS100', 'SPX500', 'BTCUSD', 'ETHUSD',
];
const M5_YEARS = 3, DEEP_YEARS = 6;
const CACHE_DIR = process.env.IA_CACHE_DIR
  || (fs.existsSync('/home/ubuntu/trading-data') ? '/home/ubuntu/trading-data/ia_cache' : path.join(process.cwd(), 'data', 'ia_cache'));
const OUT_DIR = process.env.IA_OUT_DIR || CACHE_DIR;

// Swap placeholder for multi-day holds (SPEC §3): bps of entry price per night.
const SWAP_BPS_PER_NIGHT = sym =>
  ['BTCUSD', 'ETHUSD'].includes(sym) ? 3 : ['US30', 'NAS100', 'SPX500'].includes(sym) ? 2 : 1;

const cachePath = (sym, tf) => path.join(CACHE_DIR, `${sym}_${tf}.json`);
// Sanity filter: the feed can contain mis-scaled bars (seen live: NZDCAD H4 bar
// opening at 23.1 on a 0.81 pair → one fake −763R trade). Drop non-positive
// prices and bars opening >50% away from the previous close.
function saneBars(bars) {
  const out = []; let prev = null;
  for (const b of bars) {
    if (!(b.o > 0 && b.h > 0 && b.l > 0 && b.c > 0 && b.h >= b.l)) continue;
    if (prev && (b.o > prev.c * 1.5 || b.o < prev.c * 0.5)) continue;
    out.push(b); prev = b;
  }
  return out;
}
const loadBars = (sym, tf) => saneBars(JSON.parse(fs.readFileSync(cachePath(sym, tf), 'utf8')));
const isSaturdayUtc = ms => new Date(ms).getUTCDay() === 6;

// ---------------- fetch phase (VM) ----------------
async function fetchPhase() {
  const { getTrendbars } = await import('../broker_ctrader.mjs');
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const jobs = [];
  for (const s of SMORB_SYMBOLS) jobs.push([s, 'M5', M5_YEARS]);
  for (const s of FETCH_TREND_SYMBOLS) { jobs.push([s, 'H4', DEEP_YEARS]); jobs.push([s, 'D1', DEEP_YEARS]); }
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
// Family B redesign cycle 1: every SMORB symbol is evaluated at EVERY session —
// the in-play gate (not a fixed assignment) decides which symbol-session-days
// trade. IS analysis showed the edge is dose-dependent in relVol; more candidate
// sessions buy sample size at strict gates.
function sessionOpensFor(sym, dayStartMs) {
  const opens = [];
  for (const s of SESSIONS) {
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
    // OR stats history is PER SESSION — Asia volume norms differ from NY norms;
    // mixing them would corrupt relVol.
    const orHistoryBySession = new Map();
    for (const day of days) {
      for (const { name, openMs } of sessionOpensFor(sym, day)) {
        if (!orHistoryBySession.has(name)) orHistoryBySession.set(name, []);
        const orHistory = orHistoryBySession.get(name);
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
      // resolve on subsequent H4 bars — brackets ride nights/weekends (Gate D→B
      // decision) BUT the position follows the SIGNAL: when the weekly trend is
      // no longer unanimous in the trade's direction, exit at that H4 close.
      // (Family A redesign cycle 1: the first run held dead theses for 600+
      // nights of swap because only the bracket could exit.)
      let res = null;
      for (let j = i + 1; j < h4.length; j++) {
        const b = h4[j];
        const one = simulateBracket({ bars: [b], direction: sig.direction, entry: sig.entry, sl: sig.sl, tp: sig.tp });
        if (one.outcome !== 'open') { res = one; break; }
        const fri2 = fridayAsOf(b.t + 4 * 3600_000);
        if (!weekDir.has(fri2)) {
          const closes = d1.filter(x => x.t + DAY <= fri2).map(x => x.c);
          weekDir.set(fri2, trendScore(closes).direction);
        }
        if (weekDir.get(fri2) !== sig.direction) {
          const gross = (sig.direction === 'long' ? b.c - sig.entry : sig.entry - b.c) / Math.abs(sig.entry - sig.sl);
          res = { outcome: 'flip', exitPrice: b.c, exitTs: b.t, grossR: gross };
          break;
        }
      }
      if (!res) continue; // still running at data end — drop
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
