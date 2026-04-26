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

// Check if _lo_ote is in _long_ok line (if so, old version; if not, diagnostic version)
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var mods = window.__me.editor.getModels();
      var content = mods[0].getValue();
      // Find the _long_ok line
      var lines = content.split("\n");
      var longOkLine = lines.find(function(l) { return l.indexOf("_long_ok") !== -1 && l.indexOf("=") !== -1; });
      return "long_ok line: " + (longOkLine || "NOT FOUND");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log(r1.result.value);

// Also find the _wait_long usage
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var mods = window.__me.editor.getModels();
      var content = mods[0].getValue();
      var lines = content.split("\n");
      var waitLine = lines.find(function(l) { return l.indexOf("_wait_long") !== -1 && l.indexOf("var") !== -1; });
      return "_wait_long decl: " + (waitLine || "NOT FOUND - may use old version");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log(r2.result.value);

await client.close();
