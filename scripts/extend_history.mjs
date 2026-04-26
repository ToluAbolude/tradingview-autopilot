import { evaluate, getClient } from '../src/connection.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const client = await getClient();

// Click on the chart first to focus it
await evaluate(`(function(){
  var canvas = document.querySelector('canvas');
  if (canvas) canvas.click();
})()`);
await sleep(500);

// Try available chart API methods to extend range
const methods = await evaluate(`(function(){
  try {
    var api = window.TradingViewApi;
    var chart = api._activeChartWidgetWV.value();
    return Object.getOwnPropertyNames(Object.getPrototypeOf(chart))
      .filter(m => /scroll|range|jump|goto|date|zoom|history|bar/i.test(m))
      .join(', ');
  } catch(e) { return 'err: ' + e.message; }
})()`);
console.log('Chart methods:', methods);

// Try scrollToDate (the standard TV method)
const jump = await evaluate(`(function(){
  try {
    var api = window.TradingViewApi;
    var chart = api._activeChartWidgetWV.value();
    if (chart.scrollToDate) {
      chart.scrollToDate(new Date('2025-11-01').getTime() / 1000);
      return 'scrollToDate called';
    }
    if (chart.jumpToBar) {
      chart.jumpToBar(-5000);
      return 'jumpToBar -5000';
    }
    return 'no method found';
  } catch(e) { return 'err: ' + e.message; }
})()`);
console.log('Jump:', jump);
await sleep(3000);

// Use keyboard: Home key to jump to beginning
await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
await client.Input.dispatchKeyEvent({ type: 'keyUp',   key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
await sleep(2000);

// Send many left arrows to scroll back
for (let i = 0; i < 10; i++) {
  await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
  await client.Input.dispatchKeyEvent({ type: 'keyUp',   key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
  await sleep(100);
}
await sleep(3000);

// Read the current backtest date range
const results = await evaluate(`(function(){
  var el = document.querySelector('[class*="backtesting"]');
  if (!el) return 'no panel';
  var t = el.textContent.replace(/\s+/g,' ');
  var idx = t.indexOf('Total trade');
  if (idx >= 0) return t.substring(idx, idx+300);
  // grab the date range shown
  var dateIdx = t.indexOf('Nov');
  if (dateIdx < 0) dateIdx = t.indexOf('202');
  if (dateIdx >= 0) return t.substring(Math.max(0,dateIdx-20), dateIdx+300);
  return t.substring(0,300);
})()`);
console.log('Results after scroll:', results);
