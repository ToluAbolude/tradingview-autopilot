import { evaluate } from "../src/connection.js";
await new Promise(r => setTimeout(r, 500));

// Check symbol and timeframe
const state = await evaluate(`(function(){
  try {
    var c = window.TradingViewApi._activeChartWidgetWV.value();
    return JSON.stringify({ sym: c.symbol(), tf: c.resolution() });
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Chart state:', state);
