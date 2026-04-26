import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Get pineSourceCodeModel result
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById("VBb1Zy");
      if (!study) return "no study";
      var s = study._study;
      window.__psmPromise = s.pineSourceCodeModel();
      window.__psmPromise.then(function(model) {
        window.__psmResult = model;
        window.__psmDone = true;
        // Check if model has source code
        var methods = Object.getOwnPropertyNames(Object.getPrototypeOf(model));
        window.__psmMethods = methods.join(",");
      }).catch(function(e) {
        window.__psmError = e.message;
        window.__psmDone = true;
      });
      return "promise created";
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("promise:", r1.result.value);

// Wait for it
await new Promise(r => setTimeout(r, 3000));

const r2 = await Runtime.evaluate({
  expression: `(function() {
    if (!window.__psmDone) return "not done yet";
    if (window.__psmError) return "error: " + window.__psmError;
    var model = window.__psmResult;
    if (!model) return "model is null";
    return "methods: " + (window.__psmMethods || "none");
  })()`,
  returnByValue: true
});
console.log("model methods:", r2.result.value);

// Call showPineSourceCode to see what it does and get source
const r3 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var model = window.__psmResult;
      if (!model) return "no model";
      // Try to get source code directly
      if (typeof model.getSourceCode === "function") {
        return "getSourceCode: " + model.getSourceCode().slice(0,200);
      }
      if (typeof model.source === "string") {
        return "source: " + model.source.slice(0,200);
      }
      // List all properties
      var props = [];
      var obj = model;
      while (obj && obj !== Object.prototype) {
        Object.getOwnPropertyNames(obj).forEach(function(k) {
          if (props.indexOf(k) === -1) props.push(k);
        });
        obj = Object.getPrototypeOf(obj);
      }
      // Filter for source-related
      var src = props.filter(function(p) { return p.toLowerCase().includes("source") || p.toLowerCase().includes("code") || p.toLowerCase().includes("pine"); });
      return "source-related props: " + src.join(", ") + "\n first 10 props: " + props.slice(0,10).join(", ");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("model inspect:", r3.result.value);

await client.close();
