import { evaluate } from "../src/connection.js";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Enumerate all clickable items in the bottom widget bar
const tabs = await evaluate(`(function(){
  try {
    var bwb = window.TradingView && window.TradingView.bottomWidgetBar;

    // Try various method names to activate strategy tester
    var methods = bwb ? Object.getOwnPropertyNames(Object.getPrototypeOf(bwb)) : [];
    var stratMethods = methods.filter(function(m){ return /strat|backt|test/i.test(m); });

    // Try them all
    for (var i = 0; i < stratMethods.length; i++) {
      try { bwb[stratMethods[i]](); } catch(e) {}
    }

    // Also try showWidget with different names
    var names = ['backtesting', 'strategy_tester', 'strategyTester', 'strategy-tester',
                 'strategy_tester_panel', 'backtesting_panel'];
    for (var j = 0; j < names.length; j++) {
      try { if (typeof bwb.showWidget === 'function') bwb.showWidget(names[j]); } catch(e) {}
    }

    // Try clicking the strategy tester icon in the TradingView toolbar
    var allBtns = document.querySelectorAll('[data-name], button[aria-label]');
    var clicked = [];
    allBtns.forEach(function(b) {
      var dn = b.getAttribute('data-name') || '';
      var al = b.getAttribute('aria-label') || '';
      if (/backt|strategy.test|strat.*test/i.test(dn + al)) {
        b.click();
        clicked.push(dn || al);
      }
    });

    return JSON.stringify({ stratMethods: stratMethods, clicked: clicked, bwbMethods: methods.slice(0, 20) });
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Tab activation:', tabs);

await sleep(3000);

// Read the bottom widget bar content
const dom = await evaluate(`(function(){
  try {
    // Try the broadest possible search
    var el = document.querySelector('[class*="backtesting"]') ||
             document.querySelector('[class*="strategyTester"]') ||
             document.querySelector('[class*="backtestReport"]');

    if (el) return 'FOUND: ' + el.textContent.replace(/\\s+/g, ' ').substring(0, 400);

    // Check if the strategy tester tab was added to bottom bar
    var bottomBar = document.querySelector('[class*="bottomWidget"], [class*="BottomWidget"]');
    if (bottomBar) return 'bottomBar: ' + bottomBar.textContent.replace(/\\s+/g, ' ').substring(0, 200);

    return 'nothing found';
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('DOM after activation:', dom.substring(0, 500));
