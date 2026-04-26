import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Get all studies on chart
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var studies = chart.getAllStudies();
      return JSON.stringify(studies.map(function(s) { return {id: s.id, name: s.name}; }));
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("studies:", r1.result.value);

// Check current symbol
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      return chart.symbol() + " " + chart.resolution();
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("symbol:", r2.result.value);

// Check if strategy tester is showing and what's in it
const r3 = await Runtime.evaluate({
  expression: `(function() {
    // Find strategy tester panel - look for the metrics tables
    var netProfit = null;
    var totalTrades = null;
    var els = Array.from(document.querySelectorAll("*")).filter(function(el) {
      return el.offsetParent !== null && el.children.length === 0;
    });

    // Look for text matching numbers with % or $ signs near "Net Profit"
    var labelEls = els.filter(function(el) { return el.textContent.trim() === "Net Profit"; });
    if (labelEls.length > 0) {
      var container = labelEls[0].closest("[class*='row'], [class*='cell'], tr, td");
      if (container) netProfit = container.textContent.replace(/\\s+/g, " ").trim().slice(0,60);
    }

    var tradeEls = els.filter(function(el) { return el.textContent.trim() === "Total Closed Trades"; });
    if (tradeEls.length > 0) {
      var container = tradeEls[0].closest("[class*='row'], [class*='cell'], tr, td");
      if (container) totalTrades = container.textContent.replace(/\\s+/g, " ").trim().slice(0,60);
    }

    return JSON.stringify({ netProfit: netProfit, totalTrades: totalTrades });
  })()`,
  returnByValue: true
});
console.log("strategy stats:", r3.result.value);

await client.close();
