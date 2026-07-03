/**
 * stage_s2.mjs — Ted Zhang "Stage Analysis" Stage-2 breakout, live port of the
 * backtest winner config `s2 long tp3R` (scripts/trading/cfs/stage_analysis.mjs;
 * the only Chart Fanatics config positive in BOTH OOS halves incl. the 2022
 * bear — cfs_stage_D1 / OOS run 2026-07-03).
 *
 * Daily bars. Stage 2 = close above SMA 50/100/150/200 (≈ 10/20/30/40-week),
 * SMA50 > SMA100 > SMA150, SMA50 rising. Entry: close breaks the prior 20-day
 * high while Stage 2 holds. SL below the 20-day base low (capped 4×ATR),
 * TP fixed at entry + 3R (the fixed target is WHY it passed OOS — open-ended
 * exits degraded into beta capture). Long-only.
 */

const BASE_LEN = 20;
const MAX_STOP_ATR = 4.0;
const BUF_ATR = 0.25;
const TARGET_R = 3;

function smaArr(bars, len) {
  const out = new Array(bars.length).fill(null);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].c;
    if (i >= len) sum -= bars[i - len].c;
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}
function atr14(bars) {
  const n = bars.length, out = new Array(n).fill(null);
  let prevClose = null, atr = null; const len = 14, trs = [];
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

export default {
  name: 'stage_s2',
  generateSignals(bars, _ctx) {
    const n = bars.length;
    const sigs = [];
    if (n < 210) return sigs;
    const atr = atr14(bars);
    const s50 = smaArr(bars, 50), s100 = smaArr(bars, 100), s150 = smaArr(bars, 150), s200 = smaArr(bars, 200);

    for (let i = 205; i < n; i++) {
      const b = bars[i], a = atr[i];
      if (!a || s200[i] == null) continue;
      const stage2 = b.c > s50[i] && b.c > s100[i] && b.c > s150[i] && b.c > s200[i]
                     && s50[i] > s100[i] && s100[i] > s150[i] && s50[i] > s50[i - 5];
      if (!stage2) continue;
      let hi = -Infinity, lo = Infinity;
      for (let k = i - BASE_LEN; k < i; k++) { hi = Math.max(hi, bars[k].h); lo = Math.min(lo, bars[k].l); }
      if (!(b.c > hi && bars[i - 1].c <= hi)) continue;
      const entry = b.c;
      const sl = Math.max(lo - BUF_ATR * a, entry - MAX_STOP_ATR * a);
      const risk = entry - sl;
      if (!(risk > 0)) continue;
      sigs.push({ ts: b.t, dir: 'long', entry, sl, tp: entry + TARGET_R * risk,
                  reason: 'stage2: daily base breakout above rising 50/100/150/200 SMA stack' });
    }
    return sigs;
  },
};
