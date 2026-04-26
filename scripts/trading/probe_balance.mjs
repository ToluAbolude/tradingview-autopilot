import { evaluate } from '../../src/connection.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));

await sleep(500);

const result = await evaluate(`(function(){
  // Find Balance/Equity/Profit labels with apply-common-tooltip class
  // and read their sibling/parent value elements
  var out = {};

  // Method 1: find spans with apply-common-tooltip containing Balance/Equity
  var spans = document.querySelectorAll('span.apply-common-tooltip, [class*="apply-common-tooltip"]');
  for (var i=0; i<spans.length; i++) {
    var t = (spans[i].textContent||'').trim();
    if (/^(Balance|Equity|Profit)$/.test(t)) {
      // Look for sibling or nearby value element
      var parent = spans[i].parentElement;
      if (parent) {
        var siblings = parent.children;
        for (var j=0;j<siblings.length;j++){
          var st = (siblings[j].textContent||'').trim();
          if (/^-?[\d,]+\.?\d*$/.test(st) || /^-?[\d,]+\.?\d*\s*(USD|GBP|EUR)?$/.test(st)) {
            out[t] = st;
          }
        }
        // Also try grandparent
        var gp = parent.parentElement;
        if (gp) {
          var gpText = gp.textContent.replace(/\\s+/g,' ').trim();
          if (!out[t]) out[t + '_ctx'] = gpText.substring(0,80);
        }
      }
    }
  }

  // Method 2: find title-tWnxJF90 rows and get value from sibling
  var titles = document.querySelectorAll('[class*="title-"]');
  for (var i=0; i<titles.length; i++) {
    var t = (titles[i].textContent||'').trim();
    if (/^(Account Balance|Equity|Margin|Free Margin)$/.test(t)) {
      var row = titles[i].closest('[class*="row"],[class*="item"],[class*="cell"],tr,li') || titles[i].parentElement;
      if (row) out['row_' + t] = row.textContent.replace(/\\s+/g,' ').trim().substring(0,80);
    }
  }

  return JSON.stringify(out, null, 2);
})()`);

console.log(result);
