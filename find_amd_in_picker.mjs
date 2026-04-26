import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime, Input } = client;
await Runtime.enable();

// Click "My scripts" tab
const r1 = await Runtime.evaluate({
  expression: `(function() {
    var els = Array.from(document.querySelectorAll("*"))
      .filter(function(el) { return el.offsetParent !== null && el.textContent.trim() === "My scripts"; });
    if (els.length > 0) {
      var r = els[0].getBoundingClientRect();
      return "found at x=" + r.x.toFixed(0) + " y=" + r.y.toFixed(0);
    }
    return "not found";
  })()`,
  returnByValue: true
});
console.log("my scripts:", r1.result.value);

if (r1.result.value && r1.result.value.includes("found at")) {
  const match = r1.result.value.match(/x=(\d+).*y=(\d+)/);
  if (match) {
    const x = parseInt(match[1]) + 5;
    const y = parseInt(match[2]) + 5;
    await Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await new Promise(r => setTimeout(r, 100));
    await Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    console.log("clicked My scripts at", x, y);
  }
}

await new Promise(r => setTimeout(r, 1000));

// Look for AMD OTE Runner in the list
const r2 = await Runtime.evaluate({
  expression: `(function() {
    var all = Array.from(document.querySelectorAll("*"))
      .filter(function(el) { return el.offsetParent !== null; });

    var amdEl = all.find(function(el) {
      return el.textContent.includes("AMD OTE") && el.textContent.length < 80;
    });

    if (amdEl) {
      var r = amdEl.getBoundingClientRect();
      return "AMD OTE found at x=" + r.x.toFixed(0) + " y=" + r.y.toFixed(0) + " text=" + amdEl.textContent.trim().slice(0,50);
    }

    // List what's in the picker
    var items = all.filter(function(el) {
      var r = el.getBoundingClientRect();
      return r.left > 200 && r.top > 100 && r.top < 600 && el.children.length === 0 && el.textContent.trim().length > 3;
    }).map(function(el) { return el.textContent.trim().slice(0,30); });
    var seen = {};
    return "no AMD OTE. Items: " + items.filter(function(t) { if(seen[t]) return false; seen[t]=1; return true; }).slice(0,15).join(", ");
  })()`,
  returnByValue: true
});
console.log("picker items:", r2.result.value);

await client.close();
