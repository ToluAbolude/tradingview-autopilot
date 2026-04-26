import { evaluate } from "../src/connection.js";
await new Promise(r => setTimeout(r, 1000));

const r = await evaluate(`(function(){
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var src = chart.model().model().dataSources();
    var out = [];
    for (var i = 0; i < src.length; i++) {
      var s = src[i];
      if (!s.metaInfo) continue;
      try {
        var m = s.metaInfo();
        var n = m.description || m.shortTitle || '';
        var rd = s.reportData ? (typeof s.reportData === 'function' ? s.reportData() : s.reportData) : null;
        if (rd && typeof rd.value === 'function') rd = rd.value();
        var trades = rd && rd.trades ? rd.trades.length : '?';
        out.push(i + ':' + n + '(trades=' + trades + ')');
      } catch(e) { out.push(i + ':err'); }
    }
    return out.join('\\n');
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log(r);
