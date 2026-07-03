/**
 * crudele_env.mjs — Anthony Crudele "Futures Trading Strategy" (Chart Fanatics).
 * Rules source: strategies/chart_fanatics/raw/futures-trading-strategy.md
 *
 * Daily BB(20,3) environment model, mechanized:
 *  • Environment from band width: expanding (width up over EXP_LOOK bars) vs
 *    contracting. Expansion + price pushing the outer band = one-directional.
 *  • EXPANSION setup: breakout close beyond the prior CONS_LEN-day range in the
 *    expansion direction → trade that direction only. SL at the mid-band
 *    (20-SMA), TP at "unfinished business" = the prior upper/lower band peak
 *    beyond price, else 2R.
 *  • MEAN-REVERSION setup: after a band peak, price closes below the 30% line
 *    of the peak-to-peak band move → target the 50% line (the playbook's
 *    defined trigger/target). SL beyond the recent extreme.
 *  • 1–5 day swing → timeExit after MAX_HOLD bars as a variant.
 * Playbook markets: index futures (US500/NAS100/US30 rows are the reference).
 */

const BB_LEN = 20, BB_SD = 3;
const EXP_LOOK = 5;       // band width rising vs 5 bars ago = expanding
const CONS_LEN = 15;      // breakout range lookback
const MAX_HOLD = 5;       // playbook holds 1–5 days

export const meta = {
  name: 'Anthony Crudele — BB(20,3) environment (expansion breakout / 30→50% mean reversion)',
  defaultTf: 'D1',
  note: 'Index-first per playbook (US500/NAS100/US30 rows). MR trigger = close below 30% of band-peak move.',
};

export const configs = [
  { name: 'expansion 5d',      mode: 'exp', hold: true },
  { name: 'expansion swing',   mode: 'exp', hold: false },
  { name: 'meanrev 30→50',     mode: 'mr' },
  { name: 'both 5d',           mode: 'both', hold: true },
];

function bb(bars, len, sd) {
  const n = bars.length;
  const mid = new Array(n).fill(null), up = new Array(n).fill(null), dn = new Array(n).fill(null);
  let sum = 0, sumSq = 0;
  for (let i = 0; i < n; i++) {
    sum += bars[i].c; sumSq += bars[i].c * bars[i].c;
    if (i >= len) { sum -= bars[i - len].c; sumSq -= bars[i - len].c * bars[i - len].c; }
    if (i >= len - 1) {
      const m = sum / len, v = Math.max(0, sumSq / len - m * m), s = Math.sqrt(v);
      mid[i] = m; up[i] = m + sd * s; dn[i] = m - sd * s;
    }
  }
  return { mid, up, dn };
}

export function signals(bars, atr, cfg) {
  const n = bars.length;
  const sigs = [];
  const { mid, up, dn } = bb(bars, BB_LEN, BB_SD);

  // rolling band-peak tracking for "unfinished business" + mean-reversion fib
  let upPeak = null, upPeakIdx = null, dnPeak = null, dnPeakIdx = null;
  let mrArmedShort = null, mrArmedLong = null;   // { hi, lo } of the band-peak move

  for (let i = BB_LEN + EXP_LOOK; i < n - 1; i++) {
    const b = bars[i], a = atr[i];
    if (!a || up[i] == null || up[i - EXP_LOOK] == null) continue;
    const width = up[i] - dn[i], widthPrev = up[i - EXP_LOOK] - dn[i - EXP_LOOK];
    const expanding = width > widthPrev * 1.05;
    const contracting = width < widthPrev * 0.97;

    // track band peaks (upper band local max = prior "unfinished business")
    if (up[i] < up[i - 1] && (upPeak == null || up[i - 1] > upPeak * 0.999)) { upPeak = up[i - 1]; upPeakIdx = i - 1; }
    if (dn[i] > dn[i - 1] && (dnPeak == null || dn[i - 1] < dnPeak * 1.001)) { dnPeak = dn[i - 1]; dnPeakIdx = i - 1; }

    // ── EXPANSION: one-directional breakout
    if ((cfg.mode === 'exp' || cfg.mode === 'both') && expanding) {
      let hi = -Infinity, lo = Infinity;
      for (let k = i - CONS_LEN; k < i; k++) { hi = Math.max(hi, bars[k].h); lo = Math.min(lo, bars[k].l); }
      const upDir = b.c > hi && b.c > mid[i] && b.h >= up[i] * 0.995;      // pushing the upper band
      const dnDir = b.c < lo && b.c < mid[i] && b.l <= dn[i] * 1.005;
      if (upDir) {
        const entry = b.c, stop = mid[i], risk = entry - stop;
        if (risk > 0) {
          const tp = upPeak != null && upPeak > entry + risk ? upPeak : entry + 2 * risk;
          const sig = { i, dir: 'long', entry, stop, tp, label: 'exp-long' };
          if (cfg.hold) sig.timeExit = Math.min(n - 1, i + MAX_HOLD);
          sigs.push(sig);
        }
      } else if (dnDir) {
        const entry = b.c, stop = mid[i], risk = stop - entry;
        if (risk > 0) {
          const tp = dnPeak != null && dnPeak < entry - risk ? dnPeak : entry - 2 * risk;
          const sig = { i, dir: 'short', entry, stop, tp, label: 'exp-short' };
          if (cfg.hold) sig.timeExit = Math.min(n - 1, i + MAX_HOLD);
          sigs.push(sig);
        }
      }
    }

    // ── MEAN REVERSION: after expansion peak, 30% close → 50% target
    if (cfg.mode === 'mr' || cfg.mode === 'both') {
      // bearish MR: an up-expansion peaked (upper band rolled over) → fib the
      // band-peak move (recent swing high → mid-band region)
      if (contracting && upPeakIdx != null && i - upPeakIdx <= 15 && !mrArmedShort) {
        let hh = -Infinity; for (let k = upPeakIdx - 5; k <= Math.min(upPeakIdx + 5, i); k++) hh = Math.max(hh, bars[k].h);
        mrArmedShort = { hi: hh, lo: mid[i] - (hh - mid[i]) * 0.0 };       // move base = mid-band
      }
      if (mrArmedShort) {
        const range = mrArmedShort.hi - mid[i];
        const line30 = mrArmedShort.hi - range * 0.30;
        const line50 = mrArmedShort.hi - range * 0.50;
        if (range > 0 && b.c < line30 && bars[i - 1].c >= line30) {
          const entry = b.c, stop = mrArmedShort.hi + 0.2 * a, tp = line50;
          const risk = stop - entry;
          mrArmedShort = null;
          if (risk > 0 && entry - tp > 0) sigs.push({ i, dir: 'short', entry, stop, tp, label: 'mr-short' });
        } else if (b.h > mrArmedShort.hi) mrArmedShort = null;
      }
      // bullish MR mirror
      if (contracting && dnPeakIdx != null && i - dnPeakIdx <= 15 && !mrArmedLong) {
        let ll = Infinity; for (let k = dnPeakIdx - 5; k <= Math.min(dnPeakIdx + 5, i); k++) ll = Math.min(ll, bars[k].l);
        mrArmedLong = { lo: ll };
      }
      if (mrArmedLong) {
        const range = mid[i] - mrArmedLong.lo;
        const line30 = mrArmedLong.lo + range * 0.30;
        const line50 = mrArmedLong.lo + range * 0.50;
        if (range > 0 && b.c > line30 && bars[i - 1].c <= line30) {
          const entry = b.c, stop = mrArmedLong.lo - 0.2 * a, tp = line50;
          const risk = entry - stop;
          mrArmedLong = null;
          if (risk > 0 && tp - entry > 0) sigs.push({ i, dir: 'long', entry, stop, tp, label: 'mr-long' });
        } else if (b.l < mrArmedLong.lo) mrArmedLong = null;
      }
    }
  }
  return sigs;
}
