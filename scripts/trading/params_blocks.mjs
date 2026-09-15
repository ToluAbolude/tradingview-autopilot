/**
 * Block lifecycle — a block never outlives the trading week it was applied in.
 *
 * Two bugs made every block in this system permanent:
 *
 *   - the symbol sweep (eod_agent.mjs `unblocked`) only fires for symbols that HAVE an
 *     expiry key, and the live params file carried no blockedSymbolExpiry at all, so
 *     `undefined <= today` was false for all 7 blocked symbols;
 *   - there was never a session sweep in any code path — only the LLM volunteering to
 *     recommend an unblock, which it declined to do while it saw an "active expiry".
 *
 * So the tradeable universe only ever ratcheted down. ASIAN + LONDON both blocked left
 * the plan gate's 07:00-10:00 window dead with no route back, and four of the eight core
 * plan instruments got a written thesis every morning that could never be acted on.
 *
 * Policy (operator decision, 2026-08-21): blocks are a cooloff, not a sentence. A block
 * expires at the start of the next trading week, so it can never outlive the week it was
 * applied in — at most 7 days, always landing on a Monday boundary.
 *
 * Enforced at BOTH ends:
 *   - clampBlockExpiry() on write (apply_params.mjs, the chokepoint every recommendation
 *     funnels through) backfills a missing expiry and truncates an over-long one, so a
 *     30-day block cannot enter the file no matter what the nightly agent proposes;
 *   - applyBlockExpiry() on read (inline_trader, setup_finder) so a passed expiry stops
 *     binding the same day, whether or not the nightly agent ran.
 *
 * A block with NO expiry does not bind. Under this policy every block carries a
 * week-capped expiry by construction, so a missing one means malformed data — and the
 * operator's rule is that blocks always lift. Callers log it rather than failing silent.
 */

/** Start of the next trading week: the first Monday strictly after `from` (UTC, YYYY-MM-DD). */
export function nextTradingWeekStart(from = new Date()) {
  const d = new Date(from instanceof Date ? from.getTime() : Date.parse(from));
  d.setUTCHours(0, 0, 0, 0);
  const delta = ((8 - d.getUTCDay()) % 7) || 7;   // Mon→7, Tue→6, … Fri→3, Sat→2, Sun→1
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Write-side: every blocked key gets an expiry, capped at the end of this trading week. */
export function clampBlockExpiry(params, today = new Date()) {
  const cap = nextTradingWeekStart(today);
  const fix = (list, expiry) => {
    const keys = list || [];
    const out  = {};
    for (const k of keys) {
      const cur = (expiry || {})[k];
      out[k] = (cur && cur <= cap) ? cur : cap;   // backfill missing, truncate over-long
    }
    return out;                                    // orphaned expiries dropped with the block
  };
  return {
    ...params,
    blockedSymbolExpiry:  fix(params.blockedSymbols,  params.blockedSymbolExpiry),
    blockedSessionExpiry: fix(params.blockedSessions, params.blockedSessionExpiry),
  };
}

/** Read-side: a block binds only while it carries an expiry still in the future. */
export function applyBlockExpiry(params, today = new Date().toISOString().slice(0, 10)) {
  const live = (list, expiry) => (list || []).filter(k => {
    const e = (expiry || {})[k];
    return !!e && e > today;
  });
  return {
    ...params,
    blockedSymbols:  live(params.blockedSymbols,  params.blockedSymbolExpiry),
    blockedSessions: live(params.blockedSessions, params.blockedSessionExpiry),
  };
}
