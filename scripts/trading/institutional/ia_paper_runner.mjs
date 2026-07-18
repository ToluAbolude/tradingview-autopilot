// Institutional Algorithm — PAPER runner (Stage 2 / SPEC §4). SIGNAL-ONLY:
// this process NEVER places orders — it evaluates the same pure signal modules
// the backtest uses and appends signals to a jsonl for fidelity comparison.
// Cutover to live execution is a separate Phase C deliverable behind user "go".
//
// Usage (VM, via run_scanner_job.sh institutional/ia_paper_runner.mjs):
//   --smorb    evaluate active SMORB sessions now (cron every 5 min)
//   --trendpb  evaluate TREND-PB on the latest closed H4 (cron at H4 closes)
import fs from 'node:fs';
import path from 'node:path';
import { getTrendbars } from '../broker_ctrader.mjs';
import { SESSIONS, nyOpenUtcMs } from './lib.mjs';
import { computeSmorbSignal, orWindow, ENTRY_WINDOW_MS, OR_MINUTES } from './smorb.mjs';
import { computeTrendPbSignal } from './trendpb.mjs';

const DAY = 86400_000;
const OUT = process.env.IA_PAPER_LOG || '/home/ubuntu/trading-data/ia_paper_signals.jsonl';
const TREND_SYMBOLS = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDCHF',
  'EURGBP', 'GBPJPY', 'AUDJPY', 'EURJPY', 'NZDCAD', 'GBPNZD',
  'XAUUSD', 'US30', 'NAS100', 'SPX500', 'BTCUSD', 'ETHUSD',
];

function alreadyLogged(key) {
  if (!fs.existsSync(OUT)) return false;
  return fs.readFileSync(OUT, 'utf8').includes(`"key":"${key}"`);
}
function log(entry) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.appendFileSync(OUT, JSON.stringify(entry) + '\n');
  console.log('LOGGED', entry.key, entry.status);
}

async function runSmorb() {
  const now = Date.now();
  const dayStart = Math.floor(now / DAY) * DAY;
  for (const s of SESSIONS) {
    let openMs;
    if (s.openUTC) {
      const [hh, mm] = s.openUTC.split(':').map(Number);
      openMs = dayStart + (hh * 60 + mm) * 60_000;
    } else {
      const d = new Date(dayStart);
      openMs = nyOpenUtcMs(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    // only evaluate between OR completion and entry-window expiry
    if (now < openMs + OR_MINUTES * 60_000 || now > openMs + ENTRY_WINDOW_MS) continue;
    for (const sym of s.symbols) {
      const dateKey = new Date(openMs).toISOString().slice(0, 10);
      const key = `SMORB|${sym}|${s.name}|${dateKey}`;
      if (alreadyLogged(key)) continue;
      // bars: today + enough history for 20 prior sessions' OR stats
      const bars = await getTrendbars(sym, { period: 'M5', fromMs: openMs - 35 * DAY, toMs: now, windowDays: 5 });
      const priorStats = { vols: [], ranges: [] };
      for (let d = 34; d >= 1; d--) {
        const po = openMs - d * DAY;
        const or = orWindow(bars.filter(b => b.t >= po - 3600_000 && b.t < po + 3600_000), po);
        if (or.complete) { priorStats.vols.push(or.orVol); priorStats.ranges.push(or.orHigh - or.orLow); }
      }
      const sig = computeSmorbSignal({
        bars5m: bars.filter(b => b.t >= openMs), sessionOpenMs: openMs,
        priorOrStats: { vols: priorStats.vols.slice(-20), ranges: priorStats.ranges.slice(-20) },
      });
      // log signals AND gate-refusals (fidelity check needs both sides)
      if (sig.status === 'signal' || sig.status === 'no_gate') {
        log({ key, ts: now, family: 'SMORB', sym, session: s.name, ...sig });
      }
    }
  }
}

async function runTrendPb() {
  const now = Date.now();
  for (const sym of TREND_SYMBOLS) {
    const d1 = await getTrendbars(sym, { period: 'D1', fromMs: now - 420 * DAY, toMs: now, windowDays: 300 });
    const h4 = await getTrendbars(sym, { period: 'H4', fromMs: now - 60 * DAY, toMs: now, windowDays: 60 });
    const d1Closed = d1.filter(b => b.t + DAY <= now);
    const h4Closed = h4.filter(b => b.t + 4 * 3600_000 <= now);
    if (d1Closed.length < 260 || h4Closed.length < 10) continue;
    const sig = computeTrendPbSignal({ d1Bars: d1Closed, h4Bars: h4Closed });
    if (sig.status !== 'signal') continue;
    const key = `TRENDPB|${sym}|${sig.entryTs}`;
    if (alreadyLogged(key)) continue;
    log({ key, ts: now, family: 'TREND-PB', sym, ...sig });
  }
}

const mode = process.argv.includes('--smorb') ? 'smorb' : process.argv.includes('--trendpb') ? 'trendpb' : null;
if (!mode) { console.log('usage: ia_paper_runner.mjs --smorb | --trendpb'); process.exit(1); }
if (mode === 'smorb') await runSmorb();
else await runTrendPb();
process.exit(0);
