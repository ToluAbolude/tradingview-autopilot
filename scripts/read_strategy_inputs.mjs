import { evaluate } from '../src/connection.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Get strategy inputs from the DOM (settings panel)
// Try to open settings for the strategy on chart
const openSettings = await evaluate(`(function(){
  // Find the gear/settings icon in the strategy tester header
  var el = document.querySelector('[class*="backtesting"]');
  if (!el) return 'no tester panel';

  // Look for settings buttons
  var btns = el.querySelectorAll('button, [class*="icon-"], [class*="settings"]');
  var found = [];
  btns.forEach(function(b) {
    if (!b.offsetParent) return;
    var al = b.getAttribute('aria-label') || '';
    var title = b.getAttribute('title') || '';
    var dn = b.getAttribute('data-name') || '';
    found.push('al=' + al + ' title=' + title + ' dn=' + dn + ' cls=' + (b.className||'').substring(0,40));
  });
  return found.join(' | ') || 'no buttons in tester';
})()`);
console.log('Tester buttons:', openSettings);

// Try to find the strategy on chart and get its inputs via API
const inputs = await evaluate(`(function(){
  try {
    // Try different API paths to get strategy
    var apis = [
      window.TradingViewApi,
      window.tvWidget,
      window.TradingView && window.TradingView.chartWidgets && window.TradingView.chartWidgets[0],
    ];

    for (var a = 0; a < apis.length; a++) {
      var api = apis[a];
      if (!api) continue;

      // Try chartWidget
      var cw = api._activeChartWidgetWV && api._activeChartWidgetWV.value ? api._activeChartWidgetWV.value() : null;
      if (!cw && api.chart) { try { cw = api.chart(); } catch(e) {} }
      if (!cw) continue;

      // Try panes
      var panes = typeof cw.getPanes === 'function' ? cw.getPanes() : [];
      for (var p = 0; p < panes.length; p++) {
        var sources = typeof panes[p].getSources === 'function' ? panes[p].getSources() : [];
        for (var s = 0; s < sources.length; s++) {
          var src = sources[s];
          try {
            var mi = src.metaInfo ? src.metaInfo() : null;
            var title = mi ? (mi.shortTitle || mi.name || '') : '';
            if (/alpha|kill|AK/i.test(title) || (mi && mi.is_pine_strategy)) {
              var inputInfo = src.getInputsInfo ? src.getInputsInfo() : null;
              return JSON.stringify({ title: title, inputs: inputInfo, id: src.id });
            }
          } catch(e) {}
        }
      }
    }
    return 'no strategy found via pane API';
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Strategy inputs:', inputs);

// Alternative: get inputs from the backtesting UI internal state
const backtestState = await evaluate(`(function(){
  try {
    // Look at the backtesting report element and find its React fiber
    var el = document.querySelector('[class*="backtestingReport-"]');
    if (!el) return 'no report';

    var fk;
    var curr = el;
    for (var i = 0; i < 20; i++) {
      if (!curr) break;
      fk = Object.keys(curr).find(function(k) { return k.startsWith('__reactFiber$'); });
      if (fk) break;
      curr = curr.parentElement;
    }
    if (!fk) return 'no fiber';

    var fiber = curr[fk];
    // Walk up to find the strategy report data
    for (var d = 0; d < 30; d++) {
      if (!fiber) break;
      var props = fiber.memoizedProps || {};
      if (props.report || props.strategy || props.performanceData || props.inputs) {
        return JSON.stringify(Object.keys(props).slice(0,15));
      }
      fiber = fiber.return;
    }
    return 'no strategy data in fiber';
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Backtest state:', backtestState);

// Check what debug_ha value is set to by looking at the chart study
const debugHaCheck = await evaluate(`(function(){
  try {
    // Find chart
    var chart = window.TradingViewApi._activeChartWidgetWV.value();

    // Get all studies from a broader API
    var allStudies = [];

    // Method 1: dataLayer
    if (window.tvWidget) {
      try { allStudies = window.tvWidget.chart().getAllStudies(); } catch(e) {}
    }

    // Method 2: internal chart model
    if (chart._model) {
      var model = chart._model;
      // Look for sources/studies
      if (model.getAllSources) {
        var srcs = model.getAllSources();
        srcs.forEach(function(s) { allStudies.push({ id: s.id, name: s.name || '' }); });
      }
    }

    return JSON.stringify(allStudies.slice(0,10));
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Debug HA check:', debugHaCheck);

// Direct read: current strategy tester's "more info" / "list of trades" tab
const tradeList = await evaluate(`(function(){
  // Find the "List of trades" tab and click it
  var tabs = document.querySelectorAll('[class*="tab-"], [role="tab"], button');
  for (var i = 0; i < tabs.length; i++) {
    var tab = tabs[i];
    if (!tab.offsetParent) continue;
    if (/list.of.trade/i.test(tab.textContent)) {
      tab.click();
      return 'clicked: ' + tab.textContent.trim().substring(0,30);
    }
  }
  return 'no list of trades tab';
})()`);
console.log('Trade list tab:', tradeList);
await sleep(1500);

// Read first few trades
const trades = await evaluate(`(function(){
  var el = document.querySelector('[class*="backtesting"]');
  if (!el) return 'no panel';
  var text = el.textContent.replace(/\s+/g,' ');
  // Find where trade list starts
  var idx = text.indexOf('Trade #');
  if (idx < 0) idx = text.indexOf('Entry');
  if (idx >= 0) return text.substring(idx, idx+1000);
  return text.substring(0, 500);
})()`);
console.log('Trade data:', trades.substring(0, 800));
