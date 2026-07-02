/**
 * fib_backtest.mjs — Does Fibonacci retracement depth distinguish a RETRACEMENT
 * (trend continues) from a REVERSAL (structure breaks)? And if so, is resting a
 * LIMIT order at a fib level of an impulse leg a positive-expectancy entry?
 *
 * Motivation: the operator wants proactive limit orders at pre-known levels
 * instead of waiting for confirmation. zone_limit_runner covers S&R zones
 * (reversal_sr_backtest edge); this tests the TREND-PULLBACK variant.
 *
 * Method (per symbol, both directions):
 *   • Impulse leg = last pivot low L → confirmed pivot high H (fractal len 5),
 *     leg ≥ minLeg×ATR14, 5–100 bars, H = max high and L = min low of the leg.
 *   • From the confirmation bar, track the pullback until price either makes a
 *     NEW EXTREME beyond H (continuation) or CLOSES beyond L (reversal), or
 *     150 bars pass (timeout). Record max retrace depth (H−minLow)/(H−L).
 *   • PART A: for each fib threshold, of the legs whose pullback REACHED that
 *     depth (i.e. a limit there would have filled), how many still continued?
 *   • PART B: simulate buy/sell LIMITS at 38.2/50/61.8 with SL below the leg
 *     origin (or below 78.6 tight variant), TP back at H or 2R. SL-first on
 *     spanning bars; costs = spread + 2×slip×ATR converted to R (cf_backtest).
 *   • PART C benchmark: after a ≥38.2 pullback, market entry on first close
 *     beyond H (the "wait for the break" rule), SL at pullback low, TP 2R.
 *
 * Usage (VM, env sourced):
 *   set -a && . /home/ubuntu/.ctrader.env && set +a
 *   node scripts/trading/fib_backtest.mjs --days=730 --tf=H1
 */
import { writeFileSync } from 'fs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const a = argv.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const SYMS   = arg('sym', 'GER40,NAS100,US30,XAUUSD,BTCUSD,ETHUSD,GBPJPY,EURUSD').split(',');
const TF     = arg('tf', 'H1');
const DAYS   = parseInt(arg('days', '730'), 10);
const OUT    = arg('out', '/home/ubuntu/trading-data/fib_backtest.json');
const PIV    = 5;                                   // fractal pivot length
const MINLEG = parseFloat(arg('minleg', '3'));      // leg size ≥ this × ATR14
const MAXTRACK = 150;                               // bars to resolve, else timeout
const FIBS   = [0.236, 0.382, 0.5, 0.618, 0.786, 1.0];
const ENTRY_FIBS = [0.382, 0.5, 0.618];

// round-trip cost = spread + 2×(slipFrac×ATR), in price units (cf_backtest model)
const SPREADS = { XAUUSD: 0.30, NAS100: 1.5, US30: 3.0, SPX500: 0.5, GER40: 1.0,
                  BTCUSD: 15, ETHUSD: 0.8 };
const SLIP_FRAC = parseFloat(arg('slip', '0.02'));
const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] || 0; };

function atr14(bars) {
  const o = new Array(bars.length).fill(null); let pc = null, a = null; const t = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const tr = pc == null ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    pc = b.c;
    if (i < 14) { t.push(tr); if (i === 13) { a = t.reduce((s, x) => s + x, 0) / 14; o[i] = a; } }
    else { a = (a * 13 + tr) / 14; o[i] = a; }
  }
  return o;
}
// fractal pivot confirmed at bar i, centred at i-PIV
function pivotAt(bars, i, hi) {
  const c = i - PIV; if (c < PIV) return null;
  const cv = hi ? bars[c].h : bars[c].l;
  for (let k = 1; k <= PIV; k++) {
    if (hi ? !(cv > bars[c - k].h && cv > bars[c + k].h) : !(cv < bars[c - k].l && cv < bars[c + k].l)) return null;
  }
  return { idx: c, px: cv };
}

// ── PASS 1: find impulse legs + resolve each pullback ────────────────────────
// dir=+1: up-leg L→H, pullback down, continuation = high > H, reversal = close < L
function findEvents(bars, atr) {
  const events = [];
  let lastLo = null, lastHi = null;
  let active = null;                     // one tracked pullback at a time
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];

    if (active) {
      const e = active;
      if (e.dir > 0) { e.minRe = Math.min(e.minRe, b.l); } else { e.minRe = Math.max(e.minRe, b.h); }
      e.depth = e.dir > 0 ? (e.H - e.minRe) / (e.H - e.L) : (e.minRe - e.H) / (e.L - e.H); // H=extreme, L=origin
      const cont = e.dir > 0 ? b.h > e.H : b.l < e.H;
      const rev  = e.dir > 0 ? b.c < e.L : b.c > e.L;
      if (cont || rev || i - e.startIdx >= MAXTRACK) {
        e.outcome = cont ? 'continuation' : rev ? 'reversal' : 'timeout';
        e.endIdx = i;
        events.push(e); active = null;
      }
    }

    const ph = pivotAt(bars, i, true), pl = pivotAt(bars, i, false);
    if (pl) lastLo = pl;
    if (ph) lastHi = ph;
    if (active) continue;

    // up-leg: pivot high just confirmed, leg from the last pivot low before it
    if (ph && lastLo && lastLo.idx < ph.idx) {
      const L = lastLo.px, H = ph.px, a = atr[ph.idx];
      const lenOk = ph.idx - lastLo.idx >= PIV && ph.idx - lastLo.idx <= 100;
      let integr = true;
      for (let k = lastLo.idx; k <= ph.idx; k++) { if (bars[k].h > H || bars[k].l < L) { integr = false; break; } }
      if (a && H - L >= MINLEG * a && lenOk && integr) {
        active = { dir: +1, L, H, Lidx: lastLo.idx, Hidx: ph.idx, startIdx: i, atr: a,
                   t: bars[i].t, minRe: Math.min(...bars.slice(ph.idx + 1, i + 1).map(x => x.l), H), depth: 0 };
        continue;
      }
    }
    // down-leg: mirror (origin = last pivot high, extreme = pivot low)
    if (pl && lastHi && lastHi.idx < pl.idx) {
      const L = lastHi.px, H = pl.px, a = atr[pl.idx];   // L=origin(high), H=extreme(low)
      const lenOk = pl.idx - lastHi.idx >= PIV && pl.idx - lastHi.idx <= 100;
      let integr = true;
      for (let k = lastHi.idx; k <= pl.idx; k++) { if (bars[k].l < H || bars[k].h > L) { integr = false; break; } }
      if (a && L - H >= MINLEG * a && lenOk && integr) {
        active = { dir: -1, L, H, Lidx: lastHi.idx, Hidx: pl.idx, startIdx: i, atr: a,
                   t: bars[i].t, minRe: Math.max(...bars.slice(pl.idx + 1, i + 1).map(x => x.h), H), depth: 0 };
      }
    }
  }
  return events;
}

// ── trade walker: conservative, SL first on spanning bars ────────────────────
function walk(bars, fromIdx, dir, entry, sl, tp) {
  for (let i = fromIdx; i < Math.min(bars.length, fromIdx + MAXTRACK); i++) {
    const b = bars[i];
    const hitSL = dir > 0 ? b.l <= sl : b.h >= sl;
    const hitTP = dir > 0 ? b.h >= tp : b.l <= tp;
    if (hitSL) return { exit: sl, i };                       // SL-first when both
    if (hitTP) return { exit: tp, i };
  }
  const last = bars[Math.min(bars.length, fromIdx + MAXTRACK) - 1];
  return { exit: last.c, i: null };                           // timeout at close
}

// ── PART B/C simulation over the events of one symbol ────────────────────────
function simulate(bars, events, cost) {
  const rows = [];   // {cfg, r, t}
  for (const e of events) {
    const span = e.dir > 0 ? e.H - e.L : e.L - e.H;
    const lvl = f => e.dir > 0 ? e.H - f * span : e.H + f * span;

    // limit fills: scan from confirmation bar to event end (+ trade walks beyond)
    for (const F of ENTRY_FIBS) {
      const level = lvl(F);
      let fill = null;
      for (let i = e.startIdx; i <= e.endIdx; i++) {
        const b = bars[i];
        if (e.dir > 0 ? b.l <= level : b.h >= level) { fill = i; break; }
      }
      if (fill == null) continue;
      const b0 = bars[fill];
      const entry = e.dir > 0 ? Math.min(level, b0.o) : Math.max(level, b0.o);
      for (const slMode of ['origin', 'fib79']) {
        const sl = slMode === 'origin'
          ? (e.dir > 0 ? e.L - 0.5 * e.atr : e.L + 0.5 * e.atr)
          : (e.dir > 0 ? lvl(0.786) - 0.25 * e.atr : lvl(0.786) + 0.25 * e.atr);
        const risk = Math.abs(entry - sl);
        if (!(risk > 0)) continue;
        for (const tpMode of ['priorH', '2R']) {
          const tp = tpMode === 'priorH'
            ? e.H
            : (e.dir > 0 ? entry + 2 * risk : entry - 2 * risk);
          if (e.dir > 0 ? tp <= entry : tp >= entry) continue;
          const w = walk(bars, fill, e.dir, entry, sl, tp);
          const grossR = (e.dir > 0 ? w.exit - entry : entry - w.exit) / risk;
          const costR = (cost.spread + 2 * cost.slipFrac * e.atr) / risk;
          rows.push({ cfg: `limit@${F} SL:${slMode} TP:${tpMode}`, r: grossR - costR, t: bars[fill].t });
        }
      }
    }

    // benchmark: ≥38.2 pullback then first close beyond H → market, SL pullback low, TP 2R
    const l382 = lvl(0.382);
    let touched = false, eb = null, pullExt = e.dir > 0 ? Infinity : -Infinity;
    for (let i = e.startIdx; i <= Math.min(bars.length - 1, e.startIdx + MAXTRACK); i++) {
      const b = bars[i];
      if (e.dir > 0 ? b.l <= l382 : b.h >= l382) touched = true;
      if (touched) pullExt = e.dir > 0 ? Math.min(pullExt, b.l) : Math.max(pullExt, b.h);
      if (e.dir > 0 ? b.c < e.L : b.c > e.L) break;                    // reversed first
      if (touched && (e.dir > 0 ? b.c > e.H : b.c < e.H)) { eb = i; break; }
    }
    if (eb != null) {
      const entry = bars[eb].c;
      const sl = e.dir > 0 ? pullExt - 0.5 * e.atr : pullExt + 0.5 * e.atr;
      const risk = Math.abs(entry - sl);
      if (risk > 0) {
        const tp = e.dir > 0 ? entry + 2 * risk : entry - 2 * risk;
        const w = walk(bars, eb + 1, e.dir, entry, sl, tp);
        const grossR = (e.dir > 0 ? w.exit - entry : entry - w.exit) / risk;
        const costR = (cost.spread + 2 * cost.slipFrac * e.atr) / risk;
        rows.push({ cfg: 'BENCH breakout after ≥38.2', r: grossR - costR, t: bars[eb].t });
      }
    }
  }
  return rows;
}

const fmt = (x, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d);

(async () => {
  const bridge = await import('./broker_ctrader.mjs');
  await bridge.connect();
  const fromMs = Date.now() - DAYS * 24 * 3600 * 1000;
  const windowDays = TF === 'H1' ? 20 : TF === 'M15' ? 8 : 60;

  const allEvents = [];             // {sym, dir, depth, outcome}
  const cfgAgg = new Map();         // cfg -> {n,w,gw,gl,net}
  const out = { ts: new Date().toISOString(), tf: TF, days: DAYS, minleg: MINLEG, perSymbol: {} };

  for (const sym of SYMS) {
    let bars;
    try { bars = await bridge.getTrendbars(sym, { period: TF, fromMs, windowDays }); }
    catch (e) { console.log(`${sym}: ERROR ${e.message}`); continue; }
    if (!bars || bars.length < 300) { console.log(`${sym}: only ${bars ? bars.length : 0} bars — skipped`); continue; }
    bars = bars.map(b => ({ ...b, t: b.t < 1e12 ? b.t * 1000 : b.t }));
    const atr = atr14(bars);
    const events = findEvents(bars, atr);
    const spread = SPREADS[sym] ?? median(bars.map(b => b.c)) * 0.00008;
    const rows = simulate(bars, events, { spread, slipFrac: SLIP_FRAC });
    for (const e of events) allEvents.push({ sym, dir: e.dir, depth: e.depth, outcome: e.outcome });
    for (const r of rows) {
      if (!cfgAgg.has(r.cfg)) cfgAgg.set(r.cfg, { n: 0, w: 0, gw: 0, gl: 0, net: 0 });
      const a = cfgAgg.get(r.cfg);
      a.n++; a.net += r.r; if (r.r > 0) { a.w++; a.gw += r.r; } else a.gl += -r.r;
    }
    out.perSymbol[sym] = { bars: bars.length, events: events.length,
      span: `${new Date(bars[0].t).toISOString().slice(0, 10)}→${new Date(bars[bars.length - 1].t).toISOString().slice(0, 10)}` };
    console.log(`${sym}: ${bars.length} bars, ${events.length} legs (${out.perSymbol[sym].span})`);
  }

  // ── PART A: depth → outcome discrimination ─────────────────────────────────
  const resolved = allEvents.filter(e => e.outcome !== 'timeout');
  console.log(`\n═══ PART A — pullback depth vs outcome  (${allEvents.length} legs, ${resolved.length} resolved) ═══`);
  console.log('depth reached   fills   continued   reversed   P(continue|filled)');
  out.depthTable = [];
  for (const f of FIBS) {
    const filled = resolved.filter(e => e.depth >= f);
    const cont = filled.filter(e => e.outcome === 'continuation').length;
    const rev = filled.length - cont;
    const p = filled.length ? cont / filled.length : 0;
    out.depthTable.push({ fib: f, filled: filled.length, cont, rev, pCont: p });
    console.log(`  ≥ ${(f * 100).toFixed(1).padStart(5)}%   ${String(filled.length).padStart(5)}   ${String(cont).padStart(6)}      ${String(rev).padStart(5)}       ${(p * 100).toFixed(1)}%`);
  }
  const depths = o => resolved.filter(e => e.outcome === o).map(e => e.depth);
  const md = a => a.length ? median(a) : NaN;
  console.log(`median max-depth: continuations ${(md(depths('continuation')) * 100).toFixed(0)}%  reversals ${(md(depths('reversal')) * 100).toFixed(0)}%`);

  // ── PART B/C: config table ──────────────────────────────────────────────────
  console.log(`\n═══ PART B — limit-at-fib trades, net of costs (all symbols) ═══`);
  console.log('config                          n     WR      expR     netR     PF');
  out.configs = [];
  const rowsOut = [...cfgAgg.entries()].map(([cfg, a]) => ({
    cfg, n: a.n, wr: a.n ? a.w / a.n : 0, exp: a.n ? a.net / a.n : 0, net: a.net,
    pf: a.gl > 0 ? a.gw / a.gl : Infinity,
  })).sort((x, y) => y.exp - x.exp);
  for (const r of rowsOut) {
    out.configs.push(r);
    console.log(`${r.cfg.padEnd(30)} ${String(r.n).padStart(4)}   ${(r.wr * 100).toFixed(1).padStart(5)}%  ${fmt(r.exp).padStart(7)}  ${fmt(r.net, 1).padStart(7)}   ${r.pf === Infinity ? ' inf' : r.pf.toFixed(2)}`);
  }

  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\nsaved → ${OUT}`);
  process.exit(0);
})();
