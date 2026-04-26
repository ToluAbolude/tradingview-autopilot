import { connect, evaluate } from './src/connection.js';
import { captureScreenshot } from './src/core/capture.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const RESULTS_DIR = 'C:/Users/Tda-d/words-of-rizdom-research/backtest_results';

const strategies = [
  { name: 'Break & Retest',         file: 'wor_break_and_retest.pine',                    symbol: 'BINANCE:BTCUSDT', tf: '60' },
  { name: 'Marci HTF Mean Reversion', file: 'wor_marci_silfrain_htf_mean_reversion.pine', symbol: 'CME_MINI:NQ1!',  tf: '5'  },
  { name: 'NBB ICT Power of 3',     file: 'wor_nbb_ict_power_of_3.pine',                  symbol: 'CME_MINI:NQ1!',  tf: '15' },
  { name: 'OkalaNQ Scalper',        file: 'wor_okala_nq_scalper.pine',                    symbol: 'CME_MINI:NQ1!',  tf: '5'  },
];

async function ev(expr) {
  const r = await evaluate(expr);
  return r;
}

async function openPineEditor() {
  await ev(`(function(){
    var btns = Array.from(document.querySelectorAll('button'));
    var pine = btns.find(b => (b.getAttribute('aria-label')||'').toLowerCase().includes('pine editor') || (b.textContent||'').trim() === 'Pine Editor');
    if (pine) { pine.click(); return; }
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'e', altKey:true, bubbles:true}));
  })()`);
  await sleep(2000);
}

async function setPineAndCompile(code) {
  // Use the MCP pine_set_source equivalent — inject via CodeMirror
  const b64 = Buffer.from(code).toString('base64');
  await ev(`(function(){
    var code = atob('${b64}');
    // Find CodeMirror 6 editor
    var editorEl = document.querySelector('.cm-content');
    if (editorEl) {
      editorEl.focus();
      // Select all + replace
      var sel = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(editorEl);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, code);
      return 'set via execCommand';
    }
    // Fallback: CodeMirror 5
    var cm5 = document.querySelector('.CodeMirror');
    if (cm5 && cm5.CodeMirror) {
      cm5.CodeMirror.setValue(code);
      return 'set via CM5';
    }
    return 'no editor';
  })()`);
  await sleep(500);
  
  // Click "Add to chart" / compile button
  const r = await ev(`(function(){
    var btns = Array.from(document.querySelectorAll('button'));
    var addBtn = btns.find(b => {
      var t = (b.textContent || '').trim();
      return t === 'Add to chart' || t === 'Compile and add to chart';
    });
    if (addBtn) { addBtn.click(); return 'clicked: ' + addBtn.textContent.trim(); }
    // Try shortcut Ctrl+Enter
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', ctrlKey:true, bubbles:true}));
    return 'tried ctrl+enter';
  })()`);
  await sleep(4000);
  return r;
}

async function setSymbolTF(symbol, tf) {
  await ev(`(function(){
    try {
      var api = window.TradingViewApi._activeChartWidgetWV.value();
      api.setSymbol('${symbol}', null, true);
    } catch(e) {}
  })()`);
  await sleep(2000);
  await ev(`(function(){
    try {
      var api = window.TradingViewApi._activeChartWidgetWV.value();
      api.setResolution('${tf}');
    } catch(e) {}
  })()`);
  await sleep(2000);
}

async function openStrategyTester() {
  await ev(`(function(){
    var btns = Array.from(document.querySelectorAll('[role="tab"], button'));
    var st = btns.find(b => (b.textContent||'').trim() === 'Strategy Tester');
    if (st) { st.click(); return; }
    var el = document.querySelector('[data-name="backtesting"]');
    if (el) el.click();
  })()`);
  await sleep(3000);
}

async function getResults() {
  await sleep(4000);
  return ev(`(function(){
    // Grab performance overview numbers
    var result = {};
    var rows = document.querySelectorAll('[class*="report-data"] tr, [class*="reportData"] tr');
    if (rows.length === 0) rows = document.querySelectorAll('tr');
    var text = '';
    rows.forEach(r => { text += r.innerText.replace(/\n/g, ' | ') + '\n'; });
    if (!text.trim()) {
      // Fallback: grab all stat containers
      var stats = document.querySelectorAll('[class*="profit"], [class*="drawdown"], [class*="trades"], [class*="winRate"]');
      stats.forEach(s => text += s.innerText.trim() + ' | ');
    }
    return text.trim().slice(0, 2000) || 'No results found';
  })()`);
}

mkdirSync(RESULTS_DIR, { recursive: true });

const client = await connect();
console.log('Connected to TradingView\n');

const summary = [];

for (const strat of strategies) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing: ${strat.name}`);
  console.log(`Symbol: ${strat.symbol} | TF: ${strat.tf}M`);
  console.log('='.repeat(60));

  try {
    const code = readFileSync(`C:/Users/Tda-d/words-of-rizdom-research/strategies/${strat.file}`, 'utf8');
    
    // Set symbol and timeframe
    await setSymbolTF(strat.symbol, strat.tf);
    console.log(`  → Chart set to ${strat.symbol} ${strat.tf}M`);

    // Open Pine editor
    await openPineEditor();
    console.log('  → Pine editor opened');

    // Inject and compile
    const compileResult = await setPineAndCompile(code);
    console.log(`  → Compile: ${compileResult}`);

    // Open strategy tester
    await openStrategyTester();
    console.log('  → Strategy Tester opened');

    // Get results
    const results = await getResults();
    console.log('  → Results captured');
    console.log('\nRaw results:\n' + results.slice(0, 500));

    // Screenshot
    const shot = await captureScreenshot({ region: 'full' });
    const shotDest = join(RESULTS_DIR, strat.file.replace('.pine', '_backtest.png'));
    console.log(`  → Screenshot: ${shot.file_path}`);

    summary.push({ name: strat.name, results: results.slice(0, 800) });
    writeFileSync(join(RESULTS_DIR, strat.file.replace('.pine', '_results.txt')), results);

  } catch (e) {
    console.error(`  ✗ Error: ${e.message}`);
    summary.push({ name: strat.name, results: 'ERROR: ' + e.message });
  }

  await sleep(2000);
}

console.log('\n\n' + '='.repeat(60));
console.log('ALL BACKTESTS COMPLETE');
console.log('='.repeat(60));
summary.forEach(s => {
  console.log(`\n${s.name}:`);
  console.log(s.results.slice(0, 300));
});

await client.close();
