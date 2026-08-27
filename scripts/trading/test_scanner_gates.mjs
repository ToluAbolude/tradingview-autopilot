/**
 * test_scanner_gates.mjs — guards the two gates that silently starved the scanner
 * 2026-08-22..27. Run: node test_scanner_gates.mjs
 */
import { readFileSync } from 'fs';
import assert from 'assert';

const PARAMS = JSON.parse(readFileSync('/home/ubuntu/trading-data/trading_params.json', 'utf8'));

// ── 1. Pass-1 gate must come from trading_params.json, not a hardcoded constant ──
const src = readFileSync('/home/ubuntu/tradingview-autopilot/scripts/trading/market_scanner.mjs', 'utf8');
assert(/pass1MinScore/.test(src), 'market_scanner must read pass1MinScore from params');
assert(!/const MIN_SCORE\s*=/.test(src), 'hardcoded MIN_SCORE constant is back — it outranks every param edit');
assert(/scanForSetups\(minScore\(\)/.test(src), 'scanForSetups must call minScore() per scan');

// Mirror of market_scanner.minScore()
const minScore = () => Number(PARAMS.pass1MinScore ?? 3);
assert.strictEqual(minScore(), 3, `pass1MinScore should be 3, got ${minScore()}`);

// A typical post-2026-08-21 bar scores 2; the mode of this week's live distribution
// was 2 (21455 cells) with 3->791, 4->156, >=5->49. A Pass-1 bar above 4 re-creates
// the outage, because nothing in the live distribution reaches it.
assert(minScore() <= 4, `pass1MinScore ${minScore()} > 4 starves the funnel (only 49 cells/week reached 5)`);

// ── 2. Plan-backed relief must be RELIEF, not a penalty ─────────────────────────
// Mirror of inline_trader.mjs:459
const baseThreshold  = PARAMS.scoreThreshold || 8;
const planThreshold  = Math.max(PARAMS.planScoreFloor ?? 6, baseThreshold - (PARAMS.planScoreRelief ?? 2));
assert(planThreshold <= baseThreshold,
  `plan-backed bar ${planThreshold} exceeds the ordinary bar ${baseThreshold} — relief is inverted`);
assert.strictEqual(planThreshold, 2, `plan-backed bar should be 2 (documented intent), got ${planThreshold}`);

// Trifecta-adjusted bars a plan-backed setup actually faces. inline_trader credits
// 'TL' to plan-backed setups, so trif >= 1 always and the 0-family Infinity reject
// can never fire on a planned entry.
const eff = t => t === 3 ? planThreshold
             : t === 2 ? planThreshold + (PARAMS.trifectaPartialBonus ?? 1)
             : t === 1 ? planThreshold + (PARAMS.trifectaWeakBonus    ?? 2)
             : Infinity;
assert.strictEqual(eff(3), 2);
assert.strictEqual(eff(2), 3);
assert.strictEqual(eff(1), 4);
assert(eff(1) <= 4, 'even a weak-trifecta plan entry must stay within reach of live scores');

console.log('all gate checks passed');
console.log(`  pass1MinScore   = ${minScore()}   (was a hardcoded 5)`);
console.log(`  ordinary bar    = ${baseThreshold}`);
console.log(`  plan-backed bar = ${planThreshold}   (was 6 — higher than ordinary)`);
console.log(`  plan-backed effective by trifecta: 3/3=${eff(3)}  2/3=${eff(2)}  1/3=${eff(1)}`);
