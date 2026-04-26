import { evaluate } from '/home/ubuntu/tradingview-mcp-jackson/src/connection.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function switchTo(sym, tf) {
  await evaluate(`(function(){
    var a = window.TradingViewApi._activeChartWidgetWV.value();
    a.setSymbol('${sym}', null, true);
    a.setResolution('${tf}');
  })()`);
  await sleep(5000);
}

async function getBarsAround(entryTs, windowSecs) {
  return await evaluate(`(function(){
    try {
      var a = window.TradingViewApi._activeChartWidgetWV.value();
      var barsObj = a._chartWidget.model().model().mainSeries().data().bars();
      var results = [];
      var from = ${entryTs} - 60;
      var to   = ${entryTs} + ${windowSecs};
      barsObj.each(function(idx, bar) {
        var t = bar[0];  // bar is a plain array [ts,o,h,l,c,v]
        if (t >= from && t <= to) {
          results.push({ t: t, o: bar[1], h: bar[2], l: bar[3], c: bar[4] });
        }
      });
      // Report date range of loaded data
      var va0  = barsObj.valueAt(0);
      var vaLast = barsObj.valueAt(barsObj.size() - 1);
      return {
        bars: results,
        totalLoaded: barsObj.size(),
        firstTs: va0     ? va0[0]     : null,
        lastTs:  vaLast  ? vaLast[0]  : null
      };
    } catch(e) { return { error: e.message }; }
  })()`);
}

function checkSLTP(bars, entry, sl, tp, label) {
  if (bars.error || !bars.bars) {
    console.log(`${label}: Error — ${JSON.stringify(bars)}`);
    return '?';
  }
  const rangeFrom = bars.firstTs ? new Date(bars.firstTs*1000).toISOString().slice(0,16) : '?';
  const rangeTo   = bars.lastTs  ? new Date(bars.lastTs*1000).toISOString().slice(0,16)  : '?';
  console.log(`  Loaded bars: ${bars.totalLoaded}, range ${rangeFrom} → ${rangeTo}`);
  console.log(`  Bars from entry time: ${bars.bars.length}`);

  if (bars.bars.length === 0) {
    console.log(`  *** NOT IN LOADED RANGE — need to scroll chart to that date ***`);
    return '?';
  }

  for (const b of bars.bars) {
    const dt = new Date(b.t * 1000).toISOString().slice(11, 19);
    if (b.l <= sl && b.h >= tp) {
      console.log(`  AMBIGUOUS ${dt}: low=${b.l} high=${b.h} — both levels hit same bar`);
      return '?';
    }
    if (b.l <= sl) {
      console.log(`  >>> LOSS  — SL=${sl} hit at ${dt}, bar low=${b.l}`);
      return 'L';
    }
    if (b.h >= tp) {
      console.log(`  >>> WIN   — TP=${tp} hit at ${dt}, bar high=${b.h}`);
      return 'W';
    }
  }
  console.log(`  INCONCLUSIVE — ${bars.bars.length} bars scanned, neither SL nor TP hit`);
  return '?';
}

const trades = [
  { sym: 'BLACKBULL:XAUUSD', tf: '5',  time: '2026-04-16T13:01:24Z', entry: 4819.03,  sl: 4812.9655, tp: 4831.1591, window: 90000,  label: 'XAUUSD Apr16' },
  { sym: 'BLACKBULL:ETHUSD', tf: '5',  time: '2026-04-16T15:01:27Z', entry: 2309.7,   sl: 2304.4486, tp: 2320.2029, window: 100800, label: 'ETHUSD Apr16 (closed ~13:51 Apr17)' },
  { sym: 'BLACKBULL:GBPUSD', tf: '15', time: '2026-04-17T13:01:25Z', entry: 1.3577,   sl: 1.3562,    tp: 1.3607,    window: 25200,  label: 'GBPUSD Apr17 (closed ~19:58)' },
  { sym: 'BLACKBULL:XAGUSD', tf: '5',  time: '2026-04-17T15:01:23Z', entry: 82.562,   sl: 82.1296,   tp: 83.4268,   window: 86400,  label: 'XAGUSD Apr17' },
];

const results = {};
for (const tr of trades) {
  console.log(`\n--- ${tr.label} ---`);
  await switchTo(tr.sym, tr.tf);
  const entryTs = new Date(tr.time).getTime() / 1000;
  const bars = await getBarsAround(entryTs, tr.window);
  results[tr.label] = checkSLTP(bars, tr.entry, tr.sl, tr.tp, tr.label);
}

console.log('\n=== SUMMARY ===');
for (const [k, v] of Object.entries(results)) console.log(`  ${k}: ${v}`);
