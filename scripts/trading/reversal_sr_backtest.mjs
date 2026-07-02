/**
 * reversal_sr_backtest.mjs — For S&R BOUNCE/REVERSAL setups (buy at support, sell
 * at resistance), does a LIMIT resting AT the zone beat a MARKET entry on the
 * confirmation candle? This is the case the user expects limit to help: you know
 * the area of interest, so rest an order there.
 *
 *   LIMIT  : rest at the zone edge; fills when price dips into the zone (entry =
 *            zone edge → tighter stop, better R:R). Takes EVERY touch, incl. the
 *            ones that break through (no confirmation filter).
 *   MARKET : wait for a confirmation candle (closes back out of the zone, with-
 *            body) within N bars; enter at its close (worse price, wider stop) —
 *            but the confirmation FILTERS OUT zones that just break.
 * Both: SL = beyond the zone ± buffer·ATR, TP = R × risk, walk fwd → outcome in R.
 *
 * Wick-to-body zones = support_resistance_zones.pine method. Outcomes in R so the
 * tighter-stop advantage of the limit is captured fairly.
 *
 * Usage (VM): node scripts/trading/reversal_sr_backtest.mjs --tf=H1 --years=3
 */
import { getTrendbars, connect } from './broker_ctrader.mjs';

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const TF = arg('tf', 'H1'), YEARS = parseFloat(arg('years', '3'));
const P = { pivLen: 5, maxZones: 8, buf: 0.5, R: 2, confBars: 6, tfMinBuf: 0 };
const SYMS = arg('sym', 'XAUUSD,EURUSD,GBPJPY,US30,NAS100,USDJPY').split(',');
// Cost model (same as cf_backtest): round-trip = spread + 2×slip·ATR, in R.
const SPREADS = { XAUUSD: 0.30, XAGUSD: 0.03, XPTUSD: 0.80, NAS100: 1.5, US30: 3.0, SPX500: 0.5, GER40: 1.0, JP225: 7.0 };
const SLIP = parseFloat(arg('slip', '0.02'));
const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] || 0; };

function atr14(bars) {
  const out = new Array(bars.length).fill(null); let pc = null, a = null; const trs = [];
  for (let i = 0; i < bars.length; i++) { const b = bars[i];
    const tr = pc == null ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)); pc = b.c;
    if (i < 14) { trs.push(tr); if (i === 13) { a = trs.reduce((s, x) => s + x, 0) / 14; out[i] = a; } }
    else { a = (a * 13 + tr) / 14; out[i] = a; } }
  return out;
}
// pivot at center c=i-len confirmed at bar i (strict)
function piv(bars, i, len, hi) {
  const c = i - len; if (c < len) return null; const cv = hi ? bars[c].h : bars[c].l;
  for (let k = 1; k <= len; k++) { if (hi ? !(cv > bars[c - k].h && cv > bars[c + k].h) : !(cv < bars[c - k].l && cv < bars[c + k].l)) return null; }
  return { c, cv };
}

function simulate(bars, spread) {
  const n = bars.length, atr = atr14(bars);
  const sup = [], res = [];   // {lo, hi, broken, used}
  const O = i => bars[i].o, C = i => bars[i].c, H = i => bars[i].h, L = i => bars[i].l;
  const mkt = [], lim = [];
  let touches = 0, mktFills = 0;
  // record a trade net of cost (round-trip spread + slippage, in R)
  const rec = (arr, ei, dir, entry, sl, tp, a) => {
    const o = walk(bars, ei, dir, entry, sl, tp); const risk = Math.abs(entry - sl);
    const costR = (spread + 2 * SLIP * a) / risk;
    arr.push({ t: bars[ei].t, entry, sl, tp, gross: o.r, r: o.r - costR });
  };

  for (let i = 0; i < n; i++) {
    const a = atr[i] || 0;
    // add zones on pivot confirmation
    const pl = piv(bars, i, P.pivLen, false);
    if (pl) { const lo = pl.cv; let hi = null, best = null;
      for (let k = 0; k <= P.pivLen; k++) { const bb = Math.min(O(i - k), C(i - k)); const d = bb - lo; if (d >= 0 && (best == null || d < best)) { best = d; hi = bb; } }
      if (hi == null) hi = Math.min(O(i - P.pivLen), C(i - P.pivLen));
      if (!sup.some(z => lo >= z.lo && lo <= z.hi)) { sup.unshift({ lo, hi, broken: false, used: false }); if (sup.length > P.maxZones) sup.pop(); } }
    const ph = piv(bars, i, P.pivLen, true);
    if (ph) { const hi = ph.cv; let lo = null, best = null;
      for (let k = 0; k <= P.pivLen; k++) { const bt = Math.max(O(i - k), C(i - k)); const d = hi - bt; if (d >= 0 && (best == null || d < best)) { best = d; lo = bt; } }
      if (lo == null) lo = Math.max(O(i - P.pivLen), C(i - P.pivLen));
      if (!res.some(z => hi >= z.lo && hi <= z.hi)) { res.unshift({ lo, hi, broken: false, used: false }); if (res.length > P.maxZones) res.pop(); } }
    // broken flags
    for (const z of sup) if (!z.broken && Math.max(O(i), C(i)) < z.lo) z.broken = true;
    for (const z of res) if (!z.broken && Math.min(O(i), C(i)) > z.hi) z.broken = true;

    // ── SUPPORT touch → long ──
    for (const z of sup) {
      if (z.broken || z.used) continue;
      if (L(i) <= z.hi && L(i) >= z.lo - 0.25 * a && (i === 0 || L(i - 1) > z.hi)) {   // first dip into the zone
        z.used = true; touches++;
        const sl = z.lo - P.buf * a;
        // LIMIT: fill at zone top
        const le = z.hi, lr = le - sl; if (lr > 0) rec(lim, i, 'long', le, sl, le + P.R * lr, a);
        // MARKET: confirmation candle within confBars (bullish close back above zone)
        let j = -1; for (let k = i; k <= Math.min(i + P.confBars, n - 1); k++) { if (C(k) > z.hi && C(k) > O(k)) { j = k; break; } }
        if (j >= 0) { const me = C(j), mr = me - sl; if (mr > 0) { mktFills++; rec(mkt, j, 'long', me, sl, me + P.R * mr, a); } }
      }
    }
    // ── RESISTANCE touch → short ──
    for (const z of res) {
      if (z.broken || z.used) continue;
      if (H(i) >= z.lo && H(i) <= z.hi + 0.25 * a && (i === 0 || H(i - 1) < z.lo)) {
        z.used = true; touches++;
        const sl = z.hi + P.buf * a;
        const le = z.lo, lr = sl - le; if (lr > 0) rec(lim, i, 'short', le, sl, le - P.R * lr, a);
        let j = -1; for (let k = i; k <= Math.min(i + P.confBars, n - 1); k++) { if (C(k) < z.lo && C(k) < O(k)) { j = k; break; } }
        if (j >= 0) { const me = C(j), mr = sl - me; if (mr > 0) { mktFills++; rec(mkt, j, 'short', me, sl, me - P.R * mr, a); } }
      }
    }
  }
  return { mkt, lim, touches, mktFills };
}

function walk(bars, ei, dir, entry, sl, tp) {
  const risk = Math.abs(entry - sl);
  for (let k = ei + 1; k < bars.length && k <= ei + 400; k++) {
    const b = bars[k];
    const hitSL = dir === 'long' ? b.l <= sl : b.h >= sl;
    const hitTP = dir === 'long' ? b.h >= tp : b.l <= tp;
    if (hitSL) return { r: -1 };
    if (hitTP) return { r: (dir === 'long' ? (tp - entry) : (entry - tp)) / risk };
  }
  const last = bars[Math.min(ei + 400, bars.length - 1)].c;
  return { r: (dir === 'long' ? (last - entry) : (entry - last)) / risk };
}
function stat(t) { const n = t.length; if (!n) return { n: 0, wr: 0, expR: 0, netR: 0, pf: 0 };
  let w = 0, net = 0, gw = 0, gl = 0; for (const x of t) { net += x.r; if (x.r > 0) { w++; gw += x.r; } else gl += Math.abs(x.r); }
  return { n, wr: +(w / n * 100).toFixed(1), expR: +(net / n).toFixed(3), netR: +net.toFixed(1), pf: gl > 0 ? +(gw / gl).toFixed(2) : 0 }; }

async function main() {
  await connect();
  const fromMs = Date.now() - YEARS * 365 * 86400000;
  console.log(`\n═══ S&R BOUNCE: LIMIT (at zone) vs MARKET (on confirmation) — ${TF}, ${YEARS}y, R=${P.R} ═══\n`);
  console.log('  sym       touches | MARKET n/WR/PF/expR/netR        | LIMIT n/WR/PF/expR/netR');
  let AL = [], AM = [];
  for (const s of SYMS) {
    let bars; try { bars = await getTrendbars(s, { period: TF, fromMs, windowDays: TF === 'H1' ? 20 : 60 }); } catch (e) { console.log(`  ${s}: ${e.message}`); continue; }
    if (!bars || bars.length < 500) { console.log(`  ${s}: thin`); continue; }
    const spread = SPREADS[s] ?? median(bars.map(b => b.c)) * 0.00008;
    const r = simulate(bars, spread); const m = stat(r.mkt), l = stat(r.lim);
    AL = AL.concat(r.lim); AM = AM.concat(r.mkt);
    const fmt = x => `n=${String(x.n).padStart(3)} WR=${String(x.wr).padStart(4)} PF=${String(x.pf).padStart(4)} exp=${String(x.expR).padStart(6)} net=${String(x.netR).padStart(7)}`;
    console.log(`  ${s.padEnd(8)} ${String(r.touches).padStart(4)}    | ${fmt(m)} | ${fmt(l)}`);
  }
  const am = stat(AM), al = stat(AL);
  console.log(`\n  AGGREGATE (net of spread+slip):`);
  console.log(`    MARKET: n=${am.n} WR=${am.wr}% PF=${am.pf} expR=${am.expR} netR=${am.netR}`);
  console.log(`    LIMIT : n=${al.n} WR=${al.wr}% PF=${al.pf} expR=${al.expR} netR=${al.netR}`);
  // ── OUT-OF-SAMPLE temporal split (does the LIMIT edge hold in both halves?) ──
  const splitT = median(AL.map(t => t.t));
  const day = t => new Date(t).toISOString().slice(0, 10);
  const lIS = stat(AL.filter(t => t.t < splitT)), lOOS = stat(AL.filter(t => t.t >= splitT));
  const mIS = stat(AM.filter(t => t.t < splitT)), mOOS = stat(AM.filter(t => t.t >= splitT));
  console.log(`\n  OUT-OF-SAMPLE split @ ~${day(splitT)} (net):`);
  console.log(`    LIMIT  IN-SAMPLE  n=${lIS.n} PF=${lIS.pf} expR=${lIS.expR} netR=${lIS.netR}`);
  console.log(`    LIMIT  OUT-SAMPLE n=${lOOS.n} PF=${lOOS.pf} expR=${lOOS.expR} netR=${lOOS.netR}  ${lIS.netR > 0 && lOOS.netR > 0 ? '✅ positive BOTH halves' : '🔴 fails a half'}`);
  console.log(`    MARKET IN/OUT     PF ${mIS.pf}/${mOOS.pf}  expR ${mIS.expR}/${mOOS.expR}`);
  console.log(`\n  Verdict: LIMIT ${al.expR > am.expR && al.expR > 0 ? 'wins net-of-cost' : 'does NOT beat market net'} (${al.expR} vs ${am.expR}); robust=${lIS.netR > 0 && lOOS.netR > 0}.`);
  process.exit(0);
}
main().catch(e => { console.error('FATAL:', e.stack); process.exit(1); });
