import { evaluate } from '../src/connection.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Look for date range inputs in the strategy tester
const dateInputs = await evaluate(`(function(){
  var el = document.querySelector('[class*="backtesting"]');
  if (!el) return 'no tester';
  var inputs = el.querySelectorAll('input, [class*="date"], [class*="range"], [class*="period"]');
  var found = [];
  inputs.forEach(function(i) {
    if (!i.offsetParent) return;
    found.push('tag=' + i.tagName + ' type=' + (i.type||'') + ' cls=' + (i.className||'').substring(0,40) + ' val=' + (i.value||'').substring(0,20));
  });
  return found.join(' | ') || 'none found';
})()`);
console.log('Date inputs:', dateInputs);

// Look for "Properties" or gear icon in strategy tester header
const header = await evaluate(`(function(){
  var el = document.querySelector('[class*="backtesting"]');
  if (!el) return 'no tester';
  var btns = el.querySelectorAll('button, [role="button"]');
  var found = [];
  btns.forEach(function(b) {
    if (!b.offsetParent) return;
    var al = b.getAttribute('aria-label') || '';
    var title = b.getAttribute('title') || '';
    var text = (b.textContent||'').trim().substring(0,20);
    found.push('al=' + al + ' title=' + title + ' text=' + text);
  });
  return found.join(' | ') || 'none';
})()`);
console.log('Header buttons:', header);

// Try to find and click "Properties" or settings gear
const propsClick = await evaluate(`(function(){
  var btns = document.querySelectorAll('button, [role="button"]');
  for (var i = 0; i < btns.length; i++) {
    var b = btns[i];
    if (!b.offsetParent) continue;
    var al = (b.getAttribute('aria-label')||'').toLowerCase();
    var title = (b.getAttribute('title')||'').toLowerCase();
    if (/propert|setting|gear|format/i.test(al + title)) {
      b.click();
      return 'clicked: ' + al + title;
    }
  }
  return 'no props button';
})()`);
console.log('Props click:', propsClick);
await sleep(1000);

// Check what opened
const dialog = await evaluate(`(function(){
  var dialogs = document.querySelectorAll('[class*="dialog"], [class*="modal"], [role="dialog"]');
  var found = [];
  for (var i = 0; i < dialogs.length; i++) {
    if (!dialogs[i].offsetParent) continue;
    found.push(dialogs[i].textContent.trim().substring(0,80));
  }
  return found.join(' || ') || 'no dialog';
})()`);
console.log('Dialog:', dialog);
