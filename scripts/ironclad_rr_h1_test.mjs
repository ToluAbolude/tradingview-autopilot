/**
 * Ironclad MTF — test two variables:
 *  A) H1 timeframe on all 5 Forex pairs (more chart history than 15M)
 *  B) RR variations (1.5, 2.0, 3.0) on EUR/USD at both 15M and H1
 */
import { evaluate, getClient } from '../src/connection.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir  = dirname(fileURLToPath(import.meta.url));
const client = await getClient();
const sleep  = ms => new Promise(r => setTimeout(r, ms));

const PAIRS = [
  { sym: 'BLACKBULL:EURUSD', label: 'EUR/USD' },
  { sym: 'BLACKBULL:GBPUSD', label: 'GBP/USD' },
  { sym: 'BLACKBULL:AUDUSD', label: 'AUD/USD' },
  { sym: 'BLACKBULL:USDCHF', label: 'USD/CHF' },
  { sym: 'BLACKBULL:USDJPY', label: 'USD/JPY' },
];

function parseResults(raw) {
  const t = raw.replace(/\s+/g, ' ');
  const trades  = t.match(/Total trade[s]?\s*([\d,]+)/i)?.[1]?.replace(',','') || '?';
  const winrate = t.match(/Profitable trade[s]?\s*[\d.]+%\s*([\d.]+%)/i)?.[1]
               || t.match(/([\d.]+%)\s*\d+\/\d+/)?.[1] || '?';
  const pf      = t.match(/Profit factor\s*([\d.]+)/i)?.[1] || '?';
  const pct     = t.match(/Net P&(?:amp;)?L[^%]*([+\-][\d.]+%)/i)?.[1] || '?';
  const dd      = t.match(/Max equity drawdown\s*[\d,.]+\s*USD\s*([\d.]+%)/i)?.[1] || '?';
  return { trades, winrate, pf, pct, dd };
}

async function injectPine(rr) {
  const baseSrc = readFileSync(join(__dir, 'current.pine'), 'utf-8');
  const src = baseSrc.replace(
    /i_rr\s*=\s*input\.float\(\s*[\d.]+/,
    `i_rr = input.float(${rr}`
  );

  // Open Pine editor
  await evaluate(`(function(){
    try {
      var bwb = window.TradingView.bottomWidgetBar;
      if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
      else bwb.showWidget('pine-editor');
    } catch(e) {}
  })()`);
  await sleep(1500);

  // Toolbar fallback
  const hasMonaco = await evaluate(`!!document.querySelector('.monaco-editor.pine-editor-monaco')`);
  if (!hasMonaco) {
    await evaluate(`(function(){
      var allBtns = document.querySelectorAll('button, [role="tab"]');
      for (var i=0;i<allBtns.length;i++){
        var t=(allBtns[i].textContent||'')+(allBtns[i].getAttribute('title')||'')+(allBtns[i].getAttribute('aria-label')||'');
        if (/pine.?editor|pine.?script/i.test(t) && allBtns[i].offsetParent){ allBtns[i].click(); return; }
      }
    })()`);
    await sleep(1500);
  }

  // Wait for Monaco
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    ready = await evaluate(`(function(){
      var c = document.querySelector('.monaco-editor.pine-editor-monaco');
      if (!c) return false;
      var el = c;
      for (var i=0;i<20;i++){
        if (!el) break;
        var fk = Object.keys(el).find(k=>k.startsWith('__reactFiber$'));
        if (fk){
          var cur = el[fk];
          for (var d=0;d<15;d++){
            if (!cur) break;
            if (cur.memoizedProps?.value?.monacoEnv?.editor) return true;
            cur = cur.return;
          }
          break;
        }
        el = el.parentElement;
      }
      return false;
    })()`);
    if (ready) break;
  }
  if (!ready) throw new Error('Monaco not ready');

  // Inject
  const escaped = JSON.stringify(src);
  await evaluate(`(function(){
    var c = document.querySelector('.monaco-editor.pine-editor-monaco');
    var el = c;
    for (var i=0;i<20;i++){
      if (!el) break;
      var fk = Object.keys(el).find(k=>k.startsWith('__reactFiber$'));
      if (fk){
        var cur = el[fk];
        for (var d=0;d<15;d++){
          if (!cur) break;
          if (cur.memoizedProps?.value?.monacoEnv?.editor){
            cur.memoizedProps.value.monacoEnv.editor.getEditors()[0].setValue(${escaped});
            return;
          }
          cur = cur.return;
        }
        break;
      }
      el = el.parentElement;
    }
  })()`);
  await sleep(300);

  // Save
  await evaluate(`(function(){
    var btns = document.querySelectorAll('button');
    for (var i=0;i<btns.length;i++){
      var b=btns[i]; if (!b.offsetParent) continue;
      if (b.className.indexOf('saveButton-')!==-1||b.getAttribute('title')==='Save script'){ b.click(); return; }
    }
  })()`);
  await sleep(2000);

  // Handle name dialog
  await evaluate(`(function(){
    var inputs=document.querySelectorAll('input');
    for (var i=0;i<inputs.length;i++){
      if (!inputs[i].offsetParent) continue;
      var ph=(inputs[i].getAttribute('placeholder')||'').toLowerCase();
      if (!ph.includes('search')){
        var ns=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
        ns.call(inputs[i],'Ironclad MTF Structure');
        inputs[i].dispatchEvent(new Event('input',{bubbles:true}));
        break;
      }
    }
  })()`);
  await sleep(300);
  await client.Input.dispatchKeyEvent({type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await client.Input.dispatchKeyEvent({type:'keyUp',key:'Enter',code:'Enter'});
  await sleep(1500);

  // Wait save complete
  for (let i=0;i<25;i++){
    const cls = await evaluate(`(function(){var b=document.querySelector('[class*="saveButton-"]');return b?b.className:'none';})()`);
    if (/saved-/.test(cls) && !/unsaved-|pending-/.test(cls)) break;
    await sleep(800);
  }

  // Click Update on chart
  for (let i=0;i<15;i++){
    const r = await evaluate(`(function(){
      var btns=document.querySelectorAll('button');
      for (var i=0;i<btns.length;i++){
        var b=btns[i]; if (!b.offsetParent) continue;
        var title=b.getAttribute('title')||'';
        if (/^(Add to chart|Update on chart)$/i.test(title)){b.click();return 'ok';}
      }
      return 'no';
    })()`);
    if (r === 'ok') break;
    await sleep(800);
  }
  await sleep(8000);
}

async function readBacktest(sym, tf) {
  await evaluate(`(function(){
    var a=window.TradingViewApi._activeChartWidgetWV.value();
    a.setSymbol('${sym}',null,true);
    a.setResolution('${tf}');
  })()`);
  await sleep(5000);
  await evaluate(`window.TradingView.bottomWidgetBar.showWidget('backtesting')`);
  await sleep(5000);
  let raw = '';
  for (let i=0;i<20;i++){
    raw = await evaluate(`(function(){
      var el=document.querySelector('[class*="backtesting"]');
      return el?el.textContent.replace(/\\s+/g,' '):'';
    })()`);
    if (/Total trade/i.test(raw)) break;
    await sleep(1500);
  }
  return parseResults(raw);
}

// ══════════════════════════════════════════════════
// PART A — H1 on all 5 pairs (RR = 1.5 default)
// ══════════════════════════════════════════════════
console.log('\n╔══════════════════════════════════════════════════════╗');
console.log('║  PART A: H1 Timeframe — All 5 Pairs (RR=1.5)        ║');
console.log('╚══════════════════════════════════════════════════════╝');

// H1 uses same injected strategy — just switch TF
const h1Results = [];
for (const pair of PAIRS) {
  process.stdout.write(`  ${pair.label}... `);
  const r = await readBacktest(pair.sym, '60');
  h1Results.push({ ...pair, ...r });
  process.stdout.write(`${r.trades} trades | WR ${r.winrate} | PF ${r.pf} | ${r.pct} | DD ${r.dd}\n`);
}

// ══════════════════════════════════════════════════
// PART B — RR variations on EUR/USD (15M + H1)
// ══════════════════════════════════════════════════
console.log('\n╔══════════════════════════════════════════════════════╗');
console.log('║  PART B: RR Variations — EUR/USD (15M + H1)          ║');
console.log('╚══════════════════════════════════════════════════════╝');

const rrResults = [];
for (const rr of [2.0, 3.0]) {
  console.log(`\n  Injecting RR=${rr}...`);
  await injectPine(rr);

  for (const tf of ['15', '60']) {
    const label = tf === '15' ? '15M' : 'H1';
    process.stdout.write(`  EUR/USD ${label} RR=${rr}... `);
    const r = await readBacktest('BLACKBULL:EURUSD', tf);
    rrResults.push({ label: `EUR/USD ${label}`, rr, ...r });
    process.stdout.write(`${r.trades} trades | WR ${r.winrate} | PF ${r.pf} | ${r.pct} | DD ${r.dd}\n`);
  }
}

// ══════════════════════════════════════════════════
// SUMMARY
// ══════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════════════════════');
console.log(' PART A — H1 Results (Nov 2025 – Apr 2026)');
console.log('═══════════════════════════════════════════════════════════════');
console.log(` ${'Pair'.padEnd(10)} ${'Trades'.padEnd(8)} ${'WR'.padEnd(10)} ${'PF'.padEnd(8)} ${'Net%'.padEnd(10)} DD`);
console.log('─'.repeat(60));
for (const r of h1Results) {
  const flag = parseFloat(r.pf) >= 1.0 ? '✓' : '✗';
  console.log(` ${r.label.padEnd(10)} ${r.trades.padEnd(8)} ${r.winrate.padEnd(10)} ${r.pf.padEnd(8)} ${r.pct.padEnd(10)} ${r.dd}  ${flag}`);
}

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(' PART B — RR Variations on EUR/USD');
console.log('═══════════════════════════════════════════════════════════════');
console.log(` ${'Setup'.padEnd(18)} ${'RR'.padEnd(6)} ${'Trades'.padEnd(8)} ${'WR'.padEnd(10)} ${'PF'.padEnd(8)} ${'Net%'.padEnd(10)} DD`);
console.log('─'.repeat(70));
// Include 15M RR=1.5 baseline for comparison
console.log(` ${'EUR/USD 15M'.padEnd(18)} ${'1.5'.padEnd(6)} ${'55'.padEnd(8)} ${'43.64%'.padEnd(10)} ${'0.609'.padEnd(8)} ${'?'.padEnd(10)} 5.04%  ✗`);
for (const r of rrResults) {
  const flag = parseFloat(r.pf) >= 1.0 ? '✓' : '✗';
  console.log(` ${r.label.padEnd(18)} ${String(r.rr).padEnd(6)} ${r.trades.padEnd(8)} ${r.winrate.padEnd(10)} ${r.pf.padEnd(8)} ${r.pct.padEnd(10)} ${r.dd}  ${flag}`);
}
console.log('═'.repeat(70));
