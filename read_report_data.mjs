import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Store the report data in a window global
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById("VBb1Zy");
      if (!study) return "no study";
      var s = study._study;
      var rd = s._reportData;
      if (!rd) return "no _reportData";
      window.__reportData = rd;
      return "type=" + typeof rd + " keys=" + Object.keys(rd).slice(0,20).join(",");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("reportData:", r1.result.value);

// Get the actual values
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var rd = window.__reportData;
      if (!rd) return "no rd";
      // Try to serialize it
      var result = {};
      var keys = Object.keys(rd);
      keys.forEach(function(k) {
        var v = rd[k];
        if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") {
          result[k] = v;
        } else if (v && typeof v === "object") {
          result[k] = JSON.stringify(v).slice(0,100);
        }
      });
      return JSON.stringify(result).slice(0, 2000);
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("report values:", r2.result.value);

// Also try _reportDataBuffer
const r3 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById("VBb1Zy");
      var s = study._study;
      var buf = s._reportDataBuffer;
      if (!buf) return "no buffer";
      return "buffer type=" + typeof buf + " len=" + (Array.isArray(buf) ? buf.length : Object.keys(buf).length);
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("buffer:", r3.result.value);

// Try a deeper inspection
const r4 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById("VBb1Zy");
      var s = study._study;
      var rd = s._reportData;
      // Check if it has a getValue or similar
      if (rd && typeof rd.getValue === "function") {
        var v = rd.getValue();
        return "getValue result: " + JSON.stringify(v).slice(0,500);
      }
      // Check if it's a BehaviorSubject or observable
      if (rd && rd._value !== undefined) {
        return "_value: " + JSON.stringify(rd._value).slice(0,500);
      }
      if (rd && rd.value !== undefined) {
        return ".value: " + JSON.stringify(rd.value).slice(0,500);
      }
      // List methods
      var proto = Object.getPrototypeOf(rd);
      var methods = Object.getOwnPropertyNames(proto).slice(0,20);
      return "proto methods: " + methods.join(", ");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("deep inspect:", r4.result.value);

await client.close();
