import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
const client = await CDP({ port: 9222 });
const { Runtime, Input } = client;
await Runtime.enable();

// Find AMD_OTE text element and right-click it
const r1 = await Runtime.evaluate({
  expression: `(function() {
    var all = Array.from(document.querySelectorAll("*"))
      .filter(function(el) {
        return el.offsetParent !== null;
      })
      .filter(function(el) {
        var txt = el.textContent.trim();
        return txt === "AMD_OTE" || txt === "AMD OTE";
      })
      .map(function(el) {
        var r = el.getBoundingClientRect();
        return el.tagName + " x=" + r.x.toFixed(0) + " y=" + r.y.toFixed(0) + " cls=" + (el.className||"").toString().slice(0,40);
      });
    return all.join(" | ") || "not found";
  })()`,
  returnByValue: true
});
console.log("AMD_OTE elements:", r1.result.value);

// Also find the strategy report header area
const r2 = await Runtime.evaluate({
  expression: `(function() {
    var sr = document.querySelector("[class*=report]") || document.querySelector("[class*=backtesting]");
    if (!sr) return "no report";
    var r = sr.getBoundingClientRect();
    return "report at y=" + r.y.toFixed(0) + " h=" + r.height.toFixed(0) + " text:" + sr.textContent.slice(0,60).replace(/\n/g," ");
  })()`,
  returnByValue: true
});
console.log("report area:", r2.result.value);

await client.close();
