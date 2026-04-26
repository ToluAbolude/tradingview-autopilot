import { evaluate } from '../../src/connection.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));

await sleep(500);

// First click the Positions tab to ensure broker panel is open
await evaluate(`(function() {
  var btns = document.querySelectorAll('button');
  for (var i = 0; i < btns.length; i++) {
    if ((btns[i].textContent || '').trim() === 'Positions') { btns[i].click(); break; }
  }
})()`);

await sleep(1000);

const result = await evaluate(`(function(){
  var out = {};

  // 1. Walk up from Balance span and dump ancestor HTML (truncated)
  var spans = document.querySelectorAll('span.apply-common-tooltip, [class*="apply-common-tooltip"]');
  for (var i = 0; i < spans.length; i++) {
    var t = (spans[i].textContent || '').trim();
    if (t === 'Balance') {
      // Dump up to 5 levels of parent outerHTML (first 300 chars each)
      var el = spans[i];
      for (var lvl = 0; lvl < 6; lvl++) {
        if (!el) break;
        out['bal_lvl' + lvl + '_tag'] = el.tagName + '.' + (el.className || '').substring(0, 60);
        out['bal_lvl' + lvl + '_text'] = (el.innerText || el.textContent || '').replace(/\\s+/g,' ').trim().substring(0, 120);
        el = el.parentElement;
      }
      break;
    }
  }

  // 2. Try document.body.innerText regex (after Positions tab click)
  var bodyText = document.body.innerText || '';
  var m1 = bodyText.match(/Balance[^\\d]{0,10}([\\d,]+\\.?\\d*)/);
  var m2 = bodyText.match(/Equity[^\\d]{0,10}([\\d,]+\\.?\\d*)/);
  out['body_balance'] = m1 ? m1[1] : null;
  out['body_equity']  = m2 ? m2[1] : null;

  // 3. Dump 200 chars around "Balance" in body text
  var idx = bodyText.indexOf('Balance');
  if (idx >= 0) out['body_context'] = bodyText.substring(Math.max(0, idx-20), idx+80).replace(/\\n/g,'|');

  // 4. Check for value spans adjacent to or inside the balance container
  // Look for any element whose text matches a number >= 1000 (likely balance)
  var allEls = document.querySelectorAll('span, div, td, p');
  var numericEls = [];
  for (var i = 0; i < allEls.length; i++) {
    var txt = (allEls[i].childNodes.length === 1 && allEls[i].firstChild.nodeType === 3)
      ? (allEls[i].textContent || '').trim()
      : '';
    if (/^[\\d,]{4,}(\\.\\d+)?$/.test(txt)) {
      numericEls.push({
        tag: allEls[i].tagName,
        cls: (allEls[i].className || '').substring(0, 60),
        val: txt,
        parent: (allEls[i].parentElement ? (allEls[i].parentElement.textContent || '').replace(/\\s+/g,' ').trim().substring(0,60) : '')
      });
    }
  }
  out['numeric_els'] = numericEls.slice(0, 15);

  return JSON.stringify(out, null, 2);
})()`);

console.log(result);
