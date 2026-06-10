/**
 * validate_div_robust.mjs — Robustness test for the winning variant from v2:
 * stochastic DIVERGENCE + with-trend (EMA50/200) + VWAP side.
 *
 * v2 (90d) gave DIV+trend+vwap PF 1.34 / +0.167R on n=129 — promising but modest.
 * This decides whether that edge is REAL by checking it doesn't depend on one period
 * or one symbol: 180d window + breakdowns by recency (early/recent half), symbol,
 * session, and direction. Same replay machinery as v1/v2.
 *
 * A real edge: positive in BOTH halves, not driven by a single symbol, PF ≳1.25.
 * A mirage: collapses in the recent half, or one symbol carries it all.
 *
 * Usage (on VM, env sourced): node scripts/trading/validate_div_robust.mjs [--days 180]
 */
import { getTrendbars } from './broker_ctrader.mjs';

const args = process.argv.slice(2);
const DAYS = (() => { const i = args.indexOf('--days'); return i >= 0 ? parseFloat(args[i + 1]) : 180; })();
const EOD_HOUR = 20, ATR_LEN = 14, SL_ATR = 1.5, TP_R = 2.0;
const SYMBOLS = ['XAUUSD','XAGUSD','NAS100','US30','SPX500','EURUSD','GBPUSD','USDJPY','BTCUSD','ETHUSD'];

function calcATR(bars, len=14){ const a=[]; for(let i=0;i<bars.length;i++){ const tr=i===0?bars[i].h-bars[i].l:Math.max(bars[i].h-bars[i].l,Math.abs(bars[i].h-bars[i-1].c),Math.abs(bars[i].l-bars[i-1].c)); a.push(i<len?tr:(a[i-1]*(len-1)+tr)/len);} return a; }
function calcEMA(bars,len){ const k=2/(len+1); const e=[]; for(let i=0;i<bars.length;i++) e.push(i===0?bars[i].c:bars[i].c*k+e[i-1]*(1-k)); return e; }
function calcStoch(bars,kLen,dLen=3,slow=1){
  const kRaw=new Array(bars.length).fill(50);
  for(let i=0;i<bars.length;i++){ const s=Math.max(0,i-kLen+1); let hh=-Infinity,ll=Infinity; for(let j=s;j<=i;j++){ if(bars[j].h>hh)hh=bars[j].h; if(bars[j].l<ll)ll=bars[j].l;} kRaw[i]=hh===ll?50:(100*(bars[i].c-ll))/(hh-ll); }
  const smaAt=(arr,len,i)=>{const s=Math.max(0,i-len+1);let sum=0,c=0;for(let j=s;j<=i;j++){sum+=arr[j];c++;}return c?sum/c:50;};
  const k=kRaw.map((_,i)=>slow>1?smaAt(kRaw,slow,i):kRaw[i]);
  const d=k.map((_,i)=>smaAt(k,dLen,i));
  return {k,d};
}
function calcVWAP(bars){ const v=new Array(bars.length).fill(null); let pv=0,vv=0,day=null; for(let i=0;i<bars.length;i++){ const dd=Math.floor(bars[i].t/86400000); if(dd!==day){pv=0;vv=0;day=dd;} const tp=(bars[i].h+bars[i].l+bars[i].c)/3,vol=bars[i].v||1; pv+=tp*vol; vv+=vol; v[i]=vv>0?pv/vv:bars[i].c;} return v; }

function precompute(bars){
  return { stoch14: calcStoch(bars,14,3,1), atr: calcATR(bars,ATR_LEN), ema50: calcEMA(bars,50), ema200: calcEMA(bars,200), vwap: calcVWAP(bars) };
}
function divFire(bars,pc,i,dir){
  if(i<30) return false;
  const k=pc.stoch14.k; let idx=-1;
  if(dir==='long'){ let lo=Infinity; for(let j=i-25;j<=i-5;j++) if(bars[j].l<lo){lo=bars[j].l;idx=j;} if(idx<0) return false; return bars[i].l<lo && k[i]>k[idx] && k[i]>k[i-1] && k[idx]<30; }
  else { let hi=-Infinity; for(let j=i-25;j<=i-5;j++) if(bars[j].h>hi){hi=bars[j].h;idx=j;} if(idx<0) return false; return bars[i].h>hi && k[i]<k[idx] && k[i]<k[i-1] && k[idx]>70; }
}
function trendOK(bars,pc,i,dir){ const up=pc.ema50[i]>pc.ema200[i]&&bars[i].c>pc.ema50[i]; const dn=pc.ema50[i]<pc.ema200[i]&&bars[i].c<pc.ema50[i]; return dir==='long'?up:dn; }
function vwapOK(bars,pc,i,dir){ return dir==='long'?bars[i].c>=pc.vwap[i]:bars[i].c<=pc.vwap[i]; }
function fire(bars,pc,i,dir){ return divFire(bars,pc,i,dir) && trendOK(bars,pc,i,dir) && vwapOK(bars,pc,i,dir); }

function sessionOf(t){ const h=new Date(t).getUTCHours(); if(h<8)return'ASIAN'; if(h<13)return'LONDON'; if(h<17)return'OVERLAP'; if(h<22)return'NY'; return'DEAD'; }
function eodCutoff(t){ const d=new Date(t); return Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),EOD_HOUR,0,0); }
function replay(bars,atr,i,dir){
  const entry=bars[i].c, risk=SL_ATR*atr[i]; if(!(risk>0))return null;
  const sl=dir==='long'?entry-risk:entry+risk, tp=dir==='long'?entry+risk*TP_R:entry-risk*TP_R;
  const horizon=Math.max(eodCutoff(bars[i].t),bars[i].t+3600e3);
  for(let j=i+1;j<bars.length;j++){ const b=bars[j];
    if(b.t>horizon){ const mtm=(dir==='long'?bars[j-1].c-entry:entry-bars[j-1].c)/risk; return {R:mtm,kind:'eod',exitIdx:j-1}; }
    if(dir==='long'){ if(b.l<=sl)return{R:-1,kind:'sl',exitIdx:j}; if(b.h>=tp)return{R:TP_R,kind:'tp',exitIdx:j}; }
    else { if(b.h>=sl)return{R:-1,kind:'sl',exitIdx:j}; if(b.l<=tp)return{R:TP_R,kind:'tp',exitIdx:j}; }
  }
  return null;
}
function stats(ts){ const n=ts.length; if(!n)return null; const w=ts.filter(t=>t.R>0),l=ts.filter(t=>t.R<=0); const gw=w.reduce((s,t)=>s+t.R,0),gl=Math.abs(l.reduce((s,t)=>s+t.R,0)),tot=ts.reduce((s,t)=>s+t.R,0); return {n,wr:w.length/n,avgR:tot/n,totalR:tot,pf:gl>0?gw/gl:Infinity,tpRate:ts.filter(t=>t.kind==='tp').length/n}; }
function fmt(s){ if(!s)return'n=0'; const pf=s.pf===Infinity?'∞':s.pf.toFixed(2); return `n=${String(s.n).padStart(4)}  WR=${(s.wr*100).toFixed(0).padStart(3)}%  exp=${s.avgR>=0?'+':''}${s.avgR.toFixed(3)}R  totalR=${s.totalR>=0?'+':''}${s.totalR.toFixed(1)}  PF=${pf}  TP%=${(s.tpRate*100).toFixed(0)}`; }
function group(ts,key){ const m=new Map(); for(const t of ts){ const k=key(t); if(!m.has(k))m.set(k,[]); m.get(k).push(t);} return [...m.entries()].map(([k,a])=>[k,stats(a)]).sort((a,b)=>(b[1]?.avgR??-9)-(a[1]?.avgR??-9)); }

async function main(){
  const toMs=Date.now(), fromMs=toMs-DAYS*24*3600e3;
  console.log(`=== DIV+trend+VWAP robustness — real cTrader M15, last ${DAYS}d ===`);
  console.log(`SL=${SL_ATR}×ATR  TP=${TP_R}R  EOD=20:00 UTC  SL-first\n`);
  const all=[];
  for(const sym of SYMBOLS){
    let bars=null;
    try{ bars=await getTrendbars(sym,{period:'M15',fromMs,toMs,windowDays:5}); }catch(e){ console.log(`  ✗ ${sym} — ${e.message}`); continue; }
    if(!bars||bars.length<250){ console.log(`  ✗ ${sym} — only ${bars?.length||0} bars`); continue; }
    const pc=precompute(bars); const trades=[];
    for(const dir of ['long','short']){ let i=210; while(i<bars.length-1){ if(fire(bars,pc,i,dir)){ const r=replay(bars,pc.atr,i,dir); if(r){ trades.push({dir,R:r.R,kind:r.kind,session:sessionOf(bars[i].t),t:bars[i].t,sym}); i=r.exitIdx+1; continue; } } i++; } }
    all.push(...trades);
    console.log(`  ✓ ${sym.padEnd(8)} ${String(bars.length).padStart(5)} bars  |  ${fmt(stats(trades))}`);
  }

  console.log('\n=== OVERALL ===\n  ' + fmt(stats(all)));

  // Recency split
  const sorted=[...all].sort((a,b)=>a.t-b.t); const mid=sorted.length?sorted[Math.floor(sorted.length/2)].t:0;
  console.log(`\n=== RECENCY (split @ ${new Date(mid).toISOString().slice(0,10)}) ===`);
  console.log('  EARLY   ' + fmt(stats(all.filter(t=>t.t<mid))));
  console.log('  RECENT  ' + fmt(stats(all.filter(t=>t.t>=mid))));

  console.log('\n=== BY SYMBOL ===');
  for(const [k,s] of group(all,t=>t.sym)) console.log(`  ${k.padEnd(8)} ${fmt(s)}`);
  console.log('\n=== BY SESSION ===');
  for(const [k,s] of group(all,t=>t.session)) console.log(`  ${k.padEnd(8)} ${fmt(s)}`);
  console.log('\n=== BY DIRECTION ===');
  for(const [k,s] of group(all,t=>t.dir)) console.log(`  ${k.padEnd(8)} ${fmt(s)}`);

  const o=stats(all), e=stats(all.filter(t=>t.t<mid)), r=stats(all.filter(t=>t.t>=mid));
  console.log('\n=== VERDICT ===');
  if(!o||o.n<60){ console.log(`  ⚠ n=${o?.n||0} — too few to trust. Widen basket or window.`); }
  else {
    const stable = e&&r&&e.avgR>0&&r.avgR>0;
    const symPos = group(all,t=>t.sym).filter(([,s])=>s&&s.avgR>0).length;
    console.log(`  Overall ${fmt(o)}`);
    console.log(`  Recency: ${stable?'STABLE (both halves positive)':'UNSTABLE (a half is negative)'}`);
    console.log(`  Breadth: ${symPos}/${group(all,t=>t.sym).length} symbols positive`);
    const verdict = o.avgR>0 && o.pf>=1.25 && stable && symPos>=4;
    console.log(`  → ${verdict?'EDGE HOLDS — worth implementing as a conditioned divergence vote (with operator sign-off before live).':'NOT robust enough to arm — edge is period/symbol-dependent.'}`);
  }
  console.log('\nNote: optimistic upper bound (no spread/commission/slippage). Need PF≳1.25 + recency stability to bank on it live.');
  process.exit(0);
}
main().catch(e=>{ console.error('FATAL',e); process.exit(1); });
