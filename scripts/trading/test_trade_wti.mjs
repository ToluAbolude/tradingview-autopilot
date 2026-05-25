/**
 * test_trade_wti.mjs — one-shot WTI test trade.
 * Places BUY 0.01 WTI with SL/TP, verifies the position has both attached.
 * Run on VM with: DISPLAY=:1 node scripts/trading/test_trade_wti.mjs
 */
import { placeOrder, getEquity } from './execute_trade.mjs';
import { evaluate } from '../../src/connection.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('=== WTI TEST TRADE ===');

  const eq = await getEquity();
  console.log('Account:', JSON.stringify(eq));

  console.log('Setting chart to BLACKBULL:WTI 5M...');
  await evaluate(`(function(){
    var a = window.TradingViewApi._activeChartWidgetWV.value();
    a.setSymbol('BLACKBULL:WTI', null, true);
    a.setResolution('5');
  })()`);
  await sleep(2500);

  const price = await evaluate(`(function() {
    var btn = document.querySelector('[data-name="buy-order-button"]');
    if (!btn) return null;
    var m = btn.textContent.match(/([\\d,\\.]+)/);
    return m ? parseFloat(m[1].replace(/,/g,'')) : null;
  })()`);
  console.log('Current ask:', price);

  if (!price) {
    console.error('✗ Could not read price. WTI panel may not be rendering.');
    process.exit(1);
  }

  // Tight bracket — WTI moves ~1-2% intraday; use 0.5% SL, 1.0% TP (2:1 R:R)
  const slPrice = Math.round((price * 0.995) * 100) / 100;
  const tpPrice = Math.round((price * 1.010) * 100) / 100;
  console.log(`Entry ~${price} | SL ${slPrice} (-0.5%) | TP ${tpPrice} (+1.0%) | R:R 2:1`);

  const lots = parseFloat(process.argv[2]) || 0.1;
  console.log(`Placing BUY ${lots} WTI...`);
  const result = await placeOrder({
    symbol:    'WTI',
    direction: 'buy',
    units:     lots,
    tpPrice,
    slPrice,
    minRR:     1.5,
    screenshot: true,
  });
  console.log('Result:', JSON.stringify(result));

  await sleep(4000);

  // Open Positions and read SL/TP for any WTI row
  await evaluate(`(function() {
    var btns = document.querySelectorAll('button');
    for (var i=0; i<btns.length; i++) if ((btns[i].textContent||'').trim()==='Positions') { btns[i].click(); return; }
  })()`);
  await sleep(1000);

  const wtiRow = await evaluate(`(function() {
    var rows = Array.from(document.querySelectorAll('tr'));
    for (var i=0;i<rows.length;i++) {
      var text = (rows[i].innerText||'').replace(/\\s+/g,' ').trim();
      if (!text.toUpperCase().startsWith('WTI')) continue;
      var cells = Array.from(rows[i].querySelectorAll('td'));
      return JSON.stringify({
        text: text.substring(0, 200),
        tp: (cells[3] && cells[3].textContent || '').trim(),
        sl: (cells[4] && cells[4].textContent || '').trim(),
        qty: (cells[2] && cells[2].textContent || '').trim(),
      });
    }
    return null;
  })()`);
  console.log('WTI position row:', wtiRow);

  if (wtiRow) {
    const parsed = JSON.parse(wtiRow);
    if (!parsed.sl || parsed.sl === '-' || !parsed.tp || parsed.tp === '-') {
      console.log('⚠ NAKED — naked_position_guard should repair within 2 min.');
    } else {
      console.log(`✓ Position has SL=${parsed.sl} TP=${parsed.tp}`);
    }
  } else {
    console.log('⚠ No WTI position visible — submit may have failed silently.');
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
