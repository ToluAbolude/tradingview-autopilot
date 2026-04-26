import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
const client = await CDP({ port: 9222 });
const { Runtime } = client;
await Runtime.enable();

await Runtime.evaluate({
  expression: `(function() {
    var el = document.querySelector(".pine-editor-monaco .inputarea");
    for (var i = 0; i < 3; i++) el = el && el.parentElement;
    var fk = Object.keys(el).find(function(k) { return k.startsWith("__reactFiber"); });
    var cur = el[fk];
    for (var d = 0; d < 30 && cur; d++) {
      var p = cur.memoizedProps;
      if (p && p.value && p.value.monacoEnv) { window.__me = p.value.monacoEnv; break; }
      cur = cur.return;
    }
  })()`,
  returnByValue: true
});

// Check models one by one
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var mods = window.__me.editor.getModels();
      var out = "count=" + mods.length;
      for (var i = 0; i < mods.length; i++) {
        try {
          var u = mods[i].uri ? mods[i].uri.toString() : "no-uri";
          var first40 = mods[i].getValue().slice(0, 40);
          // strip any chars that might cause issues
          first40 = first40.replace(/[^\x20-\x7E]/g, "?");
          out += " | model[" + i + "] uri=" + u + " first='" + first40 + "'";
        } catch(e2) { out += " | model[" + i + "] ERR=" + e2.message; }
      }
      return out;
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("models:", r1.result.value);

// Check editor and its model type
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var eds = window.__me.editor.getEditors();
      var ed = eds[0];
      var m = ed.getModel ? ed.getModel() : "no getModel fn";
      return "model type=" + typeof m + " null=" + (m === null) + " keys=" + (m ? JSON.stringify(Object.keys(m||{}).slice(0,5)) : "N/A");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("editor model:", r2.result.value);

await client.close();
