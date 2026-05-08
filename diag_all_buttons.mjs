import CDP from 'chrome-remote-interface';

const resp = await fetch('http://localhost:9222/json/list');
const targets = await resp.json();
const target = targets.find(t => t.type === 'page' && /tradingview/i.test(t.url));
const client = await CDP({ host: 'localhost', port: 9222, target: target.id });
await client.Runtime.enable();

const r = await client.Runtime.evaluate({
  expression: `(function() {
    var btns = document.querySelectorAll('button, [role="button"]');
    var results = [];
    for (var i = 0; i < btns.length; i++) {
      var txt = btns[i].textContent.trim();
      var cls = btns[i].className || '';
      var visible = btns[i].offsetParent !== null;
      var al = btns[i].getAttribute('aria-label') || '';
      var dn = btns[i].getAttribute('data-name') || '';
      if (visible && txt)
        results.push('"' + txt.substring(0, 30) + '" cls=' + cls.substring(0, 40) + (al?' al='+al:'') + (dn?' dn='+dn:''));
    }
    return results.join('\\n');
  })()`,
  returnByValue: true
});
console.log(r.result.value || '(none)');
await client.close();
