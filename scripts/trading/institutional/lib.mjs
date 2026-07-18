// Institutional Algorithm — shared pure library (research/institutional_algo/SPEC.md).
// PURE by design: no broker/network/fs imports. The exact functions the backtest
// uses are the ones the live runners will call — Stage-2 signal fidelity depends
// on this file staying I/O-free.

// ---- SPEC §3: measured round-trip costs (bps of price), frozen rule ----
export const COST_RT_BPS = {
  EURUSD: 2, AUDUSD: 4, NZDUSD: 5, NZDCAD: 4, GBPJPY: 4, AUDJPY: 5,
  USDCHF: 9, GBPUSD: 4, USDJPY: 4, USDCAD: 4, EURGBP: 4, EURJPY: 4,
  GBPNZD: 8, XAUUSD: 6, SPX500: 4, US30: 6, NAS100: 4, BTCUSD: 15, ETHUSD: 20,
  // Widened index universe (FINDINGS §4) — ASSUMED index-class defaults, no
  // fills to measure from yet. Any positive result must survive a 1.5× cost
  // stress before being believed.
  UK100: 6, JP225: 6, AUS200: 6, EUSTX50: 6, FRA40: 6, GER40: 6, HK50: 8,
};

export function roundTripCostPrice(symbol, price) {
  const bps = COST_RT_BPS[symbol];
  if (bps == null) throw new Error(`No cost entry for ${symbol} — add to COST_RT_BPS (SPEC §3)`);
  return price * bps / 10000;
}

// ---- SPEC §1/§6: session definitions ----
export const SESSIONS = [
  { name: 'ASIA', openUTC: '00:00', symbols: ['XAUUSD', 'US30', 'NAS100'] },
  { name: 'LONDON', openUTC: '07:00', symbols: ['SPX500'] },
  { name: 'NY', openNY: '09:30', symbols: ['BTCUSD', 'ETHUSD'] },
];

/** UTC ms of 09:30 America/New_York on a given UTC calendar date (DST-aware). */
export function nyOpenUtcMs(y, m, d) { // m is 1-12
  for (const offH of [4, 5]) { // EDT = UTC-4, EST = UTC-5
    const guess = Date.UTC(y, m - 1, d, 9 + offH, 30);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(guess));
    const hh = parts.find(p => p.type === 'hour').value;
    const mm = parts.find(p => p.type === 'minute').value;
    if (hh === '09' && mm === '30') return guess;
  }
  throw new Error(`nyOpenUtcMs: could not resolve NY open for ${y}-${m}-${d}`);
}

// ---- Indicators (pure) ----
export function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

/** Wilder-smoothed ATR over [{o,h,l,c}] bars. */
export function atr(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)));
  }
  let a = trs.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return a;
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---- Bracket resolution (gap-aware, house-conservative) ----
/**
 * Walk bars strictly AFTER entry and resolve a bracket:
 *  - a bar OPENING beyond a level fills at bar.o, not the level (models
 *    overnight/weekend gaps — SPEC §2 EOD decision requires this)
 *  - a bar touching BOTH SL and TP counts as a LOSS (house replay convention)
 * Returns { outcome: 'tp'|'sl'|'open', exitPrice, exitTs, grossR }.
 */
export function simulateBracket({ bars, direction, entry, sl, tp }) {
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) throw new Error('simulateBracket: zero risk distance');
  const long = direction === 'long';
  const rOf = px => (long ? px - entry : entry - px) / risk;
  for (const b of bars) {
    if (long ? b.o <= sl : b.o >= sl) return { outcome: 'sl', exitPrice: b.o, exitTs: b.t, grossR: rOf(b.o) };
    if (long ? b.o >= tp : b.o <= tp) return { outcome: 'tp', exitPrice: b.o, exitTs: b.t, grossR: rOf(b.o) };
    const hitSL = long ? b.l <= sl : b.h >= sl;
    if (hitSL) return { outcome: 'sl', exitPrice: sl, exitTs: b.t, grossR: -1 };
    const hitTP = long ? b.h >= tp : b.l <= tp;
    if (hitTP) return { outcome: 'tp', exitPrice: tp, exitTs: b.t, grossR: rOf(tp) };
  }
  return { outcome: 'open', exitPrice: null, exitTs: null, grossR: null };
}

/** Net R after the SPEC §3 round-trip cost, expressed in R of this trade. */
export function netR({ grossR, entry, sl, symbol }) {
  const risk = Math.abs(entry - sl);
  return grossR - roundTripCostPrice(symbol, entry) / risk;
}
