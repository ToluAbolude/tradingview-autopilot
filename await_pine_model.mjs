import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Await the pineSourceCodeModel promise and store result
const r1 = await Runtime.evaluate({
  expression: `(async function() {
    var api = window.TradingViewApi;
    var aw = api._activeChartWidgetWV.value();
    var s = aw.getStudyById("VBb1Zy");
    var model = await s._study.pineSourceCodeModel();
    window.__pscmResolved = model;
    return "resolved type=" + typeof model;
  })()`,
  returnByValue: false,
  awaitPromise: true
});
console.log("promise result:", JSON.stringify(r1.result).slice(0, 200));

await new Promise(r => setTimeout(r, 1000));

// Check the resolved model
const r2 = await Runtime.evaluate({
  expression: `window.__pscmResolved ? "type=" + typeof window.__pscmResolved : "not set"`,
  returnByValue: true
});
console.log("resolved model:", r2.result.value);

// Get its methods
const r3 = await Runtime.evaluate({
  expression: `(function() {
    var m = window.__pscmResolved;
    if (!m) return "null";
    var found = [];
    var cur = m;
    var depth = 0;
    while (cur && depth < 4) {
      Object.getOwnPropertyNames(cur).forEach(function(n) {
        found.push(n + "=" + typeof cur[n]);
      });
      cur = Object.getPrototypeOf(cur);
      depth++;
    }
    return found.slice(0, 40).join(", ");
  })()`,
  returnByValue: true
});
console.log("model methods:", r3.result.value);

await client.close();
