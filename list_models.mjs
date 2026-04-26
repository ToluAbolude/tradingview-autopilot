import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
const client = await CDP({ port: 9222 });
const { Runtime } = client;
await Runtime.enable();

// Get all Monaco models and find AMD_OTE
const res = await Runtime.evaluate({
  expression: `(function() {
    try {
      var el = document.querySelector(".pine-editor-monaco .inputarea");
      for (var i = 0; i < 3; i++) el = el && el.parentElement;
      var fiberKey = el ? Object.keys(el).find(function(k) { return k.startsWith("__reactFiber"); }) : null;
      if (!fiberKey) return "no fiber";

      function findMonaco(fiber, depth) {
        if (!fiber || depth > 50) return null;
        try {
          var p = fiber.memoizedProps;
          if (p && p.value && p.value.monacoEnv) return p.value.monacoEnv;
          if (p && p.monacoEnv) return p.monacoEnv;
          if (fiber.stateNode && fiber.stateNode.monacoEnv) return fiber.stateNode.monacoEnv;
        } catch(e) {}
        return findMonaco(fiber.child, depth+1) || findMonaco(fiber.sibling, depth+1) || (depth < 10 ? findMonaco(fiber.return, depth+1) : null);
      }

      var monacoEnv = findMonaco(el[fiberKey], 0);
      if (!monacoEnv) return "no monacoEnv";

      var models = monacoEnv.editor.getModels ? monacoEnv.editor.getModels() : [];
      var result = models.map(function(m) {
        var uri = m.uri ? m.uri.toString() : "no-uri";
        var preview = m.getValue ? m.getValue().slice(0, 100) : "no-value";
        return uri + " | " + preview;
      });
      return "models=" + models.length + "\n" + result.join("\n");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log(res.result.value);
await client.close();
