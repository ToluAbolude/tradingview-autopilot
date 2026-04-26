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
  })()`,
  returnByValue: true
});

// Search deeper in _study for "source" related functionality
const r1 = await Runtime.evaluate({
  expression: `(function() {
    var s = window.__innerStudy;
    // Walk prototype chain looking for source-related methods
    var found = [];
    var cur = s;
    var depth = 0;
    while (cur && depth < 5) {
      var names = Object.getOwnPropertyNames(cur);
      names.forEach(function(n) {
        if (n.toLowerCase().indexOf("source") !== -1 || n.toLowerCase().indexOf("pine") !== -1 || n.toLowerCase().indexOf("script") !== -1 || n.toLowerCase().indexOf("compile") !== -1) {
          found.push("depth" + depth + "." + n + "=" + typeof cur[n]);
        }
      });
      cur = Object.getPrototypeOf(cur);
      depth++;
    }
    return found.join(", ");
  })()`,
  returnByValue: true
});
console.log("source-related:", r1.result.value || "none found");

// Also check _chartWidget for source update methods
const r2 = await Runtime.evaluate({
  expression: `(function() {
    var api = window.TradingViewApi;
    var aw = api._activeChartWidgetWV.value();
    var s = aw.getStudyById("VBb1Zy");
    var cw = s._chartWidget;
    var found = [];
    var cur = cw;
    var depth = 0;
    while (cur && depth < 4) {
      var names = Object.getOwnPropertyNames(cur);
      names.forEach(function(n) {
        if (n.toLowerCase().indexOf("source") !== -1 || n.toLowerCase().indexOf("pine") !== -1 || n.toLowerCase().indexOf("script") !== -1 || n.toLowerCase().indexOf("compile") !== -1 || n.toLowerCase().indexOf("study") !== -1) {
          found.push("depth" + depth + "." + n + "=" + typeof cur[n]);
        }
      });
      cur = Object.getPrototypeOf(cur);
      depth++;
    }
    return found.slice(0,30).join(", ");
  })()`,
  returnByValue: true
});
console.log("chartWidget source-related:", r2.result.value?.slice(0, 500) || "none");

await client.close();
