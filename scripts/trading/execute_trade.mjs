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
// tpPrice and slPrice are absolute price levels.
// Uses data-qa-id selectors so it works regardless of order type (market vs limit).
// Checkbox activation uses the React-aware native property setter + change event —
// plain .click() updates the DOM but bypasses React's synthetic event system, so
// the conditional TP/SL input fields never render.
export async function setTPSL(tpPrice, slPrice) {
  // Pass 1 — always force-enable TP and SL toggles, regardless of current state.
  // Skipping when "already checked" is unreliable: the broker panel retains the toggle
  // state from the previous order, but React may not have rendered the input fields yet.
  // We always fire the full activation sequence: native setter + change + click.
  await evaluate(`(function() {
    var ticket = document.querySelector('[class*="orderTicket"]');
    if (!ticket) return;
    var checkedSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked').set;

    function enableToggle(cb) {
      if (!cb) return;
      // If already checked, uncheck first so the click below reliably re-enables it
      if (cb.checked) {
        checkedSetter.call(cb, false);
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        cb.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
      checkedSetter.call(cb, true);
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      cb.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }

    var tpCb = ticket.querySelector('[data-qa-id="order-ticket-take-profit-checkbox-bracket"]');
    var slCb = ticket.querySelector('[data-qa-id="order-ticket-stop-loss-checkbox-bracket"]');
    enableToggle(tpCb);
    enableToggle(slCb);
  })()`);

  // Wait for React to render both TP and SL price input fields
  await sleep(1200);

  // Pass 2 — find inputs by data-qa-id and set values; retry up to 4× if not yet rendered
  let result;
  for (let attempt = 0; attempt < 4; attempt++) {
    result = await evaluate(`(function() {
      var ticket = document.querySelector('[class*="orderTicket"]');
      if (!ticket) return { error: 'no ticket' };

      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      var tpInput = ticket.querySelector('[data-qa-id~="order-ticket-take-profit-input"]');
      var slInput = ticket.querySelector('[data-qa-id~="order-ticket-stop-loss-input"]');
      var results = {};

      function fillInput(el, val) {
        el.focus();
        el.select();
        // execCommand('insertText') is the only method that fully propagates
        // through React's synthetic event system in Chromium — native setter
        // + dispatchEvent sets the DOM value but leaves React's state empty,
        // so the field value is dropped when the order is submitted.
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, String(val));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        el.blur();
      }

      if (tpInput && ${tpPrice} > 0) {
        fillInput(tpInput, ${tpPrice});
        results.tpSet = tpInput.value;
      } else {
        results.tpError = tpInput ? 'no tp price' : 'tp input not found';
      }

      if (slInput && ${slPrice} > 0) {
        fillInput(slInput, ${slPrice});
        results.slSet = slInput.value;
      } else {
        results.slError = slInput ? 'no sl price' : 'sl input not found';
      }

      return results;
    })()`);

    if (!result?.tpError && !result?.slError) break;
    if (attempt < 3) await sleep(700);
  }
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
  // Provider dispatch: prefer cTrader Open API when BROKER_PROVIDER=ctrader.
  // Falls back to TV DOM path on any error (defensive — TV path is still here).
  if (process.env.BROKER_PROVIDER === 'ctrader') {
    try {
      const m = await import('./broker_ctrader.mjs');
      const r = await m.closeAllPositions();
      return `cTrader: closed=${r.closed} remaining=${r.remaining}`;
    } catch (e) {
      console.error(`[execute_trade] cTrader closeAll failed, falling back to TV: ${e.message}`);
      // intentional fallthrough to TV DOM path below
    }
  }

  // Click Positions tab first so the close icons are mounted
  await evaluate(`(function() {
    var tabs = document.querySelectorAll('button');
    for (var i = 0; i < tabs.length; i++) {
      if ((tabs[i].textContent||'').trim() === 'Positions') { tabs[i].click(); return; }
    }
  })()`);
  await sleep(800);

  // Verified 2026-05-26: BlackBull's position-row × button is data-name=
  // "close-settings-cell-button". Plain .click() doesn't trigger the popup
  // reliably — full mouse-event sequence is required. After the × opens the
  // popup, click "Close position" (also via full mouse events). Repeat per
  // remaining row — each pass closes exactly one position.
  const countOpen = async () => evaluate(
    `Array.from(document.querySelectorAll('tr')).filter(r => /(Long|Short)/i.test((r.innerText||''))).length`
  );

  const clickFully = (selectorScopeJs) => `(function(){
    var b = ${selectorScopeJs};
    if (!b || !b.offsetParent) return 'no_btn';
    var rect = b.getBoundingClientRect();
    var x = rect.left + rect.width/2, y = rect.top + rect.height/2;
    ['mouseover','mousedown','mouseup','click'].forEach(function(t){
      b.dispatchEvent(new MouseEvent(t, {bubbles:true, cancelable:true, clientX:x, clientY:y, button:0}));
    });
    return 'clicked';
  })()`;

  let totalClosed = 0;
  for (let pass = 1; pass <= 12; pass++) {
    const remaining = await countOpen();
    if (remaining === 0) break;

    const xResult = await evaluate(clickFully(`document.querySelector('[data-name="close-settings-cell-button"]')`));
    if (xResult === 'no_btn') break;
    await sleep(900);

    // Click "Close position" inside the popup (scoped to dialog/popup elements
    // so we don't accidentally click the unrelated "Close position" tab/header).
    await evaluate(`(function(){
      var dialogs = document.querySelectorAll('[role=dialog], [class*=dialog], [class*=Dialog], [class*=modal], [class*=Modal], [class*=popup], [class*=Popup]');
      for (var i=0; i<dialogs.length; i++) {
        if (!dialogs[i].offsetParent) continue;
        var btns = dialogs[i].querySelectorAll('button');
        for (var j=0; j<btns.length; j++) {
          if ((btns[j].textContent||'').trim() === 'Close position') {
            var rect = btns[j].getBoundingClientRect();
            var x = rect.left + rect.width/2, y = rect.top + rect.height/2;
            ['mouseover','mousedown','mouseup','click'].forEach(function(e){
              btns[j].dispatchEvent(new MouseEvent(e, {bubbles:true, cancelable:true, clientX:x, clientY:y, button:0}));
            });
            return;
          }
        }
      }
    })()`);
    await sleep(1500);

    const after = await countOpen();
    if (after < remaining) totalClosed += (remaining - after);
  }

  const finalOpen = await countOpen();
  return `closed=${totalClosed} remaining=${finalOpen}`;
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
  minRR = 2.0, // minimum R:R at actual fill price — rejects if market has moved adversely
  reanchorTpAtMinRR = false, // if true and R:R has degraded, recompute TP from current fill instead of rejecting
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

  // R:R pre-flight: verify actual fill price hasn't degraded R:R below minimum
  if (minRR > 0) {
    const isBuyDir = direction === 'buy' || direction === 'long';
    const fillPrice = isBuyDir ? ticket.buy : ticket.sell;
    if (fillPrice) {
      const actualRisk   = isBuyDir ? fillPrice - slPrice  : slPrice  - fillPrice;
      const actualReward = isBuyDir ? tpPrice  - fillPrice : fillPrice - tpPrice;
      const actualRR = actualReward / actualRisk;
      if (actualRR < minRR) {
        if (reanchorTpAtMinRR) {
          // Re-anchor TP to give exactly minRR from the current fill price, keeping SL fixed.
          // Used for later legs of a multi-leg ladder so the runner still places even after
          // price has moved against the original entry.
          const slDist = Math.abs(fillPrice - slPrice);
          tpPrice = isBuyDir ? fillPrice + slDist * minRR : fillPrice - slDist * minRR;
          console.log(`  R:R degraded (${actualRR.toFixed(2)}) → reanchored TP to ${tpPrice} (fill ${fillPrice}, slDist ${slDist.toFixed(4)})`);
        } else {
          await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, keyCode: 27 }))`);
          await sleep(300);
          throw new Error(`R:R degraded to ${actualRR.toFixed(2)} at current price ${fillPrice} (min ${minRR}) — skipping`);
        }
      }
      console.log(`  R:R check OK: ${actualRR.toFixed(2)} >= ${minRR} at fill ${fillPrice}`);
    }
  }

  // Set quantity
  await setQty(units);

  // Set TP + SL (always)
  const tpslResult = await setTPSL(tpPrice, slPrice);
  console.log(`  TP/SL set: ${JSON.stringify(tpslResult)}`);

  // Abort if TP/SL inputs were not found — means the ticket is on the wrong instrument
  // or the BlackBull panel hasn't finished loading. Submitting without TP/SL is never safe.
  if (tpslResult?.tpError || tpslResult?.slError) {
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, keyCode: 27 }))`);
    await sleep(300);
    throw new Error(`TP/SL inputs not found — wrong instrument or panel not loaded (${JSON.stringify(tpslResult)})`);
  }

  // Pre-submit verification — confirm both TP and SL are present in the ticket DOM
  // before clicking the button. If either is missing, abort rather than submit naked.
  const verify = await evaluate(`(function() {
    var ticket = document.querySelector('[class*="orderTicket"]');
    if (!ticket) return { ok: false, reason: 'no ticket' };
    var tpInput = ticket.querySelector('[data-qa-id~="order-ticket-take-profit-input"]');
    var slInput = ticket.querySelector('[data-qa-id~="order-ticket-stop-loss-input"]');
    return {
      ok:      !!tpInput && !!slInput && tpInput.value !== '' && slInput.value !== '',
      tpValue: tpInput  ? tpInput.value  : null,
      slValue: slInput  ? slInput.value  : null,
    };
  })()`);
  if (!verify?.ok) {
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, keyCode: 27 }))`);
    await sleep(300);
    throw new Error(`Pre-submit check failed — TP/SL not confirmed in ticket (tp=${verify?.tpValue} sl=${verify?.slValue}). Order aborted.`);
  }
  console.log(`  Pre-submit OK: TP=${verify.tpValue} SL=${verify.slValue}`);

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
