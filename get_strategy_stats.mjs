import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Click "Strategy Report" tab if not already active
const r0 = await Runtime.evaluate({
  expression: `(function() {
    var tabs = Array.from(document.querySelectorAll("[class*='tab'], button, [role='tab']"))
      .filter(function(el) { return el.offsetParent !== null && el.textContent.trim() === "Strategy Report"; });
    if (tabs.length > 0) { tabs[0].click(); return "clicked strategy report tab"; }
    return "no strategy report tab, count=" + document.querySelectorAll("[class*='tab']").length;
  })()`,
  returnByValue: true
});
console.log("tab click:", r0.result.value);

await new Promise(r => setTimeout(r, 1000));

// Get the performance summary metrics
const r1 = await Runtime.evaluate({
  expression: `(function() {
    // Find "Performance Summary" section
    var allText = [];

    // Look for the strategy tester container
    var tester = document.querySelector("[class*='backtesting'], [class*='strategyTester'], [class*='report']");
    if (tester) {
      allText.push("tester: " + tester.textContent.replace(/\\s+/g," ").slice(0,300));
    }

    // Look for key metrics by label
    var allEls = Array.from(document.querySelectorAll("*")).filter(function(el) {
      return el.offsetParent !== null && el.children.length === 0;
    });

    var metrics = {};
    var keyLabels = ["Net Profit", "Total Closed Trades", "Percent Profitable", "Profit Factor", "Max Drawdown", "Total trades"];
    keyLabels.forEach(function(label) {
      var el = allEls.find(function(e) { return e.textContent.trim() === label; });
      if (el) {
        // The value is typically the next sibling or nearby element
        var parent = el.parentElement;
        var siblings = Array.from(parent ? parent.querySelectorAll("*") : []);
        var vals = siblings.map(function(s) { return s.textContent.trim(); }).filter(function(t) { return t !== label && t.length > 0 && t.length < 30; });
        metrics[label] = vals.slice(0,3).join("|");
      }
    });
    return JSON.stringify(metrics);
  })()`,
  returnByValue: true
});
console.log("metrics:", r1.result.value);

// Get raw text from strategy tester area (bottom panel)
const r2 = await Runtime.evaluate({
  expression: `(function() {
    var els = Array.from(document.querySelectorAll("*"))
      .filter(function(el) {
        var r = el.getBoundingClientRect();
        return el.offsetParent !== null && r.top > 400 && r.width > 600 && el.children.length < 20;
      })
      .map(function(el) { return el.textContent.replace(/\\s+/g," ").trim().slice(0,200); })
      .filter(function(t) { return t.length > 10 && (t.includes("trade") || t.includes("Trade") || t.includes("Profit") || t.includes("profit")); });
    var seen = {};
    return els.filter(function(t) { if (seen[t]) return false; seen[t]=1; return true; }).slice(0,5).join("\\n---\\n");
  })()`,
  returnByValue: true
});
console.log("bottom panel:", r2.result.value);

await client.close();
