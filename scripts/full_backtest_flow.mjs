/**
 * Full backtest flow:
 * 1. Switch to XAUUSD 5M
 * 2. Open Pine editor, inject Alpha Kill, compile
 * 3. Open strategy tester with 'backtesting' widget name
 * 4. Click "Load your strategy" → navigate to "My scripts" or search "ORB"
 * 5. OR: find the strategy in chart legend and click the backtesting icon
 * 6. Read results
 */
import { evaluate, getClient } from '../src/connection.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dir, '../scripts/current.pine'), 'utf-8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const client = await getClient();

// ── 0. Escape any open modals ─────────────────────────────────────────────────
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, keyCode:27}))`);
await sleep(500);

// ── 1. Switch to OANDA:XAUUSD 5M ─────────────────────────────────────────────
const symResult = await evaluate(`(function(){
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    if (typeof chart.setSymbol === 'function') { chart.setSymbol('OANDA:XAUUSD', '5', function(){}); return 'OANDA:XAUUSD 5M'; }
    return 'no setSymbol';
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Symbol:', symResult);
await sleep(3000);

// ── 2. Open Pine editor & inject ──────────────────────────────────────────────
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
    for (var i = 0; i < 20; i++) { if (!el) break; fk = Object.keys(el).find(k => k.startsWith('__reactFiber$')); if (fk) break; el = el.parentElement; }
    if (!fk) return false;
    var cur = el[fk];
    for (var d = 0; d < 15; d++) { if (!cur) break; if (cur.memoizedProps?.value?.monacoEnv?.editor) return true; cur = cur.return; }
    return false;
  })()`);
  if (ready) break;
}
console.log('Monaco:', ready);

const escaped = JSON.stringify(src);
await evaluate(`(function(){
  var c = document.querySelector('.monaco-editor.pine-editor-monaco');
  var el = c, fk;
  for (var i = 0; i < 20; i++) { if (!el) break; fk = Object.keys(el).find(k => k.startsWith('__reactFiber$')); if (fk) break; el = el.parentElement; }
  var cur = el[fk];
  for (var d = 0; d < 15; d++) { if (!cur) break; if (cur.memoizedProps?.value?.monacoEnv?.editor) { cur.memoizedProps.value.monacoEnv.editor.getEditors()[0].setValue(${escaped}); return; } cur = cur.return; }
})()`);
await sleep(300);

// ── 3. Compile: click "Add to chart" or use Ctrl+Enter ───────────────────────
const compileBtn = await evaluate(`(function(){
  var btns = document.querySelectorAll('button');
  // Prefer "Update on chart" over "Add to chart" — keeps tester linked
  var addBtn = null, updateBtn = null;
  for (var i = 0; i < btns.length; i++) {
    var b = btns[i];
    if (!b.offsetParent) continue;
    var title = b.getAttribute('title') || '';
    var text = (b.textContent || '').trim();
    if (/^Update on chart$/i.test(title)) { b.click(); return 'Update: ' + title; }
    if (/^Add to chart$/i.test(title) && !addBtn) addBtn = b;
    if (/^Update on chart$/i.test(text) && !updateBtn) updateBtn = b;
    if (/^Add to chart$/i.test(text) && !addBtn) addBtn = b;
  }
  if (updateBtn) { updateBtn.click(); return 'Update text'; }
  if (addBtn) { addBtn.click(); return 'Add title/text'; }
  return 'no-btn';
})()`);
console.log('Compile btn:', compileBtn);
await client.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
await sleep(4000);

// ── 4. Check compilation errors ───────────────────────────────────────────────
const errors = await evaluate(`(function(){
  var c = document.querySelector('.monaco-editor.pine-editor-monaco');
  var el = c, fk;
  for (var i = 0; i < 20; i++) { if (!el) break; fk = Object.keys(el).find(k => k.startsWith('__reactFiber$')); if (fk) break; el = el.parentElement; }
  var cur = el[fk];
  for (var d = 0; d < 15; d++) { if (!cur) break; if (cur.memoizedProps?.value?.monacoEnv?.editor) { var m = cur.memoizedProps.value.monacoEnv; return m.editor.getModelMarkers({resource: m.editor.getEditors()[0].getModel().uri}).map(mk => mk.startLineNumber+': '+mk.message); } cur = cur.return; }
  return [];
})()`);
console.log('Errors:', errors);

// ── 5. Open strategy tester with correct widget name ─────────────────────────
await evaluate(`(function(){
  var bwb = window.TradingView.bottomWidgetBar;
  bwb.showWidget('backtesting');  // correct name per MCP core/ui.js
})()`);
await sleep(2000);

// ── 6. Look for strategy in chart pane title (legend) ────────────────────────
const legendSearch = await evaluate(`(function(){
  // Search pane titles / legend for Alpha Kill
  var candidates = document.querySelectorAll('[class*="paneTitle"], [class*="legendActionsButton"], [class*="apply-common-tooltip"]');
  var found = [];
  candidates.forEach(function(el) {
    if (!el.offsetParent) return;
    var text = el.textContent.trim().substring(0,60);
    var al = el.getAttribute('aria-label') || '';
    var dn = el.getAttribute('data-name') || '';
    if (/alpha|kill|strategy/i.test(text + al + dn)) {
      found.push({ tag: el.tagName, text: text.substring(0,40), al, dn, cls: (el.className||'').substring(0,50) });
    }
  });
  return JSON.stringify(found.slice(0,5));
})()`);
console.log('Legend/pane search:', legendSearch);

// ── 7. Check if tester now has data ──────────────────────────────────────────
const testerState = await evaluate(`(function(){
  var el = document.querySelector('[data-name="backtesting"]') || document.querySelector('[class*="backtesting"]');
  if (!el) return 'no panel';
  var text = el.textContent.replace(/\s+/g,' ');
  if (/Total trades|Net profit|Percent profitable/i.test(text)) {
    return 'HAS RESULTS: ' + text.substring(0,500);
  }
  return 'Empty: ' + text.substring(0,300);
})()`);
console.log('Tester state:', testerState);

// ── 8. Inspect strategy tester panel structure ────────────────────────────────
const panelStructure = await evaluate(`(function(){
  var el = document.querySelector('[data-name="backtesting"]') || document.querySelector('[class*="backtesting"]');
  if (!el) return 'no panel';
  // Find all buttons/interactive elements
  var items = el.querySelectorAll('button, [role="button"], [class*="tab-"], select');
  var result = [];
  items.forEach(function(b) {
    if (!b.offsetParent) return;
    var text = (b.textContent||'').trim().substring(0,40);
    var al = b.getAttribute('aria-label') || '';
    var dn = b.getAttribute('data-name') || '';
    var title = b.getAttribute('title') || '';
    result.push('tag=' + b.tagName + ' text=' + text + ' al=' + al + ' dn=' + dn + ' title=' + title);
  });
  return result.slice(0,10).join(' | ');
})()`);
console.log('Panel structure:', panelStructure);
