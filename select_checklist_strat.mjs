import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime, Input } = client;
await Runtime.enable();

// Find and click "Checklist Reversal Strategy" in the picker
const r1 = await Runtime.evaluate({
  expression: `(function() {
    var all = Array.from(document.querySelectorAll("*"))
      .filter(function(el) { return el.offsetParent !== null; });

    // Find exact match for "Checklist Reversal Strategy" (not "with FVG")
    var target = all.find(function(el) {
      var text = el.textContent.trim();
      return text === "Checklist Reversal Strategy" && el.children.length === 0;
    });

    if (target) {
      var r = target.getBoundingClientRect();
      return "found at x=" + r.x.toFixed(0) + " y=" + r.y.toFixed(0);
    }
    // Try partial match
    target = all.find(function(el) {
      return el.textContent.includes("Checklist Reversal Strategy") &&
             !el.textContent.includes("with FVG") &&
             el.textContent.length < 40;
    });
    if (target) {
      var r = target.getBoundingClientRect();
      return "partial found at x=" + r.x.toFixed(0) + " y=" + r.y.toFixed(0);
    }
    return "not found";
  })()`,
  returnByValue: true
});
console.log("checklist strat:", r1.result.value);

if (r1.result.value && r1.result.value.includes("found at")) {
  const match = r1.result.value.match(/x=(\d+).*y=(\d+)/);
  if (match) {
    const x = parseInt(match[1]) + 5;
    const y = parseInt(match[2]) + 5;
    await Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await new Promise(r => setTimeout(r, 100));
    await Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    console.log("clicked Checklist Reversal Strategy at", x, y);
  }
}

await new Promise(r => setTimeout(r, 3000));

// Check if strategy was added
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var studies = chart.getAllStudies();
      return studies.map(function(s) { return s.id + "=" + s.name; }).join(", ");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("studies:", r2.result.value);

// Check if strategy tester now has data
const r3 = await Runtime.evaluate({
  expression: `(function() {
    // Look for strategy metrics in DOM
    var all = Array.from(document.querySelectorAll("*"))
      .filter(function(el) { return el.offsetParent !== null && el.children.length === 0; });
    var npEl = all.find(function(e) { return e.textContent.trim() === "Net Profit"; });
    var ttEl = all.find(function(e) { return e.textContent.trim() === "Total Closed Trades"; });
    return "Net Profit: " + !!npEl + " Total Closed Trades: " + !!ttEl;
  })()`,
  returnByValue: true
});
console.log("metrics visible:", r3.result.value);

await client.close();
