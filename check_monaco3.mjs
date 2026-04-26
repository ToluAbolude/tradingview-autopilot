import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
const client = await CDP({ port: 9222 });
const { Runtime } = client;
await Runtime.enable();

// Find monacoEnv and list models
const res = await Runtime.evaluate({
  expression: `(function() {
    try {
      var el = document.querySelector(".pine-editor-monaco .inputarea");
      for (var i = 0; i < 3; i++) el = el && el.parentElement;
      var fiberKey = Object.keys(el).find(function(k) { return k.startsWith("__reactFiber"); });

      function findMonaco(fiber, depth) {
        if (!fiber || depth > 50) return null;
        try {
          var p = fiber.memoizedProps;
          if (p && p.value && p.value.monacoEnv) return p.value.monacoEnv;
          if (p && p.monacoEnv) return p.monacoEnv;
          if (fiber.stateNode && fiber.stateNode.monacoEnv) return fiber.stateNode.monacoEnv;
        } catch(e2) {}
        var fromChild = findMonaco(fiber.child, depth+1);
        if (fromChild) return fromChild;
        var fromSib = findMonaco(fiber.sibling, depth+1);
        if (fromSib) return fromSib;
        if (depth < 10) return findMonaco(fiber.return, depth+1);
        return null;
      }

      var monacoEnv = findMonaco(el[fiberKey], 0);
      if (!monacoEnv) return "no monacoEnv found";

      var editors = monacoEnv.editor.getEditors ? monacoEnv.editor.getEditors() : [];
      var out = "editors=" + editors.length;
      for (var i = 0; i < editors.length; i++) {
        var m = editors[i].getModel();
        if (m) {
          var uri = m.uri ? m.uri.toString() : "no-uri";
          var first50 = m.getValue().slice(0, 50).replace(/\n/g, " ");
          out += "\neditor[" + i + "] uri=" + uri + " start='" + first50 + "'";
        }
      }

      // Also check getModels
      var models = monacoEnv.editor.getModels ? monacoEnv.editor.getModels() : [];
      out += "\ntotal models=" + models.length;
      for (var j = 0; j < Math.min(models.length, 5); j++) {
        var uri2 = models[j].uri ? models[j].uri.toString() : "no-uri";
        var first30 = models[j].getValue().slice(0, 30).replace(/\n/g, " ");
        out += "\nmodel[" + j + "] uri=" + uri2 + " start='" + first30 + "'";
      }
      return out;
    } catch(e) { return "ERR: " + e.message + " stack=" + e.stack.slice(0,200); }
  })()`,
  returnByValue: true
});
console.log(res.result.type, "|", res.result.value);
await client.close();
