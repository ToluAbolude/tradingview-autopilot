import { getClient } from './src/connection.js';
import * as pine from './src/core/pine.js';

const consoleOut = await pine.getConsole();
console.log('PINE CONSOLE:');
console.log(JSON.stringify(consoleOut, null, 2));

// Also try reading the console DOM directly
import { evaluate } from './src/connection.js';
const rawConsole = await evaluate(`(function() {
  // Find the bottom panel with compile logs
  var all = Array.from(document.querySelectorAll('[class*="consoleRow"], [class*="console-row"], [class*="log-message"], [class*="pine-console"]'));
  var texts = all.map(function(el) { return (el.textContent||'').trim(); }).filter(function(t) { return t.length > 0; });

  // Also find error glyph markers in the editor
  var glyphs = document.querySelectorAll('[class*="error-glyph"], [class*="glyph-margin-error"], .squiggly-error');

  // Read the Pine editor console / log area at the bottom
  var bottomArea = document.querySelector('[class*="pine-log"], [class*="pineLog"], [class*="script-log"]') ||
                   document.querySelector('[class*="console"]');
  var bottomText = bottomArea ? (bottomArea.innerText||'').substring(0, 3000) : 'no bottom area';

  return {
    consoleItems: texts.slice(0, 20),
    errorGlyphs: glyphs.length,
    bottomText: bottomText
  };
})()`);
console.log('\nRAW CONSOLE:', JSON.stringify(rawConsole, null, 2));

(await getClient()).close();
