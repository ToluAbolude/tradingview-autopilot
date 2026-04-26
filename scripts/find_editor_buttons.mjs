/**
 * Enumerate all visible buttons in the Pine editor area.
 * We need to find the exact text/aria-label of the "Add to chart" button.
 */
import { evaluate } from "../src/connection.js";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// First make sure Pine editor is open
await evaluate(`(function(){
  var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
  if (bwb && typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
})()`);
await sleep(1000);

// Enumerate ALL visible buttons
const buttons = await evaluate(`(function(){
  var btns = document.querySelectorAll('button');
  var results = [];
  btns.forEach(function(b) {
    if (!b.offsetParent) return; // not visible
    var text = (b.textContent || '').trim().substring(0, 60);
    var ariaLabel = b.getAttribute('aria-label') || '';
    var title = b.getAttribute('title') || '';
    var dataName = b.getAttribute('data-name') || '';
    var cls = b.className || '';
    // Only include buttons near the Pine editor or with relevant text
    if (/add|update|chart|pine|compile|save|run|inject/i.test(text + ariaLabel + title + dataName) ||
        /pine|editor|script/i.test(cls)) {
      results.push({
        text: text,
        ariaLabel: ariaLabel,
        title: title,
        dataName: dataName,
        cls: cls.substring(0, 50)
      });
    }
  });
  return JSON.stringify(results);
})()`);
console.log('Pine editor buttons:', buttons);

// Also check for any toolbar with add/update buttons
const toolbar = await evaluate(`(function(){
  var tbars = document.querySelectorAll('[class*="toolbar"], [class*="Toolbar"], [class*="actionBar"]');
  var results = [];
  tbars.forEach(function(tb) {
    var text = (tb.textContent || '').trim().substring(0, 100);
    if (/add|update|chart|pine/i.test(text)) {
      results.push({ text: text, cls: (tb.className || '').substring(0, 50) });
    }
  });
  return JSON.stringify(results);
})()`);
console.log('Toolbars:', toolbar);
