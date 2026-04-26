import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

await Runtime.evaluate({
  expression: `(function() {
    var api = window.TradingViewApi;
    var aw = api._activeChartWidgetWV.value();
    window.__amdStudy = aw.getStudyById("VBb1Zy");
  })()`,
  returnByValue: true
});

// Get own props one by one
const r1 = await Runtime.evaluate({
  expression: `Object.getOwnPropertyNames(window.__amdStudy).length`,
  returnByValue: true
});
console.log("own props count:", r1.result.value);

// Get keys using for...in
const r2 = await Runtime.evaluate({
  expression: `(function() { var k = []; for (var p in window.__amdStudy) { k.push(p); if (k.length > 30) break; } return k.join(", "); })()`,
  returnByValue: true
});
console.log("for-in keys:", r2.result.value);

// Check specific useful methods
for (const method of ["setSource", "setPineSource", "updateSource", "changeSource", "recompile", "compile", "reload", "remove", "getSource", "getPineSource", "_pineSource", "pineSource"]) {
  const r = await Runtime.evaluate({
    expression: `typeof window.__amdStudy["${method}"]`,
    returnByValue: true
  });
  if (r.result.value !== "undefined") {
    console.log(`  ${method}: ${r.result.value}`);
  }
}

await client.close();
