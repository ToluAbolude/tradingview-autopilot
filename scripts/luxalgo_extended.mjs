/**
 * Submit extended backtest queries to LuxAlgo AI Backtesting Assistant.
 * Tests BTC 1H, ETH 5M, XAU 30M — the top 3 combos from our TradingView sweep.
 */
import CDP from 'chrome-remote-interface';

const CHAT_TAB = '6D2EB603F5BAF17F7C2CFA8BB8BBD80D';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const QUERIES = [
  {
    label: 'BTC 1H',
    msg: `Using the Smart Trail HA Scalper strategy (Chandelier Exit smart trail + HyperWave MFI filter + Heikin Ashi doji pullback entries), please backtest BTCUSDT on the 1H timeframe. Show me: total trades, net P&L, win rate, profit factor, max drawdown, and the long vs short breakdown. Use at least 6 months of history if available.`
  },
  {
    label: 'ETH 5M',
    msg: `Using the Smart Trail HA Scalper strategy (Chandelier Exit smart trail + HyperWave MFI filter + Heikin Ashi doji pullback entries), please backtest ETHUSDT on the 5M timeframe. Show me: total trades, net P&L, win rate, profit factor, max drawdown, and the long vs short breakdown. Use at least 3 months of history.`
  },
  {
    label: 'XAU 30M',
    msg: `Using the Smart Trail HA Scalper strategy (Chandelier Exit smart trail + HyperWave MFI filter + Heikin Ashi doji pullback entries), please backtest XAUUSD on the 30M timeframe. Show me: total trades, net P&L, win rate, profit factor, max drawdown, and the long vs short breakdown. Use at least 3 months of history.`
  }
];

async function sendMessage(client, message) {
  // Set textarea value
  const setResult = await client.Runtime.evaluate({
    expression: `(function() {
      var ta = document.querySelector('textarea[name="message"]');
      if (!ta) return 'no textarea';
      var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(message)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return 'set:' + ta.value.length;
    })()`,
    returnByValue: true
  });
  console.log('  Set:', setResult.result.value);

  await sleep(500);

  // Submit
  const submitResult = await client.Runtime.evaluate({
    expression: `(function() {
      // Try submit button first
      var btn = document.querySelector('button[type="submit"]') ||
                Array.from(document.querySelectorAll('button')).find(b => {
                  var t = (b.innerText || '').toLowerCase();
                  var al = (b.getAttribute('aria-label') || '').toLowerCase();
                  return t.includes('send') || al.includes('send') || b.type === 'submit';
                });
      if (btn && !btn.disabled) { btn.click(); return 'btn:' + btn.innerText.trim(); }
      // Fallback: Enter key on textarea
      var ta = document.querySelector('textarea[name="message"]');
      if (ta) {
        ta.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', code:'Enter', bubbles:true, shiftKey:false}));
        return 'enter-key';
      }
      return 'no-submit';
    })()`,
    returnByValue: true
  });
  console.log('  Submit:', submitResult.result.value);
}

async function waitForResponse(client, waitSecs = 45) {
  // Snapshot current page length
  const snap = await client.Runtime.evaluate({
    expression: `document.body.innerText.length`,
    returnByValue: true
  });
  const startLen = snap.result.value;
  let stable = 0;
  let lastLen = startLen;

  for (let i = 0; i < waitSecs; i++) {
    await sleep(1000);
    const cur = await client.Runtime.evaluate({
      expression: `document.body.innerText.length`,
      returnByValue: true
    });
    const curLen = cur.result.value;
    if (curLen > lastLen + 50) {
      process.stdout.write('.');
      stable = 0;
    } else {
      stable++;
    }
    lastLen = curLen;
    if (stable >= 5 && curLen > startLen + 200) break;
  }

  const content = await client.Runtime.evaluate({
    expression: `document.body.innerText.slice(-3000)`,
    returnByValue: true
  });
  return content.result.value;
}

async function main() {
  const client = await CDP({ host: 'localhost', port: 9222, target: CHAT_TAB });
  await client.Runtime.enable();
  console.log('Connected to LuxAlgo AI Backtesting\n');

  const results = {};

  for (const q of QUERIES) {
    console.log(`\n── Submitting: ${q.label} ──`);
    await sendMessage(client, q.msg);
    process.stdout.write('  Waiting for response');
    const response = await waitForResponse(client, 60);
    console.log('\n  Response tail:\n');
    console.log(response);
    results[q.label] = response;
    await sleep(3000); // pause between queries
  }

  console.log('\n\n=== SUMMARY ===');
  for (const [label, resp] of Object.entries(results)) {
    console.log(`\n── ${label} ──`);
    console.log(resp.slice(-1500));
  }

  await client.close();
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
