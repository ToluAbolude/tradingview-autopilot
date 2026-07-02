/**
 * fib_veto_probe.mjs — read-only diagnostic: print the fib-veto state and the
 * long/short verdicts for a basket of symbols. Run before/after deploying the
 * assertOrderSafety fib gate to sanity-check what it would block RIGHT NOW.
 *
 * Usage (VM, env sourced): node scripts/trading/fib_veto_probe.mjs [--sym=A,B,C]
 */
import { fibVetoState, checkFibVeto, pContinue } from './fib_veto.mjs';

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const SYMS = arg('sym', 'AUS200,NAS100,US30,HK50,XAUUSD,BTCUSD,ETHUSD,SOLUSD,GBPJPY,EURUSD,GBPAUD,EURGBP,WTI,COPPER,XAGUSD').split(',');

const bridge = await import('./broker_ctrader.mjs');
await bridge.connect();

console.log('symbol     status      leg     maxDepth  P(cont)  LONG        SHORT');
for (const sym of SYMS) {
  let line;
  try {
    const bars = await bridge.getTrendbars(sym, { period: 'H1', fromMs: Date.now() - 40 * 24 * 3600 * 1000, windowDays: 20 });
    const st = fibVetoState(bars);
    const v = d => checkFibVeto(st, d).vetoed ? 'VETO ⛔' : 'pass';
    line = `${sym.padEnd(10)} ${st.status.padEnd(11)} ${(st.dir > 0 ? '▲ up' : st.dir < 0 ? '▼ down' : '—').padEnd(7)} ${(st.depth * 100).toFixed(1).padStart(6)}%  ${String(st.status === 'none' ? '—' : pContinue(st.depth)).padStart(5)}%   ${v('long').padEnd(10)}  ${v('short')}`;
  } catch (e) {
    line = `${sym.padEnd(10)} ERROR ${e.message.slice(0, 70)}`;
  }
  console.log(line);
}
process.exit(0);
