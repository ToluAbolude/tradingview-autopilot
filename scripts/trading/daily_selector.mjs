/**
 * daily_selector.mjs
 * Runs each weekday morning before London open.
 *
 * Phase 1 (trend — operator directive 2026-07-08): AutoTL trendlines are the
 *          PRIMARY AND ONLY trend indicator. Each instrument is read on
 *          4H×180 candles via autoTrendlineTrend (same geometry as the
 *          "Auto Trendlines — Zone & Break" Pine indicator on the chart).
 *          Contraction / no validated 3-touch line = no day trend = skipped.
 *          (1H leg dropped same day: 3-touch+containment on 1H noise starved
 *          the list — live test found 1H lines on 1/6 symbols vs 4/6 on 4H.)
 * Phase 2 (ranking): instruments WITH an AutoTL trend are scored by
 *          runAllStrategies in that direction only (H4×180) — the score ranks
 *          conviction and sets tiers, it can no longer flip the direction.
 *          Plus zone proximity (2026-07-14): distance from price to the nearest
 *          S/R zone on the entry side of the bias, in ATRs — ≤1.0 ATR = +2,
 *          ≤1.75 ATR = +1 on rankScore. "Close to an area of interest" outranks
 *          "trending but mid-air"; biasScore itself stays pure confluence.
 * Phase 3: Write data/daily_watchlist.json — consumed by setup_finder + inline_trader.
 *
 * The full 7-TF deep scan (market_scanner) runs only on these instruments throughout the day,
 * giving complete coverage of all BlackBull markets in <5 min per cycle.
 */
import { writeFileSync, appendFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import os from 'os';
import {
  setChart, getBars, waitForBars, runAllStrategies, autoTrendlineTrend,
  buildSRZones, calcATR, fetchBarsResilient,
} from './setup_finder.mjs';
import { CORE_UNIVERSE } from './lib/instruments.mjs';
import { acquireChartLock, releaseChartLock } from './chart_lock.mjs';

const IS_LINUX   = os.platform() === 'linux';
const DATA_ROOT  = IS_LINUX
  ? '/home/ubuntu/trading-data'
  : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';

const WATCHLIST_FILE = join(DATA_ROOT, 'daily_watchlist.json');
const LOG_FILE       = join(DATA_ROOT, 'daily_selector.log');

const SCAN_TF   = '240'; // H4 — AutoTL trend read AND ranking score (operator: 4H only)
const SCAN_BARS = 180;   // operator rule 2026-07-08: trend analysis on latest 180 candles
const TOP_N    = 15;     // max instruments selected for the day
const MIN_SCORE = 4;     // minimum ranking score to be considered
const MIN_BARS  = 100;   // fewer than this = symbol not available on BlackBull

const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { appendFileSync(LOG_FILE, line); } catch (_) {}
}

// ── Today's plan — the authority on what we intend to trade ──────────────────
// daily_plan.mjs writes at 05:00 UTC, ten minutes before this job. Until now the
// two never spoke: the plan committed to zones on 7-8 instruments while this
// selector independently kept only those passing an AutoTL 3-touch read, so the
// analyst's highest-conviction calls were routinely never scanned. On 2026-08-21
// the plan named continuation shorts on US30/USDJPY as the cleanest setups of the
// day and both were absent from the watchlist — biasScore pays for trend
// ALIGNMENT, which a continuation short into a pullback never earns.
//
// Any instrument the analyst gave a tradeable zone is now admitted on the plan's
// authority, in the plan's direction (bullish → long, bearish → short). AutoTL
// still runs and still ranks; it just no longer holds a veto over the plan.
// Kill switch: PLAN_WATCHLIST=off restores pure AutoTL selection.
function loadPlanBias() {
  const out = new Map();
  if ((process.env.PLAN_WATCHLIST ?? 'on') === 'off') return out;
  try {
    const f = join(DATA_ROOT, 'daily_plan.json');
    if (!existsSync(f)) { log('  [plan] no daily_plan.json — falling back to pure AutoTL selection'); return out; }
    const plan = JSON.parse(readFileSync(f, 'utf8'));
    const today = new Date().toISOString().slice(0, 10);
    if (plan.date !== today) { log(`  [plan] plan is stale (${plan.date} vs ${today}) — no plan authority today`); return out; }
    for (const inst of plan.instruments || []) {
      const dir = inst.bias === 'bullish' ? 'long' : inst.bias === 'bearish' ? 'short' : null;
      if (!dir) continue;                                   // no-view = analyst stood aside
      const zones = (inst.entry_zones || inst.zones || []).filter(z => z.tradeable !== false);
      if (!zones.length) continue;                          // bias but nothing actionable
      out.set(inst.symbol, { dir, zones });
    }
  } catch (e) { log(`  [plan] unreadable (${e.message}) — falling back to pure AutoTL selection`); }
  return out;
}
const PLAN = loadPlanBias();

// ── Full instrument universe — everything BlackBull offers on TradingView ─────
// daily_selector prunes this to the 10-15 highest-conviction instruments each morning.
// Any symbol that returns no bars is automatically removed (not available on BlackBull).
const INSTRUMENT_UNIVERSE = [
  // FOREX MAJORS
  { sym: 'BLACKBULL:EURUSD',  label: 'EURUSD',  category: 'forex'     },
  { sym: 'BLACKBULL:GBPUSD',  label: 'GBPUSD',  category: 'forex'     },
  { sym: 'BLACKBULL:USDJPY',  label: 'USDJPY',  category: 'forex'     },
  { sym: 'BLACKBULL:USDCHF',  label: 'USDCHF',  category: 'forex'     },
  { sym: 'BLACKBULL:USDCAD',  label: 'USDCAD',  category: 'forex'     },
  { sym: 'BLACKBULL:AUDUSD',  label: 'AUDUSD',  category: 'forex'     },
  { sym: 'BLACKBULL:NZDUSD',  label: 'NZDUSD',  category: 'forex'     },

  // FOREX MINORS / CROSSES
  { sym: 'BLACKBULL:EURJPY',  label: 'EURJPY',  category: 'forex'     },
  { sym: 'BLACKBULL:GBPJPY',  label: 'GBPJPY',  category: 'forex'     },
  { sym: 'BLACKBULL:EURGBP',  label: 'EURGBP',  category: 'forex'     },
  { sym: 'BLACKBULL:AUDJPY',  label: 'AUDJPY',  category: 'forex'     },
  { sym: 'BLACKBULL:NZDJPY',  label: 'NZDJPY',  category: 'forex'     },
  { sym: 'BLACKBULL:EURAUD',  label: 'EURAUD',  category: 'forex'     },
  { sym: 'BLACKBULL:GBPAUD',  label: 'GBPAUD',  category: 'forex'     },
  { sym: 'BLACKBULL:EURCAD',  label: 'EURCAD',  category: 'forex'     },
  { sym: 'BLACKBULL:GBPCAD',  label: 'GBPCAD',  category: 'forex'     },
  { sym: 'BLACKBULL:EURCHF',  label: 'EURCHF',  category: 'forex'     },
  { sym: 'BLACKBULL:GBPCHF',  label: 'GBPCHF',  category: 'forex'     },
  { sym: 'BLACKBULL:AUDCAD',  label: 'AUDCAD',  category: 'forex'     },
  { sym: 'BLACKBULL:AUDCHF',  label: 'AUDCHF',  category: 'forex'     },
  { sym: 'BLACKBULL:AUDNZD',  label: 'AUDNZD',  category: 'forex'     },
  { sym: 'BLACKBULL:CADJPY',  label: 'CADJPY',  category: 'forex'     },
  { sym: 'BLACKBULL:CHFJPY',  label: 'CHFJPY',  category: 'forex'     },
  { sym: 'BLACKBULL:NZDCAD',  label: 'NZDCAD',  category: 'forex'     },
  { sym: 'BLACKBULL:NZDCHF',  label: 'NZDCHF',  category: 'forex'     },
  { sym: 'BLACKBULL:EURNZD',  label: 'EURNZD',  category: 'forex'     },
  { sym: 'BLACKBULL:GBPNZD',  label: 'GBPNZD',  category: 'forex'     },

  // INDICES
  { sym: 'BLACKBULL:NAS100',  label: 'NAS100',  category: 'index'     },
  { sym: 'BLACKBULL:US30',    label: 'US30',    category: 'index'     },
  { sym: 'BLACKBULL:SPX500',  label: 'SPX500',  category: 'index'     },
  { sym: 'BLACKBULL:UK100',   label: 'UK100',   category: 'index'     },
  { sym: 'BLACKBULL:GER40',   label: 'GER40',   category: 'index'     },
  { sym: 'BLACKBULL:AUS200',  label: 'AUS200',  category: 'index'     },
  // TV ticker is JPN225 (BLACKBULL:JP225 = "no data"); label stays JP225 —
  // every index-classification regex and profile key downstream matches JP225,
  // and the cTrader bridge aliases both spellings to its JPN225.
  { sym: 'BLACKBULL:JPN225',  label: 'JP225',   category: 'index'     },
  { sym: 'BLACKBULL:HK50',    label: 'HK50',    category: 'index'     },
  // TV ticker is ESTX50 (BLACKBULL:EUSTX50 = "no data"); label stays EUSTX50
  // for the downstream index-classification regexes; bridge aliases to ESTX50.
  { sym: 'BLACKBULL:ESTX50',  label: 'EUSTX50', category: 'index'     },

  // COMMODITIES
  { sym: 'BLACKBULL:XAUUSD',  label: 'XAUUSD',  category: 'commodity' },
  { sym: 'BLACKBULL:XAGUSD',  label: 'XAGUSD',  category: 'commodity' },
  { sym: 'BLACKBULL:WTI',     label: 'WTI',     category: 'commodity' },
  { sym: 'BLACKBULL:BRENT',   label: 'BRENT',   category: 'commodity' },
  // TV ticker is NGAS.F, the futures continuous (BLACKBULL:NGAS = "no data";
  // no BLACKBULL cash gas ticker on TV); cTrader trades it as NATGAS (aliased).
  { sym: 'BLACKBULL:NGAS.F',  label: 'NGAS',    category: 'commodity' },
  { sym: 'BLACKBULL:COPPER',  label: 'COPPER',  category: 'commodity' },
  { sym: 'BLACKBULL:XPTUSD',  label: 'XPTUSD',  category: 'commodity' },

  // CRYPTO
  { sym: 'BLACKBULL:BTCUSD',  label: 'BTCUSD',  category: 'crypto'    },
  { sym: 'BLACKBULL:ETHUSD',  label: 'ETHUSD',  category: 'crypto'    },
  { sym: 'BLACKBULL:LTCUSD',  label: 'LTCUSD',  category: 'crypto'    },
  { sym: 'BLACKBULL:XRPUSD',  label: 'XRPUSD',  category: 'crypto'    },
  { sym: 'BLACKBULL:BNBUSD',  label: 'BNBUSD',  category: 'crypto'    },
  { sym: 'BLACKBULL:SOLUSD',  label: 'SOLUSD',  category: 'crypto'    },
  { sym: 'BLACKBULL:ADAUSD',  label: 'ADAUSD',  category: 'crypto'    },
  { sym: 'BLACKBULL:DOTUSD',  label: 'DOTUSD',  category: 'crypto'    },
  // LINKUSD removed 2026-07-17: BlackBull doesn't offer Chainlink at all —
  // BLACKBULL:LINKUSD is a TV 404 and it's absent from the cTrader account.
  { sym: 'BLACKBULL:AVAXUSD', label: 'AVAXUSD', category: 'crypto'    },
];

// ── CORE UNIVERSE (2026-07-30) ───────────────────────────────────────────────
// The eight instruments daily_plan.mjs writes a pre-market plan for. Everything
// else is switched off, because the ledger — not taste — says so: over 147 trades
// from 15 June the 28 non-USD crosses in the list above lost -$7,790 while metals,
// indices, USD majors and BTC together netted +$1,123. Crosses are wide-spread,
// structurally muddy, and are just two majors wearing a trench coat; the account
// never had an opinion on any of them and paid for it.
//
// Scanning 8 instead of 55 also cuts a selector pass to a fraction of its old
// runtime, which shrinks the 06:10 selector/scanner shared-tab overlap window.
//
// Kill switch: CORE_ONLY=off restores the full universe.
const SCAN_LIST = (process.env.CORE_ONLY ?? 'on') === 'off'
  ? INSTRUMENT_UNIVERSE
  : INSTRUMENT_UNIVERSE.filter(i => CORE_UNIVERSE.includes(i.label));

// ── Diversification limits — prevent all slots going to one category ──────────
const CATEGORY_MAX = { forex: 8, index: 5, commodity: 4, crypto: 5 };

async function main() {
  log('=== DAILY SELECTOR START ===');
  log(`Scanning ${SCAN_LIST.length} instruments (${SCAN_LIST.length === INSTRUMENT_UNIVERSE.length ? 'FULL universe' : `core-only: ${CORE_UNIVERSE.join(', ')}`}) — trend from AutoTL on 4H×${SCAN_BARS}`);

  const utcHour = new Date().getUTCHours();
  const scored  = [];
  const unavailable = [];
  const errored = [];
  let noTrend = 0;

  // Serialise chart access against market_scanner — both drive the same tab, and an
  // overlap misattributes one instrument's prices to another. Unlike the scanner we
  // ABORT on timeout: a cross-contaminated watchlist sets wrong biasScore/zoneLevel for
  // the whole trading day, whereas aborting keeps yesterday's file, which downstream
  // already tolerates for up to 3 days (loadDailyWatchlist).
  if (!await acquireChartLock('daily_selector', 180000, log)) {
    throw new Error('chart lock held by market_scanner for >3min — aborting rather than write a cross-contaminated watchlist; previous watchlist kept');
  }
  try {
  for (const inst of SCAN_LIST) {
    try {
      // ── Trend: AutoTL on 4H only (operator directive) ──────────────────────
      // fetchBarsResilient: chart bars normally, cTrader trendbars when Chrome
      // is down — a wedged CDP morning no longer forfeits the day's watchlist.
      // A total failure (both sources) throws to the outer catch → errored[],
      // which keeps the 2026-07-10 "0 readable → keep previous file" guard
      // meaningful. Symbols simply absent from the broker land there too now
      // (the JSON's `unavailable` count goes cosmetic-only — acceptable).
      const r = await fetchBarsResilient(inst, SCAN_TF, SCAN_BARS, MIN_BARS);
      const bars = r.bars;
      if (r.source === 'broker') process.stdout.write(`  [broker bars] ${inst.label}\n`);

      const trend     = autoTrendlineTrend(bars);
      const planEntry = PLAN.get(inst.label);
      if (!trend.dir && !planEntry) {
        noTrend++;
        process.stdout.write(`  ~ ${inst.label}: no day trend — ${trend.detail}\n`);
        continue;   // no AutoTL trend AND no planned zone = no bias today, by design
      }

      // ── Direction: the plan wins when the analyst committed to one ────────
      // AutoTL still runs and still ranks; a disagreement is surfaced in
      // `reasons` rather than silently dropping the instrument.
      const bestDir  = planEntry ? planEntry.dir : trend.dir;
      const planNote = !planEntry ? ''
        : trend.dir && trend.dir !== planEntry.dir
          ? `PLAN ${bestDir} (⚠ AutoTL says ${trend.dir}); `
          : `PLAN ${bestDir}; `;
      const bestR   = runAllStrategies(bars, bestDir, utcHour, inst.label, SCAN_TF);
      const bestScore = bestR.score;

      // ── Area of interest: distance to the nearest S/R zone on the entry side ──
      // A strong trend far from any level = chasing; price within ~1-1.75 ATR of
      // a zone in the bias direction is where Trend+Level+Signal can actually
      // fire. Long → support below/at price (incl. flipped resistance); short →
      // mirror image. The bonus feeds rankScore only — biasScore keeps its raw
      // confluence meaning for downstream gates (inline_trader minBiasScore).
      const atrArr = calcATR(bars);
      const atrVal = atrArr[bars.length - 1] || 0;
      const price  = bars[bars.length - 1].c;
      let zoneDistATR = null, zoneLevel = null;
      if (atrVal > 0) {
        const geom = buildSRZones(bars, atrArr);
        const wantType = bestDir === 'long' ? 'support' : 'resistance';
        const candidates = [
          ...geom.active.filter(z => z.type === wantType),
          ...geom.flipped.filter(z => z.type !== wantType), // broken + flipped = acts as the other side now
        ];
        for (const z of candidates) {
          const lo = Math.min(z.wickTip, z.bodyLevel), hi = Math.max(z.wickTip, z.bodyLevel);
          let d;
          if (price >= lo && price <= hi) d = 0;
          else if (bestDir === 'long'  && price > hi) d = (price - hi) / atrVal;
          else if (bestDir === 'short' && price < lo) d = (lo - price) / atrVal;
          else continue; // zone on the wrong side of price for this bias
          if (zoneDistATR === null || d < zoneDistATR) { zoneDistATR = d; zoneLevel = bestDir === 'long' ? hi : lo; }
        }
      }
      const zoneBonus = zoneDistATR === null ? 0 : zoneDistATR <= 1.0 ? 2 : zoneDistATR <= 1.75 ? 1 : 0;
      const zoneNote  = zoneDistATR === null
        ? 'no active zone on entry side'
        : `nearest ${bestDir === 'long' ? 'support' : 'resistance'} ${zoneLevel} @ ${zoneDistATR.toFixed(1)} ATR${zoneBonus ? ` (+${zoneBonus})` : ''}`;

      scored.push({
        ...inst,
        planBacked: !!planEntry,
        planZones:  planEntry ? planEntry.zones.length : 0,
        biasDir:    bestDir,
        biasScore:  bestScore,
        rankScore:  bestScore + zoneBonus,
        zoneDistATR: zoneDistATR === null ? null : +zoneDistATR.toFixed(2),
        zoneLevel,
        zoneBonus,
        longScore:  bestDir === 'long'  ? bestScore : null,
        shortScore: bestDir === 'short' ? bestScore : null,
        reasons:    `${planNote}AutoTL 4H: ${trend.detail}; ${zoneNote}; ` + bestR.reasons.slice(0, 3).join('; '),
        atr:        bestR.atrVal || null,
      });

      const tag = (planEntry || bestScore + zoneBonus >= MIN_SCORE) ? '✓' : '~';
      process.stdout.write(`  ${tag} ${inst.label}: ${bestDir.toUpperCase()} ${bestScore}${zoneBonus ? `+${zoneBonus}z` : ''}${planEntry ? ` [plan ×${planEntry.zones.length}]` : ''} — ${planNote}AutoTL 4H ${trend.detail}; ${zoneNote}\n`);

    } catch (e) {
      errored.push(inst.label);
      log(`  ✗ ${inst.label}: ${e.message}`);
    }
  }
  } finally { releaseChartLock(); }
  log(`AutoTL 4H trend found on ${scored.length} instruments; ${noTrend} with no validated trend; ${unavailable.length} unavailable; ${errored.length} errored.`);

  // A wedged CDP tab (Runtime.enable timeout) errors EVERY instrument. Writing an
  // empty-but-today-dated watchlist then looks "valid" downstream: setup_finder
  // falls back to the full scan list AND requireWithTrendBias fail-opens for the
  // whole day (2026-07-10 incident). If nothing was readable, keep the previous
  // watchlist file and fail the cron loudly instead — downstream consumers now
  // accept that file up to 3 days old (loadDailyWatchlist), so a failed morning
  // run degrades to "yesterday's bias" rather than "scan everything blind".
  if (scored.length + noTrend + unavailable.length === 0) {
    throw new Error(`0/${SCAN_LIST.length} instruments readable (${errored.length} errored) — CDP likely wedged; keeping previous watchlist`);
  }

  // Plan-backed instruments first, then by rank score (confluence + zone bonus).
  // Ordering matters: a plan-backed instrument routinely ranks BELOW MIN_SCORE
  // (a continuation short earns no trend-alignment points), so it has to be
  // ahead of the TOP_N cut to survive.
  scored.sort((a, b) => (Number(!!b.planBacked) - Number(!!a.planBacked)) || (b.rankScore - a.rankScore));

  // Pick top N respecting category diversification limits
  const catCounts  = { forex: 0, index: 0, commodity: 0, crypto: 0 };
  const shortlisted = [];

  for (const inst of scored) {
    if (shortlisted.length >= TOP_N) break;
    // Plan-backed entries skip the score cut and the category caps: the analyst
    // already committed to a zone, an invalidation and a >=2R target on them, and
    // inline_trader's plan gate is the thing that decides whether to enter. This
    // loop's job is only to make sure they get SCANNED. `continue` (not `break`)
    // so a low-ranked plan instrument can't truncate the rest of the list.
    if (!inst.planBacked) {
      if (inst.rankScore < MIN_SCORE) continue;
      const cat = inst.category;
      if ((catCounts[cat] || 0) >= (CATEGORY_MAX[cat] || 99)) continue;
      catCounts[cat] = (catCounts[cat] || 0) + 1;
    }
    shortlisted.push(inst);
  }

  log(`\n── Selected ${shortlisted.length} instruments for today ──`);
  shortlisted.forEach((inst, i) => {
    log(`  ${String(i+1).padStart(2)}. [${inst.category.toUpperCase().slice(0,3)}] ${inst.label.padEnd(8)} ${inst.biasDir.toUpperCase().padEnd(5)} score=${inst.biasScore}${inst.zoneBonus ? `+${inst.zoneBonus}z` : ''}  ${inst.reasons}`);
  });

  if (unavailable.length) {
    log(`\n  Not available on BlackBull (${unavailable.length}): ${unavailable.join(', ')}`);
  }

  // Build watchlist in setup_finder-compatible format
  const ALL_TFS = ['1', '5', '15', '30', '60', '240', 'D', 'W'];
  const instruments = shortlisted.map(inst => ({
    sym:       inst.sym,
    label:     inst.label,
    category:  inst.category,
    biasDir:   inst.biasDir,
    biasScore: inst.biasScore,
    rankScore: inst.rankScore,
    planBacked: !!inst.planBacked,
    planZones:  inst.planZones || 0,
    zoneDistATR: inst.zoneDistATR,
    zoneLevel:   inst.zoneLevel,
    reasons:   inst.reasons,
    tfs:       ALL_TFS,
    autoShort: true,
    tier:      inst.rankScore >= 6 ? 1 : inst.rankScore >= 5 ? 2 : 3,
  }));

  const watchlist = {
    date:          new Date().toISOString().slice(0, 10),
    generatedAt:   new Date().toISOString(),
    scanTF:        `AutoTL 4H ×${SCAN_BARS}`,
    totalScanned:  SCAN_LIST.length,
    eligible:      scored.filter(s => s.planBacked || s.rankScore >= MIN_SCORE).length,
    planBacked:    shortlisted.filter(s => s.planBacked).length,
    unavailable:   unavailable.length,
    errors:        errored.length,
    instruments,
  };

  writeFileSync(WATCHLIST_FILE, JSON.stringify(watchlist, null, 2), 'utf8');

  log(`\n✓ Watchlist saved → ${WATCHLIST_FILE}`);
  log(`  Instruments: ${instruments.map(i => `${i.label}(${i.biasDir[0].toUpperCase()}${i.biasScore})`).join(' ')}`);
  log('=== DAILY SELECTOR DONE ===\n');
}

main()
  .then(() => process.exit(0))   // setup_finder's CDP/cTrader socket keeps the event loop alive; exit explicitly so the cron doesn't leak a zombie node each run
  .catch(e => {
    log(`Fatal: ${e.message}\n${e.stack}`);
    process.exit(1);
  });
