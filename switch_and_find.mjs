import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
import { readFileSync } from "fs";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Switch to XAUUSD using the method that worked before
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var api = window.TradingViewApi;
      var aw = api._activeChartWidgetWV.value();
      aw.setSymbol("BLACKBULL:XAUUSD");
      return "setSymbol called";
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("symbol:", r1.result.value);

await new Promise(r => setTimeout(r, 2000));

// Get all studies to find AMD_OTE
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var api = window.TradingViewApi;
      var aw = api._activeChartWidgetWV.value();
      var studies = aw.getAllStudies();
      var out = "count=" + studies.length + "\n";
      studies.forEach(function(s) {
        try {
          var id = s.id || "?";
          var name = s.metaInfo ? (s.metaInfo().shortDescription || s.metaInfo().description || "?") : "no-metaInfo";
          out += "  id=" + id + " name=" + name + "\n";
        } catch(e2) { out += "  err=" + e2.message + "\n"; }
      });
      return out;
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("studies:", r2.result.value);

await client.close();
