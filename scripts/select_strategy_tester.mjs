/**
 * Select Alpha Kill in Strategy Tester by:
 * 1. Finding the AK strategy instance on chart
 * 2. Opening it in Pine editor (which links tester to it)
 * 3. Updating on chart
 */
import { evaluate, getClient } from '../src/connection.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dir, '../scripts/current.pine'), 'utf-8');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Step 1: Find Alpha Kill entity ID on chart ────────────────────────────────
const akId = await evaluate(`(function(){
  try {
    var chart = window.TradingViewApi && window.TradingViewApi._activeChartWidgetWV && window.TradingViewApi._activeChartWidgetWV.value();
    if (!chart) return 'no-chart';
    var studies = chart.getAllStudies ? chart.getAllStudies() : [];
    for (var i = 0; i < studies.length; i++) {
      var s = studies[i];
      var name = (s.name || (s.metaInfo && s.metaInfo().shortTitle) || '').toLowerCase();
      if (/alpha.kill|ak_v/i.test(name)) {
        return JSON.stringify({ id: s.id, name: name });
      }
    }
    // Also try panewidgets
    var panes = chart.getPanes ? chart.getPanes() : [];
    for (var p = 0; p < panes.length; p++) {
      var sources = panes[p].getSources ? panes[p].getSources() : [];
      for (var ss = 0; ss < sources.length; ss++) {
        var src2 = sources[ss];
        var n = (src2.metaInfo && src2.metaInfo().shortTitle || src2.name || '').toLowerCase();
        if (/alpha.kill|ak_v/i.test(n)) {
          return JSON.stringify({ id: src2.id, name: n });
        }
      }
    }
    return 'not-found. Studies count: ' + studies.length;
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('AK entity:', akId);

// ── Step 2: Try to open AK in Pine editor via internal API ────────────────────
let parsed;
try { parsed = JSON.parse(akId); } catch(e) { parsed = null; }

if (parsed && parsed.id) {
  const openInEditor = await evaluate(`(function(){
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var entityId = ${JSON.stringify(parsed.id)};
      // Try various methods to open this entity in the editor
      if (typeof chart.openPineEditor === 'function') {
        chart.openPineEditor(entityId);
        return 'openPineEditor';
      }
      if (typeof chart.editStudy === 'function') {
        chart.editStudy(entityId);
        return 'editStudy';
      }
      // Try clicking on the entity label/name in the chart
      var labels = document.querySelectorAll('[class*="paneTitle"], [class*="study-title"], [class*="StudyTitle"]');
      for (var i = 0; i < labels.length; i++) {
        var l = labels[i];
        if (/alpha.kill|ak_v/i.test(l.textContent)) {
          // Double click to open editor
          l.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          return 'dblclick: ' + l.textContent.trim().substring(0,30);
        }
      }
      return 'no-open-method';
    } catch(e) { return 'err:' + e.message; }
  })()`);
  console.log('Open in editor:', openInEditor);
  await sleep(1500);
}

// ── Step 3: Use bwb.getWidgetByName to get strategy tester widget ─────────────
const testerInfo = await evaluate(`(function(){
  try {
    var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
    if (!bwb) return 'no bwb';
    var w = typeof bwb.getWidgetByName === 'function' ? bwb.getWidgetByName('strategy-tester') : null;
    if (!w) return 'no widget';
    var methods = Object.getOwnPropertyNames(Object.getPrototypeOf(w)).filter(function(k){ return typeof w[k] === 'function'; });
    return 'widget methods: ' + methods.slice(0,20).join(', ');
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Tester widget:', testerInfo);

// ── Step 4: Look for "Load your strategy" button or dropdown in tester ─────────
const loadBtn = await evaluate(`(function(){
  try {
    var el = document.querySelector('[class*="backtesting"]');
    if (!el) return 'no panel';
    // Find all interactive elements
    var btns = el.querySelectorAll('button, [role="button"], [class*="select"], [class*="dropdown"]');
    var found = [];
    btns.forEach(function(b) {
      var text = (b.textContent || '').trim().substring(0,40);
      var title = b.getAttribute('title') || '';
      var cls = (b.className || '').substring(0,50);
      found.push('text=' + text + ' title=' + title + ' cls=' + cls);
    });
    if (found.length) return found.join(' | ');
    return 'no buttons in panel. Panel text: ' + el.textContent.substring(0,200);
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Load strategy area:', loadBtn);

// ── Step 5: Try to open alpha kill directly in strategy tester via internal API ─
const directSelect = await evaluate(`(function(){
  try {
    // Look for strategy tester widget and its loadStrategy / selectStrategy methods
    var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
    if (!bwb) return 'no bwb';
    var w = typeof bwb.getWidgetByName === 'function' ? bwb.getWidgetByName('strategy-tester') : null;
    if (!w) {
      // Try activating it first
      bwb.showWidget('strategy-tester');
      w = bwb.getWidgetByName('strategy-tester');
    }
    if (!w) return 'no widget after show';
    // Look for load/select/set methods
    var proto = Object.getPrototypeOf(w);
    var allMethods = [];
    while(proto && proto !== Object.prototype) {
      allMethods = allMethods.concat(Object.getOwnPropertyNames(proto).filter(function(k){ return typeof w[k]==='function'; }));
      proto = Object.getPrototypeOf(proto);
    }
    var selectMethods = allMethods.filter(function(m){ return /load|select|set|strat|source/i.test(m); });
    return 'select methods: ' + selectMethods.slice(0,15).join(', ');
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Direct select:', directSelect);

// ── Step 6: Try clicking on the strategy tester button in pine editor bottom bar
// Then check if we can find a "select strategy" option
const pinetesterBtn = await evaluate(`(function(){
  try {
    // Look for the strategy tester button at the bottom of the Pine editor
    var allBtns = document.querySelectorAll('[data-name="backtesting-dialog-button"], button[aria-label*="Strategy"], button[title*="Strategy"]');
    var info = [];
    allBtns.forEach(function(b) {
      info.push('dn=' + (b.getAttribute('data-name')||'') + ' al=' + (b.getAttribute('aria-label')||'') + ' title=' + (b.getAttribute('title')||''));
    });
    return info.join(' | ') || 'none';
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Strategy tester btn:', pinetesterBtn);
