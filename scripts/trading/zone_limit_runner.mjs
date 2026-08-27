/**
 * zone_limit_runner.mjs — rests the DAILY PLAN's entry zones as live limit orders.
 *
 * This is the plan's execution arm (operator directive 2026-08-27). Until now the
 * plan could only ever VETO: daily_plan_gate.mjs refuses entries that aren't at a
 * planned level, but nothing in the system ever ORIGINATED from the plan, so a
 * morning full of validated zones produced no trades unless the momentum scanner
 * independently fired on the same instrument at the same price. It rarely did —
 * plan zones are reversion levels ("sweep-and-reclaim of the low", "range top"),
 * where momentum confluence is absent by construction.
 *
 * Causality is now thesis -> level -> RESTING ORDER -> fill:
 *   • PLACE : for each tradeable zone in today's plan, rest a limit at the zone
 *             MIDPOINT — the price the plan costed its own rr_to_t1 at — with the
 *             plan's invalidation as SL and its first target as TP, and only while
 *             price is still OUTSIDE the zone. If price is already in it, that's a
 *             market entry and inline_trader's job, not ours. Zones that cannot pay
 *             CFG.minR from that entry are refused rather than rested.
 *   • CANCEL: the plan rolled to a new day, the zone left the plan, the
 *             invalidation was breached, price ran beyond reachATR, a position is
 *             already open on the symbol, or we're inside the pre-EOD cutoff.
 *
 * This runner previously derived its own pivot S&R zones and ran DRY-RUN — it
 * logged 27 would-rest limits/day and placed none. Both are gone: the zones come
 * from the plan, and --live places real orders.
 *
 * Every placement still funnels through broker_ctrader.assertOrderSafety, which
 * re-checks the plan gate (entry must be at a planned level, in the planned
 * direction, inside the 07:00-10:00 / 12:30-16:00 UTC origination windows), the
 * SL sanity floors, the lot caps and the anti-stack rule. A limit placed inside a
 * window may legitimately fill later at its planned level.
 *
 * Usage (VM): node scripts/trading/zone_limit_runner.mjs   [--live]
 */
import { getTrendbars, connect, placeOrder, cancelOrder, getOpenVolumeForSymbol, getEquity } from './broker_ctrader.mjs';
import { loadPlan } from './daily_plan_gate.mjs';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const LIVE  = process.argv.includes('--live');
const STATE = '/home/ubuntu/trading-data/zone_limit_state.json';
const LOG   = '/home/ubuntu/trading-data/zone_limit_runner.log';
const PARAMS_FILE = '/home/ubuntu/trading-data/trading_params.json';

const CFG = {
  reachATR:   3,     // don't rest at a level price cannot plausibly reach today
  minDistATR: 0.15,  // ... and not so close it's really a market order
  maxTotal:   6,     // ceiling on simultaneous resting limits
  buf:        0.5,   // ATR buffer for the fallback SL when the plan has no invalidation
  R:          2,     // fallback TP multiple when the plan has no usable target
  minR:       2,     // 1:2 floor — the RR the strategy is specified at
  eodCutoffUTC: 19,  // stop resting orders before the 20:00 EOD flatten
};
const TF = 'H1';

function log(m) { const line = `[${new Date().toISOString()}] ${m}`; process.stdout.write(line + '\n'); }
const load = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return { orders: {} }; } };
const save = s => writeFileSync(STATE, JSON.stringify(s, null, 2));
const rnd  = (x, p) => Math.round(x * p) / p;
const prec = px => px > 1000 ? 100 : px > 10 ? 1000 : 100000;

function params() {
  try { return JSON.parse(readFileSync(PARAMS_FILE, 'utf8')); } catch { return {}; }
}

function atr14(bars){ const o=new Array(bars.length).fill(null); let pc=null,a=null; const t=[];
  for(let i=0;i<bars.length;i++){ const b=bars[i]; const tr=pc==null?b.h-b.l:Math.max(b.h-b.l,Math.abs(b.h-pc),Math.abs(b.l-pc)); pc=b.c;
    if(i<14){t.push(tr); if(i===13){a=t.reduce((s,x)=>s+x,0)/14;o[i]=a;}} else {a=(a*13+tr)/14;o[i]=a;} } return o; }

function calcLots(sym, riskPct, equity, entry, sl){ const MIN=0.01,STEP=0.01,MAX=10; const riskAmt=equity*riskPct/100, slDist=Math.abs(entry-sl); if(slDist<=0)return MIN;
  const s=sym.toUpperCase(), q=l=>Math.min(Math.max(Math.floor(l/STEP)*STEP,MIN),MAX);
  if(/XAU|GOLD/.test(s)) return q(riskAmt/(100*slDist));
  if(/US30|NAS100|SPX500|GER|UK100|JP225|AUS200|DOW/.test(s)) return q(riskAmt/slDist);
  if(/BTC|ETH|SOL|ADA|XRP|LTC|BNB/.test(s)) return q(riskAmt/slDist);
  if(/JPY/.test(s)) return q(riskAmt/(6.5*(slDist/0.01)));
  return q(riskAmt/(10*(slDist/0.0001))); }

/**
 * Today's tradeable plan zones, flattened to one record per (symbol, direction).
 * Mirrors daily_plan_gate.checkPlan's filters so this runner can never rest an
 * order the gate would then reject at the broker.
 */
export function planZones(plan) {
  const today = new Date().toISOString().slice(0, 10);
  if (!plan || plan.date !== today) return { stale: true, zones: [] };
  const zones = [];
  for (const inst of plan.instruments || []) {
    if (inst.bias === 'no-view') continue;
    for (const z of inst.entry_zones || []) {
      if (!z.tradeable || z.role === 'fade-at-target') continue;
      if (!Number.isFinite(z.zone_low) || !Number.isFinite(z.zone_high)) continue;
      zones.push({ sym: inst.symbol, dir: z.direction, lo: Math.min(z.zone_low, z.zone_high), hi: Math.max(z.zone_low, z.zone_high),
                   invalidation: z.invalidation, targets: z.targets || [], rr: z.rr_to_t1 });
    }
  }
  return { stale: false, zones };
}

/**
 * Turn one plan zone + live price into a restable order, or a reason not to.
 * Pure — no broker, no clock — so the money math is testable (test_zone_limit_plan.mjs).
 * Returns { skip: '<reason>' } or { entry, sl, tp, lots, risk, distATR, slFromPlan, tpFromPlan }.
 */
export function decideOrder(z, px, a, equity, riskPct) {
  if (!(a > 0)) return { skip: 'no ATR' };
  const p = prec(px);

  // Rest at the zone MIDPOINT, and only from outside the zone.
  //
  // The midpoint is not a preference, it is the price the plan itself costed: for
  // XAUUSD 4585-4602 (invalidation 4571, target 4643) the plan records rr_to_t1
  // 2.2, which reproduces at the midpoint and nowhere else — the near edge is 1.3R
  // and the far edge 4.1R. Resting at the edge price touches first would silently
  // fill every trade at ~60% of the R the plan validated, under the 1:2 floor the
  // whole strategy is specified around, while the plan's paperwork still claimed 2.2.
  const entry = (z.lo + z.hi) / 2;
  const dist  = z.dir === 'long' ? px - entry : entry - px;
  if (dist <= 0)                  return { skip: `price ${rnd(px,p)} already at/through zone ${z.lo}-${z.hi} (market entry, not ours)` };
  if (dist < CFG.minDistATR * a)  return { skip: `only ${rnd(dist/a,100)}·ATR away, too close to rest` };
  if (dist > CFG.reachATR  * a)   return { skip: `${rnd(dist/a,100)}·ATR away, out of reach today` };

  // SL: the plan's structural invalidation. Fall back to the far zone edge only if
  // the plan didn't give a usable one (must be the correct side of entry).
  // `sl > 0` is load-bearing, not defensive noise: Number(null) and Number('') are
  // both 0, which is finite and passes "below entry" for a long. Without it a plan
  // zone with a null invalidation ships a live order with its stop at zero.
  let sl = Number(z.invalidation), slFromPlan = true;
  if (!Number.isFinite(sl) || sl <= 0 || (z.dir === 'long' ? sl >= entry : sl <= entry)) {
    sl = z.dir === 'long' ? z.lo - CFG.buf * a : z.hi + CFG.buf * a;
    slFromPlan = false;
  }
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return { skip: 'zero risk distance' };

  // TP: the plan's first target on the correct side of entry, else an R multiple.
  let tp = (z.targets || []).map(Number).find(t => Number.isFinite(t) && t > 0 && (z.dir === 'long' ? t > entry : t < entry));
  const tpFromPlan = Number.isFinite(tp);
  if (!tpFromPlan) tp = z.dir === 'long' ? entry + CFG.R * risk : entry - CFG.R * risk;

  // The strategy is specified at 1:2 minimum. A zone whose geometry cannot pay that
  // from the entry we will actually get does not rest — better no trade than a trade
  // the edge was never measured at.
  const R = Math.abs(tp - entry) / risk;
  if (R < CFG.minR) return { skip: `only ${rnd(R,100)}R to target (floor ${CFG.minR}R)` };

  return { entry: rnd(entry,p), sl: rnd(sl,p), tp: rnd(tp,p), risk, R,
           lots: calcLots(z.sym, riskPct, equity, entry, sl),
           distATR: rnd(dist/a,100), slFromPlan, tpFromPlan };
}

async function main(){
  await connect();
  const state = load(); if (!state.orders) state.orders = {};
  const today = new Date().toISOString().slice(0, 10);
  const utcHour = new Date().getUTCHours();

  let equity = 10000; try { const e = await getEquity(); equity = e.equity || e.balance || equity; } catch {}
  const P = params();
  const riskPct = Array.isArray(P.riskPct) ? P.riskPct[0] : (P.riskPct ?? 1);

  const { stale, zones } = planZones(loadPlan());
  log(`═══ ZONE-LIMIT RUNNER (${LIVE ? 'LIVE' : 'DRY-RUN'}) equity ${rnd(equity,100)} risk ${riskPct}% ═══`);
  if (stale) log(`  plan is missing or not dated ${today} — no new orders; cancelling any that remain`);
  log(`  ${zones.length} tradeable plan zone(s): ${zones.map(z => `${z.sym} ${z.dir}`).join(', ') || 'none'}`);

  // Symbols we need market data for: everything planned plus everything resting.
  const syms = [...new Set([...zones.map(z => z.sym), ...Object.values(state.orders).map(o => o.sym)])];
  const openVol = {}, bars = {};
  for (const s of syms) {
    try { openVol[s] = await getOpenVolumeForSymbol(s).catch(() => 0); } catch { openVol[s] = 0; }
    try { bars[s] = await getTrendbars(s, { period: TF, fromMs: Date.now() - 60 * 86400000, windowDays: 20 }); } catch { bars[s] = null; }
  }

  // ── 1. CANCEL pass ──
  for (const [key, o] of Object.entries(state.orders)) {
    const b = bars[o.sym];
    const px = b && b.length ? b[b.length - 1].c : null;
    const a  = b && b.length ? (atr14(b).slice(-1)[0] || 0) : 0;

    const gone      = stale || !zones.some(z => z.sym === o.sym && z.dir === o.dir && z.lo === o.zoneLo && z.hi === o.zoneHi);
    const dayRolled = o.planDate !== today;
    const invalid   = px != null && Number.isFinite(o.sl) && (o.dir === 'long' ? px < o.sl : px > o.sl);
    const far       = px != null && a > 0 && Math.abs(px - o.entry) > CFG.reachATR * a;
    const hasPos    = (openVol[o.sym] || 0) > 0;
    const preEod    = utcHour >= CFG.eodCutoffUTC;

    if (gone || dayRolled || invalid || far || hasPos || preEod) {
      const why = dayRolled ? 'plan-rolled' : gone ? 'zone-left-plan' : invalid ? 'invalidation-breached'
                : far ? 'price-ran-away' : hasPos ? 'position-open' : 'pre-EOD-cutoff';
      log(`  CANCEL ${o.sym} ${o.dir} LIMIT @${o.entry} (${why})`);
      if (LIVE && o.orderId) { try { await cancelOrder(o.orderId); } catch (e) { log(`   cancel err ${e.message}`); } }
      delete state.orders[key];
    }
  }

  // ── 2. PLACE pass ──
  let total = Object.keys(state.orders).length;
  if (utcHour >= CFG.eodCutoffUTC) {
    log(`  past ${CFG.eodCutoffUTC}:00 UTC — not resting new orders into the EOD flatten`);
  } else {
    for (const z of zones) {
      if (total >= CFG.maxTotal) break;
      const key = `${z.sym}:${z.dir}`;
      if (state.orders[key]) continue;                    // already resting for this symbol+dir
      if ((openVol[z.sym] || 0) > 0) continue;            // anti-stack
      const b = bars[z.sym]; if (!b || b.length < 30) { log(`  SKIP ${z.sym} — no bars`); continue; }
      const a = atr14(b).slice(-1)[0] || 0, px = b[b.length - 1].c;

      const d = decideOrder(z, px, a, equity, riskPct);
      if (d.skip) { log(`  SKIP ${z.sym} ${z.dir} — ${d.skip}`); continue; }
      if (!d.slFromPlan) log(`  ${z.sym} ${z.dir}: plan invalidation unusable (${z.invalidation}) — fell back to zone edge ${d.sl}`);
      if (!d.tpFromPlan) log(`  ${z.sym} ${z.dir}: no usable plan target — fell back to ${CFG.R}R`);

      const rec = { sym: z.sym, dir: z.dir, zoneLo: z.lo, zoneHi: z.hi, entry: d.entry, sl: d.sl, tp: d.tp,
                    lots: d.lots, planDate: today, placedTs: Date.now(), orderId: null };
      const lots = d.lots;
      log(`  PLACE ${z.sym} ${z.dir.toUpperCase()} LIMIT @${rec.entry} SL ${rec.sl} TP ${rec.tp} ${lots}lots  (${d.distATR}·ATR away, ${rnd(Math.abs(d.tp-d.entry)/d.risk,10)}R)`);
      if (LIVE) {
        try {
          const res = await placeOrder({ symbol: z.sym, direction: z.dir, units: lots, tpPrice: rec.tp, slPrice: rec.sl, limitPrice: rec.entry });
          rec.orderId = Number(res?.order?.orderId) || null;
          log(`   placed orderId=${rec.orderId}`);
        } catch (e) { log(`   place REJECTED: ${e.message}`); continue; }
      }
      state.orders[key] = rec; total++;
    }
  }
  save(state);
  log(`═══ done: ${total} resting limit(s) (${LIVE ? 'LIVE' : 'dry-run'}) ═══`);
  process.exit(0);
}
// Run only when invoked directly — importing this module (the test does) must not
// connect to the broker or place anything.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(e => { log(`FATAL: ${e.stack}`); process.exit(1); });
}
