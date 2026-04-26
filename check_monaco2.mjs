import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
const client = await CDP({ port: 9222 });
const { Runtime } = client;
await Runtime.enable();

// Step 1: check fiber key
const r1 = await Runtime.evaluate({
  expression: `(function() {
    var el = document.querySelector(".pine-editor-monaco .inputarea");
    for (var i = 0; i < 3; i++) el = el && el.parentElement;
    if (!el) return "no el after 3 levels";
    var keys = Object.keys(el).filter(function(k) { return k.startsWith("__reactFiber"); });
    return "fiberKeys=" + JSON.stringify(keys.slice(0,3));
  })()`,
  returnByValue: true
});
console.log("step1:", r1.result.type, r1.result.value);

// Step 2: find monacoEnv with simple fiber walk
const r2 = await Runtime.evaluate({
  expression: `(function() {
    var el = document.querySelector(".pine-editor-monaco .inputarea");
    for (var i = 0; i < 3; i++) el = el && el.parentElement;
    var fiberKey = Object.keys(el).find(function(k) { return k.startsWith("__reactFiber"); });
    var fiber = el[fiberKey];
    // Just check if fiber exists and has memoizedProps
    return "fiber=" + (fiber ? "yes" : "no") + " type=" + typeof fiber;
  })()`,
  returnByValue: true
});
console.log("step2:", r2.result.type, r2.result.value);

await client.close();
