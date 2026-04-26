/**
 * Minimal HA-only strategy. If this gives 0 trades on XAUUSD 5M Feb-Apr 2026,
 * the EMA filter or HA condition itself never fires (data issue).
 * If this gives trades, Alpha Kill has a logic/state bug.
 */
import { evaluate, getClient } from "../src/connection.js";
const sleep = ms => new Promise(r => setTimeout(r, ms));

const src = `//@version=6
strategy("AK_HA_Test", overlay=true,
         default_qty_type=strategy.percent_of_equity, default_qty_value=1.0,
         initial_capital=10000, calc_on_every_tick=false)

_ema21 = ta.ema(close, 21)
_ema50 = ta.ema(close, 50)
_atr   = ta.atr(14)

_ha_close = (open + high + low + close) / 4
var float _ha_open = na
_ha_open := na(_ha_open[1]) ? (open + close) / 2 : (_ha_open[1] + _ha_close[1]) / 2

_ha_bull = _ha_close > _ha_open and _ha_close[1] <= _ha_open[1]
_ha_bear = _ha_close < _ha_open and _ha_close[1] >= _ha_open[1]

if _ha_bull and close > _ema21 and close > _ema50 and strategy.position_size == 0
    strategy.entry("L", strategy.long)
    strategy.exit("LX", "L", stop=close - _atr*1.5, limit=close + _atr*3.0)

if _ha_bear and close < _ema21 and close < _ema50 and strategy.position_size == 0
    strategy.entry("S", strategy.short)
    strategy.exit("SX", "S", stop=close + _atr*1.5, limit=close - _atr*3.0)
`;

// Open Pine editor and inject
const openResult = await evaluate(`(function(){
  var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
  if (bwb && typeof bwb.activateScriptEditorTab === 'function') { bwb.activateScriptEditorTab(); return 'ok'; }
  return 'no-bwb';
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
console.log('Monaco ready:', ready);

const escaped = JSON.stringify(src);
const inj = await evaluate(`(function(){
  var c=document.querySelector('.monaco-editor.pine-editor-monaco');
  if(!c)return 'no-monaco';
  var el=c,fk;
  for(var i=0;i<20;i++){if(!el)break;fk=Object.keys(el).find(k=>k.startsWith('__reactFiber$'));if(fk)break;el=el.parentElement;}
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
console.log('Inject:', inj);
await sleep(500);

const c = await getClient();
await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
console.log('Ctrl+Enter sent');

// Wait for backtest
console.log('Waiting 60s for backtest...');
await sleep(60000);

// Read raw DOM
const dom = await evaluate(`(function(){
  var el = document.querySelector('[class*="backtesting"]');
  if (!el) return 'panel not found';
  return el.textContent.replace(/\\s+/g, ' ').substring(0, 300);
})()`);
console.log('DOM:', dom);
