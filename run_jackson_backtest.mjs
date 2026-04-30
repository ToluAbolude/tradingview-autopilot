/**
 * End-to-end: load Jackson strategy → compile → read strategy tester results.
 */
import { readFileSync, writeFileSync } from 'fs';
import { evaluate, getClient } from './src/connection.js';
import * as pine  from './src/core/pine.js';
import * as chart from './src/core/chart.js';
import * as capture from './src/core/capture.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SOURCE = readFileSync('/home/ubuntu/tradingview-mcp-jackson/strategies/jackson_gold_multi_setup.pine', 'utf8');

// ── 1. Set XAUUSD 1H ─────────────────────────────────────────────────────────
console.log('[1] Setting XAUUSD 1H...');
await chart.setSymbol({ symbol: 'XAUUSD' });
await sleep(2000);
await chart.setTimeframe({ timeframe: '60' });
await sleep(2000);

// ── 2. Ensure Pine Editor open ────────────────────────────────────────────────
console.log('[2] Opening Pine Editor...');
const editorOpen = await pine.ensurePineEditorOpen();
console.log('    editor open:', editorOpen);
if (!editorOpen) {
  // Force click the Pine button
  await evaluate(`document.querySelector('[aria-label="Pine"]')?.click()`);
  await sleep(3000);
}

// ── 3. Create new blank script slot ──────────────────────────────────────────
console.log('[3] Creating new script slot...');
try {
  await pine.newScript({ type: 'strategy', title: 'Jackson GMS' });
  await sleep(2000);
} catch (e) {
  console.log('    (newScript skipped):', e.message);
}

// ── 4. Set source ─────────────────────────────────────────────────────────────
console.log('[4] Setting source (' + SOURCE.length + ' chars)...');
const srcResult = await pine.setSource({ source: SOURCE });
console.log('    set result:', JSON.stringify(srcResult));
await sleep(1500);

// ── 5. Compile (Add to chart) ─────────────────────────────────────────────────
console.log('[5] Compiling...');
const compileResult = await pine.compile();
console.log('    compile result:', JSON.stringify(compileResult));
await sleep(4000);

// ── 6. Check errors ───────────────────────────────────────────────────────────
console.log('[6] Checking errors...');
const errResult = await pine.getErrors();
console.log('    errors:', JSON.stringify(errResult));

if (errResult.has_errors) {
  console.error('COMPILE ERRORS:');
  errResult.errors.forEach(e => console.error(`  Line ${e.line}:${e.column} — ${e.message}`));
  process.exit(1);
}
console.log('    OK - compiled clean');

// ── 7. Wait for strategy to load on chart ────────────────────────────────────
console.log('[7] Waiting for strategy to load...');
await sleep(5000);

// ── 8. Find and open Strategy Tester ─────────────────────────────────────────
console.log('[8] Opening Strategy Tester...');
const openResult = await evaluate(`(function() {
  var selectors = [
    '[aria-label="Open Strategy Report"]',
    '[data-name="backtesting-dialog-button"]',
  ];
  for (var i = 0; i < selectors.length; i++) {
    var el = document.querySelector(selectors[i]);
    if (el && el.offsetParent !== null) { el.click(); return 'clicked: ' + selectors[i]; }
  }
  // Text-based search
  var btns = Array.from(document.querySelectorAll('button, [role="tab"]'));
  var match = btns.find(function(b) {
    var t = (b.textContent||'').toLowerCase();
    return t.includes('strategy') && (t.includes('report') || t.includes('tester'));
  });
  if (match) { match.click(); return 'clicked text: ' + match.textContent.trim(); }
  return 'not found';
})()`);
console.log('    open result:', openResult);
await sleep(7000);

// ── 9. Screenshot ─────────────────────────────────────────────────────────────
console.log('[9] Taking screenshot...');
const ss = await capture.captureScreenshot({ region: 'full' });
console.log('    saved:', ss?.file_path || ss?.path);

// ── 10. Read stats ────────────────────────────────────────────────────────────
console.log('[10] Reading stats...');

// Click Overview/Summary tab
await evaluate(`(function() {
  var tabs = Array.from(document.querySelectorAll('[role="tab"], [class*="tab-"]'));
  var ov = tabs.find(function(t) {
    var txt = (t.textContent||'').trim().toLowerCase();
    return txt === 'overview' || txt === 'metrics';
  });
  if (ov) ov.click();
})()`);
await sleep(1500);

const report = await evaluate(`(function() {
  // Look for the backtest report panel
  var candidate = null;

  // Option A: by data-name
  candidate = document.querySelector('[data-name="backtesting-dialog"]');

  // Option B: by class containing Net Profit text
  if (!candidate) {
    var all = Array.from(document.querySelectorAll('[class*="backtesting"], [class*="strategyReport"], [class*="report"]'));
    candidate = all.find(function(el) { return (el.innerText||'').includes('Net Profit'); });
  }

  // Option C: scan full body for "Net Profit" section
  if (!candidate) {
    var allDivs = document.querySelectorAll('div');
    for (var i = 0; i < allDivs.length; i++) {
      if ((allDivs[i].innerText||'').includes('Net Profit') &&
          (allDivs[i].innerText||'').includes('Total trades')) {
        candidate = allDivs[i];
        break;
      }
    }
  }

  if (!candidate) return { error: 'report panel not found' };

  var text = (candidate.innerText || '').substring(0, 5000);
  return { text: text };
})()`);

console.log('\n========= BACKTEST REPORT =========');
if (report.error) {
  console.log('ERROR:', report.error);
} else {
  console.log(report.text);
}
console.log('===================================');

// Save
writeFileSync('/tmp/jackson_results.json', JSON.stringify({
  strategy: 'Jackson Gold Multi-Setup',
  symbol: 'XAUUSD', timeframe: '1H',
  timestamp: new Date().toISOString(),
  screenshot: ss?.file_path || ss?.path,
  report: report.text || report.error
}, null, 2));

console.log('\nResults saved to /tmp/jackson_results.json');
(await getClient()).close();
