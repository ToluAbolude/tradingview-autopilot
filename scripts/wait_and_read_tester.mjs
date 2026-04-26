import { evaluate } from "../src/connection.js";
const sleep = ms => new Promise(r => setTimeout(r, ms));

const waitSecs = parseInt(process.argv[2] || '30');
console.log(`Waiting ${waitSecs}s...`);
await sleep(waitSecs * 1000);

// Try many selectors to find the strategy tester
const result = await evaluate(`(function(){
  try {
    // Search for elements containing "Total trades" text
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    var candidates = [];
    while (walker.nextNode()) {
      var node = walker.currentNode;
      var ownText = '';
      node.childNodes.forEach(function(c) {
        if (c.nodeType === 3) ownText += c.textContent;
      });
      if (/Total trades|Percent profitable|Profit factor/i.test(ownText)) {
        candidates.push(node.tagName + '.' + (node.className || '').substring(0, 30) + ': ' + ownText.trim().substring(0, 50));
      }
    }
    if (candidates.length > 0) return 'Found: ' + candidates.slice(0, 5).join(' | ');

    // Fallback: search body text
    var bodyText = document.body.textContent;
    var idx = bodyText.indexOf('Total trades');
    if (idx >= 0) return 'In body: ' + bodyText.slice(idx, idx+100);

    // Check strategy tester button state
    var btn = document.querySelector('[data-name="backtesting-dialog-button"]');
    return 'not found. Tester btn: ' + (btn ? 'exists' : 'null');
  } catch(e) { return 'err:' + e.message; }
})()`);
console.log('Result:', result);
