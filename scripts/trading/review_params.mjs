/**
 * review_params.mjs — Daily performance review + parameter recommendation engine.
 *
 * Runs automatically at 20:30 UTC Mon-Fri via cron after EOD close.
 * Reads last 30 days of trades.csv, generates specific change recommendations,
 * and writes them to data/pending_params.json for user approval.
 *
 * To review recommendations: cat data/pending_params.json
 * To apply approved changes:  node scripts/trading/apply_params.mjs --apply
 * To preview without applying: node scripts/trading/apply_params.mjs --preview
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { analyzePerformance } from './performance_tracker.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const IS_LINUX   = os.platform() === 'linux';
const DATA_ROOT  = IS_LINUX
  ? '/home/ubuntu/trading-data'
  : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';

const TRADES_CSV   = join(DATA_ROOT, 'trade_log', 'trades.csv');
const PARAMS_FILE  = join(DATA_ROOT, 'trading_params.json');
const PENDING_FILE = join(DATA_ROOT, 'pending_params.json');
const REVIEWS_DIR  = join(DATA_ROOT, 'reviews');
const REVIEW_LOG   = join(DATA_ROOT, 'review_params.log');

const LOOKBACK_DAYS = 30;
const MIN_TRADES_OVERALL = 20;
const MIN_TRADES_SYMBOL  = 5;
const MIN_TRADES_SESSION = 10;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { appendFileSync(REVIEW_LOG, line); } catch(_) {}
}

function loadParams() {
  if (!existsSync(PARAMS_FILE)) {
    return {
      scoreThreshold: 8, stopRuleLosses: 2, riskPct: [3.5, 2.5, 1.75],
      slAtrMult: 1.5, tp1Mult: 1.0, tp2Mult: 2.0, maxConcurrent: 4,
      blockedSessions: [], blockedSymbols: [], blockedSymbolExpiry: {},
    };
  }
  return JSON.parse(readFileSync(PARAMS_FILE, 'utf8'));
}

function parseCsv() {
  if (!existsSync(TRADES_CSV)) return [];
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - LOOKBACK_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  return readFileSync(TRADES_CSV, 'utf8').trim().split('\n').slice(1)
    .filter(l => l.trim() && l >= cutoffStr)
    .map(l => {
      const p = l.split(',');
      return {
        date:    (p[0]  || '').trim(),
        session: (p[1]  || '').trim(),
        symbol:  (p[2]  || '').trim(),
        tf:      (p[3]  || '').trim(),
        dir:     (p[4]  || '').trim(),
        score:   parseFloat(p[5] || 0) || 0,
        entry:   parseFloat(p[6] || 0) || 0,
        sl:      parseFloat(p[7] || 0) || 0,
        tp:      (p[8]  || '').trim(),
        rr:      parseFloat(p[9] || 0) || 0,
        result:  (p[10] || '').trim(),
        pnl:     parseFloat(p[11] || 0) || 0,
      };
    })
    .filter(t => t.symbol && t.symbol !== 'NONE' && t.result && t.pnl !== 0);
}

function computeBreakdown(trades, key) {
  const map = {};
  for (const t of trades) {
    const k = t[key] || 'UNKNOWN';
    if (!map[k]) map[k] = { wins: 0, losses: 0, pnl: 0 };
    if (t.pnl > 0) map[k].wins++;
    else map[k].losses++;
    map[k].pnl += t.pnl;
  }
  for (const k of Object.keys(map)) {
    const d = map[k];
    d.total = d.wins + d.losses;
    d.wr = d.total > 0 ? Math.round((d.wins / d.total) * 1000) / 10 : 0;
    d.pnl = Math.round(d.pnl * 100) / 100;
  }
  return map;
}

function generateRecommendations(trades, params) {
  const recs = [];
  const today = new Date().toISOString().slice(0, 10);

  // ── 1. Overall WR → score threshold ──────────────────────────────────────────
  const overall = analyzePerformance(trades);
  if (overall.total >= MIN_TRADES_OVERALL) {
    if (overall.wr < 40) {
      const proposed = Math.min(11, (params.scoreThreshold || 8) + 1);
      if (proposed !== params.scoreThreshold) {
        recs.push({
          param: 'scoreThreshold',
          current: params.scoreThreshold,
          proposed,
          reason: `WR ${overall.wr}% < 40% over last ${overall.total} trades — tighten entry quality`,
          condition: `WR=${overall.wr}% over ${overall.total} trades`,
        });
      }
    } else if (overall.wr > 70) {
      const proposed = Math.max(7, (params.scoreThreshold || 8) - 1);
      if (proposed !== params.scoreThreshold) {
        recs.push({
          param: 'scoreThreshold',
          current: params.scoreThreshold,
          proposed,
          reason: `WR ${overall.wr}% > 70% over last ${overall.total} trades — can loosen entry slightly`,
          condition: `WR=${overall.wr}% over ${overall.total} trades`,
        });
      }
    }

    // ── 2. PF < 1.2 → widen SL (increase slAtrMult) ─────────────────────────
    if (overall.pf < 1.2 && overall.pf > 0) {
      const proposed = Math.round(Math.min(2.5, (params.slAtrMult || 1.5) + 0.1) * 10) / 10;
      if (proposed !== params.slAtrMult) {
        recs.push({
          param: 'slAtrMult',
          current: params.slAtrMult,
          proposed,
          reason: `Profit factor ${overall.pf} < 1.2 — stops being hit too early, widen SL fallback`,
          condition: `PF=${overall.pf} over ${overall.total} trades`,
        });
      }
    }
  }

  // ── 3. Per-symbol: block symbols with poor WR ─────────────────────────────
  const bySymbol = computeBreakdown(trades, 'symbol');
  const currentBlocked = params.blockedSymbols || [];
  const currentExpiry  = params.blockedSymbolExpiry || {};
  const newBlocked     = [...currentBlocked];
  const newExpiry      = { ...currentExpiry };

  for (const [sym, d] of Object.entries(bySymbol)) {
    if (d.total >= MIN_TRADES_SYMBOL && d.wr < 30 && !newBlocked.includes(sym)) {
      const expiry = new Date();
      expiry.setUTCDate(expiry.getUTCDate() + 30);
      const expiryStr = expiry.toISOString().slice(0, 10);
      newBlocked.push(sym);
      newExpiry[sym] = expiryStr;
      recs.push({
        param: 'blockedSymbols',
        current: currentBlocked,
        proposed: newBlocked,
        reason: `${sym} WR ${d.wr}% < 30% over ${d.total} trades — cooling off for 30 days (until ${expiryStr})`,
        condition: `${sym} WR=${d.wr}% over ${d.total} trades`,
      });
      recs.push({
        param: 'blockedSymbolExpiry',
        current: currentExpiry,
        proposed: newExpiry,
        reason: `Expiry entry for ${sym} block`,
        condition: 'companion to blockedSymbols change',
      });
    }
  }

  // ── 4. Unblock symbols whose cooling-off period has expired ──────────────
  const unblocked = [];
  for (const sym of currentBlocked) {
    const expiry = currentExpiry[sym];
    if (expiry && expiry <= today) {
      unblocked.push(sym);
    }
  }
  if (unblocked.length > 0) {
    const newUnblockedList = newBlocked.filter(s => !unblocked.includes(s));
    const newUnblockedExpiry = { ...newExpiry };
    for (const s of unblocked) delete newUnblockedExpiry[s];
    recs.push({
      param: 'blockedSymbols',
      current: newBlocked,
      proposed: newUnblockedList,
      reason: `30-day cooling period expired for: ${unblocked.join(', ')} — unblocking`,
      condition: `expiry date ${unblocked.map(s => currentExpiry[s]).join(', ')} ≤ today (${today})`,
    });
    recs.push({
      param: 'blockedSymbolExpiry',
      current: newExpiry,
      proposed: newUnblockedExpiry,
      reason: `Remove expiry entries for unblocked symbols`,
      condition: 'companion to blockedSymbols unblock',
    });
  }

  // ── 5. Per-session: block sessions with consistent losses ─────────────────
  const bySession = computeBreakdown(trades, 'session');
  const currentBlockedSessions = params.blockedSessions || [];

  for (const [sess, d] of Object.entries(bySession)) {
    if (d.total >= MIN_TRADES_SESSION && d.wr < 35 && d.pnl < 0
        && !currentBlockedSessions.includes(sess)) {
      const newBlockedSessions = [...currentBlockedSessions, sess];
      recs.push({
        param: 'blockedSessions',
        current: currentBlockedSessions,
        proposed: newBlockedSessions,
        reason: `${sess} session: WR ${d.wr}% < 35% AND net PnL £${d.pnl} over ${d.total} trades`,
        condition: `${sess} WR=${d.wr}% PnL=${d.pnl} over ${d.total} trades`,
      });
    }
  }

  return recs;
}

function main() {
  log('=== DAILY PARAMETER REVIEW ===');

  const trades = parseCsv();
  log(`Loaded ${trades.length} completed trades from last ${LOOKBACK_DAYS} days (since ${new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10)})`);

  const params = loadParams();
  log(`Current params: scoreThreshold=${params.scoreThreshold} slAtrMult=${params.slAtrMult} riskPct=${params.riskPct} blocked=${JSON.stringify(params.blockedSymbols)}`);

  const recs = generateRecommendations(trades, params);

  const overall = trades.length >= 1 ? analyzePerformance(trades) : { total: 0, wr: 0, pf: 0 };
  const bySymbol = computeBreakdown(trades, 'symbol');
  const bySession = computeBreakdown(trades, 'session');

  const report = {
    generatedAt:    new Date().toISOString(),
    analysisWindow: `last ${LOOKBACK_DAYS} days`,
    tradeCount:     trades.length,
    overall:        overall.total ? { wr: overall.wr, pf: overall.pf, totalPnl: overall.totalPnl } : 'insufficient data',
    bySymbol,
    bySession,
    recommendations: recs,
    noChanges: recs.length === 0,
    applyCommand: 'node scripts/trading/apply_params.mjs --apply',
    previewCommand: 'node scripts/trading/apply_params.mjs --preview',
  };

  if (!existsSync(REVIEWS_DIR)) mkdirSync(REVIEWS_DIR, { recursive: true });
  writeFileSync(PENDING_FILE, JSON.stringify(report, null, 2), 'utf8');

  if (recs.length === 0) {
    log('✓ No parameter changes recommended. Performance within acceptable range.');
  } else {
    log(`⚠ ${recs.length} recommendation(s) generated:`);
    for (const r of recs) {
      log(`  → ${r.param}: ${JSON.stringify(r.current)} → ${JSON.stringify(r.proposed)}`);
      log(`    Reason: ${r.reason}`);
    }
    log(`\nReview at: ${PENDING_FILE}`);
    log(`To apply:  node scripts/trading/apply_params.mjs --apply`);
    log(`To preview: node scripts/trading/apply_params.mjs --preview`);
  }

  log('=== REVIEW COMPLETE ===');
}

main();
