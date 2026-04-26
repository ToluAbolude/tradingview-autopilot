import { evaluate } from "../src/connection.js";
const sleep = ms => new Promise(r => setTimeout(r, ms));

const waitSecs = parseInt(process.argv[2] || '5');
await sleep(waitSecs * 1000);

const raw = await evaluate(`(function(){
  try {
    var el = document.querySelector('[class*="backtesting"]') ||
             document.querySelector('[data-name="strategy-tester"]');
    if (!el) return 'panel not found';
    return el.textContent.replace(/\\s+/g, ' ').substring(0, 600);
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('RAW:', raw);
