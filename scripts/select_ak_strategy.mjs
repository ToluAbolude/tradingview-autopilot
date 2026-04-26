/**
 * Select Alpha Kill in TradingView Strategy Tester to populate its backtest data.
 * TradingView only calculates reportData for the CURRENTLY SELECTED strategy.
 */
import { evaluate } from "../src/connection.js";
const sleep = ms => new Promise(r => setTimeout(r, ms));

await sleep(500);

// Step 1: Find what strategy names/IDs are available
const sources = await evaluate(`(function(){
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var src = chart.model().model().dataSources();
    var out = [];
    for (var i = 0; i <= Math.max(src.length || 0, 50); i++) {
      var s = src[i];
      if (!s || !s.metaInfo) continue;
      try {
        var m = s.metaInfo();
        var n = m.description || m.shortTitle || '';
        if (/Alpha Kill|AK_Simple|OkalaNQ/i.test(n)) {
          // Check if there's a selectOnChart method or similar
          var methods = Object.getOwnPropertyNames(Object.getPrototypeOf(s)).filter(k => typeof s[k] === 'function').slice(0, 20);
          out.push({ i: i, n: n, id: m.shortId || '' });
        }
      } catch(e) {}
    }
    return JSON.stringify(out);
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Strategies:', sources);

// Step 2: Try to find the strategy tester and switch its selected strategy
// TradingView has a StrategyBenchmarkService or similar
const selectResult = await evaluate(`(function(){
  try {
    // Method 1: Look for strategy tester widget
    var tv = window.TradingViewApi;
    var chart = tv._activeChartWidgetWV.value();

    // Try to find select strategy in chart widget methods
    var chartMethods = [];
    var cw = chart;
    // Walk prototype chain
    var proto = Object.getPrototypeOf(cw);
    while (proto && proto !== Object.prototype) {
      Object.getOwnPropertyNames(proto).forEach(function(k) {
        if (/strategy|select|tester|bench/i.test(k)) chartMethods.push(k);
      });
      proto = Object.getPrototypeOf(proto);
    }

    // Also check chart widget value
    var cwv = chart._chartWidget || chart.value && chart.value();
    if (cwv) {
      proto = Object.getPrototypeOf(cwv);
      while (proto && proto !== Object.prototype) {
        Object.getOwnPropertyNames(proto).forEach(function(k) {
          if (/strategy|select|tester|bench/i.test(k)) chartMethods.push('chartWidget.'+k);
        });
        proto = Object.getPrototypeOf(proto);
      }
    }

    return JSON.stringify(chartMethods.slice(0, 30));
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Strategy-related methods:', selectResult);

// Step 3: Try clicking on the AK strategy in the chart legend via DOM
const clickResult = await evaluate(`(function(){
  try {
    // Find strategy tester "select" buttons or the strategy name in the tester
    var allEls = document.querySelectorAll('[data-name], [class*=strategyTester], [class*=strategy-tester]');
    var found = [];
    allEls.forEach(function(el) {
      var t = (el.textContent || '').trim().substring(0, 50);
      if (/Alpha Kill|AK_Simple/i.test(t)) found.push(el.tagName + ':' + t);
    });
    return found.length ? found.join(' | ') : 'not found in DOM';
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('DOM search:', clickResult);
