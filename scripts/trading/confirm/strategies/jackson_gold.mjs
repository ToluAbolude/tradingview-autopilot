/**
 * jackson_gold.mjs — port of jackson_gold_multi_setup / v2 / v3 / v4 .pine.
 * Three regime-adaptive setups, gated by daily EMA bias + ADX regime + NY session:
 *   • BREAKOUT  — body closes beyond a swing level (trending). Target 2R.
 *   • BREAK&RETEST — decisive close through a level, then a confirmed retest. 3R.
 *   • BOUNCE    — ranging: rejection candle at a fresh S/R zone. 2R.
 * TP1 50% at 1R → breakeven. RSI gate (no longs OB / no shorts OS). The v2–v4
 * refinements (longs-only, HTF levels) are exposed as params.
 */
import { calcATR, calcEMA, calcRSI, calcADX } from '../indicators.mjs';
import { swings } from './lib/structure.mjs';
import { candleSignal, bodyRatio } from './lib/helpers.mjs';

export default {
  name: 'jackson_gold',
  description: 'Jackson Gold multi-setup (breakout / break&retest / bounce), NY session',
  timeframes: ['60', '15', '240'],
  universe: ['XAUUSD', 'XAGUSD', 'NAS100', 'US30'],
  defaultParams: {
    dEmaLen: 50, adxLen: 14, adxTrend: 25, rsiOB: 70, rsiOS: 30,
    slBufAtr: 0.3, longsOnly: false, retestTolAtr: 0.5, maxRetestBars: 72,
  },

  generateSignals(bars, ctx) {
    if (bars.length < 120) return [];
    const p = { ...this.defaultParams, ...ctx.params };
    const atr = calcATR(bars, 14);
    const dEma = calcEMA(bars, p.dEmaLen);
    const rsi = calcRSI(bars, 14);
    const { adx } = calcADX(bars, p.adxLen);
    const sw = swings(bars, 4);
    const out = [];
    let pendingBreak = null; // {dir, level, bar} awaiting retest

    const nySession = (ts) => { const d = new Date(ts); const m = (d.getUTCHours() - 4 + 24) % 24 * 60 + d.getUTCMinutes(); const fri = d.getUTCDay() === 5; return m >= 8 * 60 && m <= (fri ? 15 * 60 : 17 * 60); };

    for (let i = 6; i < bars.length; i++) {
      const b = bars[i], a = atr[i];
      if (!(a > 0) || dEma[i] == null) continue;
      if (!nySession(b.t)) continue;
      const bull = b.c > dEma[i], bear = b.c < dEma[i];
      const trending = (adx[i] ?? 0) >= p.adxTrend;
      const cPrev = bars[i - 1].c;
      const ph = sw.lastHighAt(i), pl = sw.lastLowAt(i);

      const longOk = bull && rsi[i] < p.rsiOB;
      const shortOk = bear && rsi[i] > p.rsiOS && !p.longsOnly;

      // ── BREAK & RETEST tracking ──
      if (trending) {
        if (ph && cPrev <= ph.price && b.c > ph.price && bodyRatio(b) >= 0.5) pendingBreak = { dir: 'long', level: ph.price, bar: i };
        else if (pl && cPrev >= pl.price && b.c < pl.price && bodyRatio(b) >= 0.5) pendingBreak = { dir: 'short', level: pl.price, bar: i };
      }
      if (pendingBreak && i > pendingBreak.bar && i - pendingBreak.bar <= p.maxRetestBars) {
        const long = pendingBreak.dir === 'long';
        const tol = a * p.retestTolAtr;
        const retest = long ? (b.l <= pendingBreak.level + tol && b.c >= pendingBreak.level) : (b.h >= pendingBreak.level - tol && b.c <= pendingBreak.level);
        const confirm = candleSignal(bars, i) === (long ? 1 : -1);
        if (retest && confirm && ((long && longOk) || (!long && shortOk))) {
          const entry = b.c, sl = long ? pendingBreak.level - p.slBufAtr * a : pendingBreak.level + p.slBufAtr * a;
          if (Math.abs(entry - sl) > 0) {
            out.push({ ts: b.t, dir: pendingBreak.dir, entry, sl, atr: a, tps: [{ rMultiple: 1, closePct: 50 }, { rMultiple: 3, closePct: 50 }], reason: 'break & retest' });
            pendingBreak = null; continue;
          }
        }
      }

      // ── BREAKOUT (trending, body close beyond swing) ──
      if (trending) {
        if (longOk && ph && cPrev <= ph.price && b.c > ph.price && bodyRatio(b) >= 0.5 && bodyRatio(b) < 0.9) {
          const sl = b.l - p.slBufAtr * a; if (b.c - sl > 0) out.push({ ts: b.t, dir: 'long', entry: b.c, sl, atr: a, tps: [{ rMultiple: 1, closePct: 50 }, { rMultiple: 2, closePct: 50 }], reason: 'breakout long' });
        } else if (shortOk && pl && cPrev >= pl.price && b.c < pl.price && bodyRatio(b) >= 0.5 && bodyRatio(b) < 0.9) {
          const sl = b.h + p.slBufAtr * a; if (sl - b.c > 0) out.push({ ts: b.t, dir: 'short', entry: b.c, sl, atr: a, tps: [{ rMultiple: 1, closePct: 50 }, { rMultiple: 2, closePct: 50 }], reason: 'breakout short' });
        }
      }
      // ── BOUNCE (ranging, rejection at swing zone) ──
      else {
        const sig = candleSignal(bars, i);
        if (sig === 1 && longOk && pl && Math.abs(b.l - pl.price) <= a * p.retestTolAtr) {
          const sl = pl.price - p.slBufAtr * a; if (b.c - sl > 0) out.push({ ts: b.t, dir: 'long', entry: b.c, sl, atr: a, tps: [{ rMultiple: 1, closePct: 50 }, { rMultiple: 2, closePct: 50 }], reason: 'bounce long' });
        } else if (sig === -1 && shortOk && ph && Math.abs(b.h - ph.price) <= a * p.retestTolAtr) {
          const sl = ph.price + p.slBufAtr * a; if (sl - b.c > 0) out.push({ ts: b.t, dir: 'short', entry: b.c, sl, atr: a, tps: [{ rMultiple: 1, closePct: 50 }, { rMultiple: 2, closePct: 50 }], reason: 'bounce short' });
        }
      }
    }
    return out;
  },
};
