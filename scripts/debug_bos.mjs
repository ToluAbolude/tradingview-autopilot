import { evaluate } from "../src/connection.js";
await new Promise(r => setTimeout(r, 500));

// Read strategy internals: check if reportData has trades, and also check
// the performance sub-object structure more deeply
const r = await evaluate(`(function(){
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var src = chart.model().model().dataSources();
    for (var i = 0; i < src.length; i++) {
      var s = src[i];
      if (!s.metaInfo) continue;
      try {
        var m = s.metaInfo();
        if ((m.description || '').indexOf('Alpha Kill') < 0) continue;

        var rd = s.reportData ? (typeof s.reportData === 'function' ? s.reportData() : s.reportData) : null;
        if (rd && typeof rd.value === 'function') rd = rd.value();
        if (!rd) return 'no reportData at source ' + i;

        // Dig into all keys recursively one level
        var out = { source: i };
        var topKeys = Object.keys(rd);
        out.topKeys = topKeys;

        // Check trades array
        var trades = rd.trades || [];
        out.numTrades = trades.length;

        // Check performance object keys
        var perf = rd.performance || {};
        out.perfKeys = Object.keys(perf).slice(0, 30);

        // Get actual values from performance
        var statsKeys = ['netProfit','totalTrades','winTrades','lossTrades',
                         'percentProfitable','profitFactor','maxDrawdown'];
        statsKeys.forEach(function(k) {
          if (perf[k] !== undefined) out[k] = perf[k];
        });

        return JSON.stringify(out);
      } catch(e) {}
    }
    return 'Alpha Kill not found';
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log(r);
