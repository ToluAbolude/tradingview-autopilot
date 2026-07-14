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
 * Phase 3: Write data/daily_watchlist.json — consumed by setup_finder + session_runner.
 *
 * The full 7-TF deep scan (market_scanner) runs only on these instruments throughout the day,
 * giving complete coverage of all BlackBull markets in <5 min per cycle.
 */
import { writeFileSync, appendFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import os from 'os';
import {
  setChart, getBars, waitForBars, runAllStrategies, autoTrendlineTrend,
  buildSRZones, calcATR,
} from './setup_finder.mjs';

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
  { sym: 'BLACKBULL:JP225',   label: 'JP225',   category: 'index'     },
  { sym: 'BLACKBULL:HK50',    label: 'HK50',    category: 'index'     },
  { sym: 'BLACKBULL:EUSTX50', label: 'EUSTX50', category: 'index'     },

  // COMMODITIES
  { sym: 'BLACKBULL:XAUUSD',  label: 'XAUUSD',  category: 'commodity' },
  { sym: 'BLACKBULL:XAGUSD',  label: 'XAGUSD',  category: 'commodity' },
  { sym: 'BLACKBULL:WTI',     label: 'WTI',     category: 'commodity' },
  { sym: 'BLACKBULL:BRENT',   label: 'BRENT',   category: 'commodity' },
  { sym: 'BLACKBULL:NGAS',    label: 'NGAS',    category: 'commodity' },
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
  { sym: 'BLACKBULL:LINKUSD', label: 'LINKUSD', category: 'crypto'    },
  { sym: 'BLACKBULL:AVAXUSD', label: 'AVAXUSD', category: 'crypto'    },
];

// ── Diversification limits — prevent all slots going to one category ──────────
const CATEGORY_MAX = { forex: 8, index: 5, commodity: 4, crypto: 5 };

async function main() {
  log('=== DAILY SELECTOR START ===');
  log(`Scanning ${INSTRUMENT_UNIVERSE.length} instruments — trend from AutoTL on 4H×${SCAN_BARS}`);

  const utcHour = new Date().getUTCHours();
  const scored  = [];
  const unavailable = [];
  const errored = [];
  let noTrend = 0;

  for (const inst of INSTRUMENT_UNIVERSE) {
    try {
      // ── Trend: AutoTL on 4H only (operator directive) ──────────────────────
      await setChart(inst.sym, SCAN_TF);
      const bars = await waitForBars(SCAN_BARS, MIN_BARS, 3, 700);
      if (!bars || bars.length < MIN_BARS) {
        unavailable.push(inst.label);
        process.stdout.write(`  ✗ ${inst.label}: no data\n`);
        continue;
      }

      const trend = autoTrendlineTrend(bars);
      if (!trend.dir) {
        noTrend++;
        process.stdout.write(`  ~ ${inst.label}: no day trend — ${trend.detail}\n`);
        continue;   // no validated AutoTL trend = no bias today, by design
      }

      // ── Ranking: confluence score IN the AutoTL direction only ────────────
      const bestDir = trend.dir;
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
        biasDir:    bestDir,
        biasScore:  bestScore,
        rankScore:  bestScore + zoneBonus,
        zoneDistATR: zoneDistATR === null ? null : +zoneDistATR.toFixed(2),
        zoneLevel,
        zoneBonus,
        longScore:  bestDir === 'long'  ? bestScore : null,
        shortScore: bestDir === 'short' ? bestScore : null,
        reasons:    `AutoTL 4H: ${trend.detail}; ${zoneNote}; ` + bestR.reasons.slice(0, 3).join('; '),
        atr:        bestR.atrVal || null,
      });

      const tag = bestScore + zoneBonus >= MIN_SCORE ? '✓' : '~';
      process.stdout.write(`  ${tag} ${inst.label}: ${bestDir.toUpperCase()} ${bestScore}${zoneBonus ? `+${zoneBonus}z` : ''} — AutoTL 4H ${trend.detail}; ${zoneNote}\n`);

    } catch (e) {
      errored.push(inst.label);
      log(`  ✗ ${inst.label}: ${e.message}`);
    }
  }
  log(`AutoTL 4H trend found on ${scored.length} instruments; ${noTrend} with no validated trend; ${unavailable.length} unavailable; ${errored.length} errored.`);

  // A wedged CDP tab (Runtime.enable timeout) errors EVERY instrument. Writing an
  // empty-but-today-dated watchlist then looks "valid" downstream: setup_finder
  // falls back to the full scan list AND requireWithTrendBias fail-opens for the
  // whole day (2026-07-10 incident). If nothing was readable, keep the previous
  // watchlist file and fail the cron loudly instead — downstream consumers now
  // accept that file up to 3 days old (loadDailyWatchlist), so a failed morning
  // run degrades to "yesterday's bias" rather than "scan everything blind".
  if (scored.length + noTrend + unavailable.length === 0) {
    throw new Error(`0/${INSTRUMENT_UNIVERSE.length} instruments readable (${errored.length} errored) — CDP likely wedged; keeping previous watchlist`);
  }

  // Sort by rank score (confluence + zone-proximity bonus) descending
  scored.sort((a, b) => b.rankScore - a.rankScore);

  // Pick top N respecting category diversification limits
  const catCounts  = { forex: 0, index: 0, commodity: 0, crypto: 0 };
  const shortlisted = [];

  for (const inst of scored) {
    if (inst.rankScore < MIN_SCORE) break;
    if (shortlisted.length >= TOP_N) break;
    const cat = inst.category;
    if ((catCounts[cat] || 0) >= (CATEGORY_MAX[cat] || 99)) continue;
    catCounts[cat] = (catCounts[cat] || 0) + 1;
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
    totalScanned:  INSTRUMENT_UNIVERSE.length,
    eligible:      scored.filter(s => s.rankScore >= MIN_SCORE).length,
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
