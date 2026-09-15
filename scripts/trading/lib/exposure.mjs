/**
 * exposure.mjs — how many positions an account may hold on one symbol, and whose
 * they are (docs/SERVICE_MAP.md, "Several strategies on the same instrument"). Pure.
 *
 * Replaces the flat "no stacking" rule. Both cTrader accounts are HEDGING, so the
 * broker allows several positions per symbol; this policy decides what the system
 * allows. The default reproduces the old rule exactly — one position per symbol,
 * account-wide — so nothing changes until trading_params.json raises a limit:
 *
 *   "exposure": {
 *     "default": { "maxPositionsPerSymbol": 1 },
 *     "2131377": { "maxPositionsPerSymbol": 3, "maxPerStrategyPerSymbol": 1, "allowOppositeDirections": false }
 *   }
 */

export const DEFAULT_EXPOSURE = Object.freeze({
  maxPositionsPerSymbol: 1,         // across every strategy on the account
  maxPerStrategyPerSymbol: 1,       // per strategy label — keeps the June 6 re-fire protection
  allowOppositeDirections: false,   // a long and a short on one symbol = two spreads, no net position
});

/** Policy for an account: defaults ← exposure.default ← exposure[accountId]. Bad values fall back to the default. */
export function exposurePolicy(params, accountId) {
  const e = params?.exposure || {};
  const p = { ...DEFAULT_EXPOSURE, ...e.default, ...e[String(accountId ?? '')] };
  for (const k of ['maxPositionsPerSymbol', 'maxPerStrategyPerSymbol']) {
    if (!(Number.isInteger(p[k]) && p[k] >= 1)) p[k] = DEFAULT_EXPOSURE[k];
  }
  p.allowOppositeDirections = p.allowOppositeDirections === true;
  return p;
}

/**
 * May a new `dir` position owned by `label` open, given the positions already open on
 * the same symbol ([{ direction, label }])? Unlabeled positions (opened before orders
 * carried labels, or by hand) count toward the account cap only.
 */
export function exposureVerdict({ positions = [], dir, label = '', policy = DEFAULT_EXPOSURE }) {
  if (positions.length >= policy.maxPositionsPerSymbol) {
    return { ok: false, reason: `${positions.length} position(s) already open on this symbol (account cap ${policy.maxPositionsPerSymbol})` };
  }
  const own = label ? positions.filter(p => p.label === label).length : 0;
  if (label && own >= policy.maxPerStrategyPerSymbol) {
    return { ok: false, reason: `${label} already holds ${own} position(s) on this symbol (cap ${policy.maxPerStrategyPerSymbol})` };
  }
  if (!policy.allowOppositeDirections && positions.some(p => p.direction !== dir)) {
    return { ok: false, reason: 'an opposite-direction position is open on this symbol' };
  }
  return { ok: true };
}
