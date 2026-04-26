import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
import { readFileSync } from "fs";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Step 1: Ensure we're on XAUUSD 15m
await Runtime.evaluate({
  expression: `window.TradingViewApi._activeChartWidgetWV.value().setSymbol("BLACKBULL:XAUUSD")`,
  returnByValue: true
});
await new Promise(r => setTimeout(r, 1500));

// Step 2: Get the AMD_OTE study's pineSourceCodeModel and call showPineSourceCode
const r1 = await Runtime.evaluate({
  expression: `(async function() {
    var api = window.TradingViewApi;
    var aw = api._activeChartWidgetWV.value();
    var s = aw.getStudyById("VBb1Zy");
    if (!s) return "study not found";
    var model = await s._study.pineSourceCodeModel();
    window.__pscm = model;
    model.showPineSourceCode();
    return "showPineSourceCode called, title=" + model.title();
  })()`,
  returnByValue: false,
  awaitPromise: true
});
console.log("open result:", JSON.stringify(r1.result).slice(0, 200));

await new Promise(r => setTimeout(r, 2000));

// Step 3: Check what's in the Pine editor now
const r2 = await Runtime.evaluate({
  expression: `(function() {
    var widget = document.querySelector(".tv-script-widget");
    return widget ? widget.textContent.slice(0, 80).replace(/\n/g, " ") : "no widget";
  })()`,
  returnByValue: true
});
console.log("editor shows:", r2.result.value);

// Step 4: Check what Monaco model has now
const r3 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var el = document.querySelector(".pine-editor-monaco .inputarea");
      for (var i = 0; i < 3; i++) el = el && el.parentElement;
      var fk = Object.keys(el).find(function(k) { return k.startsWith("__reactFiber"); });
      var cur = el[fk];
      for (var d = 0; d < 30 && cur; d++) {
        var p = cur.memoizedProps;
        if (p && p.value && p.value.monacoEnv) {
          var mods = p.value.monacoEnv.editor.getModels();
          if (mods.length > 0) {
            var uri = mods[0].uri ? mods[0].uri.toString() : "no-uri";
            var first60 = mods[0].getValue().slice(0, 60).replace(/[^\x20-\x7E]/g, "?").replace(/\n/g, "\\n");
            return "model uri=" + uri + " first=" + first60;
          }
          return "no models";
        }
        cur = cur.return;
      }
      return "no monacoEnv";
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("monaco model:", r3.result.value);

await client.close();
