import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
const client = await CDP({ port: 9222 });
const { Runtime, Input } = client;
await Runtime.enable();

// Click AMD_OTE dropdown button (the ">" chevron next to AMD_OTE text)
// AMD_OTE button is at x=66, y=495; the chevron is slightly to the right
await Input.dispatchMouseEvent({ type: "mousePressed", x: 110, y: 503, button: "left", buttons: 1, clickCount: 1 });
await Input.dispatchMouseEvent({ type: "mouseReleased", x: 110, y: 503, button: "left", buttons: 0, clickCount: 1 });
await new Promise(r => setTimeout(r, 600));

// Look for dropdown options
const r1 = await Runtime.evaluate({
  expression: `(function() {
    var items = Array.from(document.querySelectorAll("[class*=item], [class*=option], [class*=menu], li, [role=menuitem], [role=option]"))
      .filter(function(el) { return el.offsetParent !== null; })
      .filter(function(el) {
        var r = el.getBoundingClientRect();
        return r.y > 450 && r.y < 700;
      })
      .map(function(el) {
        var r = el.getBoundingClientRect();
        return el.textContent.trim().slice(0,40) + " y=" + r.y.toFixed(0) + " cls=" + (el.className||"").toString().slice(0,40);
      })
      .filter(function(t) { return t.length > 3; });
    return items.slice(0,15).join(" | ") || "nothing appeared";
  })()`,
  returnByValue: true
});
console.log("dropdown items:", r1.result.value);

await client.close();
