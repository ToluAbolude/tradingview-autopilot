/**
 * daily_selector.mjs
 * Runs at 06:30 UTC Mon-Fri — before London open (07:00 UTC = 08:00 BST).
 *
 * Phase 1: Scan ALL ~50 BlackBull instruments on H4 for directional bias.
 *          Uses the same scoring engine as setup_finder (SmartTrail, EMA, FVG, S/R).
 *          Marks instruments with no data as unavailable on BlackBull → removed.
 * Phase 2: Pick top 10-15 by score (min score 4, both directions evaluated).
 * Phase 3: Write data/daily_watchlist.json — consumed by setup_finder + session_runner.
 *
 * The full 7-TF deep scan (market_scanner) runs only on these instruments throughout the day,
 * giving complete coverage of all BlackBull markets in <5 min per cycle.
 */
import { writeFileSync, appendFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import os from 'os';
import {
  setChart, getBars, waitForBars, runAllStrategies,
} from './setup_finder.mjs';

const IS_LINUX   = os.platform() === 'linux';
const DATA_ROOT  = IS_LINUX
  ? '/home/ubuntu/trading-data'
  : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';

const WATCHLIST_FILE = join(DATA_ROOT, 'daily_watchlist.json');
const LOG_FILE       = join(DATA_ROOT, 'daily_selector.log');

const SCAN_TF  = '240';  // H4 — strong trend signal, fast to load, updated every 4h
const TOP_N    = 15;     // max instruments selected for the day
const MIN_SCORE = 4;     // minimum H4 bias score to be considered (out of 8)
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
  log(`Scanning ${INSTRUMENT_UNIVERSE.length} instruments on H4 to select today's watchlist`);

  const utcHour = new Date().getUTCHours();
  const scored  = [];
  const unavailable = [];

  for (const inst of INSTRUMENT_UNIVERSE) {
    try {
      await setChart(inst.sym, SCAN_TF);
      const bars = await waitForBars(300, MIN_BARS, 3, 700);

      if (!bars || bars.length < MIN_BARS) {
        unavailable.push(inst.label);
        process.stdout.write(`  ✗ ${inst.label}: no data\n`);
        continue;
      }

      const longR  = runAllStrategies(bars, 'long',  utcHour, inst.label, SCAN_TF);
      const shortR = runAllStrategies(bars, 'short', utcHour, inst.label, SCAN_TF);

      const bestDir   = longR.score >= shortR.score ? 'long' : 'short';
      const bestScore = Math.max(longR.score, shortR.score);
      const bestR     = bestDir === 'long' ? longR : shortR;

      scored.push({
        ...inst,
        biasDir:    bestDir,
        biasScore:  bestScore,
        longScore:  longR.score,
        shortScore: shortR.score,
        reasons:    bestR.reasons.slice(0, 4).join('; '),
        atr:        bestR.atrVal || null,
      });

      const tag = bestScore >= MIN_SCORE ? '✓' : '~';
      process.stdout.write(`  ${tag} ${inst.label}: ${bestDir.toUpperCase()} ${bestScore} — ${bestR.reasons.slice(0,3).join(', ')}\n`);

    } catch (e) {
      log(`  ✗ ${inst.label}: ${e.message}`);
    }
  }

  // Sort by score descending
  scored.sort((a, b) => b.biasScore - a.biasScore);

  // Pick top N respecting category diversification limits
  const catCounts  = { forex: 0, index: 0, commodity: 0, crypto: 0 };
  const shortlisted = [];

  for (const inst of scored) {
    if (inst.biasScore < MIN_SCORE) break;
    if (shortlisted.length >= TOP_N) break;
    const cat = inst.category;
    if ((catCounts[cat] || 0) >= (CATEGORY_MAX[cat] || 99)) continue;
    catCounts[cat] = (catCounts[cat] || 0) + 1;
    shortlisted.push(inst);
  }

  log(`\n── Selected ${shortlisted.length} instruments for today ──`);
  shortlisted.forEach((inst, i) => {
    log(`  ${String(i+1).padStart(2)}. [${inst.category.toUpperCase().slice(0,3)}] ${inst.label.padEnd(8)} ${inst.biasDir.toUpperCase().padEnd(5)} score=${inst.biasScore}  ${inst.reasons}`);
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
    reasons:   inst.reasons,
    tfs:       ALL_TFS,
    autoShort: true,
    tier:      inst.biasScore >= 6 ? 1 : inst.biasScore >= 5 ? 2 : 3,
  }));

  const watchlist = {
    date:          new Date().toISOString().slice(0, 10),
    generatedAt:   new Date().toISOString(),
    scanTF:        'H4',
    totalScanned:  INSTRUMENT_UNIVERSE.length,
    eligible:      scored.filter(s => s.biasScore >= MIN_SCORE).length,
    unavailable:   unavailable.length,
    instruments,
  };

  writeFileSync(WATCHLIST_FILE, JSON.stringify(watchlist, null, 2), 'utf8');

  log(`\n✓ Watchlist saved → ${WATCHLIST_FILE}`);
  log(`  Instruments: ${instruments.map(i => `${i.label}(${i.biasDir[0].toUpperCase()}${i.biasScore})`).join(' ')}`);
  log('=== DAILY SELECTOR DONE ===\n');
}

main().catch(e => {
  log(`Fatal: ${e.message}\n${e.stack}`);
  process.exit(1);
});
