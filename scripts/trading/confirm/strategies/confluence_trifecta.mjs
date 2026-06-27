/**
 * confluence_trifecta.mjs — the live system's confluence engine, as a strategy.
 *
 * Faithful re-expression of setup_finder.runAllStrategies + the Trifecta gate:
 * with-trend candidates are scored across the same vote letters (A SmartTrail,
 * B EMA-stack, E EMA-cross, C S/R, F FVG, U PDH/PDL, R RSI, K candle, D daily
 * bias) using the production scanner weights, then mapped to the TREND/LEVEL/
 * SIGNAL families (confluence.mjs). A signal fires only with score ≥ threshold
 * AND a LEVEL hit AND ≥2 families present — i.e. structure, not momentum chasing.
 */
import { calcATR, calcEMA, calcRSI, calcSmartTrail, findPivots, detectFVGZones } from '../indicators.mjs';
import { familiesFor, trifectaCount } from './lib/confluence.mjs';
import { candleSignal } from './lib/helpers.mjs';

// Production scanner weights (scanner_config.json → scoring).
const SC = { A: 1, B: 1, E: 2, C_fresh: 2, C_retested: 3, F_fresh: 2, F_other: 1, U: 1, R: 1, K: 1, D: 1 };

function buildPrevDay(bars) {
  // Per-bar previous-day H/L/C (UTC). pdh/pdl/pdc[i] reflect the last COMPLETED day.
  const dayOf = t => Math.floor(t / 86400000);
  const pdh = new Array(bars.length).fill(null), pdl = new Array(bars.length).fill(null), pdc = new Array(bars.length).fill(null);
  let curDay = null, curH = -Infinity, curL = Infinity, curC = null;
  let prevH = null, prevL = null, prevC = null;
  for (let i = 0; i < bars.length; i++) {
    const d = dayOf(bars[i].t);
    if (curDay == null) curDay = d;
    if (d !== curDay) { prevH = curH; prevL = curL; prevC = curC; curDay = d; curH = -Infinity; curL = Infinity; }
    curH = Math.max(curH, bars[i].h); curL = Math.min(curL, bars[i].l); curC = bars[i].c;
    pdh[i] = prevH; pdl[i] = prevL; pdc[i] = prevC;
  }
  return { pdh, pdl, pdc };
}

export default {
  name: 'confluence_trifecta',
  description: 'Live confluence engine (Trifecta-gated multi-factor with-trend entries)',
  timeframes: ['15', '60', '240'],
  universe: 'all',
  defaultParams: { threshold: 6, slAtrMult: 1.5, cooldownBars: 5, srTolAtr: 0.5, pdTolAtr: 0.3 },

  generateSignals(bars, ctx) {
    if (bars.length < 80) return [];
    const p = { ...this.defaultParams, ...ctx.params };
    const ema8 = calcEMA(bars, 8), ema21 = calcEMA(bars, 21), ema50 = calcEMA(bars, 50);
    const rsi = calcRSI(bars, 14), atr = calcATR(bars, 14);
    const st = calcSmartTrail(bars, 22, 3.0);
    const { highs, lows } = findPivots(bars, 5);
    const fvgs = detectFVGZones(bars, atr, bars.length); // all zones, each carries barIdx
    const { pdh, pdl, pdc } = buildPrevDay(bars);

    const recentPivot = (arr, i) => { // most recent confirmed pivot at/before bar i (left=right=5)
      let best = null;
      for (const pv of arr) { if (pv.idx <= i - 5) best = pv; else break; }
      return best;
    };

    const signals = [];
    let cooldownUntil = -1;
    for (let i = 60; i < bars.length; i++) {
      if (i < cooldownUntil) continue;
      const a = atr[i]; if (!(a > 0)) continue;
      const b = bars[i];

      const trendUp = ema8[i] > ema21[i] && ema21[i] > ema50[i];
      const trendDn = ema8[i] < ema21[i] && ema21[i] < ema50[i];
      const dir = trendUp ? 'long' : trendDn ? 'short' : null;
      if (!dir) continue;
      const long = dir === 'long';

      let score = 0; const strats = [];
      // B — EMA stack (the with-trend basis)
      score += SC.B; strats.push('B');
      // A — SmartTrail aligned
      if (st.dir[i] === (long ? 1 : -1)) { score += SC.A; strats.push('A'); }
      // E — EMA8/21 cross in dir within last 3 bars
      for (let k = i; k > i - 3 && k > 0; k--) {
        const crossUp = ema8[k] > ema21[k] && ema8[k - 1] <= ema21[k - 1];
        const crossDn = ema8[k] < ema21[k] && ema8[k - 1] >= ema21[k - 1];
        if ((long && crossUp) || (!long && crossDn)) { score += SC.E; strats.push('E'); break; }
      }
      // C — nearest S/R pivot acting as level
      const pv = long ? recentPivot(lows, i) : recentPivot(highs, i);
      if (pv && Math.abs((long ? b.l : b.h) - pv.price) <= a * p.srTolAtr) { score += SC.C_fresh; strats.push('C'); }
      // F — fresh-ish FVG in dir formed in the last 30 bars and price inside it
      const fz = fvgs.find(z => z.barIdx >= i - 30 && z.barIdx <= i &&
        ((long && z.type === 'bullish') || (!long && z.type === 'bearish')) &&
        b.c <= z.top && b.c >= z.bottom);
      if (fz) { score += (fz.fresh ? SC.F_fresh : SC.F_other); strats.push('F'); }
      // U — near PDH/PDL
      if (pdh[i] != null) {
        const tol = a * p.pdTolAtr;
        if (Math.abs(b.c - pdh[i]) <= tol || Math.abs(b.c - pdl[i]) <= tol) { score += SC.U; strats.push('U'); }
      }
      // R — RSI extreme aligned
      if ((long && rsi[i] < 40) || (!long && rsi[i] > 60)) { score += SC.R; strats.push('R'); }
      // K — confirming candle at the level
      if (candleSignal(bars, i) === (long ? 1 : -1)) { score += SC.K; strats.push('K'); }
      // D — daily bias aligned
      if (pdc[i] != null && ((long && b.c > pdc[i]) || (!long && b.c < pdc[i]))) { score += SC.D; strats.push('D'); }

      const fam = familiesFor(strats);
      const hasLevel = fam.level.length > 0;
      if (score >= p.threshold && hasLevel && trifectaCount(strats) >= 2) {
        signals.push({
          ts: b.t, dir, entry: b.c,
          sl: long ? b.c - p.slAtrMult * a : b.c + p.slAtrMult * a,
          atr: a,
          reason: `score=${score} ${strats.join('')} (T:${fam.trend.join('')}|L:${fam.level.join('')}|S:${fam.signal.join('')})`,
        });
        cooldownUntil = i + p.cooldownBars;
      }
    }
    return signals;
  },
};
