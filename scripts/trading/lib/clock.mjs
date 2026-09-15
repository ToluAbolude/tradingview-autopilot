/**
 * clock.mjs — market-time rules in one place (docs/SERVICE_MAP.md, service #3).
 *
 * Every function takes `now`, so the rules are testable and no runner needs its
 * own copy of a boundary. Two different "weekends" exist on purpose, because they
 * answer different questions:
 *   isCalendarWeekend  Sat/Sun UTC — runners idle and the EOD job flattens.
 *   isFxWeekend        FX/metals/indices actually shut — all Saturday, and Sunday
 *                      before the ~22:00 UTC reopen. inline_trader's entry gate.
 */

export function isCalendarWeekend(now = new Date()) {
  const d = now.getUTCDay();
  return d === 0 || d === 6;
}

export function isFxWeekend(now = new Date()) {
  const d = now.getUTCDay();
  return d === 6 || (d === 0 && now.getUTCHours() < 22);
}

// Sun 21:00-24:00 UTC: thin books, wide spreads and gap risk at the FX reopen.
// The 2026-07-20 -$2.5k Monday started with entries placed into this window.
export function isSundayReopen(now = new Date()) {
  return now.getUTCDay() === 0 && now.getUTCHours() >= 21;
}

// Crypto trades 24/7 on a live feed, so by default it is exempt from the weekend
// block (WEEKEND_CRYPTO) and from the late-entry cutoffs (CRYPTO_LATE).
export const weekendCryptoOn = () => (process.env.WEEKEND_CRYPTO ?? 'on') !== 'off';
export const cryptoLateOn    = () => (process.env.CRYPTO_LATE ?? 'on') !== 'off';

// ── Trade windows (2026-08-17) ───────────────────────────────────────────────
// Originate entries ONLY at London open and NY open. Intraday FX/index volatility
// is periodic with peaks at these two opens (Andersen & Bollerslev 1997); the ORB
// literature's edge (Zarattini et al.) lives entirely in the cash-open window; and
// our own ledger's worst close-hours were the rollover (h21-h22, -$5.7k) and
// mid-NY chop. Format "H:MM-H:MM,..." UTC, half-open [start, end). Applies at
// ORDER PLACEMENT — a resting limit placed in-window may fill later at its planned
// level. Kill switch: TRADE_WINDOWS=off.
export const TRADE_WINDOWS_SPEC = process.env.PLAN_WINDOWS ?? '7:00-10:00,12:30-16:00';
const WINDOWS = TRADE_WINDOWS_SPEC.split(',').map(w =>
  w.split('-').map(s => { const [h, m] = s.split(':').map(Number); return h + (m || 0) / 60; }));

export function inTradeWindow(now = new Date()) {
  if ((process.env.TRADE_WINDOWS ?? 'on') === 'off') return true;
  const h = now.getUTCHours() + now.getUTCMinutes() / 60;
  return WINDOWS.some(([a, b]) => h >= a && h < b);
}

// Non-crypto entry cutoffs ahead of the 20:00 UTC EOD flatten (post-NY thinning +
// the FX rollover spread spike). Returns the skip reason, or null when entries are open.
export function entryCutoff(now = new Date()) {
  const d = now.getUTCDay(), h = now.getUTCHours(), m = now.getUTCMinutes();
  if (h >= 20 && d !== 0) return 'Past 20:00 UTC EOD cutoff';
  if (d !== 0 && h === 19 && m >= 30) return 'Past 19:30 last-entry cutoff';
  if (d === 5 && h * 60 + m >= 21 * 60) return 'Friday 21:00 UTC cutoff';
  return null;
}

// Session label for inline_trader's blockedSessions and crypto-Asian gates.
export function currentSession(now = new Date()) {
  const h = now.getUTCHours(), d = now.getUTCDay();
  if (d === 0 && h >= 22) return 'ASIAN';
  if (h >= 12 && h < 16) return 'LONDON-NY-OVERLAP';
  if (h >= 7 && h < 12) return 'LONDON';
  if (h >= 16 && h < 20) return 'NY';
  if (h >= 0 && h < 7) return 'ASIAN';
  return 'DEAD-ZONE';
}
