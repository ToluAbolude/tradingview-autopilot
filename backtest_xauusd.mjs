/**
 * Full pipeline: set XAUUSD 1H → inject Jackson strategy → apply to chart → read backtest.
 */
import { readFileSync, writeFileSync } from 'fs';
import { evaluate, getClient } from './src/connection.js';
import * as pine from './src/core/pine.js';
import * as chart from './src/core/chart.js';
import * as capture from './src/core/capture.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SOURCE = readFileSync('/home/ubuntu/tradingview-mcp-jackson/strategies/jackson_gold_multi_setup.pine', 'utf8');

// ── 1. Set XAUUSD 1H ──────────────────────────────────────────────────────────
console.log('[1] Setting XAUUSD 1H...');
await chart.setSymbol({ symbol: 'XAUUSD' });
await sleep(2000);
await chart.setTimeframe({ timeframe: '60' });
await sleep(2000);

// Confirm
const sym = await evaluate(`(function() {
  var el = document.querySelector('[class*="symbol-"] [class*="symbol-"]') ||
            document.querySelector('[data-name="legend-series-item"]');
  return document.title + ' | active: ' + (el ? (el.textContent||'').trim() : 'n/a');
})()`);
console.log('  Chart title:', sym);

// ── 2. Open Pine Editor ───────────────────────────────────────────────────────
console.log('\n[2] Opening Pine Editor...');
await evaluate(`document.querySelector('[data-name="pine-dialog-button"]')?.click()`);
await sleep(3000);

const editorCheck = await evaluate(`(function() {
  var ed = document.querySelector('.monaco-editor') ||
           document.querySelector('[class*="pine-editor"]');
  return ed ? 'editor found' : 'editor NOT found';
})()`);
console.log('  Editor:', editorCheck);

// ── 3. Inject source ──────────────────────────────────────────────────────────
console.log('\n[3] Injecting source (' + SOURCE.length + ' chars)...');
const srcResult = await pine.setSource({ source: SOURCE });
console.log('  setSource:', JSON.stringify(srcResult));
await sleep(1500);

// ── 4. Click "Add to chart" button (title-based) ──────────────────────────────
console.log('\n[4] Clicking "Add to chart"...');
const addResult = await evaluate(`(function() {
  // Primary: button with title="Add to chart"
  var allEls = Array.from(document.querySelectorAll('button, [role="button"]'));
  var btn = allEls.find(function(el) {
    return (el.getAttribute('title')||'').toLowerCase() === 'add to chart' && el.offsetParent !== null;
  });
  if (btn) { btn.click(); return 'title match clicked'; }

  // Also try "Update on chart" if already added
  btn = allEls.find(function(el) {
    return (el.getAttribute('title')||'').toLowerCase().includes('update') &&
           (el.getAttribute('title')||'').toLowerCase().includes('chart') &&
           el.offsetParent !== null;
  });
  if (btn) { btn.click(); return 'update match: ' + btn.getAttribute('title'); }

  // List all button titles for debug
  var titles = allEls
    .filter(function(el) { return el.offsetParent !== null && el.getAttribute('title'); })
    .map(function(el) { return el.getAttribute('title'); });
  return 'not found. Titles: ' + titles.join(', ');
})()`);
console.log('  Add to chart:', addResult);
await sleep(6000);

// ── 5. Check for compile errors ───────────────────────────────────────────────
console.log('\n[5] Checking errors...');
const errors = await pine.getErrors();
console.log('  Errors:', JSON.stringify(errors));

// ── 6. Screenshot ─────────────────────────────────────────────────────────────
console.log('\n[6] Screenshot...');
const ss1 = await capture.captureScreenshot({ region: 'full' });
console.log('  Screenshot:', ss1?.file_path || ss1?.path);

// ── 7. Verify Jackson is on chart ─────────────────────────────────────────────
console.log('\n[7] Checking chart indicators...');
const chartCheck = await evaluate(`(function() {
  var allText = document.body.innerText;
  var hasJackson = allText.includes('Jackson') || allText.includes('JACKSON_GMS');
  var hasPlatinum = allText.includes('Platinum');

  // Look for legend items
  var legendItems = Array.from(document.querySelectorAll(
    '[class*="legend"] [class*="title"], [class*="study"] [class*="title"]'
  )).map(function(el) { return (el.textContent||'').trim().substring(0,50); });

  return JSON.stringify({
    jackson: hasJackson,
    platinum: hasPlatinum,
    legend: legendItems.slice(0,10)
  });
})()`);
console.log('  Chart check:', chartCheck);

// ── 8. Find and click Strategy Tester ────────────────────────────────────────
console.log('\n[8] Opening Strategy Tester...');
const stResult = await evaluate(`(function() {
  // Try aria-label first
  var el = document.querySelector('[aria-label="Open Strategy Report"]');
  if (el && el.offsetParent !== null) { el.click(); return 'aria-label'; }

  // Try data-name
  el = document.querySelector('[data-name="backtesting-dialog-button"]');
  if (el && el.offsetParent !== null) { el.click(); return 'data-name'; }

  // Try title
  var allBtns = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"]'));
  var st = allBtns.find(function(b) {
    var combined = ((b.getAttribute('aria-label')||'') + (b.textContent||'') + (b.getAttribute('title')||'')).toLowerCase();
    return combined.includes('strategy') && (combined.includes('report') || combined.includes('tester'));
  });
  if (st) { st.click(); return 'text: ' + (st.textContent||st.getAttribute('aria-label')||'').trim(); }
  return 'not found';
})()`);
console.log('  Strategy Tester:', stResult);
await sleep(10000);

// ── 9. Click Overview tab ─────────────────────────────────────────────────────
await evaluate(`(function() {
  var tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  var ov = tabs.find(function(t) {
    var txt = (t.textContent||'').trim().toLowerCase();
    return txt === 'overview' || txt === 'metrics';
  });
  if (ov) ov.click();
})()`);
await sleep(2000);

// ── 10. Read backtest results ─────────────────────────────────────────────────
console.log('\n[10] Reading backtest results...');
const results = await evaluate(`(function() {
  // Check which strategy is shown
  var firstLine = '';
  var panel = document.querySelector('[data-name="backtesting-dialog"]') ||
               document.querySelector('[class*="backtesting"]') ||
               document.querySelector('[class*="strategyReport"]') ||
               document.querySelector('[class*="strategy-report"]');

  if (panel) {
    return { found: true, text: (panel.innerText||'').substring(0,5000) };
  }

  // Fallback: find Net Profit in body
  var body = document.body.innerText;
  var idx = body.indexOf('Net Profit');
  if (idx >= 0) {
    // Get some context before for strategy name
    var start = Math.max(0, idx - 200);
    return { found: true, text: body.substring(start, idx + 4000) };
  }

  // Look for any "Percent profitable" which appears in all strategy reports
  idx = body.indexOf('Percent profitable');
  if (idx >= 0) {
    var start2 = Math.max(0, idx - 500);
    return { found: true, text: body.substring(start2, idx + 3000) };
  }

  return { found: false, bodyPreview: body.substring(0, 800) };
})()`);

// Final screenshot
const ss2 = await capture.captureScreenshot({ region: 'full' });
console.log('  Final screenshot:', ss2?.file_path || ss2?.path);

console.log('\n========= BACKTEST REPORT =========');
if (results.found) {
  console.log(results.text);
} else {
  console.log('Report not found. Body preview:');
  console.log(results.bodyPreview);
}
console.log('===================================');

// Save
writeFileSync('/tmp/jackson_backtest.json', JSON.stringify({
  strategy: 'Jackson Gold Multi-Setup',
  symbol: 'XAUUSD', timeframe: '1H',
  timestamp: new Date().toISOString(),
  screenshot: ss2?.file_path || ss2?.path,
  report: results.text || results.bodyPreview
}, null, 2));

console.log('\nSaved: /tmp/jackson_backtest.json');
(await getClient()).close();
