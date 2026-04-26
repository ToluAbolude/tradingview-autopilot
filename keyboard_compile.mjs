import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
import { readFileSync } from "fs";

const code = readFileSync("/tmp/amd_ote_runner.pine", "utf8");

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime, Input } = client;
await Runtime.enable();

// First: inject a slightly MODIFIED version of the code (add a comment at top to make it "different")
const modifiedCode = "// diagnostic v" + Date.now() + "\n" + code;
await Runtime.evaluate({ expression: `window.__modCode = ${JSON.stringify(modifiedCode)}`, returnByValue: true });

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
                var m = eds[0].getModel();
                if (m) {
                  m.setValue(window.__modCode);
                  eds[0].focus();
                  return "injected modified len=" + window.__modCode.length + " first=" + window.__modCode.slice(0,30);
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
console.log("inject:", r1.result.value);

await new Promise(r => setTimeout(r, 300));

// Focus the editor
const r2 = await Runtime.evaluate({
  expression: `(function() {
    var ta = document.querySelector(".pine-editor-monaco .inputarea");
    if (!ta) return "no textarea";
    ta.focus();
    return "focused";
  })()`,
  returnByValue: true
});
console.log("focus:", r2.result.value);

await new Promise(r => setTimeout(r, 200));

// Send Ctrl+Enter to compile and add to chart
await Input.dispatchKeyEvent({
  type: "keyDown",
  modifiers: 4,  // Ctrl=4, Shift=8, Alt=1
  key: "Enter",
  code: "Enter",
  keyCode: 13,
  windowsVirtualKeyCode: 13,
  nativeVirtualKeyCode: 13
});
await new Promise(r => setTimeout(r, 50));
await Input.dispatchKeyEvent({
  type: "keyUp",
  modifiers: 4,
  key: "Enter",
  code: "Enter",
  keyCode: 13,
  windowsVirtualKeyCode: 13,
  nativeVirtualKeyCode: 13
});
console.log("sent Ctrl+Enter");

await new Promise(r => setTimeout(r, 8000));

// Check console for compile result
const r3 = await Runtime.evaluate({
  expression: `(function() {
    var c = document.querySelector("[class*='console']");
    return c ? c.textContent.slice(-400) : "no console";
  })()`,
  returnByValue: true
});
console.log("console:", r3.result.value);

// Check all studies
const r4 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var studies = chart.getAllStudies();
      return studies.map(function(s) { return s.id + "=" + s.name; }).join(", ");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("studies:", r4.result.value);

await client.close();
