/**
 * jooviers_smarttrail_scalper.mjs — port of jooviers_gems_smart_trail_scalper.pine.
 * Heikin-Ashi pullback entries filtered by a SmartTrail (Chandelier ATR-22)
 * direction, NY session (09:30–16:00 ET). Auto direction: crypto/gold trade both
 * sides, indices/FX long-only. Two-phase exit: 50% at TP1 then the runner rides
 * the trail (ATR trail enabled via riskOverrides).
 */
import { calcSmartTrail, heikinAshi } from '../indicators.mjs';
import { inEtWindow } from './lib/structure.mjs';

const BOTH_CLASSES = new Set(['crypto', 'metal']);

export default {
  name: 'jooviers_smarttrail_scalper',
  description: 'HA pullback + SmartTrail filter, NY session, two-phase trailed exit',
  timeframes: ['5', '15'],
  universe: 'all',
  defaultParams: { atrLen: 22, atrMult: 3.0, minPullback: 2 },
  riskOverrides: { defaultTpLadder: [{ rMultiple: 1, closePct: 50 }], breakevenAfterTp1: true, atrTrail: { enabled: true, atrMult: 3.0, afterTpIndex: 1 } },

  generateSignals(bars, ctx) {
    if (bars.length < 80) return [];
    const p = { ...this.defaultParams, ...ctx.params };
    const ha = heikinAshi(bars);
    const st = calcSmartTrail(bars, p.atrLen, p.atrMult);
    const cls = ctx.instrument?.class;
    const allowShort = BOTH_CLASSES.has(cls);
    const out = [];

    const isBear = c => c.c < c.o, isBull = c => c.c > c.o;
    for (let i = p.atrLen + 3; i < bars.length; i++) {
      if (!inEtWindow(bars[i].t, 9, 30, 16, 0)) continue;
      const dir = st.dir[i];
      if (dir == null) continue;
      // resumption candle in trail direction after a short pullback against it
      if (dir === 1) {
        let pull = 0; for (let k = i - 1; k >= i - 4 && k > 0; k--) { if (isBear(ha[k])) pull++; else break; }
        if (pull >= p.minPullback && isBull(ha[i])) {
          const entry = bars[i].c, sl = Math.min(...ha.slice(i - pull, i + 1).map(c => c.l));
          if (entry - sl > 0) out.push({ ts: bars[i].t, dir: 'long', entry, sl, atr: (entry - sl), reason: 'SmartTrail-up HA pullback long' });
        }
      } else if (dir === -1 && allowShort) {
        let pull = 0; for (let k = i - 1; k >= i - 4 && k > 0; k--) { if (isBull(ha[k])) pull++; else break; }
        if (pull >= p.minPullback && isBear(ha[i])) {
          const entry = bars[i].c, sl = Math.max(...ha.slice(i - pull, i + 1).map(c => c.h));
          if (sl - entry > 0) out.push({ ts: bars[i].t, dir: 'short', entry, sl, atr: (sl - entry), reason: 'SmartTrail-down HA pullback short' });
        }
      }
    }
    return out;
  },
};
