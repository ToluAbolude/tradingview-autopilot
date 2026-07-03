/**
 * dhesi_inversion.mjs — Dhesi "Liquidity Inversion Model" (Chart Fanatics).
 * Rules source: strategies/chart_fanatics/raw/liquidity-inversion-model.md
 *
 * Layered sequence, mechanized on one TF (H1/H4; playbook is NQ/ES-first):
 *  • Draw on liquidity: significant swing highs/lows (pivot 10) + PDH/PDL.
 *  • Sweep: price trades through the pool.
 *  • HTF inversion: within INV_WITHIN bars the FVG that supported the move is
 *    VIOLATED (close through its far side) — bullish gap breaks in a bearish
 *    reversal, bearish gap breaks in a bullish one. "Speed matters."
 *  • Retrace into the inverted gap (now a PD array) within RETRACE_WITHIN bars;
 *    entry when a bar tags the zone and closes back out in trade direction.
 *  • SL beyond the protected high/low (extreme since inversion).
 *  • TP: first technical target = nearest opposite pool ("tp1" configs), or
 *    runner variant: TP = second stacked pool with breakeven at the first
 *    (playbook: trim at first target, stop to BE, let the runner work).
 *  • Volatility filter (config): ATR(14) above its 50-bar mean — "do not trade
 *    the model aggressively in dead volatility."
 */

const PIV = 10;            // significant swing pivot half-length
const MAX_POOLS = 10;
const FVG_LOOKBACK = 40;   // bars an unviolated FVG stays relevant
const INV_WITHIN = 3;      // sweep → inversion speed requirement
const RETRACE_WITHIN = 12; // inversion → retrace window
const BUF_ATR = 0.2;

export const meta = {
  name: 'Dhesi — Liquidity Inversion (sweep → FVG inversion → retrace entry)',
  defaultTf: 'H1',
  note: 'Built for NQ/ES per playbook — watch NAS100/US500/US30 rows. Runner cfg = TP2 with BE at TP1.',
};

export const configs = [
  { name: 'tp1 vol',        tp: 1, vol: true },
  { name: 'tp1 noVol',      tp: 1, vol: false },
  { name: 'runner vol',     tp: 2, vol: true,  be: true },
  { name: 'runner noVol',   tp: 2, vol: false, be: true },
  { name: 'tp1 vol short',  tp: 1, vol: true,  dir: 'short' },
  { name: 'tp1 vol long',   tp: 1, vol: true,  dir: 'long' },
];

const dayKey = t => new Date(t).toISOString().slice(0, 10);

export function signals(bars, atr, cfg) {
  const n = bars.length;
  const sigs = [];

  // ATR mean for the volatility regime filter
  const atrMean = new Array(n).fill(null);
  { let sum = 0; const q = [];
    for (let i = 0; i < n; i++) { const v = atr[i] || 0; q.push(v); sum += v;
      if (q.length > 50) sum -= q.shift();
      if (q.length === 50) atrMean[i] = sum / 50; } }

  let curDay = null, dayHi = null, dayLo = null, pdh = null, pdl = null;
  const hiPools = [], loPools = [];       // confirmed swing pools
  const bullFvg = [], bearFvg = [];       // { top, bot, born } unviolated gaps
  let swHi = null, swLo = null;           // sweep state
  let invShort = null, invLong = null;    // inverted-gap setups awaiting retrace

  for (let i = PIV * 2; i < n; i++) {
    const b = bars[i], a = atr[i];
    const dk = dayKey(b.t);
    if (dk !== curDay) { if (curDay != null && dayHi != null) { pdh = dayHi; pdl = dayLo; } curDay = dk; dayHi = b.h; dayLo = b.l; }
    else { dayHi = Math.max(dayHi, b.h); dayLo = Math.min(dayLo, b.l); }
    if (!a) continue;

    // confirmed significant swings → pools
    const p = i - PIV;
    let isH = true, isL = true;
    for (let k = p - PIV; k <= p + PIV; k++) {
      if (k === p) continue;
      if (bars[k].h >= bars[p].h) isH = false;
      if (bars[k].l <= bars[p].l) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) { hiPools.push(bars[p].h); if (hiPools.length > MAX_POOLS) hiPools.shift(); }
    if (isL) { loPools.push(bars[p].l); if (loPools.length > MAX_POOLS) loPools.shift(); }

    // track FVGs (3-candle) + drop stale/violated ones
    if (i >= 2) {
      if (bars[i - 2].h < b.l) bullFvg.push({ top: b.l, bot: bars[i - 2].h, born: i });
      if (bars[i - 2].l > b.h) bearFvg.push({ top: bars[i - 2].l, bot: b.h, born: i });
    }
    for (let f = bullFvg.length - 1; f >= 0; f--) if (i - bullFvg[f].born > FVG_LOOKBACK) bullFvg.splice(f, 1);
    for (let f = bearFvg.length - 1; f >= 0; f--) if (i - bearFvg[f].born > FVG_LOOKBACK) bearFvg.splice(f, 1);

    const volOk = !cfg.vol || (atrMean[i] != null && a > atrMean[i]);

    // ── sweeps of pools (incl. PDH/PDL)
    const upTargets = [...hiPools, ...(pdh != null ? [pdh] : [])];
    const dnTargets = [...loPools, ...(pdl != null ? [pdl] : [])];
    if (!swHi) { const lvl = upTargets.filter(L => b.h > L && bars[i - 1].h <= L).sort((x, y) => y - x)[0];
                 if (lvl != null) swHi = { extreme: b.h, start: i }; }
    if (!swLo) { const lvl = dnTargets.filter(L => b.l < L && bars[i - 1].l >= L).sort((x, y) => x - y)[0];
                 if (lvl != null) swLo = { extreme: b.l, start: i }; }

    // ── HTF inversion after the sweep (violate the supporting gap with speed)
    if (swHi) {
      swHi.extreme = Math.max(swHi.extreme, b.h);
      if (i - swHi.start > INV_WITHIN) swHi = null;
      else {
        const gap = bullFvg.filter(f => f.top < swHi.extreme).sort((x, y) => y.top - x.top)[0];
        if (gap && b.c < gap.bot) {         // bullish gap violated → inverted resistance
          invShort = { zone: gap, protHigh: swHi.extreme, inv: i };
          bullFvg.splice(bullFvg.indexOf(gap), 1);
          swHi = null;
        }
      }
    }
    if (swLo) {
      swLo.extreme = Math.min(swLo.extreme, b.l);
      if (i - swLo.start > INV_WITHIN) swLo = null;
      else {
        const gap = bearFvg.filter(f => f.bot > swLo.extreme).sort((x, y) => x.bot - y.bot)[0];
        if (gap && b.c > gap.top) {         // bearish gap violated → inverted support
          invLong = { zone: gap, protLow: swLo.extreme, inv: i };
          bearFvg.splice(bearFvg.indexOf(gap), 1);
          swLo = null;
        }
      }
    }

    // ── retrace into the inverted gap → entry on rejection close
    if (invShort) {
      invShort.protHigh = Math.max(invShort.protHigh, b.h);
      if (i - invShort.inv > RETRACE_WITHIN || b.c > invShort.zone.top) invShort = null;
      else if (i > invShort.inv && b.h >= invShort.zone.bot && b.c < invShort.zone.bot && b.c < b.o) {
        const entry = b.c, stop = invShort.protHigh + BUF_ATR * a;
        const targets = dnTargets.filter(L => L < entry).sort((x, y) => y - x);
        invShort = null;
        if ((cfg.dir !== 'long') && volOk && targets.length >= cfg.tp) {
          const tp = targets[cfg.tp - 1];
          const risk = stop - entry;
          if (risk > 0 && entry - tp > 0) {
            const sig = { i, dir: 'short', entry, stop, tp, label: 'dhesi-short' };
            if (cfg.be && targets.length) sig.beTrigger = targets[0];
            sigs.push(sig);
          }
        }
      }
    }
    if (invLong) {
      invLong.protLow = Math.min(invLong.protLow, b.l);
      if (i - invLong.inv > RETRACE_WITHIN || b.c < invLong.zone.bot) invLong = null;
      else if (i > invLong.inv && b.l <= invLong.zone.top && b.c > invLong.zone.top && b.c > b.o) {
        const entry = b.c, stop = invLong.protLow - BUF_ATR * a;
        const targets = upTargets.filter(L => L > entry).sort((x, y) => x - y);
        invLong = null;
        if ((cfg.dir !== 'short') && volOk && targets.length >= cfg.tp) {
          const tp = targets[cfg.tp - 1];
          const risk = entry - stop;
          if (risk > 0 && tp - entry > 0) {
            const sig = { i, dir: 'long', entry, stop, tp, label: 'dhesi-long' };
            if (cfg.be && targets.length) sig.beTrigger = targets[0];
            sigs.push(sig);
          }
        }
      }
    }
  }
  return sigs;
}
