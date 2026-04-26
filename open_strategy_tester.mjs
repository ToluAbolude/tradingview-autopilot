import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Check if there's a strategy tester widget open and get AMD OTE study info
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById("VBb1Zy");
      if (!study) return "no study VBb1Zy";
      var keys = Object.keys(study).filter(function(k) { return !k.startsWith("_"); });
      return "study keys: " + keys.slice(0,20).join(", ");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("study:", r1.result.value);

// Try to get strategy performance
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById("VBb1Zy");
      if (!study) return "no study";
      // Check _study internals
      var s = study._study;
      var skeys = Object.keys(s).filter(function(k) { return k.includes("perf") || k.includes("trade") || k.includes("result") || k.includes("report") || k.includes("back"); });
      return "perf keys: " + skeys.join(", ");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("perf keys:", r2.result.value);

// Look for strategy tester in DOM
const r3 = await Runtime.evaluate({
  expression: `(function() {
    // Look for the strategy tester report in DOM
    var perfSummary = document.querySelector("[data-name='strategy-tester']") ||
                      document.querySelector("[class*='backtesting-content']") ||
                      document.querySelector("[class*='strategyreport']");
    if (perfSummary) return "found: " + perfSummary.className + " text=" + perfSummary.textContent.replace(/\\s+/g," ").slice(0,200);

    // Try finding by looking for metrics
    var all = Array.from(document.querySelectorAll("*"))
      .filter(function(el) { return el.offsetParent !== null; });
    var netEl = all.find(function(el) { return el.textContent.trim() === "Net Profit"; });
    if (netEl) {
      return "Net Profit found at: " + netEl.className + " parent=" + netEl.parentElement.textContent.replace(/\\s+/g," ").slice(0,100);
    }
    return "no strategy tester elements found";
  })()`,
  returnByValue: true
});
console.log("dom search:", r3.result.value);

// Try to activate strategy tester for AMD OTE
const r4 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById("VBb1Zy");
      if (!study) return "no study";
      var s = study._study;
      // Check if it has a selectAsBacktestingStudy or similar
      var methods = Object.getOwnPropertyNames(Object.getPrototypeOf(s)).filter(function(k) {
        return k.includes("select") || k.includes("backtest") || k.includes("activate") || k.includes("strategy");
      });
      return "strategy methods: " + methods.join(", ");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("strategy methods:", r4.result.value);

await client.close();
