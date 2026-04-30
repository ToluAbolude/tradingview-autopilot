/**
 * Backtest runner for Jackson Gold Multi-Setup strategy.
 * Loads the Pine strategy, runs it on XAUUSD 1H in TradingView,
 * and returns key performance metrics.
 */
import { readFileSync, writeFileSync } from 'fs';
import { evaluate, evaluateAsync, getClient } from '../../src/connection.js';
import * as pine from '../../src/core/pine.js';
import * as chart from '../../src/core/chart.js';
import * as capture from '../../src/core/capture.js';

const STRATEGY_PATH = '/home/ubuntu/tradingview-mcp-jackson/strategies/jackson_gold_multi_setup.pine';
const RESULTS_PATH  = '/tmp/jackson_backtest_results.json';
const SS_PATH       = '/tmp/jackson_backtest.png';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Step 1: Set chart to XAUUSD 1H ─────────────────────────────────────────
console.log('Setting chart: XAUUSD 1H...');
await chart.setSymbol({ symbol: 'XAUUSD' });
await sleep(2000);
await chart.setTimeframe({ timeframe: '60' });
await sleep(2000);
console.log('Chart set.');

// ── Step 2: Load the Pine strategy source ────────────────────────────────────
console.log('Loading strategy source...');
const source = readFileSync(STRATEGY_PATH, 'utf8');
console.log(`Source: ${source.length} chars, ${source.split('\n').length} lines`);

// ── Step 3: Open Pine editor and inject source ───────────────────────────────
console.log('Opening Pine editor...');
const editorOpen = await pine.ensurePineEditorOpen();
if (!editorOpen) {
  console.error('ERROR: Could not open Pine editor');
  process.exit(1);
}
await sleep(1500);

console.log('Injecting source...');
const setResult = await pine.setSource({ source });
if (!setResult.success) {
  console.error('ERROR setting source:', setResult.error);
  process.exit(1);
}
await sleep(1000);

// ── Step 4: Compile ──────────────────────────────────────────────────────────
console.log('Compiling...');
const compileResult = await pine.smartCompile({});
if (!compileResult.success) {
  console.error('Compile error:', JSON.stringify(compileResult, null, 2));
  process.exit(1);
}
console.log('Compiled:', compileResult.type, compileResult.status);

await sleep(2000);

// ── Step 5: Open Strategy Tester ────────────────────────────────────────────
console.log('Opening Strategy Tester...');
await evaluate(`
  (function() {
    // Try to open strategy tester tab
    var btns = Array.from(document.querySelectorAll('[data-name], button, [role="tab"]'));
    var st = btns.find(b =>
      (b.textContent || '').trim().toLowerCase().includes('strategy tester') ||
      (b.getAttribute('data-name') || '').includes('backtesting') ||
      (b.getAttribute('aria-label') || '').toLowerCase().includes('strategy')
    );
    if (st) { st.click(); return 'clicked strategy tester'; }
    return 'not found';
  })()
`);
await sleep(3000);

// Also try clicking the "Strategy Tester" bottom tab
await evaluate(`
  (function() {
    var tabs = Array.from(document.querySelectorAll('[class*="tab"], [role="tab"]'));
    var st = tabs.find(t => (t.textContent || '').trim() === 'Strategy Tester');
    if (st) { st.click(); return 'tab clicked'; }
    // Try data-name attribute
    var dn = document.querySelector('[data-name="backtesting-dialog-button"]');
    if (dn) { dn.click(); return 'data-name clicked'; }
    return 'not found';
  })()
`);
await sleep(5000);

// ── Step 6: Read strategy performance stats ──────────────────────────────────
console.log('Reading backtest results...');

const stats = await evaluate(`
  (function() {
    // Look for performance numbers in the strategy tester panel
    var result = {};

    // Try to find the main stats via React fiber
    var panels = document.querySelectorAll('[class*="report"], [class*="backtesting"], [class*="strategy"]');

    // Collect all visible text that looks like statistics
    var statElems = document.querySelectorAll('[class*="value"], [class*="metric"], [class*="statistic"], [class*="performance"]');
    var texts = [];
    statElems.forEach(function(el) {
      var t = el.textContent.trim();
      if (t && t.length < 50) texts.push(t);
    });

    // Also try to grab specific stat cells
    var cells = document.querySelectorAll('[class*="cell"], td, [class*="row"]');
    var cellTexts = [];
    cells.forEach(function(c) {
      var t = c.textContent.trim();
      if (t && t.length < 100 && t.length > 2) cellTexts.push(t);
    });

    return {
      statTexts: texts.slice(0, 50),
      cellTexts: cellTexts.slice(0, 80),
      panelCount: panels.length
    };
  })()
`);

console.log('Panel count:', stats.panelCount);

// Try a more targeted extraction via the Summary tab
await evaluate(`
  (function() {
    var tabs = Array.from(document.querySelectorAll('[class*="tab"], [role="tab"]'));
    var summary = tabs.find(t => (t.textContent || '').trim() === 'Overview' || (t.textContent || '').trim() === 'Summary');
    if (summary) summary.click();
  })()
`);
await sleep(2000);

// Try to extract using the known TradingView strategy report structure
const perfData = await evaluateAsync(`
  (async function() {
    // Walk React tree to find strategy report data
    function findReportData(el, depth) {
      if (!depth || depth > 50) return null;
      var fk = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (!fk) return null;
      var fiber = el[fk];
      var cur = fiber;
      for (var i = 0; i < 200; i++) {
        if (!cur) break;
        var mp = cur.memoizedProps || {};
        var ms = cur.memoizedState || {};
        // Look for strategy stats object
        if (mp.strategyReport || mp.report || mp.stats || mp.performance) {
          return mp.strategyReport || mp.report || mp.stats || mp.performance;
        }
        if (ms.report || ms.stats) return ms.report || ms.stats;
        cur = cur.return;
      }
      return null;
    }

    var panel = document.querySelector('[data-name="backtesting-dialog"]') ||
                document.querySelector('[class*="backtesting"]') ||
                document.querySelector('[class*="strategyReport"]');

    if (panel) {
      var data = findReportData(panel, 30);
      if (data) return JSON.stringify(data).substring(0, 5000);
    }

    // Fallback: scrape visible text from the stats panel
    var allText = [];
    var statRows = document.querySelectorAll('[class*="report"] [class*="row"], [class*="backtesting"] tr, [class*="statistics"] [class*="item"]');
    statRows.forEach(function(r) {
      allText.push(r.textContent.trim().replace(/\\s+/g, ' '));
    });
    return JSON.stringify({ scraped: allText.slice(0, 60) });
  })()
`);

console.log('Performance data:', perfData);

// ── Step 7: Screenshot ───────────────────────────────────────────────────────
console.log('Taking screenshot...');
const ssResult = await capture.captureScreenshot({ region: 'full' });
console.log('Screenshot:', ssResult.path);

// ── Step 8: Also try to get the stats via table text scraping ───────────────
const tableData = await evaluate(`
  (function() {
    // Find all table-like stat rows in the strategy tester
    var rows = [];

    // Common TradingView strategy report stat names
    var statNames = [
      'Net Profit', 'Gross Profit', 'Gross Loss', 'Max Drawdown',
      'Win Rate', 'Profit Factor', 'Total Trades', 'Winning Trades',
      'Losing Trades', 'Avg Win', 'Avg Loss', 'Largest Win',
      'Largest Loss', 'Avg Bars in Trade', 'Sharpe Ratio'
    ];

    // Scrape all text content that contains stat keywords
    var allElems = document.querySelectorAll('*');
    var found = {};
    for (var i = 0; i < allElems.length; i++) {
      var el = allElems[i];
      var children = el.children;
      if (children.length !== 2) continue;
      var label = children[0].textContent.trim();
      var val   = children[1].textContent.trim();
      var matchedStat = statNames.find(function(s) {
        return label.toLowerCase().includes(s.toLowerCase());
      });
      if (matchedStat && val) {
        found[matchedStat] = val;
      }
    }

    return found;
  })()
`);

console.log('\n=== BACKTEST STATS ===');
console.log(JSON.stringify(tableData, null, 2));

// Save results
const results = {
  strategy: 'Jackson Gold Multi-Setup',
  symbol: 'XAUUSD',
  timeframe: '1H',
  timestamp: new Date().toISOString(),
  rawPerf: perfData,
  stats: tableData,
  screenshot: SS_PATH
};

writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
console.log('\nResults saved to:', RESULTS_PATH);
console.log('Screenshot at:', ssResult?.path || SS_PATH);
console.log('Done.');

await (await getClient()).close();
