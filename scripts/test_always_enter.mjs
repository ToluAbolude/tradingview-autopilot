/**
 * ABSOLUTE MINIMUM: enter every bar with no conditions.
 * If this gives 0 trades → TradingView/BlackBull fundamental issue.
 * If this gives trades → EMA/HA filter is blocking Alpha Kill entries.
 */
import { evaluate, getClient } from "../src/connection.js";
const sleep = ms => new Promise(r => setTimeout(r, ms));

const src = `//@version=6
strategy("AK_Always", overlay=true,
         default_qty_type=strategy.percent_of_equity, default_qty_value=1.0,
         initial_capital=10000, calc_on_every_tick=false)

_atr = ta.atr(14)

// Enter EVERY bar with no conditions — just position=0 guard
if strategy.position_size == 0
    strategy.entry("L", strategy.long)
    strategy.exit("LX", "L", stop=close - _atr, limit=close + _atr*2)
`;

const openResult = await evaluate(`(function(){
  var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
  if (bwb && typeof bwb.activateScriptEditorTab === 'function') { bwb.activateScriptEditorTab(); return 'ok'; }
  return 'no';
})()`);
console.log('Open:', openResult);

let ready = false;
for (let i = 0; i < 30; i++) {
  await sleep(300);
  ready = await evaluate(`(function(){
    var c=document.querySelector('.monaco-editor.pine-editor-monaco');
    if(!c)return false;
    var el=c,fk;
    for(var j=0;j<20;j++){if(!el)break;fk=Object.keys(el).find(k=>k.startsWith('__reactFiber$'));if(fk)break;el=el.parentElement;}
    if(!fk)return false;
    var cur=el[fk];
    for(var d=0;d<15;d++){if(!cur)break;if(cur.memoizedProps&&cur.memoizedProps.value&&cur.memoizedProps.value.monacoEnv){var e=cur.memoizedProps.value.monacoEnv;if(e.editor&&e.editor.getEditors().length>0)return true;}cur=cur.return;}
    return false;
  })()`);
  if (ready) break;
}

const escaped = JSON.stringify(src);
await evaluate(`(function(){
  var c=document.querySelector('.monaco-editor.pine-editor-monaco');
  if(!c)return;
  var el=c,fk;
  for(var i=0;i<20;i++){if(!el)break;fk=Object.keys(el).find(k=>k.startsWith('__reactFiber$'));if(fk)break;el=el.parentElement;}
  if(!fk)return;
  var cur=el[fk];
  for(var d=0;d<15;d++){
    if(!cur)break;
    if(cur.memoizedProps&&cur.memoizedProps.value&&cur.memoizedProps.value.monacoEnv){
      var env=cur.memoizedProps.value.monacoEnv;
      if(env.editor&&typeof env.editor.getEditors==='function'){
        var eds=env.editor.getEditors();
        if(eds.length>0){eds[0].setValue(${escaped});return;}
      }
    }
    cur=cur.return;
  }
})()`);
console.log('Injected');
await sleep(500);

const c = await getClient();
await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
console.log('Ctrl+Enter sent');

console.log('Waiting 60s...');
await sleep(60000);

const dom = await evaluate(`(function(){
  var el = document.querySelector('[class*="backtesting"]');
  if (!el) return 'panel not found';
  return el.textContent.replace(/\\s+/g, ' ').substring(0, 400);
})()`);
console.log('DOM:', dom);
