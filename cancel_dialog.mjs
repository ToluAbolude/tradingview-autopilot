import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime, Input } = client;
await Runtime.enable();

// Find and click Cancel button
const r1 = await Runtime.evaluate({
  expression: `(function() {
    var btns = Array.from(document.querySelectorAll("button"))
      .filter(function(b) { return b.offsetParent !== null && b.textContent.trim() === "Cancel"; });
    if (btns.length > 0) {
      var r = btns[0].getBoundingClientRect();
      return "cancel at x=" + r.x.toFixed(0) + " y=" + r.y.toFixed(0);
    }
    return "no cancel button";
  })()`,
  returnByValue: true
});
console.log("cancel btn:", r1.result.value);

if (r1.result.value && r1.result.value.includes("cancel at")) {
  const match = r1.result.value.match(/x=(\d+).*y=(\d+)/);
  if (match) {
    const x = parseInt(match[1]) + 5;
    const y = parseInt(match[2]) + 5;
    await Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await new Promise(r => setTimeout(r, 50));
    await Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    console.log("clicked cancel at", x, y);
  }
}

await new Promise(r => setTimeout(r, 500));

// Verify dialog closed
const r2 = await Runtime.evaluate({
  expression: `(function() {
    var dlg = Array.from(document.querySelectorAll("*"))
      .find(function(el) { return el.offsetParent !== null && el.textContent.includes("Close position"); });
    return dlg ? "dialog still open: " + dlg.textContent.slice(0,50) : "dialog closed";
  })()`,
  returnByValue: true
});
console.log("dialog:", r2.result.value);

await client.close();
