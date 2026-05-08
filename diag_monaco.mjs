import CDP from 'chrome-remote-interface';

const resp = await fetch('http://localhost:9222/json/list');
const targets = await resp.json();
const target = targets.find(t => t.type === 'page' && /tradingview/i.test(t.url));
const client = await CDP({ host: 'localhost', port: 9222, target: target.id });
await client.Runtime.enable();

const expr = `
(function() {
  var container = document.querySelector('.monaco-editor.pine-editor-monaco');
  if (!container) return 'no container';

  var el = container;
  for (var i = 0; i < 30; i++) {
    if (!el) break;
    var keys = Object.keys(el);
    var fk = keys.find(function(k) { return k.startsWith('__reactFiber$'); });
    if (fk) {
      var cur = el[fk];
      var report = [];
      for (var d = 0; d < 150; d++) {
        if (!cur) { report.push('null at depth ' + d); break; }
        try {
          if (cur.memoizedProps && cur.memoizedProps.value) {
            var vkeys = Object.keys(cur.memoizedProps.value);
            report.push('D' + d + ':value{' + vkeys.slice(0, 6).join(',') + '}');
            if (cur.memoizedProps.value.monacoEnv) return 'FOUND monacoEnv at depth ' + d;
          }
        } catch(e) { report.push('D' + d + ':err(' + e.message + ')'); }
        cur = cur.return;
      }
      return report.join(' | ');
    }
    el = el.parentElement;
  }
  return 'no fiber found';
})()
`;

const result = await client.Runtime.evaluate({ expression: expr, returnByValue: true });
console.log('Fiber scan result:');
console.log(result.result.value);

// Also try to find Monaco via different global paths
const globals = await client.Runtime.evaluate({
  expression: `(function() {
    var paths = [
      'window.monaco',
      'window.monacoEditor',
      'window.__monaco',
      'window.require',
    ];
    var found = [];
    paths.forEach(function(p) {
      try {
        var v = eval(p);
        if (v !== undefined && v !== null) found.push(p + '=' + typeof v);
      } catch(e) {}
    });
    return found.join(', ') || 'none';
  })()`,
  returnByValue: true
});
console.log('Global Monaco paths:', globals.result.value);

await client.close();
