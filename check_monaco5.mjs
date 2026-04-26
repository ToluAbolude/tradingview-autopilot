import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
const client = await CDP({ port: 9222 });
const { Runtime } = client;
await Runtime.enable();

// Step by step - first just try to reach monacoEnv
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var el = document.querySelector(".pine-editor-monaco .inputarea");
      for (var i = 0; i < 3; i++) el = el && el.parentElement;
      var fiberKey = Object.keys(el).find(function(k) { return k.startsWith("__reactFiber"); });
      var fiber = el[fiberKey];
      // Check first level memoizedProps
      var p = fiber && fiber.memoizedProps;
      return "p keys=" + (p ? JSON.stringify(Object.keys(p||{}).slice(0,8)) : "null");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("memoizedProps:", r1.result.value);

// Check child fiber
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var el = document.querySelector(".pine-editor-monaco .inputarea");
      for (var i = 0; i < 3; i++) el = el && el.parentElement;
      var fiberKey = Object.keys(el).find(function(k) { return k.startsWith("__reactFiber"); });
      var fiber = el[fiberKey];
      // Try return (parent) fibers for monacoEnv
      var cur = fiber;
      var found = null;
      for (var d = 0; d < 30 && cur; d++) {
        var p = cur.memoizedProps;
        if (p && p.value && p.value.monacoEnv) { found = "return["+d+"] via memoizedProps.value.monacoEnv"; break; }
        if (p && p.monacoEnv) { found = "return["+d+"] via memoizedProps.monacoEnv"; break; }
        cur = cur.return;
      }
      return found || "not found in 30 return levels";
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("walk return:", r2.result.value);

await client.close();
