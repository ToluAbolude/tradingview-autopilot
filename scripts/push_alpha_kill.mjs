/**
 * Push alpha_kill_v1.pine to TradingView, compile, add/update on chart.
 */
import { evaluate } from '../src/connection.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dir, '../scripts/current.pine'), 'utf-8');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 1. Open Pine editor ──────────────────────────────────────────────────────
const openResult = await evaluate("(function(){ var b=document.querySelector('[data-name=\"pine-dialog-button\"]'); if(b){b.click();return 'opened';} var b2=document.querySelector('[data-name=\"pine-editor-btn\"]'); if(b2){b2.click();return 'opened2';} return 'not-found'; })()");
console.log('Pine editor:', openResult);
await sleep(1500);

// ── 2. Inject source ─────────────────────────────────────────────────────────
const escaped = JSON.stringify(src);
const setResult = await evaluate(`(function(){
  var c=document.querySelector(".monaco-editor.pine-editor-monaco");
  if(!c)return "no-monaco";
  var el=c,fk;
  for(var i=0;i<20;i++){if(!el)break;fk=Object.keys(el).find(function(k){return k.startsWith("__reactFiber$")});if(fk)break;el=el.parentElement;}
  if(!fk)return "no-fiber";
  var cur=el[fk];
  for(var d=0;d<15;d++){
    if(!cur)break;
    if(cur.memoizedProps&&cur.memoizedProps.value&&cur.memoizedProps.value.monacoEnv){
      var env=cur.memoizedProps.value.monacoEnv;
      if(env.editor&&typeof env.editor.getEditors==="function"){
        var eds=env.editor.getEditors();
        if(eds.length>0){eds[0].setValue(${escaped});return "set:"+eds.length;}
      }
    }
    cur=cur.return;
  }
  return "not-set";
})()`);
console.log('Source inject:', setResult);
await sleep(800);

// ── 3. Click Add to chart / Update on chart ──────────────────────────────────
const clickResult = await evaluate(`(function(){
  // TreeWalker approach — checks title AND textContent AND aria-label
  var walker=document.createTreeWalker(document.body,NodeFilter.SHOW_ELEMENT);
  var node;
  while((node=walker.nextNode())){
    if(node.tagName==='BUTTON'||node.getAttribute('role')==='button'){
      var t=(node.getAttribute('title')||'')+(node.textContent||'')+(node.getAttribute('aria-label')||'');
      if(/add to chart|update.*chart|save.*chart/i.test(t)&&node.offsetParent!==null){
        node.click();
        return 'clicked:'+t.substring(0,40);
      }
    }
  }
  // Fallback: Ctrl+Enter keyboard shortcut to compile + add
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',ctrlKey:true,bubbles:true}));
  return 'keyboard-fallback';
})()`);
console.log('Add to chart:', clickResult);
await sleep(3000);

// ── 4. Check errors ──────────────────────────────────────────────────────────
const errors = await evaluate(`(function(){
  var c=document.querySelector(".monaco-editor.pine-editor-monaco");
  if(!c)return[];
  var el=c,fk;
  for(var i=0;i<20;i++){if(!el)break;fk=Object.keys(el).find(function(k){return k.startsWith("__reactFiber$")});if(fk)break;el=el.parentElement;}
  if(!fk)return[];
  var cur=el[fk];
  for(var d=0;d<15;d++){
    if(!cur)break;
    if(cur.memoizedProps&&cur.memoizedProps.value&&cur.memoizedProps.value.monacoEnv){
      var env=cur.memoizedProps.value.monacoEnv;
      if(env.editor&&typeof env.editor.getEditors==="function"){
        var eds=env.editor.getEditors();
        if(eds.length>0){var m=eds[0].getModel();var mk=env.editor.getModelMarkers({resource:m.uri});return mk.map(function(x){return{line:x.startLineNumber,msg:x.message};});}
      }
    }
    cur=cur.return;
  }
  return[];
})`);

if (!errors || errors.length === 0) {
  console.log('Compiled: 0 errors');
} else {
  console.log('Errors:', errors.length);
  errors.forEach(e => console.log('  Line', e.line + ':', e.msg));
}

// ── 5. Read backtest results ─────────────────────────────────────────────────
await sleep(4000);
const stats = await evaluate("(function(){ var el=document.querySelector('[class*=backtestingReport],[data-name=strategy-tester]'); if(!el) return 'no-panel'; var t=el.textContent; return 'total='+(t.match(/Total trades\\s*(\\d+)/)||['','?'])[1]+' wr='+(t.match(/Percent profitable\\s*([\\d.]+%?)/)||['','?'])[1]+' pnl='+(t.match(/Net P.L\\s*([-\\d,.]+)/)||['','?'])[1]; })()");
console.log('Backtest:', stats);
