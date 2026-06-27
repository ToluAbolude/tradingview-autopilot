/**
 * amd_ote.mjs — port of amd_ote_runner.pine / amd_ote_clean.pine.
 * ICT AMD model: in a kill-zone (London 02:00–05:00 ET, NY 10:00–11:00 ET),
 * a liquidity SWEEP of a recent swing that REVERSES (close back through the
 * swept level = manipulation + CHoCH) is the trigger; enter at the reclaim,
 * SL beyond the sweep extreme, target ≥3R. 50% off at 1R → breakeven → ATR
 * trail on the runner. Targets gold/indices/GBP.
 */
import { calcATR } from '../indicators.mjs';
import { swings } from './lib/structure.mjs';
import { inEtWindow } from './lib/structure.mjs';

export default {
  name: 'amd_ote',
  description: 'AMD liquidity sweep + CHoCH reclaim at OTE, kill-zones, ≥3R runner',
  timeframes: ['15', '60'],
  universe: ['XAUUSD', 'NAS100', 'US30', 'SPX500', 'GBPUSD', 'GBPJPY', 'EURUSD'],
  defaultParams: { slBufAtr: 0.3, rrTarget: 3, sweepLookback: 12 },
  riskOverrides: { breakevenAfterTp1: true, atrTrail: { enabled: true, atrMult: 2.0, afterTpIndex: 1 } },

  generateSignals(bars, ctx) {
    if (bars.length < 80) return [];
    const p = { ...this.defaultParams, ...ctx.params };
    const atr = calcATR(bars, 14);
    const sw = swings(bars, 5);
    const out = [];

    for (let i = 6; i < bars.length; i++) {
      const b = bars[i], a = atr[i];
      if (!(a > 0)) continue;
      const killzone = inEtWindow(b.t, 2, 0, 5, 0) || inEtWindow(b.t, 10, 0, 11, 0);
      if (!killzone) continue;

      const pl = sw.lastLowAt(i), ph = sw.lastHighAt(i);
      // Bullish: sweep below a swing low (b.l < low) but CLOSE reclaims above it.
      if (pl && b.l < pl.price && b.c > pl.price) {
        const entry = b.c, sl = b.l - p.slBufAtr * a;
        const risk = entry - sl;
        if (risk > 0) out.push({
          ts: b.t, dir: 'long', entry, sl, atr: a,
          tps: [{ rMultiple: 1, closePct: 50 }, { rMultiple: p.rrTarget, closePct: 50 }],
          reason: `sweep+reclaim of low ${pl.price.toFixed(4)}`,
        });
      }
      // Bearish: sweep above a swing high but CLOSE reclaims below it.
      else if (ph && b.h > ph.price && b.c < ph.price) {
        const entry = b.c, sl = b.h + p.slBufAtr * a;
        const risk = sl - entry;
        if (risk > 0) out.push({
          ts: b.t, dir: 'short', entry, sl, atr: a,
          tps: [{ rMultiple: 1, closePct: 50 }, { rMultiple: p.rrTarget, closePct: 50 }],
          reason: `sweep+reclaim of high ${ph.price.toFixed(4)}`,
        });
      }
    }
    return out;
  },
};
