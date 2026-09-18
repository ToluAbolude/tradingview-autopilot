/**
 * trail_runner.mjs — runner-leg exit manager for the SCANNER account (2026-08-17).
 *
 * The exit-model inversion: inline_trader now places ~1/3 of the position with a
 * TP at the structural 2R level and leaves the other ~2/3 as a TP-less RUNNER
 * behind the same stop. This cron is what makes the runner pay:
 *
 *   at +1R  → SL to breakeven (entry). Trade can no longer lose.
 *   at +2R+ → chandelier trail: SL follows (highest H1 close since entry) − 2×ATR(H1)
 *             for longs (mirrored for shorts). Tighten-only, never widen, never
 *             above/below the current price (that would market-close the position).
 *
 * WHY: 62 matched trades ended 44% full-SL / 24% cut-winner / 10% full-TP — a
 * 23% win rate with capped 2R targets is mathematically unpayable (breakeven
 * needs avgW/avgL > 3.35). Every verified low-win-rate track record (Qullamaggie
 * 25–35% WR, Zarattini ORB 24% WR) pays for its losers with an UNCAPPED right
 * tail; ours was amputated at 2R by design. This uncaps it.
 *
 * Runs from cron with the scanner env (~/.ctrader.env). Broker-side SL means
 * every ratchet survives a bot crash. Kill switch: RUNNER_TRAIL=off.
 * Default is DRY-RUN; cron passes --live.
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import os from 'os';

const IS_LINUX  = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX ? '/home/ubuntu/trading-data' : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const STATE_FILE = join(DATA_ROOT, 'runner_trail.json');   // positionId → { initialSl } (risk anchor survives SL moves)

const LIVE       = process.argv.includes('--live');
const BE_AT_R    = Number(process.env.RUNNER_BE_R ?? 1.0);
const TRAIL_AT_R = Number(process.env.RUNNER_TRAIL_R ?? 2.0);
const CHAND_ATR  = Number(process.env.RUNNER_CHANDELIER_ATR ?? 2.0);

// Owner scoping (2026-09-15): trail only positions opened by a strategy that uses the
// runner exit. Other strategies on this account (plan zone limits, ORB) were validated
// with fixed brackets. Unlabeled positions predate order labels or were opened by hand,
// and keep the old behaviour (trailed). Comma-separated strategy ids: TRAIL_OWNERS.
const TRAIL_OWNERS = new Set((process.env.TRAIL_OWNERS ?? 'scanner_confluence').split(',').map(s => s.trim()).filter(Boolean));

const log = m => console.log(`[${new Date().toISOString()}] ${m}`);

export function atr14(bars) {
  if (bars.length < 15) return null;
  let sum = 0;
  for (let i = bars.length - 14; i < bars.length; i++) {
    const b = bars[i], pc = bars[i - 1].c;
    sum += Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
  }
  return sum / 14;
}

/** Pure trail decision — returns new SL or null. Exported for the self-check. */
export function trailDecision({ dir, entry, initialSl, currentSl, bars, openTs }) {
  const risk = Math.abs(entry - initialSl);
  const atr  = atr14(bars);
  if (!risk || !atr || !bars.length) return null;
  const px = bars[bars.length - 1].c;
  const R  = dir === 'long' ? (px - entry) / risk : (entry - px) / risk;

  let cand = null;
  if (R >= BE_AT_R) cand = entry;                              // breakeven lock
  if (R >= TRAIL_AT_R) {
    const closes = bars.filter(b => b.t >= openTs).map(b => b.c);
    if (closes.length) {
      const chand = dir === 'long'
        ? Math.max(...closes) - CHAND_ATR * atr
        : Math.min(...closes) + CHAND_ATR * atr;
      cand = dir === 'long' ? Math.max(cand, chand) : Math.min(cand, chand);
    }
  }
  if (cand == null) return null;

  // Never place SL through current price (instant market close), never widen,
  // and skip sub-noise ratchets (<0.05 ATR improvement = API spam).
  if (dir === 'long') {
    cand = Math.min(cand, px - 0.1 * atr);
    if (cand <= currentSl + 0.05 * atr) return null;
  } else {
    cand = Math.max(cand, px + 0.1 * atr);
    if (cand >= currentSl - 0.05 * atr) return null;
  }
  return Number(cand.toFixed(5));
}

// ── Self-check (assert-based, no framework) ──────────────────────────────────
if (process.argv.includes('--selftest')) {
  const mk = (t, c) => ({ t, o: c, h: c + 1, l: c - 1, c, v: 1 });
  const warm = Array.from({ length: 20 }, (_, i) => mk(i, 100));          // ATR ≈ 2
  // long from 100, risk 2: price ran to 110 → chandelier = 110 − 2×ATR ≈ 106
  const run  = [...warm, mk(20, 104), mk(21, 108), mk(22, 110)];
  const sl1 = trailDecision({ dir: 'long', entry: 100, initialSl: 98, currentSl: 98, bars: run, openTs: 20 });
  console.assert(sl1 && sl1 > 100 && sl1 < 110, `chandelier ratchets above BE, got ${sl1}`);
  // only +1R (price 102) → BE exactly
  const be  = [...warm, mk(20, 102)];
  const sl2 = trailDecision({ dir: 'long', entry: 100, initialSl: 98, currentSl: 98, bars: be, openTs: 20 });
  console.assert(sl2 === 100, `BE at +1R, got ${sl2}`);
  // flat trade → no move; and never widen (currentSl already above cand)
  const sl3 = trailDecision({ dir: 'long', entry: 100, initialSl: 98, currentSl: 98, bars: warm, openTs: 0 });
  const sl4 = trailDecision({ dir: 'long', entry: 100, initialSl: 98, currentSl: 109, bars: run, openTs: 20 });
  console.assert(sl3 === null && sl4 === null, `no-op cases, got ${sl3}/${sl4}`);
  // short mirror: from 100 down to 90, chandelier = 90 + 2×ATR ≈ 94
  const dn = [...warm, mk(20, 96), mk(21, 92), mk(22, 90)];
  const sl5 = trailDecision({ dir: 'short', entry: 100, initialSl: 102, currentSl: 102, bars: dn, openTs: 20 });
  console.assert(sl5 && sl5 < 100 && sl5 > 90, `short chandelier, got ${sl5}`);
  console.log('selftest OK');
  process.exit(0);
}

// ── Live pass ────────────────────────────────────────────────────────────────
if ((process.env.RUNNER_TRAIL ?? 'on') === 'off') { log('RUNNER_TRAIL=off — exiting'); process.exit(0); }

const bridge = await import('./broker_ctrader.mjs');
await bridge.connect();

let state = {};
try { state = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch (_) {}

const positions = await bridge.getPositions();
log(`${positions.length} open position(s)${LIVE ? '' : ' [DRY-RUN]'}`);

for (const pos of positions) {
  // getSymbolNameById returns { id, name, ... }. Passing that object on to getTrendbars
  // made every trail attempt die as 'symbol "[object Object]" not in account symbol list'
  // — 660 times since the runner exit shipped 2026-08-17, and not one stop ever moved.
  // Fixed 2026-09-18; confirm_eod_close already took `.name` this way.
  const symbol = (await bridge.getSymbolNameById(pos.symbolId).catch(() => null))?.name || null;
  if (!symbol) continue;
  if (!pos.stopLoss) { log(`  ${symbol} #${pos.positionId}: no SL — confirm_naked_guard's problem, skipping`); continue; }
  if (pos.label && !TRAIL_OWNERS.has(pos.label)) { log(`  ${symbol} #${pos.positionId}: owned by ${pos.label}, which doesn't use the runner exit — skipping`); continue; }

  // First sighting anchors the ORIGINAL risk; later SL moves must not shrink R math.
  if (!state[pos.positionId]) state[pos.positionId] = { initialSl: pos.stopLoss, symbol };
  const { initialSl } = state[pos.positionId];

  let bars;
  try {
    bars = await bridge.getTrendbars(symbol, { period: 'H1', fromMs: pos.openTimestamp - 5 * 24 * 3600 * 1000 });
  } catch (e) { log(`  ${symbol}: bars error — ${e.message}`); continue; }

  const newSl = trailDecision({
    dir: pos.direction, entry: pos.entryPrice, initialSl,
    currentSl: pos.stopLoss, bars, openTs: pos.openTimestamp,
  });
  if (newSl == null) { log(`  ${symbol} #${pos.positionId}: hold (SL ${pos.stopLoss})`); continue; }

  if (LIVE) {
    try {
      await bridge.modifyPosition(pos.positionId, { stopLoss: newSl });
      log(`  ✓ ${symbol} #${pos.positionId}: SL ${pos.stopLoss} → ${newSl} (${pos.direction}, entry ${pos.entryPrice})`);
    } catch (e) { log(`  ✗ ${symbol} #${pos.positionId}: modify failed — ${e.message}`); }
  } else {
    log(`  [dry] ${symbol} #${pos.positionId}: SL ${pos.stopLoss} → ${newSl}`);
  }
}

// Prune closed positions from state
const openIds = new Set(positions.map(p => String(p.positionId)));
for (const id of Object.keys(state)) if (!openIds.has(id)) delete state[id];
try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { log(`state write failed: ${e.message}`); }

process.exit(0);
