import { evaluate } from '../src/connection.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const changed = await evaluate(`(function(){
  try {
    var api = window.TradingViewApi;
    var chart = api._activeChartWidgetWV.value();
    chart.setResolution('5');
    return 'changed to 5';
  } catch(e) { return 'err: ' + e.message; }
})()`);
console.log('TF change:', changed);
await sleep(6000);

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
console.log('=== 5M RESULTS ===');
console.log(results);
