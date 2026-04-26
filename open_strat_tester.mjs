import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
const client = await CDP({ port: 9222 });
const { Runtime, Input } = client;
await Runtime.enable();

// Click the Strategy Report tab in the bottom panel
const r1 = await Runtime.evaluate({
  expression: `(function() {
    // Find the Strategy Report button/tab
    var btns = Array.from(document.querySelectorAll("button, [role=tab]"))
      .filter(function(b) { return b.offsetParent !== null; })
      .filter(function(b) { return b.textContent.trim().indexOf("Strategy") !== -1; });
    if (!btns.length) return "no strategy button found";
    btns[0].click();
    return "clicked: " + btns[0].textContent.trim().slice(0,30);
  })()`,
  returnByValue: true
});
console.log("click strategy report:", r1.result.value);

await new Promise(r => setTimeout(r, 1500));

// Check what's showing now
const r2 = await Runtime.evaluate({
  expression: `(function() {
    var sr = document.querySelector("[data-name=strategy-report]") ||
             Array.from(document.querySelectorAll("*")).find(function(el) {
               return el.offsetParent !== null && el.textContent.trim().slice(0,20) === "Strategy Report";
             });
    return sr ? "strategy report found at y=" + sr.getBoundingClientRect().y.toFixed(0) : "not found";
  })()`,
  returnByValue: true
});
console.log("strategy report:", r2.result.value);

await client.close();
