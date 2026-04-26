import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Try resetData to force recalculation
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      chart.resetData();
      return "resetData called";
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("resetData:", r1.result.value);

await new Promise(r => setTimeout(r, 8000));

// Check reportData now
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById("VBb1Zy");
      if (!study) return "no study";
      var s = study._study;
      var rd = s._reportData;
      if (!rd) return "no _reportData";
      var val = rd._value;
      if (val === null || val === undefined) return "_reportData._value still null";
      window.__reportVal = val;
      return "GOT VALUE: type=" + typeof val + " keys=" + Object.keys(val).slice(0,20).join(",");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("reportData:", r2.result.value);

// Get strategy performance via _reportDataBuffer
const r3 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById("VBb1Zy");
      var s = study._study;
      var buf = s._reportDataBuffer;
      if (!buf) return "no buffer";
      return "buffer type=" + typeof buf + " val=" + JSON.stringify(buf).slice(0,200);
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("buffer:", r3.result.value);

// Subscribe to reportChanged to get data
const r4 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById("VBb1Zy");
      var s = study._study;
      window.__reportReceived = null;
      // Check if reportChanged is an observable
      var rc = s._reportChanged;
      if (rc && typeof rc.subscribe === "function") {
        rc.subscribe(function(data) {
          window.__reportReceived = data;
          console.log("report changed!", JSON.stringify(data).slice(0,200));
        });
        return "subscribed to _reportChanged";
      }
      // Try reportChanged method
      var rc2 = s.reportChanged;
      if (rc2 && typeof rc2 === "object" && typeof rc2.subscribe === "function") {
        rc2.subscribe(function(data) {
          window.__reportReceived2 = data;
        });
        return "subscribed to reportChanged (method result)";
      }
      return "no subscribable: _reportChanged type=" + typeof s._reportChanged + " reportChanged type=" + typeof s.reportChanged;
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("subscribe:", r4.result.value);

await new Promise(r => setTimeout(r, 5000));

// Check if subscription received data
const r5 = await Runtime.evaluate({
  expression: `(function() {
    if (window.__reportReceived) {
      return "received: " + JSON.stringify(window.__reportReceived).slice(0,300);
    }
    if (window.__reportReceived2) {
      return "received2: " + JSON.stringify(window.__reportReceived2).slice(0,300);
    }
    return "no data received yet";
  })()`,
  returnByValue: true
});
console.log("subscription:", r5.result.value);

await client.close();
