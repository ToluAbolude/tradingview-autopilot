/**
 * confirm_weekly_review.mjs — Friday self-review of the per-strategy experiment.
 *
 * Computes each strategy's realised stats from the cTrader ledger (positionId ->
 * strategy via confirm_signals.jsonl), applies the PASS/WATCH/CUT rule, and writes
 * a review page to Notion + a local confirm_weekly_review.md.
 *
 * PASS  ✅  : >= MIN_N closed trades, ExpR > 0, PF >= MIN_PF   -> concentrate capital here
 * CUT   ❌  : ExpR <= 0 or PF < 1                              -> stop trading it
 * WATCH 🟡  : positive but not enough trades / PF below bar    -> keep gathering
 *
 * Cron: Fridays ~21:00. Needs ~/.notion.env + cTrader env.
 * Usage: node confirm_weekly_review.mjs [--days N]   (default 28 — the experiment window)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { ensureWeekDb, isoWeekInfo } from './notion_week.mjs';   // review → this week's sub-folder

const IS_LINUX  = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX ? '/home/ubuntu/trading-data' : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const SIGNALS = join(DATA_ROOT, 'confirm_signals.jsonl');
const OUT_MD  = join(DATA_ROOT, 'confirm_weekly_review.md');
const TOKEN = process.env.NOTION_TOKEN, DB = process.env.NOTION_DB, NV = '2022-06-28';
const DAYS = Number((process.argv.find(a => a.startsWith('--days=')) || '').split('=')[1] || 28);
const MIN_N = 25, MIN_PF = 1.5;   // the agreed pass bar

// Only count trades that ran as a valid 2R test: bracketed === true (SL+TP genuinely
// attached). Every trade before 2026-06-29 opened NAKED and was force-closed (scratch
// — the bracket-attach bug, fixed 2026-06-29), so it is excluded by that flag. The
// date is a backstop; the flag is the real gate.
const EXP_START = Date.parse(process.env.EXPERIMENT_START || '2026-06-29T00:00:00Z');
function loadPlaced() {
  if (!existsSync(SIGNALS)) return [];
  return readFileSync(SIGNALS, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(r => r && r.mode === 'live-demo' && r.positionId && r.bracketed === true && Date.parse(r.ts) >= EXP_START);
}

async function main() {
  const placed = loadPlaced();
  const b = await import('./broker_ctrader.mjs');
  await b.connect();
  const deals = await b.getAllClosedDeals(Date.now() - DAYS * 86400000).catch(() => []);
  const netByPos = new Map();
  for (const d of deals) netByPos.set(d.positionId, (netByPos.get(d.positionId) || 0) + d.net);

  const agg = {};
  for (const t of placed) {
    const a = agg[t.strategy] ||= { n: 0, wins: 0, sumR: 0, gw: 0, gl: 0, open: 0, syms: new Set() };
    a.syms.add(t.symbol);
    const risk = (t.equity * t.riskPct) / 100;
    if (netByPos.has(t.positionId)) {
      const R = risk > 0 ? netByPos.get(t.positionId) / risk : 0;
      a.n++; a.sumR += R; if (R > 0) { a.wins++; a.gw += R; } else a.gl += Math.abs(R);
    } else a.open++;
  }
  const rows = Object.entries(agg).map(([s, a]) => {
    const expR = a.n ? a.sumR / a.n : 0;
    const pf = a.gl > 0 ? a.gw / a.gl : (a.gw > 0 ? 99 : 0);
    const wr = a.n ? Math.round(a.wins / a.n * 100) : 0;
    let verdict = 'WATCH 🟡';
    if (a.n >= MIN_N && expR > 0 && pf >= MIN_PF) verdict = 'PASS ✅';
    else if (a.n > 0 && (expR <= 0 || pf < 1)) verdict = 'CUT ❌';
    return { s, syms: [...a.syms].join(','), n: a.n, open: a.open, wr, expR, totalR: a.sumR, pf, verdict };
  }).sort((x, y) => y.expR - x.expR);

  const fmt = n => (n >= 0 ? '+' : '') + n.toFixed(2);
  const lines = [`Weekly review ${new Date().toISOString().slice(0, 10)} — last ${DAYS}d. PASS = n≥${MIN_N}, ExpR>0, PF≥${MIN_PF}.`, ''];
  if (!rows.length) lines.push('No placed trades yet.');
  for (const r of rows) lines.push(`${r.verdict} | ${r.s} (${r.syms}) — ${r.n} closed, ${r.open} open · WR ${r.wr}% · ExpR ${fmt(r.expR)}R · total ${fmt(r.totalR)}R · PF ${r.pf === 99 ? '∞' : r.pf.toFixed(2)}`);
  const passing = rows.filter(r => r.verdict.startsWith('PASS')).map(r => `${r.s}/${r.syms}`);
  const cut = rows.filter(r => r.verdict.startsWith('CUT')).map(r => `${r.s}/${r.syms}`);
  lines.push('');
  lines.push(passing.length ? `➡ CONCENTRATE on: ${passing.join(', ')}.` : '➡ No strategy has passed yet — keep gathering trades, do NOT add risk to chase it.');
  if (cut.length) lines.push(`✂ CUT (bleeding): ${cut.join(', ')}.`);
  const body = lines.join('\n');
  console.log('\n' + body + '\n');
  if (!existsSync(DATA_ROOT)) mkdirSync(DATA_ROOT, { recursive: true });
  writeFileSync(OUT_MD, body + '\n');

  if (TOKEN && DB) {
    const weekDb = await ensureWeekDb(console.log);          // put the review IN this week's sub-folder
    const dbId = weekDb || DB;                                // flat-DB fallback if page not shared
    const children = lines.filter(Boolean).map(l => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: l.slice(0, 1900) } }] } }));
    const props = { "Name": { title: [{ text: { content: `📊 Weekly Review — ${isoWeekInfo().key}` } }] } };
    if (weekDb) props["Status"] = { select: { name: 'review' } };          // week-DB schema uses Status
    else props["Tags"] = { multi_select: [{ name: 'review' }] };           // legacy flat-DB schema
    const r = await fetch('https://api.notion.com/v1/pages', { method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Notion-Version': NV, 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent: { database_id: dbId }, properties: props, children }) });
    const j = await r.json().catch(() => ({}));
    console.log(r.ok ? `Notion review → ${weekDb ? 'week folder' : 'flat DB'}: ${j.url}` : `Notion error ${r.status} ${j.code} ${j.message}`);
  }
  process.exit(0);
}
main().catch(e => { console.error('weekly review failed:', e); process.exit(1); });
