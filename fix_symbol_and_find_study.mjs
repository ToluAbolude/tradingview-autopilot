import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
const client = await CDP({ host: "132.145.44.68", port: 9222, target: "https://www.tradingview.com/chart/OPckidUz/" });
const { Runtime } = client;
await Runtime.enable();

// 1. Switch to XAUUSD 15m
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var api = window.TradingViewApi;
      var col = api._chartWidgetCollection;
      var aw = col.activeChartWidget ? col.activeChartWidget() : (api._activeChartWidgetWV ? api._activeChartWidgetWV.value() : null);
      if (!aw) return "no active widget";
      aw.setSymbol("BLACKBULL:XAUUSD");
      return "setSymbol XAUUSD called";
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("symbol switch:", r1.result.value);

await new Promise(r => setTimeout(r, 2000));

// 2. Find all studies on the chart
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var api = window.TradingViewApi;
      var col = api._chartWidgetCollection;
      var aw = col.activeChartWidget ? col.activeChartWidget() : api._activeChartWidgetWV.value();
      // Get studies - might be in _panes, _studiesAccessor, etc.
      var keys = Object.keys(aw).filter(function(k) {
        return k.toLowerCase().indexOf("stud") !== -1 || k.toLowerCase().indexOf("pane") !== -1 || k.toLowerCase().indexOf("series") !== -1;
      });
      return "chart widget study-related keys: " + JSON.stringify(keys);
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("study keys:", r2.result.value);

await client.close();
