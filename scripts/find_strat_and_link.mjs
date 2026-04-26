import { evaluate } from '../src/connection.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Check dataSources for strategy
const ds = await evaluate(`(function(){
  try {
    var sources = window.TradingViewApi.dataSources();
    var found = [];
    sources.forEach(function(s, i) {
      if (!s || !s.metaInfo) return;
      var mi = s.metaInfo();
      if (!mi) return;
      var title = mi.shortTitle || mi.name || mi.description || '';
      found.push(i + ':' + title);
    });
    return JSON.stringify(found);
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('All data sources:', ds);

// Check if any source is a strategy
const stratSrc = await evaluate(`(function(){
  try {
    var sources = window.TradingViewApi.dataSources();
    var strats = [];
    sources.forEach(function(s, i) {
      if (!s || !s.metaInfo) return;
      var mi = s.metaInfo();
      if (!mi) return;
      var type = mi.type || '';
      var pine = mi.is_pine_strategy || mi.isPineStrategy || false;
      var title = mi.shortTitle || mi.name || '';
      if (/strat/i.test(type) || pine || /alpha|kill/i.test(title)) {
        strats.push({ i: i, title: title, type: type, pine: pine });
      }
    });
    return JSON.stringify(strats);
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Strategy sources:', stratSrc);

// Toggle strategy tester: close then reopen
const toggle1 = await evaluate(`(function(){
  var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
  if (!bwb) return 'no bwb';
  if (typeof bwb.toggleWidget === 'function') { bwb.toggleWidget('strategy-tester'); return 'toggle1'; }
  return 'no toggle';
})()`);
console.log('Toggle close:', toggle1);
await sleep(1000);

const toggle2 = await evaluate(`(function(){
  var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
  if (!bwb) return 'no bwb';
  if (typeof bwb.showWidget === 'function') { bwb.showWidget('strategy-tester'); return 'show'; }
  return 'no show';
})()`);
console.log('Toggle open:', toggle2);
await sleep(3000);

// Read tester
const tester = await evaluate(`(function(){
  var el = document.querySelector('[class*="backtesting"]');
  if (!el) return 'no panel';
  return el.textContent.replace(/\s+/g,' ').substring(0,600);
})()`);
console.log('Tester after toggle:', tester);

// Also look for ANY elements showing trade counts or strategy names
const tradeSearch = await evaluate(`(function(){
  var body = document.body.textContent;
  var idx = body.indexOf('Total trades');
  if (idx >= 0) return 'FOUND Total trades: ' + body.slice(idx-10, idx+100);
  idx = body.indexOf('Net profit');
  if (idx >= 0) return 'FOUND Net profit: ' + body.slice(idx-10, idx+100);
  idx = body.indexOf('Percent profitable');
  if (idx >= 0) return 'FOUND %profitable: ' + body.slice(idx-10, idx+100);
  return 'No trade stats in DOM';
})()`);
console.log('Trade search:', tradeSearch);
