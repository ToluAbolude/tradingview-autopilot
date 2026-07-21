/**
 * pnl_history.mjs — forensic P&L history from cTrader closed deals.
 * Builds the daily equity curve, weekly buckets, per-symbol-per-period splits,
 * and the worst days, so we can see WHAT changed from profitable → losing.
 *
 * Usage: node scripts/trading/pnl_history.mjs --from=2026-04-01
 */
import os from 'os';

const FROM = (process.argv.find(a => a.startsWith('--from=')) || '').split('=')[1] || '2026-04-01';
const fromMs = Date.parse(`${FROM}T00:00:00.000Z`);

const dayKey  = ms => new Date(ms).toISOString().slice(0, 10);
const weekKey = ms => { const d = new Date(ms); const day = (d.getUTCDay() + 6) % 7; const mon = ms - day*864e5; return dayKey(mon); };
const money = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');

async function main() {
  const bridge = await import('./broker_ctrader.mjs');
  await bridge.connect();

  // Pull EVERY round-trip position since FROM from the unfiltered ledger.
  // The old version seeded a hardcoded symbol list and silently missed any
  // pair not on it — the 2026-07-20 -$2.5k day happened almost entirely on
  // crosses (GBPNZD/EURCAD/GBPCAD/EURAUD/GBPCHF/AUDNZD) the list lacked, so
  // this report showed -$304 while the account lost $2,485.
  const byPos = new Map();
  for (const d of await bridge.getAllClosedDeals(fromMs)) {
    const cur = byPos.get(d.positionId) || { symbol: d.symbolName, closeTs: d.execTs, net: 0 };
    cur.net += d.net;
    if (d.execTs > cur.closeTs) cur.closeTs = d.execTs;
    byPos.set(d.positionId, cur);
  }
  const trades = [...byPos.values()];
  console.log(`\n=== P&L HISTORY since ${FROM} — ${trades.length} round-trip trades ===\n`);

  // Weekly buckets
  const wk = new Map();
  for (const t of trades) {
    const k = weekKey(t.closeTs);
    const c = wk.get(k) || { n: 0, w: 0, l: 0, net: 0, gw: 0, gl: 0 };
    c.n++; c.net += t.net;
    if (t.net > 0) { c.w++; c.gw += t.net; } else if (t.net < 0) { c.l++; c.gl += Math.abs(t.net); }
    wk.set(k, c);
  }
  console.log('Week (Mon) | Trades |  WR  |   PF  |   Net P&L   |  Cumulative');
  console.log('-----------+--------+------+-------+-------------+------------');
  let cum = 0;
  for (const k of [...wk.keys()].sort()) {
    const c = wk.get(k); cum += c.net;
    const wr = c.n ? Math.round(c.w/c.n*100) : 0;
    const pf = c.gl > 0 ? (c.gw/c.gl).toFixed(2) : (c.gw>0?'inf':'0');
    console.log(`${k} | ${String(c.n).padStart(6)} | ${String(wr).padStart(3)}% | ${String(pf).padStart(5)} | ${money(c.net).padStart(11)} | ${money(cum).padStart(11)}`);
  }

  // Worst 10 days
  const dd = new Map();
  for (const t of trades) { const k = dayKey(t.closeTs); const c = dd.get(k) || { net:0, n:0, syms:{} }; c.net+=t.net; c.n++; c.syms[t.symbol]=(c.syms[t.symbol]||0)+t.net; dd.set(k,c); }
  console.log('\n=== WORST 10 DAYS ===');
  for (const [k,c] of [...dd.entries()].sort((a,b)=>a[1].net-b[1].net).slice(0,10)) {
    const top = Object.entries(c.syms).sort((a,b)=>a[1]-b[1]).slice(0,3).map(([s,v])=>`${s} ${money(v)}`).join(', ');
    console.log(`  ${k}  ${money(c.net).padStart(10)}  (${c.n} trades)  worst: ${top}`);
  }

  // Per-symbol, split April / May / late (last 14d)
  const now = Date.now(), cut14 = now - 14*864e5;
  const apr = t => t.closeTs < Date.parse('2026-05-01T00:00:00Z');
  const splitSym = new Map();
  for (const t of trades) {
    const c = splitSym.get(t.symbol) || { apr:0, may:0, late:0, n:0 };
    c.n++;
    if (apr(t)) c.apr += t.net; else c.may += t.net;
    if (t.closeTs >= cut14) c.late += t.net;
    splitSym.set(t.symbol, c);
  }
  console.log('\n=== PER-SYMBOL: April vs May+ vs last-14d (net) ===');
  console.log('Symbol   | April Net | May+ Net  | Last14d   | Trades');
  console.log('---------+-----------+-----------+-----------+-------');
  for (const [s,c] of [...splitSym.entries()].sort((a,b)=>(a[1].apr+a[1].may)-(b[1].apr+b[1].may))) {
    console.log(`${s.padEnd(8)} | ${money(c.apr).padStart(9)} | ${money(c.may).padStart(9)} | ${money(c.late).padStart(9)} | ${String(c.n).padStart(5)}`);
  }

  const total = trades.reduce((s,t)=>s+t.net,0);
  const aprTot = trades.filter(apr).reduce((s,t)=>s+t.net,0);
  console.log(`\nApril net: ${money(aprTot)}   |   May-onward net: ${money(total-aprTot)}   |   TOTAL: ${money(total)}`);
  process.exit(0);
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
