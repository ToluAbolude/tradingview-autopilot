/**
 * set_tpsl_positions.mjs
 * Sets TP/SL on all open positions that are missing them.
 * Reads open positions from the positions table, clicks the edit icon on each,
 * then fills TP and SL using the modify dialog.
 */
import { evaluate, getClient } from '../../src/connection.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// TP/SL to apply per symbol for SHORT positions (based on today's signals)
const TPSL = {
  ETHUSD: { sl: 2121.61, tp: 2100.51 },  // covers both May 18 and May 19 shorts
  XAGUSD: { sl: 76.22,   tp: 75.57   },
};

async function readPositions() {
  await evaluate(`(function(){
    var tabs = Array.from(document.querySelectorAll('button'));
    var t = tabs.find(b => b.textContent.trim().startsWith('Positions'));
    if (t) t.click();
  })()`);
  await sleep(800);

  return await evaluate(`(function(){
    // Find all rows that look like position data
    var all = Array.from(document.querySelectorAll('tr, [class*="row"]'));
    var results = [];
    all.forEach(function(row) {
      var text = (row.innerText||'').replace(/\\s+/g,' ').trim();
      if (!/(ETHUSD|XAGUSD)/i.test(text)) return;
      if (text.length < 15) return;
      // Extract position ID (8+ digit number at end)
      var idm = text.match(/(\\d{8,})/g);
      var posId = idm ? idm[idm.length-1] : null;
      // Check if SL is missing (shows 0 or empty)
      var noSL = /Short\\s+[\\d.]+\\s+\\d*\\.?\\d*\\s+0\\.0/.test(text) || text.includes('0.0 0.0');
      results.push({ text: text.substring(0, 120), posId, noSL });
    });
    return JSON.stringify(results);
  })()`);
}

async function modifyPosition(posId, symbol, sl, tp) {
  console.log(`\nModifying position ${posId} (${symbol}): SL=${sl} TP=${tp}`);

  // Find and click the edit/pencil icon for this position
  const editResult = await evaluate(`(function(){
    var posId = '${posId}';
    var allRows = Array.from(document.querySelectorAll('tr, [class*="row"]'));
    var row = allRows.find(r => (r.innerText||'').includes(posId));
    if (!row) return 'row not found';
    // Try to find edit button (pencil icon) — hover first to reveal it
    var mouseenter = new MouseEvent('mouseenter', {bubbles:true});
    row.dispatchEvent(mouseenter);
    var mouseover = new MouseEvent('mouseover', {bubbles:true});
    row.dispatchEvent(mouseover);
    return 'hovered row for ' + posId;
  })()`);
  console.log(' ', editResult);
  await sleep(500);

  // Click the edit button that appears on hover
  const clickResult = await evaluate(`(function(){
    var posId = '${posId}';
    var allRows = Array.from(document.querySelectorAll('tr, [class*="row"]'));
    var row = allRows.find(r => (r.innerText||'').includes(posId));
    if (!row) return 'row not found';
    // Look for edit/pencil buttons in this row
    var btns = Array.from(row.querySelectorAll('button, [data-name], [class*="icon"]'));
    // Try edit-specific ones first
    var edit = btns.find(b => {
      var d = b.getAttribute('data-name')||'';
      var a = b.getAttribute('aria-label')||'';
      var t = b.title||'';
      return /edit|modify|pencil/i.test(d+a+t);
    });
    if (edit) { edit.click(); return 'clicked edit: ' + (edit.getAttribute('data-name')||edit.title||'?'); }
    // Fallback: click the first small button in the row
    var small = btns.find(b => b.offsetParent && b.offsetWidth < 40);
    if (small) { small.click(); return 'clicked first small btn'; }
    return 'no edit btn found';
  })()`);
  console.log(' ', clickResult);
  await sleep(1200);

  // Fill TP/SL in the modify dialog
  const fillResult = await evaluate(`(function(){
    function fillInput(el, val) {
      if (!el) return false;
      el.focus(); el.select();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, String(val));
      el.dispatchEvent(new KeyboardEvent('keydown', {key:'Tab', bubbles:true}));
      el.blur();
      return el.value;
    }
    // Try data-qa-id first, then fallback selectors
    var tpInput = document.querySelector('[data-qa-id~="order-ticket-take-profit-input"]') ||
                  document.querySelector('[placeholder*="Take profit"]') ||
                  document.querySelector('input[name*="tp"]');
    var slInput = document.querySelector('[data-qa-id~="order-ticket-stop-loss-input"]') ||
                  document.querySelector('[placeholder*="Stop loss"]') ||
                  document.querySelector('input[name*="sl"]');

    // Enable TP/SL checkboxes if needed
    var cSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked').set;
    var tpCb = document.querySelector('[data-qa-id="order-ticket-take-profit-checkbox-bracket"]');
    var slCb = document.querySelector('[data-qa-id="order-ticket-stop-loss-checkbox-bracket"]');
    if (tpCb && !tpCb.checked) {
      cSetter.call(tpCb, true);
      tpCb.dispatchEvent(new Event('change', {bubbles:true}));
      tpCb.dispatchEvent(new MouseEvent('click', {bubbles:true}));
    }
    if (slCb && !slCb.checked) {
      cSetter.call(slCb, true);
      slCb.dispatchEvent(new Event('change', {bubbles:true}));
      slCb.dispatchEvent(new MouseEvent('click', {bubbles:true}));
    }
    return JSON.stringify({tpInput: !!tpInput, slInput: !!slInput, tpCb: !!tpCb, slCb: !!slCb});
  })()`);
  console.log('  Inputs found:', fillResult);
  await sleep(800);

  // Now fill values
  const setResult = await evaluate(`(function(){
    function fillInput(el, val) {
      if (!el) return null;
      el.focus(); el.select();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, String(val));
      el.dispatchEvent(new KeyboardEvent('keydown', {key:'Tab', bubbles:true}));
      el.blur();
      return el.value;
    }
    var tpInput = document.querySelector('[data-qa-id~="order-ticket-take-profit-input"]');
    var slInput = document.querySelector('[data-qa-id~="order-ticket-stop-loss-input"]');
    return JSON.stringify({tpSet: fillInput(tpInput, ${tp}), slSet: fillInput(slInput, ${sl})});
  })()`);
  console.log('  Set values:', setResult);
  await sleep(500);

  // Submit/Save
  const saveResult = await evaluate(`(function(){
    var btns = Array.from(document.querySelectorAll('button'));
    var btn = btns.find(b => b.offsetParent && /^(save|confirm|ok|apply|update|place|sell|buy)$/i.test((b.textContent||'').trim()));
    if (btn) { btn.click(); return 'saved: ' + btn.textContent.trim(); }
    // Also try "Sell X SYMBOL MARKET" button
    var market = btns.find(b => b.offsetParent && /(MARKET|LIMIT)/.test(b.textContent));
    if (market) { market.click(); return 'market btn: ' + market.textContent.trim().substring(0,40); }
    return 'no save btn found';
  })()`);
  console.log('  Save:', saveResult);
  await sleep(800);

  // Confirm if needed
  const confResult = await evaluate(`(function(){
    var btns = Array.from(document.querySelectorAll('button'));
    var c = btns.find(b => b.offsetParent && /^(confirm|ok|yes)$/i.test((b.textContent||'').trim()));
    if (c) { c.click(); return 'confirmed'; }
    return 'none';
  })()`);
  if (confResult !== 'none') console.log('  Confirm:', confResult);
}

async function main() {
  console.log('Reading open positions...');
  const positionsJson = await readPositions();
  const positions = JSON.parse(positionsJson || '[]');
  console.log('All matching rows:', JSON.stringify(positions, null, 2));

  const toFix = positions.filter(p => p.posId);
  console.log(`\nWill attempt to set TP/SL on ${toFix.length} position(s)`);

  for (const pos of toFix) {
    const sym = /ETHUSD/i.test(pos.text) ? 'ETHUSD' : /XAGUSD/i.test(pos.text) ? 'XAGUSD' : null;
    if (!sym || !TPSL[sym]) { console.log('Unknown symbol, skipping:', pos.text.substring(0,50)); continue; }
    const { sl, tp } = TPSL[sym];
    await modifyPosition(pos.posId, sym, sl, tp);
    // Re-click Positions tab after each modification
    await evaluate(`(function(){
      var tabs = Array.from(document.querySelectorAll('button'));
      var t = tabs.find(b => b.textContent.trim().startsWith('Positions'));
      if (t) t.click();
    })()`);
    await sleep(800);
  }

  console.log('\nDone. Take a screenshot to verify.');
  process.exit(0);
}

main().catch(e => { console.error(e.message); process.exit(1); });
