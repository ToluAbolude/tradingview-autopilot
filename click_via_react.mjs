import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
import { readFileSync } from "fs";

const code = readFileSync("/tmp/amd_ote_runner.pine", "utf8");

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// First inject the AMD_OTE code
await Runtime.evaluate({ expression: `window.__newCode = ${JSON.stringify(code)}`, returnByValue: true });

const r1 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var el = document.querySelector(".pine-editor-monaco .inputarea");
      if (!el) return "no inputarea";
      var cur = el;
      for (var u = 0; u < 5; u++) {
        cur = cur.parentElement;
        if (!cur) break;
        var keys = Object.keys(cur);
        var fk = keys.find(function(k) { return k.startsWith("__reactFiber"); });
        if (fk) {
          var fiber = cur[fk];
          for (var d = 0; d < 100 && fiber; d++) {
            var p = fiber.memoizedProps;
            if (p && p.value && p.value.monacoEnv) {
              var eds = p.value.monacoEnv.editor.getEditors();
              if (eds.length > 0) {
                var m = eds[0].getModel();
                if (m) {
                  m.setValue(window.__newCode);
                  eds[0].focus();
                  return "injected len=" + window.__newCode.length;
                }
              }
              return "no editors";
            }
            fiber = fiber.return;
          }
          return "found fiber but no monacoEnv after 100 levels";
        }
      }
      return "no fiber";
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("inject:", r1.result.value);

await new Promise(r => setTimeout(r, 500));

// Now call the button's onClick via React
const r2 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var btns = Array.from(document.querySelectorAll("button"))
        .filter(function(b) { return b.offsetParent !== null; });
      var btn = btns.find(function(b) { return b.title === "Update on chart"; });
      if (!btn) return "no Update on chart btn";

      // Get all React-related keys on the button
      var reactKeys = Object.keys(btn).filter(function(k) { return k.startsWith("__react"); });

      for (var i = 0; i < reactKeys.length; i++) {
        var key = reactKeys[i];
        var fiber = btn[key];
        if (!fiber) continue;

        // Check if this is an event handler key
        if (key.includes("EventHandlers") || key.includes("Props")) {
          var p = fiber;
          if (p && p.onClick) {
            p.onClick({ preventDefault: function(){}, stopPropagation: function(){}, target: btn, currentTarget: btn, nativeEvent: {} });
            return "called onClick via " + key;
          }
        }

        // Check memoizedProps
        if (fiber.memoizedProps && fiber.memoizedProps.onClick) {
          fiber.memoizedProps.onClick({ preventDefault: function(){}, stopPropagation: function(){}, target: btn, currentTarget: btn, nativeEvent: {} });
          return "called memoizedProps.onClick";
        }
      }

      return "could not find onClick. React keys: " + reactKeys.join(", ");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("react click:", r2.result.value);

await new Promise(r => setTimeout(r, 8000));

// Check console for compile result
const r3 = await Runtime.evaluate({
  expression: `(function() {
    var c = document.querySelector("[class*='console']");
    return c ? c.textContent.slice(-300) : "no console";
  })()`,
  returnByValue: true
});
console.log("console:", r3.result.value);

// Check all studies
const r4 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var studies = chart.getAllStudies();
      return studies.map(function(s) { return s.id + "=" + s.name; }).join(", ");
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("studies:", r4.result.value);

await client.close();
