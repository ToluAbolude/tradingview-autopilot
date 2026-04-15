/**
 * Multi-timeframe × symbol sweep for Smart Trail HA Scalper
 * Tests all combos and ranks by net P&L + profit factor.
 * Usage: node scripts/tf_symbol_sweep.mjs
 */
import { evaluate } from '../src/connection.js';

const SYMBOLS = [
  'BLACKBULL:NAS100',
  'BLACKBULL:SPX500',
  'BLACKBULL:US30',
  'BLACKBULL:XAUUSD',
  'BLACKBULL:BTCUSD',
  'BLACKBULL:ETHUSD',
];

const TIMEFRAMES = ['1', '3', '5', '15', '30'];

const CHART_API = "window.TradingViewApi._activeChartWidgetWV.value()";

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function setSymbol(sym) {
  await evaluate(`(function(){ ${CHART_API}.setSymbol('${sym}', null, true); })()`);
}

async function setTimeframe(tf) {
  await evaluate(`(function(){ ${CHART_API}.setResolution('${tf}'); })()`);
}

async function getMetrics() {
  return evaluate(`
    (function() {
      var chart = ${CHART_API}._chartWidget;
      var sources = chart.model().model().dataSources();
      var strat = null;
      for (var i = 0; i < sources.length; i++) {
        var s = sources[i];
        if (!s.metaInfo) continue;
        try {
          var desc = s.metaInfo().description || '';
          if (desc.indexOf('Smart Trail') >= 0) { strat = s; break; }
        } catch(e) {}
      }
      if (!strat) return { error: 'not found' };
      var rd = null;
      try {
        rd = strat.reportData ? (typeof strat.reportData === 'function' ? strat.reportData() : strat.reportData) : null;
        if (rd && typeof rd.value === 'function') rd = rd.value();
      } catch(e) { return { error: 'rd: ' + e.message }; }
      if (!rd || !rd.performance || !rd.performance.all) return { error: 'loading' };
      var all = rd.performance.all;
      var lng = rd.performance.long  || {};
      var sht = rd.performance.short || {};
      var p   = rd.performance;
      return {
        trades:    all.totalTrades  || 0,
        netPnl:    Math.round((all.netProfit || 0) * 100) / 100,
        gProfit:   Math.round((all.grossProfit || 0) * 100) / 100,
        gLoss:     Math.round((all.grossLoss || 0) * 100) / 100,
        comm:      Math.round((all.commissionPaid || 0) * 100) / 100,
        wr:        Math.round(((all.percentProfitable || 0) * 100) * 10) / 10,
        pf:        Math.round((all.profitFactor || 0) * 1000) / 1000,
        avgW:      Math.round((all.avgWinTrade || 0) * 100) / 100,
        avgL:      Math.round((all.avgLosTrade || 0) * 100) / 100,
        maxDD:     Math.round((p.maxStrategyDrawDown || 0) * 100) / 100,
        maxDDpct:  Math.round((p.maxStrategyDrawDownPercent || 0) * 10000) / 100,
        sharpe:    Math.round((p.sharpeRatio || 0) * 1000) / 1000,
        lTrades:   lng.totalTrades || 0,
        lWR:       Math.round(((lng.percentProfitable || 0) * 100) * 10) / 10,
        lPnl:      Math.round((lng.netProfit || 0) * 100) / 100,
        sTrades:   sht.totalTrades || 0,
        sWR:       Math.round(((sht.percentProfitable || 0) * 100) * 10) / 10,
        sPnl:      Math.round((sht.netProfit || 0) * 100) / 100,
      };
    })()
  `);
}

async function waitForMetrics(maxWait = 8000) {
  const step = 1000;
  for (let waited = 0; waited < maxWait; waited += step) {
    await sleep(step);
    const m = await getMetrics();
    if (m && !m.error) return m;
  }
  return await getMetrics();
}

async function main() {
  const results = [];
  const total = SYMBOLS.length * TIMEFRAMES.length;
  let done = 0;

  for (const sym of SYMBOLS) {
    for (const tf of TIMEFRAMES) {
      done++;
      process.stdout.write(`[${done}/${total}] ${sym} ${tf}M... `);
      try {
        await setSymbol(sym);
        await setTimeframe(tf);
        const m = await waitForMetrics(8000);

        if (m && m.error) {
          console.log(`skip (${m.error})`);
          results.push({ sym, tf, error: m.error });
        } else if (!m || m.trades === 0) {
          console.log(`0 trades`);
          results.push({ sym, tf, trades: 0 });
        } else {
          console.log(`✓ ${m.trades}tr | net $${m.netPnl} | WR ${m.wr}% | PF ${m.pf} | DD -$${m.maxDD}`);
          results.push({ sym, tf, ...m });
        }
      } catch (err) {
        console.log(`ERROR: ${err.message}`);
        results.push({ sym, tf, error: err.message });
      }
    }
  }

  console.log('\n\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║   SMART TRAIL HA SCALPER — FULL TF × SYMBOL MATRIX (3% pos size)  ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  const valid = results.filter(r => !r.error && r.trades > 0);

  // Group by symbol
  for (const sym of SYMBOLS) {
    const symResults = valid.filter(r => r.sym === sym);
    if (symResults.length === 0) continue;
    console.log(`\n── ${sym} ──`);
    console.log('TF    Trades  Net P&L     WR%    PF      MaxDD     Sharpe  L-WR   S-WR   L-Pnl    S-Pnl');
    console.log('─'.repeat(95));
    for (const r of symResults.sort((a, b) => Number(a.tf) - Number(b.tf))) {
      const mark = r.netPnl > 0 ? '✓' : ' ';
      console.log(
        `${mark}${r.tf}M`.padEnd(6),
        String(r.trades).padEnd(8),
        `$${r.netPnl}`.padEnd(12),
        `${r.wr}%`.padEnd(7),
        String(r.pf).padEnd(8),
        `-$${r.maxDD}`.padEnd(10),
        String(r.sharpe).padEnd(8),
        `${r.lWR}%`.padEnd(7),
        `${r.sWR}%`.padEnd(7),
        `$${r.lPnl}`.padEnd(9),
        `$${r.sPnl}`
      );
    }
  }

  console.log('\n\n── TOP 10 COMBOS by Net P&L ──');
  console.log('Rank  Symbol              TF    Trades  Net P&L    WR%    PF      MaxDD    Sharpe');
  console.log('─'.repeat(90));
  valid
    .filter(r => r.trades >= 3)
    .sort((a, b) => b.netPnl - a.netPnl)
    .slice(0, 10)
    .forEach((r, i) => {
      console.log(
        `${i + 1}.`.padEnd(6),
        r.sym.padEnd(20),
        `${r.tf}M`.padEnd(6),
        String(r.trades).padEnd(8),
        `$${r.netPnl}`.padEnd(11),
        `${r.wr}%`.padEnd(7),
        String(r.pf).padEnd(8),
        `-$${r.maxDD}`.padEnd(9),
        r.sharpe
      );
    });

  console.log('\n\n── FULL JSON ──');
  console.log(JSON.stringify(results, null, 2));
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
