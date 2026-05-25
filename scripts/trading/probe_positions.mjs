/**
 * probe_positions.mjs — Dump the first 20 rows of the Positions tab.
 * Useful for inspecting what the position scraper sees.
 */
import { evaluate } from '../../src/connection.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));

await evaluate(`(function(){
  var btns = document.querySelectorAll('button');
  for (var i=0;i<btns.length;i++) {
    if ((btns[i].textContent||'').trim()==='Positions') { btns[i].click(); return; }
  }
})()`);
await sleep(1500);

const rows = await evaluate(`(function() {
  var trs = Array.from(document.querySelectorAll('tr'));
  return JSON.stringify(trs.slice(0, 30).map(function(r) {
    var cells = Array.from(r.querySelectorAll('td'));
    return {
      text: (r.innerText||'').replace(/\\s+/g,' ').trim().substring(0, 250),
      cellCount: cells.length,
      cells: cells.map(function(c){ return (c.textContent||'').trim().substring(0, 50); }),
    };
  }).filter(function(o){ return o.text; }));
})()`);

const parsed = JSON.parse(rows || '[]');
console.log(`Found ${parsed.length} rows.`);
parsed.forEach((r, i) => {
  console.log(`[${i}] cells=${r.cellCount} text="${r.text}"`);
  if (r.cellCount > 0) console.log(`     cells: ${JSON.stringify(r.cells)}`);
});
