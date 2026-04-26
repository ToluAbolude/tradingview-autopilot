import { evaluate } from '/home/ubuntu/tradingview-mcp-jackson/src/connection.js';

const r = await evaluate(`(function(){
  try {
    var a = window.TradingViewApi._activeChartWidgetWV.value();
    var barsObj = a._chartWidget.model().model().mainSeries().data().bars();
    var sample = [];
    var count = 0;
    barsObj.each(function(idx, bar) {
      if (count < 3) {
        sample.push({
          idx: idx,
          barType: typeof bar,
          barKeys: bar ? Object.keys(bar).slice(0,10) : [],
          barVal: bar,
          barStr: JSON.stringify(bar).substring(0,100)
        });
        count++;
      }
    });
    // Also try valueAt
    var va0 = barsObj.valueAt(0);
    var va1 = barsObj.valueAt(1);
    return { sample, va0, va1, size: barsObj.size() };
  } catch(e) { return { error: e.message }; }
})()`);
console.log(JSON.stringify(r, null, 2));
