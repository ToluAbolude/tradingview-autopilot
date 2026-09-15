/**
 * sizing.mjs — position size from risk, one copy (docs/SERVICE_MAP.md, service #13).
 *
 * Replaces six hand-copied calcLots that had already drifted: per-class lot caps
 * in one and a flat 10 in the rest, a 1% crypto risk cap in two of five, oil and
 * silver branches missing from two. This is inline_trader's version (the most
 * complete), with the asset class taken from the instrument registry.
 */
import { instrumentClass } from './instruments.mjs';

// Per-class lot caps. 3 FX lots = $300k notional; the old flat cap of 10 let a
// collapsed-SL signal size to $1M on a $7k account. broker_ctrader still clamps to
// its own safety caps on top of these.
export const LOT_CAPS = { FX: 3, METAL: 2, OIL: 5, INDEX: 10, CRYPTO: 3 };

// Crypto never risks more than this % of equity, whatever riskPct asks for.
export const CRYPTO_MAX_RISK_PCT = 1;

const MIN_LOT = 0.01, LOT_STEP = 0.01;
const floorLots = (lots, cap) => Math.min(Math.max(Math.floor(lots / LOT_STEP) * LOT_STEP, MIN_LOT), cap);

/** Lots such that a stop-out at `sl` loses about riskPct% of equity (cTrader contract sizes). */
export function calcLots(symbol, riskPct, equity, entry, sl) {
  const riskAmt = equity * (riskPct / 100);
  const slDist  = Math.abs(entry - sl);
  if (slDist === 0) return MIN_LOT;
  const sym = String(symbol).toUpperCase();

  switch (instrumentClass(sym)) {
    case 'INDEX':                                   // $1 per point per lot
      return floorLots(riskAmt / slDist, LOT_CAPS.INDEX);
    case 'CRYPTO': {                                // 1 lot = 1 coin
      const maxLots = Math.floor(((equity * (CRYPTO_MAX_RISK_PCT / 100)) / slDist) / LOT_STEP) * LOT_STEP;
      return floorLots(Math.min(riskAmt / slDist, maxLots), LOT_CAPS.CRYPTO);
    }
    case 'OIL': {
      // BlackBull oil trades whole lots only, min 1 per leg, and runs 3 legs, so the
      // total is at least 3 (splitLegs spreads any integer total unevenly).
      const lots = Math.floor((riskAmt / (10.0 * (slDist / 0.01))) / 1.0) * 1.0;
      return Math.min(Math.max(lots, 3.0), LOT_CAPS.OIL);
    }
    case 'METAL':
      if (/XAU|GOLD/.test(sym))   return floorLots(riskAmt / (100 * slDist), LOT_CAPS.METAL);    // 1 lot = 100 oz
      if (/XAG|SILVER/.test(sym)) return floorLots(riskAmt / (5000 * slDist), LOT_CAPS.METAL);   // 1 lot = 5000 oz
      // ponytail: no contract size known for other metals — sized as FX, exactly as before.
      break;
  }
  if (/JPY/.test(sym)) return floorLots(riskAmt / (6.50 * (slDist / 0.01)), LOT_CAPS.FX);
  return floorLots(riskAmt / (10.0 * (slDist / 0.0001)), LOT_CAPS.FX);   // standard forex
}

// Split a total lot count into N legs, each >= minLeg, in `step` increments, with
// any remainder on the tail legs. Returns null if N legs at minLeg can't fit.
//   splitLegs(5, 3, 1, 1)          -> [1, 2, 2]
//   splitLegs(10, 3, 1, 1)         -> [3, 3, 4]
//   splitLegs(0.06, 3, 0.01, 0.01) -> [0.02, 0.02, 0.02]
export function splitLegs(totalLots, n, minLeg, step) {
  const totalUnits = Math.round(totalLots / step);
  const minUnits   = Math.round(minLeg / step);
  if (totalUnits < minUnits * n) return null;
  const base = Math.floor(totalUnits / n);
  const legs = Array(n).fill(base);
  let rem = totalUnits - base * n;
  for (let i = n - 1; i >= 0 && rem > 0; i--, rem--) legs[i] += 1;
  return legs.map(u => Number((u * step).toFixed(4)));
}
