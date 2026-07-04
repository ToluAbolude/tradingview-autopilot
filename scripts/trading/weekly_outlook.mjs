/**
 * weekly_outlook.mjs — start-of-week analyst ("what will the market do, and where
 * do we get paid"). For each core instrument it pulls D1 + H4 history from cTrader,
 * asks Claude (opus-4-8, with web search for the week's macro calendar) for a
 * committed outlook — bias, expected path (e.g. "drop into 3800–3500 demand, plant,
 * reverse up"), entry zones with trigger/invalidation/targets — then:
 *   1. writes a "📅 Weekly Outlook" page into the week's Notion journal DB,
 *   2. saves trading-data/weekly_outlook.json for other systems to reference,
 *   3. GRADES the previous week's outlook (bias right? zones touched? targets hit?)
 *      so the analyst is held to its calls, week after week.
 *
 * Cron: Sunday 19:00 UTC (before the new week opens).
 * Needs ~/.ctrader.env + ~/.notion.env + ~/.anthropic.env.
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { getTrendbars } from './broker_ctrader.mjs';

const IS_LINUX  = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX ? '/home/ubuntu/trading-data' : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const OUTLOOK_FILE = join(DATA_ROOT, 'weekly_outlook.json');
const WEEK_DB_FILE = join(DATA_ROOT, 'notion_week_dbs.json');
const NOTION_TOKEN = process.env.NOTION_TOKEN, NOTION_DB = process.env.NOTION_DB, NV = '2022-06-28';
const NOTION_PARENT = process.env.NOTION_PARENT || null;

// core universe; cTrader name candidates per instrument (some names differ / are unmapped)
const SYMBOLS = {
  XAUUSD: ['XAUUSD', 'GOLD'], BTCUSD: ['BTCUSD'], ETHUSD: ['ETHUSD'],
  NAS100: ['NAS100', 'USTEC'], US30: ['US30', 'DJ30'], SPX500: ['SPX500', 'US500'],
  GER40: ['GER40', 'GER30', 'DE40'], EURUSD: ['EURUSD'], GBPUSD: ['GBPUSD'],
  USDJPY: ['USDJPY'], GBPJPY: ['GBPJPY'], AUDUSD: ['AUDUSD'],
};

function log(m) { process.stdout.write(`[${new Date().toISOString()}] ${m}\n`); }
const r5 = x => Number(Number(x).toPrecision(6));

// ── data prep ────────────────────────────────────────────────────────────────
async function fetchBars(candidates, period, days) {
  for (const name of candidates) {
    try {
      const b = await getTrendbars(name, { period, fromMs: Date.now() - days * 86400e3, toMs: Date.now(), windowDays: 30 });
      // cTrader trendbar t is in MILLISECONDS — normalize to seconds (everything downstream assumes seconds)
      if (b && b.length > 10) return { name, bars: b.map(x => ({ ...x, t: x.t > 1e12 ? Math.round(x.t / 1000) : x.t })) };
    } catch { /* try next */ }
  }
  return null;
}

function ema(closes, n) {
  const k = 2 / (n + 1); let e = closes[0];
  for (const c of closes) e = c * k + e * (1 - k);
  return e;
}
function atr(bars, n = 14) {
  const trs = [];
  for (let i = 1; i < bars.length; i++) trs.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)));
  return trs.slice(-n).reduce((s, x) => s + x, 0) / Math.min(n, trs.length);
}
function pivots(bars, k = 2) {  // simple fractal swings on D1
  const out = [];
  for (let i = k; i < bars.length - k; i++) {
    const w = bars.slice(i - k, i + k + 1);
    if (bars[i].h === Math.max(...w.map(b => b.h))) out.push({ t: bars[i].t, type: 'high', p: r5(bars[i].h) });
    if (bars[i].l === Math.min(...w.map(b => b.l))) out.push({ t: bars[i].t, type: 'low', p: r5(bars[i].l) });
  }
  return out.slice(-8).map(p => ({ ...p, date: new Date(p.t * 1000).toISOString().slice(0, 10) }));
}

async function buildInstrumentData() {
  const out = {};
  for (const [sym, candidates] of Object.entries(SYMBOLS)) {
    const d1 = await fetchBars(candidates, 'D1', 220);
    if (!d1) { log(`✗ ${sym}: no D1 data on cTrader — skipped`); continue; }
    const h4 = await fetchBars([d1.name], 'H4', 50);
    const bars = d1.bars;
    const closes = bars.map(b => b.c);
    const last = bars[bars.length - 1];
    // previous COMPLETE Mon–Fri week high/low/close
    const wkAgo = bars.slice(-6, -1);
    out[sym] = {
      ctraderName: d1.name,
      lastClose: r5(last.c),
      prevWeek: { high: r5(Math.max(...wkAgo.map(b => b.h))), low: r5(Math.min(...wkAgo.map(b => b.l))), close: r5(wkAgo[wkAgo.length - 1]?.c ?? last.c) },
      atrD14: r5(atr(bars)),
      emaD20: r5(ema(closes.slice(-60), 20)), emaD50: r5(ema(closes.slice(-120), 50)),
      swings: pivots(bars.slice(-90)),
      d1_last40: bars.slice(-40).map(b => [new Date(b.t * 1000).toISOString().slice(5, 10), r5(b.o), r5(b.h), r5(b.l), r5(b.c)]),
      h4_last42: (h4?.bars || []).slice(-42).map(b => [new Date(b.t * 1000).toISOString().slice(5, 13), r5(b.h), r5(b.l), r5(b.c)]),
    };
    log(`✓ ${sym} (${d1.name}) D1=${bars.length} H4=${h4?.bars?.length || 0}`);
  }
  return out;
}

// ── previous-week scorecard ──────────────────────────────────────────────────
function gradePrevious(prev, data) {
  if (!prev?.instruments?.length) return null;
  const lines = [];
  let biasHits = 0, biasCalls = 0;
  for (const inst of prev.instruments) {
    const d = data[inst.symbol]; if (!d) continue;
    const wk = d.d1_last40.slice(-5);                       // the week that just played out
    if (!wk.length) continue;
    const open = wk[0][1], close = wk[wk.length - 1][4];
    const hi = Math.max(...wk.map(b => b[2])), lo = Math.min(...wk.map(b => b[3]));
    const dirOk = inst.bias === 'bullish' ? close > open : inst.bias === 'bearish' ? close < open : Math.abs(close - open) / open < 0.01;
    if (inst.bias && inst.bias !== 'no-view') { biasCalls++; if (dirOk) biasHits++; }
    const entryZones = (inst.entry_zones || []).filter(z => z.role !== 'fade-at-target');
    const fadeZones  = (inst.entry_zones || []).filter(z => z.role === 'fade-at-target');
    const zTouched = entryZones.filter(z => z.zone_low <= hi && z.zone_high >= lo).length;
    const tHit = entryZones.flatMap(z => z.targets || []).filter(t => t >= lo && t <= hi).length;
    const fadeReached = fadeZones.filter(z => z.zone_low <= hi && z.zone_high >= lo).length;
    let line = `${inst.symbol}: bias ${inst.bias} ${dirOk ? '✅' : '❌'} (wk ${open}→${close}) · ${zTouched}/${entryZones.length} entry zones touched · ${tHit} targets traded through`;
    if (fadeZones.length) line += ` · fade level ${fadeReached}/${fadeZones.length} reached`;
    lines.push(line);
  }
  return { lines, summary: biasCalls ? `${biasHits}/${biasCalls} directional calls correct` : 'no directional calls last week' };
}

// ── Claude ───────────────────────────────────────────────────────────────────
const OUTLOOK_TOOL = {
  name: 'submit_weekly_outlook',
  description: 'Submit the weekly market outlook',
  strict: true,   // API-validated tool input — kills the malformed/leaked-output failure mode
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['week_summary', 'instruments'],
    properties: {
      week_summary: { type: 'string', description: '3-5 sentence cross-market view for the week (risk-on/off, USD, key drivers, scheduled events)' },
      instruments: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['symbol', 'bias', 'confidence', 'expected_path', 'entry_zones'],
          properties: {
            symbol:       { type: 'string' },
            bias:         { type: 'string', enum: ['bullish', 'bearish', 'range', 'no-view'] },
            confidence:   { type: 'string', enum: ['high', 'medium', 'low'] },
            expected_path:{ type: 'string', description: 'The committed call, like a pro: "drop into 3800-3500 demand, plant, reverse toward 4100". One or two sentences.' },
            entry_zones:  { type: 'array', items: { type: 'object',
              additionalProperties: false,
              required: ['direction', 'zone_low', 'zone_high', 'invalidation', 'targets'],
              properties: {
                direction:    { type: 'string', enum: ['long', 'short'] },
                role:         { type: 'string', enum: ['entry', 'fade-at-target'], description: 'entry = a zone to trade IN the bias direction (default). fade-at-target = a counter-direction exhaustion / take-profit marker at the END of the expected path, NOT a primary entry.' },
                zone_low:     { type: 'number' }, zone_high: { type: 'number' },
                trigger:      { type: 'string', description: 'what to see before entering (e.g. H4 rejection wick, break-retest)' },
                invalidation: { type: 'number', description: 'price beyond which the idea is wrong' },
                targets:      { type: 'array', items: { type: 'number' } },
                rationale:    { type: 'string' },
              } } },
            key_levels:   { type: 'array', items: { type: 'number' } },
          },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are the weekly outlook analyst for a systematic trading desk. Every week you
study the higher-timeframe structure and COMMIT to calculated predictions — like a professional analyst
who says "Gold is at 4400, I expect a drop into the 3800-3500 demand zone, a plant, then a reversal" —
and you are graded the following week on whether you were right.

For each instrument you get: last ~40 daily candles [MM-DD,o,h,l,c], last ~42 H4 candles [MM-DDTHH,h,l,c],
recent swing highs/lows, previous week's high/low/close, daily ATR(14), and daily EMA20/EMA50.

Rules:
- Commit. "Could go either way" is useless; if structure is genuinely unclear, say bias "range" or "no-view"
  and keep zones few. Prefer 1-2 high-quality zones per instrument over many weak ones.
- Zones must point the SAME way as your bias (bullish → long entry zones, bearish → short entry zones). Do NOT
  scatter both a long and a short entry on a directional call — that is hedging, not a prediction. Two exceptions:
  (a) bias "range" may carry both a long and a short zone; (b) you MAY add ONE counter-direction level marked
  role "fade-at-target" — the spot at the END of your expected path where the move is expected to exhaust (a
  take-profit / reversal marker like "runs into 4380 supply then turns"), which is NOT a primary entry. Every
  other zone is role "entry" and must match the bias.
- Zones must be REACHABLE within a normal week (~1-2.5x weekly ATR from current price) and anchored to
  real structure you can point to (prior swing, demand/supply shelf, weekly level, round number confluence).
- Every zone needs an invalidation price and 1-3 targets. Risk:reward from zone mid to first target should
  be at least 2:1 against the invalidation.
- Factor in the scheduled macro events provided (rate decisions, CPI, NFP): note when a call is hostage to
  an event.
- Write expected_path in plain committed language a trader can act on and grade.`;

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

async function macroCalendar(client) {
  // Primary: Forex Factory weekly feed — VERIFIED dates/impact/forecasts, no key.
  // (FF weeks run Sun–Sat, so the Sunday-evening cron gets the week just starting.)
  try {
    const r = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (r.ok) {
      const ev = await r.json();
      const keep = (ev || []).filter(e => /high|medium/i.test(e.impact || '')
          && new Date(e.date).getTime() > Date.now() - 3600e3)   // future events only — the feed covers the whole Sun–Sat FF week
        .sort((a, b) => new Date(a.date) - new Date(b.date)).slice(0, 45);
      if (keep.length) {
        const lines = keep.map(e => {
          const d = new Date(e.date);
          return `${DAY[d.getUTCDay()]} ${d.toISOString().slice(5, 16).replace('T', ' ')}Z ${e.country} [${e.impact}] ${e.title}${e.forecast ? ` (fcst ${e.forecast}, prev ${e.previous})` : ''}`;
        });
        log(`calendar: ${keep.length} verified events (ForexFactory)`);
        return 'VERIFIED economic calendar for the week (times UTC):\n' + lines.join('\n');
      }
    }
  } catch (e) { log(`FF calendar failed (${e.message}) — trying web search`); }
  // Fallback: web search (can come back vague — the analyst is told to treat it as soft)
  try {
    let messages = [{ role: 'user', content: 'List the major scheduled macro/economic events for the coming trading week (central bank decisions, CPI/inflation prints, NFP/jobs, PMIs), with day of week and which instruments they matter to (USD pairs, gold, indices, crypto). Be brief - a compact list. If you cannot find specific verified dates, say so plainly instead of guessing.' }];
    for (let i = 0; i < 5; i++) {
      const resp = await client.messages.create({
        model: 'claude-opus-4-8', max_tokens: 1500,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
        messages,
      });
      if (resp.stop_reason === 'pause_turn') { messages = [messages[0], { role: 'assistant', content: resp.content }]; continue; }
      return 'UNVERIFIED (web search) calendar notes:\n' + resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    }
  } catch (e) { log(`macro calendar lookup failed (${e.message}) — proceeding without`); }
  return 'No calendar available this week — flag event risk as unknown.';
}

async function runAnalyst(client, data, events, prevGrade) {
  const user = {
    scheduled_events: events,
    previous_week_scorecard: prevGrade ? `${prevGrade.summary}\n${prevGrade.lines.join('\n')}` : 'first run — no history',
    instruments: data,
  };
  const want = Object.keys(data).length;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // structured outputs — the whole response IS schema-valid JSON (forced tool_choice
      // kept coming back with XML-mangled/empty arguments on big payloads)
      const resp = await client.messages.create({
        model: 'claude-opus-4-8', max_tokens: 16000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Produce this week's outlook. Cover EVERY one of the ${want} instruments provided.\n\n${JSON.stringify(user)}` }],
        output_config: { format: { type: 'json_schema', schema: OUTLOOK_TOOL.input_schema } },
      });
      const input = JSON.parse(resp.content.filter(b => b.type === 'text').map(b => b.text).join(''));
      if (!Array.isArray(input.instruments)) input.instruments = [];
      log(`analyst attempt ${attempt}: ${input.instruments.length}/${want} instruments (stop_reason=${resp.stop_reason})`);
      if (input.instruments.length >= Math.min(6, want)) return input;   // partial coverage = degraded output, retry
    } catch (e) { log(`analyst attempt ${attempt} failed: ${e.message}`); }
  }
  throw new Error('analyst kept returning partial coverage after 3 attempts');
}

// ── Notion ───────────────────────────────────────────────────────────────────
function isoWeekInfo(d = new Date()) {
  const dow = (d.getUTCDay() + 6) % 7;
  const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
  const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
  const th = new Date(mon); th.setUTCDate(mon.getUTCDate() + 3);
  const firstThu = new Date(Date.UTC(th.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((th - firstThu) / 864e5 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  const ds = x => x.toISOString().slice(0, 10);
  const key = `${th.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  return { key, title: `${key} · ${ds(mon)}–${ds(sun)}` };
}

async function nfetch(url, opts) { const r = await fetch(url, opts); const j = await r.json().catch(() => ({})); return { ok: r.ok, status: r.status, j }; }

async function writeNotionPage(outlook, prevGrade, weekInfo) {
  if (!NOTION_TOKEN || !NOTION_DB) { log('no Notion env — skipping page'); return null; }
  let dbId = NOTION_DB;
  try { const cache = JSON.parse(readFileSync(WEEK_DB_FILE, 'utf8')); if (cache[weekInfo.key]) dbId = cache[weekInfo.key]; } catch {}
  const P = t => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: String(t).slice(0, 1900) } }] } });
  const H = t => ({ object: 'block', type: 'heading_3', heading_3: { rich_text: [{ text: { content: String(t).slice(0, 190) } }] } });
  const children = [];
  children.push(H('🌍 Week ahead'));
  children.push(P(outlook.week_summary || '—'));
  if (prevGrade) { children.push(H(`🧾 Last week's calls — ${prevGrade.summary}`)); for (const l of prevGrade.lines.slice(0, 14)) children.push(P(l)); }
  for (const inst of outlook.instruments) {
    const conf = inst.confidence === 'high' ? '🔥' : inst.confidence === 'medium' ? '·' : '❔';
    children.push(H(`${inst.symbol} — ${String(inst.bias).toUpperCase()} ${conf}`));
    children.push(P(inst.expected_path || ''));
    for (const z of inst.entry_zones || []) {
      const tag = z.role === 'fade-at-target' ? '🎯 FADE-AT-TARGET' : (z.direction === 'long' ? '🟢 LONG' : '🔴 SHORT');
      children.push(P(`${tag} zone ${z.zone_low}–${z.zone_high} | trigger: ${z.trigger || 'zone tap'} | invalid: ${z.invalidation} | targets: ${(z.targets || []).join(' → ')}${z.rationale ? ' | ' + z.rationale : ''}`));
    }
  }
  const props = { 'Name': { title: [{ text: { content: `📅 Weekly Outlook ${weekInfo.key}` } }] } };
  const r = await nfetch('https://api.notion.com/v1/pages', { method: 'POST',
    headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NV, 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent: { database_id: dbId }, properties: props, children: children.slice(0, 95) }) });
  if (!r.ok) throw new Error(`outlook page create ${r.status} ${r.j.message}`);
  return { id: r.j.id, url: r.j.url || r.j.id };
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  log('=== WEEKLY OUTLOOK ===');
  if (!process.env.ANTHROPIC_API_KEY) { log('no ANTHROPIC_API_KEY — cannot run the analyst'); process.exit(1); }
  const client = new Anthropic();

  // on Sat/Sun this outlook is for the COMING week; midweek runs target the current week
  const now = new Date();
  const targetDate = [0, 6].includes(now.getUTCDay()) ? new Date(Date.now() + 2 * 86400e3) : now;
  const weekInfo = isoWeekInfo(targetDate);

  const data = await buildInstrumentData();
  if (!Object.keys(data).length) { log('no instrument data — aborting'); process.exit(1); }

  let prev = null; try { prev = JSON.parse(readFileSync(OUTLOOK_FILE, 'utf8')); } catch {}
  const prevGrade = prev && prev.week !== weekInfo.key ? gradePrevious(prev, data) : null;

  log('fetching macro calendar (web search)...');
  const events = await macroCalendar(client);
  log('running the analyst...');
  const outlook = await runAnalyst(client, data, events, prevGrade);
  log(`outlook: ${outlook.instruments.length} instruments, week ${weekInfo.key}`);

  let page = null;
  try { page = await writeNotionPage(outlook, prevGrade, weekInfo); if (page) log(`📄 Notion page: ${page.url}`); }
  catch (e) { log(`Notion page failed: ${e.message}`); }

  writeFileSync(OUTLOOK_FILE, JSON.stringify({ week: weekInfo.key, generated: new Date().toISOString(), events_note: events, outlook_page_id: page?.id || null, ...outlook }, null, 2));
  log(`saved → ${OUTLOOK_FILE}`);

  for (const inst of outlook.instruments) log(`  ${inst.symbol} ${inst.bias} (${inst.confidence}): ${inst.expected_path}`);
  log('=== DONE ===');
  process.exit(0);
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
