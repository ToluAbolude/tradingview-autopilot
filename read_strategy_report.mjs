import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Get all text in the strategy tester panel area
const r1 = await Runtime.evaluate({
  expression: `(function() {
    // Find the metrics table
    var metrics = document.querySelector("[class*='items-']") || document.querySelector("[class*='metrics']");
    if (metrics) return "metrics: " + metrics.textContent.replace(/\s+/g, " ").slice(0, 300);

    // Try finding the report panel
    var panels = Array.from(document.querySelectorAll("*"))
      .filter(function(el) {
        var r = el.getBoundingClientRect();
        return r.y > 440 && r.y < 500 && r.width > 500 && el.offsetParent !== null;
      })
      .map(function(el) { return el.textContent.replace(/\s+/g, " ").slice(0, 100); });
    return panels.slice(0, 3).join(" | ");
  })()`,
  returnByValue: true
});
console.log("strategy report:", r1.result.value);

// Also check what time it is now via console timestamp
const r2 = await Runtime.evaluate({
  expression: `(function() {
    var c = document.querySelector("[class*='console']");
    return c ? c.textContent.slice(-200) : "no console";
  })()`,
  returnByValue: true
});
console.log("console:", r2.result.value);

// Check current strategy metrics directly
const r3 = await Runtime.evaluate({
  expression: `(function() {
    // Total trades metric
    var cells = Array.from(document.querySelectorAll("[class*='tableCell'], td, [class*='metric']"))
      .filter(function(el) { return el.offsetParent !== null; });
    var tradeCell = null;
    // Look for "Total trade" label
    var labels = Array.from(document.querySelectorAll("*"))
      .filter(function(el) {
        return el.offsetParent !== null && el.textContent.trim() === "Total trades";
      });
    if (labels.length > 0) {
      var next = labels[0].parentElement;
      return "found 'Total trades' label, parent text=" + (next ? next.textContent.replace(/\s+/g, " ").slice(0, 80) : "?");
    }
    return "no total trades label found";
  })()`,
  returnByValue: true
});
console.log("total trades:", r3.result.value);

await client.close();
