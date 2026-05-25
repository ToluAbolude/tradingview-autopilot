/**
 * probe_wti_minlot.mjs — Open WTI order ticket, read qty input's min/step,
 * then close ticket. Read-only; no order submitted.
 */
import { evaluate } from '../../src/connection.js';
import { openTicket, waitForTicket } from './execute_trade.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('Setting chart to BLACKBULL:WTI...');
  await evaluate(`(function(){
    var a = window.TradingViewApi._activeChartWidgetWV.value();
    a.setSymbol('BLACKBULL:WTI', null, true);
    a.setResolution('5');
  })()`);
  await sleep(2500);

  console.log('Opening BUY ticket...');
  await openTicket('WTI', 'buy');
  await waitForTicket(10);
  await sleep(1000);

  const info = await evaluate(`(function() {
    var ticket = document.querySelector('[class*="orderTicket"]');
    if (!ticket) return { error: 'no ticket' };
    var qty = ticket.querySelector('[data-qa-id~="order-ticket-quantity-input"]')
           || ticket.querySelector('input[type="number"]');
    if (!qty) return { error: 'no qty input' };
    return {
      currentValue: qty.value,
      min: qty.min || qty.getAttribute('min'),
      max: qty.max || qty.getAttribute('max'),
      step: qty.step || qty.getAttribute('step'),
      placeholder: qty.placeholder,
      ariaLabel: qty.getAttribute('aria-label'),
    };
  })()`);
  console.log('WTI qty input:', JSON.stringify(info, null, 2));

  // Also try reading any visible "min" / "step" text near the input
  const nearbyText = await evaluate(`(function() {
    var ticket = document.querySelector('[class*="orderTicket"]');
    if (!ticket) return null;
    var qty = ticket.querySelector('[data-qa-id~="order-ticket-quantity-input"]') || ticket.querySelector('input[type="number"]');
    if (!qty) return null;
    var section = qty.closest('[class*="section"], [class*="quantity"], [class*="row"]') || qty.parentElement.parentElement;
    return section ? section.textContent.replace(/\\s+/g,' ').trim().substring(0, 300) : null;
  })()`);
  console.log('Nearby text:', nearbyText);

  // Close ticket
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, keyCode: 27 }))`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
