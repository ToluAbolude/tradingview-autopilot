import { evaluate, getClient } from './src/connection.js';
import * as capture from './src/core/capture.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// What's the current body text (first 3000 chars)
const bodySnip = await evaluate(`document.body.innerText.substring(0, 3000)`);
console.log('BODY:\n', bodySnip);

// Check if strategy tester panel has any text
const panel = await evaluate(`(function() {
  var candidates = [
    document.querySelector('[data-name="backtesting-dialog"]'),
    document.querySelector('[class*="backtesting"]'),
    document.querySelector('[class*="strategyReport"]'),
    document.querySelector('[class*="strategy-report"]')
  ].filter(Boolean);
  if (!candidates.length) return 'NO PANEL FOUND';
  return candidates[0].innerText.substring(0, 2000);
})()`);
console.log('\nPANEL:', panel);

// Also look for any "0 trades" or "No trades" message
const noTrades = await evaluate(`(function() {
  var body = document.body.innerText;
  return {
    hasNetProfit: body.includes('Net Profit'),
    hasTotalTrades: body.includes('Total trades'),
    hasNoTrades: body.includes('No trades') || body.includes('0 trades'),
    hasJackson: body.includes('JACKSON'),
    stratSearch: body.indexOf('JACKSON_v3')
  };
})()`);
console.log('\nHEADER CHECK:', JSON.stringify(noTrades, null, 2));

const ss = await capture.captureScreenshot({ region: 'full' });
console.log('Screenshot:', ss?.file_path || ss?.path);

(await getClient()).close();
