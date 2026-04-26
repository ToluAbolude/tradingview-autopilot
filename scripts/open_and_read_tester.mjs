import { evaluate } from "../src/connection.js";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Try to open the strategy tester panel
const openResult = await evaluate(`(function(){
  try {
    var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
    if (bwb) {
      // Try strategy tester tab
      if (typeof bwb.activateStrategyTesterTab === 'function') { bwb.activateStrategyTesterTab(); return 'activateStrategyTesterTab'; }
      if (typeof bwb.showWidget === 'function') { bwb.showWidget('strategy-tester'); return 'showWidget strategy-tester'; }
    }
    // Try clicking via data-name
    var btn = document.querySelector('[data-name="backtesting-dialog-button"]') ||
              document.querySelector('[aria-label*="Strategy Tester"]') ||
              document.querySelector('[data-name="strategy-tester"]');
    if (btn) { btn.click(); return 'clicked: ' + (btn.getAttribute('data-name') || btn.ariaLabel); }

    // List available bottom bar items
    var items = document.querySelectorAll('[class*="bottomBar"] button, [class*="bottom-bar"] button');
    var names = [];
    items.forEach(function(el) {
      names.push((el.getAttribute('data-name') || el.getAttribute('aria-label') || el.textContent || '').substring(0, 30));
    });
    return 'bottom bar items: ' + names.join(' | ');
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Open tester:', openResult);

await sleep(3000);

// Read the tester with a wider selector
const dom = await evaluate(`(function(){
  try {
    var selectors = [
      '[class*="backtesting"]',
      '[class*="strategyTester"]',
      '[class*="strategy-tester"]',
      '[data-name="strategy-tester"]'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el && el.textContent.trim().length > 20) {
        return selectors[i] + ': ' + el.textContent.replace(/\\s+/g, ' ').substring(0, 500);
      }
    }
    return 'panel not found. Body contains: ' + (document.body.textContent.indexOf('Total trades') >= 0 ? 'Total trades YES' : 'Total trades NO');
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('DOM:', dom.substring(0, 600));
