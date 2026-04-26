/**
 * Clean reload: remove ALL strategies from chart, add only Alpha Kill,
 * wait 45s for full backtest calculation, then read stats via DOM.
 */
import { evaluate, getClient } from "../src/connection.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dir, "current.pine"), "utf-8");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 1. Remove ALL strategies from chart ───────────────────────────────────────
const removeAll = await evaluate(`(function(){
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    var studies = chart.getAllStudies ? chart.getAllStudies() : [];
    var removed = [];
    for (var i = 0; i < studies.length; i++) {
      var s = studies[i];
      var name = (s.name || '').toLowerCase();
      if (/strategy|alpha.kill|ak_v|okala|simple.test|riley|jooviers|tori|desiano/i.test(name)) {
        chart.removeEntity(s.id, { disableUndo: true });
        removed.push(s.name || '?');
      }
    }
    return 'removed ' + removed.length + ': ' + removed.join(', ');
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Remove all strategies:', removeAll);
await sleep(1000);

// ── 2. Open Pine editor ───────────────────────────────────────────────────────
const openResult = await evaluate(`(function(){
  try {
    var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
    if (bwb && typeof bwb.activateScriptEditorTab === 'function') {
      bwb.activateScriptEditorTab(); return 'ok';
    }
    return 'no-bwb';
  } catch(e) { return 'err:'+e.message; }
})()`);
console.log('Open editor:', openResult);

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

// ── 3. Inject source ──────────────────────────────────────────────────────────
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

// ── 4. Add to chart (click button first, fallback Ctrl+Enter) ─────────────────
const btnResult = await evaluate(`(function(){
  var btns = document.querySelectorAll('button');
  for (var i = 0; i < btns.length; i++) {
    var t = btns[i].textContent.trim();
    if (/^(Add to chart|Update on chart|Add indicator to chart)$/i.test(t) && btns[i].offsetParent) {
      btns[i].click(); return 'clicked:' + t;
    }
  }
  // Try aria-label buttons
  var ariaBtn = document.querySelector('button[aria-label*="Add to chart"], button[aria-label*="add to chart"]');
  if (ariaBtn) { ariaBtn.click(); return 'aria-click'; }
  return 'no-button';
})()`);
console.log('Button:', btnResult);

const c = await getClient();
await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
console.log('Ctrl+Enter sent');

// ── 5. Wait for full backtest calculation (45 seconds) ────────────────────────
console.log('Waiting 45s for backtest to calculate...');
await sleep(45000);

// ── 6. Read stats from DOM ────────────────────────────────────────────────────
const stats = await evaluate(`(function(){
  try {
    var el = document.querySelector('[class*="backtesting"]') ||
             document.querySelector('[data-name="strategy-tester"]');
    if (!el) return JSON.stringify({ error: 'panel not found' });
    var t = el.textContent || '';

    function getVal(label) {
      var idx = t.indexOf(label);
      if (idx < 0) return null;
      var after = t.slice(idx + label.length, idx + label.length + 60).trim();
      var m = after.match(/^([\-\d,\.]+)/);
      return m ? m[1] : null;
    }

    return JSON.stringify({
      strategyName: t.substring(0, 30),
      period:       (t.match(/(\w+ \d+, \d{4}.*?\d{4})/) || [,'?'])[1],
      totalPL:      getVal('Total P&L'),
      totalTrades:  getVal('Total trades'),
      profitable:   getVal('Profitable trades'),
      profitFactor: getVal('Profit factor'),
      maxDD:        getVal('Max equity drawdown'),
    });
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Backtest results:', stats);
