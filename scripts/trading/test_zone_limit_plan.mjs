/**
 * test_zone_limit_plan.mjs — guards the money math in zone_limit_runner's plan path.
 * Pure: no broker, no clock. Run: node test_zone_limit_plan.mjs
 */
import assert from 'assert';
import { readFileSync } from 'fs';
import { planZones, decideOrder } from './zone_limit_runner.mjs';

const today = new Date().toISOString().slice(0, 10);

// ── 1. planZones mirrors daily_plan_gate's filters ──────────────────────────────
const fake = { date: today, instruments: [
  { symbol: 'AAA', bias: 'bullish', entry_zones: [{ direction: 'long', zone_low: 10, zone_high: 12, tradeable: true,  invalidation: 9,  targets: [15] }] },
  { symbol: 'BBB', bias: 'no-view', entry_zones: [{ direction: 'long', zone_low: 10, zone_high: 12, tradeable: true,  invalidation: 9,  targets: [15] }] },
  { symbol: 'CCC', bias: 'bullish', entry_zones: [{ direction: 'long', zone_low: 10, zone_high: 12, tradeable: false, invalidation: 9,  targets: [15] }] },
  { symbol: 'DDD', bias: 'bearish', entry_zones: [{ direction: 'short', zone_low: 10, zone_high: 12, tradeable: true, invalidation: 13, targets: [7], role: 'fade-at-target' }] },
]};
const got = planZones(fake);
assert.strictEqual(got.stale, false);
assert.deepStrictEqual(got.zones.map(z => z.sym), ['AAA'], 'no-view, untradeable and fade-at-target zones must all be dropped');
assert.strictEqual(planZones({ date: '2020-01-01', instruments: [] }).stale, true, 'yesterday\'s plan must read as stale');
assert.strictEqual(planZones(null).stale, true, 'a missing plan must read as stale');

// ── 2. Resting geometry — long ──────────────────────────────────────────────────
const zL = { sym: 'XAUUSD', dir: 'long', lo: 4585, hi: 4602, invalidation: 4571, targets: [4643, 4673] };
const atr = 20, eq = 2682, risk = 5;

let d = decideOrder(zL, 4610, atr, eq, risk);                 // price above the zone
assert(!d.skip, `expected an order, got skip: ${d.skip}`);
assert.strictEqual(d.entry, 4593.5, 'must rest at the zone midpoint — the price the plan costed its R at');
assert(Math.abs(d.R - 2.2) < 0.05, `R ${d.R} must reproduce the plan's rr_to_t1 of 2.2`);
assert.strictEqual(d.sl,    4571, 'SL must be the plan invalidation');
assert.strictEqual(d.tp,    4643, 'TP must be the plan\'s first target');
assert(d.slFromPlan && d.tpFromPlan);
assert(d.sl < d.entry && d.tp > d.entry, 'long: SL below entry, TP above');

// The broker rejects any order whose SL is the wrong side of entry — assert the
// invariant assertOrderSafety enforces, so we never ship one it will bounce.
for (const px of [4605, 4620, 4650]) {
  const o = decideOrder(zL, px, atr, eq, risk);
  if (!o.skip) assert(o.sl < o.entry && o.tp > o.entry, `long invariant broken at px=${px}`);
}

// ── 3. Resting geometry — short ─────────────────────────────────────────────────
const zS = { sym: 'USDJPY', dir: 'short', lo: 159.4, hi: 159.7, invalidation: 159.9, targets: [158.8] };
d = decideOrder(zS, 159.2, 0.5, eq, risk);
assert(!d.skip, `expected an order, got skip: ${d.skip}`);
assert.strictEqual(d.entry, 159.55, 'a short must rest at the zone midpoint too');
assert(d.sl > d.entry && d.tp < d.entry, 'short: SL above entry, TP below');

// ── 4. Refusals ─────────────────────────────────────────────────────────────────
assert(decideOrder(zL, 4590, atr, eq, risk).skip.includes('already at/through'),
  'price inside the zone is a market entry, not a resting limit');
assert(decideOrder(zL, 4560, atr, eq, risk).skip.includes('already at/through'),
  'price beyond the zone must not rest a limit behind it');
assert(decideOrder(zL, 4594, atr, eq, risk).skip.includes('too close'),
  'a limit a hair from price is a market order in disguise');
assert(decideOrder(zL, 4900, atr, eq, risk).skip.includes('out of reach'),
  'a level price cannot reach today must not tie up an order slot');

// ── 5. Fallbacks when the plan is malformed ─────────────────────────────────────
d = decideOrder({ ...zL, invalidation: 4650 }, 4610, atr, eq, risk);   // SL above entry on a long
assert(!d.slFromPlan && d.sl < d.entry, 'an invalidation on the wrong side must fall back, not ship');
for (const bad of [null, undefined, '', 0, NaN, -5]) {
  d = decideOrder({ ...zL, invalidation: bad }, 4610, atr, eq, risk);
  assert(!d.slFromPlan, `invalidation ${JSON.stringify(bad)} must fall back, not ship`);
  assert(d.sl > 0 && d.sl < d.entry, `invalidation ${JSON.stringify(bad)} produced SL ${d.sl} — a stop at/below zero is a live order with no stop`);
}
for (const bad of [[null], [0], [''], [NaN]]) {
  d = decideOrder({ ...zL, targets: bad }, 4610, atr, eq, risk);
  assert(!d.tpFromPlan && d.tp > d.entry, `target ${JSON.stringify(bad)} must fall back to an R multiple`);
}
d = decideOrder({ ...zL, targets: [4000] }, 4610, atr, eq, risk);      // target on the wrong side
assert(!d.tpFromPlan && d.tp > d.entry, 'a target on the wrong side must fall back to an R multiple');

// A zone that cannot pay the 1:2 floor must not rest.
assert(decideOrder({ ...zL, targets: [4610] }, 4620, atr, eq, risk).skip.includes('floor'),
  'a sub-2R zone must be refused, not rested');

// ── 6. Sizing tracks riskPct and never exceeds it ───────────────────────────────
const small = decideOrder(zL, 4610, atr, eq, 2).lots;
const big   = decideOrder(zL, 4610, atr, eq, 10).lots;
assert(big > small, 'more risk must buy more size');
// XAUUSD: $100/point/lot. Loss at SL must not exceed the risk budget.
const o5 = decideOrder(zL, 4610, atr, eq, 5);
const loss = o5.lots * 100 * Math.abs(o5.entry - o5.sl);
assert(loss <= eq * 5 / 100 + 0.01, `sized loss $${loss.toFixed(2)} exceeds the 5% budget $${(eq*0.05).toFixed(2)}`);

// ── 7. Today's REAL plan produces broker-valid geometry ─────────────────────────
let real = null;
try { real = JSON.parse(readFileSync('/home/ubuntu/trading-data/daily_plan.json', 'utf8')); } catch {}
if (real) {
  const rz = planZones(real);
  console.log(`  live plan ${real.date}: ${rz.zones.length} tradeable zone(s) — ${rz.zones.map(z=>`${z.sym} ${z.dir}`).join(', ') || 'none'}`);
  for (const z of rz.zones) {
    const mid = (z.lo + z.hi) / 2, a = Math.abs(z.hi - z.lo) || 1;
    // Park price one ATR outside the zone so the order is placeable, then check invariants.
    const px = z.dir === 'long' ? z.hi + a : z.lo - a;
    const o = decideOrder(z, px, a, eq, risk);
    if (o.skip) { console.log(`    ${z.sym} ${z.dir}: skip — ${o.skip}`); continue; }
    assert(z.dir === 'long' ? (o.sl < o.entry && o.tp > o.entry) : (o.sl > o.entry && o.tp < o.entry),
      `${z.sym} ${z.dir}: SL/TP on the wrong side of entry — the broker would reject this`);
    assert(o.lots > 0, `${z.sym}: zero lots`);
    console.log(`    ${z.sym} ${z.dir}: entry ${o.entry} SL ${o.sl} TP ${o.tp} ${o.lots}lots ${(Math.abs(o.tp-o.entry)/o.risk).toFixed(1)}R  (plan SL=${o.slFromPlan} TP=${o.tpFromPlan})`);
  }
}

console.log('all zone-limit plan checks passed');
