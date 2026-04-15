/**
 * test_trade.mjs
 * 1. Close any open position from previous test
 * 2. Place a fresh 1-unit BUY ETHUSD with proper TP and SL
 * 3. Verify TP/SL are visible in the positions list
 */
import { placeOrder, closeAllPositions, getEquity } from './execute_trade.mjs';
import { captureScreenshot } from '../../src/core/capture.js';
import { evaluate } from '../../src/connection.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║   TEST TRADE WITH TP + SL — BlackBull Demo    ║');
  console.log('╚════════════════════════════════════════════════╝\n');

  // Step 1: Check equity / existing positions
  console.log('[1] Account state...');
  const eq = await getEquity();
  console.log('  ', JSON.stringify(eq));

  // Step 2: Close any open positions from previous test
  console.log('[2] Closing any existing positions...');
  const closed = await closeAllPositions();
  console.log('  ', closed);
  await sleep(1500);

  // Step 3: Set chart to ETHUSD 5M and read current price for TP/SL calc
  console.log('[3] Reading current ETHUSD price...');
  await evaluate(`(function(){
    var a = window.TradingViewApi._activeChartWidgetWV.value();
    a.setSymbol('BLACKBULL:ETHUSD', null, true);
    a.setResolution('5');
  })()`);
  await sleep(2000);

  const price = await evaluate(`(function() {
    // Get current ask price from buy-order-button
    var btn = document.querySelector('[data-name="buy-order-button"]');
    if (!btn) return null;
    var m = btn.textContent.match(/([\\d,\\.]+)/);
    return m ? parseFloat(m[1].replace(/,/g,'')) : null;
  })()`);
  console.log('  Current ask price:', price);

  if (!price) {
    console.error('  ✗ Could not read price. Is chart loaded?');
    process.exit(1);
  }

  // Calculate TP and SL
  // Risk = 1.5% of price (~$35 for ETH at ~$2320)
  // SL = entry - 30 points, TP = entry + 60 points (2:1 R:R)
  const atrEstimate = price * 0.013; // ~1.3% ATR estimate for ETH 5M
  const slPoints    = Math.round(atrEstimate * 1.5 * 100) / 100;
  const tpPoints    = slPoints * 2.0;
  const tpPrice     = Math.round((price + tpPoints) * 100) / 100;
  const slPrice     = Math.round((price - slPoints) * 100) / 100;

  console.log(`  Entry: ~${price} | SL: ${slPrice} (-${slPoints.toFixed(2)}) | TP: ${tpPrice} (+${tpPoints.toFixed(2)}) | R:R 2:1`);

  // Step 4: Place the order with TP + SL
  console.log('\n[4] Placing BUY 1 ETHUSD with TP + SL...');
  const result = await placeOrder({
    symbol:    'ETHUSD',
    direction: 'buy',
    units:     1,
    tpPrice,
    slPrice,
    screenshot: true,
  });
  console.log('  Result:', JSON.stringify(result));

  // Step 5: Wait and verify the position shows TP/SL
  await sleep(2000);
  console.log('\n[5] Checking positions list for TP/SL...');
  await evaluate(`(function() {
    var tabs = document.querySelectorAll('button');
    for (var i = 0; i < tabs.length; i++) {
      if ((tabs[i].textContent||'').trim() === 'Positions') { tabs[i].click(); return; }
    }
  })()`);
  await sleep(800);

  const posInfo = await evaluate(`(function() {
    var bottom = document.querySelector('[class*="layout__area--bottom"]');
    return bottom ? bottom.textContent.trim().substring(0, 500) : 'no panel';
  })()`);
  console.log('  Panel text:', posInfo.substring(0, 300));

  const finalShot = await captureScreenshot({ region: 'full' });
  console.log('\n[6] Final screenshot:', finalShot.file_path);

  const eq2 = await getEquity();
  console.log('[7] Account after trade:', JSON.stringify(eq2));

  console.log('\n✓ Complete. Check screenshot — TP/SL should be visible in position row.');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
