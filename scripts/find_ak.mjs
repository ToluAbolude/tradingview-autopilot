import { evaluate } from "../src/connection.js";
await new Promise(r => setTimeout(r, 1000));

// Search ALL data sources including high indices for any Alpha Kill
const r = await evaluate(`(function(){
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var src = chart.model().model().dataSources();
    var results = [];
    // src might be a sparse array or have length > what we've seen
    var maxIdx = Math.max(src.length || 0, 100);
    for (var i = 0; i <= maxIdx; i++) {
      var s = src[i];
      if (!s || !s.metaInfo) continue;
      try {
        var m = s.metaInfo();
        var n = m.description || m.shortTitle || '';
        var rd = s.reportData ? (typeof s.reportData === 'function' ? s.reportData() : s.reportData) : null;
        if (rd && typeof rd.value === 'function') rd = rd.value();
        var nt = rd && rd.trades ? rd.trades.length : -1;
        results.push({ i: i, n: n, trades: nt });
      } catch(e) {}
    }
    // Return all with Alpha Kill or those with trade data
    var ak = results.filter(function(x){ return x.n.indexOf('Alpha Kill') >= 0 || x.n.indexOf('AK_v') >= 0; });
    var withTrades = results.filter(function(x){ return x.trades > 0; });
    return JSON.stringify({ ak: ak, withTrades: withTrades, total: results.length });
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log(r);
