/**
 * probe_wti_symbol.mjs — Diagnose why WTI orders silently fail at BlackBull.
 * Investigates:
 *   1. What symbol the Trade panel is showing when we attempt the trade
 *   2. Whether BlackBull's broker integration recognises BLACKBULL:WTI
 *   3. Any error toasts/messages visible in the DOM during/after submit
 *   4. The full list of broker symbols available, to find the correct oil ticker
 */
import { evaluate } from '../../src/connection.js';

async function snap(name, js) {
  console.log(`\n--- ${name} ---`);
  try {
    const out = await evaluate(js);
    console.log(out);
  } catch (e) { console.log('ERR:', e.message); }
}

// 1. Current symbol in the chart
await snap('Current chart symbol', `(function(){
  var sel = document.querySelector('[class*="symbol"]') ||
            document.querySelector('[data-name*="symbol"]') ||
            document.querySelector('button[class*="symbolNameText"]');
  return sel ? (sel.textContent || sel.innerText || '').slice(0, 80) : 'no selector match';
})()`);

// 2. Trade panel — what symbol does it show?
await snap('Click Trade tab + read panel header', `(function(){
  var btns = document.querySelectorAll('button');
  for (var i = 0; i < btns.length; i++) {
    if ((btns[i].textContent || '').trim() === 'Trade') { btns[i].click(); break; }
  }
  return 'clicked';
})()`);

await new Promise(r => setTimeout(r, 1500));

await snap('Trade panel current symbol/instrument', `(function(){
  // Look for instrument header in the trade panel
  var headings = document.querySelectorAll('[class*="instrument"], [class*="header"], h3, h4');
  var found = [];
  for (var i = 0; i < headings.length; i++) {
    var t = (headings[i].textContent || '').trim();
    if (t && t.length < 80 && /^[A-Z0-9._/-]+$/.test(t.replace(/[\s|\\u00A0]/g, ''))) {
      found.push(t);
    }
  }
  return JSON.stringify(found.slice(0, 20));
})()`);

// 3. Look for any error toasts/notifications on screen
await snap('Active notifications / error toasts', `(function(){
  var sel = '[class*="toast"], [class*="notification"], [class*="error"], [role="alert"]';
  var els = document.querySelectorAll(sel);
  var msgs = [];
  for (var i = 0; i < els.length; i++) {
    var t = (els[i].textContent || '').trim();
    if (t && t.length > 5 && t.length < 200) msgs.push(t);
  }
  return JSON.stringify(msgs.slice(0, 20));
})()`);

// 4. Click 'Notifications log' tab
await snap('Click Notifications log', `(function(){
  var btns = document.querySelectorAll('button');
  for (var i = 0; i < btns.length; i++) {
    if ((btns[i].textContent || '').trim() === 'Notifications log') { btns[i].click(); return 'clicked'; }
  }
  return 'not found';
})()`);

await new Promise(r => setTimeout(r, 1500));

await snap('Notifications log content (recent entries)', `(function(){
  var rows = Array.from(document.querySelectorAll('tr'));
  var hits = [];
  for (var i = 0; i < rows.length; i++) {
    var t = (rows[i].innerText || '').replace(/\\s+/g, ' ').trim();
    if (t.length > 10) hits.push(t.slice(0, 250));
  }
  return JSON.stringify(hits.slice(0, 30));
})()`);

// 5. Search BlackBull's available instruments — open the symbol search if accessible
await snap('Search "oil" — find broker-supported symbols', `(function(){
  // Looking for any element that mentions WTI/USOIL/CRUDE/OIL
  var keywords = ['WTI', 'USOIL', 'OIL', 'CRUDE', 'BRENT'];
  var els = document.querySelectorAll('*');
  var hits = new Set();
  for (var i = 0; i < els.length && hits.size < 30; i++) {
    var t = (els[i].textContent || '').trim();
    if (t.length > 30 || t.length < 3) continue;
    for (var k = 0; k < keywords.length; k++) {
      if (t === keywords[k] || t.indexOf(keywords[k]) === 0) {
        hits.add(t);
        break;
      }
    }
  }
  return JSON.stringify(Array.from(hits));
})()`);

console.log('\n=== Done ===\n');
process.exit(0);
