/**
 * Read backtest stats from TradingView Strategy Tester DOM.
 * Waits for the data to be populated, then reads it.
 */
import { evaluate } from "../src/connection.js";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Wait for backtest to calculate
const waitSecs = parseInt(process.argv[2] || '15');
console.log(`Waiting ${waitSecs}s for backtest to calculate...`);
await sleep(waitSecs * 1000);

const result = await evaluate(`(function(){
  try {
    var sel = '[class*="backtesting"]';
    var el = document.querySelector(sel);
    if (!el) return 'strategy-tester panel not found';
    var t = el.textContent || '';
    // Extract key stats from text
    function getVal(label) {
      var idx = t.indexOf(label);
      if (idx < 0) return null;
      var after = t.slice(idx + label.length, idx + label.length + 50).trim();
      var m = after.match(/^([\\d,\\.\\-]+)/);
      return m ? m[1] : after.substring(0, 20);
    }
    return JSON.stringify({
      name:    t.match(/^([\\w\\s_]+)(?=Feb|Jan|Mar|Apr|May)/)?.[1]?.trim(),
      period:  t.match(/(\\w+ \\d+, \\d{4} \\u2014 \\w+ \\d+, \\d{4})/)?.[1],
      totalPL: getVal('Total P&L'),
      totalTrades: getVal('Total trades'),
      profitFactor: getVal('Profit factor'),
      maxDD: getVal('Max equity drawdown'),
      profitable: t.indexOf('Profitable trades') >= 0 ? getVal('Profitable trades') : null
    });
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Strategy Tester:', result);
