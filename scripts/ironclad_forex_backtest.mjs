/**
 * Ironclad MTF — backtest across the 5 CME Forex pairs mentioned in the video
 * EUR/USD, GBP/USD, AUD/USD, USD/CHF, USD/JPY — all on 15M
 * Strategy must already be on the chart (run ironclad_run3.mjs first)
 */
import { evaluate } from '../src/connection.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PAIRS = [
  { sym: 'BLACKBULL:EURUSD', label: 'EUR/USD' },
  { sym: 'BLACKBULL:GBPUSD', label: 'GBP/USD' },
  { sym: 'BLACKBULL:AUDUSD', label: 'AUD/USD' },
  { sym: 'BLACKBULL:USDCHF', label: 'USD/CHF' },
  { sym: 'BLACKBULL:USDJPY', label: 'USD/JPY' },
];

function parseResults(raw) {
  const t = raw.replace(/\s+/g, ' ');
  const trades   = t.match(/Total trade[s]?\s*([\d,]+)/i)?.[1]?.replace(',','') || '?';
  const winrate  = t.match(/Profitable trade[s]?\s*[\d.]+%\s*([\d.]+%)/i)?.[1]
                || t.match(/([\d.]+%)\s*\d+\/\d+/)?.[1] || '?';
  const pf       = t.match(/Profit factor\s*([\d.]+)/i)?.[1] || '?';
  const netpnl   = t.match(/Net P&(?:amp;)?L\s*([+\-]?[\d,]+\.?\d*\s*USD)/i)?.[1]
                || t.match(/Net P[&L]+\s*([+\-]?[\d,.]+USD)/i)?.[1] || '?';
  const pct      = t.match(/Net P&(?:amp;)?L[^%]*([+\-][\d.]+%)/i)?.[1] || '?';
  const dd       = t.match(/Max equity drawdown\s*[\d,.]+\s*USD\s*([\d.]+%)/i)?.[1] || '?';
  return { trades, winrate, pf, netpnl, pct, dd };
}

const results = [];

for (const pair of PAIRS) {
  process.stdout.write(`\nTesting ${pair.label}... `);

  // Switch symbol, keep 15M
  await evaluate(`(function(){
    var a = window.TradingViewApi._activeChartWidgetWV.value();
    a.setSymbol('${pair.sym}', null, true);
    a.setResolution('15');
  })()`);
  await sleep(5000);

  // Open strategy tester
  await evaluate(`window.TradingView.bottomWidgetBar.showWidget('backtesting')`);
  await sleep(5000);

  // Wait for results to populate (not "calculating...")
  let raw = '';
  for (let i = 0; i < 20; i++) {
    raw = await evaluate(`(function(){
      var el = document.querySelector('[class*="backtesting"]');
      if (!el) return '';
      return el.textContent.replace(/\\s+/g,' ');
    })()`);
    if (/Total trade/i.test(raw)) break;
    await sleep(1500);
  }

  const parsed = parseResults(raw);
  results.push({ ...pair, ...parsed });
  process.stdout.write(`${parsed.trades} trades | WR ${parsed.winrate} | PF ${parsed.pf} | ${parsed.pct}\n`);
}

console.log('\n═══════════════════════════════════════════════════════════');
console.log(' Ironclad MTF Market Structure — Forex Backtest Summary');
console.log(' Period: Nov 2025 – Apr 2026 | Timeframe: 15M | HTF: Daily');
console.log('═══════════════════════════════════════════════════════════');
console.log(` ${'Pair'.padEnd(10)} ${'Trades'.padEnd(8)} ${'WR'.padEnd(10)} ${'PF'.padEnd(8)} ${'Net%'.padEnd(10)} DD`);
console.log('─'.repeat(65));
for (const r of results) {
  console.log(` ${r.label.padEnd(10)} ${r.trades.padEnd(8)} ${r.winrate.padEnd(10)} ${r.pf.padEnd(8)} ${r.pct.padEnd(10)} ${r.dd}`);
}
console.log('═'.repeat(65));
