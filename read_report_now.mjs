import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
const client = await CDP({ port: 9222 });
const { Runtime, Input } = client;
await Runtime.enable();

// Press Escape to close menu
await Input.dispatchKeyEvent({ type: "keyDown", key: "Escape", code: "Escape" });
await Input.dispatchKeyEvent({ type: "keyUp", key: "Escape", code: "Escape" });
await new Promise(r => setTimeout(r, 500));

// Read all strategy report metrics
const r1 = await Runtime.evaluate({
  expression: `(function() {
    // Find the strategy report panel
    var panels = Array.from(document.querySelectorAll("*"))
      .filter(function(el) {
        return el.offsetParent !== null;
      })
      .filter(function(el) {
        var r = el.getBoundingClientRect();
        return r.y > 440 && r.height > 100;
      })
      .sort(function(a,b) { return a.getBoundingClientRect().width - b.getBoundingClientRect().width; });

    // Get the widest panel text in that area
    var best = panels[panels.length - 1];
    if (!best) return "no panel";
    return best.textContent.replace(/\s+/g, " ").slice(0, 400);
  })()`,
  returnByValue: true
});
console.log("report text:", r1.result.value);

await client.close();
