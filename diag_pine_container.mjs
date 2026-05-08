import CDP from 'chrome-remote-interface';

const resp = await fetch('http://localhost:9222/json/list');
const targets = await resp.json();
const target = targets.find(t => t.type === 'page' && /tradingview/i.test(t.url));
const client = await CDP({ host: 'localhost', port: 9222, target: target.id });
await client.Runtime.enable();

const r = await client.Runtime.evaluate({
  expression: `(function() {
    // Find the Pine Editor area
    var areas = [
      document.querySelector('.monaco-editor.pine-editor-monaco'),
      document.querySelector('[class*="layout__area--bottom"]'),
      document.querySelector('[class*="bottom-widgetbar"]'),
    ];
    var results = {};

    // Check bottom area
    var bottomArea = document.querySelector('[class*="layout__area--bottom"]');
    if (bottomArea) {
      results.bottomAreaHeight = bottomArea.offsetHeight;
      results.bottomAreaClass = bottomArea.className.substring(0, 80);
      // Find all buttons inside it
      var btns = bottomArea.querySelectorAll('button, [role="button"]');
      results.bottomAreaButtons = Array.from(btns).slice(0, 20).map(function(b) {
        return (b.offsetParent ? '[V]' : '[H]') + ' "' + b.textContent.trim().substring(0, 30) + '" ' + b.className.substring(0, 40);
      });
    } else {
      results.bottomArea = 'not found';
    }

    // Look for any "Add to chart" or "Update on chart" anywhere
    var allBtns = document.querySelectorAll('button, [role="button"]');
    var chartBtns = [];
    for (var i = 0; i < allBtns.length; i++) {
      var txt = allBtns[i].textContent.trim();
      if (txt.toLowerCase().includes('chart') || txt.toLowerCase().includes('add to') || txt.toLowerCase().includes('update on')) {
        chartBtns.push((allBtns[i].offsetParent ? '[V]' : '[H]') + ' "' + txt.substring(0,40) + '" cls=' + allBtns[i].className.substring(0,40));
      }
    }
    results.chartButtons = chartBtns;

    return results;
  })()`,
  returnByValue: true
});
const v = r.result.value;
console.log('Bottom area height:', v.bottomAreaHeight, '| class:', v.bottomAreaClass);
console.log('Bottom area buttons:');
(v.bottomAreaButtons || []).forEach(b => console.log(' ', b));
console.log('All "chart" buttons:');
(v.chartButtons || []).forEach(b => console.log(' ', b));
await client.close();
