/**
 * Ironclad backtest run 3 — robust Pine editor open + inject + read results
 */
import { evaluate, getClient } from '../src/connection.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir  = dirname(fileURLToPath(import.meta.url));
const src    = readFileSync(join(__dir, 'current.pine'), 'utf-8');
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const client = await getClient();

// ── 1. Switch to XAUUSD 15M ──
console.log('Setting XAUUSD 15M...');
await evaluate(`(function(){
  var a = window.TradingViewApi._activeChartWidgetWV.value();
  a.setSymbol('BLACKBULL:XAUUSD', null, true);
  a.setResolution('15');
})()`);
await sleep(4000);

// ── 2. Open Pine editor — try all methods ──
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,keyCode:27}))`);
await sleep(300);

// Method 1: activateScriptEditorTab
await evaluate(`(function(){
  try {
    var bwb = window.TradingView.bottomWidgetBar;
    if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
    else bwb.showWidget('pine-editor');
  } catch(e) { console.log('method1 err:', e.message); }
})()`);
await sleep(1500);

// Method 2: click Pine Script editor icon in the toolbar if still not open
const monacoCheck1 = await evaluate(`!!document.querySelector('.monaco-editor.pine-editor-monaco')`);
if (!monacoCheck1) {
  console.log('Monaco not found via method 1, trying toolbar click...');
  await evaluate(`(function(){
    // Try clicking "Pine Script Editor" button in bottom toolbar
    var btns = document.querySelectorAll('[data-name="pine-editor"], [aria-label*="Pine"], [title*="Pine"], [class*="pineEditor"]');
    for (var i=0; i<btns.length; i++) { if (btns[i].offsetParent) { btns[i].click(); return; } }
    // Fallback: look for "Pine Editor" text in bottom bar buttons
    var allBtns = document.querySelectorAll('button, [role="tab"]');
    for (var i=0; i<allBtns.length; i++) {
      var t = (allBtns[i].textContent||'') + (allBtns[i].getAttribute('title')||'') + (allBtns[i].getAttribute('aria-label')||'');
      if (/pine.?editor|pine.?script/i.test(t) && allBtns[i].offsetParent) { allBtns[i].click(); return; }
    }
  })()`);
  await sleep(1500);
}

// Method 3: keyboard shortcut Alt+P (TradingView default for Pine editor)
const monacoCheck2 = await evaluate(`!!document.querySelector('.monaco-editor.pine-editor-monaco')`);
if (!monacoCheck2) {
  console.log('Trying Alt+P keyboard shortcut...');
  await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: 1 });
  await client.Input.dispatchKeyEvent({ type: 'keyUp',   key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: 1 });
  await sleep(1500);
}

// ── 3. Wait for Monaco editor to be ready ──
let ready = false;
for (let i = 0; i < 60; i++) {
  await sleep(300);
  ready = await evaluate(`(function(){
    var c = document.querySelector('.monaco-editor.pine-editor-monaco');
    if (!c) return false;
    var el = c;
    for (var i = 0; i < 20; i++) {
      if (!el) break;
      var fk = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
      if (fk) {
        var cur = el[fk];
        for (var d = 0; d < 15; d++) {
          if (!cur) break;
          if (cur.memoizedProps && cur.memoizedProps.value && cur.memoizedProps.value.monacoEnv && cur.memoizedProps.value.monacoEnv.editor) return true;
          cur = cur.return;
        }
        break;
      }
      el = el.parentElement;
    }
    return false;
  })()`);
  if (ready) break;
}
console.log('Monaco ready:', ready);

if (!ready) {
  // Last resort: check what's visible in the bottom panel
  const bottomText = await evaluate(`(function(){
    var bwb = document.querySelector('[class*="bottomWidgetBar"], [class*="bottom-bar"]');
    return bwb ? bwb.textContent.trim().substring(0,200) : 'no bottom bar';
  })()`);
  console.log('Bottom bar text:', bottomText);
  throw new Error('Monaco editor not ready after 60 retries');
}

// ── 4. Inject code ──
const escaped = JSON.stringify(src);
const injected = await evaluate(`(function(){
  var c = document.querySelector('.monaco-editor.pine-editor-monaco');
  var el = c;
  for (var i = 0; i < 20; i++) {
    if (!el) break;
    var fk = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
    if (fk) {
      var cur = el[fk];
      for (var d = 0; d < 15; d++) {
        if (!cur) break;
        if (cur.memoizedProps && cur.memoizedProps.value && cur.memoizedProps.value.monacoEnv && cur.memoizedProps.value.monacoEnv.editor) {
          cur.memoizedProps.value.monacoEnv.editor.getEditors()[0].setValue(${escaped});
          return 'injected ' + cur.memoizedProps.value.monacoEnv.editor.getEditors()[0].getModel().getLineCount() + ' lines';
        }
        cur = cur.return;
      }
      break;
    }
    el = el.parentElement;
  }
  return 'inject-failed';
})()`);
console.log('Inject:', injected);
await sleep(500);

// ── 5. Save ──
const saveBtn = await evaluate(`(function(){
  var btns = document.querySelectorAll('button');
  for (var i = 0; i < btns.length; i++) {
    var b = btns[i];
    if (!b.offsetParent) continue;
    var cls = b.className || '', title = b.getAttribute('title') || '';
    if (cls.indexOf('saveButton-') !== -1 || title === 'Save script') { b.click(); return 'clicked: ' + title; }
  }
  return 'no save button';
})()`);
console.log('Save:', saveBtn);
await sleep(2000);

// Handle name dialog
await evaluate(`(function(){
  var inputs = document.querySelectorAll('input');
  for (var i = 0; i < inputs.length; i++) {
    if (!inputs[i].offsetParent) continue;
    var ph = (inputs[i].getAttribute('placeholder')||'').toLowerCase();
    if (!ph.includes('search')) {
      var ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      ns.call(inputs[i], 'Ironclad MTF Structure');
      inputs[i].dispatchEvent(new Event('input',{bubbles:true}));
      break;
    }
  }
})()`);
await sleep(300);
await client.Input.dispatchKeyEvent({type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
await client.Input.dispatchKeyEvent({type:'keyUp',key:'Enter',code:'Enter'});
await sleep(1500);

// Wait for save complete
let saveOk = false;
for (let i = 0; i < 25; i++) {
  const cls = await evaluate(`(function(){ var b=document.querySelector('[class*="saveButton-"]'); return b?b.className:'none'; })()`);
  if (/saved-/.test(cls) && !/unsaved-|pending-/.test(cls)) { saveOk = true; break; }
  await sleep(800);
}
console.log('Save OK:', saveOk);

// ── 6. Add/Update on chart ──
let addBtn = 'no add btn';
for (let i = 0; i < 15; i++) {
  addBtn = await evaluate(`(function(){
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (!b.offsetParent) continue;
      var title = b.getAttribute('title') || '';
      if (/^(Add to chart|Update on chart)$/i.test(title)) { b.click(); return 'clicked: '+title; }
    }
    return 'no add btn';
  })()`);
  if (!/no add btn/.test(addBtn)) break;
  await sleep(800);
}
console.log('Add to chart:', addBtn);
await sleep(8000);

// ── 7. Open strategy tester & read results ──
await evaluate(`window.TradingView.bottomWidgetBar.showWidget('backtesting')`);
await sleep(5000);

const results = await evaluate(`(function(){
  var el = document.querySelector('[class*="backtesting"]');
  if (!el) return 'no panel';
  return el.textContent.replace(/\s+/g,' ').substring(0,2000);
})()`);
console.log('=== IRONCLAD BACKTEST RESULTS ===');
console.log(results);
