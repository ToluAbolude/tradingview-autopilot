import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime, Input } = client;
await Runtime.enable();

// Click the Pine editor button (aria-label="Pine")
const r1 = await Runtime.evaluate({
  expression: `(function() {
    var btn = Array.from(document.querySelectorAll("button")).find(function(b) { return b.getAttribute("aria-label") === "Pine"; });
    if (!btn) return "no pine button";
    var r = btn.getBoundingClientRect();
    btn.click();
    return "clicked pine btn at x=" + r.x.toFixed(0) + " y=" + r.y.toFixed(0);
  })()`,
  returnByValue: true
});
console.log("pine btn:", r1.result.value);

await new Promise(r => setTimeout(r, 2500));

// Now call showPineSourceCode again
const r2 = await Runtime.evaluate({
  expression: `(async function() {
    var api = window.TradingViewApi;
    var aw = api._activeChartWidgetWV.value();
    var s = aw.getStudyById("VBb1Zy");
    if (!s) return "study not found";
    var model = await s._study.pineSourceCodeModel();
    model.showPineSourceCode();
    return "called showPineSourceCode for " + model.title().slice(0, 30);
  })()`,
  returnByValue: false,
  awaitPromise: true
});
console.log("show source:", JSON.stringify(r2.result).slice(0, 150));

await new Promise(r => setTimeout(r, 3000));

// Check if editor has AMD_OTE code
const r3 = await Runtime.evaluate({
  expression: `(function() {
    var widget = document.querySelector(".tv-script-widget");
    if (!widget) return "no widget";
    var r = widget.getBoundingClientRect();
    return "widget at y=" + r.y.toFixed(0) + " h=" + r.height.toFixed(0) + " text=" + widget.textContent.slice(0, 80).replace(/\n/g," ");
  })()`,
  returnByValue: true
});
console.log("widget:", r3.result.value);

await client.close();
