import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
const client = await CDP({ port: 9222 });
const { Runtime, Input } = client;
await Runtime.enable();

// Move mouse to AMD_OTE span position
await Input.dispatchMouseEvent({ type: "mouseMoved", x: 75, y: 503, buttons: 0 });
await new Promise(r => setTimeout(r, 800));

// Look for buttons that appeared near AMD_OTE
const r1 = await Runtime.evaluate({
  expression: `(function() {
    var btns = Array.from(document.querySelectorAll("button, [role=button], [class*=action], [class*=icon]"))
      .filter(function(b) { return b.offsetParent !== null; })
      .filter(function(b) {
        var r = b.getBoundingClientRect();
        return r.y > 480 && r.y < 540;
      })
      .map(function(b) {
        var r = b.getBoundingClientRect();
        return b.tagName + " x=" + r.x.toFixed(0) + " y=" + r.y.toFixed(0) + " title=" + (b.title||"") + " aria=" + (b.getAttribute("aria-label")||"") + " txt=" + b.textContent.trim().slice(0,20);
      });
    return btns.join(" | ") || "none";
  })()`,
  returnByValue: true
});
console.log("buttons near AMD_OTE:", r1.result.value);

// Also look at the parent element of AMD_OTE span
const r2 = await Runtime.evaluate({
  expression: `(function() {
    var span = Array.from(document.querySelectorAll("span"))
      .find(function(s) { return s.textContent.trim() === "AMD_OTE" && s.offsetParent !== null; });
    if (!span) return "span not found";
    // Walk up to find the strategy row
    var row = span;
    for (var i = 0; i < 8; i++) row = row.parentElement || row;
    var items = Array.from(row.querySelectorAll("button, [role=button], [class*=action]"))
      .filter(function(b) { return b.offsetParent !== null; })
      .map(function(b) { return b.tagName + " title=" + (b.title||"") + " aria=" + (b.getAttribute("aria-label")||"") + " cls=" + (b.className||"").toString().slice(0,40); });
    return "row=" + row.tagName + " cls=" + (row.className||"").toString().slice(0,40) + " children=" + row.childElementCount + " | btns=" + items.slice(0,5).join("; ");
  })()`,
  returnByValue: true
});
console.log("AMD_OTE row:", r2.result.value);

await client.close();
