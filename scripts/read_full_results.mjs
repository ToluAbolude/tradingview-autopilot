import { evaluate } from '../src/connection.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Read complete strategy tester DOM
const fullDom = await evaluate(`(function(){
  var el = document.querySelector('[class*="backtesting"]');
  if (!el) return 'no panel';
  return el.textContent.replace(/\s+/g,' ');
})()`);
console.log('=== FULL TESTER DOM ===');
console.log(fullDom.substring(0, 3000));

// Read strategy inputs via the chart API
const inputs = await evaluate(`(function(){
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    // Try to find the alpha kill strategy via all panes
    var allSources = [];
    var panes = typeof chart.getPanes === 'function' ? chart.getPanes() : [];
    for (var p = 0; p < panes.length; p++) {
      var sources = typeof panes[p].getSources === 'function' ? panes[p].getSources() : [];
      for (var s = 0; s < sources.length; s++) {
        var src = sources[s];
        try {
          var mi = src.metaInfo ? src.metaInfo() : null;
          if (mi) {
            allSources.push({
              id: src.id,
              name: mi.shortTitle || mi.name,
              type: mi.type,
              inputs: src.getInputsInfo ? src.getInputsInfo() : null
            });
          }
        } catch(e) {}
      }
    }
    return JSON.stringify(allSources.slice(0,5));
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('\n=== CHART SOURCES ===');
console.log(inputs);

// Get full reportData via JS
const reportData = await evaluate(`(function(){
  try {
    var sources = window.TradingViewApi.dataSources ? window.TradingViewApi.dataSources() : null;
    if (!sources) return 'no dataSources';
    var results = [];
    sources.forEach(function(src, i) {
      if (!src || !src.reportData) return;
      var rd = src.reportData;
      if (rd && rd.performance) {
        results.push(JSON.stringify({ i: i, perf: rd.performance.all || rd.performance }));
      }
    });
    return results.join('\n');
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('\n=== REPORT DATA ===');
console.log(reportData);

// Check chart symbol and timeframe
const chartInfo = await evaluate(`(function(){
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    return JSON.stringify({
      symbol: chart.symbol ? chart.symbol() : 'n/a',
      resolution: chart.resolution ? chart.resolution() : 'n/a',
    });
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('\n=== CHART INFO ===');
console.log(chartInfo);
