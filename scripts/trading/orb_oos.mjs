/**
 * orb_oos.mjs — Out-of-sample + fragility check for the ORB configs that
 * orb_backtest.mjs flagged as edges (Gold-Asia, NAS100-NY, etc.).
 *
 * Same ORB rules as orb_backtest.mjs (OR=30m after session open, entry=first
 * close beyond OR within 4h, SL=opposite boundary, TP=R×risk, hold→20:00 UTC),
 * but collects per-trade R WITH timestamps so we can:
 *   • split trades into IN-SAMPLE (1st half) vs OUT-OF-SAMPLE (2nd half),
 *   • report net-R with the 3 best trades removed (fragility),
 *   • A/B the with-trend (EMA200) filter.
 * A config is trustworthy only if it's positive in BOTH halves and survives
 * removing its top trades.
 *
 * Usage (VM, env sourced):
 *   node scripts/trading/orb_oos.mjs --tf=5 --days=180
 */
import { getTrendbars, connect } from './broker_ctrader.mjs';

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const TF = arg('tf', '5');
const DAYS = parseInt(arg('days', '180'));
const TF_PERIOD = { '1': 'M1', '5': 'M5', '15': 'M15', '30': 'M30', '60': 'H1' };

const OR_MIN = 30, BREAKOUT_H = 4, HOLD_UTC = 20;

// The configs orb_backtest.mjs surfaced as edges (Tradovate-tradable).
const CONFIGS = [
  { sym: 'XAUUSD', open: '00:00', R: 2, label: 'Gold  Asia  @2R' },
  { sym: 'NAS100', open: '13:30', R: 2, label: 'NAS100 NY   @2R' },
  { sym: 'US30',   open: '00:00', R: 2, label: 'US30  Asia  @2R' },
  { sym: 'SPX500', open: '07:00', R: 2, label: 'SPX500 Lon  @2R' },
  { sym: 'NAS100', open: '00:00', R: 1, label: 'NAS100 Asia @1R' },
];

const dayKey = ts => new Date(ts).toISOString().slice(0, 10);

// Simulate ORB for one instrument/session; returns per-trade [{t, r, trendOK}]
function orbTrades(rawBars, openUTC, R) {
  const tfMin = parseInt(TF, 10);
  const [oh, om] = openUTC.split(':').map(Number);
  const bars = rawBars.map(b => ({ ...b, t: b.t < 1e12 ? b.t * 1000 : b.t }));
  // EMA200 for with-trend
  const k = 2 / (200 + 1); let e = null;
  for (const b of [...bars].sort((a, c) => a.t - c.t)) { e = e == null ? b.c : b.c * k + e * (1 - k); b.ema = e; }

  const byDay = new Map();
  for (const b of bars) { const d = dayKey(b.t); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(b); }
  const minOrBars = Math.max(2, Math.floor(OR_MIN / tfMin) - 1);
  const trades = [];

  for (const [dk, dayBars] of byDay) {
    const d = new Date(dk + 'T00:00:00.000Z');
    const sStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), oh, om);
    const orEnd = sStart + OR_MIN * 60000;
    const boEnd = orEnd + BREAKOUT_H * 3600000;
    const holdEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), HOLD_UTC, 0);
    const orBars = dayBars.filter(b => b.t >= sStart && b.t < orEnd);
    if (orBars.length < minOrBars) continue;
    const orHigh = Math.max(...orBars.map(b => b.h)), orLow = Math.min(...orBars.map(b => b.l));
    if (!(orHigh > orLow)) continue;
    const post = dayBars.filter(b => b.t >= orEnd && b.t <= boEnd).sort((a, b) => a.t - b.t);
    let eb = null, dir = null;
    for (const b of post) { if (b.c > orHigh) { eb = b; dir = 'long'; break; } if (b.c < orLow) { eb = b; dir = 'short'; break; } }
    if (!eb) continue;
    const entry = eb.c, sl = dir === 'long' ? orLow : orHigh, risk = Math.abs(entry - sl);
    if (!(risk > 0)) continue;
    const tp = dir === 'long' ? entry + R * risk : entry - R * risk;
    const trendOK = eb.ema == null ? true : dir === 'long' ? entry > eb.ema : entry < eb.ema;
    const fwd = dayBars.filter(b => b.t > eb.t && b.t <= holdEnd).sort((a, b) => a.t - b.t);
    let r = null;
    for (const b of fwd) {
      const hitSL = dir === 'long' ? b.l <= sl : b.h >= sl;
      const hitTP = dir === 'long' ? b.h >= tp : b.l <= tp;
      if (hitSL) { r = -1; break; }
      if (hitTP) { r = R; break; }
    }
    if (r === null) { const last = fwd.length ? fwd[fwd.length - 1].c : entry; r = (dir === 'long' ? last - entry : entry - last) / risk; }
    trades.push({ t: eb.t, r, trendOK });
  }
  return trades;
}

function stats(trades) {
  const n = trades.length;
  if (!n) return { n: 0, wr: 0, pf: 0, expR: 0, netR: 0, top3: 0 };
  let w = 0, gw = 0, gl = 0, net = 0;
  for (const t of trades) { net += t.r; if (t.r > 0) { w++; gw += t.r; } else gl += Math.abs(t.r); }
  const sorted = trades.map(t => t.r).sort((a, b) => b - a);
  const top3 = sorted.slice(0, 3).reduce((s, x) => s + x, 0);
  return {
    n, wr: +(w / n * 100).toFixed(1), pf: gl > 0 ? +(gw / gl).toFixed(2) : (gw > 0 ? Infinity : 0),
    expR: +(net / n).toFixed(3), netR: +net.toFixed(2), netMinusTop3: +(net - top3).toFixed(2),
  };
}
const row = s => `n=${String(s.n).padStart(3)} WR=${String(s.wr).padStart(4)}% PF=${String(s.pf === Infinity ? 'inf' : s.pf).padStart(4)} expR=${String(s.expR).padStart(6)} netR=${String(s.netR).padStart(7)} n−t3=${String(s.netMinusTop3 ?? '-').padStart(7)}`;

async function main() {
  await connect();
  const fromMs = Date.now() - DAYS * 86400000;
  const period = TF_PERIOD[TF] || 'M5';
  console.log(`\n═══ ORB OUT-OF-SAMPLE + FRAGILITY  (${TF}m, ${DAYS}d, ${period}) ═══`);
  console.log('Trustworthy = positive in BOTH halves AND survives removing top-3 trades.\n');

  const cache = {};
  for (const c of CONFIGS) {
    if (!cache[c.sym]) { try { cache[c.sym] = await getTrendbars(c.sym, { period, fromMs, windowDays: 5 }); } catch (e) { cache[c.sym] = null; console.log(`${c.label}: fetch ERROR ${e.message}`); } }
    const bars = cache[c.sym];
    if (!bars || bars.length < 500) { console.log(`${c.label}: only ${bars ? bars.length : 0} bars`); continue; }
    const all = orbTrades(bars, c.open, c.R);
    if (!all.length) { console.log(`${c.label}: no trades`); continue; }
    const ts = all.map(t => t.t).sort((a, b) => a - b);
    const split = ts[Math.floor(ts.length / 2)];
    const IS = all.filter(t => t.t < split), OOS = all.filter(t => t.t >= split);
    const wt = all.filter(t => t.trendOK);
    console.log(`■ ${c.label}   (split ~${dayKey(split)})`);
    console.log(`   FULL       ${row(stats(all))}`);
    console.log(`   IN-SAMPLE  ${row(stats(IS))}`);
    console.log(`   OUT-SAMPLE ${row(stats(OOS))}`);
    console.log(`   +TREND     ${row(stats(wt))}`);
    const isP = stats(IS).netR > 0, oosP = stats(OOS).netR > 0, robust = stats(all).netMinusTop3 > 0;
    console.log(`   → ${isP && oosP ? '✅ positive both halves' : '🔴 fails a half'} ; ${robust ? '✅ survives top-3 removal' : '🔴 carried by top-3'}\n`);
  }
  process.exit(0);
}
main().catch(e => { console.error('FATAL:', e.stack); process.exit(1); });
