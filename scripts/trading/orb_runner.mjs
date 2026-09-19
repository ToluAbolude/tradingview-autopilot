/**
 * orb_runner.mjs — Dedicated, time-gated Opening Range Breakout strategy.
 *
 * Separate from the all-day confluence scanner: this fires ONLY in the first
 * hours after a session open, ONLY on the instruments the 90-day backtest
 * ([orb_backtest.mjs] / [[project_orb_backtest_findings]]) proved have a real
 * ORB edge, with a 2R target and SL at the opposite OR boundary.
 *
 * Roster (2026-07-02 rebuild): ONLY the configs that survived orb_oos.mjs — i.e.
 * positive in BOTH time-halves AND robust to removing their top-3 trades:
 *   ASIA   00:00 UTC → XAUUSD@2R (PF1.59), US30@2R (PF1.29), NAS100@1R (WR56%)
 *   LONDON 07:00 UTC → SPX500@2R (PF1.35 with trend)
 * The active pairings are defined below. Risk = params.orbRiskPct (default 0.5%).
 * DRY-RUN logs support forward testing before enabling cTrader execution.
 *
 * Cadence: run every 5 min via cron. Each tick, for any pairing whose breakout
 * window is currently open, it builds the opening range from cTrader M5 bars,
 * detects the first close beyond it, and (once per instrument/session/day) takes
 * the trade. State in orb_state.json prevents duplicate entries.
 *
 * Modes:
 *   --dry-run (DEFAULT) — logs the trade it WOULD take to orb_signals.jsonl,
 *                         places NO orders. Run this for ~a week to confirm the
 *                         live edge before risking money.
 *   --live              — places real cTrader bracket orders (market entry + SL + TP).
 *
 * Requires cTrader env (BROKER_PROVIDER=ctrader + CTRADER_* creds).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { calcLots } from './lib/sizing.mjs';
import { requireEquity, dailyLossPercent } from './lib/account_risk.mjs';
import { isCalendarWeekend } from './lib/clock.mjs';

const IS_LINUX  = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX
  ? '/home/ubuntu/trading-data'
  : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';

const PARAMS_FILE = join(DATA_ROOT, 'trading_params.json');
const STATE_FILE  = join(DATA_ROOT, 'orb_state.json');
const SIGNALS_LOG = join(DATA_ROOT, 'orb_signals.jsonl');

const LIVE = process.argv.includes('--live');   // default: dry-run

// ── Strategy config (from the 90d backtest) ──────────────────────────────────
const OR_DURATION_MIN  = 30;
const BREAKOUT_WINDOW_H = 2;     // confined: only enter within 2h of the OR close (2026-08-17, was 4)
const MAX_ENTRY_AGE_MIN = 15;    // don't chase a breakout older than this (price moved)
const MIN_OR_BARS       = 4;     // need >=4 of the 6 M5 bars in the 30-min OR

// Each config carries its own R target.
// 2026-08-17: London + NY opens ONLY (operator directive). The ORB literature's
// edge is specifically the cash-open session (Zarattini et al., SSRN 4416622 /
// 4729284: 5-min ORB at the 09:30 ET open, indices) — so NY 13:30 UTC carries
// the index pairings; SPX500@London keeps its own 90d-backtest slot (PF 1.35).
// The ASIA pairing is retired, not deleted — git history + this comment keep it:
//   { session: 'ASIA', openUTC: '00:00', configs: [XAUUSD@2R, US30@2R, NAS100@1R] }
const PAIRINGS = [
  { session: 'LONDON',  openUTC: '07:00', configs: [{ sym: 'SPX500', R: 2 }] },
  { session: 'NEWYORK', openUTC: '13:30', configs: [{ sym: 'NAS100', R: 2 }, { sym: 'US30', R: 2 }] },
];

function log(msg) { process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`); }

function loadParams() {
  try { return JSON.parse(readFileSync(PARAMS_FILE, 'utf8')); }
  catch { return { riskPct: [2.5, 1.8, 1.3] }; }
}
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

// ── Session window math (for today, UTC) ─────────────────────────────────────
function sessionWindow(openUTC, now) {
  const [oh, om] = openUTC.split(':').map(Number);
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), oh, om);
  const orEnd = start + OR_DURATION_MIN * 60 * 1000;
  const brkEnd = orEnd + BREAKOUT_WINDOW_H * 3600 * 1000;
  return { start, orEnd, brkEnd };
}

// ── Detect the first close beyond the opening range ──────────────────────────
// `bars` must include pre-session history (the runner fetches from start-4d) so
// the EMA200 with-trend filter is meaningful.
function detectBreakout(bars, start, orEnd, nowMs, withTrend = true) {
  const orBars = bars.filter(b => b.t >= start && b.t < orEnd);
  if (orBars.length < MIN_OR_BARS) return { status: 'or_incomplete', orBars: orBars.length };
  const orHigh = Math.max(...orBars.map(b => b.h));
  const orLow  = Math.min(...orBars.map(b => b.l));
  if (!(orHigh > orLow)) return { status: 'or_flat' };

  // EMA200 over the full series for the with-trend filter — A/B-validated to lift
  // expectancy (US30 London @2R +0.18R→+0.28R, PF 1.30→1.49). The entry must sit
  // on the trade-direction side of the EMA.
  const sorted = bars.slice().sort((a, b) => a.t - b.t);
  const PERIOD = 200, k = 2 / (PERIOD + 1);
  let ema = null; const emaAt = new Map();
  for (const b of sorted) { ema = ema == null ? b.c : b.c * k + ema * (1 - k); emaAt.set(b.t, ema); }

  for (const b of sorted) {
    if (b.t < orEnd) continue;
    let dir = null, sl = null;
    if (b.c > orHigh) { dir = 'long';  sl = orLow;  }
    else if (b.c < orLow) { dir = 'short'; sl = orHigh; }
    else continue;
    const emaV = emaAt.get(b.t);
    const trendOK = !withTrend || emaV == null || (dir === 'long' ? b.c > emaV : b.c < emaV);
    const base = { dir, entry: b.c, sl, orHigh, orLow, barT: b.t, ema: emaV == null ? null : +emaV.toFixed(5) };
    // ORB takes only the FIRST break of the day. If it's counter-trend, skip the
    // whole day (matches the backtest's with-trend `byRT` semantics).
    return { status: trendOK ? 'breakout' : 'counter_trend', ...base };
  }
  return { status: 'no_breakout', orHigh, orLow };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const now = new Date();
  if (isCalendarWeekend(now)) { log('Weekend — ORB idle.'); return; }

  log(`═══ ORB RUNNER (${LIVE ? 'LIVE' : 'DRY-RUN'}) ═══`);

  const bridge = await import('./broker_ctrader.mjs');
  await bridge.connect();
  const params = loadParams();
  const riskPct = params.orbRiskPct ?? 0.5;   // ORB has its OWN (small) risk, decoupled from the scanner's riskPct
  const state = loadState();
  const today = now.toISOString().slice(0, 10);
  const nowMs = now.getTime();

  const equity = requireEquity(await bridge.getEquity());

  // ── Per-day loss kill-switch ────────────────────────────────────────────────
  // The ORB roster can fire ~9 configs/day at riskPct each with no built-in cap.
  // Halt ALL new ORB entries for the day once today's REALISED account P&L
  // (cTrader ledger — same source as inline_trader's drawdown halt) is down more
  // than orbMaxDailyLossPct. Protects against a bad day without touching the
  // per-trade risk %. Realised-only (open trades realise when their SL/TP hits);
  // gates on whole-account daily P&L so it also catches combined ORB+scanner
  // damage. Dry-run never trades, so the switch only matters when LIVE.
  if (LIVE) {
    const MAX_DAILY_LOSS_PCT = params.orbMaxDailyLossPct ?? 10;
    try {
      const todayPnl = await bridge.getTodayRealizedPnl();
      const ddPct    = dailyLossPercent(todayPnl, equity, MAX_DAILY_LOSS_PCT);
      if (ddPct <= -MAX_DAILY_LOSS_PCT) {
        log(`🛑 ORB KILL-SWITCH: today realised P&L $${todayPnl.toFixed(0)} = ${ddPct.toFixed(1)}% (limit -${MAX_DAILY_LOSS_PCT}%). No more ORB entries today.`);
        saveState(state);
        log('═══ ORB RUNNER halted (kill-switch) ═══');
        process.exit(0);
      }
      log(`Kill-switch OK: today realised ${ddPct.toFixed(1)}% (limit -${MAX_DAILY_LOSS_PCT}%).`);
    } catch (e) {
      throw new Error(`Daily risk check unavailable; no ORB entries: ${e.message}`);
    }
  }

  for (const pairing of PAIRINGS) {
    const { start, orEnd, brkEnd } = sessionWindow(pairing.openUTC, now);
    // Only act once the OR has closed and we're still inside the breakout window.
    if (nowMs < orEnd || nowMs > brkEnd) continue;

    for (const cfg of pairing.configs) {
      const symbol = cfg.sym;
      const TARGET_R = cfg.R;
      const key = `${today}:${pairing.session}:${symbol}`;
      if (state[key]?.entered) continue;   // one shot per instrument/session/day

      let bars;
      try {
        // Fetch ~4 days of history so EMA200 (with-trend filter) is meaningful;
        // OR/breakout detection still only uses bars at/after the session open.
        bars = await bridge.getTrendbars(symbol, { period: 'M5', fromMs: start - 4 * 86400000, toMs: nowMs });
      } catch (e) { log(`  ${symbol} ${pairing.session}: bars error — ${e.message}`); continue; }

      const withTrend = params.orbWithTrend !== false;   // default ON (A/B-validated)
      const r = detectBreakout(bars, start, orEnd, nowMs, withTrend);
      if (r.status === 'counter_trend') {
        log(`  ${symbol} ${pairing.session}: first breakout ${r.dir} is counter-trend (EMA200 ${r.ema}) — skip day, mark done`);
        state[key] = { entered: true, skipped: 'counter_trend', dir: r.dir, ema: r.ema, ts: now.toISOString() };
        continue;
      }
      if (r.status !== 'breakout') continue;

      // Don't chase a stale breakout — keep entries near the actual break.
      const ageMin = (nowMs - r.barT) / 60000;
      if (ageMin > MAX_ENTRY_AGE_MIN) {
        log(`  ${symbol} ${pairing.session}: breakout ${ageMin.toFixed(0)}m old (>${MAX_ENTRY_AGE_MIN}m) — skip, mark done`);
        state[key] = { entered: true, skipped: 'stale', ts: now.toISOString() };
        continue;
      }

      const risk = Math.abs(r.entry - r.sl);
      const tp   = r.dir === 'long' ? r.entry + TARGET_R * risk : r.entry - TARGET_R * risk;
      const lots = calcLots(symbol, riskPct, equity, r.entry, r.sl);

      const signal = {
        ts: now.toISOString(), mode: LIVE ? 'live' : 'dry-run',
        session: pairing.session, symbol, dir: r.dir,
        entry: +r.entry.toFixed(5), sl: +r.sl.toFixed(5), tp: +tp.toFixed(5),
        orHigh: +r.orHigh.toFixed(5), orLow: +r.orLow.toFixed(5),
        riskR: TARGET_R, lots, riskPct, equity: +equity.toFixed(2),
      };

      if (LIVE) {
        try {
          const res = await bridge.placeOrder({ symbol, direction: r.dir, units: lots, entry: r.entry, tpPrice: tp, slPrice: r.sl, label: 'orb_sessions' });
          signal.placed = true; signal.positionId = res?.positionId ?? null;
          log(`  ✅ LIVE ${pairing.session} ${symbol} ${r.dir} ${lots}lots entry~${signal.entry} SL ${signal.sl} TP ${signal.tp}`);
        } catch (e) {
          signal.placed = false; signal.error = e.message;
          log(`  ✗ LIVE place failed ${symbol}: ${e.message}`);
        }
      } else {
        log(`  📝 DRY-RUN ${pairing.session} ${symbol} ${r.dir} ${lots}lots entry~${signal.entry} SL ${signal.sl} TP ${signal.tp} (risk ${riskPct}% = $${(equity*riskPct/100).toFixed(0)})`);
      }

      appendFileSync(SIGNALS_LOG, JSON.stringify(signal) + '\n');
      state[key] = { entered: true, ...signal };
    }
  }

  saveState(state);
  log('═══ ORB RUNNER done ═══');
  process.exit(0);
}

if (!existsSync(DATA_ROOT)) mkdirSync(DATA_ROOT, { recursive: true });
main().catch(e => { log(`FATAL: ${e.stack}`); process.exit(1); });
