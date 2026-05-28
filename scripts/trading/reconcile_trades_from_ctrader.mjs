/**
 * reconcile_trades_from_ctrader.mjs
 * 1. Pulls 90 days of cTrader closing deals (the authoritative source of truth).
 * 2. Aggregates per-position net PnL.
 * 3. Prints a per-symbol Profit Factor report.
 * 4. Updates trades.csv rows whose pnl differs from cTrader (the balance-delta
 *    bug over-attributed losses by ~3× on cluster days; this fixes the record).
 *
 * Matching strategy: for each trades.csv row with a result (W/L/VOID), find the
 * cTrader position with same symbol whose close timestamp is the closest match
 * within a ±24h window. If found and pnl differs by > $0.50, rewrite the row.
 *
 * Usage:
 *   node reconcile_trades_from_ctrader.mjs              # dry-run, report only
 *   node reconcile_trades_from_ctrader.mjs --apply      # write back to trades.csv
 *   node reconcile_trades_from_ctrader.mjs --days=30    # narrow window
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { join } from 'path';
import os from 'os';

const IS_LINUX = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX
  ? '/home/ubuntu/trading-data'
  : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';

const TRADES_CSV = join(DATA_ROOT, 'trade_log', 'trades.csv');
const BACKUP_DIR = join(DATA_ROOT, 'trade_log');

const APPLY = process.argv.includes('--apply');
const DAYS = parseInt((process.argv.find(a => a.startsWith('--days=')) || '').split('=')[1]) || 90;

const SYMBOLS = [
  'WTI','BRENT','COPPER',
  'XAUUSD','XAGUSD',
  'BTCUSD','ETHUSD','XRPUSD','SOLUSD','ADAUSD','LTCUSD','BNBUSD','DOTUSD','AVAXUSD',
  'NAS100','US30','SPX500','GER30','UK100','JPN225','AUS200',
  'EURUSD','GBPUSD','AUDUSD','NZDUSD','USDJPY','EURJPY','GBPJPY','AUDJPY','USDCAD','USDCHF','NZDCAD','NZDJPY',
];

// Scanner-side label → cTrader-side name (mirror of CTRADER_NAME_MAP in broker_ctrader.mjs)
const CSV_TO_CTRADER = { GER40: 'GER30', JP225: 'JPN225' };
// And the reverse so the CSV row can be matched even if it logged the cTrader name
const CTRADER_TO_CSV = Object.fromEntries(Object.entries(CSV_TO_CTRADER).map(([a, b]) => [b, a]));

async function pullCtraderPositions() {
  const bridge = await import('./broker_ctrader.mjs');
  await bridge.connect();
  const fromMs = Date.now() - DAYS * 24 * 60 * 60 * 1000;
  const byPos = new Map();  // positionId -> {symbol, closeTs, side, deals, net, gross}
  // cTrader rate-limits us if we burst >5/sec on ProtoOADealListReq. Throttle
  // with a 250ms pause between symbols. Retry once with backoff on rate-limit.
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (const sym of SYMBOLS) {
    let attempt = 0;
    while (attempt < 3) {
      try {
        const r = await bridge.getRecentClosePnl(sym, fromMs);
        for (const d of (r.deals || [])) {
          const cur = byPos.get(d.positionId) || {
            symbol: sym, closeTs: d.execTs, side: d.tradeSide,
            deals: 0, net: 0, gross: 0,
          };
          cur.deals++;
          cur.net   += d.net;
          cur.gross += d.gross;
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
  return [...byPos.entries()].map(([positionId, info]) => ({ positionId, ...info }));
}

function perSymbolPF(positions) {
  const bySym = new Map();
  for (const p of positions) {
    const cur = bySym.get(p.symbol) || { sym: p.symbol, n: 0, w: 0, l: 0, flat: 0, grossWins: 0, grossLosses: 0, net: 0 };
    cur.n++;
    cur.net += p.net;
    if (p.net > 0) { cur.w++; cur.grossWins += p.net; }
    else if (p.net < 0) { cur.l++; cur.grossLosses += Math.abs(p.net); }
    else cur.flat++;
    bySym.set(p.symbol, cur);
  }
  return [...bySym.values()].map(s => ({
    ...s,
    wr: s.n ? s.w / s.n : 0,
    avgWin: s.w ? s.grossWins / s.w : 0,
    avgLoss: s.l ? s.grossLosses / s.l : 0,
    pf: s.grossLosses > 0 ? s.grossWins / s.grossLosses : (s.grossWins > 0 ? Infinity : 0),
  })).sort((a, b) => b.net - a.net);
}

function printPFReport(symStats) {
  console.log('\n=== PER-SYMBOL PROFIT FACTOR (cTrader truth, ' + DAYS + 'd) ===');
  console.log('Symbol   |  N  |  W  |  L  |  WR  |  avgWin  |  avgLoss |  PF   | Net');
  console.log('---------+-----+-----+-----+------+----------+----------+-------+-----------');
  let totalGW = 0, totalGL = 0, totalNet = 0;
  for (const s of symStats) {
    totalGW += s.grossWins;
    totalGL += s.grossLosses;
    totalNet += s.net;
    const pfDisplay = s.pf === Infinity ? '   ∞ ' : s.pf.toFixed(2).padStart(5);
    const flag = s.pf >= 2.0 ? '✓' : (s.pf >= 1.0 ? '·' : '✗');
    console.log(
      flag, s.sym.padEnd(7), '|',
      String(s.n).padStart(3), '|',
      String(s.w).padStart(3), '|',
      String(s.l).padStart(3), '|',
      ((s.wr * 100).toFixed(0) + '%').padStart(4), '|',
      ('$' + s.avgWin.toFixed(0)).padStart(8), '|',
      ('$' + s.avgLoss.toFixed(0)).padStart(8), '|',
      pfDisplay, '|',
      ('$' + s.net.toFixed(0)).padStart(8),
    );
  }
  console.log('---------+-----+-----+-----+------+----------+----------+-------+-----------');
  const grandPF = totalGL > 0 ? totalGW / totalGL : Infinity;
  console.log(' TOTAL   |     |     |     |      |          |          |',
    (grandPF === Infinity ? '   ∞' : grandPF.toFixed(2).padStart(5)), '|',
    ('$' + totalNet.toFixed(0)).padStart(8));
  console.log(`\nLegend: ✓ = PF ≥ 2.0 (goal)   · = PF 1.0–1.99   ✗ = PF < 1.0 (losing)`);
}

function parseCsvLine(line) {
  // Simple CSV parse — notes column may contain commas inside it. Format is fixed at 13 columns.
  const parts = line.split(',');
  if (parts.length < 13) return null;
  const notes = parts.slice(12).join(',');  // re-join any commas that landed in notes
  return {
    date: parts[0], session: parts[1], symbol: parts[2], tf: parts[3],
    direction: parts[4], score: parts[5], entry: parts[6], sl: parts[7],
    tp: parts[8], rr: parts[9], result: parts[10], pnl: parts[11], notes,
  };
}

function rowToCsv(r) {
  return [r.date, r.session, r.symbol, r.tf, r.direction, r.score, r.entry, r.sl, r.tp, r.rr, r.result, r.pnl, r.notes].join(',');
}

function reconcileCsv(positions) {
  if (!existsSync(TRADES_CSV)) {
    console.log(`\ntrades.csv not found at ${TRADES_CSV} — skip reconcile.`);
    return { updated: 0, unchanged: 0, unmatched: 0 };
  }
  const cutoffMs = Date.now() - DAYS * 24 * 60 * 60 * 1000;
  const allLines = readFileSync(TRADES_CSV, 'utf8').split('\n');
  const header = allLines[0];
  const rows = allLines.slice(1).map(parseCsvLine);

  let updated = 0, unchanged = 0, unmatched = 0;
  const updates = [];   // for the report

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    if (r.symbol === 'NONE' || !r.symbol) continue;
    if (!r.result || !['W', 'L', 'VOID'].includes(r.result.trim())) continue;
    const rowTs = new Date(r.date).getTime();
    if (isNaN(rowTs) || rowTs < cutoffMs) continue;

    // Match: cTrader name might differ (GER40 vs GER30). Try both.
    const candidateSyms = [r.symbol, CSV_TO_CTRADER[r.symbol]].filter(Boolean);
    const candidates = positions.filter(p =>
      candidateSyms.includes(p.symbol) ||
      candidateSyms.includes(CTRADER_TO_CSV[p.symbol])
    );

    if (candidates.length === 0) { unmatched++; continue; }

    // Pick the cTrader position whose close timestamp is closest to row's
    // trade-time, within a ±24h window.
    candidates.sort((a, b) => Math.abs(a.closeTs - rowTs) - Math.abs(b.closeTs - rowTs));
    const best = candidates[0];
    if (Math.abs(best.closeTs - rowTs) > 24 * 60 * 60 * 1000) { unmatched++; continue; }

    const truthPnl = Math.round(best.net * 100) / 100;
    const csvPnl = parseFloat(r.pnl) || 0;
    const drift = Math.abs(truthPnl - csvPnl);
    if (drift < 0.50) { unchanged++; continue; }

    // Drift > $0.50 → update
    const truthResult = truthPnl > 0 ? 'W' : (truthPnl < 0 ? 'L' : r.result);
    updates.push({ rowIndex: i + 1, symbol: r.symbol, ts: r.date, oldPnl: csvPnl, newPnl: truthPnl, oldResult: r.result, newResult: truthResult });

    // Consume this cTrader position so it can't be matched again to a different row
    const idx = positions.indexOf(best);
    if (idx >= 0) positions.splice(idx, 1);

    r.pnl = String(truthPnl);
    r.result = truthResult;
    if (!r.notes.includes('reconciled_ctrader')) {
      r.notes = (r.notes || '').replace(/\s*$/, '') + `;reconciled_ctrader_${new Date().toISOString()}_was_${csvPnl}`;
    }
    updated++;
  }

  // Sample of biggest changes
  updates.sort((a, b) => Math.abs(b.newPnl - b.oldPnl) - Math.abs(a.newPnl - a.oldPnl));
  console.log(`\n=== RECONCILE REPORT (${DAYS}d) ===`);
  console.log(`Rows checked: ${rows.filter(r => r && ['W','L','VOID'].includes((r.result||'').trim())).length}`);
  console.log(`Updated:   ${updated}`);
  console.log(`Unchanged: ${unchanged}`);
  console.log(`Unmatched: ${unmatched}`);
  console.log(`\nTop 10 corrections by |Δpnl|:`);
  for (const u of updates.slice(0, 10)) {
    console.log(`  row ${u.rowIndex} ${u.symbol} ${u.ts.slice(0,16)}  ${u.oldResult}/${u.oldPnl}  →  ${u.newResult}/${u.newPnl}  (Δ${(u.newPnl - u.oldPnl).toFixed(2)})`);
  }

  if (APPLY && updated > 0) {
    const backupPath = `${TRADES_CSV}.bak_reconcile_${Date.now()}`;
    copyFileSync(TRADES_CSV, backupPath);
    console.log(`\nBackup saved → ${backupPath}`);
    const out = [header, ...rows.map(r => r ? rowToCsv(r) : '')].join('\n');
    writeFileSync(TRADES_CSV, out, 'utf8');
    console.log(`✓ Wrote ${updated} reconciled rows to trades.csv`);
  } else if (updated > 0) {
    console.log(`\n[dry-run] No file changes. Add --apply to write.`);
  }

  return { updated, unchanged, unmatched };
}

async function main() {
  console.log(`=== reconcile_trades_from_ctrader (${DAYS}d, ${APPLY ? 'APPLY' : 'dry-run'}) ===`);
  const positions = await pullCtraderPositions();
  console.log(`Pulled ${positions.length} cTrader positions over the last ${DAYS} days`);

  const symStats = perSymbolPF(positions);
  printPFReport(symStats);

  // Keep a copy of positions before reconcile splices out matched ones
  const posCopy = positions.slice();
  reconcileCsv(posCopy);

  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
