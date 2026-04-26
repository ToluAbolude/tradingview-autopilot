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
    window.__mods = window.__me.editor.getModels();
    window.__eds = window.__me.editor.getEditors();
  })()`,
  returnByValue: true
});

// Check model[0] methods
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var m0 = window.__mods[0];
      var proto = Object.getPrototypeOf(m0);
      var methods = Object.getOwnPropertyNames(proto).filter(function(n) { return typeof proto[n] === "function"; });
      return "model0 methods: " + methods.join(", ");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log(r1.result.value);

// Check editor[0] methods
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var e0 = window.__eds[0];
      var keys = Object.getOwnPropertyNames(Object.getPrototypeOf(e0)).slice(0,20);
      return "editor0 methods: " + keys.join(", ");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log(r2.result.value);

await client.close();
