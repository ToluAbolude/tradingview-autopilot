import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
import { readFileSync } from "fs";

const code = readFileSync("/tmp/amd_ote_runner.pine", "utf8");

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime, Input } = client;
await Runtime.enable();

// Step 1: Close Pine Editor
const r0 = await Runtime.evaluate({
  expression: `(function() {
    var closeBtn = Array.from(document.querySelectorAll("button"))
      .find(function(b) { return b.getAttribute("aria-label") === "Close" && b.offsetParent !== null; });
    if (closeBtn) { closeBtn.click(); return "closed"; }
    return "no close btn";
  })()`,
  returnByValue: true
});
console.log("close:", r0.result.value);

await new Promise(r => setTimeout(r, 1000));

// Step 2: Open Pine Editor by clicking Pine button
const r1 = await Runtime.evaluate({
  expression: `(function() {
    var btn = Array.from(document.querySelectorAll("button"))
      .find(function(b) { return b.getAttribute("aria-label") === "Pine"; });
    if (btn) { btn.click(); return "clicked pine"; }
    return "no pine btn";
  })()`,
  returnByValue: true
});
console.log("open:", r1.result.value);

await new Promise(r => setTimeout(r, 3000));

// Step 3: Check editor state
const r2 = await Runtime.evaluate({
  expression: `(function() {
    var inputArea = document.querySelector(".pine-editor-monaco .inputarea");
    if (!inputArea) return "no inputarea yet";
    var r = inputArea.getBoundingClientRect();
    return "inputarea at y=" + r.y.toFixed(0);
  })()`,
  returnByValue: true
});
console.log("editor:", r2.result.value);

// Step 4: Set code and inject
await Runtime.evaluate({ expression: `window.__newCode = ${JSON.stringify(code)}`, returnByValue: true });

const r3 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var el = document.querySelector(".pine-editor-monaco .inputarea");
      if (!el) return "no inputarea";
      for (var i = 0; i < 3; i++) el = el && el.parentElement;
      var fk = Object.keys(el).find(function(k) { return k.startsWith("__reactFiber"); });
      var cur = el[fk];
      for (var d = 0; d < 50 && cur; d++) {
        var p = cur.memoizedProps;
        if (p && p.value && p.value.monacoEnv) {
          var eds = p.value.monacoEnv.editor.getEditors();
          if (eds.length > 0) {
            var m = eds[0].getModel();
            if (m) {
              var first50 = m.getValue().slice(0,50).replace(/\n/g,"|");
              m.setValue(window.__newCode);
              eds[0].focus();
              return "injected len=" + window.__newCode.length + " was=" + first50;
            }
          }
          return "no editors";
        }
        cur = cur.return;
      }
      return "no monacoEnv";
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("inject:", r3.result.value);

await new Promise(r => setTimeout(r, 1000));

// Step 5: Find and click the "Add to chart" or "Update on chart" button
const r4 = await Runtime.evaluate({
  expression: `(function() {
    var btns = Array.from(document.querySelectorAll("button"))
      .filter(function(b) { return b.offsetParent !== null; });
    var btn = btns.find(function(b) { return b.title === "Update on chart" || b.title === "Add to chart"; });
    if (btn) {
      var r = btn.getBoundingClientRect();
      return "btn=" + btn.title + " at x=" + r.x.toFixed(0) + " y=" + r.y.toFixed(0);
    }
    // List visible buttons
    return "no compile btn. Visible btns: " + btns.slice(0,10).map(function(b) { return b.title + "|" + b.textContent.trim().slice(0,15); }).join(", ");
  })()`,
  returnByValue: true
});
console.log("compile btn:", r4.result.value);

// Click via Input API for reliability
if (r4.result.value && r4.result.value.includes("btn=")) {
  const match = r4.result.value.match(/x=(\d+).*y=(\d+)/);
  if (match) {
    const x = parseInt(match[1]) + 5;
    const y = parseInt(match[2]) + 5;
    await Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await new Promise(r => setTimeout(r, 100));
    await Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    console.log("clicked compile at", x, y);
  }
}

await client.close();
