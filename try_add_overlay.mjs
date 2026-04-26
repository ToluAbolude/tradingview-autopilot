import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
import { readFileSync } from "fs";

const code = readFileSync("/tmp/amd_ote_runner.pine", "utf8");

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Check addOverlayStudy signature
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      return "addOverlayStudy: " + chart.addOverlayStudy.toString().slice(0,300);
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("addOverlayStudy:", r1.result.value);

// Explore the Pine widget to understand how "Add to chart" works
// The key is finding the internal method that the "Update on chart" button calls
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var el = document.querySelector(".pine-editor-monaco .inputarea");
      if (!el) return "no inputarea";
      // Walk up to find the Pine Editor component
      var cur = el;
      for (var u = 0; u < 25; u++) {
        cur = cur.parentElement;
        if (!cur) break;
        var keys = Object.keys(cur);
        var fk = keys.find(function(k) { return k.startsWith("__reactFiber"); });
        if (fk) {
          var fiber = cur[fk];
          for (var d = 0; d < 150 && fiber; d++) {
            var p = fiber.memoizedProps;
            if (p && typeof p.onApplyToChart === "function") {
              return "found onApplyToChart at DOM level " + u + " fiber depth " + d;
            }
            if (p && typeof p.applyScript === "function") {
              return "found applyScript at DOM level " + u + " fiber depth " + d;
            }
            if (p && p.onApply) {
              return "found onApply at DOM level " + u + " fiber depth " + d;
            }
            if (p && p.onCompile) {
              return "found onCompile at DOM level " + u + " fiber depth " + d;
            }
            // Check for any "apply" related props
            var applyKeys = Object.keys(p || {}).filter(function(k) {
              return k.toLowerCase().includes("apply") || k.toLowerCase().includes("compile") || k.toLowerCase().includes("update");
            });
            if (applyKeys.length > 0 && d > 5) {
              return "apply keys at DOM " + u + " fiber " + d + ": " + applyKeys.join(",");
            }
            fiber = fiber.return;
          }
        }
      }
      return "not found";
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("apply handler:", r2.result.value);

// Check what happens when Update on chart button is clicked - inspect its click handler
const r3 = await Runtime.evaluate({
  expression: `(function() {
    var btns = Array.from(document.querySelectorAll("button"))
      .filter(function(b) { return b.offsetParent !== null; });
    var btn = btns.find(function(b) { return b.title === "Update on chart"; });
    if (!btn) return "no btn";

    // Get react fiber for the button
    var fk = Object.keys(btn).find(function(k) { return k.startsWith("__reactFiber") || k.startsWith("__reactEvent"); });
    if (!fk) return "no react key. btn keys: " + Object.keys(btn).slice(0,10).join(",");

    var fiber = btn[fk];
    if (!fiber) return "fiber null";

    // Look at the button's props to find onClick
    var props = fiber.memoizedProps;
    if (props && props.onClick) {
      return "onClick found: " + typeof props.onClick;
    }
    // Try eventData
    var evKeys = Object.keys(btn).filter(function(k) { return k.startsWith("__reactEvent") || k.startsWith("__react"); });
    return "evKeys: " + evKeys.join(", ");
  })()`,
  returnByValue: true
});
console.log("btn handler:", r3.result.value);

await client.close();
