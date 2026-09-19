/**
 * Runs the Chart Fanatics marco_liquidity detector (scripts/trading/cfs/) as a manifest
 * strategy: the detector's own signals, re-bracketed by the runner from the manifest
 * (risk.stop_mult, target.r), exactly as strategy_lab chose. params.config names which
 * of the detector's configs to run.
 */
import { configs, signals } from '../../cfs/marco_liquidity.mjs';
import { atr14 } from '../../cfs_backtest.mjs';

export default {
  name: 'marco_liquidity',

  generateSignals(bars, ctx) {
    const cfg = configs.find(c => c.name === ctx.params?.config);
    if (!cfg) throw new Error(`marco_liquidity has no config "${ctx.params?.config}"`);
    return signals(bars, atr14(bars), cfg).map(s => ({
      ts: bars[s.i].t, dir: s.dir, entry: s.entry, sl: s.stop, tp: s.tp, reason: s.label,
    }));
  },
};
