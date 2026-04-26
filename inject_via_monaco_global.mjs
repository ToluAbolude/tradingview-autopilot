import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
import { readFileSync } from "fs";

const code = readFileSync("/tmp/amd_ote_runner.pine", "utf8");

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime, Input } = client;
await Runtime.enable();

// Step 1: Check global monaco
const r1 = await Runtime.evaluate({
  expression: `(function() {
    // Check for global monaco
    if (window.monaco) {
      var eds = window.monaco.editor.getEditors();
      var mods = window.monaco.editor.getModels();
      return "global monaco found: eds=" + eds.length + " mods=" + mods.length;
    }
    return "no window.monaco";
  })()`,
  returnByValue: true
});
console.log("global monaco:", r1.result.value);

// Step 2: Try monacoEnv global
const r2 = await Runtime.evaluate({
  expression: `(function() {
    if (window.monacoEnv) {
      var eds = window.monacoEnv.editor.getEditors();
      return "monacoEnv: eds=" + eds.length;
    }
    // Check _monacoEnv or similar
    var keys = Object.keys(window).filter(function(k) {
      return k.toLowerCase().includes("monaco") || k.toLowerCase().includes("editor");
    });
    return "no monacoEnv. Related keys: " + keys.slice(0,10).join(", ");
  })()`,
  returnByValue: true
});
console.log("monacoEnv global:", r2.result.value);

// Step 3: Try finding via DOM walking with higher depth
await Runtime.evaluate({ expression: `window.__newCode = ${JSON.stringify(code)}`, returnByValue: true });

const r3 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var el = document.querySelector(".pine-editor-monaco .inputarea");
      if (!el) return "no inputarea";
      // Walk up DOM
      var cur = el;
      for (var u = 0; u < 20; u++) {
        cur = cur.parentElement;
        if (!cur) break;
        var keys = Object.keys(cur);
        var fk = keys.find(function(k) { return k.startsWith("__reactFiber"); });
        if (fk) {
          var fiber = cur[fk];
          // Walk fiber upwards
          for (var d = 0; d < 100 && fiber; d++) {
            var p = fiber.memoizedProps;
            if (p && p.value && p.value.monacoEnv) {
              var eds = p.value.monacoEnv.editor.getEditors();
              if (eds.length > 0) {
                var m = eds[0].getModel();
                if (m) {
                  m.setValue(window.__newCode);
                  eds[0].focus();
                  return "injected via DOM level " + u + " fiber depth " + d + " len=" + window.__newCode.length;
                }
              }
            }
            fiber = fiber.return;
          }
          return "found reactFiber at DOM level " + u + " but no monacoEnv in 100 fiber levels";
        }
      }
      return "no reactFiber found in 20 DOM levels";
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("inject:", r3.result.value);

// Step 4: Also try via child fiber
const r4 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var el = document.querySelector(".pine-editor-monaco .inputarea");
      if (!el) return "no inputarea";
      var keys = Object.keys(el);
      var fk = keys.find(function(k) { return k.startsWith("__reactFiber"); });
      if (!fk) return "no fiber on inputarea";
      var fiber = el[fk];
      // Walk DOWN via child
      for (var d = 0; d < 30 && fiber; d++) {
        var p = fiber.memoizedProps;
        if (p && p.monacoEnv) {
          var eds = p.monacoEnv.editor.getEditors();
          return "found direct monacoEnv at child depth " + d + " eds=" + eds.length;
        }
        if (p && p.value && p.value.monacoEnv) {
          var eds = p.value.monacoEnv.editor.getEditors();
          return "found .value.monacoEnv at child depth " + d + " eds=" + eds.length;
        }
        fiber = fiber.child || fiber.sibling;
      }
      return "no monacoEnv in child direction";
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("child fiber:", r4.result.value);

await client.close();
