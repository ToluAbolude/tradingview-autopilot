/**
 * Find and remove ALL strategies from the chart.
 * Strategies don't appear in getAllStudies() but ARE in the DOM legend.
 */
import { evaluate } from '../src/connection.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// First: close the open modal
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, keyCode:27}))`);
await sleep(500);

// Find the Checklist Reversal Strategy H2 and its parent container
const strategyInfo = await evaluate(`(function(){
  var h2s = document.querySelectorAll('h2, [class*="label-"], [class*="title-"]');
  var found = [];
  h2s.forEach(function(el) {
    if (!el.offsetParent) return;
    var text = el.textContent.trim();
    if (/checklist|reversal|alpha|kill|ORB|strategy/i.test(text)) {
      // Check for parent legend container
      var parent = el.parentElement;
      var depth = 0;
      var parentInfo = '';
      while (parent && depth < 5) {
        var cls = (parent.className||'').substring(0,50);
        var dn = parent.getAttribute('data-name') || '';
        parentInfo += depth + ':' + cls + '|' + dn + ' ';
        parent = parent.parentElement;
        depth++;
      }
      found.push({ tag: el.tagName, text: text.substring(0,50), cls: (el.className||'').substring(0,60), parents: parentInfo.substring(0,200) });
    }
  });
  return JSON.stringify(found);
})()`);
console.log('Strategy H2 info:', strategyInfo);

// Try to find and remove strategy via pane data API
const removeViaApi = await evaluate(`(function(){
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    var removed = [];
    // Try panes
    var panes = typeof chart.getPanes === 'function' ? chart.getPanes() : [];
    for (var p = 0; p < panes.length; p++) {
      var pane = panes[p];
      var sources = typeof pane.getSources === 'function' ? pane.getSources() : [];
      for (var s = 0; s < sources.length; s++) {
        var src = sources[s];
        try {
          var mi = src.metaInfo ? src.metaInfo() : null;
          var type = (mi && mi.type) || '';
          var pine = (mi && (mi.is_pine_strategy || mi.isPineStrategy)) || false;
          var title = (mi && (mi.shortTitle || mi.name || '')) || '';
          if (/strat/i.test(type) || pine || /checklist|reversal|alpha|kill|ORB/i.test(title)) {
            chart.removeEntity(src.id, {disableUndo:true});
            removed.push(title || 'unnamed_strategy');
          }
        } catch(e) {}
      }
    }
    return 'removed via pane: ' + removed.join(', ');
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Remove via pane API:', removeViaApi);
await sleep(500);

// Try direct DOM approach: find delete buttons near "Checklist" text
const removeViaDom = await evaluate(`(function(){
  try {
    // Look for strategy legend items
    var legendItems = document.querySelectorAll('[class*="legendItem-"], [class*="legend-item"], [class*="paneTitle"]');
    var clicked = [];
    legendItems.forEach(function(item) {
      if (!item.offsetParent) return;
      if (/checklist|reversal|alpha|kill/i.test(item.textContent)) {
        // Find delete/close button within this item
        var deleteBtn = item.querySelector('[class*="delete"], [class*="remove"], [aria-label*="Remove"], [aria-label*="Delete"], [title*="Remove"], [title*="Delete"]');
        if (!deleteBtn) deleteBtn = item.querySelector('button:last-child');
        if (deleteBtn) { deleteBtn.click(); clicked.push('delete in ' + item.textContent.trim().substring(0,30)); }
      }
    });
    return 'dom remove: ' + (clicked.join(', ') || 'nothing clicked');
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Remove via DOM:', removeViaDom);
await sleep(500);

// Look for the strategy in chart via right-click context or hover
// Try clicking on the chart legend area for the strategy
const legendClick = await evaluate(`(function(){
  try {
    // Find H2 with Checklist text and try clicking it to select
    var h2 = null;
    var all = document.querySelectorAll('h2, [class*="label-k49p41Es"]');
    all.forEach(function(el) {
      if (el.offsetParent && /checklist|reversal/i.test(el.textContent)) h2 = el;
    });
    if (!h2) return 'no h2 found';

    // Right click to get context menu
    h2.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true}));
    return 'right-clicked: ' + h2.textContent.trim().substring(0,30);
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Legend right click:', legendClick);
await sleep(1000);

// Check for context menu
const contextMenu = await evaluate(`(function(){
  var menus = document.querySelectorAll('[class*="menu-"], [class*="contextMenu"], [role="menu"]');
  var found = [];
  menus.forEach(function(m) {
    if (m.offsetParent) found.push(m.textContent.trim().substring(0,100));
  });
  return found.join(' | ') || 'no menu';
})()`);
console.log('Context menu:', contextMenu);

// Click "Remove" in context menu if present
await evaluate(`(function(){
  var items = document.querySelectorAll('[class*="menuItem-"], [class*="menu-item"], [role="menuitem"]');
  items.forEach(function(item) {
    if (item.offsetParent && /remove|delete/i.test(item.textContent)) item.click();
  });
})()`);
await sleep(500);

// Now check H2 status
const h2After = await evaluate(`(function(){
  var all = document.querySelectorAll('h2');
  var found = [];
  all.forEach(function(el) {
    if (el.offsetParent) found.push(el.textContent.trim().substring(0,50));
  });
  return found.join(' | ') || 'no h2s';
})()`);
console.log('H2 after cleanup:', h2After);
