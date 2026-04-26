/**
 * execute_trade.mjs
 * Place, manage, and close trades on the BlackBull demo account via TradingView broker panel.
 * ALWAYS sets TP and SL on every order.
 */
import { evaluate } from '../../src/connection.js';
import { captureScreenshot } from '../../src/core/capture.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Open the order ticket — opens in BUY or SELL mode based on direction ──
export async function openTicket(symbol, direction = 'buy') {
  if (symbol) {
    await evaluate(`(function(){
      var a = window.TradingViewApi._activeChartWidgetWV.value();
      a.setSymbol('BLACKBULL:${symbol}', null, true);
    })()`);
    await sleep(1800);
  }

  const isBuy = direction === 'buy' || direction === 'long';
  // Open ticket in the correct direction — buy-order-button for longs, sell-order-button for shorts
  const r = await evaluate(`(function() {
    var isBuy = ${isBuy};
    var primary   = document.querySelector(isBuy ? '[data-name="buy-order-button"]'  : '[data-name="sell-order-button"]');
    var secondary = document.querySelector(isBuy ? '[data-name="sell-order-button"]' : '[data-name="buy-order-button"]');
    if (primary)   { primary.click();   return 'opened via ' + (isBuy ? 'buy' : 'sell') + '-order-button'; }
    if (secondary) { secondary.click(); return 'opened via fallback ' + (isBuy ? 'sell' : 'buy') + '-order-button'; }
    return 'price buttons not found';
  })()`);
  await sleep(1200);
  return r;
}

// ── Wait for order ticket DOM element ──
export async function waitForTicket(maxSec = 8) {
  for (let i = 0; i < maxSec; i++) {
    const t = await evaluate(`(function() {
      var el = document.querySelector('[class*="orderTicket"]');
      if (!el) return null;
      var qty = document.getElementById('quantity-field');
      var text = el.textContent || '';
      var buy  = text.match(/Buy[\\s\\n]*([\\d,\\.]+)/);
      var sell = text.match(/Sell[\\s\\n]*([\\d,\\.]+)/);
      return {
        found: true,
        qty:   qty  ? qty.value : null,
        buy:   buy  ? parseFloat(buy[1].replace(/,/g,''))  : null,
        sell:  sell ? parseFloat(sell[1].replace(/,/g,'')) : null,
        text:  text.substring(0, 200),
      };
    })()`);
    if (t && t.found) return t;
    await sleep(1000);
  }
  return null;
}

// ── Set quantity ──
export async function setQty(units) {
  await evaluate(`(function() {
    var inp = document.getElementById('quantity-field');
    if (!inp) return;
    var s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    s.call(inp, '${units}');
    inp.dispatchEvent(new Event('input',  { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(300);
}

// ── Set TP and SL prices in the order ticket ──
// tpPrice and slPrice are absolute price levels
export async function setTPSL(tpPrice, slPrice) {
  const result = await evaluate(`(function() {
    var ticket = document.querySelector('[class*="orderTicket"]');
    if (!ticket) return { error: 'no ticket' };

    var checkboxes = ticket.querySelectorAll('input[type="checkbox"]');
    var textInputs  = ticket.querySelectorAll('input[type="text"]');

    // Structure: textInputs[0]=qty, textInputs[1]=TP price, textInputs[2]=SL price
    // checkboxes[0]=TP toggle, checkboxes[1]=SL toggle

    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    var results = {};

    // Enable & set TP
    if (checkboxes[0] && !checkboxes[0].checked) {
      checkboxes[0].click();
      results.tpChecked = true;
    }
    // Find TP input (first text input after qty)
    var tpInput = null, slInput = null;
    for (var i = 1; i < textInputs.length; i++) {
      var parent = textInputs[i].closest('[class*="exit"], [class*="Exit"], [class*="tp"], [class*="sl"], [class*="profit"], [class*="loss"]');
      if (!tpInput) { tpInput = textInputs[i]; }
      else if (!slInput) { slInput = textInputs[i]; break; }
    }

    if (tpInput && ${tpPrice} > 0) {
      setter.call(tpInput, '${tpPrice}');
      tpInput.dispatchEvent(new Event('input',  { bubbles: true }));
      tpInput.dispatchEvent(new Event('change', { bubbles: true }));
      tpInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      results.tpSet = tpInput.value;
    }

    // Enable & set SL
    if (checkboxes[1] && !checkboxes[1].checked) {
      checkboxes[1].click();
      results.slChecked = true;
    }
    if (slInput && ${slPrice} > 0) {
      setter.call(slInput, '${slPrice}');
      slInput.dispatchEvent(new Event('input',  { bubbles: true }));
      slInput.dispatchEvent(new Event('change', { bubbles: true }));
      slInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      results.slSet = slInput.value;
    }

    return results;
  })()`);
  await sleep(400);
  return result;
}

// ── Submit the BUY order ──
export async function submitBuy() {
  const r = await evaluate(`(function() {
    var ticket = document.querySelector('[class*="orderTicket"]');
    if (!ticket) return 'no ticket';
    var btns = ticket.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var cls = btns[i].className || '';
      var txt = btns[i].textContent.trim();
      if (/blue/i.test(cls)) { btns[i].click(); return 'clicked blue: ' + txt.substring(0,50); }
    }
    for (var i = 0; i < btns.length; i++) {
      if (/^buy/i.test(btns[i].textContent.trim())) {
        btns[i].click();
        return 'clicked: ' + btns[i].textContent.trim().substring(0,50);
      }
    }
    return 'buy btn not found';
  })()`);
  await sleep(600);
  return r;
}

// ── Submit the SELL order ──
export async function submitSell() {
  const r = await evaluate(`(function() {
    var ticket = document.querySelector('[class*="orderTicket"]');
    if (!ticket) return 'no ticket';
    var btns = ticket.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var cls = btns[i].className || '';
      var txt = btns[i].textContent.trim();
      if (/red/i.test(cls)) { btns[i].click(); return 'clicked red: ' + txt.substring(0,50); }
    }
    for (var i = 0; i < btns.length; i++) {
      if (/^sell/i.test(btns[i].textContent.trim())) {
        btns[i].click();
        return 'clicked: ' + btns[i].textContent.trim().substring(0,50);
      }
    }
    return 'sell btn not found';
  })()`);
  await sleep(600);
  return r;
}

// ── Confirm dialog if one appears ──
export async function confirmIfNeeded() {
  await sleep(400);
  return evaluate(`(function() {
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if (!btns[i].offsetParent) continue;
      var t = btns[i].textContent.trim().toLowerCase();
      if (t === 'confirm' || t === 'ok' || t === 'yes' || t === 'place order') {
        btns[i].click();
        return 'confirmed: ' + btns[i].textContent.trim();
      }
    }
    return 'none';
  })()`);
}

// ── Close all open positions ──
export async function closeAllPositions() {
  // Click Positions tab first
  await evaluate(`(function() {
    var tabs = document.querySelectorAll('button');
    for (var i = 0; i < tabs.length; i++) {
      if ((tabs[i].textContent||'').trim() === 'Positions') { tabs[i].click(); return; }
    }
  })()`);
  await sleep(600);

  // Look for close buttons on each position row
  const result = await evaluate(`(function() {
    var closed = 0;
    // Close buttons in position rows
    var closeBtns = document.querySelectorAll('[class*="closeButton"], [aria-label*="Close"], [title*="Close position"]');
    for (var i = 0; i < closeBtns.length; i++) {
      if (closeBtns[i].offsetParent) { closeBtns[i].click(); closed++; }
    }
    if (closed > 0) return 'closed ' + closed + ' position(s)';

    // Fallback: right-click row or find "Close" button text
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if (!btns[i].offsetParent) continue;
      var t = (btns[i].textContent || '').trim().toLowerCase();
      if (t === 'close' || t === 'close all') { btns[i].click(); closed++; }
    }
    return closed > 0 ? 'closed ' + closed : 'no close buttons found';
  })()`);
  await sleep(800);
  return result;
}

// ── Get account equity ──
export async function getEquity() {
  return evaluate(`(function() {
    var balance = null, equity = null;

    // Primary: title-* label + value-* sibling in same parent row
    var titles = document.querySelectorAll('[class*="title-"]');
    for (var i = 0; i < titles.length; i++) {
      var label = (titles[i].textContent || '').trim();
      var row   = titles[i].parentElement;
      if (!row) continue;
      var valEl = row.querySelector('[class*="value-"]');
      if (!valEl) continue;
      var v = parseFloat((valEl.textContent || '').replace(/,/g, ''));
      if (isNaN(v)) continue;
      if (label === 'Account Balance') balance = v;
      else if (label === 'Equity')     equity  = v;
    }

    // Fallback: value-* elements whose parent text starts with known labels
    if (balance === null || equity === null) {
      var valEls = document.querySelectorAll('[class*="value-"]');
      for (var i = 0; i < valEls.length; i++) {
        var p = valEls[i].parentElement;
        if (!p) continue;
        var pt = (p.textContent || '').trim();
        var v  = parseFloat((valEls[i].textContent || '').replace(/,/g, ''));
        if (isNaN(v)) continue;
        if (balance === null && /^Account Balance/.test(pt)) balance = v;
        if (equity  === null && /^Equity/.test(pt))          equity  = v;
      }
    }

    var unrealisedPnl = (equity !== null && balance !== null)
      ? Math.round((equity - balance) * 100) / 100
      : null;

    return { equity, balance, unrealisedPnl };
  })()`);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ORDER FUNCTION — always sets TP + SL
// tpPrice and slPrice: absolute price levels (calculate before calling)
// ─────────────────────────────────────────────────────────────────────────────
export async function placeOrder({
  symbol,
  direction,   // 'buy' | 'sell'
  units,
  tpPrice,     // REQUIRED — take profit price level
  slPrice,     // REQUIRED — stop loss price level
  screenshot = false,
}) {
  if (!tpPrice || !slPrice) throw new Error('tpPrice and slPrice are required for every trade.');

  const side = (direction === 'buy' || direction === 'long') ? 'LONG' : 'SHORT';
  console.log(`  → ${side} ${units} ${symbol} | TP:${tpPrice} SL:${slPrice}`);

  // Open order ticket in correct direction (buy/sell mode)
  await openTicket(symbol, direction);
  const ticket = await waitForTicket(10);
  if (!ticket) throw new Error('Order ticket not found after 10s. Is TradingView connected?');

  console.log(`  Ticket: bid=${ticket.sell} ask=${ticket.buy}`);

  // Set quantity
  await setQty(units);

  // Set TP + SL (always)
  const tpslResult = await setTPSL(tpPrice, slPrice);
  console.log(`  TP/SL set: ${JSON.stringify(tpslResult)}`);

  // Submit
  const isBuy = direction === 'buy' || direction === 'long';
  const clickResult = isBuy ? await submitBuy() : await submitSell();
  console.log(`  Submit: ${clickResult}`);

  const conf = await confirmIfNeeded();
  if (conf !== 'none') console.log(`  Confirm: ${conf}`);

  await sleep(1000);

  if (screenshot) {
    const s = await captureScreenshot({ region: 'full' });
    console.log(`  Screenshot: ${s.file_path}`);
  }

  return { symbol, direction, units, tpPrice, slPrice, submit: clickResult };
}
