/**
 * tg_trident.mjs — TG Capital "Unique High RR / Trident" (Chart Fanatics).
 * Rules source: strategies/chart_fanatics/raw/unique-high-rr.md
 *
 * London Kill Zone model on the 30M chart (playbook TF; H1 pass as fallback):
 *  • FVG (3-candle gap) must form inside the kill zone (≈06:30–09:00 UTC).
 *  • Trident: a small-bodied doji wicks into the FVG midpoint (consequent
 *    encroachment) within a few bars; the NEXT candle must close below the doji
 *    high (long) / above the doji low (short) — i.e. not extended — to enter.
 *  • Trend filter: EMAs 5>9>13>21 cleanly stacked + price above/below EMA 200.
 *  • SL below the FVG candles' low (above their high for shorts).
 *  • Exit: ride until the 5/21 EMA stack breaks (playbook: "EMAs begin to
 *    reverse"), fixed-R variants included for comparison.
 * Playbook pairs: USDJPY EURUSD GBPUSD NZDUSD USDCAD XAUUSD (+NAS100 noted).
 */

const KZ_START = 6.5, KZ_END = 9;    // UTC hours for FVG formation (02:30–04:00 NY ± DST)
const ENTRY_END = 10.5;              // entries must occur before ~06:30 NY
const DOJI_BODY = 0.35;              // body ≤ 35% of candle range
const DOJI_WAIT = 4;                 // bars allowed between FVG and doji

export const meta = {
  name: 'TG Capital — Trident (London KZ FVG + doji + EMA stack)',
  defaultTf: 'M30',
  note: 'Playbook pairs: USDJPY EURUSD GBPUSD NZDUSD USDCAD XAUUSD. Kill zone ≈06:30–09:00 UTC.',
};

export const configs = [
  { name: 'stack ema-exit',   stack: true,  exit: 'ema' },
  { name: 'stack tp2R',       stack: true,  exit: '2r' },
  { name: 'stack tp3R',       stack: true,  exit: '3r' },
  { name: 'noStack ema-exit', stack: false, exit: 'ema' },
];

function emaArr(bars, len) {
  const out = new Array(bars.length).fill(null);
  const k = 2 / (len + 1); let e = bars[0].c;
  for (let i = 0; i < bars.length; i++) { e = bars[i].c * k + e * (1 - k); if (i >= len) out[i] = e; }
  return out;
}
const hourUTC = t => { const d = new Date(t); return d.getUTCHours() + d.getUTCMinutes() / 60; };

export function signals(bars, atr, cfg) {
  const n = bars.length;
  const sigs = [];
  const e5 = emaArr(bars, 5), e9 = emaArr(bars, 9), e13 = emaArr(bars, 13),
        e21 = emaArr(bars, 21), e200 = emaArr(bars, 200);
  const stackedUp   = i => e21[i] != null && e5[i] > e9[i] && e9[i] > e13[i] && e13[i] > e21[i];
  const stackedDown = i => e21[i] != null && e5[i] < e9[i] && e9[i] < e13[i] && e13[i] < e21[i];

  // find the first EMA-unstack bar after i (used as the ride-the-trend exit)
  const exitAfter = (i, dir) => {
    for (let k = i + 1; k < n; k++) {
      if (dir === 'long'  && e5[k] != null && e5[k] < e21[k]) return k;
      if (dir === 'short' && e5[k] != null && e5[k] > e21[k]) return k;
    }
    return n - 1;
  };

  for (let i = 2; i < n - 1; i++) {
    const h = hourUTC(bars[i].t);
    if (h < KZ_START || h >= KZ_END) continue;               // FVG must form in the kill zone
    const c1 = bars[i - 2], c3 = bars[i];

    // bullish FVG: candle1 high < candle3 low
    if (c1.h < c3.l && e200[i] != null && bars[i].c > e200[i] && (!cfg.stack || stackedUp(i))) {
      const mid = (c1.h + c3.l) / 2;
      for (let d = i + 1; d <= Math.min(i + DOJI_WAIT, n - 2); d++) {
        const doji = bars[d], rng = doji.h - doji.l;
        if (rng <= 0 || Math.abs(doji.c - doji.o) > DOJI_BODY * rng) continue;
        if (doji.l > mid || doji.c < c1.h) continue;          // must wick to mid, close back above gap
        const conf = bars[d + 1];
        if (hourUTC(conf.t) >= ENTRY_END) break;
        if (conf.c >= doji.h || conf.c <= doji.l) break;      // extended or broken → invalid
        const entry = conf.c;
        const stop = Math.min(c1.l, bars[i - 1].l, c3.l);     // below the FVG candles
        const risk = entry - stop;
        if (risk > 0) {
          const sig = { i: d + 1, dir: 'long', entry, stop, tp: null, label: 'trident-long' };
          if (cfg.exit === 'ema') sig.timeExit = exitAfter(d + 1, 'long');
          else sig.tp = entry + (cfg.exit === '2r' ? 2 : 3) * risk;
          sigs.push(sig);
        }
        break;
      }
    }
    // bearish FVG: candle1 low > candle3 high
    if (c1.l > c3.h && e200[i] != null && bars[i].c < e200[i] && (!cfg.stack || stackedDown(i))) {
      const mid = (c1.l + c3.h) / 2;
      for (let d = i + 1; d <= Math.min(i + DOJI_WAIT, n - 2); d++) {
        const doji = bars[d], rng = doji.h - doji.l;
        if (rng <= 0 || Math.abs(doji.c - doji.o) > DOJI_BODY * rng) continue;
        if (doji.h < mid || doji.c > c1.l) continue;
        const conf = bars[d + 1];
        if (hourUTC(conf.t) >= ENTRY_END) break;
        if (conf.c <= doji.l || conf.c >= doji.h) break;
        const entry = conf.c;
        const stop = Math.max(c1.h, bars[i - 1].h, c3.h);
        const risk = stop - entry;
        if (risk > 0) {
          const sig = { i: d + 1, dir: 'short', entry, stop, tp: null, label: 'trident-short' };
          if (cfg.exit === 'ema') sig.timeExit = exitAfter(d + 1, 'short');
          else sig.tp = entry - (cfg.exit === '2r' ? 2 : 3) * risk;
          sigs.push(sig);
        }
        break;
      }
    }
  }
  return sigs;
}
