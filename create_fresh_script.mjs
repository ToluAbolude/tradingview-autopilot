import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
import { readFileSync } from "fs";

const minCode = `//@version=6
strategy("Fresh Diag", overlay=true, initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=1.0)
if strategy.position_size == 0
    strategy.entry("L", strategy.long)
else
    strategy.close_all()
`;

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime, Input } = client;
await Runtime.enable();

// Check current Pine Editor state
const r0 = await Runtime.evaluate({
  expression: `(function() {
    // Look for tabs in Pine Editor area
    var all = Array.from(document.querySelectorAll("*"))
      .filter(function(el) {
        var r = el.getBoundingClientRect();
        return el.offsetParent !== null && r.left > 1090 && r.top < 150;
      })
      .map(function(el) { return el.tagName + "|" + el.textContent.trim().slice(0,25) + "|class=" + el.className.slice(0,30); })
      .filter(function(t) { return t.split("|")[1].length > 0; });
    var seen = {};
    return all.filter(function(t) { if(seen[t]) return false; seen[t]=1; return true; }).slice(0,15).join("\\n");
  })()`,
  returnByValue: true
});
console.log("pine editor area:", r0.result.value);

// Look specifically for "New" button or "+" in Pine Editor tabs area
const r1 = await Runtime.evaluate({
  expression: `(function() {
    var all = Array.from(document.querySelectorAll("button, [role='button'], [data-name]"))
      .filter(function(el) {
        var r = el.getBoundingClientRect();
        return el.offsetParent !== null && r.left > 1090 && r.top < 100;
      });
    return all.map(function(el) {
      var r = el.getBoundingClientRect();
      return "x=" + r.x.toFixed(0) + " y=" + r.y.toFixed(0) + " text=" + el.textContent.trim().slice(0,20) + " title=" + (el.title||"") + " aria=" + (el.getAttribute("aria-label")||"") + " data-name=" + (el.getAttribute("data-name")||"");
    }).join("\\n");
  })()`,
  returnByValue: true
});
console.log("pine editor buttons:", r1.result.value);

// Try to use pine_new equivalent - find the "New script" option in Pine Editor menu
const r2 = await Runtime.evaluate({
  expression: `(function() {
    // Check the pine editor header for a dropdown or menu button
    // Look for "..." or burger menu
    var menuBtns = Array.from(document.querySelectorAll("button"))
      .filter(function(el) {
        var r = el.getBoundingClientRect();
        return el.offsetParent !== null && r.left > 1090 && r.top < 80;
      });
    return menuBtns.map(function(el) {
      var r = el.getBoundingClientRect();
      return "x=" + r.x.toFixed(0) + " text=" + el.textContent.trim().slice(0,20) + " aria=" + (el.getAttribute("aria-label")||"");
    }).join(", ");
  })()`,
  returnByValue: true
});
console.log("menu buttons:", r2.result.value);

await client.close();
