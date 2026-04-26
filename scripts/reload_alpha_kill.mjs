/**
 * Use TradingView internal API to:
 * 1. Find and remove existing AK_v1 strategy from chart
 * 2. Open Pine editor and inject new source
 * 3. Use Ctrl+Enter keyboard shortcut to compile + add to chart
 */
import { evaluate, getClient } from '../src/connection.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dir, '../scripts/current.pine'), 'utf-8');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 1. Remove existing AK_v1 from chart ──────────────────────────────────────
const removeResult = await evaluate(`(function(){
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    var studies = chart.getAllStudies ? chart.getAllStudies() : [];
    var removed = [];
    for (var i = 0; i < studies.length; i++) {
      var s = studies[i];
      var name = (s.name||s.metaInfo&&s.metaInfo().shortTitle||'').toLowerCase();
      if (/alpha.kill|ak_v/i.test(name)) {
        chart.removeEntity(s.id, {disableUndo:true});
        removed.push(name);
      }
    }
    return 'removed:' + removed.length + ' (' + removed.join(',') + ')';
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Remove:', removeResult);
await sleep(500);

// ── 2. Open Pine editor via TradingView bottom bar ────────────────────────────
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

// Wait for Monaco to be ready
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

// ── 3. Inject source ──────────────────────────────────────────────────────────
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

// ── 4. Compile: try button first, then Ctrl+Enter keyboard shortcut ──────────
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
console.log('Button:', btnResult);

// Always also try keyboard shortcut as backup
const c = await getClient();
await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
console.log('Ctrl+Enter sent');
await sleep(3000);

// ── 5. Check for errors ───────────────────────────────────────────────────────
const errors = await evaluate(`(function(){
  var c=document.querySelector('.monaco-editor.pine-editor-monaco');
  if(!c)return[];
  var el=c,fk;
  for(var i=0;i<20;i++){if(!el)break;fk=Object.keys(el).find(function(k){return k.startsWith('__reactFiber$')});if(fk)break;el=el.parentElement;}
  if(!fk)return[];
  var cur=el[fk];
  for(var d=0;d<15;d++){if(!cur)break;if(cur.memoizedProps&&cur.memoizedProps.value&&cur.memoizedProps.value.monacoEnv){var e=cur.memoizedProps.value.monacoEnv;if(e.editor&&e.editor.getEditors().length>0){var m=e.editor.getEditors()[0].getModel();var mk=e.editor.getModelMarkers({resource:m.uri});return mk.map(function(x){return x.startLineNumber+':'+x.message;});}}cur=cur.return;}
  return[];
})()`);

if (!errors || errors.length === 0) {
  console.log('Compiled: 0 errors');
} else {
  console.log('Errors:', errors);
}

// ── 6. Wait then read backtest stats ─────────────────────────────────────────
await sleep(5000);
const stats = await evaluate(`(function(){
  var el=document.querySelector('[class*=backtestingReport]')||document.querySelector('[data-name=strategy-tester]');
  if(!el) return 'no-panel';
  var t=el.textContent;
  var tot=(t.match(/Total trades\\s*(\\d+)/)||['','?'])[1];
  var wr=(t.match(/Percent profitable\\s*([\\d.]+)/)||['','?'])[1];
  var pnl=(t.match(/Net P[^\\d]*([-\\d,.]+)/)||['','?'])[1];
  return 'total='+tot+' wr='+wr+'% pnl='+pnl;
})()`);
console.log('Backtest:', stats);
