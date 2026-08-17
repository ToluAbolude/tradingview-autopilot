/**
 * daily_plan_gate.mjs — the hard inversion of the system's causality (2026-07-30).
 *
 * BEFORE: signal → trade. A 15m indicator pinged, a score cleared a threshold, an
 *         order went out on any of 40 instruments with no prior opinion about any of
 *         them. 147 trades in six weeks, ~20% win rate, -$6,667.
 * AFTER:  thesis → level → wait → trade. daily_plan.mjs commits to a written plan
 *         before London. This gate refuses to open ANY position that is not part of
 *         that plan, in the planned direction, at the planned level.
 *
 * The scanner keeps all of its analysis — it just loses the authority to ORIGINATE a
 * trade. Confluence scoring can still veto (every gate downstream of this one still
 * runs); it can no longer invent a reason to be in the market. If price never reaches
 * a planned zone, there is no trade today. That is the intended behaviour.
 *
 * FAILS CLOSED. No plan file, a stale plan, an unreadable plan → nothing trades. On
 * an account that loses money by default, "stop trading" is the correct response to
 * a broken pre-market process, not "carry on blind" (the 2026-07-20 Sunday-reopen
 * blowup was exactly a fallback path executing without the context the edge needs).
 *
 * Kill switch: PLAN_GATE=off restores the old originate-anywhere behaviour.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import os from 'os';

const IS_LINUX  = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX ? '/home/ubuntu/trading-data' : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const PLAN_FILE = join(DATA_ROOT, 'daily_plan.json');

// How far outside a zone band an entry is still accepted, as a fraction of the zone's
// own width. A rejection wick that triggers the setup often prints slightly through
// the band; 25% keeps that legitimate while still refusing a fill 3 handles away.
const ZONE_BUFFER = Number(process.env.PLAN_ZONE_BUFFER ?? 0.25);

export function loadPlan() {
  if (!existsSync(PLAN_FILE)) return null;
  try { return JSON.parse(readFileSync(PLAN_FILE, 'utf8')); } catch (_) { return null; }
}

/**
 * Decide whether `setup` is in today's plan, and if so bind it to its zone.
 * Returns { ok, reason, zone, instrument }.
 */
export function checkPlan(setup) {
  if ((process.env.PLAN_GATE ?? 'on') === 'off') return { ok: true, reason: 'plan gate disabled (PLAN_GATE=off)' };

  const plan = loadPlan();
  if (!plan) return { ok: false, reason: 'no daily_plan.json — pre-market plan never ran. Nothing trades without a plan.' };

  const today = new Date().toISOString().slice(0, 10);
  if (plan.date !== today) {
    return { ok: false, reason: `daily plan is stale (dated ${plan.date}, today is ${today}) — refusing to trade yesterday's levels` };
  }

  const inst = (plan.instruments || []).find(i => i.symbol === setup.label);
  if (!inst) return { ok: false, reason: `${setup.label} is not in today's plan (planned: ${(plan.instruments || []).map(i => i.symbol).join(', ') || 'none'})` };
  if (inst.bias === 'no-view') return { ok: false, reason: `${setup.label} bias is no-view today — analyst stood aside` };

  const zones = (inst.entry_zones || []).filter(z => z.tradeable && z.role !== 'fade-at-target');
  if (!zones.length) return { ok: false, reason: `${setup.label} has no tradeable zone today (bias ${inst.bias})` };

  const dirZones = zones.filter(z => z.direction === setup.dir);
  if (!dirZones.length) {
    return { ok: false, reason: `${setup.label} ${setup.dir} contradicts today's plan (bias ${inst.bias}, planned zones are ${[...new Set(zones.map(z => z.direction))].join('/')})` };
  }

  // Price must actually be AT a planned level. This is the whole point: the desk
  // waits for price to come to it, rather than chasing wherever the signal fired.
  //
  // A caller that cannot supply a reference price (some market-order paths) still
  // gets the membership/bias/tradeable-zone checks — it just cannot be held to the
  // level. Those callers sit behind inline_trader's strict check anyway; this is the
  // broker-level backstop, and blocking a whole path over a missing field would be
  // the wrong kind of strict.
  const px = setup.entry;
  if (!Number.isFinite(px)) {
    return { ok: true, reason: `in plan: ${inst.bias} ${setup.dir} (no reference price supplied — level check skipped)`, zone: dirZones[0], instrument: inst };
  }
  const hit = dirZones.find(z => {
    const buf = Math.abs(z.zone_high - z.zone_low) * ZONE_BUFFER;
    return px >= z.zone_low - buf && px <= z.zone_high + buf;
  });
  if (!hit) {
    const nearest = dirZones
      .map(z => ({ z, d: Math.min(Math.abs(px - z.zone_low), Math.abs(px - z.zone_high)) }))
      .sort((a, b) => a.d - b.d)[0];
    return { ok: false, reason: `${setup.label} @ ${px} is not at a planned zone (nearest ${setup.dir} zone ${nearest.z.zone_low}–${nearest.z.zone_high}, ${nearest.d.toPrecision(4)} away) — wait for the level` };
  }

  return { ok: true, reason: `in plan: ${inst.bias} ${setup.dir} zone ${hit.zone_low}–${hit.zone_high} (${hit.rr_to_t1}R) — ${hit.rationale}`, zone: hit, instrument: inst };
}

/**
 * Bind the setup's risk levels to the plan's structure. The plan's invalidation is a
 * structural level chosen before the session with a reason attached; a 15m ATR stop
 * is not. Mutates `setup`.
 *
 * SL: widen-only. If the plan's invalidation sits further from entry than the signal's
 *     own stop, take it — the WTI post-mortem (2026-05-28) and the -$5,659 USDCHF
 *     collapsed-stop incident both say a wider structural stop with smaller size beats
 *     a tight stop with big size. Never TIGHTEN, which would just manufacture a
 *     stop-out inside normal noise.
 * TP: take the plan's targets when they are on the correct side of entry.
 */
export function applyPlanLevels(setup, zone, log = () => {}) {
  if (!zone) return;
  const dir = setup.dir;
  const inv = zone.invalidation;

  const invValid = dir === 'long' ? inv < setup.entry : inv > setup.entry;
  if (invValid) {
    const planDist = Math.abs(setup.entry - inv);
    const sigDist  = Math.abs(setup.entry - setup.sl);
    if (planDist > sigDist) {
      log(`SL → plan invalidation ${setup.sl} → ${inv} (structural, ${(planDist / sigDist).toFixed(2)}x the signal stop)`);
      setup.sl = inv;
    }
  } else {
    log(`⚠ plan invalidation ${inv} is on the wrong side of entry ${setup.entry} — keeping signal SL ${setup.sl}`);
  }

  const targets = (zone.targets || []).filter(t => dir === 'long' ? t > setup.entry : t < setup.entry);
  if (targets.length) {
    const sorted = dir === 'long' ? targets.sort((a, b) => a - b) : targets.sort((a, b) => b - a);
    const prev = `${setup.tp1}/${setup.tp2}/${setup.tp3}`;
    setup.tp1 = sorted[0];
    setup.tp2 = sorted[1] ?? setup.tp1;
    setup.tp3 = sorted[2] ?? setup.tp2;
    log(`TPs → plan targets ${prev} → ${setup.tp1}/${setup.tp2}/${setup.tp3}`);
  }

  setup.planZone = { low: zone.zone_low, high: zone.zone_high, rationale: zone.rationale, trigger: zone.trigger };
}
