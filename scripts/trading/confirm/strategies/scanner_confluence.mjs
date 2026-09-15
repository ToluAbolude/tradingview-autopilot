/**
 * scanner_confluence.mjs — the market scanner's confluence engine as a strategy module.
 *
 * Same contract as the other modules in this folder: generateSignals(bars, ctx)
 * returns Signal[] (lib/contracts.mjs), so a generic runner can load it like any
 * other strategy. The logic is not a copy — scoreTimeframe and buildSetups are the
 * functions market_scanner.mjs runs live through scanForSetups, so this module and
 * the live scanner cannot drift apart.
 *
 * Multi-timeframe: pass bars for every timeframe in ctx.barsByTf
 * ({ '1': Bar[], '5': Bar[], '15': Bar[], '60': Bar[], ... }). Pass 1 scores the
 * timeframes present; pass 2 needs '15' (entry) and '60' (SL/TP geometry). Bar times
 * may be unix ms or seconds; the engine works in seconds.
 */
import { scoreTimeframe, buildSetups, PER_TF_BARS } from '../../setup_finder.mjs';
import { CORE_UNIVERSE } from '../../lib/instruments.mjs';

export const STRATEGY_ID = 'scanner_confluence';

const toSeconds = bars => (bars || []).map(b => (b.t > 1e11 ? { ...b, t: Math.floor(b.t / 1000) } : b));

/** A scanForSetups setup as a Signal. `ts` is the bar time in ms when known. */
export function toSignal(setup, ts = Date.now()) {
  const nearestFirst = (a, b) => (setup.dir === 'long' ? a - b : b - a);
  return {
    strategyId: STRATEGY_ID,
    symbol:     setup.label,
    tf:         setup.tf,
    dir:        setup.dir,
    ts,
    entry:      setup.entry,
    sl:         setup.sl,
    targets:    [setup.tp1, setup.tp2, setup.tp3].filter(Number.isFinite).sort(nearestFirst),
    entryType:  'market',
    score:      setup.score,
    reasons:    setup.reasons,
  };
}

export default {
  name: STRATEGY_ID,
  description: 'Multi-timeframe confluence scanner: vote score per TF, 15M entry, H1-structure SL/TP, at least 2R',
  timeframes: ['1', '5', '15', '30', '60', '240', 'D', 'W'],
  universe: CORE_UNIVERSE,
  defaultParams: { minScore: 3, autoShort: true },   // minScore mirrors trading_params.pass1MinScore

  generateSignals(bars, ctx = {}) {
    const p = { ...this.defaultParams, ...ctx.params };
    const byTf = Object.fromEntries(Object.entries(ctx.barsByTf || {}).map(([tf, b]) => [tf, toSeconds(b)]));
    const inst = { sym: ctx.symbol, label: ctx.symbol, tfs: Object.keys(byTf), autoShort: p.autoShort, tier: 3 };
    const now = ctx.now || new Date();
    const utcHour = now.getUTCHours();

    // Same floor the live scan applies: a timeframe with too few bars is skipped.
    const candidates = inst.tfs
      .filter(tf => byTf[tf].length >= (PER_TF_BARS[tf]?.min ?? 200))
      .flatMap(tf => scoreTimeframe(byTf[tf], inst, tf, utcHour, p.minScore).candidates);
    if (!candidates.length) return [];

    const bars15 = byTf['15'];
    const ts = bars15?.length ? bars15[bars15.length - 1].t * 1000 : now.getTime();
    return buildSetups({ inst, candidates, bars15, bars60: byTf['60'], utcHour, now })
      .filter(ev => ev.setup)
      .map(ev => toSignal(ev.setup, ts));
  },
};
