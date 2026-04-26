import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
const client = await CDP({ port: 9222 });
const { Runtime } = client;
await Runtime.enable();

// Switch back to XAUUSD 15m
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      // Find the chart widget
      var api = window.TradingViewApi;
      if (!api) return "no TradingViewApi";
      var chartWidget = api._activeChartWidgetWV ? api._activeChartWidgetWV.value() : null;
      if (!chartWidget) return "no chartWidget";
      // Switch symbol
      chartWidget.setSymbol("BLACKBULL:XAUUSD", "15", function() {});
      return "setSymbol called";
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("switch symbol:", r1.result.value);

await new Promise(r => setTimeout(r, 2000));

// Verify
const r2 = await Runtime.evaluate({
  expression: `document.querySelector("[aria-label='Symbol search']") ? document.querySelector("[aria-label='Symbol search']").textContent.trim() : "no symbol btn"`,
  returnByValue: true
});
console.log("current symbol:", r2.result.value);

await client.close();
