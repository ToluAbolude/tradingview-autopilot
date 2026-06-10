/**
 * validate_quad_stoch.mjs — Standalone edge test for the new Q vote (Quad-Stochastic
 * "Super Signal", John Kurisko). Does NOT touch setup_finder.mjs or live trading.
 *
 * Pulls real cTrader M15 history for a liquid basket, finds every 4/4 quad-rotation
 * super-signal, and replays each forward with the live conventions:
 *   - entry = signal-bar close
 *   - SL    = 1.5×ATR(14)   (scanner baseline)
 *   - TP    = 2R            (scanner's ≥2:1 enforcement)
 *   - SL-first when a bar spans both (conservative, matches edge_replay.mjs)
 *   - force-close (mark-to-market in R) at 20:00 UTC EOD of the entry day
 *   - no overlapping trades per symbol+dir (skip to the exit bar before re-arming)
 *
 * To isolate whether the *quad* requirement adds edge, it runs two comparators over
 * the SAME entry/exit machinery: a single fast-stoch trigger (1/1) and an RSI(14)
 * extreme turn. If Q doesn't beat these, the extra stochastics aren't earning their keep.
 *
 * Usage (on VM):
 *   cd /home/ubuntu/tradingview-mcp-jackson
 *   set -a; . /home/ubuntu/.ctrader_env; set +a; export BROKER_PROVIDER=ctrader
 *   node scripts/trading/validate_quad_stoch.mjs [--days 90]
 */
import os from 'os';
import { getTrendbars } from './broker_ctrader.mjs';

const args = process.argv.slice(2);
const DAYS = (() => { const i = args.indexOf('--days'); return i >= 0 ? parseFloat(args[i + 1]) : 90; })();
const EOD_HOUR = 20;            // UTC, matches eod_close
const ATR_LEN = 14;
const SL_ATR = 1.5;            // scanner baseline SL
const TP_R   = 2.0;            // scanner ≥2R enforcement

const SYMBOLS = ['XAUUSD','XAGUSD','NAS100','US30','SPX500','EURUSD','GBPUSD','USDJPY','BTCUSD','ETHUSD'];

// ── indicators (copied verbatim from setup_finder.mjs) ──
function calcATR(bars, len = 14) {
  const atr = [];
  for (let i = 0; i < bars.length; i++) {
    const tr = i === 0 ? bars[i].h - bars[i].l
      : Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i-1].c), Math.abs(bars[i].l - bars[i-1].c));
    atr.push(i < len ? tr : (atr[i-1] * (len-1) + tr) / len);
  }
  return atr;
}
function calcRSI(bars, len = 14) {
  let ag = 0, al = 0;
  const rsi = new Array(bars.length).fill(50);
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].c - bars[i-1].c;
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= len) { ag += g/len; al += l/len; }
    else { ag = (ag*(len-1)+g)/len; al = (al*(len-1)+l)/len; }
    if (i >= len) rsi[i] = al === 0 ? 100 : 100 - 100/(1 + ag/al);
  }
  return rsi;
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

// Pre-compute the 4 stochastics once per symbol (perf).
function precompute(bars) {
  const defs = [
    { kLen: 9,  dLen: 3,  slow: 1  },
    { kLen: 14, dLen: 3,  slow: 1  },
    { kLen: 40, dLen: 4,  slow: 1  },
    { kLen: 60, dLen: 3,  slow: 10 },
  ];
  return { stochs: defs.map(s => calcStoch(bars, s.kLen, s.dLen, s.slow)), rsi: calcRSI(bars), atr: calcATR(bars, ATR_LEN) };
}

// ── signal detectors (return 'long' | 'short' | null at bar i) ──
function quadFire(pc, i, dir) {                 // Q — 4/4 rotation out of extreme
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
function singleFire(pc, i, dir) {               // comparator: just the fast stoch trigger (1/1)
  if (i < 1) return false;
  const { k, d } = pc.stochs[0];
  const fast = k.slice(Math.max(0, i-4), i+1);
  if (dir === 'long')  return k[i] > k[i-1] && k[i] >= d[i] && Math.min(...fast) < 25;
  return k[i] < k[i-1] && k[i] <= d[i] && Math.max(...fast) > 75;
}
function rsiFire(pc, i, dir) {                   // comparator: RSI(14) extreme turn
  if (i < 1) return false;
  const r = pc.rsi.slice(Math.max(0, i-4), i+1);
  if (dir === 'long')  return pc.rsi[i] > pc.rsi[i-1] && Math.min(...r) < 30;
  return pc.rsi[i] < pc.rsi[i-1] && Math.max(...r) > 70;
}

function sessionOf(tMs) {
  const h = new Date(tMs).getUTCHours();
  if (h >= 0 && h < 8)  return 'ASIAN';
  if (h >= 8 && h < 13) return 'LONDON';
  if (h >= 13 && h < 17) return 'OVERLAP';
  if (h >= 17 && h < 22) return 'NY';
  return 'DEAD';
}
function eodCutoff(tMs) {
  const d = new Date(tMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), EOD_HOUR, 0, 0);
}

// Replay one trade forward. Returns { R, kind, exitIdx }.
function replay(bars, atr, i, dir) {
  const entry = bars[i].c;
  const risk  = SL_ATR * atr[i];
  if (!(risk > 0)) return null;
  const sl = dir === 'long' ? entry - risk : entry + risk;
  const tp = dir === 'long' ? entry + risk * TP_R : entry - risk * TP_R;
  const horizon = Math.max(eodCutoff(bars[i].t), bars[i].t + 3600e3);
  for (let j = i + 1; j < bars.length; j++) {
    const b = bars[j];
    if (b.t > horizon) {                                  // EOD force-close at prior close
      const mtm = (dir === 'long' ? bars[j-1].c - entry : entry - bars[j-1].c) / risk;
      return { R: mtm, kind: 'eod', exitIdx: j - 1 };
    }
    if (dir === 'long') {
      if (b.l <= sl) return { R: -1, kind: 'sl', exitIdx: j };
      if (b.h >= tp) return { R: TP_R, kind: 'tp', exitIdx: j };
    } else {
      if (b.h >= sl) return { R: -1, kind: 'sl', exitIdx: j };
      if (b.l <= tp) return { R: TP_R, kind: 'tp', exitIdx: j };
    }
  }
  return null; // ran off the end — discard (open)
}

// Run one detector over a symbol's bars, no overlapping trades per dir.
function runDetector(bars, pc, fireFn, warmup) {
  const trades = [];
  for (const dir of ['long', 'short']) {
    let i = warmup;
    while (i < bars.length - 1) {
      if (fireFn(pc, i, dir)) {
        const r = replay(bars, pc.atr, i, dir);
        if (r) { trades.push({ dir, R: r.R, kind: r.kind, session: sessionOf(bars[i].t), t: bars[i].t }); i = r.exitIdx + 1; continue; }
      }
      i++;
    }
  }
  return trades;
}

function stats(trades) {
  const n = trades.length;
  if (!n) return null;
  const wins = trades.filter(t => t.R > 0), losses = trades.filter(t => t.R <= 0);
  const gw = wins.reduce((s, t) => s + t.R, 0), gl = Math.abs(losses.reduce((s, t) => s + t.R, 0));
  const totalR = trades.reduce((s, t) => s + t.R, 0);
  return { n, wr: wins.length / n, avgR: totalR / n, totalR, pf: gl > 0 ? gw / gl : Infinity, tpRate: trades.filter(t => t.kind === 'tp').length / n };
}
function fmt(s) {
  if (!s) return 'n=0';
  const pf = s.pf === Infinity ? '∞' : s.pf.toFixed(2);
  return `n=${String(s.n).padStart(4)}  WR=${(s.wr*100).toFixed(0).padStart(3)}%  exp=${s.avgR>=0?'+':''}${s.avgR.toFixed(3)}R  totalR=${s.totalR>=0?'+':''}${s.totalR.toFixed(1)}  PF=${pf}  TP%=${(s.tpRate*100).toFixed(0)}`;
}
function groupBy(trades, keyFn) {
  const m = new Map();
  for (const t of trades) { const k = keyFn(t); if (!m.has(k)) m.set(k, []); m.get(k).push(t); }
  return [...m.entries()].map(([k, ts]) => [k, stats(ts)]).sort((a,b)=>b[1].avgR-a[1].avgR);
}

async function main() {
  const toMs = Date.now();
  const fromMs = toMs - DAYS * 24 * 3600e3;
  console.log(`=== Quad-Stochastic (Q) edge validation — real cTrader M15, last ${DAYS}d ===`);
  console.log(`SL=${SL_ATR}×ATR  TP=${TP_R}R  EOD=20:00 UTC  SL-first  basket=${SYMBOLS.join(',')}\n`);

  const qAll = [], singleAll = [], rsiAll = [];
  for (const sym of SYMBOLS) {
    let bars = null;
    try { bars = await getTrendbars(sym, { period: 'M15', fromMs, toMs, windowDays: 5 }); }
    catch (e) { console.log(`  ✗ ${sym.padEnd(8)} — ${e.message}`); continue; }
    if (!bars || bars.length < 120) { console.log(`  ✗ ${sym.padEnd(8)} — only ${bars?.length||0} bars`); continue; }
    const pc = precompute(bars);
    const warmup = 70;
    const q = runDetector(bars, pc, quadFire,   warmup);
    const s = runDetector(bars, pc, singleFire, warmup);
    const r = runDetector(bars, pc, rsiFire,    warmup);
    qAll.push(...q); singleAll.push(...s); rsiAll.push(...r);
    const qs = stats(q);
    console.log(`  ✓ ${sym.padEnd(8)} ${String(bars.length).padStart(5)} bars  |  Q: ${qs ? fmt(qs) : 'n=0'}`);
  }

  console.log('\n=== HEADLINE: does the quad-rotation requirement add edge? ===');
  console.log('  Q (4/4 quad super)   ' + fmt(stats(qAll)));
  console.log('  single fast-stoch    ' + fmt(stats(singleAll)));
  console.log('  RSI(14) extreme      ' + fmt(stats(rsiAll)));

  console.log('\n=== Q BY DIRECTION ===');
  for (const [k, s] of groupBy(qAll, t => t.dir)) console.log(`  ${k.padEnd(8)} ${fmt(s)}`);
  console.log('\n=== Q BY SESSION ===');
  for (const [k, s] of groupBy(qAll, t => t.session)) console.log(`  ${k.padEnd(8)} ${fmt(s)}`);

  const q = stats(qAll), sg = stats(singleAll);
  console.log('\n=== VERDICT ===');
  if (!q || q.n < 20) console.log('  ⚠ Too few Q signals to conclude — widen basket or days.');
  else {
    const beatsSingle = sg ? (q.avgR > sg.avgR) : true;
    console.log(`  Q expectancy ${q.avgR>=0?'POSITIVE':'NEGATIVE'} (${q.avgR.toFixed(3)}R/trade, PF ${q.pf===Infinity?'∞':q.pf.toFixed(2)}) over n=${q.n}.`);
    console.log(`  Quad filter ${beatsSingle ? 'BEATS' : 'does NOT beat'} the single fast-stoch baseline (${q.avgR.toFixed(3)}R vs ${sg?sg.avgR.toFixed(3):'n/a'}R).`);
    console.log(`  → ${q.avgR > 0 && beatsSingle ? 'Q adds edge — recommend arming.' : 'Q does not clearly add edge — do NOT arm as-is.'}`);
  }
  console.log('\nNote: optimistic upper bound (no spread/commission/slippage). A losing bucket here is damning.');
  process.exit(0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
