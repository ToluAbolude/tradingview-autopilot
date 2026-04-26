import { evaluate } from '/home/ubuntu/tradingview-mcp-jackson/src/connection.js';

const r = await evaluate(`(function(){
  try {
    var a = window.TradingViewApi._activeChartWidgetWV.value();
    var series = a._chartWidget.model().model().mainSeries();
    var data = series.data();
    var dataProto = Object.getOwnPropertyNames(Object.getPrototypeOf(data)).slice(0, 40);

    // Try bars()
    var barsObj = null;
    try { barsObj = data.bars(); } catch(e) {}
    var barsType = barsObj ? typeof barsObj : 'null';
    var barsProto = barsObj ? Object.getOwnPropertyNames(Object.getPrototypeOf(barsObj)).slice(0, 40) : [];

    // Try to get bar count
    var barCount = null;
    try { barCount = barsObj ? (barsObj.size ? barsObj.size() : (barsObj.length !== undefined ? barsObj.length : 'no size')) : 'no bars'; } catch(e) { barCount = e.message; }

    // Try to access first bar differently
    var firstBar = null;
    try {
      if (barsObj && barsObj.at) firstBar = barsObj.at(0);
      else if (barsObj && barsObj.getByIndex) firstBar = barsObj.getByIndex(0);
      else if (barsObj && barsObj.first) firstBar = barsObj.first();
      else if (Array.isArray(barsObj)) firstBar = barsObj[0];
    } catch(e) { firstBar = e.message; }

    return { dataProto, barsType, barsProto, barCount, firstBar };
  } catch(e) { return { error: e.message }; }
})()`);
console.log(JSON.stringify(r, null, 2));
