/**
 * validate_quad_stoch_v2.mjs — Conditioned variants of the Quad-Stochastic signal.
 *
 * v1 proved the raw 4/4 rotation is a coin-flip-minus-costs (-0.022R). Kurisko does
 * NOT trade it naked — he trades it relative to VWAP, with-trend (his "bull flag" is
 * a continuation), and as stochastic DIVERGENCE. This script adds those filters and
 * compares expectancy across a variant ladder, on the SAME replay machinery as v1
 * (1.5×ATR SL, 2R TP, SL-first, 20:00 EOD close, no overlapping trades per dir).
 *
 * Variants:
 *   Q              raw 4/4 quad rotation (v1 baseline)
 *   Q+trend        + EMA50/200 with-trend gate
 *   Q+vwap         + price on the trend side of daily-anchored VWAP
 *   Q+trend+vwap   full conditioned rotation
 *   DIV            stochastic divergence (price LL / stoch HL for longs; mirror)
 *   DIV+trend+vwap full conditioned divergence
 *
 * Usage (on VM):
 *   cd /home/ubuntu/tradingview-mcp-jackson
 *   set -a; . /home/ubuntu/.ctrader_env; set +a; export BROKER_PROVIDER=ctrader
 *   node scripts/trading/validate_quad_stoch_v2.mjs [--days 90]
 */
import { getTrendbars } from './broker_ctrader.mjs';

const args = process.argv.slice(2);
const DAYS = (() => { const i = args.indexOf('--days'); return i >= 0 ? parseFloat(args[i + 1]) : 90; })();
const EOD_HOUR = 20, ATR_LEN = 14, SL_ATR = 1.5, TP_R = 2.0;
const SYMBOLS = ['XAUUSD','XAGUSD','NAS100','US30','SPX500','EURUSD','GBPUSD','USDJPY','BTCUSD','ETHUSD'];

function calcATR(bars, len = 14) {
  const atr = [];
  for (let i = 0; i < bars.length; i++) {
    const tr = i === 0 ? bars[i].h - bars[i].l
      : Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i-1].c), Math.abs(bars[i].l - bars[i-1].c));
    atr.push(i < len ? tr : (atr[i-1] * (len-1) + tr) / len);
  }
  return atr;
}
function calcEMA(bars, len) {
  const k = 2 / (len + 1); const ema = [];
  for (let i = 0; i < bars.length; i++) ema.push(i === 0 ? bars[i].c : bars[i].c * k + ema[i-1] * (1-k));
  return ema;
}
function calcStoch(bars, kLen, dLen = 3, slow = 1) {
  const kRaw = new Array(bars.length).fill(50);
  for (let i = 0; i < bars.length; i++) {
    const start = Math.max(0, i - kLen + 1);
    let hh = -Infinity, ll = Infinity;
    for (let j = start; j <= i; j++) { if (bars[j].h > hh) hh = bars[j].h; if (bars[j].l < ll) ll = bars[j].l; }
    kRaw[i] = hh === ll ? 50 : (100 * (bars[i].c - ll)) / (hh - ll);
  }
  const smaAt = (arr, len, i) => { const s = Math.max(0, i - len + 1); let sum = 0, c = 0; for (let j = s; j <= i; j++) { sum += arr[j]; c++; } return c ? sum / c : 50; };
  const k = kRaw.map((_, i) => (slow > 1 ? smaAt(kRaw, slow, i) : kRaw[i]));
  const d = k.map((_, i) => smaAt(k, dLen, i));
  return { k, d };
}
// Daily-anchored VWAP (resets each UTC day). cTrader volume is tick volume — fine as a filter weight.
function calcVWAP(bars) {
  const vwap = new Array(bars.length).fill(null);
  let cumPV = 0, cumV = 0, curDay = null;
  for (let i = 0; i < bars.length; i++) {
    const day = Math.floor(bars[i].t / 86400000);
    if (day !== curDay) { cumPV = 0; cumV = 0; curDay = day; }
    const tp = (bars[i].h + bars[i].l + bars[i].c) / 3, vol = bars[i].v || 1;
    cumPV += tp * vol; cumV += vol;
    vwap[i] = cumV > 0 ? cumPV / cumV : bars[i].c;
  }
  return vwap;
}

function precompute(bars) {
  const defs = [{ kLen:9,dLen:3,slow:1 },{ kLen:14,dLen:3,slow:1 },{ kLen:40,dLen:4,slow:1 },{ kLen:60,dLen:3,slow:10 }];
  return {
    stochs: defs.map(s => calcStoch(bars, s.kLen, s.dLen, s.slow)),
    atr: calcATR(bars, ATR_LEN), ema50: calcEMA(bars, 50), ema200: calcEMA(bars, 200), vwap: calcVWAP(bars),
  };
}

// ── base signals (bars, pc, i, dir) ──
function quadFire(bars, pc, i, dir) {
  if (i < 1) return false;
  let aligned = 0;
  for (const { k, d } of pc.stochs) {
    if (dir === 'long'  && k[i] > k[i-1] && k[i] >= d[i]) aligned++;
    if (dir === 'short' && k[i] < k[i-1] && k[i] <= d[i]) aligned++;
  }
  const fast = pc.stochs[0].k.slice(Math.max(0, i-4), i+1);
  const triggered = dir === 'long' ? Math.min(...fast) < 25 : Math.max(...fast) > 75;
  return triggered && aligned >= 4;
}
function divFire(bars, pc, i, dir) {       // stochastic divergence on the 14,3 stoch
  if (i < 30) return false;
  const k = pc.stochs[1].k;
  let idx = -1;
  if (dir === 'long') {
    let lo = Infinity; for (let j = i-25; j <= i-5; j++) if (bars[j].l < lo) { lo = bars[j].l; idx = j; }
    if (idx < 0) return false;
    return bars[i].l < lo && k[i] > k[idx] && k[i] > k[i-1] && k[idx] < 30;   // price LL, stoch HL, turning up, from oversold
  } else {
    let hi = -Infinity; for (let j = i-25; j <= i-5; j++) if (bars[j].h > hi) { hi = bars[j].h; idx = j; }
    if (idx < 0) return false;
    return bars[i].h > hi && k[i] < k[idx] && k[i] < k[i-1] && k[idx] > 70;   // price HH, stoch LH, turning down, from overbought
  }
}
// ── filters ──
function trendOK(bars, pc, i, dir) {
  const up = pc.ema50[i] > pc.ema200[i] && bars[i].c > pc.ema50[i];
  const dn = pc.ema50[i] < pc.ema200[i] && bars[i].c < pc.ema50[i];
  return dir === 'long' ? up : dn;
}
function vwapOK(bars, pc, i, dir) {
  return dir === 'long' ? bars[i].c >= pc.vwap[i] : bars[i].c <= pc.vwap[i];
}
const all = (...fns) => (bars, pc, i, dir) => fns.every(f => f(bars, pc, i, dir));

function sessionOf(t) { const h = new Date(t).getUTCHours(); if (h<8) return 'ASIAN'; if (h<13) return 'LONDON'; if (h<17) return 'OVERLAP'; if (h<22) return 'NY'; return 'DEAD'; }
function eodCutoff(t) { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), EOD_HOUR, 0, 0); }

function replay(bars, atr, i, dir) {
  const entry = bars[i].c, risk = SL_ATR * atr[i];
  if (!(risk > 0)) return null;
  const sl = dir === 'long' ? entry - risk : entry + risk;
  const tp = dir === 'long' ? entry + risk*TP_R : entry - risk*TP_R;
  const horizon = Math.max(eodCutoff(bars[i].t), bars[i].t + 3600e3);
  for (let j = i+1; j < bars.length; j++) {
    const b = bars[j];
    if (b.t > horizon) { const mtm = (dir==='long'? bars[j-1].c-entry : entry-bars[j-1].c)/risk; return { R: mtm, kind:'eod', exitIdx: j-1 }; }
    if (dir === 'long') { if (b.l <= sl) return { R:-1, kind:'sl', exitIdx:j }; if (b.h >= tp) return { R:TP_R, kind:'tp', exitIdx:j }; }
    else                { if (b.h >= sl) return { R:-1, kind:'sl', exitIdx:j }; if (b.l <= tp) return { R:TP_R, kind:'tp', exitIdx:j }; }
  }
  return null;
}
function runDetector(bars, pc, fireFn, warmup) {
  const trades = [];
  for (const dir of ['long','short']) {
    let i = warmup;
    while (i < bars.length - 1) {
      if (fireFn(bars, pc, i, dir)) { const r = replay(bars, pc.atr, i, dir); if (r) { trades.push({ dir, R:r.R, kind:r.kind, session:sessionOf(bars[i].t) }); i = r.exitIdx + 1; continue; } }
      i++;
    }
  }
  return trades;
}
function stats(trades) {
  const n = trades.length; if (!n) return null;
  const wins = trades.filter(t=>t.R>0), losses = trades.filter(t=>t.R<=0);
  const gw = wins.reduce((s,t)=>s+t.R,0), gl = Math.abs(losses.reduce((s,t)=>s+t.R,0)), totalR = trades.reduce((s,t)=>s+t.R,0);
  return { n, wr: wins.length/n, avgR: totalR/n, totalR, pf: gl>0?gw/gl:Infinity, tpRate: trades.filter(t=>t.kind==='tp').length/n };
}
function fmt(s) { if (!s) return 'n=0'; const pf = s.pf===Infinity?'∞':s.pf.toFixed(2); return `n=${String(s.n).padStart(4)}  WR=${(s.wr*100).toFixed(0).padStart(3)}%  exp=${s.avgR>=0?'+':''}${s.avgR.toFixed(3)}R  totalR=${s.totalR>=0?'+':''}${s.totalR.toFixed(1)}  PF=${pf}  TP%=${(s.tpRate*100).toFixed(0)}`; }

async function main() {
  const toMs = Date.now(), fromMs = toMs - DAYS*24*3600e3;
  console.log(`=== Quad-Stochastic CONDITIONED variants — real cTrader M15, last ${DAYS}d ===`);
  console.log(`SL=${SL_ATR}×ATR  TP=${TP_R}R  EOD=20:00 UTC  SL-first  basket=${SYMBOLS.join(',')}\n`);

  const variants = {
    'Q (raw)':        quadFire,
    'Q+trend':        all(quadFire, trendOK),
    'Q+vwap':         all(quadFire, vwapOK),
    'Q+trend+vwap':   all(quadFire, trendOK, vwapOK),
    'DIV (raw)':      divFire,
    'DIV+trend+vwap': all(divFire, trendOK, vwapOK),
  };
  const agg = Object.fromEntries(Object.keys(variants).map(k => [k, []]));

  for (const sym of SYMBOLS) {
    let bars = null;
    try { bars = await getTrendbars(sym, { period:'M15', fromMs, toMs, windowDays:5 }); }
    catch (e) { console.log(`  ✗ ${sym} — ${e.message}`); continue; }
    if (!bars || bars.length < 250) { console.log(`  ✗ ${sym} — only ${bars?.length||0} bars`); continue; }
    const pc = precompute(bars);
    for (const [name, fn] of Object.entries(variants)) agg[name].push(...runDetector(bars, pc, fn, 210));
    console.log(`  ✓ ${sym.padEnd(8)} ${String(bars.length).padStart(5)} bars`);
  }

  console.log('\n=== VARIANT LADDER (best-conditioned should rise to the top) ===');
  const rows = Object.entries(agg).map(([k, t]) => [k, stats(t)]).sort((a,b) => (b[1]?.avgR ?? -9) - (a[1]?.avgR ?? -9));
  for (const [k, s] of rows) console.log(`  ${k.padEnd(16)} ${fmt(s)}`);

  // session breakdown for the strongest conditioned variant
  const best = rows.find(([k]) => k === 'Q+trend+vwap');
  if (best && best[1]) {
    console.log('\n=== Q+trend+vwap BY SESSION ===');
    const t = agg['Q+trend+vwap']; const m = new Map();
    for (const x of t) { if (!m.has(x.session)) m.set(x.session, []); m.get(x.session).push(x); }
    for (const [k, ts] of [...m.entries()].map(([k,ts])=>[k,ts]).sort()) console.log(`  ${k.padEnd(8)} ${fmt(stats(ts))}`);
  }

  console.log('\n=== VERDICT ===');
  const ranked = rows.filter(([,s]) => s && s.n >= 40);
  const top = ranked[0];
  if (!top) console.log('  ⚠ No variant has n>=40 — too selective on this window.');
  else {
    const [name, s] = top;
    const positive = s.avgR > 0 && s.pf > 1.0;
    console.log(`  Best variant with n>=40: ${name} → ${fmt(s)}`);
    console.log(`  ${positive ? 'POSITIVE on optimistic basis' : 'still not positive'} — ${positive ? 'candidate, but PF must clear ~1.2+ to survive costs.' : 'do NOT arm.'}`);
  }
  console.log('\nNote: optimistic upper bound (no spread/commission/slippage). Need PF≳1.2 to expect net-positive live.');
  process.exit(0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
