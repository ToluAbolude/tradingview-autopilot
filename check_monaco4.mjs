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
      var fiber = el[fiberKey];
      return "got fiber depth0: " + JSON.stringify(Object.keys(fiber || {}).slice(0,10));
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("FULL RESULT:", JSON.stringify(res));
await client.close();
