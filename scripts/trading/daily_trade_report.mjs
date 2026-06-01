/**
 * daily_trade_report.mjs
 * End-of-day report for the SINGLE trading day that just finished.
 *
 * Replaces the old habit of emailing the rolling 30-day per-symbol PF table
 * every night (which barely changed day to day and was useless as a daily). This
 * answers the only question that matters at EOD: "what did I trade today, and how
 * did each one do?"
 *
 * Pulls today's closing deals from cTrader (the authoritative source), groups
 * them into round-trip positions, and reports each trade's net P&L + the day's
 * totals. cTrader closing deals are net of commission + swap.
 *
 * Window: from 00:00 UTC today (the system closes all positions at 20:00 UTC, so
 * a 20:30 UTC run captures the full day). Override with --date=YYYY-MM-DD to
 * re-run a past day, or --hours=N for a rolling N-hour window.
 *
 * Output:
 *   - Console plain-text report (email text/plain fallback)
 *   - HTML report at trading-data/pf_reflection/daily_report.html (email body)
 *   - JSON snapshot at trading-data/daily_report/<date>.json
 *
 * Exit code: always 0 (the cron always emails the daily report, even on a flat /
 * no-trade day) UNLESS cTrader connectivity fails (exit 2).
 *
 * Usage:
 *   node daily_trade_report.mjs
 *   node daily_trade_report.mjs --date=2026-05-30
 *   node daily_trade_report.mjs --hours=24
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import os from 'os';

const IS_LINUX  = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX
  ? '/home/ubuntu/trading-data'
  : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';

const OUT_DIR     = join(DATA_ROOT, 'daily_report');
const HTML_DIR    = join(DATA_ROOT, 'pf_reflection'); // co-locate with cron's report dir
const HTML_FILE   = join(HTML_DIR, 'daily_report.html');

// Same symbol universe as per_symbol_pf_reflection.mjs / reconcile_trades_from_ctrader.mjs
const SYMBOLS = [
  'WTI','BRENT','COPPER',
  'XAUUSD','XAGUSD',
  'BTCUSD','ETHUSD','XRPUSD','SOLUSD','ADAUSD','LTCUSD','BNBUSD','DOTUSD','AVAXUSD',
  'NAS100','US30','SPX500','GER30','UK100','JPN225','AUS200',
  'EURUSD','GBPUSD','AUDUSD','NZDUSD','USDJPY','EURJPY','GBPJPY','AUDJPY','USDCAD','USDCHF','NZDCAD','NZDJPY',
];

// ── Window resolution ────────────────────────────────────────────────────────
const dateArg  = (process.argv.find(a => a.startsWith('--date=')) || '').split('=')[1];
const hoursArg = parseInt((process.argv.find(a => a.startsWith('--hours=')) || '').split('=')[1]);

function resolveWindow() {
  if (hoursArg) {
    const toMs = Date.now();
    return { fromMs: toMs - hoursArg * 3600 * 1000, toMs, label: `last ${hoursArg}h` };
  }
  const dayStr = dateArg || new Date().toISOString().slice(0, 10);
  const fromMs = Date.parse(`${dayStr}T00:00:00.000Z`);
  // If reporting a past explicit date, cap at end of that day; else "now".
  const endOfDay = Date.parse(`${dayStr}T23:59:59.999Z`);
  const toMs = dateArg ? endOfDay : Math.min(endOfDay, Date.now());
  return { fromMs, toMs, label: dayStr };
}

// ── Pull today's closing deals, group into round-trip positions ──────────────
async function pullTrades(fromMs, toMs) {
  const bridge = await import('./broker_ctrader.mjs');
  await bridge.connect();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const byPos = new Map();

  for (const sym of SYMBOLS) {
    let attempt = 0;
    while (attempt < 3) {
      try {
        const r = await bridge.getRecentClosePnl(sym, fromMs, toMs);
        for (const d of (r.deals || [])) {
          const cur = byPos.get(d.positionId) || {
            symbol: sym, positionId: d.positionId,
            // closing-deal side is the OPPOSITE of the entry direction
            dir: d.tradeSide === 'sell' ? 'long' : 'short',
            closeTs: d.execTs, closePrice: d.execPrice,
            deals: 0, net: 0,
          };
          cur.deals++;
          cur.net += d.net;
          if (d.execTs >= cur.closeTs) { cur.closeTs = d.execTs; cur.closePrice = d.execPrice; }
          byPos.set(d.positionId, cur);
        }
        break;
      } catch (e) {
        if (/rate limited|BLOCKED_PAYLOAD_TYPE/i.test(e.message) && attempt < 2) {
          attempt++; await sleep(2000 * attempt); continue;
        }
        break;
      }
    }
    await sleep(250);
  }
  return [...byPos.values()].map(p => ({ ...p, net: Math.round(p.net * 100) / 100 }))
    .sort((a, b) => a.closeTs - b.closeTs);
}

// ── Totals ───────────────────────────────────────────────────────────────────
function summarize(trades) {
  const wins   = trades.filter(t => t.net > 0);
  const losses = trades.filter(t => t.net < 0);
  const flats  = trades.filter(t => t.net === 0);
  const grossWin  = wins.reduce((s, t) => s + t.net, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.net, 0));
  const net = trades.reduce((s, t) => s + t.net, 0);

  // Per-symbol roll-up so a single bad instrument is obvious
  const bySym = new Map();
  for (const t of trades) {
    const cur = bySym.get(t.symbol) || { sym: t.symbol, n: 0, w: 0, l: 0, net: 0 };
    cur.n++; cur.net += t.net;
    if (t.net > 0) cur.w++; else if (t.net < 0) cur.l++;
    bySym.set(t.symbol, cur);
  }

  return {
    count: trades.length,
    wins: wins.length, losses: losses.length, flats: flats.length,
    winRate: trades.length ? Math.round((wins.length / trades.length) * 1000) / 10 : 0,
    grossWin:  Math.round(grossWin * 100) / 100,
    grossLoss: Math.round(grossLoss * 100) / 100,
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : (grossWin > 0 ? Infinity : 0),
    net: Math.round(net * 100) / 100,
    best:  trades.length ? trades.reduce((a, b) => (b.net > a.net ? b : a)) : null,
    worst: trades.length ? trades.reduce((a, b) => (b.net < a.net ? b : a)) : null,
    bySymbol: [...bySym.values()].map(s => ({ ...s, net: Math.round(s.net * 100) / 100 }))
      .sort((a, b) => a.net - b.net),
  };
}

// ── Formatting helpers ───────────────────────────────────────────────────────
function money(n) { const r = Math.round(n * 100) / 100; return (r < 0 ? '-$' : '$') + Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function pfTxt(pf) { return pf === Infinity ? '∞' : pf.toFixed(2); }
function hhmm(ts) { return new Date(ts).toISOString().slice(11, 16) + 'Z'; }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ── Plain-text report ────────────────────────────────────────────────────────
function printReport(label, trades, sum, equity) {
  console.log(`=== EOD TRADE REPORT — ${label} — ${new Date().toISOString()} ===`);
  console.log('');
  if (sum.count === 0) {
    console.log('No trades closed today. (Either no setups qualified, or all attempts were rejected.)');
  } else {
    console.log('Time   | Symbol   | Dir   |   Net P&L   | Result');
    console.log('-------+----------+-------+-------------+--------');
    for (const t of trades) {
      const res = t.net > 0 ? 'WIN' : t.net < 0 ? 'LOSS' : 'FLAT';
      console.log(
        hhmm(t.closeTs), '|',
        t.symbol.padEnd(8), '|',
        t.dir.padEnd(5), '|',
        money(t.net).padStart(11), '|', res,
      );
    }
    console.log('-------+----------+-------+-------------+--------');
    console.log('');
    console.log(`Trades: ${sum.count}   Wins: ${sum.wins}   Losses: ${sum.losses}   Win rate: ${sum.winRate}%`);
    console.log(`Gross win: ${money(sum.grossWin)}   Gross loss: -${money(sum.grossLoss)}   PF: ${pfTxt(sum.profitFactor)}`);
    console.log(`NET FOR THE DAY: ${money(sum.net)}`);
    if (sum.best)  console.log(`Best:  ${sum.best.symbol} ${money(sum.best.net)}`);
    if (sum.worst) console.log(`Worst: ${sum.worst.symbol} ${money(sum.worst.net)}`);
    if (sum.bySymbol.length > 1) {
      console.log('');
      console.log('By symbol (worst first):');
      for (const s of sum.bySymbol) console.log(`  ${s.sym.padEnd(8)} ${money(s.net).padStart(11)}  (${s.n} trades, ${s.w}W/${s.l}L)`);
    }
  }
  if (equity) {
    console.log('');
    console.log(`Account: balance=${money(equity.balance)}  equity=${money(equity.equity)}`);
  }
}

// ── HTML report (Gmail-safe: tables + inline styles, no images/SVG) ──────────
function buildHtml(label, trades, sum, equity) {
  const when = new Date().toUTCString();
  const netColor = sum.net > 0 ? '#2e7d32' : sum.net < 0 ? '#c62828' : '#607d8b';

  const rows = trades.map(t => {
    const res = t.net > 0 ? { l: 'WIN', bg: '#e8f5e9', fg: '#2e7d32' }
              : t.net < 0 ? { l: 'LOSS', bg: '#ffebee', fg: '#c62828' }
              :             { l: 'FLAT', bg: '#eceff1', fg: '#607d8b' };
    const c = t.net > 0 ? '#2e7d32' : t.net < 0 ? '#c62828' : '#607d8b';
    return `<tr style="border-bottom:1px solid #eee">
      <td style="padding:7px 12px;color:#555">${hhmm(t.closeTs)}</td>
      <td style="padding:7px 12px;font-weight:600">${esc(t.symbol)}</td>
      <td style="padding:7px 12px;text-transform:uppercase;color:#555;font-size:12px">${esc(t.dir)}</td>
      <td style="padding:7px 12px;text-align:right;font-weight:700;color:${c}">${money(t.net)}</td>
      <td style="padding:7px 12px;text-align:center"><span style="background:${res.bg};color:${res.fg};padding:3px 10px;border-radius:11px;font-size:12px;font-weight:700">${res.l}</span></td>
    </tr>`;
  }).join('');

  const card = (n, lbl, color) =>
    `<td style="padding:0 6px"><table cellpadding="0" cellspacing="0" width="100%" style="background:${color}1a;border:1px solid ${color}55;border-radius:8px"><tr><td style="padding:12px;text-align:center">
       <div style="font-size:24px;font-weight:800;color:${color}">${n}</div>
       <div style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:.5px">${lbl}</div>
     </td></tr></table></td>`;

  const emptyBlock = `<tr><td style="padding:40px 24px;text-align:center;color:#607d8b;font-size:15px">
     No trades closed today.<br><span style="font-size:13px;color:#90a4ae">Either no setups qualified, or all attempts were rejected by the broker.</span>
   </td></tr>`;

  // Per-symbol net bars (only when >1 symbol traded)
  let symBlock = '';
  if (sum.bySymbol.length > 1) {
    const maxAbs = Math.max(1, ...sum.bySymbol.map(s => Math.abs(s.net)));
    const PX = 280;
    const bars = sum.bySymbol.map(s => {
      const px = Math.max(2, Math.round(Math.abs(s.net) / maxAbs * PX));
      const color = s.net >= 0 ? '#43a047' : '#e53935';
      return `<tr>
        <td style="padding:3px 10px 3px 0;font-size:13px;width:64px;text-align:right;color:#444">${esc(s.sym)}</td>
        <td style="padding:3px 0;width:${PX}px"><table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:${PX}px"><tr>
          <td bgcolor="${color}" width="${px}" style="height:14px;line-height:14px;font-size:1px">&nbsp;</td><td>&nbsp;</td>
        </tr></table></td>
        <td style="padding:3px 10px;font-size:13px;font-weight:700;color:${color}">${money(s.net)}</td>
      </tr>`;
    }).join('');
    symBlock = `<tr><td style="padding:20px 24px 4px;font-size:15px;font-weight:700;color:#1e2a38">Net P&amp;L by symbol</td></tr>
      <tr><td style="padding:4px 24px"><table cellpadding="0" cellspacing="0">${bars}</table></td></tr>`;
  }

  const body = sum.count === 0 ? emptyBlock : `
    <tr><td style="padding:18px 18px 6px">
      <table cellpadding="0" cellspacing="0" width="100%"><tr>
        ${card(sum.count, 'Trades', '#1e2a38')}
        ${card(sum.wins, 'Wins', '#2e7d32')}
        ${card(sum.losses, 'Losses', '#c62828')}
        ${card(sum.winRate + '%', 'Win rate', '#5b6b7b')}
      </tr></table>
    </td></tr>
    <tr><td style="padding:6px 24px 0;text-align:center">
      <div style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.5px">Net for the day</div>
      <div style="font-size:34px;font-weight:800;color:${netColor}">${money(sum.net)}</div>
      <div style="font-size:12px;color:#999">PF ${pfTxt(sum.profitFactor)} · gross win ${money(sum.grossWin)} · gross loss -${money(sum.grossLoss)}</div>
    </td></tr>
    <tr><td style="padding:16px 24px 4px;font-size:15px;font-weight:700;color:#1e2a38">Trades closed today</td></tr>
    <tr><td style="padding:0 18px">
      <table cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:14px">
        <tr style="background:#f6f8fa;color:#555;font-size:12px;text-transform:uppercase">
          <td style="padding:7px 12px">Time</td><td style="padding:7px 12px">Symbol</td>
          <td style="padding:7px 12px">Dir</td><td style="padding:7px 12px;text-align:right">Net P&amp;L</td>
          <td style="padding:7px 12px;text-align:center">Result</td>
        </tr>
        ${rows}
      </table>
    </td></tr>
    ${symBlock}`;

  const acct = equity
    ? `<tr><td style="padding:8px 24px 0;text-align:center;font-size:13px;color:#555">Account balance <b>${money(equity.balance)}</b> · equity <b>${money(equity.equity)}</b></td></tr>`
    : '';

  return `<!doctype html><html><body style="margin:0;background:#f0f2f5;font-family:Arial,Helvetica,sans-serif;color:#222">
  <table cellpadding="0" cellspacing="0" width="100%"><tr><td align="center" style="padding:20px 10px">
  <table cellpadding="0" cellspacing="0" width="640" style="max-width:640px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)">
    <tr><td style="background:#1e2a38;padding:20px 24px">
      <div style="color:#fff;font-size:20px;font-weight:700">End-of-Day Trade Report</div>
      <div style="color:#9fb3c8;font-size:13px;margin-top:4px">${esc(label)} &nbsp;·&nbsp; cTrader closed deals (net of commission + swap) &nbsp;·&nbsp; ${esc(when)}</div>
    </td></tr>
    ${body}
    ${acct}
    <tr><td style="background:#f6f8fa;padding:12px 24px;font-size:11px;color:#999">Generated by daily_trade_report.mjs · single-day view · today's round-trip trades only.</td></tr>
  </table></td></tr></table></body></html>`;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const { fromMs, toMs, label } = resolveWindow();

  let trades, equity = null;
  try {
    trades = await pullTrades(fromMs, toMs);
    try {
      const bridge = await import('./broker_ctrader.mjs');
      equity = await bridge.getEquity();
    } catch (_) { /* equity is best-effort */ }
  } catch (e) {
    console.error('cTrader connectivity failed:', e.message);
    process.exit(2);
  }

  const sum = summarize(trades);
  printReport(label, trades, sum, equity);

  // Persist
  if (!existsSync(OUT_DIR))  mkdirSync(OUT_DIR,  { recursive: true });
  if (!existsSync(HTML_DIR)) mkdirSync(HTML_DIR, { recursive: true });
  const snapDate = (dateArg || new Date().toISOString().slice(0, 10));
  writeFileSync(join(OUT_DIR, `${snapDate}.json`), JSON.stringify({
    date: label, generatedAt: new Date().toISOString(),
    summary: { ...sum, profitFactor: sum.profitFactor === Infinity ? null : sum.profitFactor },
    trades, equity,
  }, null, 2));
  writeFileSync(HTML_FILE, buildHtml(label, trades, sum, equity));
  console.log('\nHTML → ' + HTML_FILE);

  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(2); });
