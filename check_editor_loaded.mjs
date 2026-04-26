import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Check Pine editor widget state
const r1 = await Runtime.evaluate({
  expression: `(function() {
    var w = document.querySelector(".tv-script-widget");
    if (!w) return "no widget";
    var r = w.getBoundingClientRect();
    return "widget h=" + r.height.toFixed(0) + " text=" + w.textContent.slice(0, 100).replace(/\n/g," ");
  })()`,
  returnByValue: true
});
console.log("widget:", r1.result.value);

// Check Monaco model content
const r2 = await Runtime.evaluate({
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
          var mods = p.value.monacoEnv.editor.getModels();
          if (mods.length > 0) {
            var uri = mods[0].uri ? mods[0].uri.toString() : "no-uri";
            var first80 = mods[0].getValue().slice(0, 80).replace(/[^\x20-\x7E]/g, "?").replace(/\n/g, "\\n");
            return "models=" + mods.length + " uri=" + uri.slice(-20) + " first=" + first80;
          }
          return "no models";
        }
        cur = cur.return;
      }
      return "no monacoEnv";
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("monaco:", r2.result.value);

// Check if spinner is present
const r3 = await Runtime.evaluate({
  expression: `(function() {
    var spinners = Array.from(document.querySelectorAll("[class*=spin], [class*=load], [class*=progress]"))
      .filter(function(el) {
        var r = el.getBoundingClientRect();
        return r.x > 1090 && el.offsetParent !== null;
      });
    return spinners.length + " spinners in editor area";
  })()`,
  returnByValue: true
});
console.log("spinners:", r3.result.value);

await client.close();
