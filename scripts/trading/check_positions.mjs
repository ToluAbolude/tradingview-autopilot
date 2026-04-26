import { evaluate } from '../../src/connection.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Click Positions tab
await evaluate(`(function(){
  var btns = document.querySelectorAll('button');
  for (var i=0;i<btns.length;i++){
    if((btns[i].textContent||'').trim()==='Positions'){btns[i].click();return;}
  }
})()`);
await sleep(1500);

const r = await evaluate(`(function(){
  var t = document.body.innerText || '';
  var noPos  = /no open position|there are no open po/i.test(t);
  var bal    = (t.match(/Balance[\\s\\n]*([\\d.,]+)/) || [])[1];
  var eq     = (t.match(/Equity[\\s\\n]*([\\d.,]+)/) || [])[1];
  var profit = (t.match(/Profit[\\s\\n]*(-?[\\d.,]+)/) || [])[1];

  // Try to find position rows (tables)
  var rows = [];
  var trs = document.querySelectorAll('tr, [class*="row"], [class*="position"]');
  for (var i=0;i<Math.min(trs.length,30);i++){
    var txt = (trs[i].textContent||'').replace(/\\s+/g,' ').trim();
    if (txt.length > 10 && txt.length < 200 && /\\d/.test(txt)) rows.push(txt);
  }

  return JSON.stringify({ noPos, bal, eq, profit, rows: rows.slice(0,10) });
})()`);
const d = JSON.parse(r);
console.log(`Positions open: ${!d.noPos}`);
console.log(`Balance: ${d.bal} | Equity: ${d.eq} | Float PnL: ${d.profit}`);
console.log('Rows:');
(d.rows||[]).forEach(r => console.log(' ', r));
