/**
 * push_reload_verify.mjs
 * For each of the 8 strategies:
 *   1. Remove existing strategy from chart
 *   2. Push Pine source into Monaco editor
 *   3. Compile + add to chart
 *   4. Save to cloud
 *   5. Verify best combos vs baseline
 *
 * Run manually or via biweekly research cron.
 * Pass a strategy name to run just one: node push_reload_verify.mjs jg_smart_trail
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { setSource, save, ensurePineEditorOpen, getErrors } from '../src/core/pine.js';
import { evaluate, getClient } from '../src/connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const STRAT_DIR = os.platform() === 'linux'
  ? '/home/ubuntu/trading-data/strategies'
  : join(__dirname, '../strategies');

// All 8 strategies with their best backtest combos and v1 baselines
const STRATEGIES = [
  {
    key: 'jg_smart_trail',
    file: 'jooviers_gems_smart_trail_scalper.pine',
    name: 'JG Smart Trail HA Scalper',
    combos: [
      { sym: 'BLACKBULL:BTCUSD', tf: '15', label: 'BTC 15M', exitMode: 'Extended', v1: { net: 108.81, wr: 44.4, pf: 1.784 } },
      { sym: 'BLACKBULL:ETHUSD', tf: '5',  label: 'ETH 5M',  exitMode: 'Fixed TP', v1: { net: 70.74,  wr: 41.7, pf: 1.929 } },
      { sym: 'BLACKBULL:XAUUSD', tf: '30', label: 'XAU 30M', exitMode: 'Extended', v1: { net: 38.49,  wr: 44.4, pf: 1.964 } },
      { sym: 'BLACKBULL:XAUUSD', tf: '15', label: 'XAU 15M', exitMode: 'Extended', v1: { net: 35.54,  wr: 28.6, pf: 1.864 } },
      { sym: 'BLACKBULL:ETHUSD', tf: '1',  label: 'ETH 1M',  exitMode: 'Fixed TP', v1: { net: 17.88,  wr: 66.7, pf: 2.728 } },
    ],
  },
  {
    key: 'jg_ha_scalper',
    file: 'jooviers_gems_ha_scalper.pine',
    name: 'JG HA Scalper',
    combos: [
      { sym: 'BLACKBULL:BTCUSD', tf: '15', label: 'BTC 15M', v1: { net: 0, wr: 0, pf: 0 } },
      { sym: 'BLACKBULL:ETHUSD', tf: '5',  label: 'ETH 5M',  v1: { net: 0, wr: 0, pf: 0 } },
      { sym: 'BLACKBULL:XAUUSD', tf: '15', label: 'XAU 15M', v1: { net: 0, wr: 0, pf: 0 } },
    ],
  },
  {
    key: 'jg_london_breakout',
    file: 'jooviers_gems_london_breakout.pine',
    name: 'JG London Breakout',
    combos: [
      { sym: 'BLACKBULL:GBPUSD', tf: '15', label: 'GBPUSD 15M', v1: { net: 0, wr: 0, pf: 0 } },
      { sym: 'BLACKBULL:EURUSD', tf: '15', label: 'EURUSD 15M', v1: { net: 0, wr: 0, pf: 0 } },
      { sym: 'BLACKBULL:XAUUSD', tf: '15', label: 'XAU 15M',    v1: { net: 0, wr: 0, pf: 0 } },
    ],
  },
  {
    key: 'tori_trendline',
    file: 'tori_trades_trendline_strategy.pine',
    name: 'Tori 4H Trendline Break',
    combos: [
      { sym: 'BLACKBULL:GBPUSD', tf: '240', label: 'GBPUSD 4H', v1: { net: 0, wr: 0, pf: 0 } },
      { sym: 'BLACKBULL:EURUSD', tf: '240', label: 'EURUSD 4H', v1: { net: 0, wr: 0, pf: 0 } },
      { sym: 'BLACKBULL:NAS100', tf: '240', label: 'NAS100 4H', v1: { net: 0, wr: 0, pf: 0 } },
    ],
  },
  {
    key: 'wor_break_retest',
    file: 'wor_break_and_retest.pine',
    name: 'WOR Break & Retest',
    combos: [
      { sym: 'BLACKBULL:BTCUSD', tf: '60',  label: 'BTC 1H',    v1: { net: 0, wr: 0, pf: 0 } },
      { sym: 'BLACKBULL:XAUUSD', tf: '60',  label: 'XAU 1H',    v1: { net: 0, wr: 0, pf: 0 } },
      { sym: 'BLACKBULL:GBPUSD', tf: '15',  label: 'GBPUSD 15M', v1: { net: 0, wr: 0, pf: 0 } },
    ],
  },
  {
    key: 'wor_marci_mean_rev',
    file: 'wor_marci_silfrain_htf_mean_reversion.pine',
    name: 'WOR Marci HTF Mean Reversion',
    combos: [
      { sym: 'BLACKBULL:NAS100', tf: '15', label: 'NAS100 15M', v1: { net: 0, wr: 0, pf: 0 } },
      { sym: 'BLACKBULL:SPX500', tf: '15', label: 'SPX500 15M', v1: { net: 0, wr: 0, pf: 0 } },
      { sym: 'BLACKBULL:US30',   tf: '15', label: 'US30 15M',   v1: { net: 0, wr: 0, pf: 0 } },
    ],
  },
  {
    key: 'wor_nbb_ict',
    file: 'wor_nbb_ict_power_of_3.pine',
    name: 'WOR NBB ICT Power of 3',
    combos: [
      { sym: 'BLACKBULL:BTCUSD', tf: '15', label: 'BTC 15M',    v1: { net: 0, wr: 0, pf: 0 } },
      { sym: 'BLACKBULL:NAS100', tf: '15', label: 'NAS100 15M', v1: { net: 0, wr: 0, pf: 0 } },
      { sym: 'BLACKBULL:XAUUSD', tf: '15', label: 'XAU 15M',    v1: { net: 0, wr: 0, pf: 0 } },
    ],
  },
  {
    key: 'wor_okala_nq',
    file: 'wor_okala_nq_scalper.pine',
    name: 'WOR Okala NQ Scalper',
    combos: [
      { sym: 'BLACKBULL:ETHUSD', tf: '5', label: 'ETH 5M',   v1: { net: 0, wr: 0, pf: 0 } },
      { sym: 'NASDAQ:QQQ',      tf: '5', label: 'QQQ 5M',   v1: { net: 0, wr: 0, pf: 0 } },
      { sym: 'NASDAQ:QQQ',      tf: '1', label: 'QQQ 1M',   v1: { net: 0, wr: 0, pf: 0 } },
    ],
  },
];

// Filter to specific strategy if passed as CLI arg
const filterKey = process.argv[2];
const ACTIVE_STRATEGIES = filterKey
  ? STRATEGIES.filter(s => s.key === filterKey || s.file.includes(filterKey))
  : STRATEGIES;

async function removeExisting(stratName) {
  // Remove ALL instances of a strategy by name substring (prevents duplicate accumulation)
  let removed = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    const entityId = await evaluate(`(function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        var sources = chart._chartWidget.model().model().dataSources();
        for (var i = 0; i < sources.length; i++) {
          var s = sources[i];
          if (!s.metaInfo) continue;
          try {
            var desc = s.metaInfo().description || '';
            var nameToMatch = ${JSON.stringify(stratName || '')};
            var matches = nameToMatch
              ? desc.indexOf(nameToMatch) >= 0
              : (desc.indexOf('Smart Trail') >= 0 || desc.indexOf('OkalaNQ') >= 0 ||
                 desc.indexOf('WOR') >= 0 || desc.indexOf('JG ') >= 0 ||
                 desc.indexOf('Tori') >= 0 || desc.indexOf('TEST') >= 0);
            if (matches) {
              var id = s._id && typeof s._id.value === 'function' ? s._id.value() : null;
              return id;
            }
          } catch(e) {}
        }
      } catch(e) {}
      return null;
    })()`);

    if (!entityId) break;
    console.log(`  Removing: ${entityId}`);
    await evaluate(`(function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      chart.removeEntity('${entityId}', { disableUndo: false });
    })()`);
    await sleep(500);
    removed++;
  }
  if (removed === 0) console.log('  No existing strategy instance found.');
  else console.log(`  Removed ${removed} existing instance(s).`);
  return removed;
}

async function clickAddToChart() {
  // Try multiple button text variants
  const result = await evaluate(`(function() {
    var candidates = [];
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var text = (btns[i].textContent || '').trim();
      candidates.push(text);
      var title = (btns[i].getAttribute('title') || '').trim();
      var ltext = text.toLowerCase();
      if (ltext === 'add to chart' || ltext === 'update on chart' ||
          ltext === 'save and add to chart' ||
          title === 'Add to chart' || title === 'Update on chart') {
        btns[i].click();
        return 'clicked:' + (text || title);
      }
    }
    return 'not-found. Buttons: ' + candidates.filter(Boolean).slice(0, 30).join(' | ');
  })()`);
  return result;
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
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var sources = chart.model().model().dataSources();
      for (var i = 0; i < sources.length; i++) {
        var s = sources[i];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          // Match any loaded strategy (type 2 = strategy in Pine)
          var isStrat = meta && (meta.is_price_study === false || meta.isTVScript === true);
          if (!isStrat && meta && !meta.description) continue;
          var rd = s._reportData || s.reportData;
          if (typeof rd === 'function') rd = rd();
          if (rd && typeof rd.value === 'function') rd = rd.value();
          if (!rd || !rd.performance || !rd.performance.all) continue;
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
        } catch(e) {}
      }
    } catch(e) { return { error: e.message }; }
    return { loading: true };
  })()`);
}

// Change the Exit Mode input on the loaded strategy (Fixed TP | Extended)
async function setExitMode(mode) {
  // Find the strategy source via dataSources, then modify its inputs directly
  const result = await evaluate(`(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var sources = chart.model().model().dataSources();
      for (var i = 0; i < sources.length; i++) {
        var s = sources[i];
        if (!s.metaInfo) continue;
        try {
          if ((s.metaInfo().description || '').indexOf('Smart Trail') < 0) continue;
          // Try direct inputs update via _propertyPages or metaInfo inputs
          var inputs = s.getInputsInfo ? s.getInputsInfo() : null;
          // Use the pine script inputs setter
          if (s.applyStudyTemplate && typeof s.applyStudyTemplate === 'function') {
            return 'has applyStudyTemplate';
          }
          // Try property set
          var pine = s._pineStudy || s.pineStudy;
          if (pine && typeof pine === 'object') {
            return 'has pineStudy: ' + Object.keys(pine).slice(0,5).join(',');
          }
          // Use chart.modifyStudy
          var id = s._id && typeof s._id.value === 'function' ? s._id.value() : null;
          return id ? 'id:' + id : 'no-id';
        } catch(e) { return 'err:' + e.message; }
      }
      return 'strategy not found';
    } catch(e) { return 'outer-err:' + e.message; }
  })()`);

  if (result && result.startsWith('id:')) {
    const entityId = result.slice(3);
    // Open settings dialog via DOM — click the gear icon on the strategy
    await evaluate(`(function() {
      // Right-click or find settings button for the strategy in the legend
      var gears = document.querySelectorAll('[data-name="legend-settings-action"], [class*="settingsButton"], button[aria-label*="Settings"]');
      for (var i = 0; i < gears.length; i++) {
        if (gears[i].offsetParent) { gears[i].click(); return 'clicked gear'; }
      }
      // Fallback: look for any visible gear/settings icon
      var all = document.querySelectorAll('button');
      for (var i = 0; i < all.length; i++) {
        var t = (all[i].getAttribute('aria-label') || all[i].title || '').toLowerCase();
        if ((t.includes('setting') || t.includes('format')) && all[i].offsetParent) {
          all[i].click(); return 'clicked: ' + t;
        }
      }
    })()`);
    await sleep(1200);

    // In the dialog, find the Exit Mode select and change it
    const changed = await evaluate(`(function() {
      var mode = '${mode}';
      // Look for a select or dropdown with "Exit Mode" label
      var labels = document.querySelectorAll('label, span, div');
      for (var i = 0; i < labels.length; i++) {
        if ((labels[i].textContent || '').trim() === 'Exit Mode') {
          // Find the nearest select
          var parent = labels[i].closest('[class*="cell"], [class*="row"], div');
          if (parent) {
            var sel = parent.querySelector('select');
            if (sel) {
              sel.value = mode;
              sel.dispatchEvent(new Event('change', { bubbles: true }));
              return 'select changed to ' + mode;
            }
            // Dropdown (custom)
            var dropdown = parent.querySelector('[class*="dropdown"], [class*="select"], button');
            if (dropdown) { dropdown.click(); return 'dropdown clicked'; }
          }
        }
      }
      return 'Exit Mode input not found';
    })()`);
    await sleep(600);

    // Click OK to apply
    await evaluate(`(function() {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var t = (btns[i].textContent || '').trim().toLowerCase();
        if ((t === 'ok' || t === 'apply') && btns[i].offsetParent) { btns[i].click(); return; }
      }
    })()`);
    await sleep(1500);
    return changed;
  }
  return result;
}

async function waitMetrics(maxSec = 18) {
  for (let i = 0; i < maxSec; i++) {
    await sleep(1000);
    const m = await getMetrics();
    if (m && !m.error && !m.loading) return m;
  }
  return await getMetrics();
}

// ── Push + compile one strategy file ──
async function pushStrategy(filePath, stratName) {
  const source = readFileSync(filePath, 'utf8');
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  ${stratName}`);
  console.log(`  ${source.length} chars, ${source.split('\n').length} lines`);
  console.log('═'.repeat(80));

  console.log('\n[1] Remove existing...');
  await removeExisting(stratName);

  console.log('\n[2] Push source...');
  const editorReady = await ensurePineEditorOpen();
  await sleep(800);
  const setResult = await setSource({ source });
  console.log('  setSource:', JSON.stringify(setResult));
  await sleep(500);

  console.log('\n[3] Add to chart...');
  const addResult = await clickAddToChart();
  console.log('  Add to chart:', addResult);
  if (addResult.startsWith('not-found')) {
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }
  await sleep(3000);

  console.log('\n[4] Check compilation...');
  const errResult = await getErrors();
  const realErrors = (errResult.errors || []).filter(e => e.severity === 1 || e.severity === 8);
  console.log(`  Markers: ${errResult.error_count} total, ${realErrors.length} real errors`);
  for (const e of (errResult.errors || [])) {
    console.log(`  [sev=${e.severity}] Line ${e.line}: ${e.message.substring(0, 80)}`);
  }
  if (realErrors.length > 0) {
    console.error('  ✗ Compilation errors — skipping combos for this strategy.');
    return false;
  }
  console.log('  ✓ No real errors.');

  console.log('\n[5] Save to cloud...');
  const saveResult = await save();
  console.log('  save:', JSON.stringify(saveResult));
  await sleep(800);

  return true;
}

// ── MAIN ──
async function main() {
  console.log(`Running ${ACTIVE_STRATEGIES.length} of ${STRATEGIES.length} strategies...\n`);
  const allResults = {};

  for (const strat of ACTIVE_STRATEGIES) {
    const filePath = join(STRAT_DIR, strat.file);
    const compiled = await pushStrategy(filePath, strat.name);
    if (!compiled) { allResults[strat.key] = { error: 'compile failed' }; continue; }

  // ── Verify combos ──
  console.log('\n[6] Verify combos');
  console.log('─'.repeat(96));
  console.log('Combo         TF    Trades  Net P&L    WR%    PF      DD       L-Net    S-Net   vs v1');
  console.log('─'.repeat(96));

  let allOK = true;
  const stratResults = [];

  let lastExitMode = 'Extended';
  for (const c of strat.combos) {
    process.stdout.write(`${c.label}... `);
    await setChart(c.sym, c.tf);
    await sleep(15000); // wait for TradingView to recalculate strategy tester

    // Switch Exit Mode if needed (only applies to JG Smart Trail)
    if (c.exitMode && c.exitMode !== lastExitMode) {
      await setExitMode(c.exitMode);
      process.stdout.write(`[${c.exitMode}] `);
      lastExitMode = c.exitMode;
      await sleep(1000);
    }

    const m = await waitMetrics(90);

    if (!m || m.error || m.loading) {
      console.log('ERROR:', JSON.stringify(m));
      allOK = false;
      continue;
    }

    // Tag vs v1 baseline (skip if no baseline set)
    const hasBaseline = c.v1.net !== 0 || c.v1.wr !== 0;
    const diff = m.net - c.v1.net;
    const tag  = !hasBaseline ? '(new)' : diff >= 0 ? `▲+$${diff.toFixed(2)}` : `▼$${diff.toFixed(2)}`;
    const wrStr = m.wr === 0 && m.trades > 0 ? '⚠0%' : `${m.wr}%`;
    if (m.wr === 0 && m.trades > 0) allOK = false;

    const row = {
      label: c.label, tf: c.tf, trades: m.trades, net: m.net, wr: m.wr,
      pf: m.pf, maxDD: m.maxDD, lNet: m.lNet, sNet: m.sNet,
    };
    stratResults.push(row);

    console.log(
      `\n${c.label.padEnd(13)} ${c.tf}`.padEnd(18),
      String(m.trades).padEnd(8),
      `$${m.net}`.padEnd(11),
      wrStr.padEnd(8),
      String(m.pf).padEnd(8),
      `-$${m.maxDD}`.padEnd(9),
      `$${m.lNet}`.padEnd(9),
      `$${m.sNet}`.padEnd(8),
      tag
    );
  }

  console.log('\n' + '─'.repeat(96));
  console.log(allOK ? `✓ ${strat.name} — all combos healthy.` : `⚠ ${strat.name} — some combos show 0% WR.`);

  allResults[strat.key] = { name: strat.name, ok: allOK, combos: stratResults };

  // Auto-update v1 baselines for new strategies (net was 0 before)
  const newBaselines = strat.combos.filter(c => c.v1.net === 0 && c.v1.wr === 0);
  if (newBaselines.length > 0) {
    console.log(`  → ${newBaselines.length} new baseline(s) recorded for future comparison.`);
    for (const nb of newBaselines) {
      const res = stratResults.find(r => r.label === nb.label);
      if (res) { nb.v1.net = res.net; nb.v1.wr = res.wr; nb.v1.pf = res.pf; }
    }
  }
  } // end strategy loop

  // ── Final summary ──
  console.log('\n\n' + '═'.repeat(80));
  console.log('  FULL STRATEGY SUITE SUMMARY');
  console.log('═'.repeat(80));
  for (const [key, r] of Object.entries(allResults)) {
    if (r.error) { console.log(`  ✗ ${key}: ${r.error}`); continue; }
    const bestCombo = r.combos?.sort((a,b) => b.net - a.net)[0];
    console.log(`  ${r.ok ? '✓' : '⚠'} ${r.name.padEnd(40)} best: ${bestCombo ? `${bestCombo.label} $${bestCombo.net} WR=${bestCombo.wr}%` : 'n/a'}`);
  }
  console.log('═'.repeat(80));
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
