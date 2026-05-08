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
      if (!txt) continue;
      var interesting = cls.indexOf('save') !== -1 || cls.indexOf('Save') !== -1 ||
        txt.toLowerCase().indexOf('chart') !== -1 ||
        txt.toLowerCase().indexOf('add') !== -1 ||
        txt.toLowerCase().indexOf('update') !== -1 ||
        txt.toLowerCase().indexOf('save') !== -1 ||
        txt.toLowerCase().indexOf('compil') !== -1;
      if (interesting)
        results.push((visible ? '[visible]' : '[hidden]') + ' "' + txt + '" cls=' + cls.substring(0, 60));
    }
    return results.join('\\n') || 'none found';
  })()`,
  returnByValue: true
});
console.log('Pine Editor buttons:');
console.log(r.result.value);
await client.close();
