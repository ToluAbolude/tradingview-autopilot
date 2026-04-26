import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Find chart API methods related to strategy/remove
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var methods = [];
      var obj = chart;
      while (obj && obj !== Object.prototype) {
        Object.getOwnPropertyNames(obj).forEach(function(k) {
          if (typeof chart[k] === "function") methods.push(k);
        });
        obj = Object.getPrototypeOf(obj);
      }
      return methods.filter(function(m) {
        return m.includes("study") || m.includes("Study") || m.includes("strateg") || m.includes("remove") || m.includes("delete");
      }).join(", ");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("chart study methods:", r1.result.value);

// Try to find the right method for removing a study
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var all = [];
      var obj = chart;
      while (obj && obj !== Object.prototype) {
        Object.getOwnPropertyNames(obj).forEach(function(k) {
          if (all.indexOf(k) === -1 && typeof chart[k] === "function") all.push(k);
        });
        obj = Object.getPrototypeOf(obj);
      }
      return all.slice(0, 50).join(", ");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("all chart methods (first 50):", r2.result.value);

await client.close();
