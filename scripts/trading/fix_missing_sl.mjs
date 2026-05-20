/**
 * fix_missing_sl.mjs
 * One-shot: finds open positions with no SL and adds one based on ATR.
 * Run once to repair positions placed before the execute_trade.mjs SL fix.
 */
import { evaluate } from '../../src/connection.js';
import { getBars, setChart, waitForBars } from './setup_finder.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Instrument ATR SL multiplier — same as INST_PROFILE in setup_finder
const SL_ATR = {
  AUS200: 1.5, JP225: 1.5, HK50: 1.5, GER40: 1.5, UK100: 1.5,
  NAS100: 1.5, US30: 1.5, SPX500: 1.5, EUSTX50: 1.5,
  BTCUSD: 2.0, ETHUSD: 2.0, SOLUSD: 2.0,
  XRPUSD: 1.5, BNBUSD: 1.5, LTCUSD: 1.5,
  XAUUSD: 1.5, XAGUSD: 1.5,
  WTI: 1.5, BRENT: 1.5,
};

function calcATR(bars, period = 14) {
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const b  = bars[i];
    const pb = bars[i - 1];
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - pb.c), Math.abs(b.l - pb.c)));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

async function getOpenPositions() {
  await evaluate(`(function(){
    var btns = document.querySelectorAll('button');
    for (var i=0;i<btns.length;i++) if ((btns[i].textContent||'').trim()==='Positions') { btns[i].click(); break; }
  })()`);
  await sleep(1000);

  const json = await evaluate(`(function(){
    if (/there are no open po/i.test(document.body.innerText||'')) return '[]';
    var rows = Array.from(document.querySelectorAll('tr'));
    var positions = [];
    rows.forEach(function(row){
      var cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 6) return;
      var text = (row.innerText||'').replace(/\\s+/g,' ').trim();
      if (!/(Short|Long)/i.test(text) || text.length<10) return;
      var symM  = text.match(/^([A-Z0-9]{3,10})/);
      var sideM = text.match(/(Short|Long)/i);
      if (!symM || !sideM) return;
      var raw = symM[1];
      var sym = (raw.length>6 && /^[SL]$/.test(raw.slice(-1))) ? raw.slice(0,-1) : raw;
      // cells: Symbol(0) Side(1) Qty(2) TP(3) SL(4) Profit(5)...
      var tp = (cells[3]?.textContent||'').trim().replace(/,/g,'');
      var sl = (cells[4]?.textContent||'').trim().replace(/,/g,'');
      var qty = parseFloat((cells[2]?.textContent||'0').replace(/,/g,'')) || 0;
      var profit = parseFloat((cells[5]?.textContent||'0').replace(/[^0-9.-]/g,'')) || 0;
      positions.push({ sym, side: sideM[1].toLowerCase(), qty, tp: tp||null, sl: sl||null, profit });
    });
    return JSON.stringify(positions);
  })()`);

  return JSON.parse(json || '[]');
}

// Edit a position to add SL — clicks the pencil icon on the matching position row
async function editPositionSL(sym, slPrice) {
  // Click Positions tab to ensure panel is visible
  await evaluate(`(function(){
    var btns = document.querySelectorAll('button');
    for (var i=0;i<btns.length;i++) if ((btns[i].textContent||'').trim()==='Positions') { btns[i].click(); break; }
  })()`);
  await sleep(800);

  // Find the position row for this symbol and click its edit/pencil button
  const clicked = await evaluate(`(function(){
    var rows = Array.from(document.querySelectorAll('tr'));
    for (var i=0; i<rows.length; i++) {
      var text = (rows[i].innerText||'').replace(/\\s+/g,' ').trim();
      if (text.indexOf('${sym}') !== 0 && !text.startsWith('${sym}')) continue;
      if (!/(Short|Long)/i.test(text)) continue;
      // Hover row to make action buttons appear
      rows[i].dispatchEvent(new MouseEvent('mouseover', {bubbles:true}));
      rows[i].dispatchEvent(new MouseEvent('mouseenter', {bubbles:true}));
      // Find pencil/edit button in this row
      var btns = rows[i].querySelectorAll('button, [class*="edit"], [class*="pencil"], [data-name*="edit"], [class*="action"]');
      for (var j=0; j<btns.length; j++) {
        var t = (btns[j].textContent||btns[j].getAttribute('aria-label')||'').toLowerCase();
        if (t.includes('edit') || btns[j].querySelector('svg')) { btns[j].click(); return 'clicked row btn for ${sym}'; }
      }
      // Fallback: click first button in row's action area
      var allBtns = rows[i].querySelectorAll('button');
      if (allBtns.length > 0) { allBtns[allBtns.length-1].click(); return 'clicked last btn in ${sym} row'; }
    }
    return 'row not found';
  })()`);
  console.log(`  Edit click: ${clicked}`);
  await sleep(1000);

  // Look for SL input in the edit dialog / inline editor that appeared
  const slSet = await evaluate(`(function(){
    // Check for an inline order-ticket style editor
    var ticket = document.querySelector('[class*="orderTicket"]');
    var slInput = ticket
      ? ticket.querySelector('[data-qa-id~="order-ticket-stop-loss-input"]')
      : document.querySelector('[data-qa-id~="order-ticket-stop-loss-input"]');

    // Fallback: any input labelled stop loss
    if (!slInput) {
      var inputs = Array.from(document.querySelectorAll('input'));
      slInput = inputs.find(function(inp) {
        var label = (inp.getAttribute('placeholder')||inp.getAttribute('aria-label')||inp.id||'').toLowerCase();
        return label.includes('stop') || label.includes('loss');
      });
    }

    if (!slInput) return 'sl_input_not_found';

    // Enable SL toggle if checkbox exists
    var slCb = document.querySelector('[data-qa-id="order-ticket-stop-loss-checkbox-bracket"]');
    if (slCb && !slCb.checked) {
      var s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked').set;
      s.call(slCb, true);
      slCb.dispatchEvent(new Event('change', {bubbles:true}));
      slCb.dispatchEvent(new MouseEvent('click', {bubbles:true}));
    }

    slInput.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, '${slPrice}');
    slInput.dispatchEvent(new KeyboardEvent('keydown', {key:'Tab', bubbles:true}));
    slInput.blur();
    return 'set:' + slInput.value;
  })()`);
  console.log(`  SL input result: ${slSet}`);

  if (slSet === 'sl_input_not_found') return false;

  await sleep(600);

  // Click OK / Save / Update button
  const saved = await evaluate(`(function(){
    var btns = Array.from(document.querySelectorAll('button'));
    var ok = btns.find(function(b){
      var t = (b.textContent||'').trim().toLowerCase();
      return b.offsetParent && (t==='ok'||t==='save'||t==='update'||t==='apply'||t==='set');
    });
    if (ok) { ok.click(); return 'saved: '+ok.textContent.trim(); }
    // Submit-style button
    var submit = btns.find(function(b){ return b.offsetParent && /^(buy|sell|place)/i.test((b.textContent||'').trim()); });
    if (submit) { submit.click(); return 'submit: '+submit.textContent.trim(); }
    return 'no save btn found';
  })()`);
  console.log(`  Save result: ${saved}`);
  await sleep(1000);
  return true;
}

async function main() {
  console.log('=== FIX MISSING SL ===');
  const positions = await getOpenPositions();
  console.log(`Open positions: ${positions.length}`);
  positions.forEach(p => console.log(`  ${p.sym} ${p.side} qty=${p.qty} tp=${p.tp} sl=${p.sl} profit=${p.profit}`));

  const missing = positions.filter(p => !p.sl || p.sl === '' || p.sl === '-');
  console.log(`\nPositions without SL: ${missing.length}`);

  if (missing.length === 0) { console.log('Nothing to fix.'); return; }

  for (const pos of missing) {
    console.log(`\n── Fixing ${pos.sym} ${pos.side} ──`);

    try {
      // Switch to this instrument's chart and get ATR from 15M bars
      await setChart(`BLACKBULL:${pos.sym}`, '15');
      const bars = await waitForBars(300, 50, 3, 700);
      if (!bars || bars.length < 20) throw new Error('Not enough bars for ATR');

      const atr     = calcATR(bars);
      const current = bars[bars.length - 1].c;
      const mult    = SL_ATR[pos.sym] || 1.5;
      // For short: SL is ABOVE entry; for long: SL is BELOW entry
      const slPrice = pos.side === 'short'
        ? Math.round((current + atr * mult) * 10000) / 10000
        : Math.round((current - atr * mult) * 10000) / 10000;

      console.log(`  ATR=${atr.toFixed(4)} current=${current} SL=${slPrice} (${pos.side} ${mult}×ATR)`);

      // Go back to positions tab and edit
      const ok = await editPositionSL(pos.sym, slPrice);
      if (ok) {
        console.log(`  ✅ SL set to ${slPrice} for ${pos.sym}`);
      } else {
        console.log(`  ⚠ Could not find SL input — may need manual edit via VNC`);
      }
    } catch(e) {
      console.log(`  ✗ Error: ${e.message}`);
    }
  }

  console.log('\n=== DONE ===');

  // Final state
  await sleep(1000);
  const final = await getOpenPositions();
  console.log('\nFinal positions:');
  final.forEach(p => console.log(`  ${p.sym} ${p.side} TP=${p.tp} SL=${p.sl}`));
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
