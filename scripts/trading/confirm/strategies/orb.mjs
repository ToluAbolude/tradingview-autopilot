/**
 * orb.mjs — Opening Range Breakout.
 *
 * Port of the live orb_backtest.mjs logic into a strategy module. For each UTC
 * day and each session open, the opening range = first `orMinutes` after the
 * open. The first bar that CLOSES beyond the range (above orHigh = long, below
 * orLow = short) is the entry; SL = opposite range boundary. Only the first
 * breakout per session per day is taken, and only within `breakoutWindowH` of the
 * OR close. Exits (TP ladder / EOD) are handled by the simulator.
 */
import { calcATR, calcEMA } from '../indicators.mjs';
import { groupByUtcDay, openMinutes, inWindow } from './lib/helpers.mjs';

export default {
  name: 'orb',
  description: 'Opening Range Breakout (first close beyond the session opening range)',
  timeframes: ['5', '15'],
  universe: 'all',
  defaultParams: { orMinutes: 30, breakoutWindowH: 4, withTrend: true, emaLen: 200 },

  generateSignals(bars, ctx) {
    if (bars.length < 50) return [];
    const p = { ...this.defaultParams, ...ctx.params };
    const tfMin = parseInt(ctx.tf, 10);
    if (!tfMin) return [];
    const atr = calcATR(bars, 14);
    const ema = calcEMA(bars, p.emaLen);
    const idxByTs = new Map(); bars.forEach((b, i) => idxByTs.set(b.t, i));

    // Session opens: crypto (session247) trades all three; others too — the
    // matrix/leaderboard reveals which session×instrument actually has an edge.
    const sessions = Object.values(ctx.sessions || { ASIA: '00:00', LONDON: '07:00', NY: '13:30' });
    const signals = [];

    for (const dayBars of groupByUtcDay(bars).values()) {
      for (const open of sessions) {
        const openMin = openMinutes(open);
        const orBars = dayBars.filter(b => inWindow(b, openMin, p.orMinutes));
        if (orBars.length < 1) continue;
        const orHigh = Math.max(...orBars.map(b => b.h));
        const orLow = Math.min(...orBars.map(b => b.l));
        if (!(orHigh > orLow)) continue;
        const orCloseMin = openMin + p.orMinutes;
        const deadline = orCloseMin + p.breakoutWindowH * 60;

        // First bar that closes beyond the OR, after OR close, within the window.
        const after = dayBars.filter(b => {
          const m = new Date(b.t).getUTCHours() * 60 + new Date(b.t).getUTCMinutes();
          return m >= orCloseMin && m <= deadline;
        });
        for (const b of after) {
          let dir = null;
          if (b.c > orHigh) dir = 'long';
          else if (b.c < orLow) dir = 'short';
          if (!dir) continue;
          const i = idxByTs.get(b.t);
          if (i == null) break;
          if (p.withTrend && ema[i] != null) {
            const withTrend = dir === 'long' ? b.c > ema[i] : b.c < ema[i];
            if (!withTrend) break; // first breakout was counter-trend → skip this session/day
          }
          signals.push({
            ts: b.t, dir, entry: b.c,
            sl: dir === 'long' ? orLow : orHigh,
            atr: atr[i],
            reason: `ORB ${open} ${dir} (orH=${orHigh.toFixed(4)} orL=${orLow.toFixed(4)})`,
          });
          break; // only first breakout per session per day
        }
      }
    }
    return signals;
  },
};
