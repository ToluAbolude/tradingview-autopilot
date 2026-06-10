/**
 * validate_kurisko_exact.mjs — Kurisko's THREE real setups, encoded from the full
 * 46-min transcript (Apify pull), validated on real cTrader bars.
 *
 * Corrections vs my earlier approximation:
 *  - Quad rotation = all 4 stochastics' %D under 20 (long) / over 80 (short) AT ONCE.
 *  - Holy Grail = quad-rotation oversold cluster + bullish divergence on the 9,3
 *    (price equal/lower low, stoch higher low) + 9,3 %D turning up through 20.
 *  - 20/20 Bull Flag = 60,10 %D embedded >80 + pullback to 20 EMA + 9,3 %D to ~20
 *    turning up, price holding the 20 EMA (with-trend continuation).
 *  - Bear flag (short) = 60,10 %D embedded <20 + price < 200 EMA + 9,3 rotates up to
 *    80 then turns down.
 *  - STRUCTURAL stop: pattern-low candle (swing low/high) ± buffer, capped at 3×ATR.
 *    TP = 2R. EOD force-close 20:00 UTC. SL-first. No overlapping trades per setup/dir.
 *
 * Stochastics use the %D (signal) line, as he states. Periods: 9,3 / 14,3 / 40,4 / 60,10.
 *
 * Usage (on VM): node scripts/trading/validate_kurisko_exact.mjs [--days 90]
 */
import { getTrendbars } from './broker_ctrader.mjs';

const args = process.argv.slice(2);
const DAYS = (() => { const i = args.indexOf('--days'); return i >= 0 ? parseFloat(args[i + 1]) : 90; })();
const EOD_HOUR = 20, ATR_LEN = 14, TP_R = 2.0, MAX_SL_ATR = 3.0;
const SYMBOLS = ['XAUUSD','XAGUSD','NAS100','US30','SPX500','EURUSD','GBPUSD','USDJPY','BTCUSD','ETHUSD'];
const TFS = ['M5', 'M15'];

function calcATR(bars,len=14){const a=[];for(let i=0;i<bars.length;i++){const tr=i===0?bars[i].h-bars[i].l:Math.max(bars[i].h-bars[i].l,Math.abs(bars[i].h-bars[i-1].c),Math.abs(bars[i].l-bars[i-1].c));a.push(i<len?tr:(a[i-1]*(len-1)+tr)/len);}return a;}
function calcEMA(bars,len){const k=2/(len+1);const e=[];for(let i=0;i<bars.length;i++)e.push(i===0?bars[i].c:bars[i].c*k+e[i-1]*(1-k));return e;}
function calcStoch(bars,kLen,dLen=3,slow=1){
  const kRaw=new Array(bars.length).fill(50);
  for(let i=0;i<bars.length;i++){const s=Math.max(0,i-kLen+1);let hh=-Infinity,ll=Infinity;for(let j=s;j<=i;j++){if(bars[j].h>hh)hh=bars[j].h;if(bars[j].l<ll)ll=bars[j].l;}kRaw[i]=hh===ll?50:(100*(bars[i].c-ll))/(hh-ll);}
  const smaAt=(arr,len,i)=>{const s=Math.max(0,i-len+1);let sum=0,c=0;for(let j=s;j<=i;j++){sum+=arr[j];c++;}return c?sum/c:50;};
  const k=kRaw.map((_,i)=>slow>1?smaAt(kRaw,slow,i):kRaw[i]);
  const d=k.map((_,i)=>smaAt(k,dLen,i));
  return {k,d};
}
function precompute(bars){
  return {
    s9: calcStoch(bars,9,3,1), s14: calcStoch(bars,14,3,1), s40: calcStoch(bars,40,4,1), s60: calcStoch(bars,60,3,10),
    atr: calcATR(bars,ATR_LEN), ema20: calcEMA(bars,20), ema50: calcEMA(bars,50), ema200: calcEMA(bars,200),
  };
}

// quad oversold/overbought cluster within last `win` bars (all 4 %D past the line at one bar)
function quadRecently(pc,i,dir,win=8){
  for(let j=Math.max(1,i-win);j<=i;j++){
    const a=pc.s9.d[j],b=pc.s14.d[j],c=pc.s40.d[j],e=pc.s60.d[j];
    if(dir==='long'  && a<20&&b<20&&c<20&&e<20) return true;
    if(dir==='short' && a>80&&b>80&&c>80&&e>80) return true;
  }
  return false;
}
function priorSwing(bars,i,dir){ // extreme low/high index in [i-12,i-3]
  let idx=-1,val=dir==='long'?Infinity:-Infinity;
  for(let j=i-12;j<=i-3;j++){ if(j<0)continue; if(dir==='long'){if(bars[j].l<val){val=bars[j].l;idx=j;}}else{if(bars[j].h>val){val=bars[j].h;idx=j;}} }
  return idx;
}

// ── Setup 1: Holy Grail (quad rotation + divergence) ──
function holyGrail(bars,pc,i,dir){
  if(i<30) return false;
  if(!quadRecently(pc,i,dir)) return false;
  const pl=priorSwing(bars,i,dir); if(pl<0) return false;
  const d9=pc.s9.d;
  if(dir==='long'){
    const lowerLow = bars[i].l <= bars[pl].l*1.0008;       // price equal/lower low
    const stochHigherLow = d9[i] > d9[pl];                  // momentum higher low
    const turnUp = d9[i] > d9[i-1] && d9[i-1] < 22;         // 9,3 turning up through 20
    return lowerLow && stochHigherLow && turnUp;
  } else {
    const higherHigh = bars[i].h >= bars[pl].h*0.9992;
    const stochLowerHigh = d9[i] < d9[pl];
    const turnDown = d9[i] < d9[i-1] && d9[i-1] > 78;
    return higherHigh && stochLowerHigh && turnDown;
  }
}
// ── Setup 2: 20/20 Bull Flag (long) / mirror (short) ──
function flag2020(bars,pc,i,dir){
  if(i<30) return false;
  const d9=pc.s9.d, d60=pc.s60.d;
  if(dir==='long'){
    const embedded = d60[i]>80 && d60[i-1]>80 && d60[i-2]>80;            // 60,10 strong trend
    const aboveTrend = bars[i].c>pc.ema20[i] && pc.ema20[i]>pc.ema50[i]; // uptrend
    const pulledToEma = Math.min(bars[i].l,bars[i-1].l,bars[i-2].l) <= pc.ema20[i]+pc.atr[i]*0.4;
    const nineDip = Math.min(d9[i-1],d9[i-2],d9[i-3]||50) < 25;
    const turnUp = d9[i] > d9[i-1];
    return embedded && aboveTrend && pulledToEma && nineDip && turnUp;
  } else {
    const embedded = d60[i]<20 && d60[i-1]<20 && d60[i-2]<20;            // bear flag: embedded low
    const belowTrend = bars[i].c<pc.ema200[i] && bars[i].c<pc.ema20[i];
    const rallyToEma = Math.max(bars[i].h,bars[i-1].h,bars[i-2].h) >= pc.ema20[i]-pc.atr[i]*0.4;
    const nineSpike = Math.max(d9[i-1],d9[i-2],d9[i-3]||50) > 75;
    const turnDown = d9[i] < d9[i-1];
    return embedded && belowTrend && rallyToEma && nineSpike && turnDown;
  }
}

function sessionOf(t){const h=new Date(t).getUTCHours();if(h<8)return'ASIAN';if(h<13)return'LONDON';if(h<17)return'OVERLAP';if(h<22)return'NY';return'DEAD';}
function eodCutoff(t){const d=new Date(t);return Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),EOD_HOUR,0,0);}

// Structural stop: pattern-low/high candle over last 6 bars ± buffer, capped at MAX_SL_ATR.
function replay(bars,pc,i,dir){
  const entry=bars[i].c, atr=pc.atr[i]; if(!(atr>0))return null;
  const buf=atr*0.10;
  let sl;
  if(dir==='long'){ let lo=Infinity; for(let j=Math.max(0,i-6);j<=i;j++) if(bars[j].l<lo)lo=bars[j].l; sl=lo-buf; }
  else            { let hi=-Infinity; for(let j=Math.max(0,i-6);j<=i;j++) if(bars[j].h>hi)hi=bars[j].h; sl=hi+buf; }
  let risk=Math.abs(entry-sl);
  if(!(risk>0)) return null;
  if(risk>atr*MAX_SL_ATR){ risk=atr*MAX_SL_ATR; sl=dir==='long'?entry-risk:entry+risk; }   // cap absurd stops
  const tp=dir==='long'?entry+risk*TP_R:entry-risk*TP_R;
  const horizon=Math.max(eodCutoff(bars[i].t),bars[i].t+3600e3);
  for(let j=i+1;j<bars.length;j++){const b=bars[j];
    if(b.t>horizon){const mtm=(dir==='long'?bars[j-1].c-entry:entry-bars[j-1].c)/risk;return{R:mtm,kind:'eod',exitIdx:j-1};}
    if(dir==='long'){if(b.l<=sl)return{R:-1,kind:'sl',exitIdx:j};if(b.h>=tp)return{R:TP_R,kind:'tp',exitIdx:j};}
    else{if(b.h>=sl)return{R:-1,kind:'sl',exitIdx:j};if(b.l<=tp)return{R:TP_R,kind:'tp',exitIdx:j};}
  }
  return null;
}
function runDetector(bars,pc,fireFn){
  const trades=[];
  for(const dir of ['long','short']){let i=210;while(i<bars.length-1){if(fireFn(bars,pc,i,dir)){const r=replay(bars,pc,i,dir);if(r){trades.push({dir,R:r.R,kind:r.kind,session:sessionOf(bars[i].t),t:bars[i].t});i=r.exitIdx+1;continue;}}i++;}}
  return trades;
}
function stats(ts){const n=ts.length;if(!n)return null;const w=ts.filter(t=>t.R>0),l=ts.filter(t=>t.R<=0);const gw=w.reduce((s,t)=>s+t.R,0),gl=Math.abs(l.reduce((s,t)=>s+t.R,0)),tot=ts.reduce((s,t)=>s+t.R,0);return{n,wr:w.length/n,avgR:tot/n,totalR:tot,pf:gl>0?gw/gl:Infinity,tpRate:ts.filter(t=>t.kind==='tp').length/n};}
function fmt(s){if(!s)return'n=0';const pf=s.pf===Infinity?'∞':s.pf.toFixed(2);return `n=${String(s.n).padStart(4)}  WR=${(s.wr*100).toFixed(0).padStart(3)}%  exp=${s.avgR>=0?'+':''}${s.avgR.toFixed(3)}R  totalR=${s.totalR>=0?'+':''}${s.totalR.toFixed(1)}  PF=${pf}  TP%=${(s.tpRate*100).toFixed(0)}`;}

async function main(){
  const toMs=Date.now(), fromMs=toMs-DAYS*24*3600e3;
  console.log(`=== Kurisko EXACT setups (from full transcript) — real cTrader, last ${DAYS}d ===`);
  console.log(`Structural stop (pattern low/high, cap ${MAX_SL_ATR}×ATR)  TP=${TP_R}R  EOD 20:00  SL-first\n`);
  const setups={ 'HolyGrail(quad+div)': holyGrail, '2020 Flag': flag2020 };

  for(const tf of TFS){
    const agg=Object.fromEntries(Object.keys(setups).map(k=>[k,[]]));
    process.stdout.write(`\n##### TIMEFRAME ${tf} #####\n`);
    for(const sym of SYMBOLS){
      let bars=null;
      try{ bars=await getTrendbars(sym,{period:tf,fromMs,toMs,windowDays:5}); }catch(e){ console.log(`  ✗ ${sym} — ${e.message}`); continue; }
      if(!bars||bars.length<300){ console.log(`  ✗ ${sym} — only ${bars?.length||0} bars`); continue; }
      const pc=precompute(bars);
      for(const [name,fn] of Object.entries(setups)) agg[name].push(...runDetector(bars,pc,fn));
      process.stdout.write(`  ✓ ${sym.padEnd(8)} ${String(bars.length).padStart(6)} bars\n`);
    }
    for(const [name,ts] of Object.entries(agg)){
      console.log(`\n  ── ${name} [${tf}] ──`);
      console.log(`    ALL    ${fmt(stats(ts))}`);
      console.log(`    long   ${fmt(stats(ts.filter(t=>t.dir==='long')))}`);
      console.log(`    short  ${fmt(stats(ts.filter(t=>t.dir==='short')))}`);
      // recency
      const sorted=[...ts].sort((a,b)=>a.t-b.t); const mid=sorted.length?sorted[Math.floor(sorted.length/2)].t:0;
      console.log(`    EARLY  ${fmt(stats(ts.filter(t=>t.t<mid)))}`);
      console.log(`    RECENT ${fmt(stats(ts.filter(t=>t.t>=mid)))}`);
    }
  }
  console.log('\nNote: optimistic upper bound (no spread/commission/slippage). Need PF≳1.25 + recency stability + n≥40 to take seriously.');
  process.exit(0);
}
main().catch(e=>{console.error('FATAL',e);process.exit(1);});
