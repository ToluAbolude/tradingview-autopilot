/**
 * daily_plan.mjs — the PRE-MARKET ANALYST. Runs once every weekday morning before
 * London and commits, in writing, to what each core instrument is expected to do
 * today and WHERE we get paid.
 *
 * Why this exists (2026-07-30): the scanner account lost -$6,667 over 147 trades in
 * six weeks at a ~20% win rate. Root cause was not the analysis — it was that the
 * system ran signal → trade. A 15m indicator pinged, a score cleared, an order went
 * out, on any of 40 instruments, with no prior opinion about any of them. Non-USD
 * crosses alone accounted for -$7,790 while everything else netted +$1,123.
 *
 * This inverts the causality to thesis → level → wait → trade, which is how a desk
 * (and every credible signal channel) actually operates. Each morning this writes a
 * plan naming, per instrument: the bias, WHY, an entry ZONE (a band, never a single
 * price), the invalidation, the targets, and the day's volatility budget. Then
 * inline_trader's plan gate refuses to originate any trade that is not in the plan.
 *
 * If price never reaches a planned zone, there is no trade that day. That is the
 * intended behaviour, not a failure.
 *
 * Two layers, deliberately:
 *   1. DETERMINISTIC (this file, no LLM): prior-day/week levels, ADR budget, ATR,
 *      EMAs, swing structure, S/R shelves, and the AutoTL trendline read. These are
 *      reproducible and never hallucinated.
 *   2. ANALYST (Claude): reads those numbers plus today's macro calendar and commits
 *      to bias + zones in language a trader can act on and be graded against.
 * Every zone Claude returns is then re-validated in code (R:R vs invalidation,
 * reachability inside the remaining ADR, direction consistency with the bias).
 * A zone that fails validation stays visible in the plan but is marked non-tradeable.
 *
 * Deliberately CDP-free: it reads bars from cTrader only, so a dead chart / snap
 * refresh / Xvfb outage cannot stop the plan being produced (July 2026 taught us
 * that the chart is the least reliable component in the stack).
 *
 * Outputs: trading-data/daily_plan.json (consumed by inline_trader's plan gate),
 *          a Notion page in the week's journal DB, and an HTML email.
 * Grades yesterday's plan on every run, so the analyst is held to its calls daily.
 *
 * Cron: weekdays 06:00 UTC. Needs ~/.ctrader.env + ~/.notion.env + ~/.anthropic.env.
 * Usage: node scripts/trading/daily_plan.mjs [--dry-run] [--no-notion]
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { getTrendbars } from './broker_ctrader.mjs';
import { autoTrendline } from './auto_trendline.mjs';

const IS_LINUX  = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX ? '/home/ubuntu/trading-data' : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const PLAN_FILE    = join(DATA_ROOT, 'daily_plan.json');
const HISTORY_FILE = join(DATA_ROOT, 'daily_plan_history.jsonl');
const HTML_FILE    = join(DATA_ROOT, 'daily_plan.html');
const LOG_FILE     = join(DATA_ROOT, 'daily_plan.log');
const WEEK_DB_FILE = join(DATA_ROOT, 'notion_week_dbs.json');

const NOTION_TOKEN = process.env.NOTION_TOKEN, NOTION_DB = process.env.NOTION_DB, NV = '2022-06-28';
const DRY_RUN   = process.argv.includes('--dry-run');
const NO_NOTION = process.argv.includes('--no-notion');

// ── The universe ─────────────────────────────────────────────────────────────
// EIGHT instruments. Chosen from the ledger, not from taste: metals, indices, USD
// majors and BTC were the classes that were net POSITIVE while the 28 crosses the
// old scanner sprawled into lost -$7,790. Non-USD crosses are deliberately absent
// and should stay absent — wide spread, no clean structure, and they are just two
// majors wearing a trench coat.
const SYMBOLS = {
  XAUUSD: ['XAUUSD', 'GOLD'],
  NAS100: ['NAS100', 'USTEC'],
  US30:   ['US30', 'DJ30'],
  GER40:  ['GER40', 'GER30', 'DE40'],
  EURUSD: ['EURUSD'],
  GBPUSD: ['GBPUSD'],
  USDJPY: ['USDJPY'],
  BTCUSD: ['BTCUSD'],
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const r5 = x => Number(Number(x).toPrecision(6));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(m) {
  const line = `[${new Date().toISOString()}] ${m}\n`;
  process.stdout.write(line);
  try { appendFileSync(LOG_FILE, line); } catch (_) {}
}

// ── bars ─────────────────────────────────────────────────────────────────────
async function fetchBars(candidates, period, days) {
  for (const name of candidates) {
    try {
      const b = await getTrendbars(name, { period, fromMs: Date.now() - days * 86400e3, toMs: Date.now(), windowDays: 30 });
      // cTrader trendbar t is in MILLISECONDS — normalise to seconds (everything downstream assumes seconds)
      if (b && b.length > 10) return { name, bars: b.map(x => ({ ...x, t: x.t > 1e12 ? Math.round(x.t / 1000) : x.t })) };
    } catch (_) { /* try next candidate name */ }
  }
  return null;
}

// ── indicators (pure) ────────────────────────────────────────────────────────
function ema(closes, n) {
  const k = 2 / (n + 1); let e = closes[0];
  for (const c of closes) e = c * k + e * (1 - k);
  return e;
}

function atrSeries(bars, n = 14) {
  const out = [];
  const trs = [];
  for (let i = 0; i < bars.length; i++) {
    const tr = i === 0 ? bars[0].h - bars[0].l
      : Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    trs.push(tr);
    const w = trs.slice(Math.max(0, i - n + 1), i + 1);
    out.push(w.reduce((s, x) => s + x, 0) / w.length);
  }
  return out;
}
const atr = (bars, n = 14) => atrSeries(bars, n)[bars.length - 1] || 0;

function swings(bars, k = 2, keep = 8) {
  const out = [];
  for (let i = k; i < bars.length - k; i++) {
    const w = bars.slice(i - k, i + k + 1);
    if (bars[i].h === Math.max(...w.map(b => b.h))) out.push({ t: bars[i].t, type: 'high', p: r5(bars[i].h) });
    if (bars[i].l === Math.min(...w.map(b => b.l))) out.push({ t: bars[i].t, type: 'low', p: r5(bars[i].l) });
  }
  return out.slice(-keep).map(p => ({ ...p, date: new Date(p.t * 1000).toISOString().slice(0, 10) }));
}


/** S/R shelves: cluster recent pivots that repeat within ½ ATR; more touches = stronger. */
function srShelves(bars, a, maxOut = 6) {
  const piv = swings(bars, 3, 40);
  const tol = a * 0.5;
  const clusters = [];
  for (const p of piv) {
    const c = clusters.find(c => Math.abs(c.price - p.p) <= tol);
    if (c) { c.touches++; c.price = (c.price * (c.touches - 1) + p.p) / c.touches; c.lastT = Math.max(c.lastT, p.t); }
    else clusters.push({ price: p.p, touches: 1, lastT: p.t, type: p.type });
  }
  return clusters
    .filter(c => c.touches >= 2)
    .sort((x, y) => y.touches - x.touches || y.lastT - x.lastT)
    .slice(0, maxOut)
    .map(c => ({ price: r5(c.price), touches: c.touches, last: new Date(c.lastT * 1000).toISOString().slice(0, 10) }));
}

// ── session boundaries ───────────────────────────────────────────────────────
/**
 * cTrader stamps a D1 bar at the START of the broker session, which is 21:00 UTC
 * of the PREVIOUS calendar day — the bar labelled 2026-07-29T21:00Z is the session
 * that runs to 21:00Z on the 30th, i.e. "today". Comparing that label against
 * today's date string (the obvious implementation, and the one this file shipped
 * with for an hour) marks the live session as "not today", which silently zeroes
 * the ADR budget and makes prevDay actually today. Split on the session window
 * instead: a bar stamped t covers [t, t+24h).
 */
function splitSessions(d1) {
  const now = Date.now();
  const lastIdx = d1.length - 1;
  const last = d1[lastIdx];
  const isLive = last && now < last.t * 1000 + 86400e3;
  return {
    current: isLive ? last : null,                       // the session in progress
    completed: isLive ? d1.slice(0, lastIdx) : d1,       // everything already closed
  };
}

// ── the volatility / movement budget ─────────────────────────────────────────
/**
 * ADR is the piece the old system never computed, and it is exactly the "market
 * volatility / movement" read that was missing. A day has a budget. If gold has an
 * 85-point ADR and has already travelled 70 by the time a signal fires, there is 15
 * points left — that is not a 3R short, and selling the low of a spent range is how
 * the scanner kept buying tops and selling bottoms.
 */
function volatilityBudget(d1) {
  const { current, completed } = splitSessions(d1);
  const last20 = completed.slice(-20);
  const adr20 = last20.reduce((s, b) => s + (b.h - b.l), 0) / Math.max(1, last20.length);
  const todayRange = current ? current.h - current.l : 0;
  const usedPct = adr20 > 0 ? (todayRange / adr20) * 100 : 0;
  return {
    adr20: r5(adr20),
    todayRangeSoFar: r5(todayRange),
    adrUsedPct: Math.round(usedPct),
    adrRemaining: r5(Math.max(0, adr20 - todayRange)),
    todayOpen: current ? r5(current.o) : null,
    todayHigh: current ? r5(current.h) : null,
    todayLow: current ? r5(current.l) : null,
  };
}

/** Asian-session range (00:00–07:00 UTC today) — the classic London-open reference. */
function asianRange(h1) {
  const today = new Date().toISOString().slice(0, 10);
  const bars = h1.filter(b => {
    const d = new Date(b.t * 1000);
    return d.toISOString().slice(0, 10) === today && d.getUTCHours() < 7;
  });
  if (bars.length < 2) return null;
  return { high: r5(Math.max(...bars.map(b => b.h))), low: r5(Math.min(...bars.map(b => b.l))), bars: bars.length };
}

// ── per-instrument data pack ─────────────────────────────────────────────────
async function buildInstrumentData() {
  const out = {};
  for (const [sym, candidates] of Object.entries(SYMBOLS)) {
    const d1r = await fetchBars(candidates, 'D1', 260);
    if (!d1r) { log(`✗ ${sym}: no D1 data on cTrader — skipped`); continue; }
    const h4r = await fetchBars([d1r.name], 'H4', 45);
    const h1r = await fetchBars([d1r.name], 'H1', 12);

    const d1 = d1r.bars, h4 = h4r?.bars || [], h1 = h1r?.bars || [];
    const closes = d1.map(b => b.c);
    const price = r5(h1.length ? h1[h1.length - 1].c : d1[d1.length - 1].c);

    // previous COMPLETE session (see splitSessions — NOT a calendar-date match)
    const { completed } = splitSessions(d1);
    const pd = completed[completed.length - 1];

    // previous complete Mon–Fri week + this week's open
    const prevWeekBars = completed.slice(-10, -5);
    const thisWeekBars = completed.slice(-5);

    const aD1 = atr(d1), aH4 = h4.length ? atr(h4) : null;

    out[sym] = {
      ctraderName: d1r.name,
      price,
      prevDay: pd ? { high: r5(pd.h), low: r5(pd.l), close: r5(pd.c), open: r5(pd.o) } : null,
      prevWeek: prevWeekBars.length ? {
        high: r5(Math.max(...prevWeekBars.map(b => b.h))),
        low: r5(Math.min(...prevWeekBars.map(b => b.l))),
        close: r5(prevWeekBars[prevWeekBars.length - 1].c),
      } : null,
      weekOpen: thisWeekBars.length ? r5(thisWeekBars[0].o) : null,
      volatility: volatilityBudget(d1),
      asianRange: asianRange(h1),
      atrD14: r5(aD1),
      atrH4: aH4 != null ? r5(aH4) : null,
      emaD20: r5(ema(closes.slice(-60), 20)),
      emaD50: r5(ema(closes.slice(-120), 50)),
      // The trendline read the operator designated PRIMARY (2026-07-08). H4×180 is
      // the same window daily_selector uses, so the two agree on trend by construction.
      autoTL_H4: h4.length >= 40 ? autoTrendline(h4.slice(-180)) : { dir: null, detail: 'insufficient H4 bars', touches: 0 },
      autoTL_D1: autoTrendline(d1.slice(-180)),
      srShelves: srShelves(d1.slice(-120), aD1),
      swings: swings(d1.slice(-90)),
      d1_last30: d1.slice(-30).map(b => [new Date(b.t * 1000).toISOString().slice(5, 10), r5(b.o), r5(b.h), r5(b.l), r5(b.c)]),
      h4_last36: h4.slice(-36).map(b => [new Date(b.t * 1000).toISOString().slice(5, 13), r5(b.h), r5(b.l), r5(b.c)]),
    };
    const tl = out[sym].autoTL_H4;
    log(`✓ ${sym} (${d1r.name}) px=${price} ADR20=${out[sym].volatility.adr20} used=${out[sym].volatility.adrUsedPct}% TL=${tl.dir || 'none'} (${tl.detail})`);
    await sleep(150);
  }
  return out;
}

// ── grading yesterday ────────────────────────────────────────────────────────
/**
 * The analyst is graded every single morning on the plan it wrote yesterday: was the
 * bias right, did price actually reach the zones, did invalidations trigger, did
 * targets pay. This is the only mechanism that turns a plan into a track record —
 * and the scorecard is fed back into the next prompt, so the analyst sees its own
 * hit rate.
 */
function gradePrevious(prev, data) {
  if (!prev?.instruments?.length) return null;
  const lines = [];
  let biasHits = 0, biasCalls = 0, zonesTouched = 0, zonesTotal = 0, targetsHit = 0, invalidations = 0;

  for (const inst of prev.instruments) {
    const d = data[inst.symbol];
    if (!d?.prevDay) continue;
    const { high: hi, low: lo, open, close } = d.prevDay;

    const dirOk = inst.bias === 'bullish' ? close > open
      : inst.bias === 'bearish' ? close < open
      : inst.bias === 'range' ? Math.abs(close - open) / open < 0.005 : null;
    if (dirOk !== null) { biasCalls++; if (dirOk) biasHits++; }

    const zones = (inst.entry_zones || []).filter(z => z.role !== 'fade-at-target');
    const touched = zones.filter(z => z.zone_low <= hi && z.zone_high >= lo);
    zonesTotal += zones.length; zonesTouched += touched.length;

    const tHit = touched.flatMap(z => z.targets || []).filter(t => t >= lo && t <= hi).length;
    targetsHit += tHit;
    const inv = touched.filter(z => z.direction === 'long' ? lo <= z.invalidation : hi >= z.invalidation).length;
    invalidations += inv;

    lines.push(`${inst.symbol}: ${inst.bias} ${dirOk === null ? '—' : dirOk ? '✅' : '❌'} `
      + `(${open}→${close}, range ${lo}–${hi}) · ${touched.length}/${zones.length} zones reached`
      + (touched.length ? ` · ${tHit} target(s) hit · ${inv} invalidated` : ''));
  }

  const wr = biasCalls ? Math.round((biasHits / biasCalls) * 100) : 0;
  return {
    date: prev.date,
    lines,
    summary: biasCalls
      ? `${biasHits}/${biasCalls} directional calls correct (${wr}%) · ${zonesTouched}/${zonesTotal} zones reached · ${targetsHit} targets hit · ${invalidations} invalidated`
      : 'no directional calls yesterday',
    stats: { biasHits, biasCalls, zonesTouched, zonesTotal, targetsHit, invalidations },
  };
}

/** Rolling scorecard so the analyst sees more than one day of its own history. */
function rollingRecord(days = 20) {
  if (!existsSync(HISTORY_FILE)) return null;
  try {
    const rows = readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).slice(-days);
    if (!rows.length) return null;
    const s = rows.reduce((a, r) => ({
      biasHits: a.biasHits + (r.stats?.biasHits || 0), biasCalls: a.biasCalls + (r.stats?.biasCalls || 0),
      zonesTouched: a.zonesTouched + (r.stats?.zonesTouched || 0), zonesTotal: a.zonesTotal + (r.stats?.zonesTotal || 0),
      targetsHit: a.targetsHit + (r.stats?.targetsHit || 0),
    }), { biasHits: 0, biasCalls: 0, zonesTouched: 0, zonesTotal: 0, targetsHit: 0 });
    if (!s.biasCalls) return null;
    return `Last ${rows.length} sessions: ${s.biasHits}/${s.biasCalls} directional calls correct `
      + `(${Math.round(s.biasHits / s.biasCalls * 100)}%), ${s.zonesTouched}/${s.zonesTotal} zones reached, ${s.targetsHit} targets hit.`;
  } catch { return null; }
}

// ── macro calendar (today only) ──────────────────────────────────────────────
async function macroToday() {
  try {
    const r = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (r.ok) {
      const ev = await r.json();
      const today = new Date().toISOString().slice(0, 10);
      const keep = (ev || [])
        .filter(e => /high|medium/i.test(e.impact || ''))
        .filter(e => new Date(e.date).toISOString().slice(0, 10) === today)
        .sort((a, b) => new Date(a.date) - new Date(b.date));
      if (keep.length) {
        const lines = keep.map(e => {
          const d = new Date(e.date);
          return `${d.toISOString().slice(11, 16)}Z ${e.country} [${e.impact}] ${e.title}`
            + (e.forecast ? ` (fcst ${e.forecast}, prev ${e.previous})` : '');
        });
        log(`calendar: ${keep.length} events today (ForexFactory)`);
        return 'VERIFIED economic calendar for TODAY (times UTC):\n' + lines.join('\n');
      }
      log('calendar: no high/medium impact events today');
      return 'No high or medium impact scheduled events today.';
    }
  } catch (e) { log(`FF calendar failed (${e.message}) — proceeding without`); }
  return 'Calendar unavailable — treat event risk as unknown and size accordingly.';
}

// ── the analyst ──────────────────────────────────────────────────────────────
const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['day_summary', 'instruments'],
  properties: {
    day_summary: { type: 'string', description: '3-5 sentences: the cross-market picture for TODAY — risk on/off, USD, what today hinges on, which instrument is the cleanest opportunity.' },
    instruments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['symbol', 'bias', 'confidence', 'expected_path', 'entry_zones'],
        properties: {
          symbol:        { type: 'string' },
          bias:          { type: 'string', enum: ['bullish', 'bearish', 'range', 'no-view'] },
          confidence:    { type: 'string', enum: ['high', 'medium', 'low'] },
          expected_path: { type: 'string', description: 'The committed call for today in plain language, e.g. "London sweeps yesterday\'s low at 3812 for liquidity, reclaims, then runs the 3865 high into NY". One or two sentences.' },
          volatility_note: { type: 'string', description: 'What the ADR budget implies today: how much range is left, whether the move is already spent, whether targets must be trimmed.' },
          entry_zones: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['direction', 'zone_low', 'zone_high', 'trigger', 'invalidation', 'targets', 'rationale'],
              properties: {
                direction:    { type: 'string', enum: ['long', 'short'] },
                role:         { type: 'string', enum: ['entry', 'fade-at-target'], description: 'entry = trade IN the bias direction (default). fade-at-target = a counter-direction exhaustion marker at the END of the expected path, NOT a primary entry.' },
                zone_low:     { type: 'number' },
                zone_high:    { type: 'number' },
                trigger:      { type: 'string', description: 'What must be SEEN before entering — e.g. "M15 rejection wick + close back inside", "break and retest of 3840". Never "price touches the zone" alone.' },
                invalidation: { type: 'number', description: 'Price beyond which the idea is wrong. This becomes the stop.' },
                targets:      { type: 'array', items: { type: 'number' }, description: '1-3 targets, first one at least 2R from zone mid vs invalidation.' },
                rationale:    { type: 'string', description: 'The structure this is anchored to — prior day high/low, trendline, S/R shelf, weekly open, session range.' },
                session:      { type: 'string', enum: ['london', 'ny', 'either'], description: 'Which session this zone is expected to trigger in.' },
              },
            },
          },
          key_levels: { type: 'array', items: { type: 'number' }, description: 'The prices that matter today, in order of importance.' },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are the pre-market analyst for a systematic trading desk. Before London opens you
commit, in writing, to what each instrument will do today and where the desk gets paid. You are graded the
next morning on whether you were right, and your rolling hit rate is shown back to you.

You are replacing a system that lost money by taking ~25 reactive trades a week at a 20% win rate across 40
instruments with no prior opinion about any of them. Your job is the opposite: few, pre-planned, high-conviction
levels the desk waits for. A day where price never reaches your zones and nobody trades is a SUCCESSFUL day.

For each instrument you receive: current price, previous day open/high/low/close, previous week high/low/close,
this week's open, the ADR(20) volatility budget (average daily range, range used so far today, range remaining),
today's Asian-session range, daily ATR(14) and H4 ATR, daily EMA20/EMA50, the AutoTL trendline read on H4 and D1
(best-fit line with >=3 touches; "BROKEN" means a body close through the zone flipped it), clustered S/R shelves
with touch counts, recent daily swing highs/lows, the last 30 daily candles [MM-DD,o,h,l,c] and last 36 H4
candles [MM-DDTHH,h,l,c].

HARD RULES:
- COMMIT. "Could go either way" is worthless. If structure is genuinely unclear, say bias "no-view" and return
  ZERO entry zones for that instrument. An honest no-view beats a manufactured setup — the desk's biggest
  historical loss came from trading instruments it had no opinion on.
- Expect to return no-view or range on several instruments most days. Two to four genuinely good zones across
  the whole book is a strong day. Ten zones means you are manufacturing.
- Entry zones are BANDS, never single prices, and must sit where price is NOT currently trading — the desk waits
  for price to come to the level. Do not build a zone around the current price just to guarantee a fill.
- Zones must point the SAME way as the bias (bullish -> long zones, bearish -> short zones). Do not scatter both
  a long and a short entry on a directional call; that is hedging, not a prediction. Two exceptions: bias "range"
  may carry one long and one short zone, and you may add ONE counter-direction level marked role
  "fade-at-target" marking where the expected move exhausts.
- RESPECT THE VOLATILITY BUDGET. If adrUsedPct is already high (say 70%+), the day's move is largely spent:
  do not plan a fresh continuation entry chasing a range that has already travelled, and trim targets to what
  the remaining range can actually deliver. If adrUsedPct is low, there is room for the full expected path.
  State this explicitly in volatility_note.
- THE 2R TEST, which is checked in code and is the most common reason a zone is thrown away. Let M be the
  MIDPOINT of your zone, I the invalidation, T the first target. Compute risk = |M - I| and reward = |T - M|.
  reward / risk MUST be >= 2.0. Do the arithmetic explicitly for every zone before you submit it.
  The failure mode to avoid: a wide zone with the stop parked far beyond it and a nearby first target. Put the
  invalidation JUST past the far edge of the zone — that is what the zone is for; it is the level that, once
  lost, proves the idea wrong. If the honest structural invalidation is so far away that the first realistic
  target cannot pay 2R, the trade does not exist: tighten the zone, or drop it and say so. Never stretch a
  target to a price the day cannot reach just to pass the test — the ADR budget is checked separately.
- Anchor every zone to structure you can name: prior day high/low, the AutoTL trendline, an S/R shelf and its
  touch count, the weekly open, the Asian range extreme. "It looks like support" is not a rationale.
- The trigger field must describe what you need to SEE, not just that price arrived. The desk needs a defined
  entry event so the stop has meaning.
- Note when a call is hostage to a scheduled event, and prefer zones that trigger after the event rather than
  into it.`;

/**
 * Repair pass. When code rejects zones, the analyst gets exactly one chance to fix
 * them with the arithmetic reasons in hand. Without this, a plan whose zones all
 * fail validation silently becomes a no-trade day for a reason nobody sees — and
 * the most common failure (invalidation parked too far past the zone) is a drafting
 * error, not a genuine absence of setups. It may legitimately answer by dropping an
 * idea; a smaller honest plan is the correct outcome.
 */
async function repairPlan(client, plan, data, notes) {
  log(`repair pass: asking the analyst to fix ${notes.length} rejected zone(s)`);
  const brief = {
    rejected_zones: notes,
    market: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { price: v.price, volatility: v.volatility, srShelves: v.srShelves, prevDay: v.prevDay }])),
    your_plan: plan,
  };
  try {
    const resp = await client.messages.create({
      model: 'claude-opus-4-8', max_tokens: 16000, system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content:
`Your plan was validated in code and the zones listed in rejected_zones FAILED. Reasons are given verbatim.

Return the COMPLETE plan again, same instruments, with only the failing zones changed. For each one either:
  (a) fix it — most commonly by moving the invalidation to just past the far edge of the zone so the first
      target clears 2R, or by tightening the zone itself; or
  (b) delete it, and if that leaves the instrument with nothing, set its bias to "no-view".
Do not invent new instruments, do not touch zones that passed, and do not stretch targets beyond what the
remaining ADR can deliver just to satisfy the ratio. Dropping a marginal idea is a perfectly good answer.

${JSON.stringify(brief)}` }],
      output_config: { format: { type: 'json_schema', schema: PLAN_SCHEMA } },
    });
    const fixed = JSON.parse(resp.content.filter(b => b.type === 'text').map(b => b.text).join(''));
    if (Array.isArray(fixed.instruments) && fixed.instruments.length >= Math.min(6, plan.instruments.length)) return fixed;
    log(`repair pass returned ${fixed.instruments?.length ?? 0} instruments — keeping the original plan`);
  } catch (e) {
    log(`repair pass failed (${e.message}) — keeping the original plan`);
  }
  return plan;
}

async function runAnalyst(client, data, events, prevGrade, rolling) {
  const user = {
    date: new Date().toISOString().slice(0, 10),
    weekday: DAY_NAMES[new Date().getUTCDay()],
    scheduled_events_today: events,
    yesterdays_scorecard: prevGrade ? `${prevGrade.summary}\n${prevGrade.lines.join('\n')}` : 'first run — no history',
    your_rolling_record: rolling || 'not enough history yet',
    instruments: data,
  };
  const want = Object.keys(data).length;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await client.messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Write today's trading plan. Cover EVERY one of the ${want} instruments provided — including the ones you have no view on (return them with bias "no-view" and no zones).\n\n${JSON.stringify(user)}` }],
        output_config: { format: { type: 'json_schema', schema: PLAN_SCHEMA } },
      });
      const plan = JSON.parse(resp.content.filter(b => b.type === 'text').map(b => b.text).join(''));
      if (!Array.isArray(plan.instruments)) plan.instruments = [];
      log(`analyst attempt ${attempt}: ${plan.instruments.length}/${want} instruments (stop_reason=${resp.stop_reason})`);
      if (plan.instruments.length >= Math.min(6, want)) return plan;
    } catch (e) {
      log(`analyst attempt ${attempt} failed: ${e.message}`);
    }
  }
  throw new Error('analyst kept returning partial coverage after 3 attempts');
}

// ── deterministic validation of the analyst's zones ──────────────────────────
/**
 * Claude proposes; code disposes. Every zone is re-checked against arithmetic the
 * LLM does not get to argue with. A failing zone is KEPT in the plan (so it is
 * visible and gradeable) but marked tradeable:false, and the plan gate in
 * inline_trader will not open a position on it.
 */
function validatePlan(plan, data) {
  const notes = [];
  for (const inst of plan.instruments) {
    const d = data[inst.symbol];
    if (!d) { inst.entry_zones = []; continue; }
    const price = d.price;
    const remaining = d.volatility.adrRemaining || d.volatility.adr20;

    for (const z of inst.entry_zones || []) {
      const reasons = [];
      const lo = Math.min(z.zone_low, z.zone_high), hi = Math.max(z.zone_low, z.zone_high);
      z.zone_low = r5(lo); z.zone_high = r5(hi);
      const mid = (lo + hi) / 2;
      z.role = z.role || 'entry';

      // 1. direction must agree with the bias (fade-at-target and range are exempt)
      if (z.role === 'entry' && inst.bias !== 'range' && inst.bias !== 'no-view') {
        const want = inst.bias === 'bullish' ? 'long' : 'short';
        if (z.direction !== want) reasons.push(`direction ${z.direction} contradicts ${inst.bias} bias`);
      }

      // 2. invalidation must be on the losing side of the zone
      if (z.direction === 'long' && z.invalidation >= lo) reasons.push('invalidation is not below a long zone');
      if (z.direction === 'short' && z.invalidation <= hi) reasons.push('invalidation is not above a short zone');

      // 3. first target must pay at least 2R against the invalidation
      const risk = Math.abs(mid - z.invalidation);
      const t1 = (z.targets || [])[0];
      const rr = risk > 0 && t1 != null ? Math.abs(t1 - mid) / risk : 0;
      z.rr_to_t1 = Number(rr.toFixed(2));
      if (!(rr >= 2)) reasons.push(`first target is ${rr.toFixed(2)}R (<2R)`);

      // 4. reachability inside today's remaining range. A zone the day cannot
      //    physically reach is a wish, not a plan.
      const distance = price >= lo && price <= hi ? 0 : Math.min(Math.abs(price - lo), Math.abs(price - hi));
      z.distance_from_price = r5(distance);
      z.distance_adr = remaining > 0 ? Number((distance / remaining).toFixed(2)) : null;
      if (remaining > 0 && distance > remaining * 1.5) reasons.push(`${(distance / remaining).toFixed(1)}x the remaining ADR away — unreachable today`);

      z.tradeable = reasons.length === 0;
      if (!z.tradeable) {
        z.rejected_for = reasons;
        notes.push(`${inst.symbol} ${z.direction} ${z.zone_low}-${z.zone_high}: ${reasons.join('; ')}`);
      }
    }
  }
  if (notes.length) { log(`validation rejected ${notes.length} zone(s):`); for (const n of notes) log(`   ✗ ${n}`); }
  return notes;
}

// ── Notion ───────────────────────────────────────────────────────────────────
function isoWeekKey(d = new Date()) {
  const dow = (d.getUTCDay() + 6) % 7;
  const th = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow + 3));
  const firstThu = new Date(Date.UTC(th.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((th - firstThu) / 864e5 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${th.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

async function nfetch(url, opts) {
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j };
}

async function writeNotionPage(plan, prevGrade, dateStr) {
  if (!NOTION_TOKEN || !NOTION_DB) { log('no Notion env — skipping page'); return null; }
  let dbId = NOTION_DB;
  try {
    const cache = JSON.parse(readFileSync(WEEK_DB_FILE, 'utf8'));
    const k = isoWeekKey();
    if (cache[k]) dbId = cache[k];
  } catch (_) {}

  const P = t => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: String(t).slice(0, 1900) } }] } });
  const H = t => ({ object: 'block', type: 'heading_3', heading_3: { rich_text: [{ text: { content: String(t).slice(0, 190) } }] } });

  const children = [H('🌅 Today'), P(plan.day_summary || '—')];
  if (prevGrade) {
    children.push(H(`🧾 Yesterday's calls — ${prevGrade.summary}`));
    for (const l of prevGrade.lines.slice(0, 10)) children.push(P(l));
  }
  for (const inst of plan.instruments) {
    const conf = inst.confidence === 'high' ? '🔥' : inst.confidence === 'medium' ? '·' : '❔';
    children.push(H(`${inst.symbol} — ${String(inst.bias).toUpperCase()} ${conf}`));
    children.push(P(inst.expected_path || ''));
    if (inst.volatility_note) children.push(P(`📏 ${inst.volatility_note}`));
    for (const z of inst.entry_zones || []) {
      const tag = z.role === 'fade-at-target' ? '🎯 FADE' : z.direction === 'long' ? '🟢 LONG' : '🔴 SHORT';
      const flag = z.tradeable ? '' : ` ⛔ NOT TRADEABLE (${(z.rejected_for || []).join('; ')})`;
      children.push(P(`${tag} ${z.zone_low}–${z.zone_high} | trigger: ${z.trigger} | invalid: ${z.invalidation} | targets: ${(z.targets || []).join(' → ')} | ${z.rr_to_t1}R | ${z.rationale}${flag}`));
    }
    if (!(inst.entry_zones || []).length) children.push(P('No zone today — stand aside.'));
  }

  const r = await nfetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NV, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parent: { database_id: dbId },
      properties: { Name: { title: [{ text: { content: `🌅 Daily Plan ${dateStr}` } }] } },
      children: children.slice(0, 95),
    }),
  });
  if (!r.ok) throw new Error(`daily plan page create ${r.status} ${r.j.message}`);
  return { id: r.j.id, url: r.j.url || r.j.id };
}

// ── email ────────────────────────────────────────────────────────────────────
function writeHtml(plan, prevGrade, rolling, data, dateStr) {
  const esc = s => String(s ?? '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const tradeable = plan.instruments.flatMap(i => (i.entry_zones || []).filter(z => z.tradeable && z.role !== 'fade-at-target'));

  let h = `<html><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:760px;margin:0 auto;color:#1a1a1a">
<h2 style="margin-bottom:4px">🌅 Daily Plan — ${dateStr}</h2>
<p style="color:#666;margin-top:0">${tradeable.length} tradeable zone(s) across ${plan.instruments.length} instruments. If price does not reach a zone, we do not trade.</p>
<p style="background:#f6f8fa;padding:12px;border-radius:6px">${esc(plan.day_summary)}</p>`;

  if (prevGrade) {
    h += `<h3>🧾 Yesterday — ${esc(prevGrade.summary)}</h3><ul style="color:#444">`;
    for (const l of prevGrade.lines) h += `<li>${esc(l)}</li>`;
    h += `</ul>`;
  }
  if (rolling) h += `<p style="color:#666"><em>${esc(rolling)}</em></p>`;

  for (const inst of plan.instruments) {
    const d = data[inst.symbol] || {};
    const v = d.volatility || {};
    const colour = inst.bias === 'bullish' ? '#137333' : inst.bias === 'bearish' ? '#c5221f' : '#666';
    h += `<h3 style="color:${colour};margin-bottom:2px">${inst.symbol} — ${String(inst.bias).toUpperCase()} <span style="color:#888;font-weight:normal;font-size:13px">(${inst.confidence} confidence · px ${d.price} · ADR ${v.adr20} used ${v.adrUsedPct}% · TL ${d.autoTL_H4?.dir || 'none'})</span></h3>`;
    h += `<p style="margin-top:2px">${esc(inst.expected_path)}</p>`;
    if (inst.volatility_note) h += `<p style="color:#666;font-size:13px">📏 ${esc(inst.volatility_note)}</p>`;
    const zones = inst.entry_zones || [];
    if (!zones.length) { h += `<p style="color:#999"><em>No zone today — stand aside.</em></p>`; continue; }
    h += `<table style="border-collapse:collapse;width:100%;font-size:13px"><tr style="background:#f0f0f0"><th style="padding:5px;text-align:left">Zone</th><th style="padding:5px;text-align:left">Trigger</th><th style="padding:5px">Invalid</th><th style="padding:5px">Targets</th><th style="padding:5px">R</th></tr>`;
    for (const z of zones) {
      const tag = z.role === 'fade-at-target' ? '🎯' : z.direction === 'long' ? '🟢' : '🔴';
      const style = z.tradeable ? '' : 'opacity:.5;text-decoration:line-through';
      h += `<tr style="border-bottom:1px solid #eee;${style}"><td style="padding:5px">${tag} ${z.zone_low}–${z.zone_high}</td><td style="padding:5px">${esc(z.trigger)}</td><td style="padding:5px;text-align:center">${z.invalidation}</td><td style="padding:5px;text-align:center">${(z.targets || []).join(' → ')}</td><td style="padding:5px;text-align:center">${z.rr_to_t1}</td></tr>`;
      h += `<tr style="${style}"><td colspan="5" style="padding:2px 5px 8px;color:#777;font-size:12px">${esc(z.rationale)}${z.tradeable ? '' : ` — <strong>NOT TRADEABLE: ${esc((z.rejected_for || []).join('; '))}</strong>`}</td></tr>`;
    }
    h += `</table>`;
  }
  h += `<p style="color:#999;font-size:12px;margin-top:24px">Generated by daily_plan.mjs. Zones are the ONLY entries inline_trader will open today.</p></body></html>`;
  writeFileSync(HTML_FILE, h);
  return HTML_FILE;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const dateStr = new Date().toISOString().slice(0, 10);
  log(`=== DAILY PLAN ${dateStr} ===`);
  if (!process.env.ANTHROPIC_API_KEY) { log('no ANTHROPIC_API_KEY — cannot run the analyst'); process.exit(1); }
  const client = new Anthropic();

  const data = await buildInstrumentData();
  if (Object.keys(data).length < 4) { log(`only ${Object.keys(data).length} instruments readable — aborting rather than planning blind`); process.exit(1); }

  let prev = null;
  try { prev = JSON.parse(readFileSync(PLAN_FILE, 'utf8')); } catch (_) {}
  const prevGrade = prev && prev.date !== dateStr ? gradePrevious(prev, data) : null;
  if (prevGrade) {
    log(`yesterday (${prevGrade.date}): ${prevGrade.summary}`);
    try { appendFileSync(HISTORY_FILE, JSON.stringify({ graded: dateStr, ...prevGrade }) + '\n'); } catch (_) {}
  }
  const rolling = rollingRecord();
  if (rolling) log(rolling);

  const events = await macroToday();
  log('running the analyst...');
  let plan = await runAnalyst(client, data, events, prevGrade, rolling);
  const notes = validatePlan(plan, data);
  if (notes.length) {
    plan = await repairPlan(client, plan, data, notes);
    validatePlan(plan, data);   // second verdict is final — no third chance
  }

  const tradeable = plan.instruments.flatMap(i => (i.entry_zones || []).filter(z => z.tradeable && z.role !== 'fade-at-target'));
  log(`plan: ${plan.instruments.length} instruments, ${tradeable.length} tradeable zone(s)`);
  for (const inst of plan.instruments) {
    const zs = (inst.entry_zones || []).filter(z => z.tradeable);
    log(`  ${inst.symbol.padEnd(7)} ${String(inst.bias).padEnd(8)} ${zs.length} zone(s) — ${inst.expected_path}`);
  }

  if (DRY_RUN) { log('--dry-run: not writing plan file, Notion or email'); log('=== DONE (dry run) ==='); process.exit(0); }

  const record = {
    date: dateStr,
    generated: new Date().toISOString(),
    events_note: events,
    graded_yesterday: prevGrade || null,
    rolling_record: rolling || null,
    market: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, {
      price: v.price, volatility: v.volatility, autoTL_H4: v.autoTL_H4?.dir || null, prevDay: v.prevDay,
    }])),
    ...plan,
  };

  let page = null;
  if (!NO_NOTION) {
    try { page = await writeNotionPage(plan, prevGrade, dateStr); if (page) log(`📄 Notion: ${page.url}`); }
    catch (e) { log(`Notion page failed: ${e.message}`); }
  }
  record.plan_page_id = page?.id || null;

  writeFileSync(PLAN_FILE, JSON.stringify(record, null, 2));
  log(`saved → ${PLAN_FILE}`);
  writeHtml(plan, prevGrade, rolling, data, dateStr);
  log(`html → ${HTML_FILE}`);
  log('=== DONE ===');
  process.exit(0);
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
