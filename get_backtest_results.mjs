import { evaluate, getClient } from './src/connection.js';
import * as capture from './src/core/capture.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Click "Open Strategy Report"
const c = await evaluate(`
(function() {
  var btn = document.querySelector('[aria-label="Open Strategy Report"]');
  if (btn) { btn.click(); return 'clicked'; }
  var btns = Array.from(document.querySelectorAll('button'));
  var sr = btns.find(b => (b.textContent||'').includes('Strategy Report'));
  if (sr) { sr.click(); return 'clicked by text'; }
  return 'not found';
})()
`);
console.log('Open button:', c);
await sleep(7000);

// Screenshot to see state
const ss = await capture.captureScreenshot({ region: 'full' });
console.log('Screenshot path:', ss);

// Scrape Overview tab stats
const overview = await evaluate(`
(function() {
  // Click Overview tab if available
  var tabs = Array.from(document.querySelectorAll('[role="tab"], [class*="tab-"]'));
  var ov = tabs.find(function(t) {
    return (t.textContent||'').trim().toLowerCase() === 'overview' ||
           (t.textContent||'').trim().toLowerCase() === 'summary';
  });
  if (ov) ov.click();
  return ov ? 'overview tab clicked: ' + (ov.textContent||'') : 'no overview tab';
})()
`);
console.log('Overview tab:', overview);
await sleep(2000);

// Read all visible text from the backtest report
const reportText = await evaluate(`
(function() {
  // Primary: look for strategy report containers
  var containers = [
    document.querySelector('[class*="backtesting-dialog"]'),
    document.querySelector('[class*="strategyReport"]'),
    document.querySelector('[class*="strategy-report"]'),
    document.querySelector('[class*="report-chart"]'),
    Array.from(document.querySelectorAll('[class*="dialog"]')).find(d => (d.innerText||'').includes('Net Profit'))
  ].filter(Boolean);

  if (containers.length > 0) {
    return containers[0].innerText.substring(0, 5000);
  }

  // Fallback: find elements containing key stats
  var body = document.body.innerText;
  var netProfitIdx = body.indexOf('Net Profit');
  if (netProfitIdx >= 0) {
    return body.substring(netProfitIdx, netProfitIdx + 3000);
  }

  return 'NO REPORT FOUND - body preview: ' + body.substring(0, 500);
})()
`);

console.log('\n========= BACKTEST RESULTS =========');
console.log(reportText);
console.log('====================================');

(await getClient()).close();
