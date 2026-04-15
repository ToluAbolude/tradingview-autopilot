/**
 * Symbol sweep — test Smart Trail HA Scalper across instruments.
 * Usage: node scripts/symbol_sweep.mjs
 */
import { evaluate } from '../src/connection.js';

const SYMBOLS = [
  'BLACKBULL:NAS100',
  'BLACKBULL:SPX500',
  'BLACKBULL:US30',
  'BLACKBULL:XAUUSD',
  'BLACKBULL:GBPUSD',
  'BLACKBULL:EURUSD',
  'BLACKBULL:BTCUSD',
  'BLACKBULL:ETHUSD',
];

const CHART_API = "window.TradingViewApi._activeChartWidgetWV.value()";

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function setSymbol(sym) {
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setSymbol('${sym}', null, true);
    })()
  `);
}

async function getStratMetrics(stratName) {
  return evaluate(`
    (function() {
      var chart = ${CHART_API}._chartWidget;
      var sources = chart.model().model().dataSources();
      var strat = null;
      for (var i = 0; i < sources.length; i++) {
        var s = sources[i];
        if (!s.metaInfo) continue;
        try {
          var desc = s.metaInfo().description || '';
          if (desc.indexOf('${stratName}') >= 0) { strat = s; break; }
        } catch(e) {}
      }
      if (!strat) return { error: 'not found' };
      var rd = null;
      try {
        rd = strat.reportData ? (typeof strat.reportData === 'function' ? strat.reportData() : strat.reportData) : null;
        if (rd && typeof rd.value === 'function') rd = rd.value();
      } catch(e) { return { error: 'reportData error: ' + e.message }; }
      if (!rd || !rd.performance || !rd.performance.all) return { error: 'no perf data', rdKeys: rd ? Object.keys(rd).join(',') : 'null' };
      var all = rd.performance.all;
      var lng = rd.performance.long || {};
      var shrt = rd.performance.short || {};
      var perf = rd.performance;
      return {
        trades:     all.totalTrades || 0,
        netPnl:     Math.round((all.netProfit || 0) * 100) / 100,
        grossProfit: Math.round((all.grossProfit || 0) * 100) / 100,
        grossLoss:  Math.round((all.grossLoss || 0) * 100) / 100,
        commission: Math.round((all.commissionPaid || 0) * 100) / 100,
        winRate:    Math.round(((all.percentProfitable || 0) * 100) * 100) / 100,
        pf:         Math.round((all.profitFactor || 0) * 1000) / 1000,
        avgWin:     Math.round((all.avgWinTrade || 0) * 100) / 100,
        avgLoss:    Math.round((all.avgLosTrade || 0) * 100) / 100,
        maxDD:      Math.round((perf.maxStrategyDrawDown || 0) * 100) / 100,
        maxDDPct:   Math.round((perf.maxStrategyDrawDownPercent || 0) * 10000) / 100,
        sharpe:     Math.round((perf.sharpeRatio || 0) * 1000) / 1000,
        longTrades: lng.totalTrades || 0,
        longWR:     Math.round(((lng.percentProfitable || 0) * 100) * 100) / 100,
        longPnl:    Math.round((lng.netProfit || 0) * 100) / 100,
        shortTrades: shrt.totalTrades || 0,
        shortWR:    Math.round(((shrt.percentProfitable || 0) * 100) * 100) / 100,
        shortPnl:   Math.round((shrt.netProfit || 0) * 100) / 100,
      };
    })()
  `);
}

async function main() {
  const results = [];

  for (const sym of SYMBOLS) {
    process.stdout.write(`Testing ${sym}... `);
    try {
      await setSymbol(sym);
      await sleep(5000); // wait for strategy tester to recompute

      const metrics = await getStratMetrics('Smart Trail');
      if (metrics && metrics.error) {
        console.log(`SKIP (${metrics.error})`);
        results.push({ sym, error: metrics.error });
      } else {
        console.log(`✓  ${metrics.trades} trades | net $${metrics.netPnl} | WR ${metrics.winRate}% | PF ${metrics.pf}`);
        results.push({ sym, ...metrics });
      }
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      results.push({ sym, error: err.message });
    }
  }

  console.log('\n\n=== SYMBOL SWEEP RESULTS — Smart Trail HA Scalper (1M, Both, Mar–Apr 2026) ===\n');
  console.log('Symbol'.padEnd(24), 'Trades'.padEnd(8), 'Net P&L'.padEnd(12), 'WR%'.padEnd(8), 'PF'.padEnd(8), 'MaxDD'.padEnd(10), 'Sharpe'.padEnd(8), 'L-WR%'.padEnd(8), 'S-WR%');
  console.log('-'.repeat(110));

  results
    .filter(r => !r.error && r.trades > 0)
    .sort((a, b) => b.netPnl - a.netPnl)
    .forEach(r => {
      console.log(
        r.sym.padEnd(24),
        String(r.trades).padEnd(8),
        `$${r.netPnl}`.padEnd(12),
        `${r.winRate}%`.padEnd(8),
        String(r.pf).padEnd(8),
        `-$${Math.abs(r.maxDD)}`.padEnd(10),
        String(r.sharpe).padEnd(8),
        `${r.longWR}%`.padEnd(8),
        `${r.shortWR}%`
      );
    });

  results.filter(r => r.error || r.trades === 0).forEach(r => {
    console.log(`${r.sym.padEnd(24)} → ${r.error || '0 trades'}`);
  });

  console.log('\n--- Full JSON ---');
  console.log(JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
