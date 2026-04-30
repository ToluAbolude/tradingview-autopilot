/**
 * Ensure Jackson strategy is applied to chart (not just saved),
 * then open Strategy Tester and scrape results.
 */
import { evaluate, getClient } from './src/connection.js';
import * as pine from './src/core/pine.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 1. Check current state ────────────────────────────────────────────────────
console.log('[1] Checking button state...');
const btns = await evaluate(`(function() {
  var allBtns = Array.from(document.querySelectorAll('button'));
  return allBtns
    .filter(function(b) { return b.offsetParent !== null; })
    .map(function(b) {
      return {
        text: (b.textContent||'').trim().substring(0,50),
        label: b.getAttribute('aria-label')||'',
        cls: b.className.substring(0,80)
      };
    })
    .filter(function(b) { return b.text || b.label; })
    .slice(0,40);
})()`);
console.log('Visible buttons:');
btns.forEach(b => console.log(`  [${b.label || b.text}] cls=${b.cls.substring(0,40)}`));

// ── 2. Look for "Add to chart" / "Update on chart" specifically ───────────────
console.log('\n[2] Looking for compile/apply button...');
const compileBtn = await evaluate(`(function() {
  var allBtns = Array.from(document.querySelectorAll('button'));
  var targets = ['add to chart', 'update on chart', 'save and add to chart', 'apply to chart'];
  var match = allBtns.find(function(b) {
    var t = (b.textContent||'').trim().toLowerCase();
    var al = (b.getAttribute('aria-label')||'').toLowerCase();
    return targets.some(function(tgt) { return t.includes(tgt) || al.includes(tgt); });
  });
  if (match) {
    match.click();
    return 'clicked: ' + (match.textContent||'').trim() + ' / ' + match.getAttribute('aria-label');
  }

  // Try data-name selectors
  var selectors = [
    '[data-name="pine-add-to-chart"]',
    '[data-name="add-to-chart"]',
    '[class*="addToChart"]',
    '[class*="add-to-chart"]',
    '[class*="applyToChart"]',
    '[class*="apply-to-chart"]',
  ];
  for (var i = 0; i < selectors.length; i++) {
    var el = document.querySelector(selectors[i]);
    if (el && el.offsetParent !== null) {
      el.click();
      return 'clicked selector: ' + selectors[i];
    }
  }

  // Find Pine toolbar specifically
  var toolbar = document.querySelector('[class*="pine-toolbar"]') ||
                document.querySelector('[class*="pineEditor"]') ||
                document.querySelector('[class*="pine-editor"]');
  if (toolbar) {
    var toolbarBtns = Array.from(toolbar.querySelectorAll('button'));
    return 'toolbar buttons: ' + toolbarBtns.map(function(b) {
      return '"' + (b.textContent||'').trim() + '"';
    }).join(', ');
  }

  return 'not found';
})()`);
console.log('Compile button result:', compileBtn);

await sleep(5000);

// ── 3. Check errors ───────────────────────────────────────────────────────────
console.log('\n[3] Checking errors...');
const errors = await pine.getErrors();
console.log('Errors:', JSON.stringify(errors));

// ── 4. Check if strategy tester button is visible now ─────────────────────────
console.log('\n[4] Checking Strategy Tester availability...');
const stCheck = await evaluate(`(function() {
  var indicators = document.querySelectorAll('[class*="study-item"], [class*="studyItem"]');
  var jackson = Array.from(indicators).find(function(el) {
    return (el.textContent||'').includes('Jackson') || (el.textContent||'').includes('JACKSON');
  });

  var stBtn = document.querySelector('[data-name="backtesting-dialog-button"]') ||
              document.querySelector('[aria-label="Open Strategy Report"]') ||
              Array.from(document.querySelectorAll('button')).find(function(b) {
                return (b.textContent||'').includes('Strategy') ||
                       (b.getAttribute('aria-label')||'').includes('Strategy');
              });

  return JSON.stringify({
    jacksonOnChart: !!jackson,
    jacksonText: jackson ? (jackson.textContent||'').trim().substring(0,50) : null,
    strategyTesterBtn: !!stBtn,
    stBtnText: stBtn ? ((stBtn.textContent||stBtn.getAttribute('aria-label')||'').trim()) : null
  });
})()`);
console.log('State:', stCheck);

// ── 5. Open Strategy Tester ───────────────────────────────────────────────────
console.log('\n[5] Opening Strategy Tester...');
const openST = await evaluate(`(function() {
  var selectors = [
    '[aria-label="Open Strategy Report"]',
    '[data-name="backtesting-dialog-button"]',
  ];
  for (var i = 0; i < selectors.length; i++) {
    var el = document.querySelector(selectors[i]);
    if (el && el.offsetParent !== null) { el.click(); return 'clicked: ' + selectors[i]; }
  }
  var btns = Array.from(document.querySelectorAll('button, [role="tab"]'));
  var st = btns.find(function(b) {
    var t = ((b.textContent||'') + (b.getAttribute('aria-label')||'')).toLowerCase();
    return t.includes('strategy') && (t.includes('report') || t.includes('tester') || t.includes('backtesting'));
  });
  if (st) { st.click(); return 'text click: ' + (st.textContent||'').trim(); }
  return 'not found';
})()`);
console.log('Strategy Tester:', openST);
await sleep(8000);

// ── 6. Scrape results ─────────────────────────────────────────────────────────
console.log('\n[6] Scraping results...');
const results = await evaluate(`(function() {
  var body = document.body.innerText;
  var idx = body.indexOf('Net Profit');
  if (idx >= 0) return { found: true, text: body.substring(idx, idx + 4000) };

  var panel = document.querySelector('[data-name="backtesting-dialog"]') ||
              document.querySelector('[class*="backtesting"]') ||
              document.querySelector('[class*="strategyReport"]');
  if (panel) return { found: true, text: (panel.innerText||'').substring(0, 4000) };

  return { found: false, preview: body.substring(0, 1000) };
})()`);

console.log('\n========= RESULTS =========');
console.log(results.found ? results.text : 'NOT FOUND. Body preview:\n' + results.preview);
console.log('===========================');

(await getClient()).close();
