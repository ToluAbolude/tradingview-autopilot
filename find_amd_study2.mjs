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

// Get one study at a time
for (let i = 0; i < 11; i++) {
  const r = await Runtime.evaluate({
    expression: `window.__studies[${i}] ? (window.__studies[${i}].id + " | " + window.__studies[${i}].name) : "null"`,
    returnByValue: true
  });
  console.log(`[${i}]: ${r.result.value}`);
}

await client.close();
