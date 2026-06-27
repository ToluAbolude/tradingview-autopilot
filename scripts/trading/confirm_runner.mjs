/**
 * confirm_runner.mjs — Per-strategy live-confirm executor (DEMO-ONLY).
 *
 * Forward-tests the backtest-validated strategy×instrument combos as INDEPENDENT,
 * per-strategy-tagged trades. There is NO voting / confluence here: each combo
 * fires its own trade whenever its own criteria are met, so we can attribute the
 * live (demo) result back to a single strategy and rank them honestly.
 *
 * Combos — 1h (H1) set (best 1h combos from the strategy-lab 90d matrix):
 *   wor_break_retest    / AUDUSD / H1   (PF2.53 n=25)
 *   jackson_gold        / XAUUSD / H1   (PF2.19 WR75%)
 *   amd_ote             / GBPUSD / H1   (PF1.71 n=43)
 *   confluence_trifecta / EURUSD / H1   (PF1.87 n=37)
 *
 * Each tick (cron, every 5 min): for each combo, pull M15 bars, run the strategy's
 * pure generateSignals(); if a signal printed on the LAST CLOSED bar and we have
 * not acted on that bar yet, place a demo bracket order:
 *   - SL  = strategy's own sl  (defines R = |entry - sl|)
 *   - TP  = 2R                 (clean -1R / +2R outcomes for easy attribution)
 *   - size = small FIXED risk % (CONFIRM_RISK_PCT, default 0.25%)
 *   - the strategy name is recorded against the positionId in confirm_signals.jsonl
 *
 * NOTE vs the backtest: the lab ranked these with a 1R/2R laddered exit + BE/trail.
 * Here we use a single robust 2R bracket (no dynamic management) — simpler and
 * unambiguous for an unattended 2-4 week run, and strictly more conservative than
 * the laddered model. Relative ranking across the 4 still holds. `confirm_report.mjs`
 * reconciles positionId -> strategy -> realised R from the cTrader ledger.
 *
 * SAFETY:
 *   - HARD demo-only: refuses to place unless CTRADER_ENV=demo.
 *   - Daily kill-switch on whole-account realised P&L (confirmMaxDailyLossPct).
 *   - assertOrderSafety (lot caps / anti-stack) before every order.
 *   - One entry per combo per bar (confirm_state.json).
 *   - Never naked: placeOrder sets SL + TP atomically.
 *
 * Modes:
 *   --dry-run (DEFAULT) — logs the trade it WOULD take, places NO orders.
 *   --live              — places real DEMO bracket orders.
 *
 * Requires cTrader env (BROKER_PROVIDER=ctrader + CTRADER_* creds, CTRADER_ENV=demo).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_LINUX  = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX
  ? '/home/ubuntu/trading-data'
  : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';

const PARAMS_FILE = join(DATA_ROOT, 'trading_params.json');
const STATE_FILE  = join(DATA_ROOT, 'confirm_state.json');
const SIGNALS_LOG = join(DATA_ROOT, 'confirm_signals.jsonl');

const LIVE             = process.argv.includes('--live');   // default: dry-run
const CONFIRM_RISK_PCT = Number(process.env.CONFIRM_RISK_PCT || 0.25);
const TARGET_R         = 2;

// ── The combos under test (each is an INDEPENDENT per-strategy trade) ─────────
// 1h (H1) set — switched from 15m for less noise (2026-06). ORB + the smarttrail
// scalper were dropped: both are intraday-only (5m/15m) and can't run at 1h, so
// they were replaced by the strongest 1h strategies from the 90d backtest
// (amd_ote/GBPUSD PF1.71, confluence_trifecta/EURUSD PF1.87). wor + jackson kept.
const COMBOS = [
  { strategy: 'wor_break_retest',    symbol: 'AUDUSD', tf: '60' },   // PF2.53 n=25
  { strategy: 'jackson_gold',        symbol: 'XAUUSD', tf: '60' },   // PF2.19 WR75%
  { strategy: 'amd_ote',             symbol: 'GBPUSD', tf: '60' },   // PF1.71 n=43
  { strategy: 'confluence_trifecta', symbol: 'EURUSD', tf: '60' },   // PF1.87 n=37
];

// Minimal instrument metadata (only confluence/jooviers read ctx.instrument;
// the current 4 read ctx.params only, but keep this correct for completeness).
const INSTRUMENTS = {
  AUDUSD: { symbol: 'AUDUSD', class: 'fx' },
  GBPUSD: { symbol: 'GBPUSD', class: 'fx' },
  EURUSD: { symbol: 'EURUSD', class: 'fx' },
  XAUUSD: { symbol: 'XAUUSD', class: 'metal', aliases: ['XAUUSD', 'GOLD'] },
};
const SESSIONS = { ASIA: '00:00', LONDON: '07:00', NY: '13:30' };
const TF_PERIOD = { '5': 'M5', '15': 'M15', '30': 'M30', '60': 'H1', '240': 'H4' };
const TF_MS     = { '5': 3e5, '15': 9e5, '30': 18e5, '60': 36e5, '240': 144e5 };

function log(msg) { process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`); }
function loadParams() { try { return JSON.parse(readFileSync(PARAMS_FILE, 'utf8')); } catch { return {}; } }
function loadState()  { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) {
  // prune evaluation keys older than 3 days so the file stays small
  const cutoff = Date.now() - 3 * 86400000;
  for (const k of Object.keys(s)) { if ((s[k]?.t || 0) < cutoff) delete s[k]; }
  if (!existsSync(DATA_ROOT)) mkdirSync(DATA_ROOT, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// Lot sizing — identical formula to orb_runner.mjs / inline_trader.mjs.
function calcLots(symbol, riskPct, equity, entry, sl) {
  const MIN_LOT = 0.01, LOT_STEP = 0.01, MAX_LOTS = 10;
  const riskAmt = equity * (riskPct / 100);
  const slDist  = Math.abs(entry - sl);
  if (slDist === 0) return MIN_LOT;
  const sym = symbol.toUpperCase();
  const q = lots => Math.min(Math.max(Math.floor(lots / LOT_STEP) * LOT_STEP, MIN_LOT), MAX_LOTS);
  if (/XAU|GOLD/.test(sym))                                   return q(riskAmt / (100 * slDist));
  if (/NAS100|NAS|NDX|NQ|US30|DOW|YM/.test(sym))              return q(riskAmt / slDist);
  if (/GER40|UK100|DAX|FTSE|SPX500|AUS200|JP225|HK50|EUSTX50/.test(sym)) return q(riskAmt / slDist);
  if (/JPY/.test(sym))                                        return q(riskAmt / (6.50 * (slDist / 0.01)));
  return q(riskAmt / (10.0 * (slDist / 0.0001)));   // standard forex (incl. fx crosses)
}

async function loadStrategies() {
  const out = {};
  for (const name of new Set(COMBOS.map(c => c.strategy))) {
    out[name] = (await import(`./confirm/strategies/${name}.mjs`)).default;
  }
  return out;
}

async function main() {
  const now = new Date();
  const dow = now.getUTCDay();
  if (dow === 0 || dow === 6) { log('Weekend — confirm runner idle.'); return; }

  log(`═══ CONFIRM RUNNER (${LIVE ? 'LIVE/DEMO' : 'DRY-RUN'}) risk=${CONFIRM_RISK_PCT}% ═══`);

  // HARD demo-only gate — this experiment must never touch a live account.
  const env = (process.env.CTRADER_ENV || 'demo').toLowerCase();
  if (LIVE && env !== 'demo') {
    log(`🛑 REFUSING: --live requires CTRADER_ENV=demo (got '${env}'). This runner is demo-only.`);
    process.exit(1);
  }

  const bridge = await import('./broker_ctrader.mjs');
  await bridge.connect();
  const params = loadParams();
  const state  = loadState();
  const nowMs  = now.getTime();

  let equity = 10000;
  try { const eq = await bridge.getEquity(); equity = eq.equity || eq.balance || equity; } catch (_) {}

  // Daily kill-switch on whole-account realised P&L (same source as the live system).
  if (LIVE) {
    const MAX_DAILY_LOSS_PCT = params.confirmMaxDailyLossPct ?? 6;
    try {
      const todayPnl = await bridge.getTodayRealizedPnl();
      const ddPct    = (todayPnl / Math.max(1, equity)) * 100;
      if (ddPct <= -MAX_DAILY_LOSS_PCT) {
        log(`🛑 KILL-SWITCH: today realised ${ddPct.toFixed(1)}% (limit -${MAX_DAILY_LOSS_PCT}%). No more entries today.`);
        log('═══ CONFIRM RUNNER halted (kill-switch) ═══');
        return;
      }
      log(`Kill-switch OK: today realised ${ddPct.toFixed(1)}% (limit -${MAX_DAILY_LOSS_PCT}%).`);
    } catch (e) {
      log(`⚠ kill-switch check FAILED (${e.message}) — proceeding WITHOUT it this tick`);
    }
  }

  const strategies = await loadStrategies();

  for (const combo of COMBOS) {
    const { strategy, symbol, tf } = combo;
    const period = TF_PERIOD[tf], tfMs = TF_MS[tf];
    const strat = strategies[strategy];
    const tag = `${strategy}/${symbol}/${tf}`;

    let bars;
    try {
      bars = await bridge.getTrendbars(symbol, { period, fromMs: nowMs - 20 * 86400000, toMs: nowMs });
    } catch (e) { log(`  ${tag}: bars error — ${e.message}`); continue; }

    // Only consider CLOSED bars (drop the still-forming final bar).
    const closed = (bars || []).filter(b => nowMs >= b.t + tfMs);
    if (closed.length < 60) { log(`  ${tag}: only ${closed.length} closed bars — skip`); continue; }
    const lastClosed = closed[closed.length - 1];
    const key = `${strategy}:${symbol}:${lastClosed.t}`;
    if (state[key]) continue;   // already evaluated this bar

    let signals;
    try { signals = strat.generateSignals(closed, { symbol, tf, params: {}, instrument: INSTRUMENTS[symbol], sessions: SESSIONS }) || []; }
    catch (e) { log(`  ${tag}: generateSignals error — ${e.message}`); continue; }

    state[key] = { t: lastClosed.t, evaluated: true };   // mark bar handled (after success)

    const fresh = signals.filter(s => s.ts === lastClosed.t && s.dir && s.entry && s.sl);
    log(`  ${tag}: ${closed.length} closed bars, ${signals.length} sig(s), ${fresh.length} fresh on last bar`);
    if (!fresh.length) continue;
    const sig = fresh[fresh.length - 1];

    const risk = Math.abs(sig.entry - sig.sl);
    if (risk <= 0) { log(`  ${tag}: zero-risk signal — skip`); continue; }
    const tp   = sig.dir === 'long' ? sig.entry + TARGET_R * risk : sig.entry - TARGET_R * risk;
    const lots = calcLots(symbol, CONFIRM_RISK_PCT, equity, sig.entry, sig.sl);

    const record = {
      ts: now.toISOString(), mode: LIVE ? 'live-demo' : 'dry-run',
      strategy, symbol, tf, dir: sig.dir,
      entry: +sig.entry.toFixed(5), sl: +sig.sl.toFixed(5), tp: +tp.toFixed(5),
      riskR: TARGET_R, lots, riskPct: CONFIRM_RISK_PCT, equity: +equity.toFixed(2),
      reason: sig.reason || null, barT: lastClosed.t,
    };

    if (LIVE) {
      try {
        // entry:null => two-step open-then-amend with ABSOLUTE SL/TP (proven path;
        // the relative-SL/TP one-step path mis-set the distance and didn't persist).
        // placeOrder calls assertOrderSafety internally (incl. anti-stack on same
        // symbol). The brief naked window is backstopped by naked_position_guard.
        const res = await bridge.placeOrder({ symbol, direction: sig.dir, units: lots, entry: null, tpPrice: tp, slPrice: sig.sl });
        record.positionId = Number(res?.position?.positionId || res?.positionId) || null;
        record.placed = !!record.positionId;   // a captured positionId means the order opened
        state[key].positionId = record.positionId;
        // Verify SL+TP attached, RETRYING up to ~8s — the two-step amend can take a
        // few seconds to reflect in getPositions. Only close if genuinely naked after
        // all retries (never-naked rule; confirm_naked_guard cron is the backstop).
        let bracketed = false;
        if (record.positionId) {
          for (let i = 0; i < 4 && !bracketed; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const p = (await bridge.getPositions()).find(x => x.positionId === record.positionId);
            if (p) bracketed = !!(p.stopLoss && p.takeProfit);
            if (p && !bracketed && i === 3) {
              log(`  ⚠ ${tag} pos ${record.positionId} still naked after 8s — closing`);
              try { await bridge.closePosition(record.positionId); record.placed = false; record.naked_closed = true; } catch (_) {}
            }
          }
        }
        record.bracketed = bracketed;
        log(`  ${record.placed ? '✅' : '✗'} ${tag} ${sig.dir} ${lots}lots entry~${record.entry} SL ${record.sl} TP ${record.tp} pos=${record.positionId} bracketed=${bracketed}`);
      } catch (e) {
        record.placed = false; record.error = e.message;
        log(`  ✗ ${tag} place failed: ${e.message}`);
      }
    } else {
      log(`  📝 DRY ${tag} ${sig.dir} ${lots}lots entry~${record.entry} SL ${record.sl} TP ${record.tp} (${CONFIRM_RISK_PCT}% = $${(equity*CONFIRM_RISK_PCT/100).toFixed(2)})`);
    }
    appendFileSync(SIGNALS_LOG, JSON.stringify(record) + '\n');
  }

  saveState(state);
  log('═══ CONFIRM RUNNER done ═══');
  process.exit(0);   // cTrader socket stays open otherwise; exit cleanly for cron
}

if (!existsSync(DATA_ROOT)) mkdirSync(DATA_ROOT, { recursive: true });
main().catch(e => { console.error('confirm_runner failed:', e); process.exit(1); });
