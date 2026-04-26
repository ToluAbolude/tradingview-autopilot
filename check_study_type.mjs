import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Check study types for VBb1Zy and 5glldj
for (const id of ["VBb1Zy", "5glldj"]) {
  const r = await Runtime.evaluate({
    expression: `(function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        var study = chart.getStudyById("${id}");
        if (!study) return "no study ${id}";
        var s = study._study;
        // Check type-related properties
        var info = {
          type: s._type,
          isStrategy: typeof s.strategyOrdersPaneView,
          hasReportData: s._reportData !== null && s._reportData !== undefined,
          reportChangedType: typeof s._reportChanged
        };
        return "${id}: " + JSON.stringify(info);
      } catch(e) { return "${id} ERR: " + e.message; }
    })()`,
    returnByValue: true
  });
  console.log(r.result.value);
}

// Check what type the strategy tester expects
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      // Find all studies that have strategy methods
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var studies = chart.getAllStudies();
      var stratStudies = studies.filter(function(s) {
        try {
          var st = chart.getStudyById(s.id)._study;
          return typeof st.strategyOrdersPaneView === "function" || st._reportData !== null;
        } catch(e) { return false; }
      });
      return "strategy studies: " + stratStudies.map(function(s) { return s.id + "=" + s.name; }).join(", ");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("all strategy studies:", r2.result.value);

// Check the source of VBb1Zy to see if it uses strategy()
const r3 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById("VBb1Zy");
      var s = study._study;
      // Check pineSourceCodeModel
      var psm = s.pineSourceCodeModel;
      if (typeof psm === "function") {
        // It's a method
        window.__psmPromise = s.pineSourceCodeModel();
        return "pineSourceCodeModel is function, promise created";
      } else if (psm) {
        return "pineSourceCodeModel type=" + typeof psm;
      }
      return "no pineSourceCodeModel";
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("pine source:", r3.result.value);

await client.close();
