import { evaluate } from '../src/connection.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Click "Metric" tab in strategy tester to show performance stats
await evaluate(`(function(){
  var btns = document.querySelectorAll('[class*="roundTabButton-"], button');
  for (var i = 0; i < btns.length; i++) {
    var b = btns[i];
    if (!b.offsetParent) continue;
    var text = (b.textContent||'').trim();
    if (/^metric|^performance|^summary/i.test(text)) { b.click(); return; }
  }
})()`);
await sleep(1000);

const stats = await evaluate(`(function(){
  var el = document.querySelector('[class*="backtesting"]');
  if (!el) return 'no panel';
  var text = el.textContent.replace(/\s+/g,' ');
  // Find the stats section
  var idx = text.indexOf('Total P&L');
  if (idx < 0) idx = text.indexOf('Total trade');
  if (idx >= 0) return text.substring(idx, idx + 800);
  return text.substring(0,800);
})()`);
console.log('=== STATS ===');
console.log(stats);
