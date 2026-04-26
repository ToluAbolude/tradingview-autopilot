import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

await Runtime.evaluate({
  expression: `window.__studies = window.TradingViewApi._activeChartWidgetWV.value().getAllStudies()`,
  returnByValue: true
});

// Inspect the first study to understand its structure
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var s = window.__studies[0];
      var keys = Object.getOwnPropertyNames(s).slice(0,15);
      var protoKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(s)).slice(0,15);
      return "own=" + JSON.stringify(keys) + " proto=" + JSON.stringify(protoKeys);
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("study[0] structure:", r1.result.value);

// Try to get the description from study
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var s = window.__studies[0];
      // Try different properties
      var props = {};
      ["_shortTitle", "_title", "_name", "name", "title", "_displayTitle", "_id", "_studyId", "_metaInfo"];
      var tries = ["_shortTitle", "_title", "_name", "name", "title", "_displayTitle"];
      tries.forEach(function(k) {
        try { props[k] = s[k]; } catch(e) {}
      });
      return JSON.stringify(props);
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("study[0] props:", r2.result.value);

// Check metaInfo result type
const r3 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var s = window.__studies[0];
      var mi = s.metaInfo();
      return "metaInfo type=" + typeof mi + " null=" + (mi===null) + " keys=" + (mi ? JSON.stringify(Object.keys(mi).slice(0,10)) : "N/A");
    } catch(e) { return "metaInfo ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("metaInfo:", r3.result.value);

await client.close();
