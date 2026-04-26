import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";

// List all available CDP targets
const list = await CDP.List({ port: 9222 });
console.log("Total targets:", list.length);
list.forEach(function(t, i) {
  console.log("[" + i + "] type=" + t.type + " url=" + (t.url||"").slice(0,80) + " title=" + (t.title||"").slice(0,40));
});
