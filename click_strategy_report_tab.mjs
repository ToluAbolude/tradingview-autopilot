import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime, Input } = client;
await Runtime.enable();

// Find and click the Strategy Report tab at the bottom
const r1 = await Runtime.evaluate({
  expression: `(function() {
    // Look for bottom panel tabs
    var allEls = Array.from(document.querySelectorAll("*"))
      .filter(function(el) { return el.offsetParent !== null; });

    // Find Strategy Report text
    var srEls = allEls.filter(function(el) {
      return el.textContent.trim() === "Strategy Report" && el.children.length === 0;
    });

    if (srEls.length === 0) {
      // Try broader search
      srEls = allEls.filter(function(el) {
        return el.textContent.includes("Strategy Report") && el.textContent.length < 30;
      });
    }

    if (srEls.length > 0) {
      var el = srEls[0];
      var r = el.getBoundingClientRect();
      return "found at x=" + r.x.toFixed(0) + " y=" + r.y.toFixed(0) + " tag=" + el.tagName;
    }
    return "not found, count=" + srEls.length;
  })()`,
  returnByValue: true
});
console.log("strategy report tab:", r1.result.value);

// Click it via mouse
if (r1.result.value && r1.result.value.includes("found at")) {
  const match = r1.result.value.match(/x=(\d+).*y=(\d+)/);
  if (match) {
    const x = parseInt(match[1]) + 5;
    const y = parseInt(match[2]) + 5;
    await Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await new Promise(r => setTimeout(r, 100));
    await Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    console.log("clicked at", x, y);
  }
}

await new Promise(r => setTimeout(r, 2000));

// Now read what's in the bottom panel
const r2 = await Runtime.evaluate({
  expression: `(function() {
    var allEls = Array.from(document.querySelectorAll("*"))
      .filter(function(el) {
        var r = el.getBoundingClientRect();
        return el.offsetParent !== null && r.top > 400 && r.height > 0 && r.height < 50 && r.width > 100;
      });

    // Look for key labels
    var keyLabels = ["Net Profit", "Total Closed Trades", "Percent Profitable", "Profit Factor", "Max Drawdown"];
    var found = [];
    keyLabels.forEach(function(label) {
      var el = allEls.find(function(e) { return e.textContent.trim() === label; });
      if (el) found.push(label + " at y=" + el.getBoundingClientRect().top.toFixed(0));
    });
    return found.length > 0 ? found.join(", ") : "no metrics found. Sample els: " +
      allEls.slice(0,5).map(function(e) { return e.textContent.trim().slice(0,30); }).join(" | ");
  })()`,
  returnByValue: true
});
console.log("metrics check:", r2.result.value);

await client.close();
