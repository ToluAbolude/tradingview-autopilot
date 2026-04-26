import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
import { readFileSync } from "fs";

const code = readFileSync("/tmp/amd_ote_runner.pine", "utf8");

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// 1. Ensure XAUUSD 15m
await Runtime.evaluate({
  expression: `window.TradingViewApi._activeChartWidgetWV.value().setSymbol("BLACKBULL:XAUUSD")`,
  returnByValue: true
});
await new Promise(r => setTimeout(r, 1500));

// 2. Set the code as a global
await Runtime.evaluate({
  expression: `window.__newCode = ${JSON.stringify(code)}`,
  returnByValue: true
});

// 3. Inject into Monaco editor
const r3 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var el = document.querySelector(".pine-editor-monaco .inputarea");
      if (!el) return "no inputarea";
      for (var i = 0; i < 3; i++) el = el && el.parentElement;
      var fk = Object.keys(el).find(function(k) { return k.startsWith("__reactFiber"); });
      var cur = el[fk];
      for (var d = 0; d < 30 && cur; d++) {
        var p = cur.memoizedProps;
        if (p && p.value && p.value.monacoEnv) {
          var eds = p.value.monacoEnv.editor.getEditors();
          if (eds.length > 0) {
            var m = eds[0].getModel();
            if (m) { m.setValue(window.__newCode); return "injected len=" + window.__newCode.length; }
          }
          return "no editors or model";
        }
        cur = cur.return;
      }
      return "no monacoEnv found";
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("inject:", r3.result.value);

await new Promise(r => setTimeout(r, 500));

// 4. Click Update on chart
const r4 = await Runtime.evaluate({
  expression: `(function() {
    var btns = Array.from(document.querySelectorAll("button"));
    var compileBtn = btns.find(function(b) { return b.title === "Update on chart"; });
    if (compileBtn) { compileBtn.click(); return "clicked update"; }
    return "compile btn not found";
  })()`,
  returnByValue: true
});
console.log("compile:", r4.result.value);

await client.close();
