// Institutional Algo project — Phase D open item #3: M5/D1 history depth probe.
// Read-only: getSymbolSpec + getTrendbars sample windows at increasing ages.
import { getTrendbars, getSymbolSpec } from '/home/ubuntu/tradingview-autopilot/scripts/trading/broker_ctrader.mjs';

const SYMS = ['XAUUSD', 'US30', 'NAS100', 'SPX500', 'BTCUSD', 'ETHUSD'];
const DAY = 86400000;
const AGES = [30, 90, 180, 365, 545, 730, 1095, 1460]; // days back

for (const s of SYMS) {
  const spec = await getSymbolSpec(s).catch(e => ({ found: 'ERR', err: e.message }));
  const m5 = [];
  for (const age of AGES) {
    const to = Date.now() - age * DAY;
    try {
      // 5-day window so a weekend can't fake an empty result
      const bars = await getTrendbars(s, { period: 'M5', fromMs: to - 5 * DAY, toMs: to, windowDays: 5 });
      m5.push({ age, n: bars.length });
    } catch (e) {
      m5.push({ age, err: e.message.slice(0, 60) });
    }
  }
  let d1 = null;
  try {
    const bars = await getTrendbars(s, { period: 'D1', fromMs: Date.now() - 8 * 365 * DAY, toMs: Date.now(), windowDays: 300 });
    d1 = { n: bars.length, first: bars.length ? new Date(bars[0].t).toISOString().slice(0, 10) : null };
  } catch (e) { d1 = { err: e.message.slice(0, 80) }; }
  console.log(JSON.stringify({
    sym: s,
    found: spec.found, enabled: spec.enabled, tradingMode: spec.tradingMode,
    m5, d1,
  }));
}
process.exit(0);
