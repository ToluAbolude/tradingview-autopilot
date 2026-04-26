/**
 * Search for Alpha Kill in the open strategy search modal.
 * If not found, click My scripts. If still not found, inject and save first.
 */
import { evaluate, getClient } from '../src/connection.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dir, '../scripts/current.pine'), 'utf-8');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Check if the strategy search modal is open ────────────────────────────────
const modalState = await evaluate(`(function(){
  var modal = document.querySelector('[class*="wrapper-b8SxMnzX"]');
  if (modal && modal.offsetParent) return 'open';
  return 'closed';
})()`);
console.log('Modal state:', modalState);

if (modalState === 'closed') {
  // Open strategy tester and click "Load your strategy"
  await evaluate(`(function(){
    var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
    if (bwb) bwb.showWidget('strategy-tester');
  })()`);
  await sleep(1000);
  await evaluate(`(function(){
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if (/load.your.strategy/i.test(btns[i].textContent)) { btns[i].click(); return; }
    }
  })()`);
  await sleep(1500);
}

// ── Type "Alpha" in the search box ───────────────────────────────────────────
const searchResult = await evaluate(`(function(){
  var input = document.querySelector('input[placeholder*="Search"], input[type="search"], [class*="search"] input');
  if (!input) return 'no search input';
  input.focus();
  // Set value via React synthetic event
  var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  nativeInputValueSetter.call(input, 'Alpha Kill');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return 'typed Alpha Kill';
})()`);
console.log('Search:', searchResult);
await sleep(2000);

// ── Read search results ───────────────────────────────────────────────────────
const results = await evaluate(`(function(){
  // Find the results list
  var lists = document.querySelectorAll('[class*="list-"], [role="listbox"], [class*="results"]');
  var found = [];
  lists.forEach(function(l) {
    if (!l.offsetParent) return;
    var items = l.querySelectorAll('[class*="item-"], [class*="title-"], li, [role="option"]');
    items.forEach(function(item) {
      var text = item.textContent.trim().substring(0,60);
      if (text) found.push(text);
    });
  });
  if (found.length) return found.slice(0,10).join(' | ');

  // Check the wrapper content
  var wrapper = document.querySelector('[class*="wrapper-b8SxMnzX"]');
  if (wrapper) return 'wrapper: ' + wrapper.textContent.replace(/\s+/g,' ').substring(0,300);
  return 'no results visible';
})()`);
console.log('Search results:', results);

// ── Click "My scripts" if no alpha kill found ─────────────────────────────────
await evaluate(`(function(){
  var allItems = document.querySelectorAll('[class*="category-"], [class*="listItem-"], button, a');
  for (var i = 0; i < allItems.length; i++) {
    var el = allItems[i];
    if (!el.offsetParent) continue;
    if (/^my scripts$/i.test(el.textContent.trim())) {
      el.click();
      return;
    }
  }
})()`);
await sleep(1500);

// ── Read My scripts results ───────────────────────────────────────────────────
const myScripts = await evaluate(`(function(){
  var wrapper = document.querySelector('[class*="wrapper-b8SxMnzX"]');
  if (!wrapper) return 'no wrapper';
  return wrapper.textContent.replace(/\s+/g,' ').substring(0,500);
})()`);
console.log('My scripts:', myScripts);

// ── Look for Alpha Kill in the list and click it ──────────────────────────────
const clickAK = await evaluate(`(function(){
  var allItems = document.querySelectorAll('[class*="cell-"], [class*="item-"], [class*="title-"], li');
  for (var i = 0; i < allItems.length; i++) {
    var el = allItems[i];
    if (!el.offsetParent) continue;
    if (/alpha.kill|ak_v1/i.test(el.textContent)) {
      el.click();
      return 'clicked: ' + el.textContent.trim().substring(0,40);
    }
  }
  return 'not found in list';
})()`);
console.log('Click AK:', clickAK);
