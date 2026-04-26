import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
const client = await CDP({ port: 9222 });
const { Runtime } = client;
await Runtime.enable();

// Explore _chartWidgetCollection
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var api = window.TradingViewApi;
      var col = api._chartWidgetCollection;
      if (!col) return "no _chartWidgetCollection";
      // Check its structure
      return "type=" + typeof col + " keys=" + JSON.stringify(Object.keys(col||{}).slice(0,10));
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("collection:", r1.result.value);

// Try _chartWidgets
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var api = window.TradingViewApi;
      var widgets = api._chartWidgets;
      if (!widgets) return "no _chartWidgets";
      var type = typeof widgets;
      var keys = Object.keys(widgets||{}).slice(0,10);
      var len = Array.isArray(widgets) ? widgets.length : (widgets.size || "n/a");
      return "type=" + type + " len=" + len + " keys=" + JSON.stringify(keys);
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("widgets:", r2.result.value);

// Get active chart symbol
const r3 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var api = window.TradingViewApi;
      var active = api._activeChartWidgetWV ? api._activeChartWidgetWV.value() : null;
      if (!active) return "no active chart";
      var sym = active.symbol ? active.symbol() : (active.getSymbol ? active.getSymbol() : "unknown");
      return "active symbol=" + sym;
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("active chart:", r3.result.value);

await client.close();
