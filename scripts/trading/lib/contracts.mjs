/**
 * contracts.mjs — the messages passed between services (docs/SERVICE_MAP.md, "Contracts").
 *
 * JSDoc types for editor/agent guidance, plus a validator for the one boundary
 * that needs it today: strategy output entering the execution path. A strategy is
 * pluggable code, so its signals are checked before anything sizes or places them.
 *
 * @typedef {Object} Bar
 * @property {number} t   bar open, unix MILLISECONDS (broker convention; chart bars
 *                        are seconds — convert at the edge, see scanner_confluence)
 * @property {number} o
 * @property {number} h
 * @property {number} l
 * @property {number} c
 * @property {number} [v]
 *
 * @typedef {Object} Signal   what a strategy emits: a view, not an order. No sizing,
 *                            no broker fields — those belong to later services.
 * @property {string} strategyId  stable id; becomes the order's owner tag
 * @property {string} symbol
 * @property {string} tf
 * @property {'long'|'short'} dir
 * @property {number} ts          unix ms of the bar that produced the signal
 * @property {number} entry
 * @property {number} sl          invalidation — where the idea is wrong
 * @property {number[]} [targets] profit targets, nearest first
 * @property {'market'|'limit'} [entryType]  default 'market'
 * @property {number} [score]
 * @property {string[]} [reasons]
 *
 * @typedef {Object} TradeIntent  a Signal after trade construction and sizing —
 *                                what order management receives
 * @property {Signal} signal
 * @property {number} entry
 * @property {number} sl
 * @property {{price: number, fraction: number}[]} tps  fractions sum to <= 1; the rest runs
 * @property {number} lots
 * @property {number} riskPct
 */

/** Everything wrong with a Signal, or [] when it is well-formed. */
export function signalErrors(s) {
  if (!s || typeof s !== 'object') return ['not an object'];
  const errors = [];
  if (typeof s.strategyId !== 'string' || !s.strategyId) errors.push('strategyId missing');
  if (typeof s.symbol !== 'string' || !s.symbol) errors.push('symbol missing');
  if (s.dir !== 'long' && s.dir !== 'short') errors.push(`dir must be long|short (got ${s.dir})`);
  for (const k of ['ts', 'entry', 'sl']) if (!Number.isFinite(s[k])) errors.push(`${k} is not a finite number`);
  const beyond = (price, from) => (s.dir === 'long' ? price > from : price < from);
  if (Number.isFinite(s.entry) && Number.isFinite(s.sl) && !beyond(s.entry, s.sl)) {
    errors.push(`sl ${s.sl} is on the wrong side of entry ${s.entry} for a ${s.dir}`);
  }
  for (const t of s.targets ?? []) {
    if (!Number.isFinite(t) || !beyond(t, s.entry)) errors.push(`target ${t} is not beyond entry ${s.entry} for a ${s.dir}`);
  }
  return errors;
}
