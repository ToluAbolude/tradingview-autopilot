/**
 * orb_runner.mjs — Dedicated, time-gated Opening Range Breakout strategy.
 *
 * Separate from the all-day confluence scanner: this fires ONLY in the first
 * hours after a session open, ONLY on the instruments the 90-day backtest
 * ([orb_backtest.mjs] / [[project_orb_backtest_findings]]) proved have a real
 * ORB edge, with a 2R target and SL at the opposite OR boundary.
 *
 * Pairings (data-driven; instrument×session matters more than instrument):
 *   ASIA   00:00 UTC → XAUUSD            (expR +0.36, PF 1.69)
 *   LONDON 07:00 UTC → WTI SPX500 US30 AUDUSD NZDUSD AUDJPY GBPJPY (+0.14..+0.29)
 *   NY     13:30 UTC → AUDJPY            (expR +0.24, PF 1.64)
 *
 * NOTE on WTI: it is blocked from the all-day scanner (churn that lost money),
 * but ORB-at-the-open is a distinct, profitable setup — so this runner keeps its
 * OWN allowlist and is intentionally NOT gated by trading_params.blockedSymbols.
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
const BREAKOUT_WINDOW_H = 4;     // only enter within 4h of the OR close
const TARGET_R          = 2;     // 2R beat 1R across almost every winning pairing
const MAX_ENTRY_AGE_MIN = 15;    // don't chase a breakout older than this (price moved)
const MIN_OR_BARS       = 4;     // need >=4 of the 6 M5 bars in the 30-min OR

const PAIRINGS = [
  { session: 'ASIA',   openUTC: '00:00', symbols: ['XAUUSD'] },
  { session: 'LONDON', openUTC: '07:00', symbols: ['WTI', 'SPX500', 'US30', 'AUDUSD', 'NZDUSD', 'AUDJPY', 'GBPJPY'] },
  { session: 'NY',     openUTC: '13:30', symbols: ['AUDJPY'] },
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

// ── Lot sizing — identical formula to inline_trader.mjs / session_runner.mjs ──
function calcLots(symbol, riskPct, equity, entry, sl) {
  const MIN_LOT = 0.01, LOT_STEP = 0.01, MAX_LOTS = 10;
  const riskAmt = equity * (riskPct / 100);
  const slDist  = Math.abs(entry - sl);
  if (slDist === 0) return MIN_LOT;
  const sym = symbol.toUpperCase();
  const q = lots => Math.min(Math.max(Math.floor(lots / LOT_STEP) * LOT_STEP, MIN_LOT), MAX_LOTS);

  if (/XAU|GOLD/.test(sym))                                   return q(riskAmt / (100 * slDist));
  if (/NAS100|NAS|NDX|NQ|US30|DOW|YM/.test(sym))              return q(riskAmt / slDist);
  if (/BTC|ETH|SOL|ADA|XRP|BNB|LTC/.test(sym)) {
    const maxLots = Math.floor(((equity * 0.01) / slDist) / LOT_STEP) * LOT_STEP;
    return q(Math.min(riskAmt / slDist, maxLots));
  }
  if (/WTI|OIL|BRENT|USOIL|UKOIL/.test(sym)) {
    const OIL_MIN = 3.0, OIL_STEP = 1.0;
    const slPips = slDist / 0.01;
    let lots = Math.floor((riskAmt / (10.0 * slPips)) / OIL_STEP) * OIL_STEP;
    return Math.min(Math.max(lots, OIL_MIN), MAX_LOTS);
  }
  if (/GER40|UK100|DAX|FTSE|SPX500|AUS200|JP225|HK50|EUSTX50/.test(sym)) return q(riskAmt / slDist);
  if (/JPY/.test(sym))   return q(riskAmt / (6.50 * (slDist / 0.01)));
  if (/XAG|SILVER/.test(sym)) return q(riskAmt / (5000 * slDist));
  return q(riskAmt / (10.0 * (slDist / 0.0001)));   // standard forex
}

// ── Session window math (for today, UTC) ─────────────────────────────────────
function sessionWindow(openUTC, now) {
  const [oh, om] = openUTC.split(':').map(Number);
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), oh, om);
  const orEnd = start + OR_DURATION_MIN * 60 * 1000;
  const brkEnd = orEnd + BREAKOUT_WINDOW_H * 3600 * 1000;
  return { start, orEnd, brkEnd };
}

// ── Detect the first close beyond the opening range ──────────────────────────
function detectBreakout(bars, start, orEnd, nowMs) {
  const orBars = bars.filter(b => b.t >= start && b.t < orEnd);
  if (orBars.length < MIN_OR_BARS) return { status: 'or_incomplete', orBars: orBars.length };
  const orHigh = Math.max(...orBars.map(b => b.h));
  const orLow  = Math.min(...orBars.map(b => b.l));
  if (!(orHigh > orLow)) return { status: 'or_flat' };

  const post = bars.filter(b => b.t >= orEnd).sort((a, b) => a.t - b.t);
  for (const b of post) {
    if (b.c > orHigh) return { status: 'breakout', dir: 'long',  entry: b.c, sl: orLow,  orHigh, orLow, barT: b.t };
    if (b.c < orLow)  return { status: 'breakout', dir: 'short', entry: b.c, sl: orHigh, orHigh, orLow, barT: b.t };
  }
  return { status: 'no_breakout', orHigh, orLow };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const now = new Date();
  const dow = now.getUTCDay();
  if (dow === 0 || dow === 6) { log('Weekend — ORB idle.'); return; }

  log(`═══ ORB RUNNER (${LIVE ? 'LIVE' : 'DRY-RUN'}) ═══`);

  const bridge = await import('./broker_ctrader.mjs');
  await bridge.connect();
  const params = loadParams();
  const riskPct = (params.riskPct && params.riskPct[0]) || 2.5;
  const state = loadState();
  const today = now.toISOString().slice(0, 10);
  const nowMs = now.getTime();

  let equity = 10000;
  try { const eq = await bridge.getEquity(); equity = eq.equity || eq.balance || equity; } catch (_) {}

  for (const pairing of PAIRINGS) {
    const { start, orEnd, brkEnd } = sessionWindow(pairing.openUTC, now);
    // Only act once the OR has closed and we're still inside the breakout window.
    if (nowMs < orEnd || nowMs > brkEnd) continue;

    for (const symbol of pairing.symbols) {
      const key = `${today}:${pairing.session}:${symbol}`;
      if (state[key]?.entered) continue;   // one shot per instrument/session/day

      let bars;
      try {
        bars = await bridge.getTrendbars(symbol, { period: 'M5', fromMs: start, toMs: nowMs });
      } catch (e) { log(`  ${symbol} ${pairing.session}: bars error — ${e.message}`); continue; }

      const r = detectBreakout(bars, start, orEnd, nowMs);
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
          const res = await bridge.placeOrder({ symbol, direction: r.dir, units: lots, entry: null, tpPrice: tp, slPrice: r.sl });
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
