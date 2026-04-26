import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Deep explore the AMD OTE study object
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById("VBb1Zy");
      if (!study) return "no study";
      var s = study._study;
      // Get all own + inherited keys with underscore prefix
      var allKeys = [];
      var obj = s;
      while (obj && obj !== Object.prototype) {
        Object.getOwnPropertyNames(obj).forEach(function(k) {
          if (allKeys.indexOf(k) === -1) allKeys.push(k);
        });
        obj = Object.getPrototypeOf(obj);
      }
      // Filter for interesting ones
      var interesting = allKeys.filter(function(k) {
        return k.includes("report") || k.includes("perf") || k.includes("trade") ||
               k.includes("backtest") || k.includes("result") || k.includes("stat") ||
               k.includes("metric") || k.includes("equity");
      });
      return interesting.join(", ");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("interesting keys:", r1.result.value);

// Check what _study properties look like
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById("VBb1Zy");
      var s = study._study;
      // Check for strategy-specific methods
      var methods = [];
      var obj = s;
      while (obj && obj !== Object.prototype) {
        Object.getOwnPropertyNames(obj).forEach(function(k) {
          var v = s[k];
          if (typeof v === "function" && methods.indexOf(k) === -1) methods.push(k);
        });
        obj = Object.getPrototypeOf(obj);
      }
      return methods.filter(function(k) {
        return k.includes("strategy") || k.includes("report") || k.includes("backtest");
      }).join(", ");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("strategy methods:", r2.result.value);

// Check the study data/source directly
const r3 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById("VBb1Zy");
      var s = study._study;
      // Look at non-function properties
      var props = {};
      Object.keys(s).forEach(function(k) {
        var v = s[k];
        if (typeof v !== "function") {
          if (v === null) props[k] = "null";
          else if (v === undefined) props[k] = "undefined";
          else if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") props[k] = v;
          else props[k] = typeof v + ":" + JSON.stringify(v).slice(0,50);
        }
      });
      return JSON.stringify(props).slice(0,1000);
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("props:", r3.result.value);

await client.close();
