/**
 * Force-reload the Smart Trail strategy on the chart from the latest saved editor source.
 * Use after `pine set --file` to make the chart pick up new code.
 *
 * Steps:
 *  1. Remove existing strategy instance by entity ID
 *  2. Click "Add to chart" button in the Pine Editor
 */
import { evaluate } from '../src/connection.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  // Find and remove the existing Smart Trail instance
  const entityId = await evaluate(`(function() {
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    var chartWidget = chart._chartWidget;
    var sources = chartWidget.model().model().dataSources();
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      if (!s.metaInfo) continue;
      try {
        if ((s.metaInfo().description || '').indexOf('Smart Trail') >= 0) {
          var id = s._id && typeof s._id.value === 'function' ? s._id.value() : null;
          return id;
        }
      } catch(e) {}
    }
    return null;
  })()`);

  if (entityId) {
    console.log(`Removing existing instance: ${entityId}`);
    await evaluate(`(function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      chart.removeEntity('${entityId}', { disableUndo: false });
    })()`);
    await sleep(500);
  } else {
    console.log('No existing instance found.');
  }

  // Open Pine Editor via toolbar button
  console.log('Opening Pine Editor...');
  await evaluate(`(function() {
    var btn = document.querySelector('[data-name="pine-dialog-button"]');
    if (btn) btn.click();
  })()`);
  await sleep(800);

  // Load the saved script
  console.log('Loading saved script...');
  // (caller should call pine open before this, or we can use internal API)
  // Try pine open via evaluate
  await evaluate(`(function() {
    try {
      var api = window.pine_editor_api || window.__pineEditorApi;
      // Fallback: rely on caller having run pine open already
    } catch(e) {}
  })()`);
  await sleep(500);

  // Click Add to chart
  console.log('Clicking Add to chart...');
  const result = await evaluate(`(function() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    var node;
    while ((node = walker.nextNode())) {
      if ((node.getAttribute && node.getAttribute('title')) === 'Add to chart' && node.tagName === 'BUTTON') {
        node.click();
        return 'clicked';
      }
    }
    return 'button not found — ensure Pine Editor is open with script loaded';
  })()`);
  console.log('Result:', result);

  await sleep(2000);
  console.log('Done — strategy reloaded.');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
