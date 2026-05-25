/**
 * naked_position_guard.mjs — Continuous post-fill guard.
 * Scans open positions; any with missing SL or TP is REPAIRED by re-attaching
 * the SL/TP values the bot originally tried to submit (looked up from
 * trades.csv). If repair fails, the position is CLOSED — never left naked.
 *
 * Why repair-first: BlackBull silently strips bracket legs on certain
 * symbols (LTCUSD, XAGUSD — bracket goes to <SYMBOL>2026 dated contract
 * while the parent Market lands on spot). The parent position is fine; only
 * the SL/TP brackets need re-attaching. Closing every time = giving up on
 * those symbols. Repair = trade them safely.
 *
 * Modes:
 *   --report   (default) scan only, log naked positions, no action
 *   --enforce  repair-first; close as fallback
 *   --close-only  strict close on any naked detection (no repair attempt)
 *
 * Findings log: /home/ubuntu/trading-data/naked_guard.log
 */
import { evaluate } from '../../src/connection.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import os from 'os';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const IS_LINUX  = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX
  ? '/home/ubuntu/trading-data'
  : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const LOG_FILE   = join(DATA_ROOT, 'naked_guard.log');
const TRADES_CSV = join(DATA_ROOT, 'trade_log', 'trades.csv');

const TRADE_LOOKUP_WINDOW_MIN = 60; // only use trades placed in the last hour for intent lookup

const mode = process.argv.includes('--close-only') ? 'close-only'
           : process.argv.includes('--enforce')    ? 'enforce'
           : process.argv.includes('--report')     ? 'report'
           : 'report';

if (!existsSync(dirname(LOG_FILE))) mkdirSync(dirname(LOG_FILE), { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { appendFileSync(LOG_FILE, line); } catch (_) {}
}

const isMissing = v => !v || v === '' || v === '-' || v === '—' || v === '0';

// ── trades.csv intent lookup ────────────────────────────────────────────────
function findRecentTradeIntent(sym, side) {
  if (!existsSync(TRADES_CSV)) return null;
  const cutoff = new Date(Date.now() - TRADE_LOOKUP_WINDOW_MIN * 60 * 1000);
  const lines = readFileSync(TRADES_CSV, 'utf8').trim().split('\n').slice(1);
  // walk newest-first
  for (let i = lines.length - 1; i >= 0; i--) {
    const p = lines[i].split(',');
    const tradeTs  = new Date(p[0]);
    const tradeSym = (p[2] || '').trim();
    const tradeDir = (p[4] || '').trim().toLowerCase();
    if (isNaN(tradeTs) || tradeTs < cutoff) break;
    if (tradeSym !== sym) continue;
    if (tradeDir !== side) continue;
    const sl = parseFloat(p[7]);
    const tpField = (p[8] || '').trim();
    // tp field is "tp2/tp3" or "tp2/tp3/tp4" — take first target
    const tp = parseFloat(tpField.split('/')[0]);
    if (!isFinite(sl) || !isFinite(tp) || sl <= 0 || tp <= 0) continue;
    return { sl, tp, ts: p[0] };
  }
  return null;
}

// ── DOM: positions, close, repair ───────────────────────────────────────────
async function openPositionsTab() {
  await evaluate(`(function(){
    var btns = document.querySelectorAll('button');
    for (var i=0;i<btns.length;i++) {
      if ((btns[i].textContent||'').trim()==='Positions') { btns[i].click(); return; }
    }
  })()`);
  await sleep(900);
}

async function getOpenPositions() {
  await openPositionsTab();
  const json = await evaluate(`(function(){
    if (/there are no open po/i.test(document.body.innerText||'')) return '[]';
    var rows = Array.from(document.querySelectorAll('tr'));
    var out  = [];
    rows.forEach(function(row){
      var cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 6) return;
      var text = (row.innerText||'').replace(/\\s+/g,' ').trim();
      if (!/(Short|Long)/i.test(text) || text.length < 10) return;
      var symM  = text.match(/^([A-Z0-9]{3,10})/);
      var sideM = text.match(/(Short|Long)/i);
      if (!symM || !sideM) return;
      var raw = symM[1];
      var sym = (raw.length>6 && /^[SL]$/.test(raw.slice(-1))) ? raw.slice(0,-1) : raw;
      var tp = (cells[3] && cells[3].textContent || '').trim().replace(/,/g,'');
      var sl = (cells[4] && cells[4].textContent || '').trim().replace(/,/g,'');
      var qty = parseFloat((cells[2] && cells[2].textContent || '0').replace(/,/g,'')) || 0;
      out.push({ sym, side: sideM[1].toLowerCase(), qty, tp, sl });
    });
    return JSON.stringify(out);
  })()`);
  return JSON.parse(json || '[]');
}

// Open the position-edit dialog for a row by hovering then clicking its edit/pencil button.
async function openPositionEditor(sym, side) {
  return await evaluate(`(function(){
    var rows = Array.from(document.querySelectorAll('tr'));
    for (var i=0; i<rows.length; i++) {
      var text = (rows[i].innerText||'').replace(/\\s+/g,' ').trim();
      if (!text.toUpperCase().startsWith('${sym.toUpperCase()}')) continue;
      if (!new RegExp('${side}', 'i').test(text)) continue;
      rows[i].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      rows[i].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      var editBtn = rows[i].querySelector('[data-name*="edit" i], [aria-label*="Edit" i], [title*="Edit" i]');
      if (editBtn && editBtn.offsetParent !== null) { editBtn.click(); return 'clicked edit btn'; }
      // Fallback: try any button containing an SVG (pencil icon is typically SVG)
      var btns = rows[i].querySelectorAll('button');
      for (var j=0; j<btns.length; j++) {
        if (btns[j].offsetParent !== null && btns[j].querySelector('svg')) {
          btns[j].click();
          return 'clicked svg btn ' + j;
        }
      }
      return 'row found but no edit button';
    }
    return 'row not found';
  })()`);
}

// Set SL and TP fields in the open edit dialog. Both are required — partial fills abort.
async function fillSLTPInDialog(slPrice, tpPrice) {
  return await evaluate(`(function(){
    var ticket = document.querySelector('[class*="orderTicket"]') || document;
    var slInput = ticket.querySelector('[data-qa-id~="order-ticket-stop-loss-input"]');
    var tpInput = ticket.querySelector('[data-qa-id~="order-ticket-take-profit-input"]');
    if (!slInput || !tpInput) {
      // Fallback by placeholder/aria
      var inputs = Array.from(ticket.querySelectorAll('input'));
      if (!slInput) slInput = inputs.find(function(inp){
        var l = (inp.getAttribute('placeholder')||inp.getAttribute('aria-label')||'').toLowerCase();
        return l.includes('stop');
      });
      if (!tpInput) tpInput = inputs.find(function(inp){
        var l = (inp.getAttribute('placeholder')||inp.getAttribute('aria-label')||'').toLowerCase();
        return l.includes('profit') || l.includes('take');
      });
    }
    if (!slInput || !tpInput) return { ok: false, reason: 'inputs not found', slFound: !!slInput, tpFound: !!tpInput };

    function enableCheckbox(qa) {
      var cb = ticket.querySelector('[data-qa-id="' + qa + '"]');
      if (cb && !cb.checked) {
        var s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked').set;
        s.call(cb, true);
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        cb.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
    }
    enableCheckbox('order-ticket-stop-loss-checkbox-bracket');
    enableCheckbox('order-ticket-take-profit-checkbox-bracket');

    function fillInput(el, val) {
      el.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, String(val));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      el.blur();
    }
    fillInput(slInput, ${slPrice});
    fillInput(tpInput, ${tpPrice});

    return { ok: true, slValue: slInput.value, tpValue: tpInput.value };
  })()`);
}

async function clickSaveInDialog() {
  return await evaluate(`(function(){
    var btns = Array.from(document.querySelectorAll('button'));
    var ok = btns.find(function(b){
      if (b.offsetParent === null) return false;
      var t = (b.textContent||'').trim().toLowerCase();
      return t === 'ok' || t === 'save' || t === 'update' || t === 'apply' || t === 'modify';
    });
    if (ok) { ok.click(); return 'saved: ' + ok.textContent.trim(); }
    return 'no save btn';
  })()`);
}

async function repairPosition(pos, intent) {
  log(`  → repair ${pos.sym} ${pos.side} with SL=${intent.sl} TP=${intent.tp} (intent ts=${intent.ts})`);
  const opened = await openPositionEditor(pos.sym, pos.side);
  log(`    editor: ${opened}`);
  if (!/clicked/.test(opened)) return false;
  await sleep(1200);
  const filled = await fillSLTPInDialog(intent.sl, intent.tp);
  log(`    filled: ${JSON.stringify(filled)}`);
  if (!filled?.ok) {
    // Escape to dismiss any open dialog so we don't strand it
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, keyCode: 27 }))`);
    return false;
  }
  await sleep(500);
  const saved = await clickSaveInDialog();
  log(`    save: ${saved}`);
  await sleep(1500);
  return /saved|modify/.test(saved);
}

async function closePosition(sym, side) {
  // BlackBull's position rows expose [data-name="close-settings-cell-button"] in
  // the rightmost cell — direct selector, no CSS :hover required (synthetic JS
  // hover events don't trigger CSS hover anyway, so we just click the button by
  // data-name. Position direction in the Positions tab is "Long"/"Short", not
  // "Buy"/"Sell" — match either form.
  const sideRe = side === 'long' || side === 'buy'  ? 'Long|Buy'
               : side === 'short'|| side === 'sell' ? 'Short|Sell'
               : side;
  const r = await evaluate(`(function(){
    var rows = Array.from(document.querySelectorAll('tr'));
    for (var i=0; i<rows.length; i++) {
      var text = (rows[i].innerText||'').replace(/\\s+/g,' ').trim();
      if (!text.toUpperCase().startsWith('${sym.toUpperCase()}')) continue;
      if (!new RegExp('${sideRe}', 'i').test(text)) continue;
      var closeBtn = rows[i].querySelector('[data-name="close-settings-cell-button"]');
      if (closeBtn) { closeBtn.click(); return 'clicked close-settings-cell-button'; }
      // Fallback selectors for any future DOM change
      var fb = rows[i].querySelector('[aria-label="Close"], [title="Close"]');
      if (fb) { fb.click(); return 'clicked fallback close'; }
      return 'row found but no close button';
    }
    return 'row not found';
  })()`);
  await sleep(700);
  const conf = await evaluate(`(function(){
    var btns = Array.from(document.querySelectorAll('button'));
    var ok = btns.find(function(b){
      if (b.offsetParent === null) return false;
      var t = (b.textContent||'').trim();
      return t === 'Close position' || t === 'Confirm' || t === 'Yes' || t === 'OK';
    });
    if (ok) { ok.click(); return 'confirmed: ' + ok.textContent.trim(); }
    return 'no modal';
  })()`);
  await sleep(800);
  return `${r} → ${conf}`;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  log(`=== NAKED POSITION GUARD (${mode}) ===`);

  const positions = await getOpenPositions();
  log(`Open positions: ${positions.length}`);
  for (const p of positions) {
    log(`  ${p.sym} ${p.side} qty=${p.qty} tp=${p.tp || '-'} sl=${p.sl || '-'}`);
  }

  const naked = positions.filter(p => isMissing(p.sl) || isMissing(p.tp));
  if (naked.length === 0) {
    log('✓ All open positions have both SL and TP. Nothing to do.');
    return;
  }

  log(`⚠ NAKED positions detected: ${naked.length}`);
  for (const p of naked) {
    const why = [isMissing(p.sl) ? 'no SL' : null, isMissing(p.tp) ? 'no TP' : null].filter(Boolean).join('+');
    log(`  ${p.sym} ${p.side} — ${why}`);
  }

  if (mode === 'report') {
    log('[report] No action taken. Run with --enforce to repair-or-close.');
    return;
  }

  let repaired = 0, closed = 0, failed = 0;
  for (const p of naked) {
    let didRepair = false;
    if (mode === 'enforce') {
      const intent = findRecentTradeIntent(p.sym, p.side);
      if (intent) {
        try {
          didRepair = await repairPosition(p, intent);
          if (didRepair) repaired++;
        } catch (e) {
          log(`  ✗ repair exception: ${e.message}`);
        }
      } else {
        log(`  ${p.sym} ${p.side} — no recent trades.csv intent within ${TRADE_LOOKUP_WINDOW_MIN}min, will close`);
      }
    }
    if (!didRepair) {
      try {
        const r = await closePosition(p.sym, p.side);
        log(`  ${p.sym} close: ${r}`);
        closed++;
      } catch (e) {
        log(`  ✗ close failed: ${e.message}`);
        failed++;
      }
    }
  }

  await sleep(1500);
  const after = await getOpenPositions();
  const stillNaked = after.filter(p => isMissing(p.sl) || isMissing(p.tp));
  log(`Repaired: ${repaired} | Closed: ${closed} | Failed: ${failed} | Still naked: ${stillNaked.length}`);
  if (stillNaked.length > 0) {
    log('⚠ ESCALATE: some naked positions resisted both repair and close — manual VNC required.');
    process.exit(2);
  }
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
