import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Runtime } = client;
await Runtime.enable();

// Check Pine editor tabs
const r1 = await Runtime.evaluate({
  expression: `(function() {
    // Find tab elements in Pine editor
    var tabs = Array.from(document.querySelectorAll("[class*='tab']"))
      .filter(function(t) { return t.offsetParent !== null && t.textContent.trim().length > 0 && t.textContent.trim().length < 50; })
      .map(function(t) { return t.textContent.trim().replace(/\\s+/g," ") + " | active=" + (t.classList.toString().indexOf("active") !== -1 || t.getAttribute("aria-selected") === "true"); });
    // Deduplicate
    var seen = {};
    return tabs.filter(function(t) { if (seen[t]) return false; seen[t]=1; return true; }).slice(0,15).join("\\n");
  })()`,
  returnByValue: true
});
console.log("tabs:", r1.result.value);

// Check what the Pine editor header shows (script name)
const r2 = await Runtime.evaluate({
  expression: `(function() {
    // Look for the script name in editor header
    var headers = Array.from(document.querySelectorAll("[class*='header'], [class*='title'], [class*='scriptName']"))
      .filter(function(el) { return el.offsetParent !== null; })
      .map(function(el) { return el.textContent.trim().replace(/\\s+/g," ").slice(0,60); })
      .filter(function(t) { return t.length > 3 && t.length < 60; });
    var seen = {};
    return headers.filter(function(t) { if (seen[t]) return false; seen[t]=1; return true; }).slice(0,10).join(" | ");
  })()`,
  returnByValue: true
});
console.log("headers:", r2.result.value);

// Check console lines with timestamps - look for anything after 12:19
const r3 = await Runtime.evaluate({
  expression: `(function() {
    var consoleLines = Array.from(document.querySelectorAll("[class*='log'], [class*='console'], [class*='output']"))
      .filter(function(el) { return el.offsetParent !== null; })
      .map(function(el) { return el.textContent.replace(/\\s+/g," ").slice(0,100); })
      .filter(function(t) { return t.includes(":") && t.length > 5; });
    var seen = {};
    return consoleLines.filter(function(t) { if (seen[t]) return false; seen[t]=1; return true; }).slice(0,10).join(" || ");
  })()`,
  returnByValue: true
});
console.log("console lines:", r3.result.value);

await client.close();
