/**
 * cfs_backtest.mjs — generic Chart Fanatics Strategies backtester.
 *
 * Same engine discipline as cf_backtest.mjs / orb_backtest.mjs (cTrader deep
 * history via getTrendbars, outcomes in R, SL-first on straddle bars, cost =
 * spread + 2×slipFrac×ATR, OOS split, basket aggregate) but with pluggable
 * strategy detectors so each playbook in strategies/chart_fanatics/ can be
 * ported once and ranked on identical terms.
 *
 * A detector module (scripts/trading/cfs/<name>.mjs) exports:
 *   meta     — { name, defaultTf, note }
 *   configs  — array of config objects (must carry a unique .name)
 *   signals(bars, atr, cfg) -> [{ i, dir:'long'|'short', entry, stop, tp, label }]
 *     • must be CAUSAL: a signal at index i may only use bars[0..i]
 *     • entry is assumed filled at bars[i].c (market on close of signal bar)
 *
 * Usage (on VM, env sourced):
 *   set -a && . /home/ubuntu/.ctrader.env && set +a
 *   node scripts/trading/cfs_backtest.mjs --strat=marco_liquidity --tf=H1 --years=3
 *   node scripts/trading/cfs_backtest.mjs --strat=marco_liquidity --tf=H4 --years=5 --oos
 */
import { writeFileSync } from 'fs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const a = argv.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const STRAT = arg('strat', '');
const SYMS  = arg('sym', 'EURUSD,GBPUSD,USDJPY,GBPJPY,AUDJPY,XAUUSD,XAGUSD,XPTUSD,US30,NAS100,US500,BTCUSD,ETHUSD').split(',');
const TF    = arg('tf', 'H1');
const YEARS = parseFloat(arg('years', '3'));
const OUT   = arg('out', `/home/ubuntu/trading-data/cfs_${STRAT}_${TF}.json`);

const SPREADS = { XPTUSD: 0.80, XAUUSD: 0.30, XAGUSD: 0.03, XPDUSD: 1.50, WTI: 0.03,
                  NAS100: 1.5, USTEC: 1.5, US30: 3.0, US500: 0.5, SPX500: 0.5, GER40: 1.0,
                  JP225: 7.0, UK100: 1.0, AUS200: 1.5, BTCUSD: 15, ETHUSD: 1.2 };
const SLIP_FRAC = parseFloat(arg('slip', '0.02'));
const SPREAD_OVR = arg('spread', '');
const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] || 0; };

export function atr14(bars) {
  const n = bars.length, out = new Array(n).fill(null);
  let prevClose = null, atr = null; const len = 14;
  const trs = [];
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const tr = prevClose == null ? (b.h - b.l)
             : Math.max(b.h - b.l, Math.abs(b.h - prevClose), Math.abs(b.l - prevClose));
    prevClose = b.c;
    if (i < len) { trs.push(tr); if (i === len - 1) { atr = trs.reduce((a, c) => a + c, 0) / len; out[i] = atr; } }
    else { atr = (atr * (len - 1) + tr) / len; out[i] = atr; }
  }
  return out;
}

// ── Generic signal simulator: flat until exit, SL-first ──────────────────────
// Signal fields:
//   i, dir, stop, tp                       — required
//   entry                                  — market fill at bars[i].c (default)
//   limit, expiry                          — pending limit order instead: fills when
//                                            price trades through `limit` within
//                                            `expiry` bars (cancelled on SL-side
//                                            touch before fill, or on expiry)
//   beTrigger                              — optional: once a bar CLOSES past this
//                                            price, stop moves to entry (breakeven)
function simulate(bars, atr, sigs, cost) {
  const n = bars.length;
  const acc = { n: 0, w: 0, l: 0, grossWin: 0, grossLoss: 0, netR: 0, grossR: 0, costR: 0 };
  const trades = [];
  let nextFree = 0;
  for (const s of sigs) {
    if (s.i < nextFree || s.i >= n - 1) continue;
    const dir = s.dir;
    let entry = s.entry, fillIdx = s.i;

    if (s.limit != null) {                       // pending limit entry
      entry = null;
      const lastIdx = Math.min(n - 1, s.i + (s.expiry || 48));
      for (let k = s.i + 1; k <= lastIdx; k++) {
        const b = bars[k];
        const slTouch = dir === 'long' ? b.l <= s.stop : b.h >= s.stop;
        const fill = dir === 'long' ? b.l <= s.limit : b.h >= s.limit;
        if (fill) {                              // SL-first inside the fill bar too
          entry = s.limit; fillIdx = k;
          if (slTouch) {
            const risk0 = dir === 'long' ? entry - s.stop : s.stop - entry;
            if (risk0 > 0) { recordTrade(acc, trades, bars[k].t, dir, -1, (cost.spread + 2 * cost.slipFrac * (atr[k] || risk0)) / risk0, 0); nextFree = k + 1; }
            entry = null;
          }
          break;
        }
        if (slTouch) break;                      // ran to SL side without filling → cancel
      }
      if (entry == null) continue;               // cancelled / expired / filled-and-stopped
    }

    let stop = s.stop;
    const tp = s.tp;
    const risk = dir === 'long' ? entry - stop : stop - entry;
    if (!(risk > 0)) continue;
    let outR = null, exitIdx = n - 1;
    for (let k = fillIdx + 1; k < n; k++) {
      const b = bars[k];
      const hitSL = dir === 'long' ? b.l <= stop : b.h >= stop;
      const hitTP = tp != null && (dir === 'long' ? b.h >= tp : b.l <= tp);
      if (hitSL) { outR = (dir === 'long' ? (stop - entry) : (entry - stop)) / risk; exitIdx = k; break; }
      if (hitTP) { outR = (dir === 'long' ? (tp - entry) : (entry - tp)) / risk; exitIdx = k; break; }
      if (s.timeExit != null && k >= s.timeExit) { outR = (dir === 'long' ? (b.c - entry) : (entry - b.c)) / risk; exitIdx = k; break; }
      if (s.beTrigger != null && (dir === 'long' ? b.c >= s.beTrigger : b.c <= s.beTrigger)) stop = entry;
    }
    if (outR === null) { const last = bars[n - 1].c; outR = (dir === 'long' ? (last - entry) : (entry - last)) / risk; exitIdx = n - 1; }
    recordTrade(acc, trades, bars[fillIdx].t, dir, outR, (cost.spread + 2 * cost.slipFrac * (atr[fillIdx] || risk)) / risk, exitIdx - fillIdx);
    nextFree = exitIdx + 1;
  }
  return finalize(acc, trades);
}

function recordTrade(acc, trades, t, dir, grossR, costR, dur) {
  const net = grossR - costR;
  acc.n++; acc.grossR += grossR; acc.costR += costR; acc.netR += net;
  if (net > 0) { acc.w++; acc.grossWin += net; } else { acc.l++; acc.grossLoss += Math.abs(net); }
  trades.push({ t, dir, grossR, costR, netR: net, dur });
}
function statsFrom(trades) {
  const acc = { n: 0, w: 0, l: 0, grossWin: 0, grossLoss: 0, netR: 0, grossR: 0, costR: 0 };
  for (const t of trades) {
    acc.n++; acc.grossR += t.grossR; acc.costR += t.costR; acc.netR += t.netR;
    if (t.netR > 0) { acc.w++; acc.grossWin += t.netR; } else { acc.l++; acc.grossLoss += Math.abs(t.netR); }
  }
  return finalize(acc, trades);
}
function finalize(acc, trades) {
  const wr = acc.n ? Math.round(acc.w / acc.n * 1000) / 10 : 0;
  const pf = acc.grossLoss > 0 ? Math.round(acc.grossWin / acc.grossLoss * 100) / 100 : (acc.grossWin > 0 ? Infinity : 0);
  const expR      = acc.n ? Math.round(acc.netR / acc.n * 1000) / 1000 : 0;
  const grossExpR = acc.n ? Math.round(acc.grossR / acc.n * 1000) / 1000 : 0;
  const avgCostR  = acc.n ? Math.round(acc.costR / acc.n * 1000) / 1000 : 0;
  const netRs = trades.map(t => t.netR);
  const sorted = [...netRs].sort((x, y) => y - x);
  const top3 = sorted.slice(0, 3).reduce((s, x) => s + x, 0);
  const worst = Math.round(Math.min(0, ...netRs, 0) * 100) / 100;
  const netMinusTop3 = Math.round((acc.netR - top3) * 100) / 100;
  const avgDur = acc.n ? Math.round(trades.reduce((s, t) => s + t.dur, 0) / acc.n) : 0;
  let eq = 0, peak = 0, maxDD = 0;
  for (const r of netRs) { eq += r; if (eq > peak) peak = eq; const dd = peak - eq; if (dd > maxDD) maxDD = dd; }
  maxDD = Math.round(maxDD * 100) / 100;
  return { n: acc.n, w: acc.w, l: acc.l, wr, pf, netR: Math.round(acc.netR * 100) / 100, expR, grossExpR, avgCostR,
    grossWin: acc.grossWin, grossLoss: acc.grossLoss, netMinusTop3, worst, avgDur, maxDD, trades };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!STRAT) { console.error('Usage: node cfs_backtest.mjs --strat=<name> [--sym=..] [--tf=H1] [--years=3] [--oos]'); process.exit(1); }
  const mod = await import(`./cfs/${STRAT}.mjs`);
  const bridge = await import('./broker_ctrader.mjs');
  await bridge.connect();
  const fromMs = Date.now() - YEARS * 365 * 24 * 3600 * 1000;
  const windowDays = TF === 'H1' ? 20 : TF === 'M30' ? 12 : (TF === 'M15' || TF === 'M5') ? 8 : 60;
  const runConfigs = mod.configs;
  const OOS = argv.includes('--oos');

  console.log(`CFS backtest — ${mod.meta.name} (${STRAT})  TF=${TF} years=${YEARS}`);
  if (mod.meta.note) console.log(mod.meta.note);

  const agg = new Map();
  for (const c of runConfigs) agg.set(c.name, { n: 0, gw: 0, gl: 0, netR: 0, syms: 0, pos: 0 });
  const out = { ts: new Date().toISOString(), strat: STRAT, tf: TF, years: YEARS, perSymbol: {} };

  for (const sym of SYMS) {
    let bars;
    try { bars = await bridge.getTrendbars(sym, { period: TF, fromMs, windowDays }); }
    catch (e) { console.log(`\n${sym}: ERROR ${e.message}`); continue; }
    if (!bars || bars.length < 300) { console.log(`\n${sym}: only ${bars ? bars.length : 0} bars — skipped`); continue; }
    const span = `${new Date(bars[0].t).toISOString().slice(0, 10)}→${new Date(bars[bars.length - 1].t).toISOString().slice(0, 10)}`;
    const atr = atr14(bars);
    // Optional correlated aux series (e.g. SMT divergence pairs): meta.aux maps
    // symbol → its pair; aux bars are aligned by timestamp (null where missing).
    let ctx = null;
    if (mod.meta?.aux?.[sym]) {
      const auxSym = mod.meta.aux[sym];
      try {
        const auxBars = await bridge.getTrendbars(auxSym, { period: TF, fromMs, windowDays });
        const m = new Map((auxBars || []).map(x => [x.t, x]));
        ctx = { auxSym, aux: bars.map(x => m.get(x.t) || null) };
        console.log(`  (aux pair: ${auxSym}, ${auxBars.length} bars)`);
      } catch (e) { console.log(`  (aux ${mod.meta.aux[sym]} fetch failed: ${e.message} — skipping ${sym})`); continue; }
    }
    const spread = SPREAD_OVR ? parseFloat(SPREAD_OVR) : (SPREADS[sym] ?? median(bars.map(b => b.c)) * 0.00008);
    const cost = { spread, slipFrac: SLIP_FRAC };
    const yearsSpan = (bars[bars.length - 1].t - bars[0].t) / (365 * 24 * 3600 * 1000);
    console.log(`\n═══ ${sym} ${TF}  (${bars.length} bars, ${span})  spread=${spread} slip=${SLIP_FRAC}×ATR ═══`);
    const rows = [];
    if (OOS) {
      console.log('  config                        │  IN-SAMPLE (1st half)          │  OUT-OF-SAMPLE (2nd half)');
      console.log('                                │   n  WR%   PF    netR  n−t3   │   n  WR%   PF    netR  n−t3');
      for (const cfg of runConfigs) {
        const r = simulate(bars, atr, mod.signals(bars, atr, cfg, ctx), cost);
        const tsAll = r.trades.map(t => t.t).sort((a, b) => a - b);
        const split = tsAll[Math.floor(tsAll.length / 2)] || 0;
        const A = statsFrom(r.trades.filter(t => t.t < split));
        const B = statsFrom(r.trades.filter(t => t.t >= split));
        const fmt = x => `${String(x.n).padStart(4)} ${String(x.wr).padStart(4)} ${String(x.pf === Infinity ? 'inf' : x.pf).padStart(5)} ${String(x.netR).padStart(7)} ${String(x.netMinusTop3).padStart(5)}`;
        console.log(`  ${cfg.name.padEnd(29)} │ ${fmt(A)}  │ ${fmt(B)}`);
        rows.push({ cfg: cfg.name, inSample: { ...A, trades: undefined }, oos: { ...B, trades: undefined } });
      }
      out.perSymbol[sym] = { bars: bars.length, span, spread, oos: true, rows };
      continue;
    }
    console.log('  config                             n  /yr   WR%  netPF  netExpR    netR  maxDD  worst  net−top3');
    for (const cfg of runConfigs) {
      const r = simulate(bars, atr, mod.signals(bars, atr, cfg, ctx), cost);
      rows.push({ cfg: cfg.name, ...r, trades: undefined });
      const pf = r.pf === Infinity ? '  inf' : String(r.pf).padStart(5);
      const perYr = yearsSpan > 0 ? (r.n / yearsSpan).toFixed(1) : '  -';
      console.log(`  ${cfg.name.padEnd(33)} ${String(r.n).padStart(3)} ${String(perYr).padStart(4)}  ${String(r.wr).padStart(5)}  ${pf}   ${String(r.expR).padStart(6)}  ${String(r.netR).padStart(7)}  ${String(r.maxDD).padStart(5)}  ${String(r.worst).padStart(5)}  ${String(r.netMinusTop3).padStart(7)}`);
      const A = agg.get(cfg.name); A.n += r.n; A.gw += r.grossWin; A.gl += r.grossLoss; A.netR += r.netR; A.syms++; if (r.netR > 0) A.pos++;
    }
    out.perSymbol[sym] = { bars: bars.length, span, spread, slipFrac: SLIP_FRAC, rows };
  }

  if (!OOS) {
    console.log(`\n═══ BASKET AGGREGATE across ${Object.keys(out.perSymbol).length} instruments (${TF}, ${YEARS}y) ═══`);
    console.log('  config                             totalN   aggPF    aggNetR   +syms');
    const aggRows = [...agg.entries()].map(([name, a]) => ({
      name, n: a.n, pf: a.gl > 0 ? Math.round(a.gw / a.gl * 100) / 100 : (a.gw > 0 ? Infinity : 0),
      netR: Math.round(a.netR * 100) / 100, pos: a.pos, syms: a.syms,
    })).sort((x, y) => y.netR - x.netR);
    for (const r of aggRows) {
      const pf = r.pf === Infinity ? '  inf' : String(r.pf).padStart(5);
      console.log(`  ${r.name.padEnd(34)} ${String(r.n).padStart(4)}   ${pf}   ${String(r.netR).padStart(8)}   ${r.pos}/${r.syms}`);
    }
    out.aggregate = aggRows;
  }

  try { writeFileSync(OUT, JSON.stringify(out, null, 2)); console.log(`\nSnapshot → ${OUT}`); } catch (e) { /* dir may not exist locally */ }
  console.log('\nNote: R-multiples, SL-first, cost-adjusted. net−top3 = fragility (net R with 3 best trades removed).');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
