import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
import { readFileSync } from "fs";

const code = readFileSync("/tmp/amd_ote_runner.pine", "utf8");

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime, Input } = client;
await Runtime.enable();

// Close the editor by clicking the X
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

await new Promise(r => setTimeout(r, 500));

// Click Pine button to reopen
const r1 = await Runtime.evaluate({
  expression: `(function() {
    var btn = Array.from(document.querySelectorAll("button")).find(function(b) { return b.getAttribute("aria-label") === "Pine"; });
    if (btn) { btn.click(); return "clicked pine"; }
    return "no pine btn";
  })()`,
  returnByValue: true
});
console.log("pine open:", r1.result.value);

await new Promise(r => setTimeout(r, 2000));

// Check editor state
const r2 = await Runtime.evaluate({
  expression: `(function() {
    var w = document.querySelector(".tv-script-widget");
    return w ? "widget h=" + w.getBoundingClientRect().height.toFixed(0) + " text=" + w.textContent.slice(0,80).replace(/\n/g," ") : "no widget";
  })()`,
  returnByValue: true
});
console.log("editor:", r2.result.value);

// Find "New" button or "pine_new" equivalent in the editor toolbar
const r3 = await Runtime.evaluate({
  expression: `(function() {
    var btns = Array.from(document.querySelectorAll("button"))
      .filter(function(b) { return b.offsetParent !== null; })
      .map(function(b) { return b.textContent.trim().slice(0,20) + "|" + b.title + "|" + (b.getAttribute("aria-label")||""); })
      .filter(function(t) { return t.toLowerCase().indexOf("new") !== -1 || t.toLowerCase().indexOf("open") !== -1 || t.toLowerCase().indexOf("create") !== -1; });
    return btns.slice(0,10).join(" | ");
  })()`,
  returnByValue: true
});
console.log("new/open buttons:", r3.result.value);

await client.close();
