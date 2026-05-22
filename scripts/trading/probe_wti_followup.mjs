/**
 * probe_wti_followup.mjs — Set chart to BLACKBULL:WTI then inspect the Trade
 * panel to confirm whether BlackBull's broker integration recognises the symbol.
 */
import { evaluate } from '../../src/connection.js';

async function snap(name, js) {
  console.log(`\n--- ${name} ---`);
  try { console.log(await evaluate(js)); }
  catch (e) { console.log('ERR:', e.message); }
}

// Use TradingView's URL hash to switch symbol (cheaper than driving the UI)
console.log('Setting chart symbol to BLACKBULL:WTI ...');
await evaluate(`(function(){
  try {
    var api = window.TradingViewApi || (window.tradingViewWidget && window.tradingViewWidget.chart);
    if (api && api._activeChartWidgetWV) {
      api._activeChartWidgetWV.value().setSymbol('BLACKBULL:WTI');
      return 'setSymbol called';
    }
  } catch(e) { return 'err: ' + e.message; }
  return 'no api';
})()`);

await new Promise(r => setTimeout(r, 4000));

await snap('After symbol set — chart header text', `(function(){
  var els = document.querySelectorAll('button, span, div');
  var hits = new Set();
  for (var i = 0; i < els.length && hits.size < 20; i++) {
    var t = (els[i].textContent || '').trim();
    if (/^WTI/.test(t) || /^USOIL/.test(t) || /^XTI/.test(t) || /^OIL/.test(t)) {
      if (t.length < 50) hits.add(t);
    }
  }
  return JSON.stringify(Array.from(hits));
})()`);

await snap('Trade panel — open and read instrument header', `(function(){
  var btns = document.querySelectorAll('button');
  for (var i = 0; i < btns.length; i++) {
    if ((btns[i].textContent || '').trim() === 'Trade') { btns[i].click(); return 'clicked'; }
  }
  return 'no Trade button';
})()`);

await new Promise(r => setTimeout(r, 2000));

await snap('Trade panel instrument / errors', `(function(){
  // Find the trade-panel headings and the Buy/Sell buttons
  var info = { instruments: [], buySell: [], errors: [], wtiTokens: [] };
  document.querySelectorAll('button').forEach(function(b){
    var t = (b.textContent || '').trim();
    if (/^(Buy|Sell)\\b/.test(t) && t.length < 80) info.buySell.push(t);
  });
  document.querySelectorAll('div, span, h1, h2, h3, h4').forEach(function(el){
    var t = (el.textContent || '').trim();
    if (t.length < 40 && /^[A-Z][A-Z0-9._-]{2,12}$/.test(t)) info.instruments.push(t);
  });
  document.querySelectorAll('[class*="error"], [role="alert"], [class*="warning"]').forEach(function(el){
    var t = (el.textContent || '').trim();
    if (t && t.length < 200) info.errors.push(t);
  });
  document.querySelectorAll('*').forEach(function(el){
    var t = (el.textContent || el.innerText || '').trim();
    if (t.length > 30) return;
    if (/(WTI|USOIL|XTI|CRUDE)/.test(t)) info.wtiTokens.push(t);
  });
  // Dedupe
  info.instruments = Array.from(new Set(info.instruments)).slice(0, 30);
  info.buySell     = Array.from(new Set(info.buySell)).slice(0, 6);
  info.errors      = Array.from(new Set(info.errors)).slice(0, 10);
  info.wtiTokens   = Array.from(new Set(info.wtiTokens)).slice(0, 10);
  return JSON.stringify(info);
})()`);

console.log('\n=== Done ===');
process.exit(0);
