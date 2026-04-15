/**
 * place_demo_trade.mjs
 * Click the "Trade" tab in the bottom panel, probe the trading UI,
 * and place a minimal test order on the BlackBull demo account.
 */
import { evaluate, evaluateAsync, getClient } from '../src/connection.js';
import { captureScreenshot } from '../src/core/capture.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function screenshot(label) {
  try {
    const s = await captureScreenshot({ region: 'full' });
    console.log(`  [screenshot] ${label}: ${s.file_path}`);
    return s.file_path;
  } catch(e) {
    console.log(`  [screenshot] failed: ${e.message}`);
  }
}

async function clickByText(text) {
  return evaluate(`(function() {
    var btns = document.querySelectorAll('button, [role="tab"], a, [role="button"]');
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].textContent || '').trim();
      if (t.toLowerCase() === ${JSON.stringify(text.toLowerCase())}) {
        btns[i].click();
        return 'clicked: ' + t;
      }
    }
    return 'not found: ' + ${JSON.stringify(text)};
  })()`);
}

async function listAllButtons() {
  return evaluate(`(function() {
    var btns = document.querySelectorAll('button, [role="tab"]');
    var list = [];
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].textContent || '').trim();
      var visible = btns[i].offsetParent !== null;
      if (t && visible) list.push({ text: t.substring(0, 50), dataName: btns[i].getAttribute('data-name') || '', ariaLabel: btns[i].getAttribute('aria-label') || '' });
    }
    return list;
  })()`);
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║   Demo Trade — BlackBull Markets               ║');
  console.log('╚════════════════════════════════════════════════╝\n');

  // Step 1: Find and click the Trade tab
  console.log('[1] Looking for Trade tab...');
  const buttons = await listAllButtons();
  const tradeRelated = buttons.filter(b =>
    /trade|order|buy|sell|broker|position|blackbull/i.test(b.text + b.ariaLabel + b.dataName)
  );
  console.log('  Trade-related buttons found:');
  for (const b of tradeRelated) console.log(`    "${b.text}" data-name="${b.dataName}" aria-label="${b.ariaLabel}"`);

  // Try clicking "Trade" tab
  const tradeTab = await evaluate(`(function() {
    var all = document.querySelectorAll('[role="tab"], button, [class*="tab"]');
    for (var i = 0; i < all.length; i++) {
      var t = (all[i].textContent || '').trim();
      var dn = all[i].getAttribute('data-name') || '';
      if (t === 'Trade' || dn === 'trade' || dn === 'trading') {
        all[i].click();
        return 'clicked:' + t;
      }
    }
    // Also try data-name="trading"
    var trading = document.querySelector('[data-name="trading"], [data-name="trade"]');
    if (trading) { trading.click(); return 'clicked via data-name'; }
    return 'not found';
  })()`);
  console.log('  Trade tab click result:', tradeTab);
  await sleep(1500);

  await screenshot('after_trade_tab_click');

  // Step 2: Probe the trading panel that appeared
  console.log('\n[2] Probing trading panel content...');
  const tradingContent = await evaluate(`(function() {
    // Look for the trading panel / order ticket
    var containers = [
      document.querySelector('[data-name="trading-panel"]'),
      document.querySelector('[class*="tradingPanel"]'),
      document.querySelector('[class*="orderTicket"]'),
      document.querySelector('[class*="order-ticket"]'),
      document.querySelector('[class*="tradePanel"]'),
      document.querySelector('[class*="AccountPanel"]'),
    ];

    var found = null;
    for (var c of containers) {
      if (c) { found = c; break; }
    }

    if (!found) {
      // Scan bottom area for trading content
      var bottom = document.querySelector('[class*="layout__area--bottom"]');
      if (bottom) return { text: bottom.textContent.trim().substring(0, 800), source: 'bottom-area' };
      return { error: 'no trading panel found' };
    }

    return { text: found.textContent.trim().substring(0, 800), source: found.className.substring(0, 60) };
  })()`);
  console.log('  Panel content:', JSON.stringify(tradingContent, null, 2));

  // Step 3: Look for buy/sell inputs and buttons
  console.log('\n[3] Scanning for order form...');
  const orderForm = await evaluate(`(function() {
    var result = {
      inputs: [],
      buyBtns: [],
      sellBtns: [],
      allVisible: [],
    };

    // All visible inputs
    var inputs = document.querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) {
      if (inputs[i].offsetParent !== null) {
        result.inputs.push({
          type: inputs[i].type,
          placeholder: inputs[i].placeholder,
          value: inputs[i].value,
          name: inputs[i].name,
          id: inputs[i].id,
        });
      }
    }

    // All visible buttons
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if (!btns[i].offsetParent) continue;
      var text = (btns[i].textContent || '').trim().toLowerCase();
      var info = { text: btns[i].textContent.trim().substring(0, 50), class: btns[i].className.substring(0, 60) };
      if (/^buy/.test(text)) result.buyBtns.push(info);
      else if (/^sell/.test(text)) result.sellBtns.push(info);
      else result.allVisible.push(info);
    }

    return result;
  })()`);

  console.log('  Visible inputs:', JSON.stringify(orderForm.inputs.slice(0, 10), null, 2));
  console.log('  Buy buttons:', JSON.stringify(orderForm.buyBtns, null, 2));
  console.log('  Sell buttons:', JSON.stringify(orderForm.sellBtns, null, 2));
  console.log('  Other visible buttons:', orderForm.allVisible.slice(0, 20).map(b => `"${b.text}"`).join(', '));

  // Step 4: Try to connect broker if not connected
  console.log('\n[4] Checking broker connection status...');
  const brokerStatus = await evaluate(`(function() {
    // Look for "Connect broker" or "Login" type buttons
    var btns = document.querySelectorAll('button, a');
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].textContent || '').trim().toLowerCase();
      if (/connect|login|sign in|start trading|demo/i.test(t) && btns[i].offsetParent) {
        return { text: btns[i].textContent.trim(), found: true };
      }
    }
    // Check for account info
    var equity = document.querySelector('[class*="equity"], [class*="balance"], [class*="Balance"]');
    if (equity) return { accountInfo: equity.textContent.trim().substring(0, 100), found: false };
    return { found: false };
  })()`);
  console.log('  Broker status:', JSON.stringify(brokerStatus));

  await screenshot('final_state');

  // Step 5: Attempt trade if panel is ready
  if (orderForm.buyBtns.length > 0 || orderForm.sellBtns.length > 0) {
    console.log('\n[5] Order form is ready — attempting minimal buy order...');

    // Find quantity input and set to minimum (0.01 lots)
    const qtySet = await evaluate(`(function() {
      var inputs = document.querySelectorAll('input');
      for (var i = 0; i < inputs.length; i++) {
        if (!inputs[i].offsetParent) continue;
        var p = (inputs[i].placeholder || '').toLowerCase();
        var n = (inputs[i].name || '').toLowerCase();
        if (/qty|quantity|lot|size|amount/i.test(p + n)) {
          // Set to minimum value
          var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeInputValueSetter.call(inputs[i], '0.01');
          inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
          inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
          return 'set qty input to 0.01';
        }
      }
      return 'qty input not found';
    })()`);
    console.log('  Set qty:', qtySet);
    await sleep(500);

    // Click Buy
    const buyResult = await evaluate(`(function() {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        if (!btns[i].offsetParent) continue;
        var text = (btns[i].textContent || '').trim().toLowerCase();
        if (/^buy/.test(text)) {
          btns[i].click();
          return 'clicked: ' + btns[i].textContent.trim();
        }
      }
      return 'buy button not found';
    })()`);
    console.log('  Buy click result:', buyResult);
    await sleep(2000);

    await screenshot('after_buy');

    // Check for confirmation dialog
    const confirm = await evaluate(`(function() {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        if (!btns[i].offsetParent) continue;
        var text = (btns[i].textContent || '').trim().toLowerCase();
        if (text === 'confirm' || text === 'ok' || text === 'place order' || text === 'submit') {
          return { text: btns[i].textContent.trim(), found: true };
        }
      }
      return { found: false };
    })()`);
    console.log('  Confirm dialog:', JSON.stringify(confirm));

    if (confirm.found) {
      console.log('  Confirmation dialog found — NOT auto-confirming. User must confirm manually.');
    }
  } else {
    console.log('\n[5] Order form not ready yet. Trading panel may need broker login.');
    console.log('  Review screenshots to see current state.');
  }

  console.log('\n─────────────────────────────────────────────');
  console.log('Done. Check screenshots folder for visual state.');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
