/**
 * Load jackson_gold_v2.pine → compile → read Strategy Tester results.
 */
import { readFileSync, writeFileSync } from 'fs';
import { evaluate, getClient } from './src/connection.js';
import * as pine from './src/core/pine.js';
import * as chart from './src/core/chart.js';
import * as capture from './src/core/capture.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SOURCE = readFileSync('/home/ubuntu/tradingview-mcp-jackson/strategies/jackson_gold_v2.pine', 'utf8');

console.log('[1] XAUUSD 1H...');
await chart.setSymbol({ symbol: 'XAUUSD' });
await sleep(1500);
await chart.setTimeframe({ timeframe: '60' });
await sleep(2000);

console.log('[2] Open Pine Editor...');
await evaluate(`document.querySelector('[data-name="pine-dialog-button"]')?.click()`);
await sleep(3000);

console.log('[3] Injecting source (' + SOURCE.length + ' chars)...');
const srcResult = await pine.setSource({ source: SOURCE });
console.log('   setSource:', JSON.stringify(srcResult));
await sleep(1000);

console.log('[4] Add to chart...');
const addResult = await evaluate(`(function() {
  var allEls = Array.from(document.querySelectorAll('button, [role="button"]'));
  var btn = allEls.find(function(el) {
    return (el.getAttribute('title')||'').toLowerCase() === 'add to chart' && el.offsetParent !== null;
  });
  if (btn) { btn.click(); return 'clicked Add to chart'; }
  btn = allEls.find(function(el) {
    return (el.getAttribute('title')||'').toLowerCase().includes('update') &&
           (el.getAttribute('title')||'').toLowerCase().includes('chart') &&
           el.offsetParent !== null;
  });
  if (btn) { btn.click(); return 'clicked: ' + btn.getAttribute('title'); }
  return 'not found';
})()`);
console.log('   Add result:', addResult);
await sleep(7000);

console.log('[5] Checking errors...');
const errors = await pine.getErrors();
console.log('   Errors:', JSON.stringify(errors));
// severity 8 = error; severity 4 = warning (barstate.islast note) — ignore warnings
const realErrors = errors.errors ? errors.errors.filter(e => e.severity >= 8) : [];
if (realErrors.length > 0) {
  realErrors.forEach(e => console.error(`   Line ${e.line}: ${e.message}`));
  (await getClient()).close();
  process.exit(1);
}
if (errors.errors && errors.errors.length) {
  console.log('   (warnings only — continuing)');
}

console.log('[6] Opening Strategy Tester...');
const stResult = await evaluate(`(function() {
  var el = document.querySelector('[aria-label="Open Strategy Report"]');
  if (el && el.offsetParent !== null) { el.click(); return 'ok'; }
  var btns = Array.from(document.querySelectorAll('button, [role="button"]'));
  var st = btns.find(function(b) {
    return ((b.getAttribute('aria-label')||'') + (b.textContent||'')).toLowerCase().includes('strategy');
  });
  if (st) { st.click(); return 'text: ' + (st.textContent||'').trim(); }
  return 'not found';
})()`);
console.log('   ST result:', stResult);
await sleep(10000);

console.log('[7] Screenshot...');
const ss = await capture.captureScreenshot({ region: 'full' });
console.log('   Screenshot:', ss?.file_path || ss?.path);

console.log('[8] Reading results...');
const results = await evaluate(`(function() {
  var body = document.body.innerText;
  var idx = body.indexOf('Net Profit');
  if (idx >= 0) {
    var start = Math.max(0, idx - 100);
    return { found: true, text: body.substring(start, idx + 4000) };
  }
  var panel = document.querySelector('[data-name="backtesting-dialog"]') ||
              document.querySelector('[class*="backtesting"]') ||
              document.querySelector('[class*="strategyReport"]');
  if (panel) return { found: true, text: (panel.innerText||'').substring(0, 4000) };
  return { found: false, preview: body.substring(0, 600) };
})()`);

console.log('\n========= v2 BACKTEST RESULTS =========');
if (results.found) {
  console.log(results.text);
} else {
  console.log('NOT FOUND. Preview:\n', results.preview);
}
console.log('========================================');

writeFileSync('/tmp/jackson_v2_results.json', JSON.stringify({
  version: 'v2',
  symbol: 'XAUUSD', timeframe: '1H',
  timestamp: new Date().toISOString(),
  screenshot: ss?.file_path || ss?.path,
  report: results.text || results.preview
}, null, 2));

console.log('Saved: /tmp/jackson_v2_results.json');
(await getClient()).close();
