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

// Step 2: Open Pine Editor
const r1 = await Runtime.evaluate({
  expression: `(function() {
    var btn = Array.from(document.querySelectorAll("button"))
      .find(function(b) { return b.getAttribute("aria-label") === "Pine"; });
    if (btn) { btn.click(); return "clicked pine"; }
    return "no pine btn";
  })()`,
  returnByValue: true
});
console.log("open pine:", r1.result.value);

await new Promise(r => setTimeout(r, 3000));

// Step 3: Find new script button / + tab button
const r2 = await Runtime.evaluate({
  expression: `(function() {
    var all = Array.from(document.querySelectorAll("button, [role='button'], [class*='tab']"))
      .filter(function(el) { return el.offsetParent !== null; });

    // Look for + or New button
    var newBtn = all.find(function(el) {
      var text = el.textContent.trim();
      var aria = el.getAttribute("aria-label") || "";
      var title = el.title || "";
      return text === "+" || aria.includes("New") || title.includes("New") ||
             aria.includes("new") || text === "New script" ||
             el.className.includes("new") || el.className.includes("add");
    });

    if (newBtn) {
      var r = newBtn.getBoundingClientRect();
      return "new btn found at x=" + r.x.toFixed(0) + " y=" + r.y.toFixed(0) + " text=" + newBtn.textContent.trim().slice(0,20) + " aria=" + (newBtn.getAttribute("aria-label")||"");
    }

    // List visible elements in Pine Editor area
    var pineArea = all.filter(function(el) {
      var r = el.getBoundingClientRect();
      return r.left > 1050 && r.top < 200;
    }).map(function(el) {
      return el.textContent.trim().slice(0,20) + "|aria=" + (el.getAttribute("aria-label")||"") + "|title=" + (el.title||"");
    });
    var seen = {};
    return "Pine area btns: " + pineArea.filter(function(t) { if(seen[t]) return false; seen[t]=1; return true; }).slice(0,10).join(" | ");
  })()`,
  returnByValue: true
});
console.log("new btn:", r2.result.value);

// Step 4: Check if Pine Editor loaded
const r3 = await Runtime.evaluate({
  expression: `(function() {
    var inputArea = document.querySelector(".pine-editor-monaco .inputarea");
    if (!inputArea) return "no inputarea";
    var r = inputArea.getBoundingClientRect();
    return "inputarea at y=" + r.y.toFixed(0) + " x=" + r.x.toFixed(0);
  })()`,
  returnByValue: true
});
console.log("editor:", r3.result.value);

// Step 5: Find the current script tab name
const r4 = await Runtime.evaluate({
  expression: `(function() {
    // Look for script name in Pine Editor header/tabs
    var all = Array.from(document.querySelectorAll("*"))
      .filter(function(el) {
        var r = el.getBoundingClientRect();
        return el.offsetParent !== null && r.left > 1090 && r.top < 100 && r.top > 20 && el.children.length === 0;
      })
      .map(function(el) { return el.textContent.trim().slice(0,30); })
      .filter(function(t) { return t.length > 0; });
    var seen = {};
    return all.filter(function(t) { if(seen[t]) return false; seen[t]=1; return true; }).join(", ");
  })()`,
  returnByValue: true
});
console.log("script name area:", r4.result.value);

await client.close();
