import { evaluate } from '../src/connection.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Click "My scripts" in the already-open modal
const click1 = await evaluate(`(function(){
  var all = document.querySelectorAll('[class*="category-"], [class*="listItem-"], button, a, li, span');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (!el.offsetParent) continue;
    var text = el.textContent.trim();
    if (text === 'My scripts') { el.click(); return 'clicked My scripts: ' + el.tagName + ' cls=' + (el.className||'').substring(0,40); }
  }
  return 'My scripts not found';
})()`);
console.log('Click My scripts:', click1);
await sleep(2000);

// Read the modal content after clicking My scripts
const myScripts = await evaluate(`(function(){
  var wrapper = document.querySelector('[class*="wrapper-b8SxMnzX"]');
  if (!wrapper) return 'no modal wrapper';
  // Look for script items
  var items = wrapper.querySelectorAll('[class*="title-"], [class*="name-"], [class*="cell-"], li, [class*="item"]');
  var found = [];
  items.forEach(function(el) {
    if (!el.offsetParent) return;
    var text = el.textContent.trim().substring(0,60);
    if (text && text.length > 2) found.push(text);
  });
  if (found.length) return found.slice(0,20).join(' | ');
  return 'modal text: ' + wrapper.textContent.replace(/\s+/g,' ').substring(0,400);
})()`);
console.log('My scripts content:', myScripts);

// Also use pine-facade API to list saved scripts
const savedScripts = await evaluate(`
  fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
    .then(r => r.json())
    .then(data => {
      if (!Array.isArray(data)) return JSON.stringify({error: 'not array', data: String(data).substring(0,100)});
      return JSON.stringify(data.map(s => ({ name: s.scriptName, title: s.scriptTitle, id: s.scriptIdPart })).slice(0,20));
    })
    .catch(e => 'fetch err: ' + e.message)
`);
console.log('Pine-facade scripts:', savedScripts);
