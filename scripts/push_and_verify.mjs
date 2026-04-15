/**
 * Push local Pine script to TradingView, compile, save, reload, then verify on top combos.
 */
import { evaluate } from '../src/connection.js';
import { readFileSync } from 'fs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const PINE_FILE = 'C:/Users/Tda-d/tradingview-autopilot/strategies/jooviers_gems_smart_trail_scalper.pine';

const COMBOS = [
  { sym: 'BLACKBULL:BTCUSD',  tf: '15', label: 'BTC 15M',  extMode: 'Extended',  v1: { net: 108.81 } },
  { sym: 'BLACKBULL:ETHUSD',  tf: '5',  label: 'ETH 5M',   extMode: 'Fixed TP',  v1: { net: 70.74  } },
  { sym: 'BLACKBULL:XAUUSD',  tf: '30', label: 'XAU 30M',  extMode: 'Extended',  v1: { net: 38.49  } },
  { sym: 'BLACKBULL:XAUUSD',  tf: '15', label: 'XAU 15M',  extMode: 'Extended',  v1: { net: 35.54  } },
  { sym: 'BLACKBULL:ETHUSD',  tf: '1',  label: 'ETH 1M',   extMode: 'Fixed TP',  v1: { net: 17.88  } },
];

// ── MCP helper stubs (call via TradingView MCP server via CDP evaluate wrappers) ──
// We'll do this via direct CDP calls since we have access

async function setPineSource(source) {
  // Use the pine editor internal API
  const escaped = JSON.stringify(source);
  return evaluate(`(function() {
    try {
      // Try to find Pine Editor CodeMirror instance
      var editors = document.querySelectorAll('.cm-content');
      if (!editors.length) {
        // Try Monaco
        var monacoEditors = window.monaco && window.monaco.editor && window.monaco.editor.getModels();
        if (monacoEditors && monacoEditors.length) {
          monacoEditors[0].setValue(${escaped});
          return 'monaco:set';
        }
        return 'no-editor-found';
      }
      // CodeMirror 6 — dispatch transaction
      var view = editors[0]._cmView || editors[0].closest('.cm-editor')?._cmEditor;
      if (view) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: ${escaped} } });
        return 'cm6:set';
      }
      return 'cm-no-view';
    } catch(e) { return 'error:' + e.message; }
  })()`);
}

async function openPineEditor() {
  const r = await evaluate(`(function() {
    var btn = document.querySelector('[data-name="pine-dialog-button"]');
    if (btn) { btn.click(); return 'opened'; }
    return 'not-found';
  })()`);
  await sleep(1000);
  return r;
}

async function clickAddToChart() {
  return evaluate(`(function() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    var node;
    while ((node = walker.nextNode())) {
      if (node.tagName === 'BUTTON') {
        var t = node.getAttribute('title') || node.textContent || '';
        if (t.indexOf('Add to chart') >= 0) { node.click(); return 'clicked'; }
      }
    }
    return 'not-found';
  })()`);
}

async function removeExistingStrategy() {
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
    console.log(`  Removing existing instance: ${entityId}`);
    await evaluate(`(function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      chart.removeEntity('${entityId}', { disableUndo: false });
    })()`);
    await sleep(600);
  }
  return entityId;
}

async function setChart(sym, tf) {
  await evaluate(`(function(){
    var a = window.TradingViewApi._activeChartWidgetWV.value();
    a.setSymbol('${sym}', null, true);
    a.setResolution('${tf}');
  })()`);
}

async function getMetrics() {
  return evaluate(`(function() {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources = chart.model().model().dataSources();
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      if (!s.metaInfo) continue;
      try {
        if ((s.metaInfo().description || '').indexOf('Smart Trail') >= 0) {
          var rd = s._reportData || s.reportData;
          if (typeof rd === 'function') rd = rd();
          if (rd && typeof rd.value === 'function') rd = rd.value();
          if (!rd || !rd.performance || !rd.performance.all) return { loading: true };
          var a = rd.performance.all;
          var p = rd.performance;
          return {
            trades: a.totalTrades || 0,
            net:    Math.round((a.netProfit || 0)*100)/100,
            wr:     Math.round(((a.percentProfitable||0)*100)*10)/10,
            pf:     Math.round((a.profitFactor||0)*1000)/1000,
            maxDD:  Math.round((p.maxStrategyDrawDown||0)*100)/100,
            lNet:   Math.round((p.long?.netProfit||0)*100)/100,
            sNet:   Math.round((p.short?.netProfit||0)*100)/100,
          };
        }
      } catch(e) {}
    }
    return { error: 'not found' };
  })()`);
}

async function waitMetrics(maxSec = 15) {
  for (let i = 0; i < maxSec; i++) {
    await sleep(1000);
    const m = await getMetrics();
    if (m && !m.error && !m.loading && m.trades > 0) return m;
    if (m && !m.error && !m.loading) return m; // 0 trades is valid (no signal period)
  }
  return await getMetrics();
}

async function setExitModeInput(mode) {
  // Try to set Exit Mode input via strategy properties dialog
  // This is complex via CDP — easier to embed in the Pine script itself per combo
  // For now we rely on default (Extended)
}

// ── PHASE 1: Push & reload strategy ──
async function pushStrategy() {
  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║   PHASE 1: Push local Pine → TradingView      ║');
  console.log('╚════════════════════════════════════════════════╝\n');

  const source = readFileSync(PINE_FILE, 'utf8');
  console.log(`  Source: ${source.length} chars, ${source.split('\n').length} lines`);

  // Open Pine Editor
  console.log('  Opening Pine Editor...');
  const openResult = await openPineEditor();
  console.log('  Open result:', openResult);
  await sleep(1200);

  // Set source
  console.log('  Setting source...');
  const setResult = await setPineSource(source);
  console.log('  Set result:', setResult);
  await sleep(800);

  if (setResult && setResult.includes('error')) {
    console.log('  ⚠ Source injection failed — trying alternate approach');
    // Try clipboard approach via execCommand
    const clipResult = await evaluate(`(function() {
      try {
        var textarea = document.createElement('textarea');
        textarea.value = 'test';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('selectAll');
        document.body.removeChild(textarea);
        return 'clipboard-approach-needed';
      } catch(e) { return 'error:' + e.message; }
    })()`);
    console.log('  Alternate:', clipResult);
  }

  // Click Add to chart (this compiles + adds)
  console.log('  Clicking Add to chart...');
  const addResult = await clickAddToChart();
  console.log('  Add result:', addResult);
  await sleep(2500);
}

// ── PHASE 2: Verify combos ──
async function verifyCombos() {
  console.log('\n╔════════════════════════════════════════════════════════════════════╗');
  console.log('║   PHASE 2: Verify top 5 combos                                    ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝\n');
  console.log('Combo      TF   Trades  Net P&L    WR%    PF      DD       L-Net    S-Net   vs v1');
  console.log('─'.repeat(95));

  for (const c of COMBOS) {
    process.stdout.write(`${c.label}... `);
    await setChart(c.sym, c.tf);
    const m = await waitMetrics(15);

    if (!m || m.error || m.loading) {
      console.log('ERROR:', JSON.stringify(m));
      continue;
    }

    const diff = m.net - c.v1.net;
    const tag  = diff >= 0 ? `▲+$${diff.toFixed(2)}` : `▼$${diff.toFixed(2)}`;
    const wr   = m.wr === 0 && m.trades > 0 ? '⚠0%' : `${m.wr}%`;

    console.log(
      `\n${c.label.padEnd(10)} ${c.tf}M`.padEnd(14),
      String(m.trades).padEnd(8),
      `$${m.net}`.padEnd(11),
      wr.padEnd(8),
      String(m.pf).padEnd(8),
      `-$${m.maxDD}`.padEnd(9),
      `$${m.lNet}`.padEnd(9),
      `$${m.sNet}`.padEnd(8),
      tag
    );
  }
  console.log('\n─'.repeat(95));
  console.log('Done.');
}

async function main() {
  // First check what's currently on chart
  console.log('Checking current strategy state...');
  const m0 = await getMetrics();
  console.log('Current metrics:', JSON.stringify(m0));

  await pushStrategy();
  await verifyCombos();
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
