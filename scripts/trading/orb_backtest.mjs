/**
 * orb_backtest.mjs — ISOLATED Opening Range Breakout backtest.
 *
 * Unlike backtest.mjs (which scores the whole confluence engine), this measures
 * ORB *on its own*, per instrument, so we can pick which instruments + sessions
 * actually have an ORB edge instead of guessing. This is the research step before
 * building a dedicated time-gated ORB runner.
 *
 * Method (per instrument, per UTC trading day in the loaded bar history):
 *   1. Opening range = first ORB_DURATION_MIN minutes after that instrument's
 *      session open (UTC). orHigh / orLow = high/low of those bars.
 *   2. Entry = first bar that CLOSES beyond the OR (above orHigh = long,
 *      below orLow = short). Only the FIRST breakout of the day is taken.
 *   3. SL = opposite OR boundary. risk = |entry - SL|. TP = entry ± R*risk.
 *   4. Walk forward to SL / TP / hard session close (HOLD_UNTIL_UTC). If neither
 *      target hit, exit at the close of the last in-window bar.
 *   5. Breakout must occur within BREAKOUT_WINDOW_H hours of the OR close.
 *
 * Outcomes are expressed in R (risk multiples) so instruments are comparable.
 * Tested at TP = 1R and 2R. Reports per-instrument WR / PF / net-R + sample size.
 *
 * Sample size is bounded by how many bars TradingView has loaded — the report
 * prints `days`/`n` per instrument so low-confidence rows are obvious.
 *
 * Usage (on VM, TradingView on CDP 9222):
 *   node scripts/trading/orb_backtest.mjs
 *   node scripts/trading/orb_backtest.mjs --tf=5 --bars=1500
 */
import { getBars, setChart, waitForBars } from './setup_finder.mjs';
import { writeFileSync } from 'fs';
import { join } from 'path';
import os from 'os';

const IS_LINUX = os.platform() === 'linux';
const OUT_DIR  = IS_LINUX ? '/home/ubuntu/trading-data' : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';

const TF       = (process.argv.find(a => a.startsWith('--tf='))   || '').split('=')[1] || '5';
const REQ_BARS = parseInt((process.argv.find(a => a.startsWith('--bars=')) || '').split('=')[1]) || 1500;
const MIN_BARS = 120;
// Data source: 'ctrader' (deep history, default) or 'tv' (~300 loaded bars).
const SOURCE   = (process.argv.find(a => a.startsWith('--source=')) || '').split('=')[1] || 'ctrader';
const DAYS     = parseInt((process.argv.find(a => a.startsWith('--days=')) || '').split('=')[1]) || 90;
const TF_TO_PERIOD = { '1':'M1','5':'M5','15':'M15','30':'M30','60':'H1' };

const ORB_DURATION_MIN   = 30;
const BREAKOUT_WINDOW_H  = 4;     // breakout must fire within 4h of OR close
const HOLD_UNTIL_UTC     = 20;    // hard session close (matches eod_close.mjs 20:00 UTC)
const R_TARGETS          = [1, 2];

// Test EVERY instrument at EVERY session open, so the best instrument×session
// pairing is found by data instead of assumed. The 3 canonical opens (UTC):
const SESSIONS = { ASIA: '00:00', LONDON: '07:00', NY: '13:30' };

// Broad universe (cTrader-supported names). Crypto omitted — 24/7, no session open.
const INSTRUMENTS = [
  'NAS100', 'US30', 'SPX500', 'UK100', 'AUS200', 'JP225',
  'XAUUSD', 'XAGUSD', 'WTI',
  'EURUSD', 'GBPUSD', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD', 'USDJPY',
  'EURJPY', 'GBPJPY', 'AUDJPY', 'NZDJPY', 'EURGBP',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const dayKey = ts => new Date(ts).toISOString().slice(0, 10);

// ── ORB simulation for one instrument ────────────────────────────────────────
function backtestInstrument(rawBars, openUTC) {
  const tfMin = parseInt(TF, 10);
  const [oh, om] = openUTC.split(':').map(Number);

  // TradingView bar timestamps are unix SECONDS — normalize to ms for Date math.
  const bars = rawBars.map(b => ({ ...b, t: b.t < 1e12 ? b.t * 1000 : b.t }));

  // Group bars by UTC day
  const byDay = new Map();
  for (const b of bars) {
    const k = dayKey(b.t);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(b);
  }

  // Per R-target accumulators
  const acc = {};
  for (const R of R_TARGETS) acc[R] = { n: 0, w: 0, l: 0, grossWin: 0, grossLoss: 0, netR: 0 };
  let daysWithBreakout = 0, daysEvaluated = 0;
  const minOrBars = Math.max(2, Math.floor(ORB_DURATION_MIN / tfMin) - 1); // tolerate 1 missing

  for (const [k, dayBars] of byDay) {
    const d = new Date(k + 'T00:00:00.000Z');
    const sessionStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), oh, om);
    const orEnd        = sessionStart + ORB_DURATION_MIN * 60 * 1000;
    const breakoutEnd  = orEnd + BREAKOUT_WINDOW_H * 3600 * 1000;
    const holdEnd      = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), HOLD_UNTIL_UTC, 0);

    const orBars = dayBars.filter(b => b.t >= sessionStart && b.t < orEnd);
    if (orBars.length < minOrBars) continue;       // not enough OR coverage this day
    daysEvaluated++;

    const orHigh = Math.max(...orBars.map(b => b.h));
    const orLow  = Math.min(...orBars.map(b => b.l));
    if (!(orHigh > orLow)) continue;

    // First close beyond OR within the breakout window
    const post = dayBars.filter(b => b.t >= orEnd && b.t <= breakoutEnd).sort((a, b) => a.t - b.t);
    let entryBar = null, dir = null;
    for (const b of post) {
      if (b.c > orHigh) { entryBar = b; dir = 'long';  break; }
      if (b.c < orLow)  { entryBar = b; dir = 'short'; break; }
    }
    if (!entryBar) continue;
    daysWithBreakout++;

    const entry = entryBar.c;
    const sl    = dir === 'long' ? orLow : orHigh;
    const risk  = Math.abs(entry - sl);
    if (!(risk > 0)) continue;

    // Forward bars until hard close
    const fwd = dayBars.filter(b => b.t > entryBar.t && b.t <= holdEnd).sort((a, b) => a.t - b.t);

    for (const R of R_TARGETS) {
      const tp = dir === 'long' ? entry + R * risk : entry - R * risk;
      let outcomeR = null;
      for (const b of fwd) {
        const hitSL = dir === 'long' ? b.l <= sl : b.h >= sl;
        const hitTP = dir === 'long' ? b.h >= tp : b.l <= tp;
        if (hitSL && hitTP) { outcomeR = -1; break; }     // both in one bar → assume SL first (conservative)
        if (hitSL) { outcomeR = -1; break; }
        if (hitTP) { outcomeR = R;  break; }
      }
      if (outcomeR === null) {
        const last = fwd.length ? fwd[fwd.length - 1].c : entry;
        outcomeR = (dir === 'long' ? (last - entry) : (entry - last)) / risk;
      }
      const a = acc[R];
      a.n++; a.netR += outcomeR;
      if (outcomeR > 0) { a.w++; a.grossWin += outcomeR; }
      else              { a.l++; a.grossLoss += Math.abs(outcomeR); }
    }
  }

  const out = { daysEvaluated, daysWithBreakout, byR: {} };
  for (const R of R_TARGETS) {
    const a = acc[R];
    out.byR[R] = {
      n: a.n, w: a.w, l: a.l,
      wr:  a.n ? Math.round(a.w / a.n * 1000) / 10 : 0,
      pf:  a.grossLoss > 0 ? Math.round(a.grossWin / a.grossLoss * 100) / 100 : (a.grossWin > 0 ? Infinity : 0),
      netR: Math.round(a.netR * 100) / 100,
      expR: a.n ? Math.round(a.netR / a.n * 100) / 100 : 0,   // expectancy per trade in R
    };
  }
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────
// Pull bars for one instrument from the chosen source.
async function fetchBars(sym, bridge) {
  if (SOURCE === 'ctrader') {
    const period = TF_TO_PERIOD[TF] || 'M5';
    const toMs = Date.now();
    const fromMs = toMs - DAYS * 24 * 60 * 60 * 1000;
    return bridge.getTrendbars(sym, { period, fromMs, toMs });
  }
  await setChart(sym.includes(':') ? sym : `BLACKBULL:${sym}`, TF);
  await sleep(400);
  return waitForBars(REQ_BARS, MIN_BARS, 4, 700);
}

// Pick the better target (1R vs 2R) for a result row, by expR.
function bestTarget(r) {
  const a = r.byR[1], b = r.byR[2];
  return b.expR > a.expR ? { R: 2, ...b } : { R: 1, ...a };
}

async function main() {
  console.log(`=== ORB INSTRUMENT×SESSION BACKTEST  (source=${SOURCE}, TF=${TF}m, OR=${ORB_DURATION_MIN}m, SL=opposite boundary, hold→${HOLD_UNTIL_UTC}:00 UTC) ===`);
  console.log(`${SOURCE === 'ctrader' ? `cTrader trendbars, last ${DAYS} days.` : `TradingView, up to ${REQ_BARS} loaded bars.`} Each instrument tested at all 3 session opens. ${new Date().toISOString()}\n`);

  let bridge = null;
  if (SOURCE === 'ctrader') {
    bridge = await import('./broker_ctrader.mjs');
    await bridge.connect();
  }
  const toMs = t => (t < 1e12 ? t * 1000 : t);

  const results = [];
  for (const sym of INSTRUMENTS) {
    try {
      const bars = await fetchBars(sym, bridge);
      if (!bars || bars.length < MIN_BARS) {
        console.log(`${sym.padEnd(8)} — only ${bars ? bars.length : 0} bars, skipped`);
        continue;
      }
      const span = `${dayKey(toMs(bars[0].t))}→${dayKey(toMs(bars[bars.length - 1].t))}`;
      const line = [`${sym.padEnd(8)} (${bars.length} bars, ${span})`];
      for (const [session, openUTC] of Object.entries(SESSIONS)) {
        const r = backtestInstrument(bars, openUTC);
        results.push({ sym, session, openUTC, bars: bars.length, span, ...r });
        const bt = bestTarget(r);
        line.push(`${session}: n=${String(bt.n).padStart(2)} best=${bt.R}R expR=${String(bt.expR).padStart(5)} wr=${String(bt.wr).padStart(4)}%`);
      }
      console.log('  ' + line.join('  |  '));
    } catch (e) {
      console.log(`${sym.padEnd(8)} — ERROR: ${(e.message || '').slice(0, 60)}`);
    }
    await sleep(300);
  }

  // Per-session ranking (best target per row, n>=10 for confidence)
  for (const session of Object.keys(SESSIONS)) {
    console.log(`\n=== ${session} OPEN (${SESSIONS[session]} UTC) — RANKED BY BEST-TARGET EXPECTANCY (n>=10) ===`);
    const rows = results.filter(r => r.session === session && Math.max(r.byR[1].n, r.byR[2].n) >= 10)
      .map(r => ({ sym: r.sym, bt: bestTarget(r) }))
      .sort((a, b) => b.bt.expR - a.bt.expR);
    for (const { sym, bt } of rows) {
      const verdict = bt.expR > 0.1 ? '✅ EDGE' : bt.expR > 0 ? '· marginal' : '🔴 negative';
      console.log(`  ${sym.padEnd(8)} ${bt.R}R  expR=${String(bt.expR).padStart(6)}  wr=${String(bt.wr).padStart(4)}%  pf=${String(bt.pf).padStart(5)}  n=${String(bt.n).padStart(2)}  ${verdict}`);
    }
  }

  // Best instrument per session (top positive-edge pick)
  console.log('\n=== BEST INSTRUMENT PER SESSION (positive edge only) ===');
  for (const session of Object.keys(SESSIONS)) {
    const top = results.filter(r => r.session === session && Math.max(r.byR[1].n, r.byR[2].n) >= 10)
      .map(r => ({ sym: r.sym, bt: bestTarget(r) }))
      .filter(x => x.bt.expR > 0)
      .sort((a, b) => b.bt.expR - a.bt.expR)[0];
    console.log(`  ${session.padEnd(7)} → ${top ? `${top.sym} @ ${top.bt.R}R (expR ${top.bt.expR}, wr ${top.bt.wr}%, n ${top.bt.n})` : 'no positive-edge instrument'}`);
  }

  const payload = { ts: new Date().toISOString(), tf: TF, daysWindow: DAYS, orMin: ORB_DURATION_MIN, breakoutWindowH: BREAKOUT_WINDOW_H, holdUntilUTC: HOLD_UNTIL_UTC, sessions: SESSIONS, results };
  writeFileSync(join(OUT_DIR, 'orb_backtest.json'), JSON.stringify(payload, null, 2));
  console.log(`\nSnapshot → ${join(OUT_DIR, 'orb_backtest.json')}`);
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.stack); process.exit(1); });
