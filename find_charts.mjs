import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
const client = await CDP({ port: 9222 });
const { Runtime } = client;
await Runtime.enable();

// Find all chart widgets and their symbols
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      // Try to find all chart widgets
      var api = window.TradingViewApi;
      if (!api) return "no TradingViewApi";

      // Check _chartWidgets or similar
      var keys = Object.keys(api).filter(function(k) { return k.toLowerCase().indexOf("chart") !== -1; });
      return "TradingViewApi keys with chart: " + JSON.stringify(keys);
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log(r1.result.value);

// Find chart widgets via DOM
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      // Find all chart containers
      var charts = Array.from(document.querySelectorAll("[class*=chart-container], [class*=pane]"))
        .filter(function(el) { return el.offsetParent !== null; })
        .filter(function(el) {
          var r = el.getBoundingClientRect();
          return r.width > 200 && r.height > 200;
        })
        .map(function(el) {
          var r = el.getBoundingClientRect();
          // Find symbol text inside
          var symEl = el.querySelector("[class*=symbol], [title*=search]");
          return el.tagName + " " + (el.className||"").toString().slice(0,40) + " at y=" + r.y.toFixed(0) + " h=" + r.height.toFixed(0) + " sym=" + (symEl ? symEl.textContent.trim() : "?");
        });
      return charts.slice(0,5).join("\n");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("charts:", r2.result.value);

await client.close();
