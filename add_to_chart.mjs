/**
 * add_to_chart.mjs — finds "Strategy Dashboard" in the My Scripts tab
 * of the Indicators dialog and clicks "Add to chart".
 */
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

// Wait for the indicators dialog to appear
await sleep(1500);

// Step 1: Click "My scripts" tab inside the dialog
const tabClicked = await ev(`
  (function() {
    var tabs = document.querySelectorAll('[role="tab"], [class*="tab"]');
    for (var i = 0; i < tabs.length; i++) {
      var txt = tabs[i].textContent.trim().toLowerCase();
      if (txt === 'my scripts' || txt === 'saved' || txt.includes('my script')) {
        tabs[i].click();
        return 'clicked: ' + tabs[i].textContent.trim();
      }
    }
    return 'not found';
  })()
`);
console.log('Tab click:', tabClicked);

await sleep(800);

// Step 2: Search for "Strategy Dashboard" in the search field
const searched = await ev(`
  (function() {
    var inputs = document.querySelectorAll('input[type="text"], input[placeholder], [role="searchbox"]');
    for (var i = 0; i < inputs.length; i++) {
      if (inputs[i].offsetParent !== null) {
        inputs[i].focus();
        var nativeInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        nativeInput.set.call(inputs[i], 'Strategy Dashboard');
        inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
        inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
        return 'typed in: ' + (inputs[i].placeholder || inputs[i].id || 'input');
      }
    }
    return 'no input found';
  })()
`);
console.log('Search:', searched);

await sleep(1200);

// Step 3: Find the script in results and click "Add to chart" or the item itself
const added = await ev(`
  (function() {
    // Look for "Strategy Dashboard" in the results list
    var items = document.querySelectorAll('[class*="listItem"], [class*="item-"], [class*="result"]');
    for (var i = 0; i < items.length; i++) {
      var txt = items[i].textContent;
      if (txt.includes('Strategy Dashboard') || txt.includes('Checklist Reversal')) {
        // Try to find "Add to chart" button inside this item
        var addBtn = items[i].querySelector('button, [role="button"]');
        if (addBtn) { addBtn.click(); return 'clicked add button in: ' + txt.trim().substring(0, 50); }
        // Otherwise double-click or click the item itself
        items[i].click();
        return 'clicked item: ' + txt.trim().substring(0, 50);
      }
    }
    // Try clicking any visible element containing the script title
    var all = document.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      var t = all[j].textContent.trim();
      if ((t === 'Strategy Dashboard — Trend · S&R · FVG' || t === 'Checklist Reversal Strategy') && all[j].offsetParent !== null) {
        all[j].click();
        return 'direct click on: ' + t.substring(0, 50);
      }
    }
    return 'not found in results';
  })()
`);
console.log('Add result:', added);

await sleep(2000);

// Step 4: Check chart studies to confirm
const stateR = await client.Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      if (chart && typeof chart.getAllStudies === 'function') {
        return chart.getAllStudies().map(function(s) { return s.metaInfo ? s.metaInfo.shortDescription || s.metaInfo.description : s.name; }).join(', ');
      }
    } catch(e) { return 'error: ' + e.message; }
    return 'chart api not available';
  })()`,
  returnByValue: true
});
console.log('Chart studies after:', stateR.result.value);

await client.close();
