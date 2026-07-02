/**
 * po3_ote_adr.mjs — NBB Trader "PO3, OTE + ADR" (Chart Fanatics).
 * Rules source: strategies/chart_fanatics/raw/po3-ote-adr.md
 *
 * Market Maker Model, mechanized on H1 (playbook confirms on 15/30m; H1 is the
 * closest TF with 3y of cTrader history — M15 pass runs where history allows):
 *  • Manipulation = session-window sweep of the previous day's high/low
 *    (PDH/PDL). Sessions: London open ≈ 06–10 UTC, NY open ≈ 11–15 UTC.
 *  • Confirmation (Smart Money Reversal) = displacement candle that closes back
 *    past the swept level AND below/above the minor swing formed since the
 *    sweep, with body ≥ dispATR×ATR.
 *  • Fib leg = manipulation extreme → displacement bar's far end. LIMIT entry
 *    at the OTE retrace (0.50 / 0.62 / 0.705), SL at the 1.0 (leg extreme),
 *    TP at the 0.0, optional breakeven once a bar closes past the 0.20.
 *  • Optional daily bias (H1 EMA-600 ≈ ~5-week trend): shorts only below, longs
 *    only above. Optional ADR filter: skip if today already used >0.7×ADR(20).
 */

const DISP_ATR = 0.7;     // displacement body must be ≥ this × ATR
const EXPIRY = 24;        // bars the OTE limit stays working (~1 day on H1)
const EMA_LEN = 600;      // H1 bias proxy for the daily/weekly trend
const ADR_LEN = 20;

export const meta = {
  name: 'NBB Trader — PO3, OTE + ADR (MMM sweep → displacement → OTE limit)',
  defaultTf: 'H1',
  note: 'Limit entries at fib retrace; SL=leg extreme, TP=leg 0.0. Sessions UTC: LDN 06-10, NY 11-15.',
};

export const configs = [
  { name: 'ote62 be bias adr',      fib: 0.62,  be: true,  bias: true,  adr: true },
  { name: 'ote62 be bias',          fib: 0.62,  be: true,  bias: true,  adr: false },
  { name: 'ote62 be noBias',        fib: 0.62,  be: true,  bias: false, adr: false },
  { name: 'ote62 noBE bias',        fib: 0.62,  be: false, bias: true,  adr: false },
  { name: 'ote50 be bias',          fib: 0.50,  be: true,  bias: true,  adr: false },
  { name: 'ote705 be bias',         fib: 0.705, be: true,  bias: true,  adr: false },
];

const inWindow = t => {
  const h = new Date(t).getUTCHours();
  return (h >= 6 && h < 10) || (h >= 11 && h < 15);
};
const dayKey = t => new Date(t).toISOString().slice(0, 10);

export function signals(bars, atr, cfg) {
  const n = bars.length;
  const sigs = [];

  // EMA for bias
  const ema = new Array(n).fill(null);
  { const k = 2 / (EMA_LEN + 1); let e = bars[0].c;
    for (let i = 0; i < n; i++) { e = bars[i].c * k + e * (1 - k); ema[i] = i >= EMA_LEN ? e : null; } }

  // per-day bookkeeping
  let curDay = null, dayHi = null, dayLo = null;
  let pdh = null, pdl = null;
  const dayRanges = [];      // completed daily ranges for ADR
  let adr = null;

  // active sweep state (one per side)
  let swHi = null;           // { extreme, minorLow, start }
  let swLo = null;           // { extreme, minorHigh, start }

  for (let i = 1; i < n; i++) {
    const b = bars[i], a = atr[i];
    const dk = dayKey(b.t);
    if (dk !== curDay) {
      if (curDay != null && dayHi != null) {
        pdh = dayHi; pdl = dayLo;
        dayRanges.push(dayHi - dayLo);
        if (dayRanges.length > ADR_LEN) dayRanges.shift();
        adr = dayRanges.length >= 5 ? dayRanges.reduce((s, x) => s + x, 0) / dayRanges.length : null;
      }
      curDay = dk; dayHi = b.h; dayLo = b.l;
      swHi = null; swLo = null;               // model resets each day
    } else { dayHi = Math.max(dayHi, b.h); dayLo = Math.min(dayLo, b.l); }
    if (!a || pdh == null) continue;

    const bearBias = ema[i] != null && b.c < ema[i];
    const bullBias = ema[i] != null && b.c > ema[i];
    const adrOk = !cfg.adr || adr == null || (dayHi - dayLo) < 0.7 * adr;

    // 1) manipulation sweep inside a session window
    if (inWindow(b.t)) {
      if (b.h > pdh && !swHi) swHi = { extreme: b.h, minorLow: b.l, start: i };
      if (b.l < pdl && !swLo) swLo = { extreme: b.l, minorHigh: b.h, start: i };
    }

    // 2) displacement confirmation → OTE limit signal
    if (swHi) {
      swHi.extreme = Math.max(swHi.extreme, b.h);
      const body = Math.abs(b.c - b.o);
      if (b.c < pdh && b.c < swHi.minorLow && b.c < b.o && body >= DISP_ATR * a) {
        const hi = swHi.extreme, lo = b.l, range = hi - lo;
        swHi = null;
        if (range > 0 && (!cfg.bias || bearBias) && adrOk) {
          const limit = lo + range * cfg.fib;
          sigs.push({ i, dir: 'short', limit, expiry: EXPIRY, stop: hi, tp: lo,
                      beTrigger: cfg.be ? lo + range * 0.20 : null, label: 'po3-short' });
        }
      } else swHi.minorLow = Math.min(swHi.minorLow, b.l);
    }
    if (swLo) {
      swLo.extreme = Math.min(swLo.extreme, b.l);
      const body = Math.abs(b.c - b.o);
      if (b.c > pdl && b.c > swLo.minorHigh && b.c > b.o && body >= DISP_ATR * a) {
        const lo = swLo.extreme, hi = b.h, range = hi - lo;
        swLo = null;
        if (range > 0 && (!cfg.bias || bullBias) && adrOk) {
          const limit = hi - range * cfg.fib;
          sigs.push({ i, dir: 'long', limit, expiry: EXPIRY, stop: lo, tp: hi,
                      beTrigger: cfg.be ? hi - range * 0.20 : null, label: 'po3-long' });
        }
      } else swLo.minorHigh = Math.max(swLo.minorHigh, b.h);
    }
  }
  return sigs;
}
