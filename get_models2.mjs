import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
const client = await CDP({ port: 9222 });
const { Runtime } = client;
await Runtime.enable();

// Get monacoEnv into a global, then query it in steps
await Runtime.evaluate({
  expression: `(function() {
    var el = document.querySelector(".pine-editor-monaco .inputarea");
    for (var i = 0; i < 3; i++) el = el && el.parentElement;
    var fiberKey = Object.keys(el).find(function(k) { return k.startsWith("__reactFiber"); });
    var cur = el[fiberKey];
    for (var d = 0; d < 30 && cur; d++) {
      var p = cur.memoizedProps;
      if (p && p.value && p.value.monacoEnv) { window.__me = p.value.monacoEnv; break; }
      cur = cur.return;
    }
  })()`,
  returnByValue: true
});

const r1 = await Runtime.evaluate({
  expression: `typeof window.__me + " editors=" + (window.__me ? typeof window.__me.editor : "n/a")`,
  returnByValue: true
});
console.log("monacoEnv:", r1.result.value);

const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var eds = window.__me.editor.getEditors();
      return "getEditors ok count=" + eds.length;
    } catch(e) { return "getEditors ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("editors:", r2.result.value);

const r3 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var mods = window.__me.editor.getModels();
      return "getModels ok count=" + mods.length;
    } catch(e) { return "getModels ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("models:", r3.result.value);

const r4 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var eds = window.__me.editor.getEditors();
      if (!eds.length) return "no editors";
      var m = eds[0].getModel();
      if (!m) return "no model";
      var uri = m.uri ? m.uri.toString() : "no-uri";
      var val = m.getValue().slice(0,100).replace(/\n/g,"\\n");
      return "uri=" + uri + " | " + val;
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("active editor:", r4.result.value);

await client.close();
