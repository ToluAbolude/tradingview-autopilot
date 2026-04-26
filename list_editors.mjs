import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

const r = await Runtime.evaluate({
  expression: `(function() {
    try {
      var el = document.querySelector(".pine-editor-monaco .inputarea");
      if (!el) return "no inputarea";
      for (var i = 0; i < 3; i++) el = el && el.parentElement;
      var fk = Object.keys(el).find(function(k) { return k.startsWith("__reactFiber"); });
      var cur = el[fk];
      for (var d = 0; d < 30 && cur; d++) {
        var p = cur.memoizedProps;
        if (p && p.value && p.value.monacoEnv) {
          var eds = p.value.monacoEnv.editor.getEditors();
          var mods = p.value.monacoEnv.editor.getModels();
          var info = "editors=" + eds.length + " models=" + mods.length + "\n";
          eds.forEach(function(e, idx) {
            var m = e.getModel();
            var first = m ? m.getValue().slice(0,80).replace(/\n/g,"|") : "";
            info += "ed[" + idx + "] focused=" + e.hasTextFocus() + " uri=" + (m ? m.uri.toString().slice(-30) : "null") + " first=" + first + "\n";
          });
          mods.forEach(function(m, idx) {
            var first = m.getValue().slice(0,80).replace(/\n/g,"|");
            info += "mod[" + idx + "] uri=" + m.uri.toString().slice(-30) + " first=" + first + "\n";
          });
          return info;
        }
        cur = cur.return;
      }
      return "no monacoEnv";
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log(r.result.value);
await client.close();
