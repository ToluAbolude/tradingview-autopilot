import { evaluate } from '../../src/connection.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));

await evaluate(`(function(){
  var btns = document.querySelectorAll('button');
  for (var i=0;i<btns.length;i++) if ((btns[i].textContent||'').trim()==='Positions') { btns[i].click(); return; }
})()`);
await sleep(1200);

const html = await evaluate(`(function(){
  var rows = Array.from(document.querySelectorAll('tr'));
  var wti = rows.find(function(r){
    var t = (r.innerText||'').replace(/\\s+/g,' ').trim();
    return t.toUpperCase().startsWith('WTILONG') || t.toUpperCase().startsWith('WTI LONG');
  });
  if (!wti) return 'no WTI row';
  // Trim attributes, keep structure
  return wti.outerHTML.substring(0, 4000);
})()`);
console.log(html);
