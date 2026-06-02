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
const HTML_FILE   = join(DATA_ROOT, 'morning_review.html');

const day  = ms => new Date(ms).toISOString().slice(0, 10);
const usd  = n => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

// ── Gmail-safe HTML report (tables + bgcolor bars + emoji; NO external images/
// SVG/GIF — Gmail blocks those, they'd render as broken boxes) ───────────────
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function hbar(label, value, maxAbs, px, forceColor) {
  const w = Math.max(2, Math.round(Math.abs(value) / maxAbs * px));
  const color = forceColor || (value >= 0 ? '#43a047' : '#e53935');
  return `<tr>
    <td style="padding:3px 10px 3px 0;font-size:13px;width:78px;text-align:right;color:#444">${esc(label)}</td>
    <td style="padding:3px 0;width:${px}px"><table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:${px}px"><tr>
      <td bgcolor="${color}" width="${w}" style="height:15px;line-height:15px;font-size:1px">&nbsp;</td><td>&nbsp;</td>
    </tr></table></td>
    <td style="padding:3px 10px;font-size:13px;font-weight:700;color:${color}">${usd(value)}</td>
  </tr>`;
}

function buildHtml(c) {
  const when = new Date().toUTCString();
  const delta = c.balNow - c.bal7Ago;
  const edgeColor = c.edgePos ? '#2e7d32' : '#c62828';
  const edgeWord = c.edgePos ? 'POSITIVE' : 'NEGATIVE';
  const wr = c.overall.wr;
  const card = (val, label, color) =>
    `<td style="padding:0 6px"><table cellpadding="0" cellspacing="0" width="100%" style="background:${color}1a;border:1px solid ${color}55;border-radius:8px"><tr><td style="padding:12px;text-align:center">
       <div style="font-size:21px;font-weight:800;color:${color}">${val}</div>
       <div style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:.5px">${label}</div>
     </td></tr></table></td>`;

  const maxAbs = Math.max(1, ...c.symStats.map(s => Math.abs(s.net)));
  const symBars = c.symStats.map(s => hbar(s.sym, s.net, maxAbs, 300)).join('');
  const bMax = Math.max(c.balNow, c.bal7Ago, 1);
  const balBars = hbar('7d ago', c.bal7Ago, bMax, 300, '#90a4ae')
                + hbar('now', c.balNow, bMax, 300, c.balNow >= c.bal7Ago ? '#43a047' : '#e53935');
  const wrColor = wr >= 50 ? '#43a047' : wr >= 40 ? '#fb8c00' : '#e53935';
  const wrBar = `<table cellpadding="0" cellspacing="0" style="width:320px;background:#eceff1;border-radius:9px"><tr>
    <td bgcolor="${wrColor}" width="${Math.round(wr / 100 * 320)}" style="height:18px;border-radius:9px;font-size:11px;color:#fff;text-align:center;font-weight:700">${wr}%</td><td>&nbsp;</td></tr></table>`;
  const blocked = c.newlyBlocked.length
    ? c.newlyBlocked.map(s => `<span style="display:inline-block;background:#ffebee;color:#c62828;padding:4px 10px;border-radius:11px;font-size:12px;font-weight:700;margin:2px">🚫 ${esc(s.sym)} ${usd(s.net)}</span>`).join('')
    : '<span style="color:#607d8b;font-size:13px">None triggered today.</span>';
  const props = c.proposals.map(p => `<li style="margin:7px 0;font-size:14px;color:#333;line-height:1.4">${esc(p)}</li>`).join('');
  const sec = t => `<tr><td style="padding:18px 24px 4px;font-size:15px;font-weight:700;color:#1e2a38">${t}</td></tr>`;

  return `<!doctype html><html><body style="margin:0;background:#f0f2f5;font-family:Arial,Helvetica,sans-serif;color:#222">
  <table cellpadding="0" cellspacing="0" width="100%"><tr><td align="center" style="padding:20px 10px">
  <table cellpadding="0" cellspacing="0" width="680" style="max-width:680px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.12)">
    <tr><td style="background:${edgeColor};padding:20px 24px">
      <div style="color:#fff;font-size:21px;font-weight:800">📊 Morning Review &nbsp;·&nbsp; Edge ${c.edgePos ? '🟢' : '🔴'} ${edgeWord}</div>
      <div style="color:#ffffffcc;font-size:13px;margin-top:4px">Last ${DAYS}d &nbsp;·&nbsp; cTrader ledger &nbsp;·&nbsp; ${esc(when)}</div>
    </td></tr>
    <tr><td style="padding:18px 18px 6px"><table cellpadding="0" cellspacing="0" width="100%"><tr>
      ${card(usd(c.balNow), 'Balance', '#1e2a38')}
      ${card((delta >= 0 ? '+' : '') + usd(delta), '7-day', delta >= 0 ? '#2e7d32' : '#c62828')}
      ${card(usd(c.yest.net), 'Yesterday', c.yest.net >= 0 ? '#2e7d32' : '#c62828')}
      ${card('PF ' + c.overall.pf, 'Profit factor', c.overall.pf >= 1 ? '#2e7d32' : '#c62828')}
    </tr></table></td></tr>
    ${sec('📉 Balance trend (7 days)')}
    <tr><td style="padding:4px 24px"><table cellpadding="0" cellspacing="0">${balBars}</table></td></tr>
    ${sec(`🎯 Win rate <span style="font-weight:400;color:#888;font-size:12px">— ${wr}% over ${c.overall.n} trades</span>`)}
    <tr><td style="padding:4px 24px">${wrBar}</td></tr>
    ${sec('💹 Net P&amp;L by symbol (worst → best)')}
    <tr><td style="padding:4px 24px"><table cellpadding="0" cellspacing="0">${symBars}</table></td></tr>
    ${sec('🚫 Auto-blocked (persistent bleeders)')}
    <tr><td style="padding:4px 24px">${blocked}</td></tr>
    ${sec('💡 Proposals <span style="font-weight:400;color:#888;font-size:12px">— not auto-applied</span>')}
    <tr><td style="padding:0 24px"><ul style="margin:4px 0 0;padding-left:20px">${props}</ul></td></tr>
    <tr><td style="background:#f6f8fa;padding:12px 24px;font-size:11px;color:#999">riskPct ${esc(JSON.stringify(c.params.riskPct))} · threshold ${c.params.scoreThreshold} · caps ${c.params.maxDailyTotal}/day ${c.params.maxDailyPerSymbol}/sym · halt ${c.params.maxDailyDrawdownPct}% · blocked [${esc((c.params.blockedSymbols || []).join(', '))}]</td></tr>
  </table></td></tr></table></body></html>`;
}

async function main() {
  const b = await import('./broker_ctrader.mjs');
  await b.connect();
  // Pull 30d so we can guard auto-block against a proven winner in a short dip.
  const LONG_DAYS = Math.max(DAYS, 30);
  const longDeals = (await b.getAllClosedDeals(Date.now() - LONG_DAYS * 864e5)).sort((x, y) => x.execTs - y.execTs);
  const fromMs = Date.now() - DAYS * 864e5;
  const deals = longDeals.filter(d => d.execTs >= fromMs);
  const longNetBySym = {};
  for (const d of longDeals) longNetBySym[d.symbolName] = (longNetBySym[d.symbolName] || 0) + d.net;
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

  // Auto-block clear bleeders (authorized): WR<30% AND net<0 AND n>=5 over the
  // window, AND also net<0 over the 30d window (so a proven winner in a short
  // dip — e.g. BTCUSD — is NOT blocked).
  const blocked = new Set(params.blockedSymbols || []);
  const newlyBlocked = [];
  for (const s of symStats) {
    const persistentLoser = (longNetBySym[s.sym] || 0) < 0;
    if (s.n >= 5 && s.net < 0 && s.wr < 30 && persistentLoser && !blocked.has(s.sym)) { blocked.add(s.sym); newlyBlocked.push(s); }
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

  // Rich HTML report for the email body
  writeFileSync(HTML_FILE, buildHtml({ balNow, bal7Ago, yest, overall, symStats, newlyBlocked, proposals, params, edgePos }));
  console.log('\nHTML → ' + HTML_FILE);
  process.exit(0);
}
main().catch(e => { console.error('morning_review FATAL:', e.message); process.exit(2); });
