/**
 * daily_brief.mjs — the morning confirmation scan that connects the weekly outlook
 * to live trading. Each weekday morning it:
 *   1. re-checks every weekly call against fresh D1/H4 price action (confirming /
 *      against / invalidated, which entry zones are live and how far away),
 *   2. pulls TODAY's high/medium-impact events (Forex Factory feed),
 *   3. has Claude write the day plan,
 *   4. writes trading-data/daily_context/YYYY-MM-DD.json — the file session_runner
 *      ALREADY reads (skip_today / score_threshold_override / instruments_to_avoid_today),
 *      so the scanner trades WITH the weekly view instead of against it,
 *   5. appends the daily check to the week's Notion outlook page.
 *
 * Cron: 06:15 UTC Mon–Fri (before daily_selector 06:30 and the London/NY sessions).
 * Needs ~/.ctrader.env + ~/.notion.env + ~/.anthropic.env.
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { getTrendbars } from './broker_ctrader.mjs';

const IS_LINUX  = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX ? '/home/ubuntu/trading-data' : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const OUTLOOK_FILE = join(DATA_ROOT, 'weekly_outlook.json');
const BRIEF_FILE   = join(DATA_ROOT, 'daily_brief.json');
const CTX_DIR      = join(DATA_ROOT, 'daily_context');
const NOTION_TOKEN = process.env.NOTION_TOKEN, NV = '2022-06-28';

const SYMBOLS = {
  XAUUSD: ['XAUUSD', 'GOLD'], BTCUSD: ['BTCUSD'], ETHUSD: ['ETHUSD'],
  NAS100: ['NAS100', 'USTEC'], US30: ['US30', 'DJ30'], SPX500: ['SPX500', 'US500'],
  GER40: ['GER40', 'GER30', 'DE40'], EURUSD: ['EURUSD'], GBPUSD: ['GBPUSD'],
  USDJPY: ['USDJPY'], GBPJPY: ['GBPJPY'], AUDUSD: ['AUDUSD'],
};
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function log(m) { process.stdout.write(`[${new Date().toISOString()}] ${m}\n`); }
const r5 = x => Number(Number(x).toPrecision(6));

async function fetchBars(candidates, period, days) {
  for (const name of candidates) {
    try {
      const b = await getTrendbars(name, { period, fromMs: Date.now() - days * 86400e3, toMs: Date.now(), windowDays: 30 });
      // cTrader trendbar t is in MILLISECONDS — normalize to seconds (everything downstream assumes seconds)
      if (b && b.length > 3) return { name, bars: b.map(x => ({ ...x, t: x.t > 1e12 ? Math.round(x.t / 1000) : x.t })) };
    } catch { /* try next */ }
  }
  return null;
}
function atr(bars, n = 14) {
  const trs = [];
  for (let i = 1; i < bars.length; i++) trs.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)));
  return trs.slice(-n).reduce((s, x) => s + x, 0) / Math.min(n, trs.length);
}

// today's high/medium events from the Forex Factory weekly feed
async function todaysEvents() {
  try {
    const r = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return 'calendar unavailable';
    const ev = await r.json();
    const now = Date.now();
    const keep = (ev || []).filter(e => {
      const t = new Date(e.date).getTime();
      return /high|medium/i.test(e.impact || '') && t > now - 3600e3 && t < now + 26 * 3600e3;
    }).sort((a, b) => new Date(a.date) - new Date(b.date)).slice(0, 20);
    if (!keep.length) return 'no high/medium-impact events in the next 24h';
    return keep.map(e => { const d = new Date(e.date); return `${d.toISOString().slice(11, 16)}Z ${e.country} [${e.impact}] ${e.title}${e.forecast ? ` (fcst ${e.forecast}, prev ${e.previous})` : ''}`; }).join('\n');
  } catch (e) { return `calendar failed: ${e.message}`; }
}

// released events this week WITH actuals — the "why did it move" candidates
async function weekReleases() {
  try {
    const r = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return 'no release data';
    const ev = await r.json();
    const now = Date.now();
    const keep = (ev || []).filter(e => /high|medium/i.test(e.impact || '') && new Date(e.date).getTime() < now && e.actual)
      .sort((a, b) => new Date(a.date) - new Date(b.date)).slice(-25);
    if (!keep.length) return 'no releases with actuals yet this week';
    return keep.map(e => { const d = new Date(e.date); return `${DAY[d.getUTCDay()]} ${e.country} [${e.impact}] ${e.title}: actual ${e.actual} vs fcst ${e.forecast || '?'} (prev ${e.previous || '?'})`; }).join('\n');
  } catch (e) { return `release data failed: ${e.message}`; }
}

// headline search: what ACTUALLY drove the broken instruments this week
async function headlines(client, symbols) {
  try {
    let messages = [{ role: 'user', content: `In 6-10 concrete bullet points: what actually drove these instruments this week: ${symbols.join(', ')}? Real causes (central bank actions/speak, data surprises, flows, geopolitics, crypto-specific news). Search for it — do not guess. Brief.` }];
    for (let i = 0; i < 4; i++) {
      const resp = await client.messages.create({
        model: 'claude-opus-4-8', max_tokens: 1500,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 }],
        messages,
      });
      if (resp.stop_reason === 'pause_turn') { messages = [messages[0], { role: 'assistant', content: resp.content }]; continue; }
      return resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    }
  } catch (e) { log(`headline search failed: ${e.message}`); }
  return 'no headline context available';
}

const REVISE_TOOL = {
  name: 'submit_revisions',
  description: 'Submit revised calls for instruments whose weekly prediction broke',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['revisions'],
    properties: {
      revisions: { type: 'array', items: { type: 'object',
        additionalProperties: false,
        required: ['symbol', 'why', 'new_bias', 'expected_path', 'entry_zones', 'tradeable_today'],
        properties: {
          symbol:    { type: 'string' },
          why:       { type: 'string', description: 'root cause of the move against the original call — from the released data / headlines, not hand-waving' },
          new_bias:  { type: 'string', enum: ['bullish', 'bearish', 'range', 'no-view'] },
          confidence:{ type: 'string', enum: ['high', 'medium', 'low'] },
          expected_path: { type: 'string', description: 'the revised committed call for the REST of the week' },
          entry_zones: { type: 'array', items: { type: 'object',
            additionalProperties: false,
            required: ['direction', 'zone_low', 'zone_high', 'invalidation', 'targets'],
            properties: {
              direction: { type: 'string', enum: ['long', 'short'] },
              role:      { type: 'string', enum: ['entry', 'fade-at-target'], description: 'entry = trade IN the revised bias (default). fade-at-target = counter-direction exhaustion marker at the end of the path, not a primary entry.' },
              zone_low: { type: 'number' }, zone_high: { type: 'number' },
              trigger: { type: 'string' }, invalidation: { type: 'number' },
              targets: { type: 'array', items: { type: 'number' } }, rationale: { type: 'string' },
            } } },
          tradeable_today: { type: 'boolean', description: 'true if the revised plan is actionable today; false if it needs a level/close to confirm first' },
        } } },
    },
  },
};

const REVISE_PROMPT = `A weekly call broke — price went against the prediction. Your job now is the professional
pivot: first find WHY it broke (use the released economic data and headline context provided — point at the actual
cause, not hand-waving), then build a NEW plan that makes money from the new reality instead of defending the old
opinion. Same quality bar as the weekly outlook: zones anchored to real structure, reachable within the remaining
week, invalidation + 1-3 targets, at least 2:1 to the first target. If the honest answer is "no edge until price
proves X", set tradeable_today=false and name the level to watch in expected_path. Never revise INTO a fight with
strong momentum — the pivot either goes WITH the new move or stands aside at a defined level.
Entry zones must point the SAME way as your new_bias; do not hedge with both directions. You may add ONE
counter-direction level marked role "fade-at-target" for where the new move is expected to exhaust — everything
else is role "entry".`;

async function reviseCalls(client, outlook, flaggedSyms, statuses, releases, heads) {
  const payload = {
    broken_calls: outlook.instruments.filter(i => flaggedSyms.includes(i.symbol)),
    live_status: Object.fromEntries(flaggedSyms.map(s => [s, statuses[s]]).filter(([, v]) => v)),
    released_data_this_week: releases,
    headline_context: heads,
  };
  const { parsed } = await jsonCall(client, {
    system: REVISE_PROMPT,
    content: `Revise these broken calls.\n\n${JSON.stringify(payload)}`,
    schema: REVISE_TOOL.input_schema, max_tokens: 8000,
  });
  return Array.isArray(parsed.revisions) ? parsed.revisions : [];
}

// how is each weekly call doing against this week's actual price action?
function statusFor(inst, d1bars, atrD) {
  // bars from this ISO week (Mon 00:00 UTC)
  const now = new Date();
  const dow = (now.getUTCDay() + 6) % 7;
  const monday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dow) / 1000;
  const wk = d1bars.filter(b => b.t >= monday);
  const last = d1bars[d1bars.length - 1];
  const weekOpen = wk.length ? wk[0].o : last.o;
  const hi = wk.length ? Math.max(...wk.map(b => b.h)) : last.h;
  const lo = wk.length ? Math.min(...wk.map(b => b.l)) : last.l;
  const move = last.c - weekOpen;
  const dir = Math.abs(move) < 0.15 * atrD ? 'flat' : move > 0 ? 'up' : 'down';
  const biasDir = inst.bias === 'bullish' ? 'up' : inst.bias === 'bearish' ? 'down' : null;
  let bias_status = 'n/a';
  if (biasDir) bias_status = dir === 'flat' ? 'undecided' : dir === biasDir ? 'confirming' : 'against';
  const zones = (inst.entry_zones || []).map(z => {
    const invalidated = z.direction === 'long' ? lo < z.invalidation : hi > z.invalidation;
    const mid = (z.zone_low + z.zone_high) / 2;
    const distAtr = r5(Math.abs(last.c - mid) / (atrD || 1));
    const touched = z.zone_low <= hi && z.zone_high >= lo;
    return { ...z, invalidated, touched_this_week: touched, dist_atr_from_price: distAtr };
  });
  return { last_close: r5(last.c), week_open: r5(weekOpen), week_dir_so_far: dir, bias_status, week_high: r5(hi), week_low: r5(lo), atrD: r5(atrD), zones };
}

const BRIEF_TOOL = {
  name: 'submit_daily_brief',
  description: 'Submit the daily confirmation brief',
  strict: true,   // API-validated tool input — kills the malformed/leaked-output failure mode
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['day_note', 'instruments'],
    properties: {
      day_note: { type: 'string', description: '2-4 sentences: is the week playing out as called, what matters today (events), where are the live opportunities' },
      instruments: { type: 'array', items: { type: 'object',
        additionalProperties: false,
        required: ['symbol', 'status', 'note'],
        properties: {
          symbol: { type: 'string' },
          status: { type: 'string', enum: ['on_track', 'against', 'invalidated', 'played_out', 'undecided'] },
          note:   { type: 'string', description: 'one line: what price did vs the call, and the plan for today' },
          avoid_today:   { type: 'boolean', description: 'true if the scanner should not trade this instrument today (idea invalidated, fighting the bias hard, or a red-flag event makes it a coin flip)' },
          favored_today: { type: 'boolean', description: 'true if aligned with the weekly call AND near a live entry zone' },
        } } },
      score_threshold_override: { type: 'number', description: 'ONLY to RAISE the scanner bar on heavy-event days (6-12). Omit for normal days.' },
      skip_today: { type: 'boolean', description: 'true ONLY in extreme conditions (crisis gap, all ideas invalidated)' },
      skip_reason: { type: 'string' },
    },
  },
};

const SYSTEM_PROMPT = `You are the morning desk analyst. The weekly outlook made committed calls; your job each
morning is to CONFIRM or DENY them with fresh price action and set today's guardrails for the automated scanner.

You get: the weekly outlook (bias, expected path, entry zones with invalidation/targets), a programmatic status
per instrument (week direction vs bias, which zones are live/touched/invalidated, distance from price in ATR),
and today's verified economic events.

Rules:
- The weekly call is the framework. Your job is confirmation, not a new opinion — only mark 'against' or
  'invalidated' when price action actually says so (invalidation breached, or strong movement contrary to bias).
- avoid_today: instruments whose weekly idea is invalidated, or fighting the bias hard, or facing a red-flag
  event today that makes direction a coin flip until the print.
- favored_today: aligned with the weekly call AND price is at/near a live entry zone (within ~1 ATR).
- score_threshold_override: only to RAISE the bar (never lower) on days loaded with high-impact events.
- skip_today only for extreme conditions. Missing a day costs little; a blown week costs a lot.
- Keep notes short and actionable — they go on the trading journal page.`;

// structured outputs (output_config.format) — the whole response IS schema-valid JSON;
// forced tool_choice kept coming back with XML-mangled/empty arguments on big payloads
async function jsonCall(client, { system, content, schema, max_tokens }) {
  const resp = await client.messages.create({
    model: 'claude-opus-4-8', max_tokens,
    system,
    messages: [{ role: 'user', content }],
    output_config: { format: { type: 'json_schema', schema } },
  });
  const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return { parsed: JSON.parse(text), stop_reason: resp.stop_reason };
}

async function runBrief(client, payload) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { parsed, stop_reason } = await jsonCall(client, {
        system: SYSTEM_PROMPT,
        content: `Morning check.\n\n${JSON.stringify(payload)}`,
        schema: BRIEF_TOOL.input_schema, max_tokens: 6000,
      });
      if (Array.isArray(parsed.instruments) && parsed.instruments.length) return parsed;
      log(`brief came back empty (stop_reason=${stop_reason}) — ${attempt < 2 ? 'retrying' : 'giving up'}`);
    } catch (e) { log(`brief attempt ${attempt} failed: ${e.message}`); }
  }
  // fail HARD: a broken brief must never write a permissive daily context
  throw new Error('brief empty after 2 attempts — no daily_context written (scanner runs on defaults)');
}

async function appendToOutlookPage(pageId, brief, revisions = []) {
  if (!NOTION_TOKEN || !pageId) return;
  const P = t => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: String(t).slice(0, 1900) } }] } });
  const H = t => ({ object: 'block', type: 'heading_3', heading_3: { rich_text: [{ text: { content: String(t).slice(0, 190) } }] } });
  const today = new Date();
  const icon = { on_track: '✅', against: '⚠️', invalidated: '❌', played_out: '🏁', undecided: '➖' };
  const children = [H(`📆 ${DAY[today.getUTCDay()]} ${today.toISOString().slice(5, 10)} — daily check`), P(brief.day_note || '—')];
  for (const i of brief.instruments) {
    children.push(P(`${icon[i.status] || '·'} ${i.symbol} ${i.status}${i.favored_today ? ' ⭐' : ''}${i.avoid_today ? ' 🚫' : ''} — ${i.note}`));
  }
  for (const rev of revisions) {
    children.push(H(`🔄 ${rev.symbol} REVISED → ${String(rev.new_bias).toUpperCase()}${rev.tradeable_today ? ' (tradeable today)' : ' (needs confirmation)'}`));
    children.push(P(`Why it broke: ${rev.why}`));
    children.push(P(`New plan: ${rev.expected_path}`));
    for (const z of rev.entry_zones || []) {
      const tag = z.role === 'fade-at-target' ? '🎯 FADE-AT-TARGET' : (z.direction === 'long' ? '🟢 LONG' : '🔴 SHORT');
      children.push(P(`${tag} zone ${z.zone_low}–${z.zone_high} | trigger: ${z.trigger || 'zone tap'} | invalid: ${z.invalidation} | targets: ${(z.targets || []).join(' → ')}`));
    }
  }
  const r = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, { method: 'PATCH',
    headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NV, 'Content-Type': 'application/json' },
    body: JSON.stringify({ children: children.slice(0, 40) }) });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(`append ${r.status} ${j.message}`); }
}

async function main() {
  log('=== DAILY BRIEF ===');
  if (!process.env.ANTHROPIC_API_KEY) { log('no ANTHROPIC_API_KEY — abort'); process.exit(1); }
  let outlook = null;
  try { outlook = JSON.parse(readFileSync(OUTLOOK_FILE, 'utf8')); } catch {}
  if (!outlook?.instruments?.length) { log('no weekly_outlook.json — run weekly_outlook.mjs first'); process.exit(1); }
  const ageDays = (Date.now() - Date.parse(outlook.generated)) / 86400e3;
  if (ageDays > 9) log(`⚠ outlook is ${ageDays.toFixed(1)} days old — stale week`);

  // the brief confirms the outlook against ITS OWN week — on weekends the outlook
  // already targets the coming week and there is nothing to confirm yet
  const nowD = new Date();
  const thuD = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate() - ((nowD.getUTCDay() + 6) % 7) + 3));
  const firstThu = new Date(Date.UTC(thuD.getUTCFullYear(), 0, 4));
  const curWeek = `${thuD.getUTCFullYear()}-W${String(1 + Math.round(((thuD - firstThu) / 864e5 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7)).padStart(2, '0')}`;
  if (outlook.week !== curWeek) { log(`outlook targets ${outlook.week}, current week is ${curWeek} — nothing to confirm yet`); process.exit(0); }

  const statuses = {};
  for (const inst of outlook.instruments) {
    const cand = SYMBOLS[inst.symbol] || [inst.symbol];
    const d1 = await fetchBars(cand, 'D1', 40);
    if (!d1) { log(`✗ ${inst.symbol}: no data — skipped`); continue; }
    statuses[inst.symbol] = statusFor(inst, d1.bars, atr(d1.bars));
    log(`✓ ${inst.symbol}: week ${statuses[inst.symbol].week_dir_so_far}, bias ${statuses[inst.symbol].bias_status}`);
  }

  const events = await todaysEvents();
  const client = new Anthropic();
  const brief = await runBrief(client, {
    week: outlook.week, weekly_summary: outlook.week_summary,
    weekly_calls: outlook.instruments,
    live_status: statuses,
    todays_events: events,
  });

  const dateStr = new Date().toISOString().slice(0, 10);

  // ── REVISION STAGE: a broken call gets a root-cause + a NEW plan, not a shrug ──
  const flaggedSyms = brief.instruments.filter(i => ['against', 'invalidated'].includes(i.status)).map(i => i.symbol);
  let revisions = [];
  if (flaggedSyms.length) {
    log(`⚠ ${flaggedSyms.length} weekly calls broken (${flaggedSyms.join(', ')}) — finding out why + revising...`);
    const releases = await weekReleases();
    const heads = await headlines(client, flaggedSyms);
    try { revisions = await reviseCalls(client, outlook, flaggedSyms, statuses, releases, heads); }
    catch (e) { log(`revision stage failed: ${e.message}`); }
    for (const rev of revisions) {
      const idx = outlook.instruments.findIndex(x => x.symbol === rev.symbol);
      if (idx < 0) continue;
      const orig = outlook.instruments[idx];
      outlook.instruments[idx] = {
        ...orig, bias: rev.new_bias, confidence: rev.confidence || 'medium',
        expected_path: rev.expected_path, entry_zones: rev.entry_zones || [],
        revised_on: dateStr, revision_why: rev.why,
        original_bias: orig.original_bias || orig.bias, original_path: orig.original_path || orig.expected_path,
      };
      log(`🔄 ${rev.symbol}: ${orig.bias} → ${rev.new_bias}${rev.tradeable_today ? ' (tradeable today)' : ' (watch level first)'} — ${rev.why}`);
    }
    if (revisions.length) writeFileSync(OUTLOOK_FILE, JSON.stringify(outlook, null, 2));   // next mornings confirm against the REVISED calls
  }

  // guardrails on the guardrails
  if (brief.score_threshold_override != null && (brief.score_threshold_override < 6 || brief.score_threshold_override > 12)) brief.score_threshold_override = null;
  const tradeableRevised = new Set(revisions.filter(r => r.tradeable_today).map(r => r.symbol.toUpperCase()));
  const avoid = brief.instruments.filter(i => i.avoid_today).map(i => i.symbol.toUpperCase())
    .filter(s => !tradeableRevised.has(s));   // a revised, actionable plan lifts the block
  const favored = brief.instruments.filter(i => i.favored_today).map(i => i.symbol.toUpperCase());
  if (brief.skip_today) log(`⚠ SKIP TODAY: ${brief.skip_reason || 'no reason'}`);

  // 1) the file session_runner already consumes
  mkdirSync(CTX_DIR, { recursive: true });
  const ctx = {
    generated: new Date().toISOString(), source: 'daily_brief (weekly-outlook confirmation)',
    session_bias: brief.day_note?.slice(0, 160) || '',
    skip_today: !!brief.skip_today, skip_reason: brief.skip_reason || null,
    score_threshold_override: brief.score_threshold_override ?? null,
    instruments_to_avoid_today: avoid,
    favored_today: favored,
  };
  writeFileSync(join(CTX_DIR, `${dateStr}.json`), JSON.stringify(ctx, null, 2));
  log(`ctx → daily_context/${dateStr}.json  avoid=[${avoid.join(',')}] favored=[${favored.join(',')}] threshold=${ctx.score_threshold_override ?? 'default'}`);

  // 2) full brief for other consumers
  writeFileSync(BRIEF_FILE, JSON.stringify({ date: dateStr, week: outlook.week, ...brief, revisions }, null, 2));

  // 3) journal it on the weekly outlook page
  try { await appendToOutlookPage(outlook.outlook_page_id, brief, revisions); log('📄 appended to weekly outlook page'); }
  catch (e) { log(`Notion append failed: ${e.message}`); }

  log(`day note: ${brief.day_note}`);
  for (const i of brief.instruments) log(`  ${i.symbol} ${i.status}${i.favored_today ? ' ⭐' : ''}${i.avoid_today ? ' 🚫' : ''}: ${i.note}`);
  log('=== DONE ===');
  process.exit(0);
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
