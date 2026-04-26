import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Get _reportDataBuffer for VBb1Zy
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById("VBb1Zy");
      var s = study._study;
      var buf = s._reportDataBuffer;
      if (!buf) return "no buffer";
      window.__buf = buf;
      // Get performance.all
      var perf = buf.performance && buf.performance.all;
      return JSON.stringify({
        filledOrders_count: buf.filledOrders ? buf.filledOrders.length : "N/A",
        performance_all_keys: perf ? Object.keys(perf).slice(0,30) : "no perf.all",
        first_perf_vals: perf ? JSON.stringify(perf).slice(0,500) : "none"
      });
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("buffer:", r1.result.value);

// Get specific performance metrics
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var buf = window.__buf;
      if (!buf) return "no buf";
      var perf = buf.performance;
      if (!perf) return "no perf";
      // Check all, long, short
      return JSON.stringify({
        all: {
          netProfit: perf.all ? perf.all.netProfit : null,
          totalTrades: perf.all ? perf.all.totalTrades : null,
          percentProfitable: perf.all ? perf.all.percentProfitable : null,
          profitFactor: perf.all ? perf.all.profitFactor : null,
          maxDrawdown: perf.all ? perf.all.maxDrawdown : null,
          grossProfit: perf.all ? perf.all.grossProfit : null,
          grossLoss: perf.all ? perf.all.grossLoss : null
        }
      });
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("performance:", r2.result.value);

// Check if there are any trades in the list
const r3 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var buf = window.__buf;
      var fo = buf.filledOrders;
      if (!fo || fo.length === 0) {
        // Check if there's something else
        return "filledOrders empty. buf keys: " + Object.keys(buf).join(", ");
      }
      return "filledOrders[0]: " + JSON.stringify(fo[0]).slice(0,200);
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("orders:", r3.result.value);

// Check if settings show the right script version
const r4 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var buf = window.__buf;
      return JSON.stringify({
        currency: buf.currency,
        settings: buf.settings,
        hasOpenInterest: !!buf.openInterest,
        openInterestLen: buf.openInterest ? buf.openInterest.length : 0
      });
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("settings:", r4.result.value);

await client.close();
