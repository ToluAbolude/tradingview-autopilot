/**
 * backtest_uv.mjs — UV Filter Comparison via Pine indicator
 * Tests Factor U (PDH/PDL proximity) and Factor V (ADR room) vs baseline.
 * Results written to /tmp/uv_backtest_result.txt
 */
import { evaluate, getClient } from '../src/connection.js';
import { setSource, ensurePineEditorOpen, getErrors } from '../src/core/pine.js';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const src    = readFileSync(join(__dir, '../strategies/uv_filter_indicator.pine'), 'utf-8');

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

async function removeUV() {
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
            if (desc.indexOf('uv filter') < 0 && desc.indexOf('htf filter') < 0) continue;
            var id = s._id && typeof s._id.value === 'function' ? s._id.value() : null;
            if (id) return id;
          } catch(e) {}
        }
      } catch(e) {}
      return null;
    })()`);
    if (!id) { console.log(`  removeUV: cleared after ${i} iterations`); break; }
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
          if (desc.indexOf('uv filter') < 0) continue;
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
            lastRow: lastRow ? JSON.stringify(lastRow).substring(0,200) : null,
            lastNonEmpty: lc ? JSON.stringify(lc).substring(0,400) : null
          };
        } catch(e) { return { err: e.message }; }
      }
    } catch(e) { return { topErr: e.message }; }
    return { notFound: true };
  })()`);
}

// Parse plot values: lastRow format = {index, value:[ts, n1, w1, n2, w2, n3, w3, n4, w4]}
function parseResults(probe) {
  const combos = ['NoFilter', 'Uonly', 'Vonly', 'UV'];
  try {
    let vals = null;
    if (probe.lastNonEmpty) {
      const lne = JSON.parse(probe.lastNonEmpty);
      const firstKey = Object.keys(lne)[0];
      vals = lne[firstKey]?.value;
    }
    if (!vals && probe.lastRow) {
      const row = JSON.parse(probe.lastRow);
      vals = row?.value || row;
    }
    if (!vals || vals.length < 9) return null;
    // vals = [timestamp, n1, w1c, n2, w2, n3, w3, n4, w4]
    const out = {};
    for (let i = 0; i < 4; i++) {
      const total = vals[1 + i*2];
      const wins  = vals[2 + i*2];
      const wr    = total > 0 ? Math.round(wins / total * 1000) / 10 : 0;
      out[combos[i]] = { total, wins, wr };
    }
    return out;
  } catch(e) { return null; }
}

const log = (...a) => console.log(a.join(' '));
const allResults = {};

log('\n════════════════════════════════════════════════════════════');
log('  UV Filter Comparison — Backtest (PDH/PDL + ADR)');
log('════════════════════════════════════════════════════════════\n');

await setChart(SYMBOLS[0].sym, SYMBOLS[0].tf);
const editorReady = await ensurePineEditorOpen();
log(`Pine editor ready: ${editorReady}`);

log(`Removing old filter studies...`);
await removeUV();
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
await sleep(15000);

for (const sym of SYMBOLS) {
  log(`\n▶ ${sym.label}`);
  await setChart(sym.sym, sym.tf);

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

  const probe = await readPlotValues();
  const parsed = parseResults(probe);
  log(`  Plot probe: ${JSON.stringify(probe)}`);

  if (parsed) {
    log(`\n  ┌─────────────┬────────┬──────┬───────┬───────┐`);
    log(`  │ Combo       │ Trades │ Wins │  WR%  │  dWR  │`);
    log(`  ├─────────────┼────────┼──────┼───────┼───────┤`);
    const base = parsed.NoFilter?.wr || 0;
    for (const [name, r] of Object.entries(parsed)) {
      const dwr = r.wr - base;
      const sign = dwr >= 0 ? '+' : '';
      const pad = s => String(s).padStart(6);
      log(`  │ ${name.padEnd(11)} │ ${pad(r.total)} │ ${pad(r.wins)} │ ${pad(r.wr+'%')} │ ${(sign+dwr.toFixed(1)+'%').padStart(5)} │`);
    }
    log(`  └─────────────┴────────┴──────┴───────┴───────┘`);
  }

  allResults[sym.label] = { plotData: probe, parsed };
}

writeFileSync('/tmp/uv_backtest_result.txt', JSON.stringify(allResults, null, 2));
log(`\nResults written to /tmp/uv_backtest_result.txt`);
log('\n════════════════════════════════════════════════════════════\n');
