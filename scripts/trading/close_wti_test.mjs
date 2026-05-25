/**
 * close_wti_test.mjs — one-shot close of the manually-placed WTI test position.
 * Targets WTI specifically rather than closeAllPositions to avoid touching
 * any unrelated open trades.
 */
import { evaluate } from '../../src/connection.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  // Click Positions tab
  await evaluate(`(function(){
    var btns = document.querySelectorAll('button');
    for (var i=0;i<btns.length;i++) if ((btns[i].textContent||'').trim()==='Positions') { btns[i].click(); return; }
  })()`);
  await sleep(1200);

  // Inject CSS to force hover-gated action buttons to render. TradingView usually
  // hides per-row close/edit icons until :hover; synthetic JS events don't trigger
  // CSS hover, so we just unhide everything in the positions table.
  await evaluate(`(function(){
    var s = document.createElement('style');
    s.id = '__naked_guard_force_hover__';
    s.textContent = 'tr [class*="action"], tr [class*="hover"], tr button { opacity: 1 !important; visibility: visible !important; display: inline-flex !important; }';
    document.head.appendChild(s);
  })()`);
  await sleep(300);

  // BlackBull position rows expose [data-name="close-settings-cell-button"] in
  // the rightmost cell. Find every WTI Long/Short row and click the close button
  // by direct selector — no hover required.
  const r = await evaluate(`(function(){
    var rows = Array.from(document.querySelectorAll('tr'));
    var clicked = 0, notFound = 0;
    for (var i=0; i<rows.length; i++) {
      var text = (rows[i].innerText||'').replace(/\\s+/g,' ').trim();
      if (!text.toUpperCase().startsWith('WTI')) continue;
      if (!/(Long|Short)/i.test(text)) continue;
      var btn = rows[i].querySelector('[data-name="close-settings-cell-button"]');
      if (!btn) { notFound++; continue; }
      btn.click();
      clicked++;
    }
    return 'clicked=' + clicked + ' notFound=' + notFound;
  })()`);
  console.log('Click:', r);
  await sleep(900);

  // Confirm modal
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
  console.log('Confirm:', conf);
  await sleep(1500);

  // Re-read positions to verify WTI is gone
  const after = await evaluate(`(function(){
    var rows = Array.from(document.querySelectorAll('tr'));
    var wti = rows.find(function(r){
      var t = (r.innerText||'').replace(/\\s+/g,' ').trim();
      return t.toUpperCase().startsWith('WTI') && /(Buy|Sell|Short|Long)/i.test(t);
    });
    return wti ? ('still open: ' + (wti.innerText||'').replace(/\\s+/g,' ').trim().substring(0, 80)) : 'WTI no longer in positions';
  })()`);
  console.log('After:', after);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
