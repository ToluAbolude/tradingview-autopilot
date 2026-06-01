/**
 * pnl_reconcile.mjs — 100% cTrader, account-wide, reconciled to the broker ledger.
 *
 * Pulls EVERY closing deal (no symbol filter) and reads the `balance` field
 * cTrader stamps on each deal = the real account balance AFTER that deal. The
 * balance curve is the broker's own ledger — not a sum we compute — so it can't
 * be wrong from a missed symbol. We then cross-check vs the live balance.
 *
 * Usage: node scripts/trading/pnl_reconcile.mjs --from=2026-04-01
 */
const FROM = (process.argv.find(a => a.startsWith('--from=')) || '').split('=')[1] || '2026-04-01';
const fromMs = Date.parse(`${FROM}T00:00:00.000Z`);

const day  = ms => new Date(ms).toISOString().slice(0, 10);
const wk   = ms => { const d = new Date(ms); const off = (d.getUTCDay()+6)%7; return day(ms - off*864e5); };
const usd  = n => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const b = await import('./broker_ctrader.mjs');
  await b.connect();

  const live = await b.getEquity().catch(() => ({}));
  const deals = await b.getAllClosedDeals(fromMs);
  // Order by the broker's own balance sequence (authoritative), fall back to time.
  deals.sort((x, y) => (x.balanceVersion - y.balanceVersion) || (x.execTs - y.execTs));

  if (!deals.length) { console.log('No closing deals returned by cTrader for this window.'); process.exit(0); }

  const startBal = deals[0].balance - deals[0].net;     // balance just BEFORE first deal
  const endBal   = deals[deals.length - 1].balance;     // balance after last deal
  const sumNet   = deals.reduce((s, d) => s + d.net, 0);
  const peak     = Math.max(startBal, ...deals.map(d => d.balance));
  const trough   = Math.min(startBal, ...deals.map(d => d.balance));

  console.log(`\n=== cTrader LEDGER RECONCILIATION since ${FROM} ===`);
  console.log(`Closing deals pulled (whole account, no filter): ${deals.length}`);
  console.log(`First deal: ${day(deals[0].execTs)}   Last deal: ${day(deals[deals.length-1].execTs)}`);
  console.log('');
  console.log(`Balance BEFORE first deal : ${usd(startBal)}`);
  console.log(`Peak balance              : ${usd(peak)}`);
  console.log(`Trough balance            : ${usd(trough)}`);
  console.log(`Balance AFTER last deal   : ${usd(endBal)}`);
  console.log(`Live balance (ProtoOATraderReq): ${usd(live.balance || 0)}`);
  console.log(`Net of all closing deals  : ${usd(sumNet)}`);
  console.log(`Ledger check (end-start)  : ${usd(endBal - startBal)}  ${Math.abs((endBal-startBal)-sumNet) < 1 ? '✓ matches net' : '⚠ differs from net (deposits/resets?)'}`);
  console.log(`Live vs ledger end        : ${Math.abs((live.balance||0) - endBal) < 5 ? '✓ matches' : `⚠ off by ${usd((live.balance||0)-endBal)} (open float or post-window activity)`}`);

  // Weekly: closing balance + net
  const byWk = new Map();
  for (const d of deals) {
    const k = wk(d.execTs);
    const c = byWk.get(k) || { net: 0, n: 0, w: 0, lastBal: d.balance, lastVer: d.balanceVersion };
    c.net += d.net; c.n++; if (d.net > 0) c.w++;
    if (d.balanceVersion >= c.lastVer) { c.lastBal = d.balance; c.lastVer = d.balanceVersion; }
    byWk.set(k, c);
  }
  console.log('\nWeek (Mon) | Trades |  WR  |   Net P&L   | Balance @ wk-end');
  console.log('-----------+--------+------+-------------+-----------------');
  for (const k of [...byWk.keys()].sort()) {
    const c = byWk.get(k);
    console.log(`${k} | ${String(c.n).padStart(6)} | ${String(c.n?Math.round(c.w/c.n*100):0).padStart(3)}% | ${usd(c.net).padStart(11)} | ${usd(c.lastBal).padStart(15)}`);
  }

  // Per-symbol totals (complete)
  const bySym = new Map();
  for (const d of deals) { const c = bySym.get(d.symbolName) || { net:0, n:0 }; c.net += d.net; c.n++; bySym.set(d.symbolName, c); }
  console.log('\nSymbol        |   Net P&L    | Trades');
  console.log('--------------+--------------+-------');
  for (const [s,c] of [...bySym.entries()].sort((a,b)=>a[1].net-b[1].net))
    console.log(`${s.padEnd(13)} | ${usd(c.net).padStart(12)} | ${String(c.n).padStart(5)}`);

  console.log('');
  console.log(`SUMMARY: started ${usd(startBal)} → peaked ${usd(peak)} → now ${usd(endBal)}.  Net over period: ${usd(sumNet)}.`);
  process.exit(0);
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
