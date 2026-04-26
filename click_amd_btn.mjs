import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
const client = await CDP({ port: 9222 });
const { Runtime, Input } = client;
await Runtime.enable();

// Click on AMD_OTE button in strategy report - should open it in Pine editor
const res = await Runtime.evaluate({
  expression: `(function() {
    // Find the AMD_OTE button in strategy report
    var btns = Array.from(document.querySelectorAll("button"));
    var amdBtn = btns.find(function(b) { return b.title === "AMD_OTE"; });
    if (!amdBtn) return "not found by title";
    var r = amdBtn.getBoundingClientRect();
    return "found at x=" + r.x.toFixed(0) + " y=" + r.y.toFixed(0);
  })()`,
  returnByValue: true
});
console.log(res.result.value);

// Try double-click on it
await Runtime.evaluate({
  expression: `(function() {
    var btns = Array.from(document.querySelectorAll("button"));
    var amdBtn = btns.find(function(b) { return b.title === "AMD_OTE"; });
    if (amdBtn) { amdBtn.click(); return "clicked"; }
    return "not found";
  })()`,
  returnByValue: true
});
console.log("clicked AMD_OTE button");

await new Promise(r => setTimeout(r, 1000));

// Check what script the editor shows now
const r2 = await Runtime.evaluate({
  expression: `(function() {
    var widget = document.querySelector(".tv-script-widget");
    if (!widget) return "no widget";
    return "widget text: " + widget.textContent.slice(0, 100).replace(/\n/g, " ");
  })()`,
  returnByValue: true
});
console.log(r2.result.value);

await client.close();
