/**
 * zone_limits_preview.mjs — DRY-RUN preview of proactive S&R zone limit orders.
 *
 * Captures the mechanism the reversal_sr_backtest validated (+703R net, robust
 * OOS): rest a LIMIT at each active S&R zone near price, BEFORE the touch —
 *   support zone  → BUY  LIMIT at zone top,    SL = zone bottom − 0.5·ATR, TP = 2R
 *   resistance    → SELL LIMIT at zone bottom, SL = zone top    + 0.5·ATR, TP = 2R
 * Only zones within `reachATR` of price (a plausible pullback) and not broken.
 *
 * Prints + writes trading-data/zone_limits.json. PLACES NOTHING — this is the
 * "show me the real entry/SL/TP on live signals" step before any live wiring.
 *
 * Usage (VM): node scripts/trading/zone_limits_preview.mjs
 */
import { getTrendbars, connect } from './broker_ctrader.mjs';
import { writeFileSync } from 'fs';

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const TF = arg('tf', 'H1'), REACH = parseFloat(arg('reach', '3'));   // zones within 3·ATR of price
const P = { pivLen: 5, maxZones: 8, buf: 0.5, R: 2 };
const SYMS = arg('sym', 'XAUUSD,EURUSD,GBPJPY,US30,NAS100,USDJPY,GER40,BTCUSD').split(',');
const OUT = '/home/ubuntu/trading-data/zone_limits.json';

function atr14(bars){ const o=new Array(bars.length).fill(null); let pc=null,a=null; const t=[];
  for(let i=0;i<bars.length;i++){ const b=bars[i]; const tr=pc==null?b.h-b.l:Math.max(b.h-b.l,Math.abs(b.h-pc),Math.abs(b.l-pc)); pc=b.c;
    if(i<14){t.push(tr); if(i===13){a=t.reduce((s,x)=>s+x,0)/14;o[i]=a;}} else {a=(a*13+tr)/14;o[i]=a;} } return o; }
function piv(bars,i,len,hi){ const c=i-len; if(c<len)return null; const cv=hi?bars[c].h:bars[c].l;
  for(let k=1;k<=len;k++){ if(hi?!(cv>bars[c-k].h&&cv>bars[c+k].h):!(cv<bars[c-k].l&&cv<bars[c+k].l))return null; } return {c,cv}; }

// active (non-broken) wick-to-body zones at the last bar
function zones(bars){
  const n=bars.length, O=i=>bars[i].o,C=i=>bars[i].c;
  const sup=[],res=[];
  for(let i=0;i<n;i++){
    const pl=piv(bars,i,P.pivLen,false);
    if(pl){ const lo=pl.cv; let hi=null,best=null; for(let k=0;k<=P.pivLen;k++){ const bb=Math.min(O(i-k),C(i-k)); const d=bb-lo; if(d>=0&&(best==null||d<best)){best=d;hi=bb;} } if(hi==null)hi=Math.min(O(i-P.pivLen),C(i-P.pivLen));
      if(!sup.some(z=>lo>=z.lo&&lo<=z.hi)){ sup.unshift({lo,hi,broken:false}); if(sup.length>P.maxZones)sup.pop(); } }
    const ph=piv(bars,i,P.pivLen,true);
    if(ph){ const hi=ph.cv; let lo=null,best=null; for(let k=0;k<=P.pivLen;k++){ const bt=Math.max(O(i-k),C(i-k)); const d=hi-bt; if(d>=0&&(best==null||d<best)){best=d;lo=bt;} } if(lo==null)lo=Math.max(O(i-P.pivLen),C(i-P.pivLen));
      if(!res.some(z=>hi>=z.lo&&hi<=z.hi)){ res.unshift({lo,hi,broken:false}); if(res.length>P.maxZones)res.pop(); } }
    for(const z of sup) if(!z.broken&&Math.max(O(i),C(i))<z.lo) z.broken=true;
    for(const z of res) if(!z.broken&&Math.min(O(i),C(i))>z.hi) z.broken=true;
  }
  return { sup:sup.filter(z=>!z.broken), res:res.filter(z=>!z.broken) };
}

const rnd = (x, p) => Math.round(x * p) / p;
async function main(){
  await connect();
  const fromMs = Date.now() - 60*86400000;   // ~60d of H1 = plenty of zones
  const out = { ts:new Date().toISOString(), tf:TF, orders:[] };
  console.log(`\n═══ PROACTIVE S&R ZONE LIMITS — DRY-RUN PREVIEW (${TF}, zones within ${REACH}·ATR of price) ═══`);
  console.log('  places nothing — shows the limit it WOULD rest at each active zone near price\n');
  for(const s of SYMS){
    let bars; try{ bars=await getTrendbars(s,{period:TF,fromMs,windowDays:20}); }catch(e){ console.log(`  ${s}: ${e.message}`); continue; }
    if(!bars||bars.length<200){ console.log(`  ${s}: thin`); continue; }
    const atr=atr14(bars), a=atr[atr.length-1]||0, px=bars[bars.length-1].c;
    const z=zones(bars); const p=px>1000?100:px>10?1000:100000;   // rounding precision by price magnitude
    let printed=false;
    for(const zn of z.sup){ if(zn.hi<px && (px-zn.hi)<=REACH*a){ const entry=zn.hi, sl=zn.lo-P.buf*a, risk=entry-sl; if(risk<=0)continue; const tp=entry+P.R*risk;
      const o={sym:s,dir:'long',type:'BUY LIMIT @ support',entry:rnd(entry,p),sl:rnd(sl,p),tp:rnd(tp,p),distATR:rnd((px-entry)/a,10)}; out.orders.push(o);
      console.log(`  ${s.padEnd(8)} ${o.type.padEnd(20)} entry ${o.entry}  SL ${o.sl}  TP ${o.tp}  (${o.distATR}·ATR below px ${rnd(px,p)})`); printed=true; } }
    for(const zn of z.res){ if(zn.lo>px && (zn.lo-px)<=REACH*a){ const entry=zn.lo, sl=zn.hi+P.buf*a, risk=sl-entry; if(risk<=0)continue; const tp=entry-P.R*risk;
      const o={sym:s,dir:'short',type:'SELL LIMIT @ resistance',entry:rnd(entry,p),sl:rnd(sl,p),tp:rnd(tp,p),distATR:rnd((entry-px)/a,10)}; out.orders.push(o);
      console.log(`  ${s.padEnd(8)} ${o.type.padEnd(20)} entry ${o.entry}  SL ${o.sl}  TP ${o.tp}  (${o.distATR}·ATR above px ${rnd(px,p)})`); printed=true; } }
    if(!printed) console.log(`  ${s.padEnd(8)} — no active zone within ${REACH}·ATR of price ${rnd(px,p)}`);
  }
  try{ writeFileSync(OUT, JSON.stringify(out,null,2)); console.log(`\n  ${out.orders.length} would-rest limits → ${OUT}`); }catch(_){}
  console.log('  DRY-RUN — nothing placed. Next: rest these via placeOrder({limitPrice}), with GTC + expiry management.');
  process.exit(0);
}
main().catch(e=>{ console.error('FATAL:',e.stack); process.exit(1); });
