/**
 * scale_risk_to_goal.mjs — Compute trade-level risk (riskPct tiers) required
 * to hit the absolute goal in goal.json given the bot's actual recent edge.
 *
 * Math:
 *   daysToGoal      = (targetByDate - today) in calendar days
 *   targetMultiple  = targetAbsolute / startingEquity
 *   requiredDaily   = targetMultiple ^ (1/daysToGoal) - 1
 *   tradesPerDay    = trades.csv last-30d count / unique trading days
 *   edgeR           = avgWin·WR - avgLoss·(1-WR)  in R-multiples
 *   requiredRiskPct = (requiredDaily / tradesPerDay) / edgeR × 100
 *
 * Hard bounds: [RISK_FLOOR_PCT, RISK_CAP_PCT_TIER1].
 * Tiers: tier1 = computed, tier2 = tier1·0.7, tier3 = tier1·0.5
 *
 * Negative edge (avgR <= 0): refuses to scale up — halves current risk instead,
 * because piling capital on a losing strategy just blows the account faster.
 *
 * Usage:
 *   node scripts/trading/scale_risk_to_goal.mjs              (dry-run: report only)
 *   node scripts/trading/scale_risk_to_goal.mjs --apply      (snapshot + write)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import os from 'os';

const IS_LINUX  = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX
  ? '/home/ubuntu/trading-data'
  : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';

const GOAL_FILE     = join(DATA_ROOT, 'goal.json');
const PARAMS_FILE   = join(DATA_ROOT, 'trading_params.json');
const TRADES_CSV    = join(DATA_ROOT, 'trade_log', 'trades.csv');
const HISTORY_DIR   = join(DATA_ROOT, 'params_history');
const RISK_LOG      = join(DATA_ROOT, 'risk_scaling.jsonl');

const LOOKBACK_DAYS       = 30;
const RISK_FLOOR_PCT      = 5.0;   // raised 1.0 → 5.0 on 2026-05-28 at user direction (restore April sizing)
const RISK_CAP_PCT_TIER1  = 10.0;
const TIER2_RATIO         = 0.7;
const TIER3_RATIO         = 0.5;
const APPLY = process.argv.includes('--apply');

function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Fallback: parse trades.csv. Known to over-attribute losses via the
// balance-delta bug — use only when cTrader source unavailable.
function parseTradesCsv() {
  if (!existsSync(TRADES_CSV)) return [];
  const cutoff = new Date(); cutoff.setUTCDate(cutoff.getUTCDate() - LOOKBACK_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return readFileSync(TRADES_CSV, 'utf8').trim().split('\n').slice(1)
    .filter(l => l.trim() && l >= cutoffStr)
    .map(l => {
      const p = l.split(',');
      return {
        date: (p[0] || '').slice(0, 10),
        result: (p[10] || '').trim(),
        pnl: parseFloat(p[11]) || 0,
      };
    })
    .filter(t => t.result && t.pnl !== 0);
}

// Authoritative source: cTrader's deal history. Aggregates all closing deals
// per position into one synthetic "trade" row (W/L based on net sign) so the
// edge math stays apples-to-apples with the csv path.
async function parseTradesFromCtrader() {
  const bridge = await import('./broker_ctrader.mjs');
  const fromMs = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  // Symbols we've actually traded — covers all instruments in any current or
  // recent watchlist. Each call is a single API roundtrip; cached after the
  // first hit so cost stays low.
  const symbols = [
    'WTI','XAUUSD','XAGUSD','BTCUSD','ETHUSD','XRPUSD','SOLUSD','ADAUSD','LTCUSD',
    'NAS100','US30','SPX500','GER30','UK100','JPN225','AUS200',
    'EURUSD','GBPUSD','AUDUSD','NZDUSD','USDJPY','EURJPY','GBPJPY','AUDJPY','USDCAD','USDCHF',
    'BRENT','COPPER','BNBUSD','DOTUSD','AVAXUSD','NZDCAD',
  ];
  // Group closing deals by positionId so each trade contributes one row.
  const byPos = new Map(); // positionId -> { date, net }
  for (const sym of symbols) {
    try {
      const r = await bridge.getRecentClosePnl(sym, fromMs);
      for (const d of (r.deals || [])) {
        const pid = d.positionId;
        const cur = byPos.get(pid) || { date: new Date(d.execTs).toISOString().slice(0, 10), net: 0 };
        cur.net += d.net;
        // keep earliest close date for the position
        if (new Date(d.execTs).toISOString().slice(0, 10) < cur.date) cur.date = new Date(d.execTs).toISOString().slice(0, 10);
        byPos.set(pid, cur);
      }
    } catch (_) { /* symbol not in account or no deals; skip */ }
  }
  return [...byPos.values()]
    .filter(t => t.net !== 0)
    .map(t => ({ date: t.date, result: t.net > 0 ? 'W' : 'L', pnl: t.net }));
}

// Picks the source. Default = ctrader; --source=csv falls back to the legacy parser.
async function parseTrades() {
  const srcArg = (process.argv.find(a => a.startsWith('--source=')) || '').split('=')[1];
  const useCsv = srcArg === 'csv';
  if (useCsv) {
    console.log('Source: trades.csv (legacy; balance-delta attribution bug)');
    return parseTradesCsv();
  }
  try {
    console.log('Source: cTrader deal history (authoritative)');
    const t = await parseTradesFromCtrader();
    if (t.length === 0) {
      console.log('cTrader returned 0 trades — falling back to trades.csv');
      return parseTradesCsv();
    }
    return t;
  } catch (e) {
    console.error('cTrader source failed:', e.message, '— falling back to trades.csv');
    return parseTradesCsv();
  }
}

function computeEdge(trades, riskPctTier1, equity) {
  // Convert each trade's $ pnl into R-multiples using current tier-1 risk as the R unit.
  // (Approximation: actual R per trade varied with which tier fired; tier1 is a fair
  // central estimate.)
  const R = (riskPctTier1 / 100) * equity;
  if (R <= 0) return null;
  const Rs    = trades.map(t => t.pnl / R);
  const wins  = Rs.filter(r => r > 0);
  const losses= Rs.filter(r => r < 0);
  const wr    = trades.length ? wins.length / trades.length : 0;
  const avgWin  = wins.length   ? wins.reduce((a, b) => a + b, 0)   / wins.length   : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 0;
  const edgeR   = wr * avgWin - (1 - wr) * avgLoss;
  return { n: trades.length, wr, avgWin, avgLoss, edgeR };
}

function tradesPerDay(trades) {
  if (!trades.length) return 0;
  const days = new Set(trades.map(t => t.date));
  return trades.length / Math.max(1, days.size);
}

function daysUntil(isoDate) {
  const ms = new Date(isoDate + 'T23:59:59Z').getTime() - Date.now();
  return Math.max(1, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

function nextVersionTag() {
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
  const existing = readdirSync(HISTORY_DIR).filter(f => /^v\d{4}\.json$/.test(f));
  const next = existing.length ? Math.max(...existing.map(f => parseInt(f.slice(1, 5), 10))) + 1 : 1;
  return 'v' + String(next).padStart(4, '0');
}

async function main() {
  console.log('=== SCALE RISK TO GOAL ===');
  const goal = loadJson(GOAL_FILE, {});
  const params = loadJson(PARAMS_FILE, {});
  const trades = await parseTrades();

  if (!goal.targetAbsolute || !goal.targetByDate || !goal.startingEquity) {
    console.error('goal.json missing one of: targetAbsolute, targetByDate, startingEquity');
    process.exit(1);
  }

  const days   = daysUntil(goal.targetByDate);
  const mult   = goal.targetAbsolute / goal.startingEquity;
  const daily  = Math.pow(mult, 1 / days) - 1;
  const tpd    = tradesPerDay(trades);
  const currentTier1 = (params.riskPct && params.riskPct[0]) || 5.0;
  const edge   = computeEdge(trades, currentTier1, goal.startingEquity);

  console.log(`Target:           $${goal.targetAbsolute} by ${goal.targetByDate}  (${days} days)`);
  console.log(`Multiple needed:  ${mult.toFixed(2)}×`);
  console.log(`Required daily:   ${(daily * 100).toFixed(2)}%/day`);
  console.log(`Trades/day (30d): ${tpd.toFixed(2)}  (n=${trades.length})`);
  if (edge) {
    console.log(`Edge (last 30d):  WR=${(edge.wr*100).toFixed(1)}%  avgWin=${edge.avgWin.toFixed(2)}R  avgLoss=${edge.avgLoss.toFixed(2)}R  → edgeR=${edge.edgeR.toFixed(3)}R/trade`);
  } else {
    console.log('Edge (last 30d):  insufficient trades');
  }
  console.log(`Current riskPct:  ${JSON.stringify(params.riskPct)}`);

  let tier1, rationale;
  if (!edge || edge.edgeR <= 0) {
    // Losing or no-data: don't scale up. Halve current as a defensive move.
    tier1 = Math.max(RISK_FLOOR_PCT, currentTier1 / 2);
    rationale = edge ? `negative edge (edgeR=${edge.edgeR.toFixed(3)}R) → halving risk` : 'insufficient trade data → halving as a defensive default';
  } else if (tpd <= 0) {
    tier1 = currentTier1;
    rationale = 'no trades per day — leaving risk unchanged';
  } else {
    const required = (daily / tpd) / edge.edgeR * 100; // %
    tier1 = Math.min(RISK_CAP_PCT_TIER1, Math.max(RISK_FLOOR_PCT, required));
    rationale = `required tier1=${required.toFixed(2)}% → clipped to [${RISK_FLOOR_PCT},${RISK_CAP_PCT_TIER1}]`;
  }

  tier1 = Math.round(tier1 * 10) / 10;
  const tier2 = Math.round(tier1 * TIER2_RATIO * 10) / 10;
  const tier3 = Math.round(tier1 * TIER3_RATIO * 10) / 10;
  const proposed = [tier1, tier2, tier3];

  console.log(`\nProposed riskPct: ${JSON.stringify(proposed)}  (${rationale})`);

  if (!APPLY) {
    console.log('\n[dry-run] No files written. Add --apply to write.');
    return;
  }

  // Snapshot + write
  const vTag = nextVersionTag();
  copyFileSync(PARAMS_FILE, join(HISTORY_DIR, `${vTag}.json`));
  const next = { ...params, riskPct: proposed,
    _lastUpdated: new Date().toISOString().slice(0, 10),
    _updatedBy: 'scale_risk_to_goal',
    _version: (parseInt(params._version, 10) || 0) + 1,
  };
  writeFileSync(PARAMS_FILE, JSON.stringify(next, null, 2), 'utf8');
  console.log(`✓ Snapshot: ${vTag}.json`);
  console.log(`✓ trading_params.json riskPct → ${JSON.stringify(proposed)}  v${next._version}`);

  appendFileSync(RISK_LOG, JSON.stringify({
    ts: new Date().toISOString(),
    daysToGoal: days, multiple: mult, requiredDaily: daily, tradesPerDay: tpd,
    edge, from: params.riskPct, to: proposed, rationale,
  }) + '\n');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
