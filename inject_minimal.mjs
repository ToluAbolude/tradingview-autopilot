import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
import { readFileSync } from "fs";

const code = readFileSync("/tmp/minimal_test.pine", "utf8");

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

await Runtime.evaluate({ expression: `window.__minCode = ${JSON.stringify(code)}`, returnByValue: true });

// Inject using executeEdits
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
              var eds = p.value.monacoEnv.editor.getEditors();
              if (eds.length > 0) {
                var ed = eds[0];
                var m = ed.getModel();
                if (m) {
                  var fullRange = m.getFullModelRange();
                  ed.executeEdits("inject", [{ range: fullRange, text: window.__minCode, forceMoveMarkers: true }]);
                  ed.focus();
                  m.pushStackElement();
                  return "injected minimal len=" + window.__minCode.length;
                }
              }
            }
            fiber = fiber.return;
          }
        }
      }
      return "no fiber found";
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("inject:", r1.result.value);

await new Promise(r => setTimeout(r, 300));

// Click Update on chart
const r2 = await Runtime.evaluate({
  expression: `(function() {
    var btn = Array.from(document.querySelectorAll("button"))
      .filter(function(b) { return b.offsetParent !== null; })
      .find(function(b) { return b.title === "Update on chart" || b.title === "Add to chart"; });
    if (btn) { btn.click(); return "clicked: " + btn.title; }
    return "no btn";
  })()`,
  returnByValue: true
});
console.log("click:", r2.result.value);

await new Promise(r => setTimeout(r, 8000));

// Check console
const r3 = await Runtime.evaluate({
  expression: `(function() {
    var c = document.querySelector("[class*='console']");
    return c ? c.textContent.slice(-300) : "no console";
  })()`,
  returnByValue: true
});
console.log("console:", r3.result.value);

await client.close();
