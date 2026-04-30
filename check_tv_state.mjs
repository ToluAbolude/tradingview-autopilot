import { evaluate, getClient } from './src/connection.js';

const r = await evaluate(`(function() {
  var btn = document.querySelector('[aria-label="Pine"]') ||
            document.querySelector('[data-name="pine-dialog-button"]');
  var editors = document.querySelectorAll('.monaco-editor');
  var bottomBtns = Array.from(document.querySelectorAll('[class*="bottom-bar"] button, [class*="bottomBar"] button')).map(b => b.getAttribute('aria-label') || b.textContent.trim()).slice(0,20);
  return JSON.stringify({
    pineBtn: btn ? btn.tagName + '/' + (btn.getAttribute('aria-label') || '') : 'not found',
    editorCount: editors.length,
    url: window.location.href.substring(0, 80),
    title: document.title.substring(0, 60),
    bottomBtns: bottomBtns
  });
})()`);

console.log('TV state:', r);
(await getClient()).close();
