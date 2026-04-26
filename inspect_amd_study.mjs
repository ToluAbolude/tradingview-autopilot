import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

await Runtime.evaluate({
  expression: `window.__studies = window.TradingViewApi._activeChartWidgetWV.value().getAllStudies(); window.__amd = window.__studies.find(function(s){ return s.name && s.name.indexOf("AMD OTE") !== -1; })`,
  returnByValue: true
});

const r1 = await Runtime.evaluate({
  expression: `window.__amd ? "found: id=" + window.__amd.id : "not found"`,
  returnByValue: true
});
console.log("AMD study:", r1.result.value);

// Get the actual study instance with more functionality
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var api = window.TradingViewApi;
      var aw = api._activeChartWidgetWV.value();
      // Try to get the study widget with more methods
      // The getAllStudies returns {id, name} objects. The actual study may be accessible via getStudyById or similar
      var methods = Object.getOwnPropertyNames(aw).filter(function(k) {
        return k.toLowerCase().indexOf("stud") !== -1;
      });
      var protos = Object.getOwnPropertyNames(Object.getPrototypeOf(aw)).filter(function(k) {
        return k.toLowerCase().indexOf("stud") !== -1;
      });
      return "own=" + JSON.stringify(methods) + " proto=" + JSON.stringify(protos);
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("chart study methods:", r2.result.value);

await client.close();
