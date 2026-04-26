import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
const client = await CDP({ port: 9222 });
const { Runtime } = client;
await Runtime.enable();

// Explore chart widget defs to find XAUUSD
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var api = window.TradingViewApi;
      var col = api._chartWidgetCollection;
      var defs = col._chartWidgetsDefs;
      if (!defs) return "no defs";
      var type = typeof defs;
      // Is it an array or map?
      var len = Array.isArray(defs) ? defs.length : (defs.size || Object.keys(defs).length);
      return "defs type=" + type + " len=" + len;
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("defs:", r1.result.value);

// Try to iterate chart widgets
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var api = window.TradingViewApi;
      var col = api._chartWidgetCollection;
      var defs = col._chartWidgetsDefs;
      var out = [];

      // Try as array
      if (Array.isArray(defs)) {
        defs.forEach(function(d, i) {
          try {
            var w = d && (d.value ? d.value() : d);
            var sym = w && w.symbol ? w.symbol() : "?";
            out.push("[" + i + "] sym=" + sym);
          } catch(e2) { out.push("[" + i + "] ERR=" + e2.message); }
        });
      } else if (defs && defs.forEach) {
        // Map
        defs.forEach(function(d, k) {
          try {
            var w = d && (d.value ? d.value() : d);
            var sym = w && w.symbol ? w.symbol() : "?";
            out.push("[" + k + "] sym=" + sym);
          } catch(e2) { out.push("[" + k + "] ERR=" + e2.message); }
        });
      } else {
        // Object keys
        Object.keys(defs).forEach(function(k) {
          out.push(k + "=" + typeof defs[k]);
        });
      }
      return out.join(" | ");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("chart list:", r2.result.value);

// Try the _activeIndex approach to switch charts
const r3 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var api = window.TradingViewApi;
      var col = api._chartWidgetCollection;
      return "activeIndex=" + col._activeIndex + " layoutType=" + col._layoutType;
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("active:", r3.result.value);

await client.close();
