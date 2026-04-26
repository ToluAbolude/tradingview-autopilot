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
    var s = aw.getStudyById("VBb1Zy");
    window.__innerStudy = s._study;
    window.__amdModel = s._model;
  })()`,
  returnByValue: true
});

// Explore _study methods with for-in
const r1 = await Runtime.evaluate({
  expression: `(function() { var k = []; for (var p in window.__innerStudy) { k.push(p); if (k.length > 50) break; } return k.join(", "); })()`,
  returnByValue: true
});
console.log("_study for-in keys:", r1.result.value?.slice(0, 500));

// Check specific methods
for (const method of ["setSource", "setPineSource", "updateSource", "pineSource", "getPineSource", "getSource", "setInputs", "getSources", "setProperty"]) {
  const r = await Runtime.evaluate({
    expression: `typeof window.__innerStudy["${method}"]`,
    returnByValue: true
  });
  if (r.result.value !== "undefined") {
    console.log(`  _study.${method}: ${r.result.value}`);
  }
}

// Explore _model
const r2 = await Runtime.evaluate({
  expression: `(function() { var k = []; for (var p in window.__amdModel) { k.push(p); if (k.length > 30) break; } return k.join(", "); })()`,
  returnByValue: true
});
console.log("_model for-in keys:", r2.result.value?.slice(0, 300));

await client.close();
