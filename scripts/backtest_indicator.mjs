/**
 * backtest_indicator.mjs — HTF Filter Comparison via Pine indicator + log.info
 * Removes old HTF studies, injects indicator, waits, reads Pine console output.
 * Results written to /tmp/htf_backtest_result.txt for SSH-independent access.
 */
import { evaluate, getClient } from '../src/connection.js';
import { setSource, ensurePineEditorOpen, getErrors } from '../src/core/pine.js';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const src    = readFileSync(join(__dir, '../strategies/htf_filter_indicator.pine'), 'utf-8');

const SYMBOLS = [
  { sym: 'BLACKBULL:XAUUSD', tf: '60', label: 'XAUUSD H1' },
  { sym: 'BLACKBULL:BTCUSD', tf: '60', label: 'BTCUSD H1' },
  { sym: 'BLACKBULL:NAS100', tf: '60', label: 'NAS100 H1' },
];

async function setChart(sym, tf) {
  await evaluate(`(function(){
    var a = window.TradingViewApi._activeChartWidgetWV.value();
    a.setSymbol('${sym}', null, true);
    a.setResolution('${tf}');
  })()`);
  await sleep(5000);
}

async function removeHTF() {
  for (let i = 0; i < 12; i++) {
    const id = await evaluate(`(function(){
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        var sources = chart._chartWidget.model().model().dataSources();
        for (var i = 0; i < sources.length; i++) {
          var s = sources[i];
          if (!s.metaInfo) continue;
          try {
            var desc = (s.metaInfo().description || '').toLowerCase();
            if (desc.indexOf('htf') < 0) continue;
            var id = s._id && typeof s._id.value === 'function' ? s._id.value() : null;
            if (id) return id;
          } catch(e) {}
        }
      } catch(e) {}
      return null;
    })()`);
    if (!id) { console.log(`  removeHTF: cleared after ${i} iterations`); break; }
    await evaluate(`(function(){
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        chart._chartWidget.model().model().removeStudy('${id}');
      } catch(e) {}
    })()`);
    await sleep(1200);
  }
}

async function clickAddToChart() {
  const r = await evaluate(`(function(){
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (!b.offsetParent) continue;
      var title = (b.getAttribute('title') || '').trim();
      var text  = (b.textContent  || '').trim();
      if (/^(Add to chart|Update on chart|Add indicator to chart)$/i.test(title) ||
          /^(Add to chart|Update on chart)$/i.test(text)) {
        b.click();
        return 'clicked:' + (title || text).substring(0, 40);
      }
    }
    return 'not-found';
  })()`);
  if (r.startsWith('not-found')) {
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type:'keyDown', modifiers:2, key:'Enter', code:'Enter', windowsVirtualKeyCode:13 });
    await c.Input.dispatchKeyEvent({ type:'keyUp', key:'Enter', code:'Enter' });
  }
  await sleep(4000);
  return r;
}

// Read Pine console log lines from the DOM
async function readPineConsole() {
  return evaluate(`(function(){
    try {
      // Pine console lines appear in the editor output area
      var lines = [];
      // Try various selectors for the Pine console output
      var selectors = [
        '[class*="log-line"]',
        '[class*="console-line"]',
        '[class*="output-line"]',
        '[class*="pine-log"]',
        '[data-name="pine-console"] [class*="line"]',
        '.tv-script-output-line'
      ];
      for (var si = 0; si < selectors.length; si++) {
        var els = document.querySelectorAll(selectors[si]);
        if (els.length > 0) {
          for (var i = 0; i < els.length; i++) {
            var t = (els[i].textContent || '').trim();
            if (t) lines.push(t);
          }
          if (lines.length > 0) return { found: true, selector: selectors[si], lines: lines };
        }
      }
      // Try reading from any element containing "RESULT|"
      var all = document.querySelectorAll('*');
      var resultLines = [];
      for (var i = 0; i < all.length; i++) {
        var t = all[i].childNodes.length === 1 && all[i].childNodes[0].nodeType === 3
          ? all[i].textContent.trim() : '';
        if (t.indexOf('RESULT|') >= 0) resultLines.push(t);
      }
      if (resultLines.length > 0) return { found: true, selector: 'text-scan', lines: resultLines };
      return { found: false };
    } catch(e) { return { error: e.message }; }
  })()`);
}

// Read plot values from _data._items last row
async function readPlotValues() {
  return evaluate(`(function(){
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var sources = chart.model().model().dataSources();
      for (var i = 0; i < sources.length; i++) {
        var s = sources[i];
        if (!s.metaInfo) continue;
        try {
          var desc = (s.metaInfo().description || '').toLowerCase();
          if (desc.indexOf('htf') < 0) continue;
          var spc = s._simplePlotsCount;
          var end = s._data && s._data._end ? s._data._end : 0;
          var items = s._data && s._data._items;
          var lastRow = null;
          if (items) {
            if (Array.isArray(items) && items.length > 0) lastRow = items[items.length-1];
            else if (typeof items === 'object') {
              var keys = Object.keys(items);
              if (keys.length > 0) lastRow = items[keys[keys.length-1]];
            }
          }
          var lc = s._lastNonEmptyPlotRowCache;
          if (lc && typeof lc.value === 'function') lc = lc.value();
          return {
            desc: s.metaInfo().description,
            simplePlotsCount: spc,
            dataEnd: end,
            lastRowType: lastRow ? typeof lastRow : 'null',
            lastRowLen: lastRow && lastRow.length,
            lastRow: lastRow ? JSON.stringify(lastRow).substring(0,200) : null,
            lastNonEmpty: lc ? JSON.stringify(lc).substring(0,300) : null
          };
        } catch(e) { return { err: e.message }; }
      }
    } catch(e) { return { topErr: e.message }; }
    return { notFound: true };
  })()`);
}

const log = (...a) => { const msg = a.join(' '); console.log(msg); };
const results = {};

log('\n════════════════════════════════════════════════════════════');
log('  HTF Filter Comparison — Indicator backtest');
log('════════════════════════════════════════════════════════════\n');

await setChart(SYMBOLS[0].sym, SYMBOLS[0].tf);
const editorReady = await ensurePineEditorOpen();
log(`Pine editor ready: ${editorReady}`);

log(`Removing old HTF studies...`);
await removeHTF();
await sleep(3000);

const setResult = await setSource({ source: src });
log(`Injected ${setResult.lines_set} lines`);

const errs = await getErrors();
if (errs.has_errors) {
  log(`Pine errors: ${JSON.stringify(errs.errors)}`);
  process.exit(1);
}
log(`No compile errors.`);

const addResult = await clickAddToChart();
log(`Add to chart: ${addResult}`);
await sleep(15000); // wait for first symbol to compute

for (const sym of SYMBOLS) {
  log(`\n▶ ${sym.label}`);
  await setChart(sym.sym, sym.tf);

  // Wait up to 3 minutes for data
  let plotData = null;
  for (let i = 0; i < 180; i++) {
    await sleep(1000);
    const probe = await readPlotValues();
    if (probe && probe.simplePlotsCount >= 8 && probe.dataEnd > 0) {
      plotData = probe;
      log(`  Data ready after ${i+1}s: spc=${probe.simplePlotsCount} end=${probe.dataEnd}`);
      break;
    }
    if (i === 59) log(`  Still waiting... spc=${probe?.simplePlotsCount} end=${probe?.dataEnd}`);
  }

  // Try Pine console
  const cons = await readPineConsole();
  log(`  Console: ${JSON.stringify(cons).substring(0, 300)}`);

  // Log raw plot probe
  const probe = await readPlotValues();
  log(`  Plot probe: ${JSON.stringify(probe)}`);
  results[sym.label] = { plotData, probe, cons };
}

// Write full results to file for easy retrieval
writeFileSync('/tmp/htf_backtest_result.txt', JSON.stringify(results, null, 2));
log(`\nResults written to /tmp/htf_backtest_result.txt`);
log('\n════════════════════════════════════════════════════════════\n');
