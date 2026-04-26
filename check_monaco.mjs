import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
const client = await CDP({ port: 9222 });
const { Runtime } = client;
await Runtime.enable();

const res = await Runtime.evaluate({
  expression: `(function() {
    var el = document.querySelector(".pine-editor-monaco .inputarea");
    if (!el) return "no inputarea found";
    var r = el.getBoundingClientRect();
    return "inputarea at x=" + r.x.toFixed(0) + " y=" + r.y.toFixed(0);
  })()`,
  returnByValue: true
});
console.log("result type:", res.result.type, "value:", res.result.value);
await client.close();
