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
    window.__pscm = s._study.pineSourceCodeModel();
  })()`,
  returnByValue: true
});

const r1 = await Runtime.evaluate({
  expression: `window.__pscm ? "type=" + typeof window.__pscm : "null"`,
  returnByValue: true
});
console.log("pineSourceCodeModel:", r1.result.value);

// Get its methods
const r2 = await Runtime.evaluate({
  expression: `(function() {
    var m = window.__pscm;
    if (!m) return "null";
    var found = [];
    var cur = m;
    var depth = 0;
    while (cur && depth < 4) {
      Object.getOwnPropertyNames(cur).forEach(function(n) {
        found.push("d" + depth + "." + n + "=" + typeof cur[n]);
      });
      cur = Object.getPrototypeOf(cur);
      depth++;
    }
    return found.slice(0,50).join(", ");
  })()`,
  returnByValue: true
});
console.log("pscm methods:", r2.result.value?.slice(0, 800));

await client.close();
