import { evaluate } from "../src/connection.js";
await new Promise(r => setTimeout(r, 1000));

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

        // reportData is the top-level object
        var rd = s.reportData ? (typeof s.reportData === 'function' ? s.reportData() : s.reportData) : null;
        if (rd && typeof rd.value === 'function') rd = rd.value();

        if (!rd) return 'Alpha Kill found but no reportData (source ' + i + ')';

        // performance metrics are nested under rd.performance
        var perf = rd.performance || rd;
        var trades = rd.trades || [];
        var filled = rd.filledOrders || [];

        var keys = ['netProfit','grossProfit','grossLoss','totalTrades','winTrades',
                    'lossTrades','percentProfitable','profitFactor','maxDrawdown',
                    'sharpeRatio','sortinoRatio','avgTrade','avgWinTrade','avgLossTrade'];
        var out = { source: i, totalTrades: trades.length, filledOrders: filled.length };
        keys.forEach(function(k) { if (perf[k] !== undefined) out[k] = perf[k]; });

        return JSON.stringify(out);
      } catch(e) {}
    }
    return 'Alpha Kill not found';
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log(r);
