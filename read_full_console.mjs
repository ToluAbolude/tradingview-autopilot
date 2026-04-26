import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Get the full Pine console text content
const r1 = await Runtime.evaluate({
  expression: `(function() {
    // Find console rows - each row has timestamp + message
    var rows = Array.from(document.querySelectorAll("[class*='row'], [class*='line'], [class*='item']"))
      .filter(function(el) {
        return el.offsetParent !== null && el.textContent.match(/\\d{2}:\\d{2}:\\d{2}/);
      })
      .map(function(el) { return el.textContent.replace(/\\s+/g," ").trim().slice(0,120); });
    var seen = {};
    return rows.filter(function(t) { if (seen[t]) return false; seen[t]=1; return true; }).join("\\n");
  })()`,
  returnByValue: true
});
console.log("rows:", r1.result.value);

// Try direct console container text
const r2 = await Runtime.evaluate({
  expression: `(function() {
    var cns = Array.from(document.querySelectorAll("*"))
      .filter(function(el) {
        return el.offsetParent !== null && el.children.length < 5 && el.textContent.match(/14:04/);
      })
      .map(function(el) { return el.tagName + " class=" + el.className.slice(0,40) + " text=" + el.textContent.replace(/\\s+/g," ").slice(0,100); });
    return cns.slice(0,10).join("\\n");
  })()`,
  returnByValue: true
});
console.log("14:04 elements:", r2.result.value);

await client.close();
