// SMORB IS-only analysis (charter: calibration evidence may come from IS ONLY).
// Reads the backtest trade log; sweeps STRICTER gates by filtering (every trade
// carries its relVol/relRange, so tighter thresholds are exact subsets).
import fs from 'node:fs';

const PATHJ = process.env.IA_TRADES || '/home/ubuntu/trading-data/ia_cache/ia_backtest_trades.jsonl';
const trades = fs.readFileSync(PATHJ, 'utf8').trim().split('\n').map(JSON.parse).filter(t => t.family === 'SMORB');
const tStart = Math.min(...trades.map(t => t.entryTs));
const tEnd = Math.max(...trades.map(t => t.entryTs)) + 1;
const isEnd = tStart + (tEnd - tStart) * 0.6;
const IS = trades.filter(t => t.entryTs < isEnd);

const m = ts => {
  if (!ts.length) return { n: 0 };
  const rs = ts.map(t => t.netR);
  const w = rs.filter(r => r > 0), l = rs.filter(r => r <= 0);
  const gw = w.reduce((a, b) => a + b, 0), gl = Math.abs(l.reduce((a, b) => a + b, 0));
  return {
    n: ts.length,
    wr: +(w.length / ts.length).toFixed(2),
    expR: +(rs.reduce((a, b) => a + b, 0) / ts.length).toFixed(3),
    pf: +(gl > 0 ? gw / gl : 99).toFixed(2),
  };
};

console.log('IS n=' + IS.length, 'IS window ends', new Date(isEnd).toISOString().slice(0, 10));
console.log('\n== by symbol@session (IS) ==');
const keys = [...new Set(IS.map(t => t.sym + '@' + t.session))].sort();
for (const k of keys) console.log(k.padEnd(16), JSON.stringify(m(IS.filter(t => t.sym + '@' + t.session === k))));

console.log('\n== outcome mix (IS) ==');
for (const o of ['tp', 'sl', 'eod']) {
  const ts = IS.filter(t => t.outcome === o);
  const avg = ts.length ? ts.reduce((a, t) => a + t.netR, 0) / ts.length : 0;
  console.log(o.padEnd(4), String(ts.length).padStart(4), 'avgNetR', +avg.toFixed(2));
}

console.log('\n== gate sweep (IS): relVol x relRange ==');
for (const rv of [1.5, 2, 2.5, 3]) for (const rr of [1.0, 1.25, 1.5]) {
  console.log(`rv>=${rv} rr>=${rr}`.padEnd(16), JSON.stringify(m(IS.filter(t => t.relVol >= rv && t.relRange >= rr))));
}

console.log('\n== per symbol@session at rv>=2.5 rr>=1.25 (IS) ==');
for (const k of keys) {
  const ts = IS.filter(t => t.sym + '@' + t.session === k && t.relVol >= 2.5 && t.relRange >= 1.25);
  if (ts.length) console.log(k.padEnd(16), JSON.stringify(m(ts)));
}
