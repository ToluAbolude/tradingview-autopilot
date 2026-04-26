import { evaluate } from "../src/connection.js";
await new Promise(r => setTimeout(r, 500));

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

        var perf = rd.performance || {};
        var all  = perf.all  || {};
        var lng  = perf.long || {};

        var out = {
          source: i,
          numTrades: (rd.trades || []).length,
          // perf.all (all trades)
          all_netProfit:         all.netProfit,
          all_grossProfit:       all.grossProfit,
          all_grossLoss:         all.grossLoss,
          all_totalTrades:       all.totalTrades,
          all_winTrades:         all.winTrades,
          all_lossTrades:        all.lossTrades,
          all_percentProfitable: all.percentProfitable,
          all_profitFactor:      all.profitFactor,
          all_maxDrawdown:       all.maxDrawdown,
          all_avgTrade:          all.avgTrade,
          all_avgWinTrade:       all.avgWinTrade,
          all_avgLossTrade:      all.avgLossTrade,
          all_ratioAvgWinAvgLoss:all.ratioAvgWinAvgLoss,
          // long only
          lng_totalTrades:       lng.totalTrades,
          lng_winTrades:         lng.winTrades,
          lng_percentProfitable: lng.percentProfitable,
          lng_netProfit:         lng.netProfit,
        };
        return JSON.stringify(out);
      } catch(e) {}
    }
    return 'Alpha Kill not found';
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log(r);
