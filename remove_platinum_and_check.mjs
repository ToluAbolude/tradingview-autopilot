import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Remove Platinum MTF Strategy (5glldj) from chart
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      chart.removeStudy("5glldj");
      return "removed 5glldj";
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("remove:", r1.result.value);

await new Promise(r => setTimeout(r, 2000));

// Check what studies remain
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var studies = chart.getAllStudies();
      return JSON.stringify(studies.map(function(s) { return {id: s.id, name: s.name}; }));
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("remaining studies:", r2.result.value);

// Now check if AMD OTE Runner has report data
const r3 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById("VBb1Zy");
      if (!study) return "no VBb1Zy";
      var s = study._study;
      var rd = s._reportData;
      if (!rd) return "still no _reportData";
      return "has _reportData! keys=" + Object.keys(rd).slice(0,10).join(",");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("AMD OTE report data:", r3.result.value);

await client.close();
