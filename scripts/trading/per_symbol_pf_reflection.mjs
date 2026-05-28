/**
 * per_symbol_pf_reflection.mjs
 * Nightly per-symbol Profit Factor audit against goal.json's minProfitFactor.
 *
 * Pulls last 30 days of cTrader closing deals (the authoritative source) and
 * computes per-symbol stats. Flags any symbol with PF below the goal threshold.
 *
 * Output:
 *   - Console table for the cron mail recipient.
 *   - JSON snapshot at trading-data/pf_reflection/latest.json
 *   - Appended JSONL history at trading-data/pf_reflection/history.jsonl
 *   - Updates blockedSymbols? No — per user direction, we DON'T auto-block.
 *     We only flag. Strategy decisions come from the human reviewing the report.
 *
 * Exit code:
 *   0 = all symbols meet threshold OR insufficient data
 *   1 = at least one active symbol below threshold (cron job can alert)
 *   2 = cTrader connectivity error
 *
 * Usage:
 *   node per_symbol_pf_reflection.mjs                  # 30d default
 *   node per_symbol_pf_reflection.mjs --days=14        # narrower window
 *   node per_symbol_pf_reflection.mjs --min-trades=5   # threshold for "active"
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import os from 'os';

const IS_LINUX  = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX
  ? '/home/ubuntu/trading-data'
  : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';

const GOAL_FILE   = join(DATA_ROOT, 'goal.json');
const OUT_DIR     = join(DATA_ROOT, 'pf_reflection');
const LATEST_FILE = join(OUT_DIR, 'latest.json');
const HISTORY     = join(OUT_DIR, 'history.jsonl');

const DAYS        = parseInt((process.argv.find(a => a.startsWith('--days=')) || '').split('=')[1]) || 30;
const MIN_TRADES  = parseInt((process.argv.find(a => a.startsWith('--min-trades=')) || '').split('=')[1]) || 5;

// Same symbol universe used by reconcile_trades_from_ctrader.mjs
const SYMBOLS = [
  'WTI','BRENT','COPPER',
  'XAUUSD','XAGUSD',
  'BTCUSD','ETHUSD','XRPUSD','SOLUSD','ADAUSD','LTCUSD','BNBUSD','DOTUSD','AVAXUSD',
  'NAS100','US30','SPX500','GER30','UK100','JPN225','AUS200',
  'EURUSD','GBPUSD','AUDUSD','NZDUSD','USDJPY','EURJPY','GBPJPY','AUDJPY','USDCAD','USDCHF','NZDCAD','NZDJPY',
];

async function pullPositions() {
  const bridge = await import('./broker_ctrader.mjs');
  await bridge.connect();
  const fromMs = Date.now() - DAYS * 24 * 60 * 60 * 1000;
  const byPos = new Map();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (const sym of SYMBOLS) {
    let attempt = 0;
    while (attempt < 3) {
      try {
        const r = await bridge.getRecentClosePnl(sym, fromMs);
        for (const d of (r.deals || [])) {
          const cur = byPos.get(d.positionId) || { symbol: sym, closeTs: d.execTs, side: d.tradeSide, deals: 0, net: 0 };
          cur.deals++;
          cur.net += d.net;
          if (d.execTs > cur.closeTs) cur.closeTs = d.execTs;
          byPos.set(d.positionId, cur);
        }
        break;
      } catch (e) {
        if (/rate limited|BLOCKED_PAYLOAD_TYPE/i.test(e.message) && attempt < 2) {
          attempt++;
          await sleep(2000 * attempt);
          continue;
        }
        break;
      }
    }
    await sleep(250);
  }
  return [...byPos.values()];
}

function perSymbolStats(positions) {
  const bySym = new Map();
  for (const p of positions) {
    const cur = bySym.get(p.symbol) || { sym: p.symbol, n: 0, w: 0, l: 0, flat: 0, grossWins: 0, grossLosses: 0, net: 0 };
    cur.n++;
    cur.net += p.net;
    if (p.net > 0)      { cur.w++; cur.grossWins   += p.net; }
    else if (p.net < 0) { cur.l++; cur.grossLosses += Math.abs(p.net); }
    else                  cur.flat++;
    bySym.set(p.symbol, cur);
  }
  return [...bySym.values()].map(s => ({
    ...s,
    wr:      s.n ? s.w / s.n : 0,
    avgWin:  s.w ? s.grossWins   / s.w : 0,
    avgLoss: s.l ? s.grossLosses / s.l : 0,
    pf:      s.grossLosses > 0 ? s.grossWins / s.grossLosses : (s.grossWins > 0 ? Infinity : 0),
  })).sort((a, b) => b.net - a.net);
}

function classify(stats, threshold) {
  // Three buckets:
  //   active_pass  — n >= MIN_TRADES AND pf >= threshold
  //   active_fail  — n >= MIN_TRADES AND pf <  threshold  (FLAG)
  //   insufficient — n <  MIN_TRADES (don't flag — need more data)
  const out = { active_pass: [], active_fail: [], insufficient: [] };
  for (const s of stats) {
    if (s.n < MIN_TRADES) out.insufficient.push(s);
    else if (s.pf >= threshold) out.active_pass.push(s);
    else out.active_fail.push(s);
  }
  return out;
}

function pfStr(pf) {
  if (pf === Infinity) return '   ∞ ';
  return pf.toFixed(2).padStart(5);
}

function printReport(report, threshold) {
  console.log(`=== PER-SYMBOL PF REFLECTION  (${DAYS}d, goal PF >= ${threshold.toFixed(1)})  ${new Date().toISOString()} ===`);
  console.log('');
  const rows = [...report.active_fail, ...report.active_pass, ...report.insufficient];
  console.log('Symbol   |   N |   W |   L |  WR  | avgWin   | avgLoss  |  PF   |   Net    | Status');
  console.log('---------+-----+-----+-----+------+----------+----------+-------+----------+--------');
  for (const s of rows) {
    let status;
    if (s.n < MIN_TRADES) status = 'insufficient (n<' + MIN_TRADES + ')';
    else if (s.pf >= threshold) status = 'OK';
    else status = '⚠ FLAG (PF<' + threshold.toFixed(1) + ')';
    console.log(
      s.sym.padEnd(8), '|',
      String(s.n).padStart(3), '|',
      String(s.w).padStart(3), '|',
      String(s.l).padStart(3), '|',
      ((s.wr * 100).toFixed(0) + '%').padStart(4), '|',
      ('$' + s.avgWin.toFixed(0)).padStart(8), '|',
      ('$' + s.avgLoss.toFixed(0)).padStart(8), '|',
      pfStr(s.pf), '|',
      ('$' + s.net.toFixed(0)).padStart(8), '|',
      status,
    );
  }
  console.log('---------+-----+-----+-----+------+----------+----------+-------+----------+--------');
  console.log('');
  console.log(`Active passing:    ${report.active_pass.length}`);
  console.log(`Active FLAGGED:    ${report.active_fail.length}`);
  console.log(`Insufficient data: ${report.insufficient.length} (need >= ${MIN_TRADES} trades to evaluate)`);
  if (report.active_fail.length > 0) {
    console.log('');
    console.log('Flagged symbols (consider per-symbol strategy review):');
    for (const s of report.active_fail) {
      console.log('  ' + s.sym + ' — PF=' + s.pf.toFixed(2) + ', WR=' + (s.wr*100).toFixed(0) + '%, net=$' + s.net.toFixed(0));
    }
  }
}

async function main() {
  const goal = existsSync(GOAL_FILE) ? JSON.parse(readFileSync(GOAL_FILE, 'utf8')) : {};
  const threshold = Number(goal.minProfitFactor || 2.0);

  let positions;
  try {
    positions = await pullPositions();
  } catch (e) {
    console.error('cTrader connectivity failed:', e.message);
    process.exit(2);
  }

  const stats = perSymbolStats(positions);
  const report = classify(stats, threshold);

  printReport(report, threshold);

  // Persist JSON snapshot + history
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const payload = {
    ts: new Date().toISOString(),
    daysWindow: DAYS,
    minTrades: MIN_TRADES,
    threshold,
    counts: {
      active_pass:  report.active_pass.length,
      active_fail:  report.active_fail.length,
      insufficient: report.insufficient.length,
    },
    flagged: report.active_fail.map(s => ({ sym: s.sym, pf: s.pf, wr: s.wr, n: s.n, net: s.net })),
    passing: report.active_pass.map(s => ({ sym: s.sym, pf: s.pf === Infinity ? null : s.pf, wr: s.wr, n: s.n, net: s.net })),
    insufficient: report.insufficient.map(s => ({ sym: s.sym, pf: s.pf === Infinity ? null : s.pf, wr: s.wr, n: s.n, net: s.net })),
  };
  writeFileSync(LATEST_FILE, JSON.stringify(payload, null, 2));
  appendFileSync(HISTORY, JSON.stringify(payload) + '\n');
  console.log('\nSnapshot → ' + LATEST_FILE);

  process.exit(report.active_fail.length > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(2); });
