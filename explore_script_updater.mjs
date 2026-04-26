import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Explore scriptUpdater
const r1 = await Runtime.evaluate({
  expression: `(function() {
    var su = window.scriptUpdater;
    if (!su) return "no scriptUpdater";
    var type = typeof su;
    if (type === "function") return "scriptUpdater is function: " + su.toString().slice(0,200);
    var keys = Object.keys(su).slice(0,20);
    return "scriptUpdater type=" + type + " keys=" + keys.join(",");
  })()`,
  returnByValue: true
});
console.log("scriptUpdater:", r1.result.value);

// Explore TVScript
const r2 = await Runtime.evaluate({
  expression: `(function() {
    var tvs = window.TVScript;
    if (!tvs) return "no TVScript";
    var keys = typeof tvs === "object" ? Object.keys(tvs).slice(0,20) : [];
    return "TVScript type=" + typeof tvs + " keys=" + keys.join(",");
  })()`,
  returnByValue: true
});
console.log("TVScript:", r2.result.value);

// Check what happens when we call scriptUpdater
const r3 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var su = window.scriptUpdater;
      if (typeof su !== "function") return "not a function";
      // Don't call it yet - check if it's the "Add to chart" function
      var code = su.toString();
      return "first 500 chars: " + code.slice(0,500);
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("scriptUpdater code:", r3.result.value);

// Check for the study model that's currently open
const r4 = await Runtime.evaluate({
  expression: `(function() {
    try {
      // Try to find the active Pine script model
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      // Look for pineWidgetSets or similar
      var chartKeys = [];
      var obj = chart;
      while (obj && obj !== Object.prototype) {
        Object.getOwnPropertyNames(obj).forEach(function(k) {
          if (chartKeys.indexOf(k) === -1) chartKeys.push(k);
        });
        obj = Object.getPrototypeOf(obj);
      }
      var pineRelated = chartKeys.filter(function(k) {
        return k.toLowerCase().includes("pine") || k.toLowerCase().includes("widget") || k.toLowerCase().includes("add");
      });
      return pineRelated.join(", ");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("pine chart keys:", r4.result.value);

await client.close();
