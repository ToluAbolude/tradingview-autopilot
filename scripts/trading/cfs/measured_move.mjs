/**
 * measured_move.mjs — Marci Silfrain "Measured Move Trend / Little RZY"
 * (Chart Fanatics). Rules: strategies/chart_fanatics/raw/measured-move-trend-strategy.md
 *
 * Mechanized (short side; longs mirror): the Little RZY is a flag-like pullback.
 *  • Trend filter: close below EMA(50) and EMA falling.
 *  • Impulse: drop ≥ IMP_ATR×ATR within ≤ IMP_BARS bars → structure opens.
 *  • Structure: lowest low anywhere inside it; pullback highs form a FALLING
 *    trendline (p1 = highest high in structure, p2 = highest later, lower high).
 *  • Measure: distance from the lowest low UP to the trendline at that bar →
 *    project the same distance DOWN from the low = TP.
 *  • Entry: bar tags the trendline (within TOL×ATR) and closes bearish below
 *    it while the trend filter still holds. SL above the structure high.
 *  • Bollinger context (config): the tag must reach the mid-band region —
 *    "early structures near the upper band are higher probability".
 */

const EMA_LEN = 50;
const IMP_ATR = 2.0;    // impulse ≥ 2×ATR
const IMP_BARS = 10;    // ...within 10 bars
const PB_MIN = 3;       // structure needs ≥3 bars after the impulse
const PB_MAX = 20;      // ...and resolves within 20
const TOL_ATR = 0.35;   // trendline tag tolerance
const BUF_ATR = 0.25;   // SL buffer beyond structure extreme

export const meta = {
  name: 'Marci Silfrain — Measured Move Trend (Little RZY)',
  defaultTf: 'H4',
  note: 'Impulse→flag TL→projected-distance TP. BB(20,2) context filter variant.',
};

export const configs = [
  { name: 'both bb',        bb: true },
  { name: 'both noBB',      bb: false },
  { name: 'long noBB',      bb: false, dir: 'long' },
  { name: 'short noBB',     bb: false, dir: 'short' },
  { name: 'both bb tp1.5x', bb: true, tpMult: 1.5 },
];

function emaArr(bars, len) {
  const out = new Array(bars.length).fill(null);
  const k = 2 / (len + 1); let e = bars[0].c;
  for (let i = 0; i < bars.length; i++) { e = bars[i].c * k + e * (1 - k); if (i >= len) out[i] = e; }
  return out;
}
function bollinger(bars, len = 20, mult = 2) {
  const mid = new Array(bars.length).fill(null);
  let sum = 0, sumSq = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].c; sumSq += bars[i].c * bars[i].c;
    if (i >= len) { sum -= bars[i - len].c; sumSq -= bars[i - len].c * bars[i - len].c; }
    if (i >= len - 1) mid[i] = sum / len;
  }
  return { mid };
}
const lineAt = (x1, y1, x2, y2, x) => x1 === x2 ? y1 : y1 + (y2 - y1) / (x2 - x1) * (x - x1);

export function signals(bars, atr, cfg) {
  const n = bars.length;
  const sigs = [];
  const ema = emaArr(bars, EMA_LEN);
  const bb = bollinger(bars);

  // one structure per side: { start, low/hi + idx, p1:{i,px}|null, p2:{i,px}|null }
  let dn = null, up = null;

  for (let i = IMP_BARS + 1; i < n; i++) {
    const b = bars[i], a = atr[i];
    if (!a || ema[i] == null || bb.mid[i] == null) continue;
    const downTrend = b.c < ema[i] && ema[i] < ema[i - 1];
    const upTrend   = b.c > ema[i] && ema[i] > ema[i - 1];

    // ── SHORT side (bear-flag Little RZY)
    if (cfg.dir !== 'long') {
      if (!dn) {
        if (downTrend && bars[i - IMP_BARS].h - b.l >= IMP_ATR * a)
          dn = { start: i, low: b.l, lowIdx: i, p1: null, p2: null };
      } else {
        if (!downTrend || i - dn.start > PB_MAX) { dn = null; }
        else {
          if (b.l < dn.low) { dn.low = b.l; dn.lowIdx = i; }
          // build the falling TL across structure highs
          if (!dn.p1 || b.h > dn.p1.px) { dn.p1 = { i, px: b.h }; dn.p2 = null; }
          else if (b.h < dn.p1.px && (!dn.p2 || b.h > dn.p2.px)) dn.p2 = { i, px: b.h };

          if (dn.p1 && dn.p2 && i > dn.p2.i && i - dn.start >= PB_MIN) {
            const tl = lineAt(dn.p1.i, dn.p1.px, dn.p2.i, dn.p2.px, i);
            const tagged = b.h >= tl - TOL_ATR * a && b.c < b.o && b.c < tl && b.h <= dn.p1.px;
            const bbOk = !cfg.bb || b.h >= bb.mid[i];
            const dist = lineAt(dn.p1.i, dn.p1.px, dn.p2.i, dn.p2.px, dn.lowIdx) - dn.low;
            if (tagged && bbOk && dist > 0) {
              const entry = b.c;
              const stop = dn.p1.px + BUF_ATR * a;
              const tp = dn.low - (cfg.tpMult || 1.0) * dist;
              const risk = stop - entry;
              dn = null;
              if (risk > 0 && entry - tp > 0)
                sigs.push({ i, dir: 'short', entry, stop, tp, label: 'rzy-short' });
              continue;
            }
          }
        }
      }
    }

    // ── LONG side (bull-flag Little RZY)
    if (cfg.dir !== 'short') {
      if (!up) {
        if (upTrend && b.h - bars[i - IMP_BARS].l >= IMP_ATR * a)
          up = { start: i, hi: b.h, hiIdx: i, p1: null, p2: null };
      } else {
        if (!upTrend || i - up.start > PB_MAX) { up = null; }
        else {
          if (b.h > up.hi) { up.hi = b.h; up.hiIdx = i; }
          // rising TL across structure lows
          if (!up.p1 || b.l < up.p1.px) { up.p1 = { i, px: b.l }; up.p2 = null; }
          else if (b.l > up.p1.px && (!up.p2 || b.l < up.p2.px)) up.p2 = { i, px: b.l };

          if (up.p1 && up.p2 && i > up.p2.i && i - up.start >= PB_MIN) {
            const tl = lineAt(up.p1.i, up.p1.px, up.p2.i, up.p2.px, i);
            const tagged = b.l <= tl + TOL_ATR * a && b.c > b.o && b.c > tl && b.l >= up.p1.px;
            const bbOk = !cfg.bb || b.l <= bb.mid[i];
            const dist = up.hi - lineAt(up.p1.i, up.p1.px, up.p2.i, up.p2.px, up.hiIdx);
            if (tagged && bbOk && dist > 0) {
              const entry = b.c;
              const stop = up.p1.px - BUF_ATR * a;
              const tp = up.hi + (cfg.tpMult || 1.0) * dist;
              const risk = entry - stop;
              up = null;
              if (risk > 0 && tp - entry > 0)
                sigs.push({ i, dir: 'long', entry, stop, tp, label: 'rzy-long' });
              continue;
            }
          }
        }
      }
    }
  }
  return sigs;
}
