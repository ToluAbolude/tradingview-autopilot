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

// ── HTML email report — styled tables + CSS bar-chart "graphs" ──────────────
// Uses table/bgcolor/width-based bars and inline styles so it renders in Gmail
// (no external images, no SVG — both are stripped/blocked by Gmail).
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function money(n) { const r = Math.round(n); return (r < 0 ? '-$' : '$') + Math.abs(r).toLocaleString('en-US'); }
function pfTxt(pf) { return pf === Infinity ? '∞' : pf.toFixed(2); }

function buildHtml(report, threshold) {
  const active = [...report.active_fail, ...report.active_pass];
  const rows   = [...report.active_fail, ...report.active_pass, ...report.insufficient];
  const when   = new Date().toUTCString();

  const statusOf = s =>
    s.n < MIN_TRADES ? { label: `n&lt;${MIN_TRADES}`, bg: '#eceff1', fg: '#607d8b' }
    : s.pf >= threshold ? { label: 'OK',  bg: '#e8f5e9', fg: '#2e7d32' }
    :                     { label: 'FLAG', bg: '#ffebee', fg: '#c62828' };

  // Main table
  const tableRows = rows.map(s => {
    const st = statusOf(s);
    const netC = s.net > 0 ? '#2e7d32' : s.net < 0 ? '#c62828' : '#607d8b';
    return `<tr style="border-bottom:1px solid #eee">
      <td style="padding:7px 12px;font-weight:600">${esc(s.sym)}</td>
      <td style="padding:7px 12px;text-align:right;color:#555">${s.n}</td>
      <td style="padding:7px 12px;text-align:right;color:#555">${(s.wr * 100).toFixed(0)}%</td>
      <td style="padding:7px 12px;text-align:right;font-weight:700">${pfTxt(s.pf)}</td>
      <td style="padding:7px 12px;text-align:right;font-weight:700;color:${netC}">${money(s.net)}</td>
      <td style="padding:7px 12px;text-align:center"><span style="background:${st.bg};color:${st.fg};padding:3px 10px;border-radius:11px;font-size:12px;font-weight:700">${st.label}</span></td>
    </tr>`;
  }).join('');

  // PF bar chart (cap display at 6×; goal line drawn at threshold)
  const PF_CAP = 6, PF_PX = 280;
  const goalPx = Math.round(threshold / PF_CAP * PF_PX);
  const pfBars = active.map(s => {
    const v = s.pf === Infinity ? PF_CAP : Math.min(s.pf, PF_CAP);
    const px = Math.max(2, Math.round(v / PF_CAP * PF_PX));
    const color = s.pf >= threshold ? '#43a047' : '#e53935';
    return `<tr>
      <td style="padding:3px 10px 3px 0;font-size:13px;width:64px;text-align:right;color:#444">${esc(s.sym)}</td>
      <td style="padding:3px 0;width:${PF_PX}px">
        <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:${PF_PX}px;background:#f4f4f4;border-left:2px solid #bbb"><tr>
          <td bgcolor="${color}" width="${px}" style="height:14px;line-height:14px;font-size:1px">&nbsp;</td><td>&nbsp;</td>
        </tr></table>
      </td>
      <td style="padding:3px 10px;font-size:13px;font-weight:700;color:${color}">${pfTxt(s.pf)}</td>
    </tr>`;
  }).join('');

  // Net P&L bars (single direction, colored by sign, sorted desc)
  const maxAbs = Math.max(1, ...active.map(s => Math.abs(s.net)));
  const NET_PX = 280;
  const netBars = active.slice().sort((a, b) => b.net - a.net).map(s => {
    const px = Math.max(2, Math.round(Math.abs(s.net) / maxAbs * NET_PX));
    const pos = s.net >= 0, color = pos ? '#43a047' : '#e53935';
    return `<tr>
      <td style="padding:3px 10px 3px 0;font-size:13px;width:64px;text-align:right;color:#444">${esc(s.sym)}</td>
      <td style="padding:3px 0;width:${NET_PX}px">
        <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:${NET_PX}px"><tr>
          <td bgcolor="${color}" width="${px}" style="height:14px;line-height:14px;font-size:1px">&nbsp;</td><td>&nbsp;</td>
        </tr></table>
      </td>
      <td style="padding:3px 10px;font-size:13px;font-weight:700;color:${color}">${money(s.net)}</td>
    </tr>`;
  }).join('');

  const card = (n, label, color) =>
    `<td style="padding:0 6px"><table cellpadding="0" cellspacing="0" width="100%" style="background:${color}1a;border:1px solid ${color}55;border-radius:8px"><tr><td style="padding:12px;text-align:center">
       <div style="font-size:26px;font-weight:800;color:${color}">${n}</div>
       <div style="font-size:12px;color:#555;text-transform:uppercase;letter-spacing:.5px">${label}</div>
     </td></tr></table></td>`;

  return `<!doctype html><html><body style="margin:0;background:#f0f2f5;font-family:Arial,Helvetica,sans-serif;color:#222">
  <table cellpadding="0" cellspacing="0" width="100%"><tr><td align="center" style="padding:20px 10px">
  <table cellpadding="0" cellspacing="0" width="720" style="max-width:720px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)">
    <tr><td style="background:#1e2a38;padding:20px 24px">
      <div style="color:#fff;font-size:20px;font-weight:700">Per-Symbol Profit Factor — ${DAYS}d</div>
      <div style="color:#9fb3c8;font-size:13px;margin-top:4px">Goal PF &ge; ${threshold.toFixed(1)} &nbsp;·&nbsp; cTrader deal history (authoritative) &nbsp;·&nbsp; ${esc(when)}</div>
    </td></tr>
    <tr><td style="padding:18px 18px 6px">
      <table cellpadding="0" cellspacing="0" width="100%"><tr>
        ${card(report.active_pass.length, 'Passing', '#2e7d32')}
        ${card(report.active_fail.length, 'Flagged', '#c62828')}
        ${card(report.insufficient.length, 'Insufficient', '#607d8b')}
      </tr></table>
    </td></tr>
    <tr><td style="padding:14px 24px 4px;font-size:15px;font-weight:700;color:#1e2a38">Summary table</td></tr>
    <tr><td style="padding:0 18px">
      <table cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:14px">
        <tr style="background:#f6f8fa;color:#555;font-size:12px;text-transform:uppercase">
          <td style="padding:7px 12px">Symbol</td><td style="padding:7px 12px;text-align:right">N</td>
          <td style="padding:7px 12px;text-align:right">WR</td><td style="padding:7px 12px;text-align:right">PF</td>
          <td style="padding:7px 12px;text-align:right">Net</td><td style="padding:7px 12px;text-align:center">Status</td>
        </tr>
        ${tableRows}
      </table>
    </td></tr>
    <tr><td style="padding:22px 24px 4px;font-size:15px;font-weight:700;color:#1e2a38">Profit Factor by symbol <span style="font-weight:400;font-size:12px;color:#888">(green = meets goal ${threshold.toFixed(1)}, red = below; bars capped at ${PF_CAP}×)</span></td></tr>
    <tr><td style="padding:4px 24px">
      <table cellpadding="0" cellspacing="0">${pfBars}</table>
    </td></tr>
    <tr><td style="padding:22px 24px 4px;font-size:15px;font-weight:700;color:#1e2a38">Net P&amp;L by symbol</td></tr>
    <tr><td style="padding:4px 24px 18px">
      <table cellpadding="0" cellspacing="0">${netBars}</table>
    </td></tr>
    <tr><td style="background:#f6f8fa;padding:12px 24px;font-size:11px;color:#999">Generated by per_symbol_pf_reflection.mjs · ${DAYS}-day window · min ${MIN_TRADES} trades to evaluate · we flag, never auto-block.</td></tr>
  </table></td></tr></table></body></html>`;
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

  // Rich HTML report (tables + bar-chart graphs) for the email body
  const REPORT_HTML = join(OUT_DIR, 'report.html');
  writeFileSync(REPORT_HTML, buildHtml(report, threshold));
  console.log('\nSnapshot → ' + LATEST_FILE);
  console.log('HTML     → ' + REPORT_HTML);

  process.exit(report.active_fail.length > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(2); });
