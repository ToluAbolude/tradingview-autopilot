import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Try to look at pine editor's current script model to get script ID
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var el = document.querySelector(".pine-editor-monaco .inputarea");
      if (!el) return "no inputarea";
      // Walk up DOM to find Pine Editor widget
      var cur = el;
      for (var u = 0; u < 20; u++) {
        cur = cur.parentElement;
        if (!cur) break;
        var keys = Object.keys(cur);
        var fk = keys.find(function(k) { return k.startsWith("__reactFiber"); });
        if (fk) {
          var fiber = cur[fk];
          for (var d = 0; d < 100 && fiber; d++) {
            var p = fiber.memoizedProps;
            if (p && p.value && p.value.monacoEnv) {
              // Found monacoEnv - now look for script info in nearby fibers
              // Walk sibling chain to find script metadata
              var sibling = fiber;
              for (var s = 0; s < 50 && sibling; s++) {
                var sp = sibling.memoizedProps;
                if (sp && sp.scriptId) return "scriptId in props: " + sp.scriptId;
                if (sp && sp.script && sp.script.id) return "script.id: " + sp.script.id;
                sibling = sibling.sibling;
              }
              return "found monacoEnv at DOM level " + u + " fiber depth " + d;
            }
            fiber = fiber.return;
          }
        }
      }
      return "not found";
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("script id via fiber:", r1.result.value);

// Try to get the current Pine Editor script info from the global pineScriptsStorage or similar
const r2 = await Runtime.evaluate({
  expression: `(function() {
    // Look for pine-related global objects
    var pineKeys = Object.keys(window).filter(function(k) {
      return k.toLowerCase().includes("pine") || k.toLowerCase().includes("script") || k.toLowerCase().includes("editor");
    }).slice(0,20);
    return pineKeys.join(", ");
  })()`,
  returnByValue: true
});
console.log("pine globals:", r2.result.value);

// Try to find how the current script's "publish" feature works to get its ID
const r3 = await Runtime.evaluate({
  expression: `(function() {
    try {
      // Try the publish script button to find IDs
      var publishBtn = Array.from(document.querySelectorAll("button"))
        .find(function(b) { return b.offsetParent !== null && (b.title.includes("Publish") || b.textContent.trim() === "Publish script"); });
      if (!publishBtn) return "no publish btn";
      var r = publishBtn.getBoundingClientRect();
      return "publish btn at x=" + r.x.toFixed(0) + " y=" + r.y.toFixed(0);
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("publish btn:", r3.result.value);

// Try insertStudyWithoutCheck
const r4 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var result = chart.insertStudyWithoutCheck.toString().slice(0,300);
      return result;
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("insertStudyWithoutCheck:", r4.result.value);

await client.close();
