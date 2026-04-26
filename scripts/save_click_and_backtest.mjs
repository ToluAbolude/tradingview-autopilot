/**
 * Save alpha kill via the save button (not Ctrl+S), then add to chart,
 * then load in strategy tester from "My scripts".
 */
import { evaluate, getClient } from '../src/connection.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dir, '../scripts/current.pine'), 'utf-8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const client = await getClient();

// Close any open modals
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, keyCode:27}))`);
await sleep(500);

// Ensure Pine editor is open
await evaluate(`(function(){
  var bwb = window.TradingView.bottomWidgetBar;
  if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
})()`);
await sleep(1000);

// Inject alpha kill code
const escaped = JSON.stringify(src);
await evaluate(`(function(){
  var c = document.querySelector('.monaco-editor.pine-editor-monaco');
  var el = c, fk;
  for (var i = 0; i < 20; i++) { if (!el) break; fk = Object.keys(el).find(k => k.startsWith('__reactFiber$')); if (fk) break; el = el.parentElement; }
  var cur = el[fk];
  for (var d = 0; d < 15; d++) {
    if (!cur) break;
    if (cur.memoizedProps?.value?.monacoEnv?.editor) {
      cur.memoizedProps.value.monacoEnv.editor.getEditors()[0].setValue(${escaped});
      return;
    }
    cur = cur.return;
  }
})()`);
await sleep(500);
console.log('Injected alpha kill code');

// ── STEP 1: Click the "Save script" button directly ──────────────────────────
const saveClick = await evaluate(`(function(){
  var btns = document.querySelectorAll('button');
  for (var i = 0; i < btns.length; i++) {
    var b = btns[i];
    if (!b.offsetParent) continue;
    var title = b.getAttribute('title') || '';
    var cls = b.className || '';
    if (title === 'Save script' || cls.indexOf('saveButton-') !== -1) {
      b.click();
      return 'clicked save: title=' + title + ' cls=' + cls.substring(0,40);
    }
  }
  return 'save button not found';
})()`);
console.log('Save click:', saveClick);
await sleep(2000);

// Check for save dialog
const saveDialog = await evaluate(`(function(){
  // Look for a "Save as" dialog with an input for script name
  var inputs = document.querySelectorAll('input[type="text"], input:not([type])');
  var dialogs = [];
  for (var i = 0; i < inputs.length; i++) {
    if (inputs[i].offsetParent) {
      var val = inputs[i].value || '';
      var placeholder = inputs[i].getAttribute('placeholder') || '';
      dialogs.push('val=' + val.substring(0,40) + ' ph=' + placeholder.substring(0,40));
    }
  }
  return dialogs.join(' | ') || 'no inputs visible';
})()`);
console.log('Save dialog inputs:', saveDialog);

// If dialog appeared, type the name and confirm
if (!/no inputs/i.test(saveDialog)) {
  // Set the script name to "Alpha Kill Strategy v1"
  await evaluate(`(function(){
    var inputs = document.querySelectorAll('input[type="text"], input:not([type])');
    for (var i = 0; i < inputs.length; i++) {
      if (!inputs[i].offsetParent) continue;
      var nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSet.call(inputs[i], 'Alpha Kill Strategy v1');
      inputs[i].dispatchEvent(new Event('input', {bubbles:true}));
      break;
    }
  })()`);
  await sleep(300);
  await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  console.log('Typed name "Alpha Kill Strategy v1" and confirmed');
  await sleep(2000);
}

// Check save status
const saveStatus = await evaluate(`(function(){
  var btns = document.querySelectorAll('[class*="saveButton-"]');
  var status = [];
  btns.forEach(function(b) {
    if (b.offsetParent) status.push(b.className.substring(0,60) + ' title=' + (b.getAttribute('title')||''));
  });
  return status.join(' | ') || 'no save button';
})()`);
console.log('Save status:', saveStatus);

// ── STEP 2: Click "Add to chart" ──────────────────────────────────────────────
const addBtn = await evaluate(`(function(){
  var btns = document.querySelectorAll('button');
  for (var i = 0; i < btns.length; i++) {
    var b = btns[i];
    if (!b.offsetParent) continue;
    var title = b.getAttribute('title') || '';
    var text = (b.textContent||'').trim();
    if (/^(Add to chart|Update on chart)$/i.test(title)) {
      b.click();
      return 'clicked: ' + title;
    }
  }
  return 'no add button';
})()`);
console.log('Add to chart:', addBtn);
await sleep(4000);

// ── STEP 3: Open strategy tester ──────────────────────────────────────────────
await evaluate(`(function(){
  var bwb = window.TradingView.bottomWidgetBar;
  bwb.showWidget('backtesting');
})()`);
await sleep(2000);

// Check tester state
const testerState = await evaluate(`(function(){
  var el = document.querySelector('[class*="backtesting"]');
  if (!el) return 'no panel';
  var text = el.textContent.replace(/\s+/g,' ');
  if (/Total trades|Net profit|Percent profitable/i.test(text)) return 'HAS RESULTS: ' + text.substring(0,500);
  return 'Empty state: ' + text.substring(0,300);
})()`);
console.log('Tester state:', testerState);

// ── STEP 4: If still empty, try "Load your strategy" → My scripts ─────────────
if (!/HAS RESULTS/i.test(testerState)) {
  console.log('Tester empty, trying Load your strategy -> My scripts...');

  // Click "Load your strategy"
  await evaluate(`(function(){
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].offsetParent && /load.your.strategy/i.test(btns[i].textContent)) {
        btns[i].click();
        return;
      }
    }
  })()`);
  await sleep(1500);

  // Click "My scripts" in the modal
  await evaluate(`(function(){
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!el.offsetParent) continue;
      if (el.textContent.trim() === 'My scripts' && /listItem|category|tab/i.test(el.className||'')) {
        el.click();
        return;
      }
    }
    // fallback: any element with exact text
    for (var j = 0; j < all.length; j++) {
      var e = all[j];
      if (!e.offsetParent) continue;
      var children = e.childNodes;
      var text = '';
      children.forEach(function(c) { if (c.nodeType === 3) text += c.textContent; });
      if (text.trim() === 'My scripts') { e.click(); return; }
    }
  })()`);
  await sleep(2000);

  // Check what My scripts shows
  const myScriptsContent = await evaluate(`(function(){
    var wrapper = document.querySelector('[class*="wrapper-b8SxMnzX"]');
    if (!wrapper) return 'no modal';
    return wrapper.textContent.replace(/\s+/g,' ').substring(0,300);
  })()`);
  console.log('My scripts after save:', myScriptsContent);

  // Try to find and click Alpha Kill / Checklist Reversal
  await evaluate(`(function(){
    var items = document.querySelectorAll('[class*="title-cIIj4HrJ"], [class*="cell-"], li');
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      if (!el.offsetParent) continue;
      if (/alpha.kill|checklist.reversal/i.test(el.textContent)) {
        el.click();
        return;
      }
    }
  })()`);
  await sleep(3000);

  // Final read
  const finalResult = await evaluate(`(function(){
    var el = document.querySelector('[class*="backtesting"]');
    if (!el) return 'no panel';
    var text = el.textContent.replace(/\s+/g,' ');
    return text.substring(0,600);
  })()`);
  console.log('Final tester result:', finalResult);
}
