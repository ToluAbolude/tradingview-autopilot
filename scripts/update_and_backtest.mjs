/**
 * Update Alpha Kill on chart WITHOUT removing first.
 * This keeps the Strategy Tester linked so results appear.
 */
import { evaluate, getClient } from '../src/connection.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dir, '../scripts/current.pine'), 'utf-8');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 1. Open Pine editor ───────────────────────────────────────────────────────
const openResult = await evaluate(`(function(){
  try {
    var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
    if (bwb) {
      if (typeof bwb.activateScriptEditorTab === 'function') { bwb.activateScriptEditorTab(); return 'activateScriptEditorTab'; }
      if (typeof bwb.showWidget === 'function') { bwb.showWidget('pine-editor'); return 'showWidget'; }
    }
    var btn = document.querySelector('[data-name="pine-dialog-button"]') || document.querySelector('[aria-label="Pine"]');
    if (btn) { btn.click(); return 'btn-click'; }
    return 'not-found';
  } catch(e) { return 'err:'+e.message; }
})()`);
console.log('Open editor:', openResult);

// Wait for Monaco
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

// ── 2. Inject source ──────────────────────────────────────────────────────────
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

// ── 3. Check button state before clicking ─────────────────────────────────────
const btnState = await evaluate(`(function(){
  var btns = document.querySelectorAll('button');
  var found = [];
  for (var i = 0; i < btns.length; i++) {
    var b = btns[i];
    if (!b.offsetParent) continue;
    var title = b.getAttribute('title') || '';
    var text  = (b.textContent || '').trim();
    if (/add.to.chart|update.on.chart|add.indicator/i.test(title + text)) {
      found.push('title=' + title + ' text=' + text.substring(0,20));
    }
  }
  return found.join(' | ') || 'no compile button found';
})()`);
console.log('Button state:', btnState);

// ── 4. Click "Update on chart" ────────────────────────────────────────────────
const btnResult = await evaluate(`(function(){
  var btns = document.querySelectorAll('button');
  for (var i = 0; i < btns.length; i++) {
    var b = btns[i];
    if (!b.offsetParent) continue;
    var title = b.getAttribute('title') || '';
    var text  = (b.textContent || '').trim();
    if (/^(Add to chart|Update on chart|Add indicator to chart)$/i.test(title) ||
        /^(Add to chart|Update on chart)$/i.test(text)) {
      b.click();
      return 'clicked: title=' + title + ' text=' + text.substring(0,30);
    }
  }
  return 'no-button-found';
})()`);
console.log('Button click:', btnResult);

// Ctrl+Enter as backup
const c = await getClient();
await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
console.log('Ctrl+Enter sent');
await sleep(2000);

// ── 5. Open strategy tester ───────────────────────────────────────────────────
const testerOpen = await evaluate(`(function(){
  try {
    var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
    if (bwb && typeof bwb.showWidget === 'function') {
      bwb.showWidget('strategy-tester');
      return 'showWidget:strategy-tester';
    }
    // Try clicking the strategy tester tab button
    var btns = document.querySelectorAll('button, [role="tab"]');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var dn = b.getAttribute('data-name') || '';
      var al = b.getAttribute('aria-label') || '';
      var tt = b.getAttribute('title') || '';
      if (/backt|strategy.test/i.test(dn + al + tt)) {
        b.click();
        return 'clicked: ' + (dn || al || tt);
      }
    }
    return 'not-found';
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Open tester:', testerOpen);
await sleep(5000);

// ── 6. Read DOM results ───────────────────────────────────────────────────────
const dom = await evaluate(`(function(){
  try {
    var selectors = ['[class*="backtesting"]', '[class*="strategyTester"]', '[class*="strategy-tester"]'];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el && el.textContent.trim().length > 30) {
        var t = el.textContent.replace(/\\s+/g, ' ');
        return selectors[i] + ': ' + t.substring(0, 800);
      }
    }
    return 'panel not found';
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Strategy Tester DOM:');
console.log(dom);
