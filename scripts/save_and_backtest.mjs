/**
 * Full clean flow:
 * 1. Close modal, switch to XAUUSD 5M
 * 2. Open Pine editor, inject code
 * 3. Save to TV cloud (Ctrl+S)
 * 4. Add to chart
 * 5. Open strategy tester, read results
 */
import { evaluate, getClient } from '../src/connection.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dir, '../scripts/current.pine'), 'utf-8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const client = await getClient();

// ── 0. Close any open modals ──────────────────────────────────────────────────
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, keyCode:27}))`);
await sleep(800);

// ── 1. Switch to XAUUSD 5M ────────────────────────────────────────────────────
const symResult = await evaluate(`(function(){
  try {
    var chart = window.TradingViewApi && window.TradingViewApi._activeChartWidgetWV && window.TradingViewApi._activeChartWidgetWV.value();
    if (!chart) return 'no-chart';
    if (typeof chart.setSymbol === 'function') {
      chart.setSymbol('OANDA:XAUUSD', '5', function(){});
      return 'setSymbol OANDA:XAUUSD 5M';
    }
    // Try alternative
    if (typeof chart.setChartResolution === 'function') chart.setChartResolution('5');
    return 'no setSymbol';
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Symbol switch:', symResult);
await sleep(2000);

// ── 2. Remove ALL strategies from chart ───────────────────────────────────────
const rmResult = await evaluate(`(function(){
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    var studies = chart.getAllStudies ? chart.getAllStudies() : [];
    var removed = 0;
    studies.forEach(function(s) {
      var name = (s.name || '').toLowerCase();
      if (/alpha|kill|strategy|strat/i.test(name)) {
        chart.removeEntity(s.id, {disableUndo:true});
        removed++;
      }
    });
    return 'removed:' + removed + ' of ' + studies.length;
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Remove strats:', rmResult);
await sleep(500);

// ── 3. Open Pine editor ───────────────────────────────────────────────────────
await evaluate(`(function(){
  var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
  if (bwb && typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
})()`);

let monacoReady = false;
for (let i = 0; i < 30; i++) {
  await sleep(300);
  monacoReady = await evaluate(`(function(){
    var c=document.querySelector('.monaco-editor.pine-editor-monaco');
    if(!c)return false;
    var el=c,fk;
    for(var i=0;i<20;i++){if(!el)break;fk=Object.keys(el).find(function(k){return k.startsWith('__reactFiber$')});if(fk)break;el=el.parentElement;}
    if(!fk)return false;
    var cur=el[fk];
    for(var d=0;d<15;d++){if(!cur)break;if(cur.memoizedProps&&cur.memoizedProps.value&&cur.memoizedProps.value.monacoEnv){var e=cur.memoizedProps.value.monacoEnv;if(e.editor&&e.editor.getEditors().length>0)return true;}cur=cur.return;}
    return false;
  })()`);
  if (monacoReady) break;
}
console.log('Monaco ready:', monacoReady);

// ── 4. Create a NEW script (not overwrite existing) ───────────────────────────
// Use pine_new equivalent: look for File > New > Strategy menu
const newScript = await evaluate(`(function(){
  try {
    // Find "New" or "+" button in the Pine editor header
    var headerBtns = document.querySelectorAll('[class*="pine"] button, [class*="editor"] button');
    var found = [];
    headerBtns.forEach(function(b) {
      if (!b.offsetParent) return;
      var text = (b.textContent||'').trim();
      var title = b.getAttribute('title') || '';
      var al = b.getAttribute('aria-label') || '';
      found.push(text + '|' + title + '|' + al);
    });
    return found.slice(0,10).join(' :: ');
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Editor buttons:', newScript);

// ── 5. Inject source code ─────────────────────────────────────────────────────
const escaped = JSON.stringify(src);
const injectResult = await evaluate(`(function(){
  var c=document.querySelector('.monaco-editor.pine-editor-monaco');
  if(!c)return 'no-monaco';
  var el=c,fk;
  for(var i=0;i<20;i++){if(!el)break;fk=Object.keys(el).find(function(k){return k.startsWith('__reactFiber$')});if(fk)break;el=el.parentElement;}
  if(!fk)return 'no-fiber';
  var cur=el[fk];
  for(var d=0;d<15;d++){
    if(!cur)break;
    if(cur.memoizedProps&&cur.memoizedProps.value&&cur.memoizedProps.value.monacoEnv){
      var env=cur.memoizedProps.value.monacoEnv;
      if(env.editor&&typeof env.editor.getEditors==='function'){
        var eds=env.editor.getEditors();
        if(eds.length>0){eds[0].setValue(${escaped});return 'injected:'+eds[0].getModel().getLineCount()+'lines';}
      }
    }
    cur=cur.return;
  }
  return 'inject-failed';
})()`);
console.log('Inject:', injectResult);
await sleep(500);

// ── 6. Save to cloud (Ctrl+S) ─────────────────────────────────────────────────
// First focus the Monaco editor
await evaluate(`(function(){
  var ed = document.querySelector('.monaco-editor.pine-editor-monaco');
  if (ed) ed.click();
})()`);
await sleep(200);
await client.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 's', code: 'KeyS' });
console.log('Ctrl+S sent');
await sleep(2000);

// Check if a save dialog appeared (for naming the script)
const saveDialog = await evaluate(`(function(){
  var dialogs = document.querySelectorAll('[role="dialog"], [class*="dialog"]');
  var found = [];
  dialogs.forEach(function(d) {
    if (d.offsetParent) found.push(d.textContent.trim().substring(0,100));
  });
  return found.join(' | ') || 'no dialog';
})()`);
console.log('Save dialog:', saveDialog);

// If dialog appeared asking for script name, type "Alpha Kill Strategy v1" and confirm
if (/name|title|save/i.test(saveDialog)) {
  await evaluate(`(function(){
    var inputs = document.querySelectorAll('[role="dialog"] input, [class*="dialog"] input');
    if (inputs.length > 0) {
      var nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSet.call(inputs[0], 'Alpha Kill Strategy v1');
      inputs[0].dispatchEvent(new Event('input', {bubbles:true}));
    }
  })()`);
  await sleep(300);
  await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  console.log('Typed name and confirmed');
  await sleep(2000);
}

// ── 7. Click "Add to chart" button ───────────────────────────────────────────
const addBtn = await evaluate(`(function(){
  var btns = document.querySelectorAll('button');
  for (var i = 0; i < btns.length; i++) {
    var b = btns[i];
    if (!b.offsetParent) continue;
    var title = b.getAttribute('title') || '';
    var text  = (b.textContent || '').trim();
    if (/^(Add to chart|Update on chart|Add indicator to chart)$/i.test(title) ||
        /^(Add to chart|Update on chart)$/i.test(text)) {
      b.click();
      return 'clicked: ' + (title || text).substring(0,30);
    }
  }
  return 'no-add-button';
})()`);
console.log('Add to chart:', addBtn);
await sleep(3000);

// ── 8. Check getAllStudies to confirm it's there ──────────────────────────────
const studiesAfter = await evaluate(`(function(){
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    var ss = chart.getAllStudies ? chart.getAllStudies() : [];
    return JSON.stringify(ss.map(function(s){ return s.name; }));
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Studies after add:', studiesAfter);

// ── 9. Open strategy tester ───────────────────────────────────────────────────
await evaluate(`(function(){
  var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
  if (bwb) bwb.showWidget('strategy-tester');
})()`);
await sleep(8000);

// ── 10. Read results ──────────────────────────────────────────────────────────
const domResult = await evaluate(`(function(){
  var el = document.querySelector('[class*="backtesting"]');
  if (!el) return 'panel not found';
  return el.textContent.replace(/\s+/g,' ').substring(0, 800);
})()`);
console.log('Tester DOM:');
console.log(domResult);
