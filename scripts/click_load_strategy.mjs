import { evaluate } from '../src/connection.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// List all studies on chart
const studies = await evaluate(`(function(){
  try {
    var chart = window.TradingViewApi && window.TradingViewApi._activeChartWidgetWV && window.TradingViewApi._activeChartWidgetWV.value();
    if (!chart) return 'no-chart';
    var ss = chart.getAllStudies ? chart.getAllStudies() : [];
    return JSON.stringify(ss.map(function(s){
      return { id: s.id, name: s.name, shortTitle: s.metaInfo && s.metaInfo().shortTitle };
    }));
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Studies:', studies);

// Open strategy tester
await evaluate(`(function(){
  var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
  if (bwb && typeof bwb.showWidget === 'function') bwb.showWidget('strategy-tester');
})()`);
await sleep(1000);

// Click "Load your strategy" button
const clickResult = await evaluate(`(function(){
  try {
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (!b.offsetParent) continue;
      if (/load.your.strategy/i.test(b.textContent)) {
        b.click();
        return 'clicked: ' + b.textContent.trim().substring(0,40);
      }
    }
    return 'button not found';
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Click result:', clickResult);
await sleep(2000);

// See what appeared after click
const afterClick = await evaluate(`(function(){
  try {
    // Look for a dialog/dropdown/list that appeared
    var dialogs = document.querySelectorAll('[role="dialog"], [class*="dialog"], [class*="modal"], [class*="popup"], [class*="dropdown"]');
    var found = [];
    dialogs.forEach(function(d) {
      if (d.offsetParent) {
        found.push('tag=' + d.tagName + ' cls=' + (d.className||'').substring(0,50) + ' text=' + d.textContent.trim().substring(0,100));
      }
    });
    if (found.length) return found.join(' | ');

    // Check if strategy tester panel changed
    var el = document.querySelector('[class*="backtesting"]');
    if (el) return 'tester: ' + el.textContent.replace(/\s+/g,' ').substring(0,300);
    return 'nothing new';
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('After click:', afterClick);
