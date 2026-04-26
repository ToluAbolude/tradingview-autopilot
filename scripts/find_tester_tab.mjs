import { evaluate } from "../src/connection.js";

// Enumerate ALL visible buttons to find Strategy Tester tab
const result = await evaluate(`(function(){
  try {
    // List ALL buttons with their text + attributes
    var btns = document.querySelectorAll('button, [role="tab"], [class*="tab"]');
    var found = [];
    btns.forEach(function(b) {
      if (!b.offsetParent) return;
      var text = (b.textContent || '').trim().substring(0, 40);
      var aria = b.getAttribute('aria-label') || '';
      var title = b.getAttribute('title') || '';
      var dn = b.getAttribute('data-name') || '';
      var cls = (b.className || '').substring(0, 50);
      if (/strategy|tester|backt/i.test(text + aria + title + dn + cls)) {
        found.push({ text, aria, title, dn, cls });
      }
    });
    if (found.length) return JSON.stringify(found);

    // Try bottomWidgetBar methods
    var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
    if (!bwb) return 'no bottomWidgetBar';
    var methods = Object.getOwnPropertyNames(Object.getPrototypeOf(bwb)).filter(k=>typeof bwb[k]==='function');
    return 'bwb methods: ' + methods.join(', ');
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Tester tab search:', result);
