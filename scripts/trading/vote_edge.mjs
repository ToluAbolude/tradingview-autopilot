/**
 * vote_edge.mjs — measure what each confluence vote is actually worth.
 *
 * The scoring table in setup_finder was hand-set and never fitted to outcomes, which
 * is the mechanical reason score bands aren't monotonic (7-8 lose, but 13-16 also
 * underperform). A score of 14 isn't 14 units of edge, it's whatever happened to stack.
 *
 * This joins the two halves that were never connected:
 *   - codes:    market_scanner.log logs every signal with its letter codes AND its
 *               entry/sl/tp   ("NEW [9] BTCUSD 15M LONG | Entry:.. SL:.. TP:.. | T,D,K")
 *   - outcomes: replayed against real cTrader M5 history via edge_replay.replay()
 *
 * Output is per-code expectancy: n, win rate, average R. A vote that fires often but
 * shows avgR at or below the population average is decoration — it inflates scores
 * without discriminating, and should be weighted down or removed.
 *
 * Usage (on VM, env loaded):
 *   node scripts/trading/vote_edge.mjs              # last 2000 signals
 *   node scripts/trading/vote_edge.mjs --limit 500
 *
 * Caveats inherit from edge_replay: M5 intrabar approximated SL-first, no spread or
 * slippage. Optimistic upper bound — so a vote that looks bad here IS bad.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { replay, stats } from './edge_replay.mjs';
import { getTrendbars } from './broker_ctrader.mjs';

const DATA_ROOT = os.platform() === 'linux' ? '/home/ubuntu/trading-data' : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const LOG = join(DATA_ROOT, 'market_scanner.log');
const LIMIT = Number(process.argv[process.argv.indexOf('--limit') + 1]) || 2000;

// "[ts] ... NEW [score] SYM TF DIR | Entry:E SL:S TP:T | A,B,C"
const LINE = /^\[(\S+)\][\s\S]*?NEW \[(\d+)\] (\S+) (\S+) (LONG|SHORT) \| Entry:([\d.]+) SL:([\d.]+) TP:([\d.]+).*?\| ([A-Za-z,\-]+)\s*$/;

function parseSignals() {
  if (!existsSync(LOG)) { console.error(`no ${LOG}`); process.exit(1); }
  const out = [];
  let lastTs = null;
  for (const raw of readFileSync(LOG, 'utf8').split('\n')) {
    const tsm = raw.match(/^\[(20\d\d-\d\d-\d\dT[\d:.]+Z)\]/);
    if (tsm) lastTs = Date.parse(tsm[1]);
    const m = raw.match(/NEW \[(\d+)\] (\S+) (\S+) (LONG|SHORT) \| Entry:([\d.]+) SL:([\d.]+) TP:([\d.]+)[^|]*\| ([A-Za-z,\-]+)\s*$/);
    if (!m || !lastTs) continue;
    const [, score, symbol, , dir, entry, sl, tp1, codes] = m;
    out.push({
      ts: lastTs, symbol, dir: dir.toLowerCase(), score: +score,
      entry: +entry, sl: +sl, tp1: +tp1,
      codes: [...new Set(codes.split(',').map(c => c.trim()).filter(Boolean))],
    });
  }
  return out.slice(-LIMIT);
}

const pct = x => (x * 100).toFixed(0).padStart(3) + '%';

async function main() {
  const signals = parseSignals();
  console.log(`Parsed ${signals.length} signals with codes from market_scanner.log\n`);
  if (!signals.length) return;

  const bySym = {};
  for (const s of signals) (bySym[s.symbol] ||= []).push(s);

  const rows = [];
  for (const [symbol, list] of Object.entries(bySym)) {
    let bars;
    try { bars = await getTrendbars(symbol, 'M5', 20000); }
    catch (e) { console.error(`  ${symbol}: no bars (${e.message}) — skipped`); continue; }
    if (!bars?.length) { console.error(`  ${symbol}: no bars — skipped`); continue; }
    for (const s of list) rows.push({ ...s, ...replay(s, bars) });
    process.stderr.write(`  ${symbol}: ${list.length} replayed\n`);
  }

  const base = stats(rows);
  if (!base) { console.log('nothing resolved'); return; }
  console.log(`\nPOPULATION  n=${base.n}  WR ${pct(base.wr)}  avgR ${base.avgR.toFixed(3)}  PF ${base.pf.toFixed(2)}\n`);

  const codes = [...new Set(rows.flatMap(r => r.codes))].sort();
  const table = [];
  for (const c of codes) {
    const withC = stats(rows.filter(r => r.codes.includes(c)));
    const without = stats(rows.filter(r => !r.codes.includes(c)));
    if (!withC || withC.n < 20) continue;               // too few to mean anything
    table.push({
      code: c, n: withC.n,
      fire: withC.n / base.n,
      wr: withC.wr, avgR: withC.avgR,
      lift: withC.avgR - (without ? without.avgR : base.avgR),   // the number that matters
    });
  }
  table.sort((a, b) => b.lift - a.lift);

  console.log('code      fire    n     WR    avgR    LIFT vs signals without it');
  for (const t of table) {
    const flag = t.lift <= 0 ? '  <- no edge' : '';
    console.log(`${t.code.padEnd(8)} ${pct(t.fire)} ${String(t.n).padStart(5)}  ${pct(t.wr)} ${t.avgR.toFixed(3).padStart(7)} ${(t.lift >= 0 ? '+' : '') + t.lift.toFixed(3)}${flag}`);
  }
  console.log('\nLIFT is the honest column: avgR WITH the vote minus avgR WITHOUT it.');
  console.log('A vote with high fire-rate and ~0 lift is a pedestal — it raises every score equally.');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
