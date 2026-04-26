import CDP from "/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js";
import { writeFileSync } from "fs";

const list = await CDP.List({ port: 9222 });
const tvTarget = list.find(t => t.type === "page" && t.url && t.url.includes("tradingview.com"));
const client = await CDP({ port: 9222, target: tvTarget.id });
const { Page } = client;
await Page.enable();

const ss = await Page.captureScreenshot({ format: "png" });
writeFileSync("/tmp/screenshot.png", Buffer.from(ss.data, "base64"));
console.log("screenshot saved to /tmp/screenshot.png");

await client.close();
