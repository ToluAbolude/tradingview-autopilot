/**
 * Backtest: Ironclad MTF Market Structure
 * Chart: BLACKBULL:XAUUSD, 15M (LTF per strategy design)
 * HTF: Daily (set in Pine inputs)
 */
import { evaluate, getClient } from '../src/connection.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const src   = readFileSync(join(__dir, 'current.pine'), 'utf-8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const client = await getClient();

// ── 1. Switch chart to XAUUSD 15M ──
console.log('Setting chart: BLACKBULL:XAUUSD 15M...');
await evaluate(`(function(){
  var a = window.TradingViewApi._activeChartWidgetWV.value();
  a.setSymbol('BLACKBULL:XAUUSD', null, true);
  a.setResolution('15');
})()`);
await sleep(4000);

// ── 2. Close any modal ──
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,keyCode:27}))`);
await sleep(500);

// ── 3. Open Pine editor ──
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
    for (var i = 0; i < 20; i++) { if (!el) break; fk = Object.keys(el).find(k=>k.startsWith('__reactFiber$')); if (fk) break; el = el.parentElement; }
    var cur = el[fk];
    for (var d = 0; d < 15; d++) { if (!cur) break; if (cur.memoizedProps?.value?.monacoEnv?.editor) return true; cur = cur.return; }
    return false;
  })()`);
  if (ready) break;
}
console.log('Monaco ready:', ready);

// ── 4. Inject code ──
const escaped = JSON.stringify(src);
const injected = await evaluate(`(function(){
  var c = document.querySelector('.monaco-editor.pine-editor-monaco');
  var el = c, fk;
  for (var i = 0; i < 20; i++) { if (!el) break; fk = Object.keys(el).find(k=>k.startsWith('__reactFiber$')); if (fk) break; el = el.parentElement; }
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

// ── 5. Save ──
const saveBtn = await evaluate(`(function(){
  var btns = document.querySelectorAll('button');
  for (var i = 0; i < btns.length; i++) {
    var b = btns[i];
    if (!b.offsetParent) continue;
    var cls = b.className || '';
    var title = b.getAttribute('title') || '';
    if (cls.indexOf('saveButton-') !== -1 || title === 'Save script') { b.click(); return 'clicked: ' + title; }
  }
  return 'no save button';
})()`);
console.log('Save:', saveBtn);
await sleep(2000);

// Handle name dialog if appears
await evaluate(`(function(){
  var inputs = document.querySelectorAll('input');
  for (var i = 0; i < inputs.length; i++) {
    if (!inputs[i].offsetParent) continue;
    var ph = (inputs[i].getAttribute('placeholder')||'').toLowerCase();
    if (!ph.includes('search')) {
      var nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      nativeSet.call(inputs[i], 'Ironclad MTF Structure');
      inputs[i].dispatchEvent(new Event('input',{bubbles:true}));
      break;
    }
  }
})()`);
await sleep(300);
await client.Input.dispatchKeyEvent({type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
await client.Input.dispatchKeyEvent({type:'keyUp',  key:'Enter',code:'Enter'});
await sleep(1500);

// Wait for save to complete (pending → saved)
let saveOk = false;
for (let i = 0; i < 25; i++) {
  const cls = await evaluate(`(function(){
    var b = document.querySelector('[class*="saveButton-"]');
    return b ? b.className : 'none';
  })()`);
  if (/saved-/.test(cls) && !/unsaved-|pending-/.test(cls)) { saveOk = true; break; }
  await sleep(800);
}
console.log('Save complete:', saveOk);

// ── 6. Add/Update on chart ──
let addBtn = 'no add btn';
for (let i = 0; i < 10; i++) {
  addBtn = await evaluate(`(function(){
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (!b.offsetParent) continue;
      var title = b.getAttribute('title') || '';
      if (/^(Add to chart|Update on chart)$/i.test(title)) { b.click(); return 'clicked: ' + title; }
    }
    return 'no add btn';
  })()`);
  if (!/no add btn/.test(addBtn)) break;
  await sleep(800);
}
console.log('Add to chart:', addBtn);
await sleep(8000);

// ── 7. Open strategy tester ──
await evaluate(`window.TradingView.bottomWidgetBar.showWidget('backtesting')`);
await sleep(4000);

// ── 8. Read results ──
const results = await evaluate(`(function(){
  var el = document.querySelector('[class*="backtesting"]');
  if (!el) return 'no panel';
  return el.textContent.replace(/\s+/g,' ').substring(0, 2000);
})()`);
console.log('=== IRONCLAD BACKTEST RESULTS ===');
console.log(results);
