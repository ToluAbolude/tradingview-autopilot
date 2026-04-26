import { evaluate } from '../src/connection.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Scroll chart back to Nov 2025 to load full history
const scrolled = await evaluate(`(function(){
  try {
    var api = window.TradingViewApi;
    var chart = api._activeChartWidgetWV.value();
    // Nov 1 2025 unix timestamp
    var from = 1746057600; // Apr 1 2025
    var to   = Math.floor(Date.now() / 1000);
    if (chart.setVisibleRange) {
      chart.setVisibleRange({ from: from, to: to });
      return 'setVisibleRange called';
    }
    return 'no setVisibleRange';
  } catch(e) { return 'err: ' + e.message; }
})()`);
console.log('Scroll:', scrolled);
await sleep(3000);

// Try scrolling further back
const scrolled2 = await evaluate(`(function(){
  try {
    var api = window.TradingViewApi;
    var chart = api._activeChartWidgetWV.value();
    var from = 1730419200; // Nov 1 2025
    var to   = Math.floor(Date.now() / 1000);
    if (chart.setVisibleRange) {
      chart.setVisibleRange({ from: from, to: to });
      return 'scrolled to Nov 1 2025';
    }
    return 'no setVisibleRange';
  } catch(e) { return 'err: ' + e.message; }
})()`);
console.log('Scroll2:', scrolled2);
await sleep(5000);

// Open strategy tester
await evaluate(`window.TradingView.bottomWidgetBar.showWidget('backtesting')`);
await sleep(3000);

const results = await evaluate(`(function(){
  var el = document.querySelector('[class*="backtesting"]');
  if (!el) return 'no panel';
  var t = el.textContent.replace(/\s+/g,' ');
  var idx = t.indexOf('Total trade');
  if (idx >= 0) return t.substring(idx, idx+400);
  return t.substring(0,400);
})()`);
console.log('=== RESULTS AFTER SCROLL ===');
console.log(results);
