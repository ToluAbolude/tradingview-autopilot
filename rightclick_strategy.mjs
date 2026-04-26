import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
const client = await CDP({ port: 9222 });
const { Runtime, Input } = client;
await Runtime.enable();

// Right-click the AMD_OTE button at x=66, y=495
await Input.dispatchMouseEvent({ type: "mousePressed", x: 66, y: 495, button: "right", buttons: 2, clickCount: 1 });
await Input.dispatchMouseEvent({ type: "mouseReleased", x: 66, y: 495, button: "right", buttons: 0, clickCount: 1 });
await new Promise(r => setTimeout(r, 800));

// Check for context menu
const r1 = await Runtime.evaluate({
  expression: `(function() {
    var menus = Array.from(document.querySelectorAll("[class*=menu], [class*=context], [class*=popup], [role=menu]"))
      .filter(function(el) { return el.offsetParent !== null; })
      .map(function(el) {
        var r = el.getBoundingClientRect();
        return el.tagName + " cls=" + (el.className||"").toString().slice(0,60) + " y=" + r.y.toFixed(0) + " txt=" + el.textContent.trim().slice(0,80);
      });
    return menus.join(" | ") || "no menu";
  })()`,
  returnByValue: true
});
console.log("context menus:", r1.result.value);

// Also check for any new overlays/modals
const r2 = await Runtime.evaluate({
  expression: `(function() {
    var items = Array.from(document.querySelectorAll("[class*=item], li"))
      .filter(function(el) { return el.offsetParent !== null; })
      .filter(function(el) {
        var r = el.getBoundingClientRect();
        return r.y > 400 && r.y < 700;
      })
      .map(function(el) {
        var r = el.getBoundingClientRect();
        return el.textContent.trim().slice(0,30) + " y=" + r.y.toFixed(0);
      })
      .filter(function(t) { return t.length > 5; });
    return items.slice(0,15).join(" | ") || "no items";
  })()`,
  returnByValue: true
});
console.log("context items:", r2.result.value);

await client.close();
