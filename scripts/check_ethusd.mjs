import { evaluate } from '/home/ubuntu/tradingview-mcp-jackson/src/connection.js';
import { execSync } from 'child_process';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CHART = "window.TradingViewApi._activeChartWidgetWV.value()";
const BARS  = `${CHART}._chartWidget.model().mainSeries().bars()`;

// Switch to ETHUSD 5M
await evaluate(`(function(){
  var a = ${CHART};
  a.setSymbol('BLACKBULL:ETHUSD', null, true);
  a.setResolution('5');
})()`);
await sleep(5000);

// Find TradingView window and click to focus it on the chart area
const winInfo = execSync('DISPLAY=:1 xdotool search --name "TradingView" 2>/dev/null | head -1', {encoding:'utf8'}).trim();
console.log('Window ID:', winInfo);

if (winInfo) {
  // Move mouse to chart center and click to focus
  execSync(`DISPLAY=:1 xdotool mousemove --window ${winInfo} 800 400 click 1 2>/dev/null || true`);
  await sleep(500);

  // Press Left arrow many times to scroll back to Apr 16 (about 3 days × ~300 bars/day = 900 presses)
  // Each left press scrolls ~1 bar on TradingView
  console.log('Scrolling left via keyboard (1000 presses)...');
  execSync(`DISPLAY=:1 xdotool key --window ${winInfo} --repeat 1000 --delay 5 Left 2>/dev/null || true`);
  await sleep(3000);

  // Check if data loaded
  const mid = await evaluate(`(function(){
    var bars = ${BARS};
    var v0 = bars.valueAt(bars.firstIndex());
    return { firstTs: v0?v0[0]:null, size: bars.size() };
  })()`);
  console.log('After 1000 left presses:', mid.firstTs ? new Date(mid.firstTs*1000).toISOString().slice(0,16) : '?', '| size:', mid.size);

  // If still not there, press more
  const entryTs = new Date('2026-04-16T15:01:27Z').getTime() / 1000;
  if (!mid.firstTs || mid.firstTs > entryTs) {
    console.log('Pressing more left keys...');
    execSync(`DISPLAY=:1 xdotool key --window ${winInfo} --repeat 1000 --delay 5 Left 2>/dev/null || true`);
    await sleep(3000);
  }
} else {
  console.log('Window not found via xdotool — trying mousemove on screen center');
  execSync(`DISPLAY=:1 xdotool mousemove 800 400 click 1 2>/dev/null || true`);
  execSync(`DISPLAY=:1 xdotool key --repeat 1000 --delay 5 Left 2>/dev/null || true`);
  await sleep(3000);
}

// Read bars for Apr 16 entry
const entryTs = new Date('2026-04-16T15:01:27Z').getTime() / 1000;
const final = await evaluate(`(function(){
  var bars = ${BARS};
  var v0 = bars.valueAt(bars.firstIndex());
  var vn = bars.valueAt(bars.lastIndex());
  var entry = ${entryTs};
  var sl = 2304.4486, tp = 2320.2029;
  var results = [];
  for (var i = bars.firstIndex(); i <= bars.lastIndex(); i++) {
    var v = bars.valueAt(i);
    if (!v) continue;
    var t = v[0];
    if (t >= entry - 60 && t <= entry + 100800) results.push({ t: t, h: v[2], l: v[3] });
  }
  return {
    firstTs: v0?v0[0]:null, lastTs: vn?vn[0]:null, size: bars.size(),
    barsFromEntry: results.length, bars: results
  };
})()`);

console.log('Final range:', final.firstTs ? new Date(final.firstTs*1000).toISOString().slice(0,16) : '?',
            '→', final.lastTs ? new Date(final.lastTs*1000).toISOString().slice(0,16) : '?', '| size:', final.size);
console.log('Bars from entry:', final.barsFromEntry);

const sl = 2304.4486, tp = 2320.2029;
let result = '?';
if (final.bars && final.bars.length > 0) {
  for (const b of final.bars) {
    const dt = new Date(b.t * 1000).toISOString().slice(11, 19);
    if (b.l <= sl && b.h >= tp) { console.log(`AMBIGUOUS at ${dt}`); break; }
    if (b.l <= sl) { console.log(`>>> LOSS — SL=${sl} hit at ${dt}, low=${b.l}`); result = 'L'; break; }
    if (b.h >= tp) { console.log(`>>> WIN  — TP=${tp} hit at ${dt}, high=${b.h}`); result = 'W'; break; }
  }
  if (result === '?') console.log(`INCONCLUSIVE over ${final.barsFromEntry} bars`);
} else {
  console.log('*** DATA STILL NOT LOADED — marking as unknown ***');
}
console.log('ETHUSD result:', result);
