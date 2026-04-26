import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
import { readFileSync } from "fs";

const code = readFileSync("/tmp/amd_ote_runner.pine", "utf8");
const modifiedCode = "// AMD OTE Diagnostic v" + Date.now() + "\n" + code;

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime, Input } = client;
await Runtime.enable();

await Runtime.evaluate({ expression: `window.__modCode = ${JSON.stringify(modifiedCode)}`, returnByValue: true });

// Inject using executeEdits to properly trigger change events
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var el = document.querySelector(".pine-editor-monaco .inputarea");
      if (!el) return "no inputarea";
      var cur = el;
      for (var u = 0; u < 5; u++) {
        cur = cur.parentElement;
        if (!cur) break;
        var keys = Object.keys(cur);
        var fk = keys.find(function(k) { return k.startsWith("__reactFiber"); });
        if (fk) {
          var fiber = cur[fk];
          for (var d = 0; d < 100 && fiber; d++) {
            var p = fiber.memoizedProps;
            if (p && p.value && p.value.monacoEnv) {
              var monacoEnv = p.value.monacoEnv;
              var eds = monacoEnv.editor.getEditors();
              if (eds.length > 0) {
                var ed = eds[0];
                var m = ed.getModel();
                if (m) {
                  // Use executeEdits for proper change tracking
                  var fullRange = m.getFullModelRange();
                  ed.executeEdits("external-inject", [{
                    range: fullRange,
                    text: window.__modCode,
                    forceMoveMarkers: true
                  }]);
                  ed.focus();
                  // Also trigger model content changed event
                  m.pushStackElement();
                  return "executeEdits done len=" + window.__modCode.length;
                }
              }
              return "no editors";
            }
            fiber = fiber.return;
          }
        }
      }
      return "no fiber";
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("inject via edits:", r1.result.value);

await new Promise(r => setTimeout(r, 500));

// Try clicking Update on chart button
const r2 = await Runtime.evaluate({
  expression: `(function() {
    var btns = Array.from(document.querySelectorAll("button"))
      .filter(function(b) { return b.offsetParent !== null; });
    var btn = btns.find(function(b) { return b.title === "Update on chart" || b.title === "Add to chart"; });
    if (btn) {
      var r = btn.getBoundingClientRect();
      btn.click();
      return "clicked: " + btn.title + " at x=" + r.x.toFixed(0) + " y=" + r.y.toFixed(0);
    }
    return "no compile btn";
  })()`,
  returnByValue: true
});
console.log("click:", r2.result.value);

await new Promise(r => setTimeout(r, 8000));

// Check console
const r3 = await Runtime.evaluate({
  expression: `(function() {
    var c = document.querySelector("[class*='console']");
    if (!c) return "no console";
    var text = c.textContent;
    // Get last 500 chars
    return text.slice(-500);
  })()`,
  returnByValue: true
});
console.log("console:", r3.result.value);

// Check studies
const r4 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var studies = chart.getAllStudies();
      return JSON.stringify(studies.map(function(s) { return {id: s.id, name: s.name}; }));
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("studies:", r4.result.value);

await client.close();
