import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Get trades and firstTradeIndex from buffer
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById("VBb1Zy");
      var s = study._study;
      var buf = s._reportDataBuffer;
      if (!buf) return "no buf";
      return JSON.stringify({
        trades_type: typeof buf.trades,
        trades_len: Array.isArray(buf.trades) ? buf.trades.length : (buf.trades ? Object.keys(buf.trades).length : 0),
        trades_first: Array.isArray(buf.trades) && buf.trades.length > 0 ? JSON.stringify(buf.trades[0]).slice(0,200) : "empty",
        firstTradeIndex: buf.firstTradeIndex,
        filledOrders_len: buf.filledOrders ? buf.filledOrders.length : 0
      });
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("trades:", r1.result.value);

// Check if maybe there's a different version of the reportData
// Try accessing it via the strategy tester widget
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      // Find the strategy tester widget in the DOM
      var all = Array.from(document.querySelectorAll("*"))
        .filter(function(el) { return el.offsetParent !== null && el.textContent.includes("AMD OTE Diag Min") && el.textContent.length < 100; });

      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        var fk = Object.keys(el).find(function(k) { return k.startsWith("__reactFiber"); });
        if (!fk) continue;
        var fiber = el[fk];
        for (var d = 0; d < 50 && fiber; d++) {
          var p = fiber.memoizedProps;
          if (p && p.reportData) {
            return "found reportData in props at depth " + d + ": " + JSON.stringify(p.reportData).slice(0,200);
          }
          if (p && p.data && p.data.performance) {
            return "found data.performance: " + JSON.stringify(p.data.performance).slice(0,200);
          }
          if (p && p.performance) {
            return "found performance in props: " + JSON.stringify(p.performance).slice(0,200);
          }
          fiber = fiber.return;
        }
      }
      return "no reportData found in strategy tester DOM";
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("strategy tester data:", r2.result.value);

// Try subscribing to reportChanged again and wait
const r3 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById("VBb1Zy");
      var s = study._study;
      window.__latestReport = null;
      var rc = s._reportChanged;
      if (rc && typeof rc.subscribe === "function") {
        rc.subscribe(function(data) {
          window.__latestReport = data;
        });
        // Also check current value
        var cur = rc.getValue ? rc.getValue() : (rc._value !== undefined ? rc._value : null);
        return "subscribed. current value type=" + typeof cur + " " + (cur ? JSON.stringify(cur).slice(0,200) : "null");
      }
      return "no subscribe";
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("reportChanged value:", r3.result.value);

await client.close();
