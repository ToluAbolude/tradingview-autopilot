import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
import { readFileSync } from "fs";

const code = readFileSync("/tmp/amd_ote_runner.pine", "utf8");

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime, Input } = client;
await Runtime.enable();

// Set code global
await Runtime.evaluate({ expression: `window.__newCode = ${JSON.stringify(code)}`, returnByValue: true });

// Inject code into Monaco
const r1 = await Runtime.evaluate({
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
            if (m) {
              m.setValue(window.__newCode);
              // Also trigger a change event
              eds[0].focus();
              return "injected+focused len=" + window.__newCode.length;
            }
          }
          return "no model";
        }
        cur = cur.return;
      }
      return "no monacoEnv";
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("inject:", r1.result.value);

await new Promise(r => setTimeout(r, 800));

// Find the inputarea and click it, then use Ctrl+Enter or similar
const r2 = await Runtime.evaluate({
  expression: `(function() {
    var ta = document.querySelector(".pine-editor-monaco .inputarea");
    if (!ta) return "no textarea";
    ta.focus();
    return "textarea focused at y=" + ta.getBoundingClientRect().y.toFixed(0);
  })()`,
  returnByValue: true
});
console.log("focus:", r2.result.value);

// Click the Update on chart button using mouse click simulation
const r3 = await Runtime.evaluate({
  expression: `(function() {
    var btns = Array.from(document.querySelectorAll("button"));
    var b = btns.find(function(x) { return x.title === "Update on chart"; });
    if (!b) return "btn not found";
    var rect = b.getBoundingClientRect();
    return "btn at x=" + rect.x.toFixed(0) + " y=" + rect.y.toFixed(0);
  })()`,
  returnByValue: true
});
console.log("btn pos:", r3.result.value);

// Simulate a real mouse click at button position
if (r3.result.value && r3.result.value.includes("btn at x=")) {
  const match = r3.result.value.match(/x=(\d+).*y=(\d+)/);
  if (match) {
    const x = parseInt(match[1]) + 5;
    const y = parseInt(match[2]) + 5;
    await Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await new Promise(r => setTimeout(r, 100));
    await Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    console.log("mouse clicked at", x, y);
  }
}

await client.close();
