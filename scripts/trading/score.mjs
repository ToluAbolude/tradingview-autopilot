/**
 * score.mjs — Composite score [-1, +1] of recent performance vs goal.json.
 *
 * Components (equal-weighted):
 *   - return    : realisedReturn / targetReturn30d, clipped to [-1, +1]
 *   - drawdown  : 1 - (observedDD / maxDD), clipped to [-1, +1]
 *   - quality   : (PF / minPF + WR / minWR) / 2 - 1, clipped to [-1, +1]
 *
 * Score < failureBelow is the bail-out signal for Hermes.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { analyzePerformance } from './performance_tracker.mjs';

const IS_LINUX  = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX
  ? '/home/ubuntu/trading-data'
  : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';

const GOAL_FILE = join(DATA_ROOT, 'goal.json');

const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function maxDrawdown(trades) {
  let peak = 0, equity = 0, maxDD = 0;
  for (const t of trades) {
    equity += parseFloat(t.pnl || 0);
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }
  return { maxDD, peak };
}

export function loadGoal() {
  if (!existsSync(GOAL_FILE)) {
    return { targetReturn30d: 0.05, maxDrawdown: 0.08, minSharpe: 1.2, minProfitFactor: 1.2, minWinRate: 0.40, failureBelow: -0.04 };
  }
  return JSON.parse(readFileSync(GOAL_FILE, 'utf8'));
}

export function scorePerformance(trades, startingEquity, goal = loadGoal()) {
  if (!trades.length) return { score: 0, components: null, verdict: 'no_data' };

  const perf       = analyzePerformance(trades);
  const totalPnl   = perf.totalPnl ?? trades.reduce((s, t) => s + parseFloat(t.pnl || 0), 0);
  const equity     = Math.max(1, startingEquity || 10000);
  const realisedR  = totalPnl / equity;
  const dd         = maxDrawdown(trades).maxDD / equity;

  const cReturn   = clip(realisedR / goal.targetReturn30d, -1, 1);
  const cDrawdown = clip(1 - (dd / goal.maxDrawdown), -1, 1);
  const pfRatio   = (perf.pf && isFinite(perf.pf)) ? perf.pf / goal.minProfitFactor : 0;
  const wrRatio   = (perf.wr || 0) / 100 / goal.minWinRate;
  const cQuality  = clip(((pfRatio + wrRatio) / 2) - 1, -1, 1);

  const score = (cReturn + cDrawdown + cQuality) / 3;
  const verdict = score < goal.failureBelow ? 'failing'
                : score >= 0.33 ? 'on_track'
                : 'underperforming';

  return {
    score: Math.round(score * 1000) / 1000,
    verdict,
    components: {
      realisedReturn: Math.round(realisedR * 10000) / 10000,
      observedDrawdown: Math.round(dd * 10000) / 10000,
      profitFactor: perf.pf,
      winRate: perf.wr,
      tradeCount: trades.length,
    },
    breakdown: {
      cReturn: Math.round(cReturn * 1000) / 1000,
      cDrawdown: Math.round(cDrawdown * 1000) / 1000,
      cQuality: Math.round(cQuality * 1000) / 1000,
    },
  };
}
