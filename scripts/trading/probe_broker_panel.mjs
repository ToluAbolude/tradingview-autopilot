/**
 * probe_broker_panel.mjs — One-off probe to discover what BlackBull broker tabs
 * expose actual trade history vs just open positions.
 * Run on VM: node scripts/trading/probe_broker_panel.mjs
 */
import { evaluate } from '../../src/connection.js';

async function clickTab(name) {
  const js = `(function(){
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if ((btns[i].textContent || '').trim() === '${name}') { btns[i].click(); return 'clicked'; }
    }
    return 'not found';
  })()`;
  const res = await evaluate(js);
  await new Promise(r => setTimeout(r, 1500));
  return res;
}

async function snapshot() {
  const js = `(function(){
    var rows = Array.from(document.querySelectorAll('tr'));
    var samples = [];
    for (var i = 0; i < Math.min(rows.length, 8); i++) {
      var t = (rows[i].innerText || '').slice(0, 200);
      t = t.split(String.fromCharCode(10)).join(' | ');
      samples.push(t);
    }
    return JSON.stringify({ rowCount: rows.length, samples: samples });
  })()`;
  return await evaluate(js);
}

async function listAllTabs() {
  const js = `(function(){
    var btns = Array.from(document.querySelectorAll('button'));
    return JSON.stringify(btns.map(function(b){return (b.textContent||'').trim();}).filter(function(t){return t && t.length > 0 && t.length < 40;}));
  })()`;
  return await evaluate(js);
}

async function findExportButton() {
  const js = `(function(){
    var keywords = ['Export', 'Download', 'CSV', 'Statement', 'History', 'Print'];
    var matches = [];
    var els = document.querySelectorAll('button, a');
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].textContent || '').trim();
      for (var k = 0; k < keywords.length; k++) {
        if (t.indexOf(keywords[k]) >= 0 && t.length < 50) {
          matches.push(t);
          break;
        }
      }
    }
    return JSON.stringify(matches.slice(0, 20));
  })()`;
  return await evaluate(js);
}

console.log('\n=== All tabs/buttons present ===');
console.log(await listAllTabs());

for (const tab of ['Trade', 'Positions', 'Orders', 'All', 'Account summary']) {
  console.log(`\n=== Clicking "${tab}" ===`);
  const c = await clickTab(tab);
  console.log('click result:', c);
  const s = await snapshot();
  console.log('table snapshot:', s);
}

console.log('\n=== Export/Download/History buttons anywhere on page ===');
console.log(await findExportButton());

process.exit(0);
