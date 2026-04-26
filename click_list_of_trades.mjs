import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime, Input } = client;
await Runtime.enable();

// Click "List of trades" tab
const r1 = await Runtime.evaluate({
  expression: `(function() {
    var all = Array.from(document.querySelectorAll("button, [role='tab'], *"))
      .filter(function(el) { return el.offsetParent !== null && el.textContent.trim() === "List of trades" && el.children.length === 0; });
    if (all.length > 0) {
      var r = all[0].getBoundingClientRect();
      return "found at x=" + r.x.toFixed(0) + " y=" + r.y.toFixed(0);
    }
    return "not found";
  })()`,
  returnByValue: true
});
console.log("list of trades tab:", r1.result.value);

if (r1.result.value && r1.result.value.includes("found at")) {
  const match = r1.result.value.match(/x=(\d+).*y=(\d+)/);
  if (match) {
    const x = parseInt(match[1]) + 5;
    const y = parseInt(match[2]) + 5;
    await Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await new Promise(r => setTimeout(r, 100));
    await Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    console.log("clicked at", x, y);
  }
}

await new Promise(r => setTimeout(r, 1500));

// Read the content of the trades list
const r2 = await Runtime.evaluate({
  expression: `(function() {
    // Get all text in the strategy tester bottom panel
    var all = Array.from(document.querySelectorAll("*"))
      .filter(function(el) {
        var r = el.getBoundingClientRect();
        return el.offsetParent !== null && r.top > 450 && r.top < 770 && r.width > 100;
      })
      .map(function(el) { return el.textContent.replace(/\\s+/g," ").trim().slice(0,100); })
      .filter(function(t) { return t.length > 5; });

    var seen = {};
    return all.filter(function(t) { if(seen[t]) return false; seen[t]=1; return true; }).slice(0,10).join(" | ");
  })()`,
  returnByValue: true
});
console.log("list content:", r2.result.value);

// Also check strategy properties for the active study
const r3 = await Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById("VBb1Zy");
      var s = study._study;
      // Check if it's actually being treated as a strategy
      var isStrategy = s._reportData !== undefined; // Strategies have _reportData (even if null)
      var sourceType = s._type; // May indicate study type
      var inputs = s._inputs;
      return JSON.stringify({
        _type: s._type,
        hasReportChanged: !!s._reportChanged,
        reportChangedType: typeof s._reportChanged,
        reportData: s._reportData === null ? "null" : (s._reportData === undefined ? "undefined" : "object:" + typeof s._reportData)
      });
    } catch(e) { return "ERR: " + e.message; }
  })()`,
  returnByValue: true
});
console.log("study type:", r3.result.value);

await client.close();
