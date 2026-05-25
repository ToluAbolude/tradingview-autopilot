/**
 * probe_oil_symbols.mjs — one-shot probe of BlackBull's symbol catalogue
 * for any oil-related instrument (WTI / BRENT / USOIL / CL / etc.).
 * Read-only: opens the chart's symbol search, queries common oil terms,
 * captures whatever suggestions appear, and reports.
 */
import { evaluate } from '../../src/connection.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function querySymbolSearch(term) {
  // Open the chart's symbol search dialog (Ctrl+K equivalent on TradingView)
  await evaluate(`(function(){
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  })()`);
  await sleep(800);

  // Find the search input and type the term
  await evaluate(`(function(){
    var inp = document.querySelector('[data-name="symbol-search-items-dialog"] input, [class*="searchInput"] input, [class*="symbol-search"] input');
    if (!inp) {
      // Fallback: any visible input with symbol-related placeholder
      var inputs = Array.from(document.querySelectorAll('input'));
      inp = inputs.find(function(i){
        var p = (i.getAttribute('placeholder')||i.getAttribute('aria-label')||'').toLowerCase();
        return p.includes('search') || p.includes('symbol');
      });
    }
    if (!inp) return 'no search input';
    inp.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, '${term}');
    return 'typed: ${term}';
  })()`);
  await sleep(1500);

  // Capture suggestion rows
  const results = await evaluate(`(function(){
    var rows = Array.from(document.querySelectorAll('[data-name="symbol-search-result"], [class*="itemRow"], [class*="symbolName"], [role="option"]'));
    var seen = new Set();
    var out = [];
    rows.forEach(function(r){
      var t = (r.textContent||'').replace(/\\s+/g,' ').trim();
      if (!t || t.length > 200 || seen.has(t)) return;
      seen.add(t);
      out.push(t.substring(0, 120));
    });
    return JSON.stringify(out.slice(0, 30));
  })()`);

  // Close the dialog
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, keyCode: 27 }))`);
  await sleep(500);

  return JSON.parse(results || '[]');
}

async function main() {
  console.log('=== BlackBull oil-symbol probe ===');
  for (const term of ['WTI', 'CRUDE', 'OIL', 'BRENT', 'USOIL', 'CL']) {
    console.log(`\n── search: "${term}" ──`);
    const hits = await querySymbolSearch(term);
    if (!hits.length) { console.log('  (no results)'); continue; }
    hits.forEach(h => console.log('  ' + h));
  }
  console.log('\n=== DONE ===');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
