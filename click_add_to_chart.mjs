import CDP from 'chrome-remote-interface';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const resp = await fetch('http://localhost:9222/json/list');
const targets = await resp.json();
const target = targets.find(t => t.type === 'page' && /tradingview/i.test(t.url));
const client = await CDP({ host: 'localhost', port: 9222, target: target.id });
await client.Runtime.enable();

const ev = async (expr) => {
  const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};

// Get chart study count before
const before = await ev(`
  (function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
    } catch(e) {}
    return -1;
  })()
`);
console.log('Studies before:', before);

// Find and click the icon buttons in the script widget (excluding save/publish/ellipsis)
const clicked = await ev(`
  (function() {
    var widget = document.querySelector('.tv-script-widget');
    if (!widget) return 'widget not found';

    // The Pine Editor toolbar buttons (visible icon buttons in the header area)
    // Skip: nameButton, saveButton, publishButton, ellipse/more-options
    // Click: the first action button (should be "Add to chart" or "Update on chart")
    var btns = widget.querySelectorAll('button');
    var actionBtns = [];
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var cls = b.className || '';
      // Exclude Monaco find/replace buttons, name button, save button, publish button, ellipse
      if (cls.includes('codicon') || cls.includes('nameButton') ||
          cls.includes('saveButton') || cls.includes('publishButton') ||
          cls.includes('ellipse') || cls.includes('consoleButton') ||
          cls.includes('referenceButton')) continue;
      if (!b.offsetParent) continue; // hidden
      actionBtns.push(b);
    }

    if (actionBtns.length === 0) return 'no action buttons found';

    // Click the LAST visible action button (usually "Add to chart" is rightmost before ellipsis)
    // But let's try the first one first
    var btn = actionBtns[0];
    btn.click();
    return 'clicked: cls=' + btn.className.substring(0, 60) + ' text="' + btn.textContent.trim().substring(0,20) + '"';
  })()
`);
console.log('Click result:', clicked);

await sleep(3000);

// Check if study was added
const after = await ev(`
  (function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      if (chart && typeof chart.getAllStudies === 'function') {
        return chart.getAllStudies().map(function(s) {
          return (s.metaInfo ? s.metaInfo.shortDescription || '' : '') || s.name || 'unknown';
        });
      }
    } catch(e) { return ['error: ' + e.message]; }
    return [];
  })()
`);
console.log('Studies after:', JSON.stringify(after));

await client.close();
