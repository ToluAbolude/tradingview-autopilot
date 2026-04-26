/**
 * backtest_okala_nq.mjs
 * Backtest Okala NQ Scalper on CME_MINI:NQ1! using live TradingView chart.
 * Tests 1M and 5M timeframes.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { setSource, smartCompile, ensurePineEditorOpen } from '../src/core/pine.js';
import { evaluate } from '../src/connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const source = readFileSync(
  join(__dirname, '../../trading-data/strategies/wor_okala_nq_scalper.pine'), 'utf8'
);

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
            maxDD:  Math.round(Math.abs(p.maxStrategyDrawDown||0)*100)/100,
            lNet:   Math.round(((p.long && p.long.netProfit)||0)*100)/100,
            sNet:   Math.round(((p.short && p.short.netProfit)||0)*100)/100,
          };
        } catch(e) {}
      }
    } catch(e) { return { error: e.message }; }
    return { loading: true };
  })()`);
}

async function waitForMetrics(label, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(3000);
    const m = await getMetrics();
    if (m && !m.loading && !m.error && m.trades > 0) {
      return m;
    }
    if (m && m.error) { console.log(`  Error reading metrics: ${m.error}`); break; }
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  return null;
}

async function main() {
  const combos = [
    { sym: 'CME_MINI:NQ1!', tf: '5',  label: 'NQ1! 5M' },
    { sym: 'CME_MINI:NQ1!', tf: '1',  label: 'NQ1! 1M' },
    { sym: 'CME_MINI:NQ1!', tf: '15', label: 'NQ1! 15M' },
  ];

  // Load strategy once
  console.log('Opening Pine editor...');
  await ensurePineEditorOpen();
  await sleep(1500);

  console.log('Injecting Okala NQ source...');
  await setSource({ source });
  await sleep(1000);

  // Switch to first symbol before compiling
  console.log(`Switching to ${combos[0].sym} ${combos[0].tf}M...`);
  await setChart(combos[0].sym, combos[0].tf);
  await sleep(3000);

  console.log('Compiling...');
  const compileResult = await smartCompile();
  console.log('Compile result:', JSON.stringify(compileResult).substring(0, 200));
  await sleep(3000);

  // If smartCompile didn't add to chart, click "Add to chart" / "Update on chart"
  if (!compileResult.study_added) {
    console.log('Clicking Add to chart...');
    const clickResult = await evaluate(`(function() {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var text = (btns[i].textContent || '').trim().toLowerCase();
        var title = (btns[i].getAttribute('title') || '').trim().toLowerCase();
        if (text === 'add to chart' || text === 'update on chart' ||
            title === 'add to chart' || title === 'update on chart') {
          btns[i].click();
          return 'clicked: ' + (btns[i].textContent || '').trim();
        }
      }
      return 'not found';
    })()`);
    console.log('Add to chart:', clickResult);
    await sleep(5000);
  } else {
    await sleep(2000);
  }

  const results = [];

  for (const c of combos) {
    console.log(`\n── ${c.label} ──`);
    await setChart(c.sym, c.tf);
    await sleep(4000);
    process.stdout.write('  Waiting for strategy tester');
    const m = await waitForMetrics(c.label);
    if (m) {
      results.push({ label: c.label, ...m });
      console.log(`  Trades: ${m.trades} | WR: ${m.wr}% | PF: ${m.pf} | Net: $${m.net} | MaxDD: $${m.maxDD}`);
      console.log(`  Long: $${m.lNet} | Short: $${m.sNet}`);
    } else {
      results.push({ label: c.label, error: 'timeout/no data' });
      console.log('  No results (timeout or no data)');
    }
  }

  console.log('\n════════════════════════════════════════');
  console.log('OKALA NQ SCALPER — CME_MINI:NQ1! RESULTS');
  console.log('════════════════════════════════════════');
  for (const r of results) {
    if (r.error) {
      console.log(`${r.label}: ${r.error}`);
    } else {
      const verdict = r.pf >= 1.3 ? '✅ PROFITABLE' : r.pf >= 1.0 ? '⚠ MARGINAL' : '❌ LOSING';
      console.log(`${r.label}: ${verdict} | PF=${r.pf} WR=${r.wr}% Trades=${r.trades} Net=$${r.net} MaxDD=$${r.maxDD}`);
    }
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
