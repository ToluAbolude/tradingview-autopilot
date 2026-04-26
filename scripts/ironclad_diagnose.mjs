/**
 * Diagnose why Ironclad fired 0 trades — test on EURUSD 15M + XAUUSD 15M
 * Also checks Pine errors and whether D1 pivots are registering
 */
import { evaluate } from '../src/connection.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Test on EURUSD 15M (original backtest pair from video) ──
console.log('Switching to EURUSD 15M...');
await evaluate(`(function(){
  var a = window.TradingViewApi._activeChartWidgetWV.value();
  a.setSymbol('BLACKBULL:EURUSD', null, true);
  a.setResolution('15');
})()`);
await sleep(5000);

await evaluate(`window.TradingView.bottomWidgetBar.showWidget('backtesting')`);
await sleep(3000);

const eurusd = await evaluate(`(function(){
  var el = document.querySelector('[class*="backtesting"]');
  if (!el) return 'no panel';
  return el.textContent.replace(/\s+/g,' ').substring(0, 1500);
})()`);
console.log('=== EURUSD 15M ===');
console.log(eurusd);

// ── Check Pine errors ──
const errors = await evaluate(`(function(){
  var err = document.querySelectorAll('[class*="error"], [class*="Error"], .error-list');
  var found = [];
  err.forEach(function(e) {
    if (e.offsetParent && e.textContent.trim().length > 3)
      found.push(e.textContent.trim().substring(0,100));
  });
  return found.join(' | ') || 'no errors visible';
})()`);
console.log('Pine errors:', errors);

// ── Check what chart data range is loaded ──
const range = await evaluate(`(function(){
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    var model = chart._chartWidget.model();
    var ms = model.mainSeries();
    var bars = ms.bars();
    var end = bars.lastIndex();
    var start = bars.firstIndex();
    var first = bars.valueAt(start);
    var last  = bars.valueAt(end);
    return 'bars=' + (end-start+1) + ' | first_t=' + (first ? new Date(first[0]*1000).toISOString().slice(0,10) : '?') + ' | last_t=' + (last ? new Date(last[0]*1000).toISOString().slice(0,10) : '?');
  } catch(e) { return 'err: ' + e.message; }
})()`);
console.log('Chart range:', range);

// ── Check if strategy data sources exist ──
const stratInfo = await evaluate(`(function(){
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    var model = chart._chartWidget.model().model();
    var sources = model.dataSources();
    var strats = [];
    sources.forEach(function(s) {
      var type = s.constructor ? s.constructor.name : '?';
      var title = '';
      try { title = s.metaInfo().shortTitle || s.metaInfo().description || ''; } catch(e) {}
      if (/strategy|strat/i.test(type) || /ironclad/i.test(title)) {
        strats.push(type + ':' + title);
      }
    });
    return strats.join(', ') || 'no strategy found (' + sources.length + ' sources)';
  } catch(e) { return 'err: ' + e.message; }
})()`);
console.log('Strategy data source:', stratInfo);
