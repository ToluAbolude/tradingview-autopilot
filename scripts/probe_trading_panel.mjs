/**
 * probe_trading_panel.mjs
 * Probe the TradingView broker trading panel for BlackBull demo account.
 * Reports account info, order form elements, and attempts a minimal test order.
 */
import { evaluate, evaluateAsync } from '../src/connection.js';
import { openPanel } from '../src/core/ui.js';
import { captureScreenshot } from '../src/core/capture.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║   Trading Panel Probe — BlackBull Demo         ║');
  console.log('╚════════════════════════════════════════════════╝\n');

  // 1. Open trading panel
  console.log('[1] Opening Trading Panel...');
  try {
    const r = await openPanel({ panel: 'trading', action: 'open' });
    console.log('  Result:', JSON.stringify(r));
  } catch (e) {
    console.log('  openPanel error:', e.message);
  }
  await sleep(2000);

  // 2. Check TradingView broker API
  console.log('\n[2] Checking broker API...');
  const brokerInfo = await evaluate(`(function() {
    try {
      var api = window.TradingViewApi;
      var keys = [];
      for (var k in api) {
        if (/broker|trade|order|account|position/i.test(k)) keys.push(k);
      }
      return {
        apiKeys: keys,
        hasBrokerApi: !!(api._brokerApi || api.brokerApi || api._tradingPanelApi),
        hasHostApi: !!api._chartWidgetCollection,
      };
    } catch(e) { return { error: e.message }; }
  })()`);
  console.log('  Broker API:', JSON.stringify(brokerInfo, null, 2));

  // 3. Probe trading panel DOM
  console.log('\n[3] Probing trading panel DOM...');
  const panelInfo = await evaluate(`(function() {
    // Look for trading panel containers
    var selectors = [
      '[data-name="trading-button"]',
      '[class*="trading-panel"]',
      '[class*="broker"]',
      '[class*="order-panel"]',
      '[class*="trade-panel"]',
      '[data-dialog-name="trading"]',
      '[class*="accountPanel"]',
      '[class*="TradingPanel"]',
    ];
    var found = {};
    for (var s of selectors) {
      var el = document.querySelector(s);
      if (el) found[s] = { tag: el.tagName, text: el.textContent.trim().substring(0, 100), visible: el.offsetParent !== null };
    }

    // Look for account balance info
    var balanceEls = [];
    var all = document.querySelectorAll('[class*="balance"], [class*="equity"], [class*="margin"]');
    for (var i = 0; i < Math.min(all.length, 10); i++) {
      var t = all[i].textContent.trim();
      if (t) balanceEls.push(t.substring(0, 80));
    }

    // Look for order entry form
    var orderForms = [];
    var inputs = document.querySelectorAll('input[type="text"], input[type="number"], input[placeholder]');
    for (var i = 0; i < Math.min(inputs.length, 20); i++) {
      var inp = inputs[i];
      orderForms.push({
        placeholder: inp.getAttribute('placeholder') || '',
        value: inp.value || '',
        name: inp.name || '',
        class: inp.className.substring(0, 60),
      });
    }

    // Look for Buy/Sell buttons
    var tradeBtns = [];
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var text = btns[i].textContent.trim().toLowerCase();
      if (text === 'buy' || text === 'sell' || text === 'place order' || text === 'submit' ||
          /^(buy|sell)\s*(market|limit)?$/i.test(text)) {
        tradeBtns.push({
          text: btns[i].textContent.trim(),
          class: btns[i].className.substring(0, 60),
          visible: btns[i].offsetParent !== null,
        });
      }
    }

    return { found, balanceEls, orderForms: orderForms.slice(0, 10), tradeBtns };
  })()`);

  console.log('  DOM elements found:', JSON.stringify(panelInfo.found, null, 2));
  console.log('  Balance elements:', panelInfo.balanceEls);
  console.log('  Order inputs:', JSON.stringify(panelInfo.orderForms, null, 2));
  console.log('  Trade buttons:', JSON.stringify(panelInfo.tradeBtns, null, 2));

  // 4. Check internal broker state
  console.log('\n[4] Checking internal broker state...');
  const brokerState = await evaluateAsync(`(function() {
    try {
      // Try TradingView internal trading host
      var host = window.TradingViewApi._tradingHost ||
                 window.TradingViewApi._brokerHost ||
                 window._tradingViewBrokerHost;
      if (!host) return { error: 'no trading host found' };
      return { hasHost: true, hostType: typeof host };
    } catch(e) { return { error: e.message }; }
  })()`);
  console.log('  Broker state:', JSON.stringify(brokerState));

  // 5. Screenshot
  console.log('\n[5] Taking screenshot...');
  try {
    const shot = await captureScreenshot({ region: 'full' });
    console.log('  Screenshot:', shot.file || shot.path || JSON.stringify(shot));
  } catch(e) {
    console.log('  Screenshot failed:', e.message);
  }

  // 6. List all right-panel content
  console.log('\n[6] Right panel content...');
  const rightPanel = await evaluate(`(function() {
    var panel = document.querySelector('[class*="layout__area--right"]');
    if (!panel) return 'no right panel found';
    return panel.textContent.trim().substring(0, 500);
  })()`);
  console.log('  Right panel text:', rightPanel);

  console.log('\n─────────────────────────────────────────────');
  console.log('Probe complete. Review output above for trade panel details.');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
