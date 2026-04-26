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

// Get all study names
const r1 = await Runtime.evaluate({
  expression: `(function() {
    var out = [];
    for (var i = 0; i < window.__studies.length; i++) {
      try {
        var s = window.__studies[i];
        out.push(i + ": id=" + s.id + " name=" + s.name);
      } catch(e) { out.push(i + ": ERR=" + e.message); }
    }
    return out.join("\n");
  })()`,
  returnByValue: true
});
console.log("All studies:\n" + r1.result.value);

await client.close();
