/**
 * morning_review.mjs — daily 06:00 UTC performance read + tuning proposals.
 * Runs ON THE VM (has cTrader creds + can edit live params). Emits a short read
 * to stdout (the cron wrapper emails it). Reads the cTrader ledger only.
 *
 * Actions:
 *   - Auto-BLOCKS a clearly-bleeding instrument (WR<30% AND net<0 over >=5 trades
 *     in the window) — the only auto-change the operator authorized.
 *   - PROPOSES (does NOT apply) risk / caps / threshold / kill-switch changes.
 *
 * Usage: node scripts/trading/morning_review.mjs --days=14
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import os from 'os';

const DAYS = parseInt((process.argv.find(a => a.startsWith('--days=')) || '').split('=')[1]) || 14;
const DATA_ROOT = os.platform() === 'linux' ? '/home/ubuntu/trading-data' : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const PARAMS_FILE = join(DATA_ROOT, 'trading_params.json');

const day  = ms => new Date(ms).toISOString().slice(0, 10);
const usd  = n => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

async function main() {
  const b = await import('./broker_ctrader.mjs');
  await b.connect();
  const fromMs = Date.now() - DAYS * 864e5;
  const deals = (await b.getAllClosedDeals(fromMs)).sort((x, y) => x.execTs - y.execTs);
  const live = await b.getEquity().catch(() => ({}));
  const params = existsSync(PARAMS_FILE) ? JSON.parse(readFileSync(PARAMS_FILE, 'utf8')) : {};

  if (!deals.length) { console.log(`Morning review: no closed deals in last ${DAYS}d. Balance ${usd(live.balance||0)}.`); process.exit(0); }

  // Overall + per-symbol + yesterday + balance trend
  const agg = (arr) => {
    const w = arr.filter(d => d.net > 0), l = arr.filter(d => d.net < 0);
    const gw = w.reduce((s, d) => s + d.net, 0), gl = Math.abs(l.reduce((s, d) => s + d.net, 0));
    return { n: arr.length, w: w.length, l: l.length, net: arr.reduce((s, d) => s + d.net, 0),
             wr: arr.length ? Math.round(w.length / arr.length * 100) : 0, pf: gl > 0 ? +(gw / gl).toFixed(2) : (gw > 0 ? Infinity : 0) };
  };
  const overall = agg(deals);
  const ystr = day(Date.now() - 864e5);
  const yest = agg(deals.filter(d => day(d.execTs) === ystr));
  const bal7Ago = (deals.find(d => d.execTs >= Date.now() - 7 * 864e5) || deals[0]).balance;
  const balNow = deals[deals.length - 1].balance;

  const bySym = new Map();
  for (const d of deals) { const c = bySym.get(d.symbolName) || []; c.push(d); bySym.set(d.symbolName, c); }
  const symStats = [...bySym.entries()].map(([s, arr]) => ({ sym: s, ...agg(arr) })).sort((a, b2) => a.net - b2.net);

  // Auto-block clear bleeders (authorized): WR<30% AND net<0 AND n>=5, not already blocked
  const blocked = new Set(params.blockedSymbols || []);
  const newlyBlocked = [];
  for (const s of symStats) {
    if (s.n >= 5 && s.net < 0 && s.wr < 30 && !blocked.has(s.sym)) { blocked.add(s.sym); newlyBlocked.push(s); }
  }
  if (newlyBlocked.length) {
    params.blockedSymbols = [...blocked];
    params._morning_review_note = `${new Date().toISOString().slice(0,10)} auto-blocked ${newlyBlocked.map(s=>s.sym).join(',')} (WR<30% & net<0 over >=5 trades)`;
    writeFileSync(PARAMS_FILE, JSON.stringify(params, null, 2));
  }

  // Edge verdict + proposals
  const edgePos = overall.net > 0 && overall.pf > 1;
  const proposals = [];
  if (!edgePos) {
    proposals.push(`Edge is NEGATIVE (${DAYS}d net ${usd(overall.net)}, WR ${overall.wr}%, PF ${overall.pf}). Bigger size compounds losses — consider CUTTING riskPct ${JSON.stringify(params.riskPct)} → [2,1.5,1] and re-arming the daily halt (maxDailyDrawdownPct 20 → 3).`);
    if (overall.wr < 35) proposals.push(`WR ${overall.wr}% < 35% — consider raising scoreThreshold ${params.scoreThreshold} → ${(params.scoreThreshold||9)+1}.`);
  } else {
    proposals.push(`Edge is POSITIVE (${DAYS}d net ${usd(overall.net)}, WR ${overall.wr}%, PF ${overall.pf}). Risk increase is justified here — could scale riskPct up while edge holds.`);
  }
  const ddAccel = (balNow - bal7Ago) < 0 && yest.net < 0;
  if (ddAccel) proposals.push(`⚠ Drawdown accelerating — 7d balance ${usd(bal7Ago)}→${usd(balNow)} and yesterday ${usd(yest.net)}.`);

  // ── Print the morning read ──
  console.log(`MORNING REVIEW — ${new Date().toISOString().slice(0,16)}Z (last ${DAYS}d, cTrader ledger)`);
  console.log('');
  console.log(`Balance: ${usd(balNow)}  (7d ago ${usd(bal7Ago)}, ${balNow-bal7Ago>=0?'+':''}${usd(balNow-bal7Ago)})`);
  console.log(`Yesterday (${ystr}): ${yest.n} trades, ${yest.w}W/${yest.l}L, net ${usd(yest.net)}`);
  console.log(`Last ${DAYS}d: ${overall.n} trades, WR ${overall.wr}%, PF ${overall.pf}, net ${usd(overall.net)}`);
  console.log(`Edge: ${edgePos ? '🟢 POSITIVE' : '🔴 NEGATIVE'}`);
  console.log('');
  console.log('Per symbol (worst first):');
  for (const s of symStats) console.log(`  ${s.sym.padEnd(8)} ${usd(s.net).padStart(8)}  ${s.n}tr ${s.wr}%WR`);
  console.log('');
  if (newlyBlocked.length) console.log(`AUTO-BLOCKED (clear bleeders): ${newlyBlocked.map(s=>`${s.sym} (${usd(s.net)}, ${s.wr}%WR, ${s.n}tr)`).join('; ')}`);
  else console.log('Auto-block: none triggered.');
  console.log('');
  console.log('PROPOSALS (not applied — reply to approve):');
  for (const p of proposals) console.log(`  • ${p}`);
  console.log('');
  console.log(`Current: riskPct ${JSON.stringify(params.riskPct)}, threshold ${params.scoreThreshold}, caps ${params.maxDailyTotal}/day ${params.maxDailyPerSymbol}/sym, halt ${params.maxDailyDrawdownPct}%, blocked [${(params.blockedSymbols||[]).join(',')}]`);
  process.exit(0);
}
main().catch(e => { console.error('morning_review FATAL:', e.message); process.exit(2); });
