/**
 * Remove all strategies EXCEPT Alpha Kill / AK test from chart.
 * This will make Alpha Kill the only strategy, auto-selecting it in
 * the Strategy Tester so its backtest data gets populated.
 */
import { evaluate } from "../src/connection.js";
const sleep = ms => new Promise(r => setTimeout(r, ms));

await sleep(500);

const result = await evaluate(`(function(){
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    var studies = chart.getAllStudies ? chart.getAllStudies() : [];
    var removed = [];
    for (var i = 0; i < studies.length; i++) {
      var s = studies[i];
      var name = (s.name || (s.metaInfo && s.metaInfo().shortTitle) || '').toLowerCase();
      // Remove OkalaNQ but KEEP Alpha Kill / AK
      if (/okala|okalanq/i.test(name)) {
        chart.removeEntity(s.id, { disableUndo: true });
        removed.push(name);
      }
    }
    return 'removed: ' + removed.length + ' (' + removed.join(', ') + ')';
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Remove OkalaNQ:', result);

await sleep(3000);

// Check what's left
const remaining = await evaluate(`(function(){
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    var studies = chart.getAllStudies ? chart.getAllStudies() : [];
    return studies.map(function(s) { return s.name || '?'; }).join(', ');
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Remaining studies:', remaining);

// Wait for backtest to calculate
console.log('Waiting 30s for backtest to calculate...');
await sleep(30000);

// Read Alpha Kill results
const perf = await evaluate(`(function(){
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var src = chart.model().model().dataSources();
    for (var i = 0; i <= Math.max(src.length || 0, 100); i++) {
      var s = src[i];
      if (!s || !s.metaInfo) continue;
      try {
        var m = s.metaInfo();
        var n = m.description || m.shortTitle || '';
        if (!/Alpha Kill|AK_Simple|AK_v/i.test(n)) continue;

        var rd = s.reportData ? (typeof s.reportData === 'function' ? s.reportData() : s.reportData) : null;
        if (rd && typeof rd.value === 'function') rd = rd.value();

        var trades = rd && rd.trades ? rd.trades.length : -1;
        var perf = rd && rd.performance && rd.performance.all ? rd.performance.all : {};
        return JSON.stringify({
          source: i, name: n, trades: trades,
          totalTrades: perf.totalTrades,
          winTrades: perf.winTrades,
          percentProfitable: perf.percentProfitable,
          netProfit: perf.netProfit,
          profitFactor: perf.profitFactor
        });
      } catch(e) {}
    }
    return 'AK strategy not found';
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Alpha Kill performance:', perf);
