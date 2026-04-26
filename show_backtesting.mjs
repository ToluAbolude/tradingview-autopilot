import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Get model and call showBacktesting
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById("VBb1Zy");
      if (!study) return "no study";
      var s = study._study;
      window.__btPromise = s.pineSourceCodeModel().then(function(model) {
        window.__btModel = model;
        model.showBacktesting();
        window.__btCalled = true;
      }).catch(function(e) { window.__btError = e.message; });
      return "promise created";
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("init:", r1.result.value);

await new Promise(r => setTimeout(r, 5000));

const r2 = await Runtime.evaluate({
  expression: `(function() {
    return JSON.stringify({
      called: window.__btCalled,
      error: window.__btError,
      hasModel: !!window.__btModel
    });
  })()`,
  returnByValue: true
});
console.log("status:", r2.result.value);

// Check if strategy tester appeared
const r3 = await Runtime.evaluate({
  expression: `(function() {
    var all = Array.from(document.querySelectorAll("*"))
      .filter(function(el) { return el.offsetParent !== null; });

    // Look for "Net Profit" or "Total trades"
    var npEl = all.find(function(e) { return e.textContent.trim() === "Net Profit"; });
    var ttEl = all.find(function(e) { return e.textContent.trim() === "Total Closed Trades"; });
    if (npEl || ttEl) {
      return "strategy tester metrics found!";
    }

    // Look for strategy tester panel
    var stEl = all.find(function(el) { return el.textContent.includes("Strategy Report") && el.textContent.length < 30; });
    if (stEl) {
      var r = stEl.getBoundingClientRect();
      return "Strategy Report tab at y=" + r.top.toFixed(0);
    }

    return "no strategy tester metrics visible";
  })()`,
  returnByValue: true
});
console.log("tester visible:", r3.result.value);

// Check AMD OTE _reportData now
const r4 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById("VBb1Zy");
      var s = study._study;
      var rd = s._reportData;
      if (rd && typeof rd === "object") {
        var val = rd._value !== undefined ? rd._value : (rd.value !== undefined ? rd.value : null);
        return "_reportData: " + (val ? JSON.stringify(val).slice(0,300) : "val is null. keys=" + Object.keys(rd).slice(0,10).join(","));
      }
      return "_reportData null/undefined, type=" + typeof rd;
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("report data:", r4.result.value);

await client.close();
