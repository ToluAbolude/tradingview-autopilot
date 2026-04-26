import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Remove Platinum MTF Strategy using removeEntity
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      chart.removeEntity("5glldj");
      return "removed 5glldj via removeEntity";
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("remove:", r1.result.value);

await new Promise(r => setTimeout(r, 2000));

// Verify it's gone and check AMD OTE
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var studies = chart.getAllStudies();
      return studies.map(function(s) { return s.id + "=" + s.name; }).join(", ");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("studies after:", r2.result.value);

// Check AMD OTE report data now
const r3 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById("VBb1Zy");
      if (!study) return "no VBb1Zy";
      var s = study._study;
      return JSON.stringify({
        hasReportData: s._reportData !== null && s._reportData !== undefined,
        reportDataType: typeof s._reportData,
        reportChangedType: typeof s._reportChanged
      });
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("AMD OTE status:", r3.result.value);

await client.close();
