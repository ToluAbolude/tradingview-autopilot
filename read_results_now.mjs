import { evaluate, getClient } from './src/connection.js';
import * as capture from './src/core/capture.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Click Strategy Report tab
console.log('Opening Strategy Tester...');
await evaluate(`(function() {
  var el = document.querySelector('[aria-label="Open Strategy Report"]');
  if (el && el.offsetParent !== null) { el.click(); return; }
  var btns = Array.from(document.querySelectorAll('button, [role="button"]'));
  var st = btns.find(function(b) {
    return ((b.getAttribute('aria-label')||'') + (b.textContent||'')).toLowerCase().includes('strategy');
  });
  if (st) st.click();
})()`);
await sleep(8000);

// Screenshot first
const ss = await capture.captureScreenshot({ region: 'full' });
console.log('Screenshot:', ss?.file_path || ss?.path);

// Try to read full body
const fullText = await evaluate(`document.body.innerText.substring(0, 8000)`);
console.log('\nFULL BODY (8000 chars):\n', fullText);

(await getClient()).close();
