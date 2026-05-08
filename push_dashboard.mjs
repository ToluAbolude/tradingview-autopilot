/**
 * push_dashboard.mjs — one-shot script to inject strategy_dashboard.pine
 * into the live TradingView instance via CDP.
 * Run on the VM: DISPLAY=:1 node push_dashboard.mjs
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import CDP from 'chrome-remote-interface';

const __dir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dir, 'scripts/strategy_dashboard.pine'), 'utf8');

const CDP_PORT = 9222;

const FIND_MONACO = `
  (function findMonacoEditor() {
    // Method 1: React fiber walk (original approach)
    var container = document.querySelector('.monaco-editor.pine-editor-monaco');
    if (container) {
      var el = container;
      for (var i = 0; i < 30; i++) {
        if (!el) break;
        var fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
        if (fiberKey) {
          var current = el[fiberKey];
          for (var d = 0; d < 40; d++) {
            if (!current) break;
            try {
              if (current.memoizedProps && current.memoizedProps.value && current.memoizedProps.value.monacoEnv) {
                var env = current.memoizedProps.value.monacoEnv;
                if (env.editor && typeof env.editor.getEditors === 'function') {
                  var editors = env.editor.getEditors();
                  if (editors.length > 0) return { editor: editors[0], env: env };
                }
              }
            } catch(e) {}
            current = current.return;
          }
        }
        el = el.parentElement;
      }
    }

    // Method 2: window.monaco global
    if (window.monaco && window.monaco.editor) {
      var eds = window.monaco.editor.getEditors();
      if (eds && eds.length > 0) {
        return { editor: eds[0], env: window.monaco };
      }
    }

    // Method 3: TradingView's internal pine editor accessor
    try {
      var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
      if (bwb && bwb._pineEditorWidget) {
        var ped = bwb._pineEditorWidget;
        if (ped._editor) return { editor: ped._editor, env: null };
      }
    } catch(e) {}

    // Method 4: container element internal Monaco property
    if (container) {
      var props = Object.keys(container);
      for (var p = 0; p < props.length; p++) {
        var key = props[p];
        if (key.startsWith('__monaco') || key === '_editor' || key === '_codeEditor') {
          var ed = container[key];
          if (ed && typeof ed.getValue === 'function') return { editor: ed, env: null };
        }
      }
    }

    return null;
  })()
`;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function evaluate(client, expression) {
  const result = await client.Runtime.evaluate({ expression, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function main() {
  console.log('Connecting to TradingView via CDP...');
  const resp = await fetch(`http://localhost:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const target = targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
               || targets.find(t => t.type === 'page' && /tradingview/i.test(t.url));

  if (!target) throw new Error('No TradingView chart page found. Is TradingView open?');
  console.log('Target:', target.url.substring(0, 60));

  const client = await CDP({ host: 'localhost', port: CDP_PORT, target: target.id });
  await client.Runtime.enable();

  // Step 1: Check if Pine Editor is already open
  let monacoReady = await evaluate(client, `(function(){ return ${FIND_MONACO} !== null; })()`);

  if (!monacoReady) {
    console.log('Opening Pine Editor...');

    // Try every known method to open the Pine Editor
    await evaluate(client, `
      (function() {
        // Method 1: bottom widget bar API
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        if (bwb) {
          if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
          else if (typeof bwb.showWidget === 'function') bwb.showWidget('pine-editor');
        }
        // Method 2: button click (various selectors)
        var selectors = [
          '[aria-label="Pine Editor"]',
          '[aria-label="Pine"]',
          '[data-name="pine-dialog-button"]',
          '[data-name="open-script-editor"]',
          '.js-pine-editor-activator',
          '[title="Pine Editor"]',
        ];
        for (var s = 0; s < selectors.length; s++) {
          var btn = document.querySelector(selectors[s]);
          if (btn) { btn.click(); break; }
        }
        // Method 3: find any button whose text includes "Pine"
        var btns = document.querySelectorAll('button, [role="button"]');
        for (var i = 0; i < btns.length; i++) {
          var t = btns[i].textContent.trim();
          if (t === 'Pine Editor' || t === 'Pine') { btns[i].click(); break; }
        }
      })()
    `);

    await sleep(1000);

    // Method 4: keyboard shortcut Alt+P
    await client.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 1, key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80 });
    await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'p', code: 'KeyP' });

    for (let i = 0; i < 60; i++) {
      await sleep(200);
      monacoReady = await evaluate(client, `(function(){ return ${FIND_MONACO} !== null; })()`);
      if (monacoReady) break;
    }

    if (!monacoReady) {
      // Diagnose what Monaco paths are available
      const diag = await evaluate(client, `
        (function() {
          var results = {};
          results.pineMonacoElements = document.querySelectorAll('.monaco-editor.pine-editor-monaco').length;
          results.windowMonaco = typeof window.monaco !== 'undefined';
          results.windowMonacoEditors = window.monaco && window.monaco.editor ? window.monaco.editor.getEditors().length : 0;

          // Try to find via React fiber with deeper walk
          var container = document.querySelector('.monaco-editor.pine-editor-monaco');
          if (container) {
            var el = container;
            var fiberFound = false;
            var maxDepth = 0;
            for (var i = 0; i < 30; i++) {
              if (!el) break;
              var fk = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
              if (fk) { fiberFound = true; break; }
              el = el.parentElement;
            }
            results.fiberFound = fiberFound;
            if (fiberFound) {
              var cur = el[Object.keys(el).find(function(k){return k.startsWith('__reactFiber$')})];
              for (var d = 0; d < 60; d++) {
                if (!cur) break;
                maxDepth = d;
                if (cur.memoizedProps && cur.memoizedProps.value) {
                  results.foundValueAtDepth = d;
                  results.valueKeys = Object.keys(cur.memoizedProps.value).slice(0, 10);
                  break;
                }
                cur = cur.return;
              }
              results.fiberMaxDepth = maxDepth;
            }
          }
          return results;
        })()
      `);
      console.log('Deep diagnostics:', JSON.stringify(diag, null, 2));
      throw new Error('Pine Editor Monaco not accessible after 12s.');
    }
  }

  console.log('Pine Editor open. Injecting source (' + source.split('\n').length + ' lines)...');

  // Step 2: Inject source
  const escaped = JSON.stringify(source);
  const injected = await evaluate(client, `
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return false;
      m.editor.setValue(${escaped});
      return true;
    })()
  `);
  if (!injected) throw new Error('Monaco setValue() failed.');
  console.log('Source injected.');

  await sleep(500);

  // Step 3: Click "Add to chart" / "Save and add to chart"
  const clicked = await evaluate(client, `
    (function() {
      var btns = document.querySelectorAll('button');
      var addBtn = null;
      var updateBtn = null;
      var saveAndAdd = null;
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/save and add to chart/i.test(text)) { saveAndAdd = btns[i]; break; }
        if (!addBtn && /^add to chart$/i.test(text)) addBtn = btns[i];
        if (!updateBtn && /^update on chart$/i.test(text)) updateBtn = btns[i];
      }
      var btn = saveAndAdd || addBtn || updateBtn;
      if (btn) { btn.click(); return btn.textContent.trim(); }
      return null;
    })()
  `);

  if (clicked) {
    console.log('Clicked: "' + clicked + '"');
  } else {
    console.log('No button found — sending Ctrl+Enter...');
    await client.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await sleep(3000);

  // Step 4: Check for errors
  const errors = await evaluate(client, `
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers
        .filter(function(mk) { return mk.severity >= 8; })
        .map(function(mk) { return 'Line ' + mk.startLineNumber + ': ' + mk.message; });
    })()
  `);

  if (errors && errors.length > 0) {
    console.error('Compilation errors:');
    errors.forEach(e => console.error('  ' + e));
    process.exit(1);
  }

  console.log('Strategy Dashboard added to chart successfully.');
  await client.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
