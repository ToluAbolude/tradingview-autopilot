import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Store studies globally
await Runtime.evaluate({
  expression: `window.__studies = window.TradingViewApi._activeChartWidgetWV.value().getAllStudies()`,
  returnByValue: true
});

// Check each study safely
for (let i = 0; i < 11; i++) {
  const r = await Runtime.evaluate({
    expression: `(function() {
      try {
        var s = window.__studies[${i}];
        if (!s) return "[${i}] undefined";
        var id = s.id || "?";
        // Try different ways to get the name
        var name = "?";
        try { name = s.metaInfo().shortDescription; } catch(e1) {
          try { name = s.metaInfo().description; } catch(e2) {
            try { name = s._study ? (s._study.metaInfo ? s._study.metaInfo().shortDescription : "?") : "?"; } catch(e3) {
              name = "err=" + e3.message;
            }
          }
        }
        return "[${i}] id=" + id + " name=" + name;
      } catch(e) { return "[${i}] ERR=" + e.message; }
    })()`,
    returnByValue: true
  });
  console.log(r.result.value);
}

await client.close();
