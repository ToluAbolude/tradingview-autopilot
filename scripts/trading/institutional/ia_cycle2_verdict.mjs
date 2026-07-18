// Family B redesign cycle 2 (FINAL) — Asia cluster + cost-rationality floor.
// Pre-stated selection rule (written BEFORE looking at OOS):
//   sweep rv ∈ {1.5,2,2.5} × costFloorR ∈ {0.12,0.15,0.20} on IS ONLY;
//   eligible = configs whose projected OOS n (IS n × OOSwindow/ISwindow) ≥ 100;
//   pick the eligible config with the highest IS PF; grade OOS ONCE with it.
import fs from 'node:fs';
import { roundTripCostPrice } from './lib.mjs';
import { computeMetrics, gradeStage1 } from './metrics.mjs';

const PATHJ = process.env.IA_TRADES || '/home/ubuntu/trading-data/ia_cache/ia_backtest_trades.jsonl';
const all = fs.readFileSync(PATHJ, 'utf8').trim().split('\n').map(JSON.parse).filter(t => t.family === 'SMORB');
// IS/OOS boundary must match the engine's: 60% of the FULL family window
const tStart = Math.min(...all.map(t => t.entryTs));
const tEnd = Math.max(...all.map(t => t.entryTs)) + 1;
const isEnd = tStart + (tEnd - tStart) * 0.6;
const oosSpan = tEnd - isEnd, isSpan = isEnd - tStart;

const CLUSTER = new Set(['XAUUSD', 'NAS100', 'SPX500']);
const cluster = all.filter(t => CLUSTER.has(t.sym) && t.session === 'ASIA')
  .map(t => ({ ...t, costR: roundTripCostPrice(t.sym, t.entry) / Math.abs(t.entry - t.sl) }));

const IS = cluster.filter(t => t.entryTs < isEnd);
const OOS = cluster.filter(t => t.entryTs >= isEnd);

const conf = (ts, rv, floor) => ts.filter(t => t.relVol >= rv && t.costR <= floor);
console.log('== IS sweep (cluster: XAU/NAS100/SPX500 @ ASIA) ==');
let best = null;
for (const rv of [1.5, 2, 2.5]) for (const floor of [0.12, 0.15, 0.20]) {
  const ts = conf(IS, rv, floor);
  const m = computeMetrics(ts);
  const projOosN = Math.round((m.n || 0) * oosSpan / isSpan);
  const eligible = projOosN >= 100;
  console.log(`rv>=${rv} costR<=${floor}`.padEnd(20),
    JSON.stringify({ n: m.n, pf: +(m.pf || 0).toFixed(2), expR: +(m.expR || 0).toFixed(3), projOosN, eligible }));
  if (eligible && (!best || m.pf > best.m.pf)) best = { rv, floor, m };
}
if (!best) { console.log('\nNO ELIGIBLE CONFIG (projected OOS n < 100 everywhere) — Family B cannot meet the frozen n threshold on this data.'); process.exit(0); }
console.log(`\nPICKED (pre-stated rule): rv>=${best.rv} costR<=${best.floor} — IS PF ${best.m.pf.toFixed(2)}, IS n ${best.m.n}`);

const oosSel = conf(OOS, best.rv, best.floor);
const foldMs = oosSpan / 4;
const folds = Array.from({ length: 4 }, (_, i) =>
  oosSel.filter(t => t.entryTs >= isEnd + i * foldMs && t.entryTs < isEnd + (i + 1) * foldMs));
const g = gradeStage1({ oos: oosSel, folds });
console.log('\n== OOS VERDICT (single evaluation) ==');
console.log('OOS:', JSON.stringify({ n: g.oosMetrics.n, pf: +(g.oosMetrics.pf || 0).toFixed(2), expR: +(g.oosMetrics.expR || 0).toFixed(3), wr: +(g.oosMetrics.wr || 0).toFixed(2), payoff: +(g.oosMetrics.payoff || 0).toFixed(2), totalR: +(g.oosMetrics.totalR || 0).toFixed(1) }));
console.log('fold PFs:', g.foldMetrics.map(f => +(f.pf || 0).toFixed(2)));
console.log('checks:', JSON.stringify(g.checks, null, 1));
console.log('STAGE 1 PASS:', g.pass);
