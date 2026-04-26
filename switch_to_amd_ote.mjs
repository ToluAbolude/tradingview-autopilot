import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime, Input } = client;
await Runtime.enable();

// Find the strategy name selector in the strategy tester panel and click it
const r1 = await Runtime.evaluate({
  expression: `(function() {
    var allVisible = Array.from(document.querySelectorAll("*"))
      .filter(function(el) { return el.offsetParent !== null; });

    // Find "Platinum MTF Strategy" text which is the current strategy selector
    var platEl = allVisible.find(function(el) {
      return el.textContent.trim() === "Platinum MTF Strategy" && el.children.length === 0;
    });

    if (platEl) {
      var r = platEl.getBoundingClientRect();
      return "found at x=" + r.x.toFixed(0) + " y=" + r.y.toFixed(0) + " tag=" + platEl.tagName;
    }

    // Try to find the strategy dropdown
    var strat = allVisible.find(function(el) {
      return el.textContent.includes("Platinum MTF") && el.textContent.length < 50;
    });
    if (strat) {
      var r = strat.getBoundingClientRect();
      return "broader found at x=" + r.x.toFixed(0) + " y=" + r.y.toFixed(0);
    }
    return "not found";
  })()`,
  returnByValue: true
});
console.log("strategy selector:", r1.result.value);

// Click it to open dropdown
if (r1.result.value && r1.result.value.includes("found at")) {
  const match = r1.result.value.match(/x=(\d+).*y=(\d+)/);
  if (match) {
    const x = parseInt(match[1]) + 5;
    const y = parseInt(match[2]) + 5;
    await Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await new Promise(r => setTimeout(r, 100));
    await Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    console.log("clicked strategy selector at", x, y);
  }
}

await new Promise(r => setTimeout(r, 1000));

// Look for AMD OTE Runner in the dropdown
const r2 = await Runtime.evaluate({
  expression: `(function() {
    var allVisible = Array.from(document.querySelectorAll("*"))
      .filter(function(el) { return el.offsetParent !== null; });

    var amdEl = allVisible.find(function(el) {
      return el.textContent.includes("AMD OTE") && el.textContent.length < 60;
    });

    if (amdEl) {
      var r = amdEl.getBoundingClientRect();
      return "AMD OTE found at x=" + r.x.toFixed(0) + " y=" + r.y.toFixed(0) + " text=" + amdEl.textContent.trim();
    }

    // List visible items that appeared after click
    var newItems = allVisible.filter(function(el) {
      var r = el.getBoundingClientRect();
      return r.top > 500 && el.children.length === 0 && el.textContent.trim().length > 3 && el.textContent.trim().length < 60;
    }).map(function(el) { return el.textContent.trim(); });
    var seen = {};
    return "no AMD OTE. Items: " + newItems.filter(function(t) { if(seen[t]) return false; seen[t]=1; return true; }).slice(0,10).join(", ");
  })()`,
  returnByValue: true
});
console.log("dropdown:", r2.result.value);

await client.close();
