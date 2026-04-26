import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Try createStudy with "Checklist Reversal Strategy"
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      // Get the signature of createStudy
      return chart.createStudy.toString().slice(0, 200);
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("createStudy signature:", r1.result.value);

// Try to add Checklist Reversal Strategy
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      // createStudy typically takes (name, forceOverlay, lock, inputs, overrides, options)
      window.__studyPromise = chart.createStudy("Checklist Reversal Strategy", false, false);
      if (window.__studyPromise && typeof window.__studyPromise.then === "function") {
        window.__studyPromise.then(function(id) {
          window.__newStudyId = id;
          window.__studyCreated = true;
        }).catch(function(e) { window.__studyError = e.message; });
        return "promise created";
      }
      return "result: " + JSON.stringify(window.__studyPromise);
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("createStudy:", r2.result.value);

await new Promise(r => setTimeout(r, 5000));

const r3 = await Runtime.evaluate({
  expression: `(function() {
    return JSON.stringify({
      created: window.__studyCreated,
      error: window.__studyError,
      id: window.__newStudyId
    });
  })()`,
  returnByValue: true
});
console.log("study result:", r3.result.value);

// Check studies on chart
const r4 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var studies = chart.getAllStudies();
      return studies.map(function(s) { return s.id + "=" + s.name; }).join(", ");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("studies:", r4.result.value);

await client.close();
