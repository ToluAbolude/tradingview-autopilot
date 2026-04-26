import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Get all studies including any new ones
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var studies = chart.getAllStudies();
      return JSON.stringify(studies.map(function(s) { return {id: s.id, name: s.name}; }));
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("studies:", r1.result.value);

// Check for AMD OTE Diag Min study specifically
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var studies = chart.getAllStudies();
      var amdDiag = studies.find(function(s) { return s.name && s.name.includes("Diag"); });
      if (!amdDiag) {
        // Check if strategy is somewhere in the charts model
        var chartModel = chart._chartWidget ? chart._chartWidget.model() : null;
        if (!chartModel) return "no chart model";
        var studyList = chartModel.getAllStudies ? chartModel.getAllStudies() : null;
        return "no AMD Diag in getAllStudies. chartModel keys: " + (studyList ? studyList.length + " studies" : "no getAllStudies");
      }
      return "found AMD Diag: " + JSON.stringify(amdDiag);
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("amd diag:", r2.result.value);

// Check the strategy report - is there a reportData for any study?
const r3 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var studies = chart.getAllStudies();
      var results = [];
      studies.forEach(function(s) {
        try {
          var study = chart.getStudyById(s.id);
          if (study && study._study) {
            var rd = study._study._reportData;
            var hasRd = rd !== null && rd !== undefined && typeof rd === "object" && !(rd instanceof Function);
            if (hasRd) {
              var val = rd._value !== undefined ? rd._value : (rd.value !== undefined ? rd.value : null);
              results.push(s.name + ": reportData._value type=" + typeof val + " " + (val ? JSON.stringify(val).slice(0,50) : "null"));
            }
          }
        } catch(e) {}
      });
      return results.join("; ") || "no study has reportData";
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("reportData check:", r3.result.value);

// Check what "AMD OTE — " corresponds to by looking at the strategy tester panel deeper
const r4 = await Runtime.evaluate({
  expression: `(function() {
    // Find the strategy name in the strategy tester and look for its ID
    var all = Array.from(document.querySelectorAll("*"))
      .filter(function(el) { return el.offsetParent !== null; });

    var stratName = all.find(function(el) {
      return el.textContent.includes("AMD OTE Diag") && el.textContent.length < 50;
    });

    if (stratName) {
      // Try to find React fiber to get the strategy ID
      var fk = Object.keys(stratName).find(function(k) { return k.startsWith("__reactFiber"); });
      if (fk) {
        var fiber = stratName[fk];
        for (var d = 0; d < 30 && fiber; d++) {
          var p = fiber.memoizedProps;
          if (p && p.entityId) return "entityId=" + p.entityId;
          if (p && p.studyId) return "studyId=" + p.studyId;
          fiber = fiber.return;
        }
      }
      var r = stratName.getBoundingClientRect();
      return "found at y=" + r.top.toFixed(0) + " text=" + stratName.textContent.trim();
    }
    return "AMD OTE Diag not found in DOM";
  })()`,
  returnByValue: true
});
console.log("strategy DOM:", r4.result.value);

await client.close();
