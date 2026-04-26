import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
const client = await CDP({ port: 9222 });
const { Runtime, Input } = client;
await Runtime.enable();

// Find AMD_OTE text in DOM and check its context
const r1 = await Runtime.evaluate({
  expression: `(function() {
    // Find all clickable elements with AMD_OTE text
    var all = Array.from(document.querySelectorAll("*"))
      .filter(function(el) {
        return el.offsetParent !== null && el.textContent.trim() === "AMD_OTE";
      })
      .map(function(el) {
        var r = el.getBoundingClientRect();
        return el.tagName + " x=" + r.x.toFixed(0) + " y=" + r.y.toFixed(0) + " cls=" + (el.className||"").toString().slice(0,50);
      });
    return all.join(" | ");
  })()`,
  returnByValue: true
});
console.log("AMD_OTE elements:", r1.result.value);

// Also look for elements in the strategy report area
const r2 = await Runtime.evaluate({
  expression: `(function() {
    // Find strategy report panel
    var sr = document.querySelector("[class*=backtesting]") || document.querySelector("[class*=strategy-report]");
    if (!sr) return "no strategy report panel";
    var clickable = Array.from(sr.querySelectorAll("button, [role=button], a"))
      .filter(function(el) { return el.offsetParent !== null; })
      .map(function(el) {
        var r = el.getBoundingClientRect();
        return el.tagName + " title=" + (el.title||"") + " txt=" + el.textContent.trim().slice(0,20) + " y=" + r.y.toFixed(0);
      });
    return clickable.slice(0,10).join(" | ");
  })()`,
  returnByValue: true
});
console.log("strategy report clickables:", r2.result.value);

await client.close();
