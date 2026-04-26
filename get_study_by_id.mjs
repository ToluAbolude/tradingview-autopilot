import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Get AMD_OTE study by ID
await Runtime.evaluate({
  expression: `(function() {
    var api = window.TradingViewApi;
    var aw = api._activeChartWidgetWV.value();
    window.__amdStudy = aw.getStudyById("VBb1Zy");
  })()`,
  returnByValue: true
});

const r1 = await Runtime.evaluate({
  expression: `window.__amdStudy ? "type=" + typeof window.__amdStudy : "null/undefined"`,
  returnByValue: true
});
console.log("amdStudy type:", r1.result.value);

// Get its own + prototype methods
const r2 = await Runtime.evaluate({
  expression: `(function() {
    var s = window.__amdStudy;
    if (!s) return "null";
    var own = Object.getOwnPropertyNames(s).slice(0,20);
    var proto = s.__proto__ ? Object.getOwnPropertyNames(s.__proto__).slice(0,30) : [];
    return "own=" + JSON.stringify(own) + "\nproto=" + JSON.stringify(proto);
  })()`,
  returnByValue: true
});
console.log("methods:", r2.result.value);

await client.close();
