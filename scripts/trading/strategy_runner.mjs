/**
 * strategy_runner.mjs — runs every plugged-in strategy for one cTrader account.
 *
 * Strategies are folders in scripts/trading/strategies/<id>/ with a manifest.json
 * (how to add one: scripts/trading/strategies/README.md). This replaces
 * confirm_runner.mjs (2026-09-15): the per-strategy behaviour is unchanged, but the
 * roster, instruments, timeframe, risk and target come from manifests instead of a
 * hardcoded COMBOS list, and every order carries the strategy id as its cTrader label.
 *
 * Each tick (cron, every 5 min), for every enabled manifest on THIS account
 * (CTRADER_ACCOUNT_ID) × each of its instruments:
 *   closed bars → logic.generateSignals() → a signal on the last closed bar not yet
 *   acted on → manifest filters → signalErrors() → bracket (the strategy's own TP when
 *   it is on the profit side, else target.r × risk) → lots from risk.per_trade_pct →
 *   placeOrder with label = manifest id → verify SL+TP attached.
 *
 * SAFETY:
 *   - --live places orders only for manifests with mode "live", and only when
 *     CTRADER_ENV=demo (both accounts are demo; lifting that is a separate decision).
 *   - Daily kill switch on whole-account realised P&L (confirmMaxDailyLossPct, default 6).
 *   - assertOrderSafety on every order: plan gate (scanner account), stop floors, lot
 *     caps, exposure policy, fib veto, frozen price.
 *   - One entry per strategy × symbol × bar (state file).
 *   - A broken manifest, a strategy that throws, or an invalid signal is logged and
 *     skipped — it never stops the other strategies.
 *
 * Without --live everything is a dry run. With --live, mode "paper" manifests still
 * only log. Both append to the signals log, with mode "dry-run" / "paper".
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { fetchHighImpactNews, filterForSymbol } from './news_checker.mjs';
import { calcLots } from './lib/sizing.mjs';
import { isCrypto, instrumentClass } from './lib/instruments.mjs';
import { isCalendarWeekend, weekendCryptoOn } from './lib/clock.mjs';
import { signalErrors } from './lib/contracts.mjs';
import { loadStrategies, TIMEFRAMES } from './lib/strategies.mjs';

const IS_LINUX  = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX ? '/home/ubuntu/trading-data' : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
// STRATEGY_DATA_DIR redirects the state file and signals log — a dry-run comparison
// must never mark bars as evaluated in the live state. Params always come from DATA_ROOT.
const RUN_DIR = process.env.STRATEGY_DATA_DIR || DATA_ROOT;
const ACCOUNT = String(process.env.CTRADER_ACCOUNT_ID || '');
// The experiment account keeps its historical file names: confirm_report,
// confirm_weekly_review, strategy_benchmark and trade_notion_sync read them.
const FILES = ACCOUNT === '2131377'
  ? { state: 'confirm_state.json', signals: 'confirm_signals.jsonl' }
  : { state: `strategy_state_${ACCOUNT}.json`, signals: `strategy_signals_${ACCOUNT}.jsonl` };

const PARAMS_FILE = join(DATA_ROOT, 'trading_params.json');
const STATE_FILE  = join(RUN_DIR, FILES.state);
const SIGNALS_LOG = join(RUN_DIR, FILES.signals);

const LIVE     = process.argv.includes('--live');   // default: dry-run
const SESSIONS = { ASIA: '00:00', LONDON: '07:00', NY: '13:30' };

function log(msg) { process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`); }
function loadParams() { try { return JSON.parse(readFileSync(PARAMS_FILE, 'utf8')); } catch { return {}; } }
function loadState()  { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) {
  // prune evaluation keys older than 3 days so the file stays small
  const cutoff = Date.now() - 3 * 86400000;
  for (const k of Object.keys(s)) { if ((s[k]?.t || 0) < cutoff) delete s[k]; }
  if (!existsSync(RUN_DIR)) mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ── Manifest filters (Chart Fanatics playbook filters) ────────────────────────
// prior_day_range: the most recent prior UTC day's high/low (skips weekend gaps).
function priorDayHL(bars, refTs) {
  const ref = new Date(refTs);
  const refDayStart = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate());
  const byDay = {};
  for (const b of bars) {
    if (b.t >= refDayStart) continue;
    const d = new Date(b.t);
    const k = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    (byDay[k] ||= []).push(b);
  }
  const days = Object.keys(byDay).map(Number).sort((a, b) => b - a);
  if (!days.length) return null;
  const prev = byDay[days[0]];
  return { hi: Math.max(...prev.map(b => b.h)), lo: Math.min(...prev.map(b => b.l)) };
}
function evTimeMs(ev) {                       // FF date may be full-ISO or date + time
  let t = Date.parse(ev.date);
  if (isNaN(t) && ev.time) t = Date.parse(`${ev.date} ${ev.time}`);
  return t;
}
// news_recent: a high-impact event for the symbol's currencies fired recently
// (post-spike window) — the Chart Fanatics "trade the move AFTER the news" rule.
function newsRecent(events, symbol, nowMs, { minMin = 5, maxMin = 180 } = {}) {
  let relevant = events;
  try { relevant = filterForSymbol(events, symbol); } catch (_) {}
  for (const ev of relevant) {
    const t = evTimeMs(ev);
    if (isNaN(t)) continue;
    const ageMin = (nowMs - t) / 60000;
    if (ageMin >= minMin && ageMin <= maxMin) return true;
  }
  return false;
}

async function main() {
  const now = new Date();
  const isWeekend = isCalendarWeekend(now);
  // Weekend policy: FX/metals/indices are closed (the broker queues orders to the
  // illiquid Sunday open — the 2026-06-06 blowup), but CRYPTO trades 24/7 with a live
  // feed. So on the weekend only crypto instruments run. WEEKEND_CRYPTO=off idles.
  if (isWeekend && !weekendCryptoOn()) { log('Weekend — strategy runner idle.'); return; }

  const { strategies, errors } = await loadStrategies();
  for (const e of errors) log(`⚠ strategy "${e.id}" skipped: ${e.errors.join('; ')}`);
  const mine = strategies.filter(s => s.manifest.enabled && s.manifest.account === ACCOUNT);
  const roster = mine.map(s => `${s.manifest.id}[${s.manifest.mode}]`).join(', ') || 'no strategies';
  log(`═══ STRATEGY RUNNER (${LIVE ? 'LIVE/DEMO' : 'DRY-RUN'}) account ${ACCOUNT || '?'}: ${roster}${isWeekend ? ' — WEEKEND crypto-only' : ''} ═══`);
  if (!mine.length) return;
  if (process.env.CONFIRM_RISK_PCT) log(`ⓘ CONFIRM_RISK_PCT=${process.env.CONFIRM_RISK_PCT} is ignored — each manifest sets risk.per_trade_pct`);

  // HARD demo-only gate for placing orders.
  const env = (process.env.CTRADER_ENV || 'demo').toLowerCase();
  if (LIVE && env !== 'demo') {
    log(`🛑 REFUSING: --live requires CTRADER_ENV=demo (got '${env}').`);
    process.exit(1);
  }

  const bridge = await import('./broker_ctrader.mjs');
  await bridge.connect();
  const params = loadParams();
  const state  = loadState();
  const nowMs  = now.getTime();

  let equity = 10000;
  try { const eq = await bridge.getEquity(); equity = eq.equity || eq.balance || equity; } catch (_) {}

  // Daily kill switch on whole-account realised P&L (same source as the live system).
  if (LIVE) {
    const MAX_DAILY_LOSS_PCT = params.confirmMaxDailyLossPct ?? 6;
    try {
      const todayPnl = await bridge.getTodayRealizedPnl();
      const ddPct    = (todayPnl / Math.max(1, equity)) * 100;
      if (ddPct <= -MAX_DAILY_LOSS_PCT) {
        log(`🛑 KILL-SWITCH: today realised ${ddPct.toFixed(1)}% (limit -${MAX_DAILY_LOSS_PCT}%). No more entries today.`);
        log('═══ STRATEGY RUNNER halted (kill-switch) ═══');
        process.exit(0);
      }
      log(`Kill-switch OK: today realised ${ddPct.toFixed(1)}% (limit -${MAX_DAILY_LOSS_PCT}%).`);
    } catch (e) {
      log(`⚠ kill-switch check FAILED (${e.message}) — proceeding WITHOUT it this tick`);
    }
  }

  // Fetch the high-impact calendar once per tick if any strategy needs it.
  let newsEvents = null;
  if (mine.some(s => s.manifest.filters.includes('news_recent'))) {
    try { newsEvents = await fetchHighImpactNews(); log(`News: ${newsEvents.length} high-impact event(s) this week.`); }
    catch (e) { newsEvents = []; log(`⚠ news fetch failed (${e.message}) — news-gated strategies skip this tick`); }
  }

  async function runOne(m, logic, symbol) {
    const { period, ms: tfMs } = TIMEFRAMES[m.timeframe];
    const tf  = m.timeframe;
    const tag = `${m.id}/${symbol}/${tf}`;

    let bars;
    try {
      bars = await bridge.getTrendbars(symbol, { period, fromMs: nowMs - m.history_days * 86400000, toMs: nowMs });
    } catch (e) { log(`  ${tag}: bars error — ${e.message}`); return; }

    // Only consider CLOSED bars (drop the still-forming final bar).
    const closed = (bars || []).filter(b => nowMs >= b.t + tfMs);
    if (closed.length < 60) { log(`  ${tag}: only ${closed.length} closed bars — skip`); return; }
    const lastClosed = closed[closed.length - 1];
    const key = `${m.id}:${symbol}:${lastClosed.t}`;
    if (state[key]) return;   // already evaluated this bar

    let signals;
    try {
      signals = logic.generateSignals(closed, {
        symbol, tf, params: m.params, sessions: SESSIONS,
        instrument: { symbol, class: instrumentClass(symbol).toLowerCase() },
      }) || [];
    } catch (e) { log(`  ${tag}: generateSignals error — ${e.message}`); return; }

    state[key] = { t: lastClosed.t, evaluated: true };   // mark bar handled (after success)

    const fresh = signals.filter(s => s.ts === lastClosed.t && s.dir && s.entry && s.sl);
    log(`  ${tag}: ${closed.length} closed bars, ${signals.length} sig(s), ${fresh.length} fresh on last bar`);
    if (!fresh.length) return;
    const sig = fresh[fresh.length - 1];

    if (m.filters.includes('prior_day_range')) {
      const pd = priorDayHL(closed, sig.ts);
      const ok = pd && (sig.dir === 'long' ? sig.entry > pd.hi : sig.entry < pd.lo);
      if (!ok) { log(`  ${tag} [NTZ]: entry inside prior-day range (balance/chop) — skip`); return; }
    }
    if (m.filters.includes('news_recent')) {
      if (!newsRecent(newsEvents || [], symbol, nowMs)) { log(`  ${tag} [news]: no recent high-impact ${symbol} news — skip`); return; }
    }

    const invalid = signalErrors({ strategyId: m.id, symbol, tf, dir: sig.dir, ts: sig.ts, entry: sig.entry, sl: sig.sl });
    if (invalid.length) { log(`  ${tag}: invalid signal — ${invalid.join('; ')} — skip`); return; }
    const risk = Math.abs(sig.entry - sig.sl);
    // A strategy may supply its own TP (e.g. jadecap targets opposite session
    // liquidity, not a fixed R multiple); it must be on the profit side.
    const ownTp = sig.tp != null && (sig.dir === 'long' ? sig.tp > sig.entry : sig.tp < sig.entry);
    const tp    = ownTp ? sig.tp : (sig.dir === 'long' ? sig.entry + m.target.r * risk : sig.entry - m.target.r * risk);
    const riskPct = m.risk.per_trade_pct;
    const lots  = calcLots(symbol, riskPct, equity, sig.entry, sig.sl);
    const placing = LIVE && m.mode === 'live';

    const record = {
      ts: now.toISOString(), mode: placing ? 'live-demo' : LIVE ? 'paper' : 'dry-run',
      strategy: m.id, symbol, tf, dir: sig.dir,
      entry: +sig.entry.toFixed(5), sl: +sig.sl.toFixed(5), tp: +tp.toFixed(5),
      riskR: +(Math.abs(tp - sig.entry) / risk).toFixed(2), lots, riskPct, equity: +equity.toFixed(2),
      reason: sig.reason || null, barT: lastClosed.t,
    };

    if (placing) {
      try {
        // Pass `entry` => ATOMIC path: SL/TP attach on the order itself (relative
        // distance from fill). placeOrder still runs assertOrderSafety.
        const sentAt = Date.now();
        const res = await bridge.placeOrder({ symbol, direction: sig.dir, units: lots, entry: sig.entry, tpPrice: tp, slPrice: sig.sl, label: m.id });
        record.positionId = Number(res?.position?.positionId || res?.positionId) || null;
        // ORDER_ACCEPTED can arrive without the position object (observed 2026-07-03,
        // stage_s2/US30) — recover the id so bracket-verify + attribution still run.
        if (!record.positionId) {
          await new Promise(r => setTimeout(r, 3000));
          try {
            const cand = (await bridge.getPositions())
              .filter(p => p.direction === sig.dir && (p.openTimestamp || 0) >= sentAt - 2000)
              .sort((a, b) => (b.openTimestamp || 0) - (a.openTimestamp || 0))[0];
            if (cand) { record.positionId = cand.positionId; record.positionIdRecovered = true; }
          } catch (_) {}
        }
        record.placed = !!record.positionId;
        state[key].positionId = record.positionId;
        // Verify SL+TP attached, retrying up to ~8s. Only close if genuinely naked after
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
      log(`  📝 ${LIVE ? 'PAPER' : 'DRY'} ${tag} ${sig.dir} ${lots}lots entry~${record.entry} SL ${record.sl} TP ${record.tp} (${riskPct}% = $${(equity * riskPct / 100).toFixed(2)})`);
    }
    appendFileSync(SIGNALS_LOG, JSON.stringify(record) + '\n');
  }

  for (const { manifest: m, logic } of mine) {
    for (const symbol of m.instruments) {
      // Weekend: only crypto instruments — FX/metals/indices are closed.
      if (isWeekend && !isCrypto(symbol)) continue;
      try { await runOne(m, logic, symbol); }
      catch (e) { log(`  ${m.id}/${symbol}/${m.timeframe}: failed — ${e.message}`); }
    }
  }

  saveState(state);
  log('═══ STRATEGY RUNNER done ═══');
  process.exit(0);   // cTrader socket stays open otherwise; exit cleanly for cron
}

if (!existsSync(RUN_DIR)) mkdirSync(RUN_DIR, { recursive: true });
main().catch(e => { console.error('strategy_runner failed:', e); process.exit(1); });
