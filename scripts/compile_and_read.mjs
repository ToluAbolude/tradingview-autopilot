import { evaluate, getClient } from '../src/connection.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const client = await getClient();

// Wait for save to complete (pending → saved)
let saveOk = false;
for (let i = 0; i < 20; i++) {
  const cls = await evaluate(`(function(){
    var b = document.querySelector('[class*="saveButton-"]');
    return b ? b.className : 'none';
  })()`);
  console.log('Save state:', cls.substring(0,50));
  if (/saved-/.test(cls) && !/unsaved-|pending-/.test(cls)) { saveOk = true; break; }
  await sleep(1000);
}
console.log('Save complete:', saveOk);

// Find the compile button
const btnState = await evaluate(`(function(){
  var btns = document.querySelectorAll('button');
  var found = [];
  for (var i = 0; i < btns.length; i++) {
    var b = btns[i];
    if (!b.offsetParent) continue;
    var title = b.getAttribute('title') || '';
    var text = (b.textContent||'').trim().substring(0,30);
    if (/add|update|chart|compil/i.test(title + text)) {
      found.push('title=' + title + ' text=' + text);
    }
  }
  return found.join(' | ') || 'no compile btn';
})()`);
console.log('Compile buttons:', btnState);

// Click "Update on chart" or "Add to chart"
const addResult = await evaluate(`(function(){
  var btns = document.querySelectorAll('button');
  for (var i = 0; i < btns.length; i++) {
    var b = btns[i];
    if (!b.offsetParent) continue;
    var title = b.getAttribute('title') || '';
    var text = (b.textContent||'').trim();
    if (/^(Add to chart|Update on chart)$/i.test(title)) {
      b.click();
      return 'clicked: ' + title;
    }
  }
  // Fallback: Ctrl+Enter
  return 'no btn found';
})()`);
console.log('Compile result:', addResult);

if (/no btn/i.test(addResult)) {
  // Send Ctrl+Enter as fallback
  await client.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  console.log('Ctrl+Enter sent');
}
await sleep(5000);

// The strategy tester should now auto-update since it's linked to Alpha Kill v1
// Read results
const results = await evaluate(`(function(){
  var el = document.querySelector('[class*="backtesting"]');
  if (!el) return 'no panel';
  var text = el.textContent.replace(/\s+/g,' ');
  // Find summary stats
  var idx = text.indexOf('Total trade');
  if (idx >= 0) return 'STATS: ' + text.substring(idx, idx+200);
  return text.substring(0,400);
})()`);
console.log('Results:', results);
