/**
 * Inject a minimal test strategy and check if it generates trades.
 * If this works → Alpha Kill has a logic bug.
 * If this also shows 0 trades → TradingView API read is the issue.
 */
import { evaluate, getClient } from '../src/connection.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const src = `//@version=6
strategy("AK_Simple_Test", overlay=true, calc_on_every_tick=false,
         default_qty_type=strategy.percent_of_equity, default_qty_value=1.0,
         initial_capital=10000)

_ema21 = ta.ema(close, 21)
_ema50 = ta.ema(close, 50)
_atr   = ta.atr(14)

if ta.crossover(_ema21, _ema50) and strategy.position_size == 0
    strategy.entry("L", strategy.long)
    strategy.exit("L_X", "L", stop=close - _atr*1.5, limit=close + _atr*3.0)

if ta.crossunder(_ema21, _ema50) and strategy.position_size == 0
    strategy.entry("S", strategy.short)
    strategy.exit("S_X", "S", stop=close + _atr*1.5, limit=close - _atr*3.0)
`;

// Open Pine editor
const openResult = await evaluate(`(function(){
  try {
    var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
    if (bwb && typeof bwb.activateScriptEditorTab === 'function') {
      bwb.activateScriptEditorTab(); return 'ok';
    }
    return 'no-bwb';
  } catch(e) { return 'err:'+e.message; }
})()`);
console.log('Open:', openResult);

// Wait for Monaco
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

// Inject source
const escaped = JSON.stringify(src);
const injectResult = await evaluate(`(function(){
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
console.log('Inject:', injectResult);
await sleep(500);

// Click Add to chart or send Ctrl+Enter
const c = await getClient();
await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
console.log('Ctrl+Enter sent');

// Wait for backtest to run
await sleep(8000);

// Read result
const result = await evaluate(`(function(){
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var src = chart.model().model().dataSources();
    for (var i = 0; i <= Math.max(src.length, 100); i++) {
      var s = src[i];
      if (!s || !s.metaInfo) continue;
      try {
        var m = s.metaInfo();
        if ((m.description || '').indexOf('AK_Simple_Test') < 0) continue;
        var rd = s.reportData ? (typeof s.reportData === 'function' ? s.reportData() : s.reportData) : null;
        if (rd && typeof rd.value === 'function') rd = rd.value();
        var trades = rd && rd.trades ? rd.trades.length : -1;
        var perf = rd && rd.performance && rd.performance.all ? rd.performance.all : {};
        return JSON.stringify({ source: i, trades: trades, totalTrades: perf.totalTrades, wr: perf.percentProfitable });
      } catch(e) {}
    }
    return 'AK_Simple_Test not found';
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Result:', result);
