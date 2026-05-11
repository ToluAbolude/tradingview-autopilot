/**
 * sync_cookies.mjs
 * 1. Connects to local Chrome (port 9223) - extracts all tradingview.com cookies in plain text via CDP
 * 2. Connects to VM's TradingView Electron (port 9222 via SSH tunnel) - injects those cookies
 * 3. Clicks Connect on BlackBull Markets broker panel
 */

import CDP from 'chrome-remote-interface';
import { writeFileSync, readFileSync } from 'fs';
import { createConnection } from 'net';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Step 1: Extract cookies from local Chrome ──────────────────────────────
console.log('\n── Step 1: Extracting cookies from local Chrome (port 9223) ──');

const localTargets = await (await fetch('http://localhost:9223/json/list')).json();
const tvTarget = localTargets.find(t => t.type === 'page' && /tradingview\.com/.test(t.url));
if (!tvTarget) { console.log('No TradingView tab found in local Chrome'); process.exit(1); }
console.log('Found tab:', tvTarget.url.substring(0, 80));

const local = await CDP({ host: 'localhost', port: 9223, target: tvTarget.id });
await local.Network.enable();
await local.Runtime.enable();

// Get ALL cookies via CDP (these are plain text — CDP handles decryption on Windows)
const { cookies } = await local.Network.getAllCookies();
const tvCookies = cookies.filter(c =>
  c.domain.includes('tradingview') || c.domain.includes('blackbull')
);
console.log(`Got ${cookies.length} total cookies, ${tvCookies.length} tradingview/blackbull cookies`);

// Also check TradingView login state + broker
const state = await local.Runtime.evaluate({
  expression: `(function(){
    var title = document.title;
    var tradeBtn = !!document.querySelector('[data-name="trading-toolbar-button"], button[aria-label="Trade"]');
    var acctMgr = !!Array.from(document.querySelectorAll('*')).find(e=>e.textContent.trim()==='Account Manager'&&e.offsetParent);
    return JSON.stringify({title: title.substring(0,60), tradeBtn, acctMgr});
  })()`,
  returnByValue: true
});
console.log('Page state:', state.result.value);

const cookiePath = (process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp') + '\\tv_cookies.json';
writeFileSync(cookiePath, JSON.stringify(tvCookies, null, 2));
console.log('Cookies saved to', cookiePath);

await local.close();

// ── Step 2: Inject cookies into VM via SSH tunnel (port 9222) ─────────────
console.log('\n── Step 2: Injecting cookies into VM TradingView (port 9222) ──');

const vmTargets = await (await fetch('http://localhost:9222/json/list')).json();
const vmTarget = vmTargets.find(t => t.type === 'page' && /tradingview/i.test(t.url));
if (!vmTarget) { console.log('No TradingView page found on VM CDP'); process.exit(1); }
console.log('VM target:', vmTarget.url.substring(0, 80));

const vm = await CDP({ host: 'localhost', port: 9222, target: vmTarget.id });
await vm.Network.enable();
await vm.Runtime.enable();

// Set each cookie on the VM
let set = 0, failed = 0;
for (const c of tvCookies) {
  try {
    const params = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
    };
    if (c.expires && c.expires > 0) params.expires = c.expires;
    await vm.Network.setCookie(params);
    set++;
  } catch (e) {
    failed++;
  }
}
console.log(`Set ${set} cookies, ${failed} failed`);

// Reload the TradingView page so it picks up new cookies
console.log('\nReloading TradingView page on VM...');
await vm.Page.reload({ ignoreCache: true });
await sleep(8000);

// ── Step 3: Click Connect on BlackBull ────────────────────────────────────
console.log('\n── Step 3: Checking broker connection ──');

const check = await vm.Runtime.evaluate({
  expression: `(function(){
    var acct = Array.from(document.querySelectorAll('*')).find(e=>e.textContent.trim()==='Account Manager'&&e.offsetParent);
    var connectBtn = Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Connect'&&b.offsetParent);
    return JSON.stringify({accountManager: !!acct, connectBtn: !!connectBtn});
  })()`,
  returnByValue: true
});
console.log('State after reload:', check.result.value);

await vm.close();
console.log('\nDone.');
