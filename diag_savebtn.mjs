import CDP from 'chrome-remote-interface';

const resp = await fetch('http://localhost:9222/json/list');
const targets = await resp.json();
const target = targets.find(t => t.type === 'page' && /tradingview/i.test(t.url));
const client = await CDP({ host: 'localhost', port: 9222, target: target.id });
await client.Runtime.enable();

const r = await client.Runtime.evaluate({
  expression: `(function() {
    // Find elements with 'saveButton' in class
    var all = document.querySelectorAll('[class*="saveButton"]');
    var results = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      results.push({
        tag: el.tagName,
        text: el.textContent.trim().substring(0, 60),
        cls: el.className.substring(0, 80),
        visible: el.offsetParent !== null,
        al: el.getAttribute('aria-label') || '',
        dn: el.getAttribute('data-name') || ''
      });
    }
    // Also scan all buttons for Pine Editor specific ones
    var btns = document.querySelectorAll('button');
    var pineEditorBtns = [];
    for (var j = 0; j < btns.length; j++) {
      var txt = btns[j].textContent.trim();
      if (txt && btns[j].offsetParent !== null) {
        var cls = btns[j].className || '';
        // Check if it's in the Pine Editor panel
        var parent = btns[j].closest('[class*="pine-editor"], [class*="scriptEditor"], [class*="editor-"]');
        if (parent) pineEditorBtns.push('"' + txt.substring(0,40) + '" cls=' + cls.substring(0,50));
      }
    }
    return {saveButton: results, pineEditorBtns: pineEditorBtns};
  })()`,
  returnByValue: true
});
console.log('saveButton elements:', JSON.stringify(r.result.value.saveButton, null, 2));
console.log('Pine Editor buttons:', r.result.value.pineEditorBtns);
await client.close();
