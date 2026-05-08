import CDP from 'chrome-remote-interface';
import { readFileSync } from 'fs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const source = readFileSync('/home/ubuntu/tradingview-mcp-jackson/scripts/strategy_dashboard.pine', 'utf8');
console.log(`Source: ${source.length} chars, ${source.split('\n').length} lines`);

const resp = await fetch('http://localhost:9222/json/list');
const targets = await resp.json();
const target = targets.find(t => t.type === 'page' && /tradingview/i.test(t.url));
if (!target) { console.log('No TradingView page found'); process.exit(1); }
console.log('Target:', target.url.substring(0, 80));

const client = await CDP({ host: 'localhost', port: 9222, target: target.id });
await client.Runtime.enable();

const ev = async (expr) => {
  const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true });
  if (r.exceptionDetails) console.log('Exception:', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};

// The FIND_MONACO snippet from src/core/pine.js — finds Monaco via React fiber
const FIND_MONACO = `
  (function findMonacoEditor() {
    var container = document.querySelector('.monaco-editor.pine-editor-monaco');
    if (!container) return null;
    var el = container;
    var fiberKey;
    for (var i = 0; i < 20; i++) {
      if (!el) break;
      fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
      if (fiberKey) break;
      el = el.parentElement;
    }
    if (!fiberKey) return null;
    var current = el[fiberKey];
    for (var d = 0; d < 15; d++) {
      if (!current) break;
      if (current.memoizedProps && current.memoizedProps.value && current.memoizedProps.value.monacoEnv) {
        var env = current.memoizedProps.value.monacoEnv;
        if (env.editor && typeof env.editor.getEditors === 'function') {
          var editors = env.editor.getEditors();
          if (editors.length > 0) return { found: true };
        }
      }
      current = current.return;
    }
    return null;
  })()
`;

// Step 1: Open Pine Editor and wait for Monaco
console.log('\n-- Step 1: Open Pine Editor --');
// Try TradingView internal API first
await ev(`(function() {
  var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
  if (!bwb) return;
  if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
  else if (typeof bwb.showWidget === 'function') bwb.showWidget('pine-editor');
})()`);
await ev(`(function() {
  var btn = document.querySelector('[aria-label="Pine"]') || document.querySelector('[data-name="pine-dialog-button"]');
  if (btn) btn.click();
})()`);

// Wait for Monaco (up to 10 seconds)
let monacoReady = false;
for (let i = 0; i < 50; i++) {
  await sleep(200);
  const ready = await ev(`(function() { return (${FIND_MONACO}) !== null; })()`);
  if (ready) { monacoReady = true; break; }
}
console.log('Monaco ready:', monacoReady);

// Step 2: Inject source
console.log('\n-- Step 2: Injecting source --');
const escaped = JSON.stringify(source);
const setRes = await ev(`(function() {
  var findMonaco = function() {
    var container = document.querySelector('.monaco-editor.pine-editor-monaco');
    if (!container) return null;
    var el = container;
    var fiberKey;
    for (var i = 0; i < 20; i++) {
      if (!el) break;
      fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
      if (fiberKey) break;
      el = el.parentElement;
    }
    if (!fiberKey) return null;
    var current = el[fiberKey];
    for (var d = 0; d < 15; d++) {
      if (!current) break;
      if (current.memoizedProps && current.memoizedProps.value && current.memoizedProps.value.monacoEnv) {
        var env = current.memoizedProps.value.monacoEnv;
        if (env.editor && typeof env.editor.getEditors === 'function') {
          var editors = env.editor.getEditors();
          if (editors.length > 0) return { editor: editors[0], env: env };
        }
      }
      current = current.return;
    }
    return null;
  };
  var m = findMonaco();
  if (!m) return 'no-monaco';
  m.editor.setValue(${escaped});
  return 'set:' + m.editor.getValue().length + ' chars';
})()`);
console.log('Set result:', setRes);
await sleep(1000);

if (!setRes || setRes === 'no-monaco') {
  console.log('Monaco not found — aborting');
  await client.close();
  process.exit(1);
}

// Step 3: Click "Add to chart" / "Update on chart"
console.log('\n-- Step 3: Add/Update on chart --');
const addRes = await ev(`(function() {
  var btn = document.querySelector('[aria-label="Add to chart"]') ||
            document.querySelector('[aria-label="Update on chart"]');
  if (btn) { btn.click(); return 'clicked aria: ' + btn.getAttribute('aria-label'); }
  var allBtns = Array.from(document.querySelectorAll('button, [role="button"]'));
  for (var b of allBtns) {
    if (!b.offsetParent) continue;
    var t = (b.getAttribute('title') || b.getAttribute('aria-label') || b.textContent || '').trim();
    if (t === 'Add to chart' || t === 'Update on chart') { b.click(); return 'clicked: ' + t; }
  }
  var widget = document.querySelector('.tv-script-widget');
  if (widget) {
    var wbtns = Array.from(widget.querySelectorAll('button')).filter(function(b) {
      var cls = b.className || '';
      return b.offsetParent &&
        !cls.includes('codicon') && !cls.includes('nameButton') &&
        !cls.includes('saveButton') && !cls.includes('publishButton') &&
        !cls.includes('ellipse') && !cls.includes('consoleButton') &&
        !cls.includes('referenceButton');
    });
    if (wbtns.length > 0) { wbtns[0].click(); return 'widget-btn: ' + wbtns[0].className.substring(0, 50); }
  }
  return 'not-found';
})()`);
console.log('Add result:', addRes);

await sleep(5000);

// Step 4: Check for compile errors
console.log('\n-- Step 4: Check errors --');
const errors = await ev(`(function() {
  var errs = document.querySelectorAll('.tv-script-editor-container .error, [class*="error"], [class*="Error"]');
  var msgs = [];
  errs.forEach(function(e) {
    var t = e.textContent.trim();
    if (t && t.length < 200 && !msgs.includes(t)) msgs.push(t);
  });
  return JSON.stringify(msgs.slice(0, 5));
})()`);
console.log('Errors:', errors);

// Step 5: Verify studies
console.log('\n-- Step 5: Studies on chart --');
const studies = await ev(`(function() {
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    if (chart && typeof chart.getAllStudies === 'function') {
      return JSON.stringify(chart.getAllStudies().map(function(s) {
        return (s.metaInfo ? s.metaInfo.shortDescription || '' : '') || s.name || 'unknown';
      }));
    }
  } catch(e) { return '["error:' + e.message + '"]'; }
  return '[]';
})()`);
console.log('Studies:', studies);

await client.close();
console.log('\nDone.');
