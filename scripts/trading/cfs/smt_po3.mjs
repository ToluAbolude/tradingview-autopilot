/**
 * smt_po3.mjs — Trader Kane "SMT Divergence + PO3" (Chart Fanatics).
 * Rules source: strategies/chart_fanatics/raw/smt-divergence-po3.md
 *
 * Manipulation-fade back to the range midpoint, mechanized on H1 with a
 * correlated aux series for the SMT gate:
 *  • Range = last significant swing low↔high (pivot 10). Bias: price trading
 *    in the premium (upper half) for shorts / discount for longs.
 *  • Manipulation: sweep of the range high (bar.h > swing high) inside the key
 *    window (~10:00 ET → 13:30–16:00 UTC).
 *  • SMT divergence: the AUX symbol does NOT make a corresponding new high
 *    over the same lookback on the same bar (NQ↑ / ES✗ analogue).
 *  • Entry: breakdown close back below the swept level within a few bars.
 *  • SL just above the SMT/sweep high; TP = 50% of the range (base hit).
 *  • BE variant: stop to breakeven once price closes half-way to target.
 * Pairs (meta.aux): NAS100↔US500, US30→US500, BTC↔ETH, XAU↔XAG, EUR↔GBP.
 */

const PIV = 10;
const WINDOW = [13.5, 16];   // UTC manipulation window (~10:00 ET)
const CONFIRM_WITHIN = 3;
const BUF_ATR = 0.15;

export const meta = {
  name: 'Trader Kane — SMT Divergence + PO3 (manipulation fade → 50% base hit)',
  defaultTf: 'H1',
  aux: { NAS100: 'US500', US500: 'NAS100', US30: 'US500', BTCUSD: 'ETHUSD', ETHUSD: 'BTCUSD',
         XAUUSD: 'XAGUSD', XAGUSD: 'XAUUSD', EURUSD: 'GBPUSD', GBPUSD: 'EURUSD' },
  note: 'Requires aux pair for the SMT gate. TP = range midpoint.',
};

export const configs = [
  { name: 'smt window be',    smt: true,  window: true,  be: true },
  { name: 'smt window',       smt: true,  window: true,  be: false },
  { name: 'smt allday be',    smt: true,  window: false, be: true },
  { name: 'noSmt window be',  smt: false, window: true,  be: true },
];

const hourUTC = t => { const d = new Date(t); return d.getUTCHours() + d.getUTCMinutes() / 60; };

export function signals(bars, atr, cfg, ctx) {
  const n = bars.length;
  const sigs = [];
  const aux = ctx?.aux || null;
  if (cfg.smt && !aux) return sigs;            // SMT config without a pair → no trades

  // confirmed significant swings (causal)
  let lastHi = null, lastLo = null;            // { idx, price }
  let sweepHi = null, sweepLo = null;          // { level, extreme, start, mid }

  for (let i = PIV * 2; i < n; i++) {
    const b = bars[i], a = atr[i];
    if (!a) continue;
    const p = i - PIV;
    let isH = true, isL = true;
    for (let k = p - PIV; k <= p + PIV; k++) {
      if (k === p) continue;
      if (bars[k].h >= bars[p].h) isH = false;
      if (bars[k].l <= bars[p].l) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) lastHi = { idx: p, price: bars[p].h };
    if (isL) lastLo = { idx: p, price: bars[p].l };
    if (!lastHi || !lastLo) continue;

    const rangeHi = lastHi.price, rangeLo = lastLo.price;
    if (!(rangeHi > rangeLo)) continue;
    const mid = (rangeHi + rangeLo) / 2;
    const inWindow = !cfg.window || (hourUTC(b.t) >= WINDOW[0] && hourUTC(b.t) < WINDOW[1]);

    // aux "did NOT make a new high/low" over the same lookback, same bar
    const auxDiverges = dir => {
      if (!cfg.smt) return true;
      const ab = aux[i];
      if (!ab) return false;
      let ext = dir === 'short' ? -Infinity : Infinity;
      for (let k = Math.max(0, i - PIV * 2); k < i; k++) {
        const x = aux[k];
        if (!x) continue;
        if (dir === 'short') ext = Math.max(ext, x.h); else ext = Math.min(ext, x.l);
      }
      return dir === 'short' ? ab.h <= ext : ab.l >= ext;   // pair failed to sweep
    };

    // ── manipulation sweep detection
    if (!sweepHi && inWindow && b.c > mid && b.h > rangeHi && bars[i - 1].h <= rangeHi && auxDiverges('short')) {
      sweepHi = { level: rangeHi, extreme: b.h, start: i, mid };
    }
    if (!sweepLo && inWindow && b.c < mid && b.l < rangeLo && bars[i - 1].l >= rangeLo && auxDiverges('long')) {
      sweepLo = { level: rangeLo, extreme: b.l, start: i, mid };
    }

    // ── breakdown/reclaim confirmation → fade to the midpoint
    if (sweepHi) {
      sweepHi.extreme = Math.max(sweepHi.extreme, b.h);
      if (i - sweepHi.start > CONFIRM_WITHIN) sweepHi = null;
      else if (b.c < sweepHi.level && b.c < b.o) {
        const entry = b.c, stop = sweepHi.extreme + BUF_ATR * a, tp = sweepHi.mid;
        const risk = stop - entry;
        sweepHi = null;
        if (risk > 0 && entry - tp > 0) {
          const sig = { i, dir: 'short', entry, stop, tp, label: 'smt-short' };
          if (cfg.be) sig.beTrigger = entry - (entry - tp) / 2;
          sigs.push(sig);
        }
      }
    }
    if (sweepLo) {
      sweepLo.extreme = Math.min(sweepLo.extreme, b.l);
      if (i - sweepLo.start > CONFIRM_WITHIN) sweepLo = null;
      else if (b.c > sweepLo.level && b.c > b.o) {
        const entry = b.c, stop = sweepLo.extreme - BUF_ATR * a, tp = sweepLo.mid;
        const risk = entry - stop;
        sweepLo = null;
        if (risk > 0 && tp - entry > 0) {
          const sig = { i, dir: 'long', entry, stop, tp, label: 'smt-long' };
          if (cfg.be) sig.beTrigger = entry + (tp - entry) / 2;
          sigs.push(sig);
        }
      }
    }
  }
  return sigs;
}
