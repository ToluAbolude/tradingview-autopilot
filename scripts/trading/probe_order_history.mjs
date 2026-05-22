/**
 * probe_order_history.mjs — Pull BlackBull's actual Order History from TradingView's
 * broker panel via CDP. This is the authoritative source (the broker's own ledger)
 * vs the bot's trades.csv which only records what the bot TRIED to do.
 */
import { evaluate } from '../../src/connection.js';

async function clickButtonExact(text) {
  const js = `(function(){
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if ((btns[i].textContent || '').trim() === '${text}') { btns[i].click(); return 'clicked'; }
    }
    return 'not found: ' + ${JSON.stringify(text)};
  })()`;
  return await evaluate(js);
}

async function clickButtonContains(text) {
  const js = `(function(){
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].textContent || '').trim();
      if (t.indexOf('${text}') === 0 || t === '${text}') { btns[i].click(); return 'clicked: ' + t; }
    }
    return 'not found: ${text}';
  })()`;
  return await evaluate(js);
}

async function tableRows() {
  const js = `(function(){
    var rows = Array.from(document.querySelectorAll('tr'));
    return JSON.stringify(rows.map(function(r){
      return (r.innerText || '').split(String.fromCharCode(10)).join(' | ').slice(0, 250);
    }).filter(function(t){return t && t.length > 10;}));
  })()`;
  return JSON.parse(await evaluate(js));
}

console.log('\n=== Clicking "Order history" tab ===');
console.log(await clickButtonExact('Order history'));
await new Promise(r => setTimeout(r, 2000));

console.log('\n=== Filter: All ===');
console.log(await clickButtonContains('All '));
await new Promise(r => setTimeout(r, 1500));
const allRows = await tableRows();
console.log(`Rows: ${allRows.length}`);
console.log('First 5:');
allRows.slice(0, 5).forEach(r => console.log(' ', r));

console.log('\n=== Filter: Rejected ===');
console.log(await clickButtonContains('Rejected'));
await new Promise(r => setTimeout(r, 1500));
const rejRows = await tableRows();
console.log(`Rejected rows: ${rejRows.length}`);
rejRows.forEach(r => console.log(' ', r));

console.log('\n=== Filter: Cancelled ===');
console.log(await clickButtonContains('Cancelled'));
await new Promise(r => setTimeout(r, 1500));
const canRows = await tableRows();
console.log(`Cancelled rows: ${canRows.length}`);
canRows.slice(0, 10).forEach(r => console.log(' ', r));

console.log('\n=== Filter: Filled ===');
console.log(await clickButtonContains('Filled'));
await new Promise(r => setTimeout(r, 1500));
const fillRows = await tableRows();
console.log(`Filled rows: ${fillRows.length}`);
fillRows.slice(0, 10).forEach(r => console.log(' ', r));

process.exit(0);
