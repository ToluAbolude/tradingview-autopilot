import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
const client = await CDP({ port: 9222 });
const { Runtime } = client;
await Runtime.enable();

const res = await Runtime.evaluate({
  expression: `(function() {
    try {
      var el = document.querySelector(".pine-editor-monaco .inputarea");
      for (var i = 0; i < 3; i++) el = el && el.parentElement;
      var fiberKey = Object.keys(el).find(function(k) { return k.startsWith("__reactFiber"); });
      var cur = el[fiberKey];
      // Walk up to find monacoEnv
      var monacoEnv = null;
      for (var d = 0; d < 30 && cur; d++) {
        var p = cur.memoizedProps;
        if (p && p.value && p.value.monacoEnv) { monacoEnv = p.value.monacoEnv; break; }
        cur = cur.return;
      }
      if (!monacoEnv) return "monacoEnv not found";

      var editors = monacoEnv.editor.getEditors();
      var out = "editors=" + editors.length;
      for (var i = 0; i < editors.length; i++) {
        var m = editors[i].getModel();
        var uri = m ? (m.uri ? m.uri.toString() : "no-uri") : "no-model";
        var first80 = m ? m.getValue().slice(0, 80).replace(/\n/g, "\\n") : "";
        out += " | [" + i + "] " + uri + " => " + first80;
      }

      var models = monacoEnv.editor.getModels();
      out += "\ntotal-models=" + models.length;
      for (var j = 0; j < Math.min(models.length, 10); j++) {
        var u = models[j].uri ? models[j].uri.toString() : "no-uri";
        var s = models[j].getValue().slice(0, 60).replace(/\n/g, "\\n");
        out += "\n  [" + j + "] " + u + " => " + s;
      }
      return out;
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log(res.result.value);
await client.close();
