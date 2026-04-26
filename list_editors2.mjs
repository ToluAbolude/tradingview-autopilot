import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Step 1: get editor count
const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var el = document.querySelector(".pine-editor-monaco .inputarea");
      if (!el) return "no inputarea";
      for (var i = 0; i < 3; i++) el = el && el.parentElement;
      var fk = Object.keys(el).find(function(k) { return k.startsWith("__reactFiber"); });
      var cur = el[fk];
      for (var d = 0; d < 50 && cur; d++) {
        var p = cur.memoizedProps;
        if (p && p.value && p.value.monacoEnv) {
          var eds = p.value.monacoEnv.editor.getEditors();
          window.__eds = eds;
          return "found monacoEnv at depth=" + d + " eds=" + eds.length;
        }
        cur = cur.return;
      }
      return "no monacoEnv in 50 levels";
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("step1:", JSON.stringify(r1.result));

// Step 2: list editors by index
for (let i = 0; i < 5; i++) {
  const r = await Runtime.evaluate({
    expression: `(function() {
      if (!window.__eds || ${i} >= window.__eds.length) return "no ed[${i}]";
      var e = window.__eds[${i}];
      var m = e.getModel();
      if (!m) return "ed[${i}] no model";
      return "ed[${i}] uri=" + m.uri.toString().slice(-40) + " first=" + m.getValue().slice(0,60).replace(/[\\n]/g,"|");
    })()`,
    returnByValue: true
  });
  if (r.result.value && !r.result.value.startsWith("no ed[")) {
    console.log(r.result.value);
  } else {
    break;
  }
}

await client.close();
