/**
 * kurisko_flag_runner.mjs — Dedicated 20/20 Bull/Bear Flag strategy (John Kurisko).
 *
 * From the full transcript of YouTube PjigwAmhiT0 ([[research/kurisko_..._transcript.md]]).
 * The ONLY Kurisko setup that survived validation, and only on a conditioned slice:
 *   instruments = indices + metals, sessions = active western hours (8-22 UTC), M15.
 * Backtest (validate_2020flag_slice.mjs, 180d real cTrader M15): PF 1.57 no-cost /
 * 1.35 @0.08R cost, recency-stable (early 1.29 → recent 1.90), 5/5 symbols, both dirs.
 *
 * ⚠ The slice was selected POST-HOC. This runner is armed at REDUCED risk (~1%) on the
 *   operator's explicit decision; treat its first weeks as live forward-validation and
 *   scale only once live fills confirm the backtest.
 *
 * SETUP (long "20/20 bull flag"):
 *   - 60,10 stochastic %D embedded >80 for 3 bars (strong trend)
 *   - price above 20 EMA and 20 EMA > 50 EMA (uptrend)
 *   - pullback: recent low within 0.4×ATR of the 20 EMA
 *   - 9,3 stochastic %D dipped <25 then ticks up → entry
 *   Short "bear flag" = mirror (60,10 %D embedded <20, price < 200 EMA, rally to 20 EMA,
 *   9,3 %D spiked >75 then ticks down).
 * STOP: structural — pattern low/high over last 6 bars ± 0.1×ATR, capped 3×ATR.  TP: 2R.
 *
 * Modes:  --dry-run (DEFAULT) logs to kurisko_flag_signals.jsonl, places nothing.
 *         --live places real cTrader bracket orders (market + SL + TP).
 * Cadence: every 5 min via cron during 8-22 UTC. State prevents duplicate entries
 *          (one per symbol+dir+day). Honours the same kill-switch + symbol-block guards
 *          as orb_runner / inline_trader. Requires BROKER_PROVIDER=ctrader + CTRADER_*.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import os from 'os';

const IS_LINUX  = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX ? '/home/ubuntu/trading-data' : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const PARAMS_FILE = join(DATA_ROOT, 'trading_params.json');
const REJECT_FILE = join(DATA_ROOT, 'broker_rejects.json');
const STATE_FILE  = join(DATA_ROOT, 'kurisko_flag_state.json');
const SIGNALS_LOG = join(DATA_ROOT, 'kurisko_flag_signals.jsonl');

const LIVE = process.argv.includes('--live');   // default: dry-run

// ── Strategy config (from validate_2020flag_slice.mjs) ───────────────────────
const SYMBOLS         = ['XAUUSD', 'XAGUSD', 'NAS100', 'US30', 'SPX500']; // indices + metals
const SESSION_START_H = 8;     // active western session (UTC) — London open
const SESSION_END_H   = 22;    //                            → NY close
const TARGET_R        = 2.0;
const MAX_SL_ATR      = 3.0;   // cap absurd structural stops
const ATR_LEN         = 14;
const MAX_ENTRY_AGE_MIN = 20;  // don't act on a signal bar older than this

function log(m){ process.stdout.write(`[${new Date().toISOString()}] ${m}\n`); }
function loadParams(){ try { return JSON.parse(readFileSync(PARAMS_FILE,'utf8')); } catch { return {}; } }
function loadState(){ try { return JSON.parse(readFileSync(STATE_FILE,'utf8')); } catch { return {}; } }
function saveState(s){ writeFileSync(STATE_FILE, JSON.stringify(s,null,2)); }

function blockedSet(){
  const set = new Set();
  try { (loadParams().blockedSymbols||[]).forEach(s=>set.add(s)); } catch {}
  try { const r=JSON.parse(readFileSync(REJECT_FILE,'utf8')); const now=Date.now();
        for(const [s,rec] of Object.entries(r)) if(rec&&rec.until&&rec.until>now) set.add(s); } catch {}
  return set;
}

// ── indicators (identical to the validators) ─────────────────────────────────
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
    return d60[i]>80&&d60[i-1]>80&&d60[i-2]>80 && bars[i].c>pc.ema20[i]&&pc.ema20[i]>pc.ema50[i]
      && Math.min(bars[i].l,bars[i-1].l,bars[i-2].l)<=pc.ema20[i]+pc.atr[i]*0.4
      && Math.min(d9[i-1],d9[i-2],d9[i-3]||50)<25 && d9[i]>d9[i-1];
  } else {
    return d60[i]<20&&d60[i-1]<20&&d60[i-2]<20 && bars[i].c<pc.ema200[i]&&bars[i].c<pc.ema20[i]
      && Math.max(bars[i].h,bars[i-1].h,bars[i-2].h)>=pc.ema20[i]-pc.atr[i]*0.4
      && Math.max(d9[i-1],d9[i-2],d9[i-3]||50)>75 && d9[i]<d9[i-1];
  }
}
function structuralStop(bars,atr,i,dir){
  const buf=atr*0.10;let sl;
  if(dir==='long'){let lo=Infinity;for(let j=Math.max(0,i-6);j<=i;j++)if(bars[j].l<lo)lo=bars[j].l;sl=lo-buf;}
  else{let hi=-Infinity;for(let j=Math.max(0,i-6);j<=i;j++)if(bars[j].h>hi)hi=bars[j].h;sl=hi+buf;}
  const entry=bars[i].c;let risk=Math.abs(entry-sl);
  if(risk>atr*MAX_SL_ATR){risk=atr*MAX_SL_ATR;sl=dir==='long'?entry-risk:entry+risk;}
  return {sl,risk};
}

// ── Lot sizing — same formula as orb_runner / inline_trader (indices+metals only here) ──
function calcLots(symbol, riskPct, equity, entry, sl){
  const MIN_LOT=0.01, LOT_STEP=0.01, MAX_LOTS=10;
  const riskAmt=equity*(riskPct/100); const slDist=Math.abs(entry-sl);
  if(slDist===0) return MIN_LOT;
  const sym=symbol.toUpperCase();
  const q=lots=>Math.min(Math.max(Math.floor(lots/LOT_STEP)*LOT_STEP,MIN_LOT),MAX_LOTS);
  if(/XAU|GOLD/.test(sym)) return q(riskAmt/(100*slDist));
  if(/XAG|SILVER/.test(sym)) return q(riskAmt/(5000*slDist));
  if(/NAS100|NAS|NDX|NQ|US30|DOW|YM|SPX500|SPX|ES/.test(sym)) return q(riskAmt/slDist);
  return q(riskAmt/slDist);   // indices fallback (all symbols here are indices/metals)
}

async function main(){
  const now=new Date(), dow=now.getUTCDay(), hourUTC=now.getUTCHours(), nowMs=now.getTime();
  if(dow===0||dow===6){ log('Weekend — Kurisko flag idle.'); return; }
  log(`═══ KURISKO 20/20 FLAG RUNNER (${LIVE?'LIVE':'DRY-RUN'}) ═══`);
  if(hourUTC<SESSION_START_H || hourUTC>=SESSION_END_H){ log(`Outside active session ${SESSION_START_H}-${SESSION_END_H} UTC (now ${hourUTC}:xx) — idle.`); return; }

  const bridge=await import('./broker_ctrader.mjs');
  await bridge.connect();
  const params=loadParams();
  const riskPct=params.kuriskoFlagRiskPct ?? 1.0;       // reduced risk for in-sample-only strategy
  const blocked=blockedSet();
  const state=loadState();
  const today=now.toISOString().slice(0,10);

  let equity=10000;
  try{ const eq=await bridge.getEquity(); equity=eq.equity||eq.balance||equity; }catch(_){}

  // ── Per-day loss kill-switch (same source as orb_runner / inline_trader) ──
  if(LIVE){
    const MAX_DAILY_LOSS_PCT = params.kuriskoMaxDailyLossPct ?? 4;
    try{
      const todayPnl=await bridge.getTodayRealizedPnl();
      const ddPct=(todayPnl/Math.max(1,equity))*100;
      if(ddPct<=-MAX_DAILY_LOSS_PCT){ log(`🛑 KILL-SWITCH: today realised ${ddPct.toFixed(1)}% (limit -${MAX_DAILY_LOSS_PCT}%). No entries.`); saveState(state); process.exit(0); }
      log(`Kill-switch OK: today realised ${ddPct.toFixed(1)}% (limit -${MAX_DAILY_LOSS_PCT}%).`);
    }catch(e){ log(`⚠ kill-switch check FAILED (${e.message}) — proceeding WITHOUT it this tick`); }
  }

  for(const symbol of SYMBOLS){
    if(blocked.has(symbol)){ log(`  ${symbol}: blocked/untradable — skip`); continue; }

    let bars;
    try{ bars=await bridge.getTrendbars(symbol,{period:'M15',fromMs:nowMs-7*86400000,toMs:nowMs}); }
    catch(e){ log(`  ${symbol}: bars error — ${e.message}`); continue; }
    if(!bars||bars.length<260){ log(`  ${symbol}: only ${bars?.length||0} bars — skip`); continue; }
    bars.sort((a,b)=>a.t-b.t);

    // last CLOSED M15 bar (open time + 15min <= now)
    let i=bars.length-1;
    while(i>0 && bars[i].t+15*60*1000>nowMs) i--;
    const signalBar=bars[i];
    const ageMin=(nowMs-(signalBar.t+15*60*1000))/60000;
    if(ageMin>MAX_ENTRY_AGE_MIN){ continue; }   // stale data, don't act

    const pc=precompute(bars);

    for(const dir of ['long','short']){
      const key=`${today}:${symbol}:${dir}`;
      if(state[key]?.entered) continue;          // one shot per symbol+dir+day
      if(!flag2020(bars,pc,i,dir)) continue;

      const entry=signalBar.c;
      const {sl,risk}=structuralStop(bars,pc.atr[i],i,dir);
      if(!(risk>0)) continue;
      const tp=dir==='long'?entry+TARGET_R*risk:entry-TARGET_R*risk;
      const lots=calcLots(symbol,riskPct,equity,entry,sl);

      const signal={ ts:now.toISOString(), mode:LIVE?'live':'dry-run', strategy:'kurisko_2020_flag',
        symbol, dir, entry:+entry.toFixed(5), sl:+sl.toFixed(5), tp:+tp.toFixed(5),
        riskR:TARGET_R, lots, riskPct, equity:+equity.toFixed(2), sessionHourUTC:hourUTC };

      if(LIVE){
        try{
          const res=await bridge.placeOrder({ symbol, direction:dir, units:lots, entry:entry, tpPrice:tp, slPrice:sl });
          signal.placed=true; signal.positionId=res?.positionId??null;
          log(`  ✅ LIVE ${symbol} ${dir} ${lots}lots entry~${signal.entry} SL ${signal.sl} TP ${signal.tp}`);
        }catch(e){ signal.placed=false; signal.error=e.message; log(`  ✗ LIVE place failed ${symbol}: ${e.message}`); }
      } else {
        log(`  📝 DRY-RUN ${symbol} ${dir} ${lots}lots entry~${signal.entry} SL ${signal.sl} TP ${signal.tp} (risk ${riskPct}% = $${(equity*riskPct/100).toFixed(0)})`);
      }
      appendFileSync(SIGNALS_LOG, JSON.stringify(signal)+'\n');
      state[key]={ entered:true, ...signal };
    }
  }
  saveState(state);
  log('═══ KURISKO FLAG RUNNER done ═══');
  process.exit(0);
}
if(!existsSync(DATA_ROOT)) mkdirSync(DATA_ROOT,{recursive:true});
main().catch(e=>{ log(`FATAL: ${e.stack}`); process.exit(1); });
