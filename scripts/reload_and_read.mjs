/**
 * Reload the alpha kill strategy (updated version) and read backtest results.
 * Uses the known working flow: inject → save → "Update on chart" → read tester.
 */
import { evaluate, getClient } from '../src/connection.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dir, '../scripts/current.pine'), 'utf-8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const client = await getClient();

// Close any modal
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, keyCode:27}))`);
await sleep(500);

// Open Pine editor
await evaluate(`(function(){
  var bwb = window.TradingView.bottomWidgetBar;
  if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
})()`);

let ready = false;
for (let i = 0; i < 40; i++) {
  await sleep(250);
  ready = await evaluate(`(function(){
    var c = document.querySelector('.monaco-editor.pine-editor-monaco');
    if (!c) return false;
    var el = c, fk;
    for (var i = 0; i < 20; i++) { if (!el) break; fk = Object.keys(el).find(k => k.startsWith('__reactFiber$')); if (fk) break; el = el.parentElement; }
    var cur = el[fk];
    for (var d = 0; d < 15; d++) { if (!cur) break; if (cur.memoizedProps?.value?.monacoEnv?.editor) return true; cur = cur.return; }
    return false;
  })()`);
  if (ready) break;
}
console.log('Monaco ready:', ready);

// Inject code
const escaped = JSON.stringify(src);
const injected = await evaluate(`(function(){
  var c = document.querySelector('.monaco-editor.pine-editor-monaco');
  var el = c, fk;
  for (var i = 0; i < 20; i++) { if (!el) break; fk = Object.keys(el).find(k => k.startsWith('__reactFiber$')); if (fk) break; el = el.parentElement; }
  var cur = el[fk];
  for (var d = 0; d < 15; d++) {
    if (!cur) break;
    if (cur.memoizedProps?.value?.monacoEnv?.editor) {
      cur.memoizedProps.value.monacoEnv.editor.getEditors()[0].setValue(${escaped});
      return 'injected ' + cur.memoizedProps.value.monacoEnv.editor.getEditors()[0].getModel().getLineCount() + ' lines';
    }
    cur = cur.return;
  }
  return 'inject-failed';
})()`);
console.log('Inject:', injected);
await sleep(300);

// Save via save button (not keyboard — to avoid side effects)
const saveBtn = await evaluate(`(function(){
  var btns = document.querySelectorAll('button');
  for (var i = 0; i < btns.length; i++) {
    var b = btns[i];
    if (!b.offsetParent) continue;
    var cls = b.className || '';
    var title = b.getAttribute('title') || '';
    if (cls.indexOf('saveButton-') !== -1 || title === 'Save script') {
      b.click();
      return 'saved: ' + title;
    }
  }
  return 'no save button';
})()`);
console.log('Save:', saveBtn);
await sleep(2000);

// Handle save dialog if any
await evaluate(`(function(){
  // Check for name input in dialog
  var inputs = document.querySelectorAll('input');
  for (var i = 0; i < inputs.length; i++) {
    if (!inputs[i].offsetParent) continue;
    var val = (inputs[i].value||'').toLowerCase();
    var ph = (inputs[i].getAttribute('placeholder')||'').toLowerCase();
    if (!ph.includes('search')) {
      // Type name
      var nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSet.call(inputs[i], 'Alpha Kill Strategy v1');
      inputs[i].dispatchEvent(new Event('input', {bubbles:true}));
      break;
    }
  }
})()`);
await sleep(300);
await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
await sleep(1500);

// Check if saved (saveButton class should change from unsaved to saved)
const saveStatus = await evaluate(`(function(){
  var b = document.querySelector('[class*="saveButton-"]');
  return b ? b.className.substring(0,60) : 'no save btn';
})()`);
console.log('Save status:', saveStatus);

// Wait for save to fully complete (pending → saved)
let saveOk = false;
for (let i = 0; i < 25; i++) {
  const cls = await evaluate(`(function(){
    var b = document.querySelector('[class*="saveButton-"]');
    return b ? b.className : 'none';
  })()`);
  if (/saved-/.test(cls) && !/unsaved-|pending-/.test(cls)) { saveOk = true; break; }
  await sleep(800);
}
console.log('Save fully complete:', saveOk);

// Click Add/Update to chart
let addBtn = 'no add btn';
for (let i = 0; i < 10; i++) {
  addBtn = await evaluate(`(function(){
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (!b.offsetParent) continue;
      var title = b.getAttribute('title') || '';
      if (/^(Add to chart|Update on chart)$/i.test(title)) {
        b.click();
        return 'clicked: ' + title;
      }
    }
    return 'no add btn';
  })()`);
  if (!/no add btn/.test(addBtn)) break;
  await sleep(800);
}
console.log('Add to chart:', addBtn);
await sleep(6000);

// Open strategy tester with 'backtesting' widget
await evaluate(`window.TradingView.bottomWidgetBar.showWidget('backtesting')`);
await sleep(3000);

// Check if tester has data or if we need to "Load your strategy"
const testerCheck = await evaluate(`(function(){
  var el = document.querySelector('[class*="backtesting"]');
  if (!el) return 'no panel';
  var text = el.textContent.replace(/\s+/g,' ');
  if (/Total trades|Net profit/i.test(text)) return 'HAS_RESULTS';
  if (/Load your strategy/i.test(text)) return 'NEED_LOAD';
  return text.substring(0,100);
})()`);
console.log('Tester check:', testerCheck);

// If need to load, try My scripts
if (/NEED_LOAD/i.test(testerCheck)) {
  // Click "Load your strategy"
  await evaluate(`(function(){
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if (/load.your.strategy/i.test(btns[i].textContent) && btns[i].offsetParent) {
        btns[i].click(); return;
      }
    }
  })()`);
  await sleep(1500);

  // Click My scripts
  await evaluate(`(function(){
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      if (!all[i].offsetParent) continue;
      var own = '';
      all[i].childNodes.forEach(function(c) { if (c.nodeType===3) own+=c.textContent; });
      if (own.trim() === 'My scripts') { all[i].click(); return; }
    }
  })()`);
  await sleep(2000);

  // Find and click Alpha Kill Strategy v1
  const clickResult = await evaluate(`(function(){
    var items = document.querySelectorAll('[class*="title-"], [class*="cell-"], li, span');
    for (var i = 0; i < items.length; i++) {
      if (!items[i].offsetParent) continue;
      if (/alpha.kill/i.test(items[i].textContent)) {
        items[i].click();
        return 'clicked: ' + items[i].textContent.trim().substring(0,40);
      }
    }
    return 'alpha kill not found';
  })()`);
  console.log('Select script:', clickResult);
  await sleep(5000);
}

// Read final results
const results = await evaluate(`(function(){
  var el = document.querySelector('[class*="backtesting"]');
  if (!el) return 'no panel';
  return el.textContent.replace(/\s+/g,' ').substring(0, 1200);
})()`);
console.log('=== BACKTEST RESULTS ===');
console.log(results);
