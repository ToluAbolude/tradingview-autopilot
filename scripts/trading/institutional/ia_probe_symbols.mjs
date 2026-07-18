// Probe candidate session-structured index CFDs on the cTrader account
// (FINDINGS §4: widen the SMORB universe). Read-only.
import { getSymbolSpec, getTrendbars } from '../broker_ctrader.mjs';

const CANDIDATES = [
  'DE40', 'GER40', 'DAX40', 'DE30', 'GER30',
  'UK100', 'FTSE100',
  'JP225', 'JPN225', 'NIK225', 'JPN225.cash',
  'HK50', 'HSI50', 'HongKong50',
  'AUS200', 'ASX200',
  'EU50', 'STOXX50', 'EUSTX50',
  'FRA40', 'F40', 'CAC40',
  'ES35', 'SPA35', 'IBEX35',
  'US2000', 'RUT2000', 'USDX',
];
const DAY = 86400_000;

for (const name of CANDIDATES) {
  try {
    const s = await getSymbolSpec(name);
    if (!s.found) { console.log(name.padEnd(12), 'not found'); continue; }
    let m5 = null;
    try {
      const bars = await getTrendbars(name, { period: 'M5', fromMs: Date.now() - 3 * 365 * DAY - 5 * DAY, toMs: Date.now() - 3 * 365 * DAY, windowDays: 5 });
      m5 = bars.length;
    } catch (e) { m5 = 'ERR ' + e.message.slice(0, 30); }
    console.log(name.padEnd(12), JSON.stringify({ enabled: s.enabled, tradingMode: s.tradingMode, m5BarsAt3y: m5 }));
  } catch (e) {
    console.log(name.padEnd(12), 'ERR', e.message.slice(0, 60));
  }
}
process.exit(0);
