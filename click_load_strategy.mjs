import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime, Input } = client;
await Runtime.enable();

// Find "Load your strategy" button
const r1 = await Runtime.evaluate({
  expression: `(function() {
    var allVisible = Array.from(document.querySelectorAll("button, [role='button']"))
      .filter(function(el) { return el.offsetParent !== null; });
    var btn = allVisible.find(function(el) { return el.textContent.trim() === "Load your strategy"; });
    if (btn) {
      var r = btn.getBoundingClientRect();
      return "found at x=" + r.x.toFixed(0) + " y=" + r.y.toFixed(0);
    }
    return "not found";
  })()`,
  returnByValue: true
});
console.log("load strategy btn:", r1.result.value);

if (r1.result.value && r1.result.value.includes("found at")) {
  const match = r1.result.value.match(/x=(\d+).*y=(\d+)/);
  if (match) {
    const x = parseInt(match[1]) + 10;
    const y = parseInt(match[2]) + 10;
    await Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await new Promise(r => setTimeout(r, 100));
    await Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    console.log("clicked at", x, y);
  }
}

await new Promise(r => setTimeout(r, 2000));

// Check what appeared
const r2 = await Runtime.evaluate({
  expression: `(function() {
    var all = Array.from(document.querySelectorAll("*"))
      .filter(function(el) { return el.offsetParent !== null; });

    // Check for modal dialog or Pine editor change
    var modal = all.find(function(el) {
      return el.textContent.includes("Open") && el.textContent.includes("strategy") && el.textContent.length < 200;
    });

    // Check if Pine Editor has "Update on chart" button visible
    var updateBtn = Array.from(document.querySelectorAll("button"))
      .find(function(b) { return b.title === "Update on chart" && b.offsetParent !== null; });

    return JSON.stringify({
      modal: modal ? modal.textContent.slice(0,100) : null,
      updateBtn: updateBtn ? "found" : "not found",
      editorVisible: !!document.querySelector(".pine-editor-monaco .inputarea")
    });
  })()`,
  returnByValue: true
});
console.log("after click:", r2.result.value);

await client.close();
