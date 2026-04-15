/**
 * Verify v2 Smart Trail results on top 3 combos.
 * Compares against v1 baseline.
 */
import { evaluate } from '../src/connection.js';

const COMBOS = [
  { sym: 'BLACKBULL:BTCUSD',  tf: '15', v1: { net: 108.81, wr: 44.4, pf: 1.784 } },
  { sym: 'BLACKBULL:ETHUSD',  tf: '5',  v1: { net: 70.74,  wr: 41.7, pf: 1.929 } },
  { sym: 'BLACKBULL:XAUUSD',  tf: '30', v1: { net: 38.49,  wr: 44.4, pf: 1.964 } },
  { sym: 'BLACKBULL:XAUUSD',  tf: '15', v1: { net: 35.54,  wr: 28.6, pf: 1.864 } },
  { sym: 'BLACKBULL:ETHUSD',  tf: '1',  v1: { net: 17.88,  wr: 66.7, pf: 2.728 } },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
          var a = rd.performance.all, p = rd.performance;
          return {
            trades: a.totalTrades || 0,
            net:    Math.round((a.netProfit || 0)*100)/100,
            wr:     Math.round(((a.percentProfitable||0)*100)*10)/10,
            pf:     Math.round((a.profitFactor||0)*1000)/1000,
            maxDD:  Math.round((p.maxStrategyDrawDown||0)*100)/100,
            lWR:    Math.round(((rd.performance.long?.percentProfitable||0)*100)*10)/10,
            sWR:    Math.round(((rd.performance.short?.percentProfitable||0)*100)*10)/10,
            lNet:   Math.round((rd.performance.long?.netProfit||0)*100)/100,
            sNet:   Math.round((rd.performance.short?.netProfit||0)*100)/100,
          };
        }
      } catch(e) {}
    }
    return { error: 'not found' };
  })()`);
}

async function waitLoad() {
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    const m = await getMetrics();
    if (m && !m.error && !m.loading) return m;
  }
  return await getMetrics();
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║   Smart Trail v2 Verification — Top 5 Combos                  ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');
  console.log('Combo             TF   Trades  Net P&L    WR%    PF      DD      L-Net    S-Net   vs v1');
  console.log('─'.repeat(100));

  for (const c of COMBOS) {
    process.stdout.write(`${c.sym.replace('BLACKBULL:','')} ${c.tf}M... `);
    await setChart(c.sym, c.tf);
    const m = await waitLoad();

    if (!m || m.error || m.loading) {
      console.log('ERROR:', JSON.stringify(m));
      continue;
    }

    const netDiff  = m.net - c.v1.net;
    const indicator = netDiff > 0 ? `▲+$${netDiff.toFixed(2)}` : `▼$${netDiff.toFixed(2)}`;

    console.log(
      `\n${c.sym.replace('BLACKBULL:','').padEnd(8)} ${c.tf}M`.padEnd(14),
      String(m.trades).padEnd(8),
      `$${m.net}`.padEnd(11),
      `${m.wr}%`.padEnd(7),
      String(m.pf).padEnd(8),
      `-$${m.maxDD}`.padEnd(8),
      `$${m.lNet}`.padEnd(9),
      `$${m.sNet}`.padEnd(8),
      indicator
    );
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
