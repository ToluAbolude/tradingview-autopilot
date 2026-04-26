import { evaluate } from '../src/connection.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Check current visible range
const range = await evaluate(`(function(){
  try {
    var api = window.TradingViewApi;
    var chart = api._activeChartWidgetWV.value();
    var vr = chart.getVisibleRange();
    return JSON.stringify(vr);
  } catch(e) { return 'err: ' + e.message; }
})()`);
console.log('Current range:', range);

// Scroll back by 10000 bars (5M × 10000 = ~35 trading days = ~7 weeks)
// Need to go back ~6 months, so try 30000 bars
const scroll = await evaluate(`(function(){
  try {
    var api = window.TradingViewApi;
    var chart = api._activeChartWidgetWV.value();
    chart.scrollChartByBar(-30000, true);
    return 'scrolled -30000 bars';
  } catch(e) { return 'err: ' + e.message; }
})()`);
console.log('Scroll:', scroll);
await sleep(3000);

// Try setVisibleRange with correct parameter format
const setRange = await evaluate(`(function(){
  try {
    var api = window.TradingViewApi;
    var chart = api._activeChartWidgetWV.value();
    // Nov 1 2025 to today
    chart.setVisibleRange({ from: 1746057600, to: Math.floor(Date.now()/1000) });
    return 'setVisibleRange called';
  } catch(e) { return 'err2: ' + e.message; }
})()`);
console.log('SetRange:', setRange);
await sleep(3000);

const range2 = await evaluate(`(function(){
  try {
    var api = window.TradingViewApi;
    var chart = api._activeChartWidgetWV.value();
    var vr = chart.getVisibleRange();
    return JSON.stringify(vr);
  } catch(e) { return 'err: ' + e.message; }
})()`);
console.log('New range:', range2);

await evaluate(`window.TradingView.bottomWidgetBar.showWidget('backtesting')`);
await sleep(4000);

const results = await evaluate(`(function(){
  var el = document.querySelector('[class*="backtesting"]');
  if (!el) return 'no panel';
  var t = el.textContent.replace(/\s+/g,' ');
  var idx = t.indexOf('Total trade');
  if (idx >= 0) return t.substring(idx, idx+300);
  return t.substring(0,300);
})()`);
console.log('=== RESULTS ===');
console.log(results);
