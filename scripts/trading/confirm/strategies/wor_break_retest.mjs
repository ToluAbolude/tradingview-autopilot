/**
 * wor_break_retest.mjs — port of wor_break_and_retest.pine (Vincent Desiano).
 * A DECISIVE close through a major swing level (body, not a wick), then wait for
 * the pullback that RETESTS the broken level — enter as it flips (support↔
 * resistance). Stop beyond the level; edge comes from R:R, not hit-rate.
 */
import { calcATR } from '../indicators.mjs';
import { swings } from './lib/structure.mjs';
import { candleSignal, bodyRatio } from './lib/helpers.mjs';

export default {
  name: 'wor_break_retest',
  description: 'Decisive break of a major level + retest flip entry (WOR / Desiano)',
  timeframes: ['60', '240', '15'],
  universe: 'all',
  defaultParams: { slBufAtr: 0.4, retestTolAtr: 0.4, maxRetestBars: 50, minBodyRatio: 0.55 },
  riskOverrides: { defaultTpLadder: [{ rMultiple: 2, closePct: 60 }, { rMultiple: 3.5, closePct: 40 }], breakevenAfterTp1: true },

  generateSignals(bars, ctx) {
    if (bars.length < 100) return [];
    const p = { ...this.defaultParams, ...ctx.params };
    const atr = calcATR(bars, 14);
    const sw = swings(bars, 6);
    const out = [];
    let pending = null;

    for (let i = 7; i < bars.length; i++) {
      const b = bars[i], a = atr[i];
      if (!(a > 0)) continue;
      const cPrev = bars[i - 1].c;
      const ph = sw.lastHighAt(i), pl = sw.lastLowAt(i);

      // decisive break (body close beyond a major swing)
      if (ph && cPrev <= ph.price && b.c > ph.price && bodyRatio(b) >= p.minBodyRatio) pending = { dir: 'long', level: ph.price, bar: i };
      else if (pl && cPrev >= pl.price && b.c < pl.price && bodyRatio(b) >= p.minBodyRatio) pending = { dir: 'short', level: pl.price, bar: i };

      if (pending && i > pending.bar && i - pending.bar <= p.maxRetestBars) {
        const long = pending.dir === 'long';
        const tol = a * p.retestTolAtr;
        const retest = long ? (b.l <= pending.level + tol && b.c >= pending.level) : (b.h >= pending.level - tol && b.c <= pending.level);
        const confirm = candleSignal(bars, i) === (long ? 1 : -1);
        if (retest && confirm) {
          const entry = b.c, sl = long ? pending.level - p.slBufAtr * a : pending.level + p.slBufAtr * a;
          if (Math.abs(entry - sl) > 0) { out.push({ ts: b.t, dir: pending.dir, entry, sl, atr: a, reason: `break&retest flip @${pending.level.toFixed(4)}` }); pending = null; }
        }
      }
    }
    return out;
  },
};
