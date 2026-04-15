/**
 * Submit Smart Trail Scalper to LuxAlgo AI Backtesting Assistant
 * and read the response.
 */
import CDP from 'chrome-remote-interface';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAT_TAB_ID = '6D2EB603F5BAF17F7C2CFA8BB8BBD80D';

const SMART_TRAIL_PATH = path.join(__dirname, '../strategies/jooviers_gems_smart_trail_scalper.pine');
const stratCode = fs.readFileSync(SMART_TRAIL_PATH, 'utf8');

const MESSAGE = `Please backtest this Pine Script strategy and tell me:
1. Which instrument/market is most profitable for this strategy?
2. Which timeframe (1M, 3M, 5M, 15M, 30M) gives the best results?
3. What parameters should be optimised?
4. Any issues with the logic you can see?

Here is the strategy code:

${stratCode}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('Connecting to LuxAlgo AI Backtesting tab...');
  const client = await CDP({ host: 'localhost', port: 9222, target: CHAT_TAB_ID });
  await client.Runtime.enable();

  // Find and clear the message textarea
  console.log('Finding message input...');
  const clearResult = await client.Runtime.evaluate({
    expression: `(function() {
      var ta = document.querySelector('textarea[name="message"]');
      if (!ta) return 'textarea not found';
      ta.focus();
      // Use React synthetic event to set value
      var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      nativeInputValueSetter.call(ta, ${JSON.stringify(MESSAGE)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return 'value set, length: ' + ta.value.length;
    })()`,
    returnByValue: true
  });
  console.log('Set message result:', clearResult.result.value);

  await sleep(1000);

  // Submit the form — find the send button
  const submitResult = await client.Runtime.evaluate({
    expression: `(function() {
      // Try to find submit button (usually form submit or a send button)
      var form = document.querySelector('form');
      var submitBtn = document.querySelector('button[type="submit"]')
                   || document.querySelector('form button:last-child')
                   || Array.from(document.querySelectorAll('button')).find(b =>
                        b.type === 'submit' ||
                        b.innerText.toLowerCase().includes('send') ||
                        b.getAttribute('aria-label')?.toLowerCase().includes('send'));
      if (submitBtn) {
        submitBtn.click();
        return 'clicked submit: ' + (submitBtn.innerText || submitBtn.getAttribute('aria-label'));
      }
      // Fallback: dispatch Enter key on textarea
      var ta = document.querySelector('textarea[name="message"]');
      if (ta) {
        var evt = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, ctrlKey: false, shiftKey: false });
        ta.dispatchEvent(evt);
        return 'dispatched Enter on textarea';
      }
      return 'no submit found';
    })()`,
    returnByValue: true
  });
  console.log('Submit result:', submitResult.result.value);

  await sleep(3000);

  // Wait for response (poll for new content)
  console.log('Waiting for LuxAlgo AI response (up to 60s)...');
  let lastLength = 0;
  let response = '';

  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const contentResult = await client.Runtime.evaluate({
      expression: `(function() {
        var text = document.body ? document.body.innerText : '';
        return { length: text.length, tail: text.slice(-2000) };
      })()`,
      returnByValue: true
    });

    const { length, tail } = contentResult.result.value;
    if (length > lastLength + 100) {
      process.stdout.write('.');
      lastLength = length;
      response = tail;
    } else if (lastLength > 0 && i > 10) {
      // Content stabilised
      break;
    }
  }

  console.log('\n\n=== LUXALGO AI BACKTESTING RESPONSE ===\n');
  console.log(response);

  await client.close();
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
