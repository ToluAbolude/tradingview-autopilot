/**
 * naked_position_guard.mjs — Continuous post-fill guard.
 * Scans open positions; closes any without BOTH SL and TP.
 *
 * Background: pre-submit guards in execute_trade.mjs enforce TP/SL at placement,
 * but naked positions still appear (broker-side bracket stripping, alternate
 * code paths, manual orders). Rule from operator: NEVER allow a naked position
 * to persist — close it rather than fly blind.
 *
 * Modes:
 *   --report   (default) scan only, log naked positions, no action
 *   --enforce  close every naked position immediately
 *
 * Writes findings to /home/ubuntu/trading-data/naked_guard.log (always).
 */
import { evaluate } from '../../src/connection.js';
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import os from 'os';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const IS_LINUX  = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX
  ? '/home/ubuntu/trading-data'
  : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const LOG_FILE  = join(DATA_ROOT, 'naked_guard.log');

const mode = process.argv.includes('--enforce') ? 'enforce'
           : process.argv.includes('--report')  ? 'report'
           : 'report';

if (!existsSync(dirname(LOG_FILE))) mkdirSync(dirname(LOG_FILE), { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { appendFileSync(LOG_FILE, line); } catch (_) {}
}

// ── DOM: list open positions + their TP/SL columns ─────────────────────────
async function getOpenPositions() {
  // Click Positions tab
  await evaluate(`(function(){
    var btns = document.querySelectorAll('button');
    for (var i=0;i<btns.length;i++) {
      if ((btns[i].textContent||'').trim()==='Positions') { btns[i].click(); return; }
    }
  })()`);
  await sleep(900);

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
      // cells: Symbol(0) Side(1) Qty(2) TP(3) SL(4) Profit(5)...
      var tp = (cells[3] && cells[3].textContent || '').trim().replace(/,/g,'');
      var sl = (cells[4] && cells[4].textContent || '').trim().replace(/,/g,'');
      var qty = parseFloat((cells[2] && cells[2].textContent || '0').replace(/,/g,'')) || 0;
      out.push({ sym, side: sideM[1].toLowerCase(), qty, tp, sl });
    });
    return JSON.stringify(out);
  })()`);
  return JSON.parse(json || '[]');
}

const isMissing = v => !v || v === '' || v === '-' || v === '—' || v === '0';

// ── DOM: close a specific position by symbol+side ──────────────────────────
async function closePosition(sym, side) {
  // Hover the row, then click its close button (× icon in the rightmost cell)
  const r = await evaluate(`(function(){
    var rows = Array.from(document.querySelectorAll('tr'));
    for (var i=0; i<rows.length; i++) {
      var text = (rows[i].innerText||'').replace(/\\s+/g,' ').trim();
      if (!text.toUpperCase().startsWith('${sym.toUpperCase()}')) continue;
      if (!new RegExp('${side}', 'i').test(text)) continue;
      // Make hover-only action buttons appear
      rows[i].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      rows[i].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      // Look for explicit close button by label / data-name / aria
      var closeBtn = rows[i].querySelector('[data-name*="close"], [aria-label*="Close" i], [title*="Close" i], button[class*="close" i]');
      if (closeBtn && closeBtn.offsetParent !== null) { closeBtn.click(); return 'clicked close button'; }
      // Fallback: rightmost button in the row (close × is usually last)
      var btns = rows[i].querySelectorAll('button');
      if (btns.length > 0) {
        var last = btns[btns.length - 1];
        if (last.offsetParent !== null) { last.click(); return 'clicked last btn in row'; }
      }
      return 'row found but no clickable close';
    }
    return 'row not found';
  })()`);
  await sleep(700);

  // Confirm modal if it pops
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

// ── Main ───────────────────────────────────────────────────────────────────
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
    log('[report] No action taken. Run with --enforce to close them.');
    return;
  }

  // --enforce: close each naked position
  let closed = 0, failed = 0;
  for (const p of naked) {
    log(`→ closing ${p.sym} ${p.side}`);
    try {
      const r = await closePosition(p.sym, p.side);
      log(`  ${r}`);
      closed++;
    } catch (e) {
      log(`  ✗ close failed: ${e.message}`);
      failed++;
    }
  }

  // Verify final state
  await sleep(1200);
  const after = await getOpenPositions();
  const stillNaked = after.filter(p => isMissing(p.sl) || isMissing(p.tp));
  log(`Closed: ${closed} | Failed: ${failed} | Still naked after sweep: ${stillNaked.length}`);
  if (stillNaked.length > 0) {
    log('⚠ ESCALATE: some naked positions resisted close — manual VNC intervention required.');
    process.exit(2);
  }
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
