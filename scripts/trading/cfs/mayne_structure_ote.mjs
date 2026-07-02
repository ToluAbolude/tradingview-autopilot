/**
 * mayne_structure_ote.mjs — Trader Mayne "Structure + OTE" (Chart Fanatics).
 * Rules source: strategies/chart_fanatics/raw/structure-ote.md
 *
 * Top-down model collapsed onto one series (HTF = large pivots, LTF = small):
 *  • HTF Market Structure Break: close beyond the last major swing (pivLen 20).
 *    Range = last major swing low↔high; discount = lower half (longs), premium
 *    = upper half (shorts).
 *  • POI = order block: the last opposite candle before the impulse that broke
 *    structure (body-to-extreme zone).
 *  • Entry trigger inside the POI: engineered liquidity sweep — a minor swing
 *    (pivLen 3) gets run, then price CLOSES back beyond it (breaker/MSS).
 *  • SL beyond the swept extreme; TP = HTF external liquidity (the range's
 *    far swing); minimum 2:1 RR required by the playbook.
 */

const HTF_PIV = 20;   // major swing half-length (~HTF structure on H1)
const LTF_PIV = 3;    // minor swing for the sweep-and-reclaim entry
const BUF_ATR = 0.15;
const POI_TTL = 400;  // bars a POI stays valid after the MSB

export const meta = {
  name: 'Trader Mayne — Structure + OTE (MSB → OB POI → sweep & reclaim)',
  defaultTf: 'H1',
  note: 'HTF pivots=20, LTF sweep pivots=3, TP = range extreme, minRR 2 per playbook.',
};

export const configs = [
  { name: 'core rr2 discount',   minRR: 2.0, zone: true },
  { name: 'core rr2 anyZone',    minRR: 2.0, zone: false },
  { name: 'core rr1.5 discount', minRR: 1.5, zone: true },
  { name: 'long rr2 discount',   minRR: 2.0, zone: true, dir: 'long' },
  { name: 'short rr2 discount',  minRR: 2.0, zone: true, dir: 'short' },
];

function pivots(bars, len) {
  const hi = [], lo = [];             // arrays of { idx (center), conf (confirm idx), price }
  for (let i = len * 2; i < bars.length; i++) {
    const p = i - len;
    let isH = true, isL = true;
    for (let k = p - len; k <= p + len; k++) {
      if (k === p) continue;
      if (bars[k].h >= bars[p].h) isH = false;
      if (bars[k].l <= bars[p].l) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) hi.push({ idx: p, conf: i, price: bars[p].h });
    if (isL) lo.push({ idx: p, conf: i, price: bars[p].l });
  }
  return { hi, lo };
}

export function signals(bars, atr, cfg) {
  const n = bars.length;
  const sigs = [];
  const HTF = pivots(bars, HTF_PIV);
  const LTF = pivots(bars, LTF_PIV);

  // walk bars; maintain last confirmed HTF swings and active POI
  let hIdx = 0, lIdx = 0, lastHi = null, lastLo = null;
  let ltfH = 0, ltfL = 0;
  const minorHi = [], minorLo = [];    // confirmed minor swings (rolling)
  let poi = null;   // { dir, top, bot, born, rangeHi, rangeLo, swept:null|{extreme} }

  for (let i = 1; i < n; i++) {
    const a = atr[i];
    while (hIdx < HTF.hi.length && HTF.hi[hIdx].conf <= i) lastHi = HTF.hi[hIdx++];
    while (lIdx < HTF.lo.length && HTF.lo[lIdx].conf <= i) lastLo = HTF.lo[lIdx++];
    while (ltfH < LTF.hi.length && LTF.hi[ltfH].conf <= i) { minorHi.push(LTF.hi[ltfH++]); if (minorHi.length > 8) minorHi.shift(); }
    while (ltfL < LTF.lo.length && LTF.lo[ltfL].conf <= i) { minorLo.push(LTF.lo[ltfL++]); if (minorLo.length > 8) minorLo.shift(); }
    if (!a || !lastHi || !lastLo) continue;
    const b = bars[i];

    // ── HTF MSB → define POI (order block = last opposite candle pre-impulse)
    if (b.c > lastHi.price && (!poi || poi.dir !== 'long' || poi.msbAt !== lastHi.idx)) {
      let ob = null;
      for (let k = i - 1; k > Math.max(lastLo.idx, i - 60); k--) {
        if (bars[k].c < bars[k].o) { ob = k; break; }        // last down candle
      }
      if (ob != null) poi = { dir: 'long', msbAt: lastHi.idx, top: Math.max(bars[ob].o, bars[ob].c), bot: bars[ob].l,
                              born: i, rangeHi: lastHi.price, rangeLo: lastLo.price, armed: false, swept: null };
    }
    if (b.c < lastLo.price && (!poi || poi.dir !== 'short' || poi.msbAt !== lastLo.idx)) {
      let ob = null;
      for (let k = i - 1; k > Math.max(lastHi.idx, i - 60); k--) {
        if (bars[k].c > bars[k].o) { ob = k; break; }        // last up candle
      }
      if (ob != null) poi = { dir: 'short', msbAt: lastLo.idx, top: bars[ob].h, bot: Math.min(bars[ob].o, bars[ob].c),
                              born: i, rangeHi: lastHi.price, rangeLo: lastLo.price, armed: false, swept: null };
    }
    if (!poi) continue;
    if (i - poi.born > POI_TTL) { poi = null; continue; }
    if (cfg.dir && poi.dir !== cfg.dir) continue;

    const mid = (poi.rangeHi + poi.rangeLo) / 2;

    if (poi.dir === 'long') {
      if (b.c < poi.bot - a) { poi = null; continue; }                   // POI violated
      const inPoi = b.l <= poi.top;
      const inZone = !cfg.zone || b.c <= mid;                            // discount
      if (inPoi && inZone) poi.armed = true;
      if (!poi.armed) continue;
      // sweep of a minor low inside/near the POI, then reclaim
      if (!poi.swept) {
        const swing = minorLo.filter(s => s.idx > poi.msbAt && s.price >= poi.bot - a).pop();
        if (swing && b.l < swing.price) poi.swept = { level: swing.price, extreme: b.l };
      } else {
        poi.swept.extreme = Math.min(poi.swept.extreme, b.l);
        if (b.c > poi.swept.level) {                                     // reclaim → entry
          const entry = b.c, stop = poi.swept.extreme - BUF_ATR * a, tp = poi.rangeHi;
          const risk = entry - stop, reward = tp - entry;
          poi = null;
          if (risk > 0 && reward / risk >= cfg.minRR)
            sigs.push({ i, dir: 'long', entry, stop, tp, label: 'mayne-long' });
        }
      }
    } else {
      if (b.c > poi.top + a) { poi = null; continue; }
      const inPoi = b.h >= poi.bot;
      const inZone = !cfg.zone || b.c >= mid;                            // premium
      if (inPoi && inZone) poi.armed = true;
      if (!poi.armed) continue;
      if (!poi.swept) {
        const swing = minorHi.filter(s => s.idx > poi.msbAt && s.price <= poi.top + a).pop();
        if (swing && b.h > swing.price) poi.swept = { level: swing.price, extreme: b.h };
      } else {
        poi.swept.extreme = Math.max(poi.swept.extreme, b.h);
        if (b.c < poi.swept.level) {
          const entry = b.c, stop = poi.swept.extreme + BUF_ATR * a, tp = poi.rangeLo;
          const risk = stop - entry, reward = entry - tp;
          poi = null;
          if (risk > 0 && reward / risk >= cfg.minRR)
            sigs.push({ i, dir: 'short', entry, stop, tp, label: 'mayne-short' });
        }
      }
    }
  }
  return sigs;
}
