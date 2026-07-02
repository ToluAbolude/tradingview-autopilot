/**
 * load_pine_indicator.mjs — Load a .pine file into TradingView's Pine Editor
 * (via VM-local CDP :9222), save it as a NEW script, and ADD IT TO THE CHART.
 *
 * Discovered by live DOM probing (2026-07-02) — the Pine editor is a floating
 * dialog; its toolbar buttons are icon-only but carry stable data-qa-ids:
 *   pine-script-title-button (name + file menu) · add-script-to-chart ·
 *   pine-script-save-button · script-more-options
 * File menu: "Create new" → "Indicator…" gives a fresh script identity, so
 * Ctrl+S opens the NAME dialog instead of overwriting the open saved script.
 * Safety: current buffer is backed up first; if the editor cannot be switched
 * to a fresh script the run aborts BEFORE any save.
 *
 * Usage (on VM): node scripts/vm/load_pine_indicator.mjs \
 *   --file=strategies/fib_retracement_veto.pine --name="Fib Retracement — Veto" \
 *   [--match=fib] [--require=OPckidUz]
 */
import { readFileSync, writeFileSync } from 'fs';
import { evaluate, getClient } from '../../src/connection.js';
import { ensurePineEditorOpen, getSource, setSource, getErrors } from '../../src/core/pine.js';
import { captureScreenshot } from '../../src/core/capture.js';

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const FILE    = arg('file', '');
const NAME    = arg('name', '');
const MATCH   = new RegExp(arg('match', 'fib'), 'i');
const REQUIRE = arg('require', '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => process.stdout.write(`[load_pine] ${m}\n`);

if (!FILE) { console.error('need --file=path/to/script.pine'); process.exit(1); }
const source = readFileSync(FILE, 'utf8');

const scriptTitle = () => evaluate(`(function(){
  var b = document.querySelector('[data-qa-id="pine-script-title-button"]');
  return b ? (b.textContent || '').trim() : null;
})()`);

async function openTitleMenu() {
  for (let i = 0; i < 3; i++) {
    await evaluate(`(function(){
      var b = document.querySelector('[data-qa-id="pine-script-title-button"]');
      if (b && b.getAttribute('aria-expanded') !== 'true') b.click();
    })()`);
    await sleep(800);
    const open = await evaluate(`(function(){
      var b = document.querySelector('[data-qa-id="pine-script-title-button"]');
      return !!(b && b.getAttribute('aria-expanded') === 'true');
    })()`);
    if (open) return true;
  }
  return false;
}

const clickMenuItem = pattern => evaluate(`(function(){
  var els = document.querySelectorAll('[role="menuitem"]');
  for (var i = 0; i < els.length; i++) {
    if (!els[i].offsetParent) continue;
    var t = (els[i].textContent || '').trim();
    if (new RegExp(${JSON.stringify(pattern)}).test(t)) {
      els[i].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      els[i].click();
      return t;
    }
  }
  return null;
})()`);

async function newScriptViaMenu(originalTitle) {
  if (!(await openTitleMenu())) { log('could not open file menu'); return false; }
  const cn = await clickMenuItem('^Create new');
  if (!cn) { log('no "Create new" item'); return false; }
  await sleep(900);
  const ind = await clickMenuItem('^Indicator');
  if (!ind) { log('no "Indicator" submenu item'); return false; }
  log(`clicked: Create new → ${ind}`);
  await sleep(2000);
  // dismiss a possible "save changes?" prompt on the old buffer — discard
  await evaluate(`(function(){
    var btns = document.querySelectorAll('[role="dialog"] button');
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].textContent || '').trim();
      if (/don.?t save|discard|^no$/i.test(t)) { btns[i].click(); return t; }
    }
    return null;
  })()`);
  await sleep(700);
  const title = await scriptTitle();
  log(`editor script now: "${title}"`);
  return title !== null && title !== originalTitle;
}

// Ctrl+S → name dialog → set our name (React-safe) → Save
async function saveAs(name) {
  const c = await getClient();
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 's', code: 'KeyS' });
  await sleep(1500);
  const res = await evaluate(`(function(){
    var dlg = document.querySelector('[role="dialog"]');
    if (!dlg || !dlg.querySelector('input')) return 'no_dialog';
    var input = dlg.querySelector('input');
    if (${JSON.stringify(!!name)}) {
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(name)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    var btns = dlg.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].textContent || '').trim();
      if (/^Save$/i.test(t)) { var b = btns[i]; setTimeout(function(){ b.click(); }, 200); return 'saved_with_dialog'; }
    }
    return 'dialog_without_save_button';
  })()`);
  await sleep(2000);
  return res;
}

(async () => {
  // ── 0. right tab? ──
  const loc = await evaluate(`({ href: location.href, title: document.title })`);
  log(`target tab: ${loc?.href} — "${loc?.title}"`);
  if (REQUIRE && !(loc?.href || '').includes(REQUIRE)) {
    console.error(`ABORT: tab URL does not contain "${REQUIRE}"`); process.exit(1);
  }

  // ── 1. open editor (dialog mode needs showWidget, not activateScriptEditorTab) ──
  await evaluate(`(function(){ try { window.TradingView.bottomWidgetBar.showWidget('pine-editor'); } catch(e) {} })()`);
  await sleep(2500);
  if (!(await ensurePineEditorOpen())) { console.error('ABORT: Pine editor not available'); process.exit(1); }

  // ── 2. backup whatever is open ──
  const originalTitle = await scriptTitle();
  let backup = '';
  try { const s = await getSource(); backup = typeof s === 'string' ? s : (s?.source || ''); } catch { }
  const bfile = `/home/ubuntu/trading-data/pine_editor_backup_${Date.now()}.pine`;
  writeFileSync(bfile, backup);
  log(`open script "${originalTitle}" backed up (${backup.length} chars) → ${bfile}`);

  // ── 3. fresh script identity — hard requirement, no fallback ──
  if (!(await newScriptViaMenu(originalTitle))) {
    console.error('ABORT: could not create a fresh script — nothing was modified.');
    process.exit(1);
  }

  // ── 4. inject + save under our name ──
  await setSource({ source });
  log(`source set (${source.split('\n').length} lines)`);
  await sleep(1000);
  const saved = await saveAs(NAME);
  const titleNow = await scriptTitle();
  log(`save: ${saved} — script title now "${titleNow}"`);
  // New TV UX saves silently, auto-naming from the indicator() title (no dialog).
  const savedOk = saved === 'saved_with_dialog' || (titleNow && titleNow !== 'Untitled script' && titleNow !== originalTitle);
  if (!savedOk) {
    console.error(`ABORT: save did not take (${saved}, title "${titleNow}"). Check the editor via VNC.`);
    process.exit(1);
  }
  await sleep(2500);

  const errs = await getErrors();
  const fatal = (errs.errors || []).filter(e => e.severity >= 8);
  if (fatal.length) {
    console.error(`ABORT: ${fatal.length} compile error(s):`);
    for (const e of fatal.slice(0, 10)) console.error(`  line ${e.line}: ${e.message}`);
    process.exit(1);
  }
  log('no editor errors');

  // ── 5. add to chart ──
  const added = await evaluate(`(function(){
    var b = document.querySelector('[data-qa-id="add-script-to-chart"]');
    if (b && b.offsetParent) { b.click(); return true; }
    return false;
  })()`);
  if (!added) { console.error('ABORT: add-script-to-chart button not found'); process.exit(1); }
  log('clicked add-script-to-chart');

  // ── 6. verify the study landed ──
  let names = [];
  for (let i = 0; i < 10; i++) {
    await sleep(2000);
    names = await evaluate(`(function(){
      try {
        var st = window.TradingViewApi._activeChartWidgetWV.value().getAllStudies();
        return st.map(function(s){ return s.name || s.title || String(s.id); });
      } catch(e) { return ['ERR ' + e.message]; }
    })()`) || [];
    if (names.some(n => MATCH.test(n))) break;
  }
  log(`studies on chart: ${JSON.stringify(names)}`);
  if (!names.some(n => MATCH.test(n))) {
    console.error('ABORT: study did not appear on the chart (server-side compile may have failed — check editor console via VNC)');
    process.exit(1);
  }

  // saving sometimes auto-adds too — remove duplicate instances
  const deduped = await evaluate(`(function(){
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    var st = chart.getAllStudies().filter(function(s){ return new RegExp(${JSON.stringify(MATCH.source)}, 'i').test(s.name || s.title || ''); });
    var removed = 0;
    while (st.length > 1) { chart.removeEntity(st.shift().id); removed++; }
    return removed;
  })()`);
  if (deduped) log(`removed ${deduped} duplicate instance(s)`);

  const shot = await captureScreenshot({ region: 'chart' });
  log(`screenshot: ${JSON.stringify(shot)}`);
  log('SUCCESS — indicator saved and on chart');
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
