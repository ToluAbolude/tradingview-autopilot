/**
 * backtest_st_filters.mjs
 * Tests BOS+retest strategy with D1 (Factor S) and W1 (Factor T) filters
 * across XAUUSD H1, BTCUSD H1, NAS100 H1 — 4 filter combos × 3 symbols = 12 runs.
 *
 * Uses push_reload_verify pipeline (setSource → Add to chart → getMetrics).
 *
 * Run: DISPLAY=:1 node scripts/backtest_st_filters.mjs
 */
import { evaluate, getClient } from '../src/connection.js';
import { setSource, ensurePineEditorOpen, getErrors } from '../src/core/pine.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir  = dirname(fileURLToPath(import.meta.url));
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const base   = readFileSync(join(__dir, '../strategies/htf_filter_comparison.pine'), 'utf-8');

// 4 filter variants — unique strategy name per variant forces fresh compile (bypasses TV cache)
function makePine(d1On, w1On, variantId) {
  const title      = `HTF_ST_V${variantId}_${d1On?'D1':'no'}_${w1On?'W1':'no'}`;
  const shortTitle = `HTF_V${variantId}`;
  return base
    .replace(/strategy\("HTF Filter Test \(Factor S \/ T\)"/,
             `strategy("${title}"`)
    .replace(/shorttitle\s*=\s*"HTF_ST_TEST"/,
             `shorttitle        = "${shortTitle}"`)
    .replace('i_use_d1 = input.bool(true,  "Use D1 Trend Filter (Factor S)"',
             `i_use_d1 = input.bool(${d1On}, "Use D1 Trend Filter (Factor S)"`)
    .replace('i_use_w1 = input.bool(true,  "Use W1 Trend Filter (Factor T)"',
             `i_use_w1 = input.bool(${w1On}, "Use W1 Trend Filter (Factor T)"`);
}

const VARIANTS = [
  { label: 'No Filter  (baseline)', d1: false, w1: false, id: 1 },
  { label: 'D1 only    (Factor S)', d1: true,  w1: false, id: 2 },
  { label: 'W1 only    (Factor T)', d1: false, w1: true,  id: 3 },
  { label: 'D1 + W1    (S+T full)', d1: true,  w1: true,  id: 4 },
];

const SYMBOLS = [
  { sym: 'BLACKBULL:XAUUSD', tf: '60', label: 'XAUUSD H1' },
  { sym: 'BLACKBULL:BTCUSD', tf: '60', label: 'BTCUSD H1' },
  { sym: 'BLACKBULL:NAS100', tf: '60', label: 'NAS100 H1' },
];

// ── Remove any existing instance of this test strategy ──
async function removeExisting() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const entityId = await evaluate(`(function() {
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
        return null;
      } catch(e) { return null; }
    })()`);
    if (!entityId) break;
    await evaluate(`(function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        chart._chartWidget.model().model().removeStudy('${entityId}');
      } catch(e) {}
    })()`);
    await sleep(1000);
  }
}

// ── Switch symbol/TF ──
async function setChart(sym, tf) {
  await evaluate(`(function(){
    var a = window.TradingViewApi._activeChartWidgetWV.value();
    a.setSymbol('${sym}', null, true);
    a.setResolution('${tf}');
  })()`);
  await sleep(3000);
}

// ── Click "Add to chart" or "Update on chart" ──
async function clickAddToChart() {
  const r = await evaluate(`(function(){
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (!b.offsetParent) continue;
      var title = (b.getAttribute('title') || '').trim();
      var text  = (b.textContent || '').trim();
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
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }
  await sleep(3000);
  return r;
}

// ── Read strategy tester metrics (first strategy with performance data) ──
function getMetrics() {
  return evaluate(`(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var sources = chart.model().model().dataSources();
      for (var i = 0; i < sources.length; i++) {
        var s = sources[i];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var rd = s._reportData || s.reportData;
          if (typeof rd === 'function') rd = rd();
          if (rd && typeof rd.value === 'function') rd = rd.value();
          if (!rd || !rd.performance || !rd.performance.all) continue;
          var a = rd.performance.all;
          var p = rd.performance;
          return {
            desc:   meta.description || meta.shortDescription || '?',
            trades: a.totalTrades || 0,
            net:    Math.round((a.netProfit || 0) * 100) / 100,
            wr:     Math.round(((a.percentProfitable || 0)) * 10) / 10,
            pf:     Math.round((a.profitFactor || 0) * 1000) / 1000,
            maxDD:  Math.round(Math.abs(p.maxStrategyDrawDown || 0) * 100) / 100,
          };
        } catch(e) {}
      }
    } catch(e) { return { error: e.message }; }
    return { loading: true };
  })()`);
}

async function waitMetrics(maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    await sleep(1000);
    const m = await getMetrics();
    if (m && !m.error && !m.loading && m.trades > 0) return m;
    if (m && !m.error && !m.loading && i > 20) return m; // accept 0 after 20s
  }
  return await getMetrics();
}

// ── Main ──
console.log('\n════════════════════════════════════════════════════════════════════');
console.log('  Factor S (D1 Bias) + Factor T (W1 Bias) — Backtest Comparison');
console.log('  Strategy: BOS + Retest (Alpha Kill logic), SL=1.5×ATR, TP=3×ATR');
console.log('════════════════════════════════════════════════════════════════════\n');

const results = {};

// Open Pine editor once at the start
await setChart(SYMBOLS[0].sym, SYMBOLS[0].tf);
const editorReady = await ensurePineEditorOpen();
console.log(`Pine editor ready: ${editorReady}`);
if (!editorReady) { console.error('Pine editor failed to open — cannot proceed.'); process.exit(1); }

for (const sym of SYMBOLS) {
  console.log(`\n▶ ${sym.label}`);
  results[sym.label] = {};

  for (const v of VARIANTS) {
    // Fresh load each variant: remove existing → inject new source → add to chart
    await setChart(sym.sym, sym.tf);
    await sleep(1000);
    await removeExisting();
    await sleep(800);

    const varTitle = `HTF_ST_V${v.id}`;
    const src = makePine(v.d1, v.w1, v.id);
    process.stdout.write(`  [${v.label}] push...`);

    const setResult = await setSource({ source: src });
    process.stdout.write(` inject(${setResult.lines_set}L) → compile...`);
    await clickAddToChart();
    await sleep(3000); // allow chart to register new strategy

    process.stdout.write(` waiting...`);
    const m = await waitMetrics(45);

    // percentProfitable is 0.0–1.0 fraction — convert to %
    if (m && m.wr != null) m.wr = Math.round(m.wr * 100 * 10) / 10;
    results[sym.label][v.label] = m || { trades: 0, wr: 0, pf: 0, net: 0 };

    const wr  = m?.wr  != null ? m.wr.toFixed(1) + '%'  : 'N/A';
    const pf  = m?.pf  != null ? m.pf.toFixed(3)        : 'N/A';
    const net = m?.net != null ? '$' + m.net.toFixed(0)  : 'N/A';
    console.log(` trades=${m?.trades ?? '?'} WR=${wr} PF=${pf} net=${net}`);
  }
}

// ── Summary ──
console.log('\n\n════════════════════════════════════════════════════════════════════');
console.log('  SUMMARY — Does adding D1/W1 bias filter improve win rate?');
console.log('════════════════════════════════════════════════════════════════════');
console.log(`${'Symbol'.padEnd(12)} ${'Filter'.padEnd(26)} ${'WR%'.padStart(7)} ${'PF'.padStart(7)} ${'Net $'.padStart(10)} ${'Trades'.padStart(7)} ${'ΔWR'.padStart(7)}`);
console.log('─'.repeat(82));

for (const [symLabel, varMap] of Object.entries(results)) {
  const baseline = varMap[VARIANTS[0].label];
  for (const [vLabel, r] of Object.entries(varMap)) {
    const wr   = r.wr  != null ? r.wr.toFixed(1) + '%'   : 'N/A';
    const pf   = r.pf  != null ? r.pf.toFixed(3)         : 'N/A';
    const net  = r.net != null ? '$' + r.net.toFixed(0)  : 'N/A';
    const dwr  = (baseline?.wr != null && r.wr != null && vLabel !== VARIANTS[0].label)
      ? (r.wr - baseline.wr >= 0 ? '+' : '') + (r.wr - baseline.wr).toFixed(1) + '%' : '';
    const mark = (dwr && parseFloat(dwr) > 0) ? '✅' : (dwr && parseFloat(dwr) < 0) ? '❌' : '';
    console.log(`${symLabel.padEnd(12)} ${vLabel.padEnd(26)} ${wr.padStart(7)} ${pf.padStart(7)} ${net.padStart(10)} ${String(r.trades ?? 0).padStart(7)} ${dwr.padStart(7)} ${mark}`);
  }
  console.log('');
}

console.log('ΔWR = win rate change vs no-filter baseline. ✅ = improved. ❌ = worse.');
console.log('════════════════════════════════════════════════════════════════════\n');
