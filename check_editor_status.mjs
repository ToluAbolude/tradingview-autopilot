import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Check editor status
const r1 = await Runtime.evaluate({
  expression: `(async function() {
    var api = window.TradingViewApi;
    var aw = api._activeChartWidgetWV.value();
    var s = aw.getStudyById("VBb1Zy");
    var model = await s._study.pineSourceCodeModel();
    var status = model.pineSourceEditorStatus();
    return "status type=" + typeof status + " val=" + (status ? JSON.stringify(Object.keys(status||{}).slice(0,5)) : "null");
  })()`,
  returnByValue: false,
  awaitPromise: true
});
console.log("editor status:", JSON.stringify(r1.result));

// Check if isAbleShowSourceCode
const r2 = await Runtime.evaluate({
  expression: `(async function() {
    var api = window.TradingViewApi;
    var aw = api._activeChartWidgetWV.value();
    var s = aw.getStudyById("VBb1Zy");
    var model = await s._study.pineSourceCodeModel();
    return "isAbleShowSourceCode=" + model.isAbleShowSourceCode();
  })()`,
  returnByValue: false,
  awaitPromise: true
});
console.log("ability:", JSON.stringify(r2.result));

// Check script() function
const r3 = await Runtime.evaluate({
  expression: `(async function() {
    var api = window.TradingViewApi;
    var aw = api._activeChartWidgetWV.value();
    var s = aw.getStudyById("VBb1Zy");
    var model = await s._study.pineSourceCodeModel();
    var script = model.script();
    return "script type=" + typeof script + (script ? " id=" + script.id + " title=" + script.title : " null");
  })()`,
  returnByValue: false,
  awaitPromise: true
});
console.log("script:", JSON.stringify(r3.result));

await client.close();
