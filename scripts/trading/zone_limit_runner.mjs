/**
 * zone_limit_runner.mjs — Proactive S&R zone LIMIT runner (DRY-RUN by default).
 *
 * Implements the reversal_sr_backtest-validated edge (PF 1.18, +703R net, robust
 * OOS): rest a LIMIT at each active S&R zone near price BEFORE the touch, and
 * MANAGE the resting orders:
 *   • PLACE : nearest active support→BUY LIMIT / resistance→SELL LIMIT within
 *             reachATR of price (and ≥ minDistATR away, so it isn't an instant
 *             fill). One per (symbol,direction); capped at maxTotal overall.
 *   • CANCEL: when the zone BREAKS (a close beyond it), the order goes STALE
 *             (> staleH), price runs > reachATR away, or the symbol already has
 *             an open position (anti-stack).
 *   entry = zone edge, SL = far side − buf·ATR, TP = R × risk.
 *
 * Modes: (default) DRY-RUN — logs PLACE/CANCEL it WOULD do to zone_limit_runner.log
 *        + state in zone_limit_state.json; places nothing. --live — real cTrader
 *        limit orders via placeOrder({limitPrice}) + cancelOrder. Run --live only
 *        after watching the dry-run log for a few days.
 *
 * Usage (VM): node scripts/trading/zone_limit_runner.mjs   [--live]
 */
import { getTrendbars, connect, placeOrder, cancelOrder, getPositions, getOpenVolumeForSymbol, getEquity, getSymbolNameById } from './broker_ctrader.mjs';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const LIVE = process.argv.includes('--live');
const STATE = '/home/ubuntu/trading-data/zone_limit_state.json';
const LOG   = '/home/ubuntu/trading-data/zone_limit_runner.log';
const CFG = { reachATR: 3, minDistATR: 0.3, maxTotal: 6, buf: 0.5, R: 2, staleH: 48, riskPct: 0.5 };
const SYMS = ['XAUUSD', 'EURUSD', 'GBPJPY', 'US30', 'NAS100', 'USDJPY', 'BTCUSD', 'GBPUSD', 'AUDUSD', 'SPX500'];
const TF = 'H1';

function log(m) { const line = `[${new Date().toISOString()}] ${m}`; process.stdout.write(line + '\n'); }
const load = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return { orders: {} }; } };
const save = s => writeFileSync(STATE, JSON.stringify(s, null, 2));
const rnd = (x, p) => Math.round(x * p) / p;
const prec = px => px > 1000 ? 100 : px > 10 ? 1000 : 100000;

function atr14(bars){ const o=new Array(bars.length).fill(null); let pc=null,a=null; const t=[];
  for(let i=0;i<bars.length;i++){ const b=bars[i]; const tr=pc==null?b.h-b.l:Math.max(b.h-b.l,Math.abs(b.h-pc),Math.abs(b.l-pc)); pc=b.c;
    if(i<14){t.push(tr); if(i===13){a=t.reduce((s,x)=>s+x,0)/14;o[i]=a;}} else {a=(a*13+tr)/14;o[i]=a;} } return o; }
function piv(bars,i,len,hi){ const c=i-len; if(c<len)return null; const cv=hi?bars[c].h:bars[c].l;
  for(let k=1;k<=len;k++){ if(hi?!(cv>bars[c-k].h&&cv>bars[c+k].h):!(cv<bars[c-k].l&&cv<bars[c+k].l))return null; } return {c,cv}; }
function activeZones(bars){ const n=bars.length,O=i=>bars[i].o,C=i=>bars[i].c,P={pivLen:5,maxZones:8};
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
function calcLots(sym, riskPct, equity, entry, sl){ const MIN=0.01,STEP=0.01,MAX=10; const riskAmt=equity*riskPct/100, slDist=Math.abs(entry-sl); if(slDist<=0)return MIN;
  const s=sym.toUpperCase(), q=l=>Math.min(Math.max(Math.floor(l/STEP)*STEP,MIN),MAX);
  if(/XAU|GOLD/.test(s)) return q(riskAmt/(100*slDist));
  if(/US30|NAS100|SPX500|GER|UK100|JP225|AUS200|DOW/.test(s)) return q(riskAmt/slDist);
  if(/BTC|ETH|SOL|ADA|XRP|LTC|BNB/.test(s)) return q(riskAmt/slDist);
  if(/JPY/.test(s)) return q(riskAmt/(6.5*(slDist/0.01)));
  return q(riskAmt/(10*(slDist/0.0001))); }

async function main(){
  await connect();
  const state = load(); if (!state.orders) state.orders = {};
  let equity = 10000; try { const e = await getEquity(); equity = e.equity || e.balance || equity; } catch {}
  // open positions per symbol name (anti-stack)
  const openVol = {}; for (const s of SYMS) { try { openVol[s] = await getOpenVolumeForSymbol(s).catch(() => 0); } catch { openVol[s] = 0; } }
  const bars = {}; for (const s of SYMS) { try { bars[s] = await getTrendbars(s, { period: TF, fromMs: Date.now() - 60 * 86400000, windowDays: 20 }); } catch { bars[s] = null; } }

  log(`═══ ZONE-LIMIT RUNNER (${LIVE ? 'LIVE' : 'DRY-RUN'}) equity ${rnd(equity,100)} ═══`);

  // ── 1. CANCEL pass ──
  for (const [key, o] of Object.entries(state.orders)) {
    const b = bars[o.sym]; if (!b || !b.length) continue;
    const px = b[b.length - 1].c;
    const broken = o.dir === 'long' ? px < o.zoneLo : px > o.zoneHi;    // a close beyond the zone
    const a = (atr14(b).slice(-1)[0]) || 0;
    const far = a > 0 && Math.abs(px - o.entry) > CFG.reachATR * a;
    const stale = Date.now() - o.placedTs > CFG.staleH * 3600e3;
    const hasPos = (openVol[o.sym] || 0) > 0;
    if (broken || far || stale || hasPos) {
      const why = broken ? 'zone-broken' : far ? 'price-ran-away' : stale ? 'stale' : 'position-open';
      log(`  CANCEL ${o.sym} ${o.dir} LIMIT @${o.entry} (${why})`);
      if (LIVE && o.orderId) { try { await cancelOrder(o.orderId); } catch (e) { log(`   cancel err ${e.message}`); } }
      delete state.orders[key];
    }
  }

  // ── 2. PLACE pass ──
  let total = Object.keys(state.orders).length;
  for (const sym of SYMS) {
    if (total >= CFG.maxTotal) break;
    const b = bars[sym]; if (!b || b.length < 200) continue;
    if ((openVol[sym] || 0) > 0) continue;                 // anti-stack
    const atr = atr14(b), a = atr[atr.length - 1] || 0, px = b[b.length - 1].c; if (a <= 0) continue;
    const z = activeZones(b), p = prec(px);
    // nearest support below / resistance above, within reach and not an instant fill
    const supCand = z.sup.filter(x => x.hi < px && (px - x.hi) <= CFG.reachATR * a && (px - x.hi) >= CFG.minDistATR * a).sort((x, y) => y.hi - x.hi)[0];
    const resCand = z.res.filter(x => x.lo > px && (x.lo - px) <= CFG.reachATR * a && (x.lo - px) >= CFG.minDistATR * a).sort((x, y) => x.lo - y.lo)[0];
    for (const [cand, dir] of [[supCand, 'long'], [resCand, 'short']]) {
      if (!cand || total >= CFG.maxTotal) continue;
      const key = `${sym}:${dir}`;
      if (state.orders[key]) continue;                     // already resting for this symbol+dir
      const entry = dir === 'long' ? cand.hi : cand.lo;
      const sl = dir === 'long' ? cand.lo - CFG.buf * a : cand.hi + CFG.buf * a;
      const risk = Math.abs(entry - sl); if (risk <= 0) continue;
      const tp = dir === 'long' ? entry + CFG.R * risk : entry - CFG.R * risk;
      const lots = calcLots(sym, CFG.riskPct, equity, entry, sl);
      const rec = { sym, dir, zoneLo: cand.lo, zoneHi: cand.hi, entry: rnd(entry, p), sl: rnd(sl, p), tp: rnd(tp, p), lots, placedTs: Date.now(), orderId: null };
      log(`  PLACE ${sym} ${dir.toUpperCase()} LIMIT @${rec.entry} SL ${rec.sl} TP ${rec.tp} ${lots}lots (${rnd((dir==='long'?px-entry:entry-px)/a,10)}·ATR away)`);
      if (LIVE) { try { const res = await placeOrder({ symbol: sym, direction: dir, units: lots, tpPrice: tp, slPrice: sl, limitPrice: entry }); rec.orderId = Number(res?.order?.orderId) || null; } catch (e) { log(`   place err ${e.message}`); continue; } }
      state.orders[key] = rec; total++;
    }
  }
  save(state);
  log(`═══ done: ${total} resting limit(s) (${LIVE ? 'LIVE' : 'dry-run'}) ═══`);
  process.exit(0);
}
main().catch(e => { log(`FATAL: ${e.stack}`); process.exit(1); });
