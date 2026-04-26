import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

// Get target list and connect to TradingView tab specifically
const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
if (!tvTarget) { console.log("No TradingView tab found"); process.exit(1); }
console.log("Connecting to:", tvTarget.title.slice(0,50));

const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Switch to XAUUSD
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var api = window.TradingViewApi;
      var col = api._chartWidgetCollection;
      var aw = col.activeChartWidget ? col.activeChartWidget() : api._activeChartWidgetWV.value();
      if (!aw) return "no active widget";
      aw.setSymbol("BLACKBULL:XAUUSD");
      return "setSymbol XAUUSD called on: " + aw.symbol();
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("symbol switch:", r1.result.value);

await new Promise(r => setTimeout(r, 2000));

// Now find studies
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var api = window.TradingViewApi;
      var aw = api._activeChartWidgetWV.value();
      // Try getting studies via getAllStudies or similar
      var methods = ["getAllStudies", "getStudies", "_studiesAccessor", "_studies", "_panes", "_mainSeries", "getPriceScales"];
      var found = [];
      methods.forEach(function(m) {
        try {
          var v = aw[m];
          if (v !== undefined) found.push(m + "=" + typeof v);
        } catch(e) {}
      });
      return "found methods: " + found.join(", ");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("study methods:", r2.result.value);

await client.close();
