// Cross-sectional OOS test (FINDINGS §4 widened universe): the frozen config
// (relVol>=1.5, costR<=0.2, natural session, 2R brackets) applied to symbols it
// was NEVER fitted on. Their entire history is out-of-sample by construction.
// Includes a 1.5x cost stress (their cost entries are assumed, not measured).
import fs from 'node:fs';
import { roundTripCostPrice } from './lib.mjs';
import { computeMetrics, gradeStage1 } from './metrics.mjs';

const NEW = { UK100: 'LONDON', EUSTX50: 'LONDON', FRA40: 'LONDON', GER40: 'LONDON', JP225: 'ASIA', AUS200: 'ASIA', HK50: 'ASIA' };
const PATHJ = process.env.IA_TRADES || '/home/ubuntu/trading-data/ia_cache/ia_backtest_trades.jsonl';
const all = fs.readFileSync(PATHJ, 'utf8').trim().split('\n').map(JSON.parse).filter(t => t.family === 'SMORB');

const sel = all.filter(t => NEW[t.sym] && t.session === NEW[t.sym] && t.relVol >= 1.5)
  .map(t => ({ ...t, costR: roundTripCostPrice(t.sym, t.entry) / Math.abs(t.entry - t.sl) }))
  .filter(t => t.costR <= 0.2);

if (!sel.length) { console.log('no qualifying trades'); process.exit(0); }
const t0 = Math.min(...sel.map(t => t.entryTs)), t1 = Math.max(...sel.map(t => t.entryTs)) + 1;
const foldMs = (t1 - t0) / 4;
const folds = Array.from({ length: 4 }, (_, i) => sel.filter(t => t.entryTs >= t0 + i * foldMs && t.entryTs < t0 + (i + 1) * foldMs));

console.log('== per-symbol (frozen config, ALL history = OOS) ==');
for (const sym of Object.keys(NEW)) {
  const ts = sel.filter(t => t.sym === sym);
  if (!ts.length) { console.log(sym.padEnd(8), 'no trades'); continue; }
  const m = computeMetrics(ts);
  console.log(sym.padEnd(8), JSON.stringify({ n: m.n, pf: +m.pf.toFixed(2), expR: +m.expR.toFixed(3), wr: +m.wr.toFixed(2) }));
}

const g = gradeStage1({ oos: sel, folds });
console.log('\n== COMBINED cross-sectional OOS ==');
console.log(JSON.stringify({ n: g.oosMetrics.n, pf: +g.oosMetrics.pf.toFixed(2), expR: +g.oosMetrics.expR.toFixed(3), wr: +g.oosMetrics.wr.toFixed(2), payoff: +g.oosMetrics.payoff.toFixed(2), totalR: +g.oosMetrics.totalR.toFixed(1), maxDD: +g.oosMetrics.maxDD.toFixed(1) }));
console.log('fold PFs:', g.foldMetrics.map(f => +(f.pf || 0).toFixed(2)), ' STAGE1-style PASS:', g.pass);

const stressed = sel.map(t => ({ ...t, netR: t.netR - 0.5 * t.costR }));
const ms = computeMetrics(stressed);
console.log('\n== 1.5x cost stress ==');
console.log(JSON.stringify({ n: ms.n, pf: +ms.pf.toFixed(2), expR: +ms.expR.toFixed(3), totalR: +ms.totalR.toFixed(1) }));
