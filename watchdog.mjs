/**
 * watchdog.mjs
 * Runs every 5 minutes via cron.
 * Checks TradingView + BlackBull are alive. Heals if not.
 */
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import http from 'http';

const ALERT_SENT_FILE = '/home/ubuntu/trading-data/.session_alert_sent';

function sendAlert(subject, body) {
  try {
    execSync(
      `/home/ubuntu/tradingview-mcp-jackson/send_alert.sh "${subject}" "${body}"`,
      { timeout: 15000 }
    );
    log('EMAIL ALERT SENT: ' + subject);
  } catch (e) {
    log('EMAIL FAILED: ' + e.message);
  }
}

const LOG = '/home/ubuntu/trading-data/watchdog.log';
mkdirSync('/home/ubuntu/trading-data/trade_log', { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  console.log(line);
  appendFileSync(LOG, line + '\n');
}

function cdpGet(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: 9222, path }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    }).on('error', reject);
  });
}

async function restartChrome() {
  log('HEALING: Restarting tradingview service...');
  try {
    execSync('sudo systemctl restart tradingview', { timeout: 30000 });
    await sleep(12000);
    log('Chrome restarted OK');
  } catch (e) {
    log('ERROR restarting: ' + e.message);
  }
}

// Run a CDP command using the cdp-tool node_modules
async function runCdpScript(script) {
  try {
    return execSync(
      'node --input-type=module',
      { input: script, timeout: 20000, env: { ...process.env, HOME: '/home/ubuntu' } }
    ).toString().trim();
  } catch (e) {
    return e.stdout ? e.stdout.toString().trim() : 'error';
  }
}

async function main() {
  log('--- Watchdog tick ---');

  // 1. Check CDP is reachable
  let tabs;
  try {
    tabs = await cdpGet('/json');
    if (!tabs || !Array.isArray(tabs)) throw new Error('invalid response');
  } catch (e) {
    log('CDP unreachable: ' + e.message + ' — restarting Chrome');
    await restartChrome();
    return;
  }

  // 2. Check TradingView tab exists
  const tvTab = tabs.find(t => t.type === 'page' && t.url && t.url.includes('tradingview.com'));
  if (!tvTab) {
    log('No TradingView tab — restarting Chrome');
    await restartChrome();
    return;
  }
  log('TV tab OK: ' + tvTab.url.slice(0, 60));

  // 3. Check for disconnected session + BlackBull status, auto-heal
  const CDP_MODULE = '/home/ubuntu/cdp-tool/node_modules/chrome-remote-interface/index.js';
  const result = await runCdpScript(`
import CDP from '${CDP_MODULE}';
import http from 'http';
const tabs = JSON.parse(await new Promise(r => {
  http.get('http://localhost:9222/json', res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>r(d)); });
}));
const tv = tabs.find(t => t.url && t.url.includes('tradingview.com'));
if (!tv) { console.log(JSON.stringify({error: 'no tv tab'})); process.exit(0); }
const client = await CDP({target: tv.id, port: 9222});
const r = await client.Runtime.evaluate({
  expression: String.raw\`(function(){
    var body = document.body.innerText;
    var disconnected = body.includes('Session disconnected');
    var connectBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Connect');
    if (disconnected && connectBtn) { connectBtn.click(); return JSON.stringify({action:'reconnected'}); }
    var tradeBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Trade');
    var bbConnected = body.includes('BlackBull') && !body.includes('Trade with your broker');
    if (!bbConnected && tradeBtn) { tradeBtn.click(); return JSON.stringify({action:'opened_trade_panel'}); }
    // Detect full session expiry — TradingView shows sign-in page
    var sessionExpired = body.includes('Sign in') && !body.includes('chart') && !body.includes('XAUUSD');
    return JSON.stringify({ok:true, bbConnected, disconnected, sessionExpired});
  })()\`,
  returnByValue: true
});
console.log(JSON.stringify(r.result?.value));
await client.close();
`);

  log('Page state: ' + result);

  // 4. Detect session expiry (logged out of TradingView account entirely)
  //    Signs: body contains 'Sign in' or 'Log in' but NOT the chart
  try {
    const state = JSON.parse(result);
    const sessionExpired = typeof state === 'object' && state.sessionExpired;

    if (sessionExpired) {
      // Only send one alert per expiry event (avoid spam)
      if (!existsSync(ALERT_SENT_FILE)) {
        writeFileSync(ALERT_SENT_FILE, new Date().toISOString());
        sendAlert(
          '[AutoTrader] TradingView session expired — action needed',
          'Your TradingView session on the Oracle VM has expired. Trading is paused.\\n\\n' +
          '─────────────────────────────────────────\\n' +
          'STEP 1 — Open a terminal on your PC\\n' +
          'STEP 2 — Run this command:\\n\\n' +
          '  bash C:/Users/Tda-d/tradingview-mcp-jackson/refresh_cookies.sh\\n\\n' +
          '─────────────────────────────────────────\\n' +
          'That is all. Trading will resume automatically once done.\\n\\n' +
          'VM: ubuntu@132.145.44.68\\n' +
          'Time detected: ' + new Date().toUTCString()
        );
      }
    } else {
      // Clear the alert flag once session is healthy again
      if (existsSync(ALERT_SENT_FILE)) {
        try { execSync('rm ' + ALERT_SENT_FILE); } catch {}
        log('Session healthy — alert flag cleared');
      }
    }
  } catch { /* non-fatal parse error */ }

  log('Watchdog OK');
}

main().catch(e => log('FATAL: ' + e.message));
