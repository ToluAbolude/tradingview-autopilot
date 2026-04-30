import { readFileSync, writeFileSync } from 'fs';
import { evaluate, getClient } from './src/connection.js';
import * as pine from './src/core/pine.js';
import * as chart from './src/core/chart.js';
import * as capture from './src/core/capture.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SOURCE = readFileSync('/home/ubuntu/tradingview-mcp-jackson/strategies/jackson_gold_v3.pine', 'utf8');

console.log('[1] XAUUSD 1H...');
await chart.setSymbol({ symbol: 'XAUUSD' });
await sleep(1500);
await chart.setTimeframe({ timeframe: '60' });
await sleep(2000);

console.log('[2] Open Pine Editor...');
await evaluate(`document.querySelector('[data-name="pine-dialog-button"]')?.click()`);
await sleep(3000);

console.log('[3] Inject source (' + SOURCE.length + ' chars)...');
const srcResult = await pine.setSource({ source: SOURCE });
console.log('   ', JSON.stringify(srcResult));
await sleep(1000);

console.log('[4] Add to chart...');
const addResult = await evaluate(`(function() {
  var allEls = Array.from(document.querySelectorAll('button, [role="button"]'));
  var btn = allEls.find(function(el) {
    var t = (el.getAttribute('title')||'').toLowerCase();
    return (t === 'add to chart' || t.includes('update') && t.includes('chart')) && el.offsetParent !== null;
  });
  if (btn) { btn.click(); return btn.getAttribute('title'); }
  return 'not found';
})()`);
console.log('   ', addResult);
await sleep(7000);

console.log('[5] Check errors...');
const errors = await pine.getErrors();
const real = (errors.errors || []).filter(e => e.severity >= 8);
if (real.length > 0) {
  real.forEach(e => console.error(`   Line ${e.line}: ${e.message}`));
  (await getClient()).close(); process.exit(1);
}
console.log('   OK — 0 real errors');

console.log('[6] Open Strategy Tester...');
await evaluate(`(function() {
  var el = document.querySelector('[aria-label="Open Strategy Report"]');
  if (el && el.offsetParent !== null) { el.click(); return; }
  var btns = Array.from(document.querySelectorAll('button'));
  var st = btns.find(function(b) { return ((b.getAttribute('aria-label')||'') + (b.textContent||'')).toLowerCase().includes('strategy'); });
  if (st) st.click();
})()`);
await sleep(10000);

console.log('[7] Screenshot...');
const ss = await capture.captureScreenshot({ region: 'full' });
console.log('   ', ss?.file_path || ss?.path);

console.log('[8] Read results...');
const results = await evaluate(`(function() {
  var body = document.body.innerText;
  var idx = body.indexOf('Net Profit');
  if (idx >= 0) return { found: true, text: body.substring(Math.max(0, idx - 100), idx + 4000) };
  var panel = document.querySelector('[data-name="backtesting-dialog"]') || document.querySelector('[class*="backtesting"]') || document.querySelector('[class*="strategyReport"]');
  if (panel) return { found: true, text: (panel.innerText||'').substring(0, 4000) };
  return { found: false, preview: body.substring(0, 500) };
})()`);

console.log('\n========= v3 RESULTS =========');
console.log(results.found ? results.text : 'NOT FOUND:\n' + results.preview);
console.log('================================');

writeFileSync('/tmp/jackson_v3_results.json', JSON.stringify({
  version: 'v3', symbol: 'XAUUSD', timeframe: '1H',
  timestamp: new Date().toISOString(),
  screenshot: ss?.file_path || ss?.path,
  report: results.text || results.preview
}, null, 2));

console.log('Saved: /tmp/jackson_v3_results.json');
(await getClient()).close();
