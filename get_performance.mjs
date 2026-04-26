import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Try reportData() method
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById("VBb1Zy");
      var s = study._study;
      var rd = s.reportData();
      if (!rd) return "reportData() returned null/undefined";
      window.__rd = rd;
      return "reportData type=" + typeof rd + " keys=" + Object.keys(rd).slice(0,20).join(",");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("reportData():", r1.result.value);

// Try performance property
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById("VBb1Zy");
      var s = study._study;
      var perf = s.performance;
      if (!perf) return "performance is null";
      window.__perf = perf;
      var keys = typeof perf === "object" ? Object.keys(perf).slice(0,20) : [];
      return "performance type=" + typeof perf + " keys=" + keys.join(",");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("performance:", r2.result.value);

// Try metric property
const r3 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById("VBb1Zy");
      var s = study._study;
      var m = s.metric;
      if (!m) return "metric is null";
      // Check if it's a BehaviorSubject
      var val = m._value !== undefined ? m._value : (m.value !== undefined ? m.value : null);
      if (val) {
        return "metric value: " + JSON.stringify(val).slice(0,200);
      }
      return "metric type=" + typeof m + " keys=" + (typeof m === "object" ? Object.keys(m).slice(0,10).join(",") : "");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("metric:", r3.result.value);

// Try state and stateCustomFields
const r4 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById("VBb1Zy");
      var s = study._study;
      var state = s.state;
      if (!state) return "state is null";
      var val = state._value !== undefined ? state._value : (state.value !== undefined ? state.value : null);
      return "state: " + JSON.stringify(val).slice(0, 300);
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("state:", r4.result.value);

// Explore __rd structure if we got it
const r5 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var rd = window.__rd;
      if (!rd) return "no __rd";
      // Walk keys looking for trade/profit data
      function walk(obj, depth, prefix) {
        if (depth > 3 || !obj || typeof obj !== "object") return;
        Object.keys(obj).forEach(function(k) {
          var v = obj[k];
          if (typeof v === "number" || typeof v === "string") {
            window.__rdFlat = window.__rdFlat || {};
            window.__rdFlat[prefix + k] = v;
          } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
            walk(v, depth+1, prefix + k + ".");
          }
        });
      }
      window.__rdFlat = {};
      walk(rd, 0, "");
      var flat = window.__rdFlat;
      var keys = Object.keys(flat);
      return keys.length + " flat keys. Sample: " + JSON.stringify(Object.fromEntries(keys.slice(0,20).map(function(k) { return [k, flat[k]]; }))).slice(0,500);
    } catch(e) { return "ERR walk: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("rd walk:", r5.result.value);

await client.close();
