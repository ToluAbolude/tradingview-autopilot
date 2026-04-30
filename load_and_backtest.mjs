/**
 * Loads jackson_gold_multi_setup.pine into TradingView, compiles it,
 * runs the strategy tester, and captures results.
 */
import { readFileSync, writeFileSync } from 'fs';
import { evaluate, getClient } from './src/connection.js';
import * as chart from './src/core/chart.js';
import * as capture from './src/core/capture.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SOURCE_FILE = '/home/ubuntu/tradingview-mcp-jackson/strategies/jackson_gold_multi_setup.pine';

// ── 1. Set symbol and timeframe ──────────────────────────────────────────────
console.log('→ Setting XAUUSD 1H...');
await chart.setSymbol({ symbol: 'XAUUSD' });
await sleep(1500);
await chart.setTimeframe({ timeframe: '60' });
await sleep(2000);
console.log('  Chart set.');

// ── 2. Read source ───────────────────────────────────────────────────────────
const source = readFileSync(SOURCE_FILE, 'utf8');
console.log(`→ Source: ${source.length} chars`);

// ── 3. Click Pine button to open editor ─────────────────────────────────────
console.log('→ Opening Pine editor...');
await evaluate(`document.querySelector('[aria-label="Pine"]')?.click()`);
await sleep(3000);

// Verify editor is open
const editorState = await evaluate(`(function() {
  var pineEditor = document.querySelector('.monaco-editor.pine-editor-monaco') ||
                   document.querySelector('[class*="pine-editor"]');
  var inputArea = document.querySelector('.pine-editor-monaco .inputarea') ||
                  document.querySelector('[class*="pine"] .inputarea');
  return JSON.stringify({ pineEditor: !!pineEditor, inputArea: !!inputArea });
})()`);
console.log('  Editor state:', editorState);

// ── 4. Inject source via Monaco editor API ───────────────────────────────────
console.log('→ Injecting source...');

// Set source as window variable first (avoids quoting issues)
await evaluate(`window.__jacksonSrc = ${JSON.stringify(source)}`);

// Find Monaco editor instance and set value
const injectResult = await evaluate(`(function() {
  // Method 1: Monaco global
  if (window.monaco && window.monaco.editor) {
    var eds = window.monaco.editor.getEditors();
    var pineEd = eds.find(function(e) {
      var d = e.getDomNode && e.getDomNode();
      return d && (d.closest('[class*="pine"]') || d.closest('.pine-editor-monaco'));
    });
    if (!pineEd && eds.length > 0) pineEd = eds[eds.length - 1]; // fallback: last editor
    if (pineEd) {
      var model = pineEd.getModel();
      model.setValue(window.__jacksonSrc);
      return 'monaco-global: set ' + window.__jacksonSrc.length + ' chars';
    }
  }

  // Method 2: React fiber walk
  var container = document.querySelector('.monaco-editor.pine-editor-monaco') ||
                  document.querySelector('.monaco-editor');
  if (!container) return 'no monaco container';

  var el = container;
  for (var i = 0; i < 20; i++) {
    var fk = el && Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
    if (fk) {
      var cur = el[fk];
      for (var d = 0; d < 200; d++) {
        if (!cur) break;
        var mp = cur.memoizedProps || {};
        if (mp.value && mp.value.monacoEnv) {
          var env = mp.value.monacoEnv;
          if (env.editor) {
            var eds2 = env.editor.getEditors();
            if (eds2.length > 0) {
              eds2[eds2.length - 1].getModel().setValue(window.__jacksonSrc);
              return 'fiber-walk: set ' + window.__jacksonSrc.length + ' chars';
            }
          }
        }
        cur = cur.return;
      }
      break;
    }
    el = el && el.parentElement;
  }

  return 'fallback: could not set via Monaco API';
})()`);

console.log('  Inject result:', injectResult);
await sleep(1500);

// ── 5. Compile: click "Add to chart" button ──────────────────────────────────
console.log('→ Compiling (Add to chart)...');
const addToChart = await evaluate(`(function() {
  // Try various selectors for the Add/Apply button
  var selectors = [
    '[class*="add-to-chart"]',
    '[class*="addToChart"]',
    'button[class*="apply"]',
    'button[class*="compile"]',
  ];
  for (var i = 0; i < selectors.length; i++) {
    var btn = document.querySelector(selectors[i]);
    if (btn && btn.offsetParent) { btn.click(); return 'clicked: ' + selectors[i]; }
  }
  // Text-based fallback
  var btns = Array.from(document.querySelectorAll('button'));
  var add = btns.find(function(b) {
    var t = (b.textContent || '').trim().toLowerCase();
    var al = (b.getAttribute('aria-label') || '').toLowerCase();
    return t === 'add to chart' || al.includes('add to chart') || t === 'apply' || al === 'apply';
  });
  if (add) { add.click(); return 'clicked by text: ' + (add.textContent || '').trim(); }
  return 'not found';
})()`);
console.log('  Add to chart:', addToChart);
await sleep(4000);

// ── 6. Check for compile errors ──────────────────────────────────────────────
const errors = await evaluate(`(function() {
  var errEls = document.querySelectorAll('[class*="error"], [class*="Error"]');
  var msgs = [];
  errEls.forEach(function(e) {
    var t = e.textContent.trim();
    if (t && t.length > 5 && t.length < 200) msgs.push(t);
  });
  return msgs.slice(0, 10);
})()`);
if (errors && errors.length) {
  console.log('  Compile errors/warnings:', JSON.stringify(errors));
} else {
  console.log('  No errors detected.');
}

// ── 7. Open Strategy Tester ───────────────────────────────────────────────────
console.log('→ Opening Strategy Tester...');
const openST = await evaluate(`(function() {
  var btns = Array.from(document.querySelectorAll('button, [role="tab"]'));
  var st = btns.find(function(b) {
    var label = (b.getAttribute('aria-label') || b.textContent || '').toLowerCase();
    return label.includes('strategy tester') || label.includes('backtesting');
  });
  if (!st) st = document.querySelector('[data-name="backtesting-dialog-button"]');
  if (st) { st.click(); return 'opened: ' + (st.textContent || st.getAttribute('aria-label') || '').trim(); }
  return 'not found';
})()`);
console.log('  Strategy Tester:', openST);
await sleep(6000);

// ── 8. Wait for backtest to finish then scrape results ───────────────────────
console.log('→ Reading backtest results...');

// Click "Overview" or "Summary" tab in the tester
await evaluate(`(function() {
  var tabs = Array.from(document.querySelectorAll('[role="tab"], [class*="tab"]'));
  var ov = tabs.find(function(t) {
    var txt = (t.textContent || '').trim().toLowerCase();
    return txt === 'overview' || txt === 'summary';
  });
  if (ov) ov.click();
})()`);
await sleep(2000);

// Scrape the stats table
const statsRaw = await evaluate(`(function() {
  var stats = {};

  // Try structured stat-value pairs
  var allEls = Array.from(document.querySelectorAll('*'));
  allEls.forEach(function(el) {
    var ch = el.children;
    if (ch.length < 2) return;
    var label = (ch[0].textContent || '').trim();
    var val   = (ch[1].textContent || '').trim();
    var keywords = ['Net Profit','Gross Profit','Gross Loss','Max Drawdown','Win Rate',
                    'Profit Factor','Total Trades','Winning Trades','Losing Trades',
                    'Avg Win','Avg Loss','Largest Win','Largest Loss','Sharpe',
                    'Buy & Hold','Avg Trade','Max Run-up'];
    keywords.forEach(function(kw) {
      if (label.toLowerCase().includes(kw.toLowerCase()) && val && !stats[kw]) {
        stats[kw] = val;
      }
    });
  });

  // Also scrape all visible text in the tester panel
  var panel = document.querySelector('[data-name="backtesting-dialog"]') ||
              document.querySelector('[class*="backtesting"]') ||
              document.querySelector('[class*="strategyReport"]');
  var rawText = panel ? panel.innerText.substring(0, 3000) : 'panel not found';

  return { stats: stats, rawText: rawText };
})()`);

console.log('\n=== STATS ===');
if (statsRaw && statsRaw.stats && Object.keys(statsRaw.stats).length) {
  console.log(JSON.stringify(statsRaw.stats, null, 2));
} else {
  console.log('(No structured stats found)');
}
console.log('\n=== RAW TEXT (first 1500 chars) ===');
console.log((statsRaw?.rawText || '').substring(0, 1500));

// ── 9. Screenshot ─────────────────────────────────────────────────────────────
console.log('\n→ Taking screenshot...');
const ss = await capture.captureScreenshot({ region: 'full' });
console.log('  Screenshot:', ss?.path || 'captured');

// Save results
writeFileSync('/tmp/jackson_backtest_results.json', JSON.stringify({
  strategy: 'Jackson Gold Multi-Setup',
  symbol: 'XAUUSD',
  timeframe: '1H',
  timestamp: new Date().toISOString(),
  compileResult: injectResult,
  stats: statsRaw?.stats,
  rawText: statsRaw?.rawText
}, null, 2));

console.log('\nDone. Results at /tmp/jackson_backtest_results.json');
(await getClient()).close();
