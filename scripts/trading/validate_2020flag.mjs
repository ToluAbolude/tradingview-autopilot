/**
 * validate_2020flag.mjs — CONFIRMATION test for the one Kurisko setup that held up:
 * the 20/20 Bull Flag on M15 (PF 1.32, recency-stable @ 90d).
 *
 * Two questions that killed the earlier divergence candidate must be answered here:
 *   1) Does it survive 180 days (not just a lucky 90d window)? → recency + by-symbol.
 *   2) Does it survive realistic costs? → expectancy at 0 / 0.04 / 0.08 R haircuts
 *      per round trip (PF 1.32 is a no-cost upper bound).
 *
 * Same rules/replay as validate_kurisko_exact.mjs (structural stop, 2R TP, EOD close).
 *
 * Usage (on VM): node scripts/trading/validate_2020flag.mjs [--days 180]
 */
import { getTrendbars } from './broker_ctrader.mjs';

const args = process.argv.slice(2);
const DAYS = (() => { const i = args.indexOf('--days'); return i >= 0 ? parseFloat(args[i + 1]) : 180; })();
const EOD_HOUR = 20, ATR_LEN = 14, TP_R = 2.0, MAX_SL_ATR = 3.0;
const SYMBOLS = ['XAUUSD','XAGUSD','NAS100','US30','SPX500','EURUSD','GBPUSD','USDJPY','BTCUSD','ETHUSD'];
const HAIRCUTS = [0, 0.04, 0.08];   // R deducted per trade for spread+commission+slippage

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
function precompute(bars){return{s9:calcStoch(bars,9,3,1),s60:calcStoch(bars,60,3,10),atr:calcATR(bars,ATR_LEN),ema20:calcEMA(bars,20),ema50:calcEMA(bars,50),ema200:calcEMA(bars,200)};}

function flag2020(bars,pc,i,dir){
  if(i<30) return false;
  const d9=pc.s9.d, d60=pc.s60.d;
  if(dir==='long'){
    const embedded=d60[i]>80&&d60[i-1]>80&&d60[i-2]>80;
    const aboveTrend=bars[i].c>pc.ema20[i]&&pc.ema20[i]>pc.ema50[i];
    const pulledToEma=Math.min(bars[i].l,bars[i-1].l,bars[i-2].l)<=pc.ema20[i]+pc.atr[i]*0.4;
    const nineDip=Math.min(d9[i-1],d9[i-2],d9[i-3]||50)<25;
    const turnUp=d9[i]>d9[i-1];
    return embedded&&aboveTrend&&pulledToEma&&nineDip&&turnUp;
  } else {
    const embedded=d60[i]<20&&d60[i-1]<20&&d60[i-2]<20;
    const belowTrend=bars[i].c<pc.ema200[i]&&bars[i].c<pc.ema20[i];
    const rallyToEma=Math.max(bars[i].h,bars[i-1].h,bars[i-2].h)>=pc.ema20[i]-pc.atr[i]*0.4;
    const nineSpike=Math.max(d9[i-1],d9[i-2],d9[i-3]||50)>75;
    const turnDown=d9[i]<d9[i-1];
    return embedded&&belowTrend&&rallyToEma&&nineSpike&&turnDown;
  }
}
function sessionOf(t){const h=new Date(t).getUTCHours();if(h<8)return'ASIAN';if(h<13)return'LONDON';if(h<17)return'OVERLAP';if(h<22)return'NY';return'DEAD';}
function eodCutoff(t){const d=new Date(t);return Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),EOD_HOUR,0,0);}
function replay(bars,pc,i,dir){
  const entry=bars[i].c,atr=pc.atr[i];if(!(atr>0))return null;const buf=atr*0.10;let sl;
  if(dir==='long'){let lo=Infinity;for(let j=Math.max(0,i-6);j<=i;j++)if(bars[j].l<lo)lo=bars[j].l;sl=lo-buf;}
  else{let hi=-Infinity;for(let j=Math.max(0,i-6);j<=i;j++)if(bars[j].h>hi)hi=bars[j].h;sl=hi+buf;}
  let risk=Math.abs(entry-sl);if(!(risk>0))return null;
  if(risk>atr*MAX_SL_ATR){risk=atr*MAX_SL_ATR;sl=dir==='long'?entry-risk:entry+risk;}
  const tp=dir==='long'?entry+risk*TP_R:entry-risk*TP_R;
  const horizon=Math.max(eodCutoff(bars[i].t),bars[i].t+3600e3);
  for(let j=i+1;j<bars.length;j++){const b=bars[j];
    if(b.t>horizon){const mtm=(dir==='long'?bars[j-1].c-entry:entry-bars[j-1].c)/risk;return{R:mtm,kind:'eod',exitIdx:j-1};}
    if(dir==='long'){if(b.l<=sl)return{R:-1,kind:'sl',exitIdx:j};if(b.h>=tp)return{R:TP_R,kind:'tp',exitIdx:j};}
    else{if(b.h>=sl)return{R:-1,kind:'sl',exitIdx:j};if(b.l<=tp)return{R:TP_R,kind:'tp',exitIdx:j};}
  }
  return null;
}
function run(bars,pc){const t=[];for(const dir of['long','short']){let i=210;while(i<bars.length-1){if(flag2020(bars,pc,i,dir)){const r=replay(bars,pc,i,dir);if(r){t.push({dir,R:r.R,kind:r.kind,session:sessionOf(bars[i].t),t:bars[i].t,sym:bars.sym});i=r.exitIdx+1;continue;}}i++;}}return t;}
function stats(ts,hc=0){const n=ts.length;if(!n)return null;const adj=ts.map(t=>({...t,R:t.R-hc}));const w=adj.filter(t=>t.R>0),l=adj.filter(t=>t.R<=0);const gw=w.reduce((s,t)=>s+t.R,0),gl=Math.abs(l.reduce((s,t)=>s+t.R,0)),tot=adj.reduce((s,t)=>s+t.R,0);return{n,wr:w.length/n,avgR:tot/n,totalR:tot,pf:gl>0?gw/gl:Infinity};}
function fmt(s){if(!s)return'n=0';const pf=s.pf===Infinity?'∞':s.pf.toFixed(2);return `n=${String(s.n).padStart(4)}  WR=${(s.wr*100).toFixed(0).padStart(3)}%  exp=${s.avgR>=0?'+':''}${s.avgR.toFixed(3)}R  totalR=${s.totalR>=0?'+':''}${s.totalR.toFixed(1)}  PF=${pf}`;}
function grp(ts,key){const m=new Map();for(const t of ts){const k=key(t);if(!m.has(k))m.set(k,[]);m.get(k).push(t);}return[...m.entries()].map(([k,a])=>[k,stats(a)]).sort((a,b)=>(b[1]?.avgR??-9)-(a[1]?.avgR??-9));}

async function main(){
  const toMs=Date.now(),fromMs=toMs-DAYS*24*3600e3;
  console.log(`=== 20/20 Bull Flag CONFIRMATION — M15, last ${DAYS}d ===`);
  console.log(`Structural stop (cap ${MAX_SL_ATR}×ATR)  TP=${TP_R}R  EOD 20:00  SL-first\n`);
  const all=[];
  for(const sym of SYMBOLS){
    let bars=null;
    try{bars=await getTrendbars(sym,{period:'M15',fromMs,toMs,windowDays:5});}catch(e){console.log(`  ✗ ${sym} — ${e.message}`);continue;}
    if(!bars||bars.length<300){console.log(`  ✗ ${sym} — only ${bars?.length||0} bars`);continue;}
    bars.sym=sym; const pc=precompute(bars); const t=run(bars,pc); t.forEach(x=>x.sym=sym); all.push(...t);
    console.log(`  ✓ ${sym.padEnd(8)} ${String(bars.length).padStart(5)} bars  |  ${fmt(stats(t))}`);
  }
  console.log('\n=== OVERALL @ cost haircuts ===');
  for(const hc of HAIRCUTS) console.log(`  haircut ${hc.toFixed(2)}R/trade   ${fmt(stats(all,hc))}`);
  console.log('\n=== BY DIRECTION (no haircut) ===');
  for(const[k,s]of grp(all,t=>t.dir))console.log(`  ${k.padEnd(8)} ${fmt(s)}`);
  const sorted=[...all].sort((a,b)=>a.t-b.t);const mid=sorted.length?sorted[Math.floor(sorted.length/2)].t:0;
  console.log(`\n=== RECENCY (split @ ${new Date(mid).toISOString().slice(0,10)}, no haircut) ===`);
  console.log('  EARLY   '+fmt(stats(all.filter(t=>t.t<mid))));
  console.log('  RECENT  '+fmt(stats(all.filter(t=>t.t>=mid))));
  console.log('\n=== BY SYMBOL (no haircut) ===');
  for(const[k,s]of grp(all,t=>t.sym))console.log(`  ${k.padEnd(8)} ${fmt(s)}`);
  console.log('\n=== BY SESSION (no haircut) ===');
  for(const[k,s]of grp(all,t=>t.session))console.log(`  ${k.padEnd(8)} ${fmt(s)}`);

  const o0=stats(all,0),o8=stats(all,0.08),e=stats(all.filter(t=>t.t<mid)),r=stats(all.filter(t=>t.t>=mid));
  const symPos=grp(all,t=>t.sym).filter(([,s])=>s&&s.avgR>0).length;
  console.log('\n=== VERDICT ===');
  if(!o0||o0.n<60){console.log(`  ⚠ n=${o0?.n||0} — too few.`);}
  else{
    const stable=e&&r&&e.avgR>0&&r.avgR>0;
    const survivesCost=o8&&o8.pf>=1.15&&o8.avgR>0;
    console.log(`  No-cost: ${fmt(o0)}`);
    console.log(`  Pessimistic-cost (0.08R): ${fmt(o8)}`);
    console.log(`  Recency: ${stable?'STABLE':'UNSTABLE'} | Breadth: ${symPos}/${grp(all,t=>t.sym).length} symbols positive`);
    const go=o0.pf>=1.25&&stable&&survivesCost&&symPos>=5;
    console.log(`  → ${go?'CONFIRMED — robust + survives costs. Recommend implementing as a with-trend flag vote (operator sign-off before live).':'NOT confirmed — do not arm.'}`);
  }
  console.log('\nNote: still in-sample on one window. Even if confirmed, paper/forward-test before full size.');
  process.exit(0);
}
main().catch(e=>{console.error('FATAL',e);process.exit(1);});
