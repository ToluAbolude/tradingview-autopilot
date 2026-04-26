/**
 * 1. Find the Checklist Reversal Strategy legend item
 * 2. Find and click its backtesting icon or delete button
 * 3. Then inject Alpha Kill and link to tester
 */
import { evaluate, getClient } from '../src/connection.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dir, '../scripts/current.pine'), 'utf-8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const client = await getClient();

// Close modal first
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, keyCode:27}))`);
await sleep(500);

// Find the strategy legend item and list ALL buttons near it
const legendButtons = await evaluate(`(function(){
  // Find the nameButton-k49p41Es parent of the Checklist H2
  var nameBtn = document.querySelector('[class*="nameButton-k49p41Es"]');
  if (!nameBtn) return 'no nameButton found';

  // Go up to wrapper-mJYe25IQ
  var wrapper = nameBtn.closest('[class*="wrapper-mJYe25IQ"]');
  if (!wrapper) return 'no wrapper, nameBtn class: ' + nameBtn.className;

  // Get ALL elements in the wrapper
  var all = wrapper.querySelectorAll('button, [class*="btn-"], [class*="icon-"], [class*="action-"]');
  var found = [];
  all.forEach(function(el) {
    var al = el.getAttribute('aria-label') || '';
    var title = el.getAttribute('title') || '';
    var dn = el.getAttribute('data-name') || '';
    var cls = (el.className||'').substring(0,60);
    var text = el.textContent.trim().substring(0,30);
    found.push('tag=' + el.tagName + ' al=' + al + ' title=' + title + ' dn=' + dn + ' cls=' + cls + ' text=' + text);
  });
  return found.join(' || ');
})()`);
console.log('Legend wrapper buttons:', legendButtons);

// Also check what pane element the wrapper is inside
const paneInfo = await evaluate(`(function(){
  var nameBtn = document.querySelector('[class*="nameButton-k49p41Es"]');
  if (!nameBtn) return 'no nameBtn';
  var el = nameBtn;
  var chain = [];
  for (var i = 0; i < 10; i++) {
    if (!el) break;
    var dn = el.getAttribute('data-name') || '';
    var id = el.id || '';
    chain.push(i + ':' + el.tagName + ' dn=' + dn + ' id=' + id + ' cls=' + (el.className||'').substring(0,40));
    el = el.parentElement;
  }
  return chain.join(' -> ');
})()`);
console.log('Pane chain:', paneInfo);

// Hover over the legend to show action buttons
const hoverResult = await evaluate(`(function(){
  var nameBtn = document.querySelector('[class*="nameButton-k49p41Es"]');
  if (!nameBtn) return 'no nameBtn';
  nameBtn.dispatchEvent(new MouseEvent('mouseover', {bubbles:true}));
  nameBtn.dispatchEvent(new MouseEvent('mouseenter', {bubbles:true}));
  return 'hovered';
})()`);
console.log('Hover:', hoverResult);
await sleep(500);

// Now check for newly visible buttons (action buttons appear on hover)
const hoverButtons = await evaluate(`(function(){
  var nameBtn = document.querySelector('[class*="nameButton-k49p41Es"]');
  if (!nameBtn) return 'no nameBtn';
  var wrapper = nameBtn.closest('[class*="wrapper-mJYe25IQ"]');
  if (!wrapper) return 'no wrapper';
  var all = wrapper.querySelectorAll('button, [class*="btn"]');
  var found = [];
  all.forEach(function(el) {
    var al = el.getAttribute('aria-label') || '';
    var title = el.getAttribute('title') || '';
    var cls = (el.className||'').substring(0,50);
    found.push('al=' + al + ' title=' + title + ' cls=' + cls);
  });
  return found.join(' | ');
})()`);
console.log('Hover buttons:', hoverButtons);

// Try clicking the nameButton to open strategy settings/tester
const nameClick = await evaluate(`(function(){
  var nameBtn = document.querySelector('[class*="nameButton-k49p41Es"]');
  if (!nameBtn) return 'no nameBtn';
  nameBtn.click();
  return 'clicked nameButton';
})()`);
console.log('Name button click:', nameClick);
await sleep(1000);

// Check what appeared
const afterNameClick = await evaluate(`(function(){
  var menus = document.querySelectorAll('[role="menu"], [class*="menu-"], [class*="dialog"], [class*="modal"]');
  var found = [];
  menus.forEach(function(m) {
    if (m.offsetParent) found.push(m.textContent.trim().substring(0,100));
  });
  return found.join(' | ') || 'nothing appeared';
})()`);
console.log('After name click:', afterNameClick);

// Check strategy tester
await sleep(500);
const testerNow = await evaluate(`(function(){
  var el = document.querySelector('[class*="backtesting"]') || document.querySelector('[data-name="backtesting"]');
  if (!el) return 'no panel';
  var text = el.textContent.replace(/\s+/g,' ');
  if (/Total trades|Net profit|Percent profitable/i.test(text)) return 'HAS RESULTS: ' + text.substring(0,400);
  return 'still empty: ' + text.substring(0,200);
})()`);
console.log('Tester now:', testerNow);
