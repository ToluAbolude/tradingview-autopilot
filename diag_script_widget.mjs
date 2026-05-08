import CDP from 'chrome-remote-interface';

const resp = await fetch('http://localhost:9222/json/list');
const targets = await resp.json();
const target = targets.find(t => t.type === 'page' && /tradingview/i.test(t.url));
const client = await CDP({ host: 'localhost', port: 9222, target: target.id });
await client.Runtime.enable();

const r = await client.Runtime.evaluate({
  expression: `(function() {
    var widget = document.querySelector('.tv-script-widget');
    if (!widget) return {error: 'tv-script-widget not found'};

    var btns = widget.querySelectorAll('button, [role="button"], [class*="Button"], [class*="button"]');
    var results = Array.from(btns).map(function(b) {
      return {
        visible: b.offsetParent !== null,
        text: b.textContent.trim().substring(0, 50),
        cls: b.className.substring(0, 80),
        al: b.getAttribute('aria-label') || '',
        dn: b.getAttribute('data-name') || ''
      };
    });

    // Also check for any text that says "Add" or "chart"
    var allEls = widget.querySelectorAll('*');
    var addEls = [];
    for (var i = 0; i < allEls.length; i++) {
      var txt = allEls[i].childNodes.length === 1 && allEls[i].childNodes[0].nodeType === 3
        ? allEls[i].textContent.trim() : '';
      if (txt && (txt.toLowerCase().includes('add') || txt.toLowerCase().includes('chart'))) {
        addEls.push({txt: txt, tag: allEls[i].tagName, cls: allEls[i].className.substring(0,40)});
      }
    }

    return {buttons: results, addElements: addEls.slice(0, 10)};
  })()`,
  returnByValue: true
});
const v = r.result.value;
if (v.error) { console.log(v.error); }
else {
  console.log('All buttons in tv-script-widget:');
  v.buttons.forEach(b => console.log(' ', b.visible ? '[V]' : '[H]', JSON.stringify(b.text), 'cls=', b.cls.substring(0,50), b.al ? 'al='+b.al : ''));
  console.log('Add/chart elements:', v.addElements);
}
await client.close();
