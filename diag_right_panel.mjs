import CDP from 'chrome-remote-interface';

const resp = await fetch('http://localhost:9222/json/list');
const targets = await resp.json();
const target = targets.find(t => t.type === 'page' && /tradingview/i.test(t.url));
const client = await CDP({ host: 'localhost', port: 9222, target: target.id });
await client.Runtime.enable();

const r = await client.Runtime.evaluate({
  expression: `(function() {
    var results = {};

    // Find the monaco editor and work upward to find its container panel
    var monaco = document.querySelector('.monaco-editor.pine-editor-monaco');
    if (monaco) {
      var el = monaco;
      var path = [];
      for (var i = 0; i < 15; i++) {
        if (!el || el === document.body) break;
        path.push(el.tagName + '.' + (el.className || '').split(' ').slice(0,2).join('.').substring(0,40));
        el = el.parentElement;
      }
      results.monacoParentPath = path.join(' > ');

      // Find the panel containing Monaco
      el = monaco;
      for (var j = 0; j < 15; j++) {
        if (!el || el === document.body) break;
        if (el.offsetHeight > 200 && el.offsetWidth > 200) {
          // Found a substantial container - look for buttons in it
          var btns = el.querySelectorAll('button, [role="button"]');
          var btnList = Array.from(btns).slice(0, 30).map(function(b) {
            return (b.offsetParent ? '[V]' : '[H]') + ' "' + b.textContent.trim().substring(0,30) + '" cls=' + b.className.substring(0,50);
          });
          results.containerButtons = btnList;
          results.containerClass = el.className.substring(0, 80);
          results.containerSize = el.offsetWidth + 'x' + el.offsetHeight;
          break;
        }
        el = el.parentElement;
      }
    } else {
      results.monaco = 'not found';
    }

    return results;
  })()`,
  returnByValue: true
});
const v = r.result.value;
console.log('Monaco parent path:', v.monacoParentPath);
console.log('Container:', v.containerClass, v.containerSize);
console.log('Buttons in container:');
(v.containerButtons || []).forEach(b => console.log(' ', b));
await client.close();
