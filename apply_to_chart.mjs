/**
 * Find and click the "Add to chart" / "Update on chart" button in the Pine editor toolbar,
 * then read Strategy Tester results.
 */
import { readFileSync } from 'fs';
import { evaluate, getClient } from './src/connection.js';
import * as pine from './src/core/pine.js';
import * as capture from './src/core/capture.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 1. Inspect Pine editor toolbar buttons ────────────────────────────────────
console.log('[1] Inspecting Pine editor area...');
const toolbar = await evaluate(`(function() {
  // Find Pine editor container
  var pineArea = document.querySelector('[class*="pine-editor"]') ||
                 document.querySelector('[class*="pineEditor"]') ||
                 document.querySelector('[id*="pine"]');

  // Get all buttons in the page with aria-labels (toolbar buttons often have these)
  var allBtns = Array.from(document.querySelectorAll('button, [role="button"]'));
  var result = allBtns
    .filter(function(b) { return b.offsetParent !== null; })
    .map(function(b) {
      return {
        text: (b.textContent||'').trim().substring(0,40),
        label: b.getAttribute('aria-label') || '',
        title: b.getAttribute('title') || '',
        dataName: b.getAttribute('data-name') || '',
        cls: b.className.substring(0,80)
      };
    })
    .filter(function(b) {
      var combined = (b.label + b.title + b.dataName).toLowerCase();
      return combined.includes('add') || combined.includes('chart') ||
             combined.includes('save') || combined.includes('apply') ||
             combined.includes('compile') || combined.includes('update') ||
             combined.includes('pine') || combined.includes('script');
    });
  return result;
})()`);
console.log('Pine-related buttons:');
toolbar.forEach(b => console.log(`  text="${b.text}" label="${b.label}" title="${b.title}" data-name="${b.dataName}"`));

// ── 2. Try clicking "Add to chart" by various means ───────────────────────────
console.log('\n[2] Attempting to add to chart...');
const addResult = await evaluate(`(function() {
  // Search by aria-label patterns
  var allBtns = Array.from(document.querySelectorAll('button, [role="button"]'));
  var patterns = ['add to chart', 'update on chart', 'save and add', 'apply to chart',
                  'add script to chart', 'apply script'];

  for (var i = 0; i < allBtns.length; i++) {
    var b = allBtns[i];
    var combined = ((b.getAttribute('aria-label')||'') + ' ' +
                    (b.getAttribute('title')||'') + ' ' +
                    (b.textContent||'')).toLowerCase();
    for (var j = 0; j < patterns.length; j++) {
      if (combined.includes(patterns[j]) && b.offsetParent !== null) {
        b.click();
        return 'clicked: "' + combined.trim().substring(0,60) + '"';
      }
    }
  }

  // Try data-name selectors
  var dataNames = ['add-to-chart', 'pine-add-to-chart', 'pine-update', 'compile', 'apply'];
  for (var k = 0; k < dataNames.length; k++) {
    var el = document.querySelector('[data-name="' + dataNames[k] + '"]');
    if (el && el.offsetParent !== null) {
      el.click();
      return 'data-name clicked: ' + dataNames[k];
    }
  }

  // Try the keyboard shortcut Ctrl+Enter (common for "Add to chart")
  return 'no button found - will try keyboard shortcut';
})()`);
console.log('Add result:', addResult);

// If button not found, try Ctrl+Enter keyboard shortcut
if (addResult.includes('no button')) {
  console.log('  → Trying Ctrl+Enter shortcut...');
  // Focus the Pine editor first
  await evaluate(`(function() {
    var editor = document.querySelector('.monaco-editor') ||
                 document.querySelector('[class*="pine-editor"]');
    if (editor) editor.click();
  })()`);
  await sleep(500);

  // Dispatch Ctrl+Enter
  await evaluate(`(function() {
    var event = new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13,
      ctrlKey: true, bubbles: true, cancelable: true
    });
    document.activeElement.dispatchEvent(event);
    document.dispatchEvent(event);
  })()`);
  console.log('  Ctrl+Enter dispatched');
}

await sleep(6000);

// ── 3. Check if Jackson is now on chart ───────────────────────────────────────
console.log('\n[3] Checking if Jackson is on chart...');
const chartState = await evaluate(`(function() {
  var studies = document.querySelectorAll('[class*="study-item"], [class*="studyItem"], [class*="legend-"]');
  var items = Array.from(studies).map(function(el) {
    return (el.textContent||'').trim().substring(0,60);
  }).filter(function(t) { return t.length > 2; });
  return { items: items.slice(0,20) };
})()`);
console.log('Chart items:', JSON.stringify(chartState));

// ── 4. Try using pine.compile() which has more sophisticated button detection ──
console.log('\n[4] Using pine.compile() to properly apply...');
const compileResult = await pine.compile();
console.log('compile():', JSON.stringify(compileResult));
await sleep(6000);

// ── 5. Take screenshot to see current state ───────────────────────────────────
console.log('\n[5] Screenshot...');
const ss = await capture.captureScreenshot({ region: 'full' });
console.log('Screenshot:', ss?.file_path || ss?.path);

// ── 6. Check Strategy Tester ──────────────────────────────────────────────────
console.log('\n[6] Opening Strategy Tester...');
const stResult = await evaluate(`(function() {
  var el = document.querySelector('[aria-label="Open Strategy Report"]') ||
            document.querySelector('[data-name="backtesting-dialog-button"]');
  if (el && el.offsetParent !== null) { el.click(); return 'clicked'; }

  var btns = Array.from(document.querySelectorAll('button, [role="button"]'));
  var st = btns.find(function(b) {
    return ((b.getAttribute('aria-label')||'') + (b.textContent||'')).toLowerCase().includes('strategy');
  });
  if (st) { st.click(); return 'text: ' + (st.textContent||st.getAttribute('aria-label')||'').trim(); }
  return 'not found';
})()`);
console.log('Strategy Tester:', stResult);
await sleep(8000);

// ── 7. Scrape results ─────────────────────────────────────────────────────────
console.log('\n[7] Reading results...');
const results = await evaluate(`(function() {
  // First check what strategy name is shown
  var body = document.body.innerText;
  var idx = body.indexOf('Net Profit');
  if (idx >= 0) {
    // Find strategy name (usually near top of report)
    var stratNameEl = document.querySelector('[class*="strategyReport"] [class*="title"]') ||
                      document.querySelector('[class*="backtesting"] h1') ||
                      document.querySelector('[class*="backtesting"] h2');
    return {
      found: true,
      strategyName: stratNameEl ? (stratNameEl.textContent||'').trim() : 'unknown',
      text: body.substring(idx, idx + 4000)
    };
  }
  return { found: false, bodyPreview: body.substring(0, 500) };
})()`);

console.log('\n========= RESULTS =========');
if (results.found) {
  console.log('Strategy:', results.strategyName);
  console.log(results.text);
} else {
  console.log('NOT FOUND. Preview:', results.bodyPreview);
}
console.log('===========================');

(await getClient()).close();
