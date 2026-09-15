/**
 * instruments.mjs — what a symbol IS, in one place (docs/SERVICE_MAP.md, service #2).
 *
 * Asset-class detection used to be re-typed in every runner with slightly
 * different regexes (crypto with or without DOGE, indices with or without
 * GER30, metals with or without platinum). Pure, no I/O.
 */

// First match wins. Aliases are included so a broker or chart name classifies
// the same as its canonical label (USTEC = NAS100, DJ30 = US30, DE40 = GER40).
const CLASS_PATTERNS = [
  ['METAL',  /XAU|GOLD|XAG|SILVER|XPT|PLATINUM|COPPER/],
  ['OIL',    /WTI|USOIL|CRUDE|BRENT|UKOIL|NGAS/],
  ['INDEX',  /NAS|NDX|NQ|USTEC|US30|DJ30|DOW|YM|SPX|UK100|FTSE|GER40|GER30|DE40|DAX|JP225|AUS200|HK50|EUSTX50/],
  ['CRYPTO', /BTC|ETH|SOL|ADA|XRP|BNB|LTC|DOT|AVAX|DOGE/],
];

/** @returns {'METAL'|'OIL'|'INDEX'|'CRYPTO'|'FX'} */
export function instrumentClass(symbol) {
  const s = String(symbol ?? '').toUpperCase();
  for (const [cls, re] of CLASS_PATTERNS) if (re.test(s)) return cls;
  return 'FX';
}

export const isCrypto = symbol => instrumentClass(symbol) === 'CRYPTO';

// The eight instruments daily_plan.mjs writes a plan for (2026-07-30 cutover).
// Chosen from the ledger: metals, indices, USD majors and BTC netted positive
// while the 28 non-USD crosses lost -$7,790.
export const CORE_UNIVERSE = ['XAUUSD', 'NAS100', 'US30', 'GER40', 'EURUSD', 'GBPUSD', 'USDJPY', 'BTCUSD'];

// Minimum stop distance as a fraction of entry price. The 2026-06-06 USDCHF
// signal had a 1-pip stop off a frozen ATR, which blew risk-based sizing up to
// the lot cap (-$5,659). FX 0.08% is about 6-8 pips on the majors.
export const MIN_SL_FRAC = { FX: 0.0008, METAL: 0.0012, OIL: 0.004, INDEX: 0.0015, CRYPTO: 0.003 };
