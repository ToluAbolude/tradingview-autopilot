// Institutional Algo project — Phase D open item #2: realized execution cost probe.
// Read-only. Part A: |closing-deal execPrice − M1 bar close| per symbol (proxy for
// effective half-spread + slippage; M1 granularity noise averages out in the median).
// Part B (--depth): D1 history depth for the TREND-PB FX universe.
import { getTrendbars, getAllClosedDeals } from '/home/ubuntu/tradingview-autopilot/scripts/trading/broker_ctrader.mjs';

const DAY = 86400000;
const UNIVERSE = new Set([
  'XAUUSD', 'US30', 'NAS100', 'SPX500', 'BTCUSD', 'ETHUSD',
  'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDCHF',
  'EURGBP', 'GBPJPY', 'AUDJPY', 'EURJPY', 'NZDCAD', 'GBPNZD',
]);
const doDepth = process.argv.includes('--depth');

// ---- Part A: realized deviation ----
const deals = await getAllClosedDeals(Date.now() - 45 * DAY);
const bySym = {};
for (const d of deals) {
  if (!UNIVERSE.has(d.symbolName) || !d.execPrice) continue;
  (bySym[d.symbolName] ||= []).push(d);
}
const costRows = [];
for (const [sym, ds] of Object.entries(bySym)) {
  const devs = [];
  for (const d of ds.slice(-40)) {
    try {
      const bars = await getTrendbars(sym, { period: 'M1', fromMs: d.execTs - 6 * 60000, toMs: d.execTs + 60000, windowDays: 1 });
      const bar = bars.filter(b => b.t <= d.execTs).sort((a, b) => b.t - a.t)[0];
      if (!bar) continue;
      const px = Number(d.execPrice);
      devs.push({ dev: Math.abs(px - bar.c), px });
    } catch { /* skip deal */ }
  }
  if (devs.length >= 3) {
    devs.sort((a, b) => a.dev - b.dev);
    const med = devs[Math.floor(devs.length / 2)];
    const p75 = devs[Math.floor(devs.length * 0.75)];
    costRows.push({
      sym, n: devs.length,
      medDev: +med.dev.toPrecision(3), p75Dev: +p75.dev.toPrecision(3),
      medDevBps: +(med.dev / med.px * 10000).toPrecision(3),
      p75DevBps: +(p75.dev / p75.px * 10000).toPrecision(3),
    });
  } else {
    costRows.push({ sym, n: devs.length, note: 'too few fills' });
  }
}
console.log('COSTS ' + JSON.stringify(costRows));

// ---- Part B: FX D1 depth ----
if (doDepth) {
  for (const sym of ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDCHF', 'EURGBP', 'GBPJPY', 'AUDJPY', 'EURJPY', 'NZDCAD', 'GBPNZD']) {
    try {
      const bars = await getTrendbars(sym, { period: 'D1', fromMs: Date.now() - 8 * 365 * DAY, toMs: Date.now(), windowDays: 300 });
      console.log('DEPTH ' + JSON.stringify({ sym, n: bars.length, first: bars.length ? new Date(bars[0].t).toISOString().slice(0, 10) : null }));
    } catch (e) {
      console.log('DEPTH ' + JSON.stringify({ sym, err: e.message.slice(0, 60) }));
    }
  }
}
process.exit(0);
