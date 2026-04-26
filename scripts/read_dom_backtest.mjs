/**
 * Read backtest results from TradingView Strategy Tester DOM.
 * The DOM definitely shows results; we just need to find the right selectors.
 */
import { evaluate } from "../src/connection.js";
const sleep = ms => new Promise(r => setTimeout(r, ms));

await sleep(500);

// Method 1: Scan ALL text in the Strategy Tester area
const dom1 = await evaluate(`(function(){
  try {
    // Try to find the strategy tester container
    var selectors = [
      '[data-name="strategy-tester"]',
      '[class*="strategyTester"]',
      '[class*="strategy-tester"]',
      '[class*="backtesting"]',
      '[class*="report"]',
      '[class*="performance"]'
    ];
    for (var j = 0; j < selectors.length; j++) {
      var el = document.querySelector(selectors[j]);
      if (el && el.textContent.trim().length > 20) {
        return selectors[j] + ': ' + el.textContent.trim().substring(0, 300);
      }
    }
    return 'none found';
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('DOM method 1:', dom1.substring(0, 500));

// Method 2: Look for numeric stats in the bottom panel
const dom2 = await evaluate(`(function(){
  try {
    // Walk all bottom panel elements looking for "Total trades" / "Percent profitable"
    var allText = document.body.innerText;
    var patterns = [
      /Total trades[^\n]*\n[^\n]*/,
      /Percent profitable[^\n]*\n[^\n]*/,
      /Net profit[^\n]*\n[^\n]*/,
      /Profit factor[^\n]*\n[^\n]*/
    ];
    var found = [];
    patterns.forEach(function(p) {
      var m = allText.match(p);
      if (m) found.push(m[0].replace(/\\s+/g, ' ').trim());
    });
    return found.length ? found.join(' | ') : 'not found in body text';
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('DOM method 2:', dom2);

// Method 3: Check the strategy source's 'performance' property directly
const perf = await evaluate(`(function(){
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var src = chart.model().model().dataSources();
    for (var i = 0; i <= Math.max(src.length || 0, 50); i++) {
      var s = src[i];
      if (!s || !s.metaInfo) continue;
      try {
        var m = s.metaInfo();
        var n = m.description || m.shortTitle || '';
        if (!/Alpha Kill|AK_Simple|AK_v/i.test(n)) continue;

        // Try s.performance directly (not via reportData)
        var perf = s.performance ? (typeof s.performance === 'function' ? s.performance() : s.performance) : null;
        if (perf && typeof perf.value === 'function') perf = perf.value();

        // Also try other property names
        var propNames = Object.getOwnPropertyNames(s).filter(function(k) {
          return /perf|report|result|stat|trade|backtest/i.test(k);
        });

        return JSON.stringify({
          i: i, n: n,
          perfDirect: perf ? Object.keys(perf).slice(0, 10) : 'null',
          propNames: propNames
        });
      } catch(e) {}
    }
    return 'not found';
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Performance direct:', perf);
