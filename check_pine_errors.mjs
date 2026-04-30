import { evaluate, getClient } from './src/connection.js';
import * as pine from './src/core/pine.js';

// Get current errors from Pine editor
const errors = await pine.getErrors({});
console.log('Current errors:', JSON.stringify(errors, null, 2));

// Also check if strategy tester tab exists (indicates successful compile)
const stateCheck = await evaluate(`(function() {
  var stTab = document.querySelector('[data-name="backtesting-dialog-button"]') ||
              Array.from(document.querySelectorAll('[role="tab"]'))
                .find(t => (t.textContent||'').includes('Strategy Tester'));
  var pineConsole = document.querySelector('[class*="pine-console"]');
  var compiledOk = document.querySelector('[class*="study-item"]');
  return JSON.stringify({
    strategyTesterTab: !!stTab,
    stTabText: stTab ? (stTab.textContent||'').trim() : null,
    compiledIndicator: !!compiledOk
  });
})()`);
console.log('State:', stateCheck);
(await getClient()).close();
