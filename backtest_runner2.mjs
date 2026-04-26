import { connect, evaluate } from './src/connection.js';
import { captureScreenshot } from './src/core/capture.js';
import * as pine from './src/core/pine.js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const RESULTS_DIR = 'C:/Users/Tda-d/words-of-rizdom-research/backtest_results';
mkdirSync(RESULTS_DIR, { recursive: true });

const strategies = [
  { name: 'Break & Retest',           file: 'wor_break_and_retest.pine',                    symbol: 'BINANCE:BTCUSDT', tf: '60' },
  { name: 'Marci HTF Mean Reversion', file: 'wor_marci_silfrain_htf_mean_reversion.pine',   symbol: 'CME_MINI:NQ1!',   tf: '5'  },
  { name: 'NBB ICT Power of 3',       file: 'wor_nbb_ict_power_of_3.pine',                  symbol: 'CME_MINI:NQ1!',   tf: '15' },
  { name: 'OkalaNQ Scalper',          file: 'wor_okala_nq_scalper.pine',                    symbol: 'CME_MINI:NQ1!',   tf: '1'  },
];

async function setSymbolTF(symbol, tf) {
  await evaluate(`(function(){
    try {
      var api = window.TradingViewApi._activeChartWidgetWV.value();
      api.setSymbol('${symbol}', null, true);
    } catch(e) { console.error('symbol err', e.message); }
  })()`);
  await sleep(2500);
  await evaluate(`(function(){
    try {
      var api = window.TradingViewApi._activeChartWidgetWV.value();
      api.setResolution('${tf}');
    } catch(e) { console.error('tf err', e.message); }
  })()`);
  await sleep(2500);
}

async function openStrategyTester() {
  await evaluate(`(function(){
    var tabs = Array.from(document.querySelectorAll('[role="tab"], button, [data-name]'));
    var st = tabs.find(b => (b.textContent||'').trim() === 'Strategy Tester' || b.getAttribute('data-name') === 'backtesting');
    if (st) st.click();
  })()`);
  await sleep(3000);
}

async function getStrategyResults() {
  // Try multiple approaches to extract the performance table
  return evaluate(`(function(){
    var lines = [];
    // Overview tab stats
    var labelEls = document.querySelectorAll('[class*="firstRow"] [class*="title"], [class*="secondRow"] [class*="title"]');
    var valueEls = document.querySelectorAll('[class*="firstRow"] [class*="value"], [class*="secondRow"] [class*="value"]');
    if (labelEls.length > 0) {
      for (var i = 0; i < Math.min(labelEls.length, valueEls.length); i++) {
        lines.push(labelEls[i].textContent.trim() + ': ' + valueEls[i].textContent.trim());
      }
      return lines.join(' | ');
    }
    // Fallback: grab all visible text in the bottom panel
    var panel = document.querySelector('[data-name="backtesting"], [class*="strategyReport"], [class*="backtestReport"]');
    if (panel) return panel.innerText.replace(/[ \t]+/g, ' ').slice(0, 1500);
    return 'No results panel found';
  })()`);
}

const client = await connect();
console.log('Connected to TradingView\n');

const allResults = [];

for (const strat of strategies) {
  console.log('\n' + '='.repeat(60));
  console.log('Strategy: ' + strat.name);
  console.log('Symbol:   ' + strat.symbol + ' | TF: ' + strat.tf + 'M');
  console.log('='.repeat(60));

  try {
    const code = readFileSync('C:/Users/Tda-d/words-of-rizdom-research/strategies/' + strat.file, 'utf8');

    // 1. Set symbol + timeframe
    await setSymbolTF(strat.symbol, strat.tf);
    console.log('  ✓ Symbol/TF set');

    // 2. Open Pine editor
    await pine.ensurePineEditorOpen();
    console.log('  ✓ Pine editor open');
    await sleep(1000);

    // 3. Set source
    await pine.setSource({ source: code });
    console.log('  ✓ Source injected');
    await sleep(500);

    // 4. Compile
    const compileResult = await pine.smartCompile();
    console.log('  ✓ Compiled:', compileResult.success ? 'OK' : 'ERRORS: ' + JSON.stringify(compileResult.errors?.slice(0,2)));
    await sleep(3000);

    // 5. Open strategy tester
    await openStrategyTester();
    console.log('  ✓ Strategy Tester opened');

    // 6. Get results
    const rawResults = await getStrategyResults();
    console.log('\n  Results:\n  ' + rawResults.slice(0, 600).replace(/\n/g, '\n  '));

    // 7. Screenshot
    const shot = await captureScreenshot({ region: 'full' });

    const resultFile = join(RESULTS_DIR, strat.file.replace('.pine', '_results.txt'));
    writeFileSync(resultFile, rawResults);
    console.log('  ✓ Saved: ' + resultFile);

    allResults.push({ name: strat.name, raw: rawResults });

  } catch(e) {
    console.error('  ✗ Error:', e.message);
    allResults.push({ name: strat.name, raw: 'ERROR: ' + e.message });
  }

  await sleep(2000);
}

await client.close();

console.log('\n\n' + '='.repeat(60));
console.log('SUMMARY');
console.log('='.repeat(60));
allResults.forEach(r => {
  console.log('\n► ' + r.name);
  console.log(r.raw.slice(0, 400));
});
