import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Step 1: get studies count
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var api = window.TradingViewApi;
      var aw = api._activeChartWidgetWV.value();
      var studies = aw.getAllStudies();
      return "getAllStudies type=" + typeof studies + " isArray=" + Array.isArray(studies) + " len=" + (studies ? studies.length : "n/a");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("step1:", r1.result.value);

// Step 2: try _studies
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var api = window.TradingViewApi;
      var aw = api._activeChartWidgetWV.value();
      var s = aw._studies;
      var type = typeof s;
      var keys = s ? Object.keys(s).slice(0,10) : [];
      var len = Array.isArray(s) ? s.length : (s && s.size ? s.size : keys.length);
      return "type=" + type + " len=" + len + " keys=" + JSON.stringify(keys);
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("_studies:", r2.result.value);

// Step 3: Check what getAllStudies returns as a direct value
await Runtime.evaluate({
  expression: `window.__studies = (function() {
    var api = window.TradingViewApi;
    var aw = api._activeChartWidgetWV.value();
    return aw.getAllStudies();
  })()`,
  returnByValue: true
});

const r3 = await Runtime.evaluate({
  expression: `"studies stored: type=" + typeof window.__studies + " len=" + (window.__studies ? window.__studies.length : "null")`,
  returnByValue: true
});
console.log("stored studies:", r3.result.value);

// Step 4: check panes for strategies
const r4 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var api = window.TradingViewApi;
      var aw = api._activeChartWidgetWV.value();
      var panes = aw._panes;
      var type = typeof panes;
      // Try to count panes
      var count = Array.isArray(panes) ? panes.length : (panes && panes.size ? panes.size : Object.keys(panes||{}).length);
      return "panes type=" + type + " count=" + count;
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("panes:", r4.result.value);

await client.close();
