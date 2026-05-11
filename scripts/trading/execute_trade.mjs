/**
 * execute_trade.mjs
 * Place, manage, and close trades on the BlackBull demo account via TradingView broker panel.
 * ALWAYS sets TP and SL on every order.
 */
import { evaluate, getClient, getTargetInfo } from '../../src/connection.js';
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

    // Verify the chart actually finished loading the correct symbol before clicking anything.
    // Without this, a slow load leaves the previous symbol's ticket open and the trade fires
    // on the wrong instrument.
    const targetSym = symbol.toUpperCase();
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await evaluate(`(function(){
        try { return window.TradingViewApi._activeChartWidgetWV.value().symbol(); }
        catch(e) { return null; }
      })()`);
      if (current && current.toUpperCase().includes(targetSym)) break;
      if (attempt === 4) throw new Error(`Symbol switch failed: chart shows "${current}", expected "${symbol}"`);
      await sleep(800);
    }
  }

  // Bring Tab 1 (broker tab) to foreground so UI interactions land on the right target.
  try {
    const c = await getClient();
    const tgt = await getTargetInfo();
    if (tgt) await c.Target.activateTarget({ targetId: tgt.id });
    await sleep(300);
  } catch(_) {}

  // Close any leftover order ticket from a prior placement before opening a fresh one.
  // Without this, clicking buy/sell a second time (e.g. O2 after O1) can interact with
  // the still-open O1 ticket instead of creating a new independent order.
  await evaluate(`(function(){
    var ticket = document.querySelector('[class*="orderTicket"]');
    if (!ticket) return;
    var selectors = ['[class*="close-"]', '[aria-label*="Close"]', '[aria-label*="close"]', '[class*="closeButton"]'];
    for (var i = 0; i < selectors.length; i++) {
      var btn = ticket.querySelector(selectors[i]);
      if (btn && btn.offsetParent) { btn.click(); return; }
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, keyCode: 27 }));
  })()`);
  await sleep(500);

  // Ensure the trading panel (buy/sell buttons) is visible before clicking.
  // If buttons are missing, try clicking the Trading panel tab to open it.
  const panelState = await evaluate(`(function(){
    if (document.querySelector('[data-name="buy-order-button"]') ||
        document.querySelector('[data-name="sell-order-button"]')) return 'visible';
    var btns = Array.from(document.querySelectorAll('button'));
    var panel = btns.find(function(b){
      var n = (b.getAttribute('data-name')||'').toLowerCase();
      var a = (b.getAttribute('aria-label')||'').toLowerCase();
      return n === 'trading' || a.includes('trading panel');
    });
    if (panel) { panel.click(); return 'opened'; }
    return 'not_found';
  })()`);
  if (panelState !== 'visible') await sleep(1000);

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
// Split into two evaluate() calls: first enable checkboxes, then (after React re-renders)
// re-query inputs and set values. Querying inputs before clicking checkboxes returns a
// stale NodeList that misses fields TradingView conditionally renders on checkbox enable.
export async function setTPSL(tpPrice, slPrice) {
  // Pass 1 — enable TP and SL checkboxes if not already checked
  await evaluate(`(function() {
    var ticket = document.querySelector('[class*="orderTicket"]');
    if (!ticket) return;
    var checkboxes = ticket.querySelectorAll('input[type="checkbox"]');
    if (checkboxes[0] && !checkboxes[0].checked) checkboxes[0].click();
    if (checkboxes[1] && !checkboxes[1].checked) checkboxes[1].click();
  })()`);

  // Wait for React to re-render the TP/SL input fields
  await sleep(600);

  // Pass 2 — re-query inputs now that TP/SL fields exist in the DOM, then set values
  const result = await evaluate(`(function() {
    var ticket = document.querySelector('[class*="orderTicket"]');
    if (!ticket) return { error: 'no ticket' };

    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    var textInputs = ticket.querySelectorAll('input[type="text"]');
    // textInputs[0]=qty, textInputs[1]=TP price, textInputs[2]=SL price
    var tpInput = textInputs[1] || null;
    var slInput = textInputs[2] || null;
    var results = {};

    if (tpInput && ${tpPrice} > 0) {
      setter.call(tpInput, '${tpPrice}');
      tpInput.dispatchEvent(new Event('input',  { bubbles: true }));
      tpInput.dispatchEvent(new Event('change', { bubbles: true }));
      tpInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      results.tpSet = tpInput.value;
    } else {
      results.tpError = 'input not found (index 1 of ' + textInputs.length + ')';
    }

    if (slInput && ${slPrice} > 0) {
      setter.call(slInput, '${slPrice}');
      slInput.dispatchEvent(new Event('input',  { bubbles: true }));
      slInput.dispatchEvent(new Event('change', { bubbles: true }));
      slInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      results.slSet = slInput.value;
    } else {
      results.slError = 'input not found (index 2 of ' + textInputs.length + ')';
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

// ── Confirm the "Close position" dialog if it appears ──
async function confirmCloseDialog() {
  await sleep(600);
  return evaluate(`(function() {
    var btns = Array.from(document.querySelectorAll('button'));
    // Find the confirmation button inside the modal — matches "Close position" exactly
    var confirm = btns.find(function(b) {
      return b.offsetParent !== null && (b.textContent || '').trim() === 'Close position';
    });
    if (confirm) { confirm.click(); return 'dialog confirmed'; }
    return 'no dialog';
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
    var closeBtns = document.querySelectorAll('[class*="closeButton"], [aria-label*="Close"], [title*="Close position"]');
    for (var i = 0; i < closeBtns.length; i++) {
      if (closeBtns[i].offsetParent) { closeBtns[i].click(); closed++; }
    }
    if (closed > 0) return 'clicked ' + closed + ' close button(s)';

    // Fallback: find "Close" button text
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if (!btns[i].offsetParent) continue;
      var t = (btns[i].textContent || '').trim().toLowerCase();
      if (t === 'close' || t === 'close all') { btns[i].click(); closed++; }
    }
    return closed > 0 ? 'clicked ' + closed : 'no close buttons found';
  })()`);

  // Confirm the modal dialog that TradingView shows after clicking close
  const confirmed = await confirmCloseDialog();
  await sleep(500);
  return `${result} → ${confirmed}`;
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
  let ticket = await waitForTicket(10);
  if (!ticket) {
    // One retry — re-click the buy/sell button in case the first click missed
    const retryBtn = (direction === 'buy' || direction === 'long')
      ? '[data-name="buy-order-button"]' : '[data-name="sell-order-button"]';
    console.log(`  Ticket not found — retrying button click...`);
    await evaluate(`(function(){
      var btn = document.querySelector('${retryBtn}');
      if (btn && btn.offsetParent) btn.click();
    })()`);
    await sleep(800);
    ticket = await waitForTicket(8);
  }
  if (!ticket) throw new Error('Order ticket not found after retry. Is TradingView connected?');

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
