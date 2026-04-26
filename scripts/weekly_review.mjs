/**
 * weekly_review.mjs — Last-week trade audit
 *
 * For each major instrument × timeframe:
 *   1. Pull bars covering last week
 *   2. Filter to Sun 22:00 UTC → Fri 22:00 UTC
 *   3. Detect all signals (BOS-retest, EMA-stack, SmartTrail, etc.)
 *   4. Simulate virtual trades (SL=1.5×ATR, TP=3×ATR, 1:2 RR)
 *   5. Report: hits / misses / bad takes / good filters
 *
 * Run: DISPLAY=:1 nohup node scripts/weekly_review.mjs > /tmp/weekly_review.log 2>&1 &
 */
import { evaluate } from '../src/connection.js';
import { writeFileSync } from 'fs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Last week window ──
// Today is Friday 2026-04-24. Last week = Sun 2026-04-13 22:00 UTC → Fri 2026-04-18 22:00 UTC
const WEEK_START = new Date('2026-04-13T22:00:00Z').getTime() / 1000;
const WEEK_END   = new Date('2026-04-18T22:00:00Z').getTime() / 1000;

const INSTRUMENTS = [
  { sym: 'BLACKBULL:XAUUSD',  label: 'XAUUSD',  autoShort: true  },
  { sym: 'BLACKBULL:NAS100',  label: 'NAS100',  autoShort: false },
  { sym: 'BLACKBULL:BTCUSD',  label: 'BTCUSD',  autoShort: true  },
  { sym: 'BLACKBULL:GBPUSD',  label: 'GBPUSD',  autoShort: true  },
  { sym: 'BLACKBULL:EURUSD',  label: 'EURUSD',  autoShort: true  },
  { sym: 'BLACKBULL:US30',    label: 'US30',    autoShort: false },
  { sym: 'BLACKBULL:ETHUSD',  label: 'ETHUSD',  autoShort: true  },
  { sym: 'BLACKBULL:USDJPY',  label: 'USDJPY',  autoShort: true  },
  { sym: 'BLACKBULL:GBPJPY',  label: 'GBPJPY',  autoShort: true  },
  { sym: 'BLACKBULL:WTI',     label: 'WTI',     autoShort: true  },
];

// Timeframes to analyse (label → TradingView resolution string)
const TIMEFRAMES = [
  { tf: '15',  label: '15M' },
  { tf: '60',  label: 'H1'  },
  { tf: '240', label: 'H4'  },
  { tf: 'D',   label: 'D1'  },
];

// ── Indicators (copied from setup_finder) ──
function calcATR(bars, len = 14) {
  const atr = [];
  for (let i = 0; i < bars.length; i++) {
    const tr = i === 0 ? bars[i].h - bars[i].l
      : Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i-1].c), Math.abs(bars[i].l - bars[i-1].c));
    atr.push(i < len ? tr : (atr[i-1] * (len-1) + tr) / len);
  }
  return atr;
}

function calcEMA(bars, len) {
  const k = 2 / (len + 1);
  const ema = [];
  for (let i = 0; i < bars.length; i++)
    ema.push(i === 0 ? bars[i].c : bars[i].c * k + ema[i-1] * (1-k));
  return ema;
}

function calcRSI(bars, len = 14) {
  let ag = 0, al = 0;
  const rsi = new Array(bars.length).fill(50);
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].c - bars[i-1].c;
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= len) { ag += g/len; al += l/len; }
    else { ag = (ag*(len-1)+g)/len; al = (al*(len-1)+l)/len; }
    if (i >= len) rsi[i] = al === 0 ? 100 : 100 - 100/(1 + ag/al);
  }
  return rsi;
}

function calcSmartTrail(bars, len = 22, mult = 3.0) {
  const atr = calcATR(bars, len);
  const trail = [], dir = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < len) { trail.push(null); dir.push(1); continue; }
    const highs = bars.slice(Math.max(0,i-len+1), i+1).map(b=>b.h);
    const lows  = bars.slice(Math.max(0,i-len+1), i+1).map(b=>b.l);
    const upper = Math.max(...highs) - mult * atr[i];
    const lower = Math.min(...lows)  + mult * atr[i];
    if (!trail[i-1]) { trail.push(upper); dir.push(1); continue; }
    if (bars[i].c > trail[i-1]) { trail.push(Math.max(upper, trail[i-1])); dir.push(1); }
    else                        { trail.push(Math.min(lower, trail[i-1])); dir.push(-1); }
  }
  return { trail, dir };
}

// ── Signal detection: returns true/false for long/short entry at bar i ──
function detectSignals(bars, i) {
  if (i < 50) return { long: false, short: false, reasons: [] };
  const n    = i;
  const atr  = calcATR(bars.slice(0, n+1));
  const ema8 = calcEMA(bars.slice(0, n+1), 8);
  const ema21= calcEMA(bars.slice(0, n+1), 21);
  const ema50= calcEMA(bars.slice(0, n+1), 50);
  const rsi  = calcRSI(bars.slice(0, n+1));
  const st   = calcSmartTrail(bars.slice(0, n+1));
  const last = bars[n];
  const sl   = bars.slice(0, n+1);

  // EMA stack
  const emaLong  = ema8[n] > ema21[n] && ema21[n] > ema50[n];
  const emaShort = ema8[n] < ema21[n] && ema21[n] < ema50[n];

  // SmartTrail direction
  const stLong  = st.dir[n] === 1;
  const stShort = st.dir[n] === -1;

  // RSI zone
  const rsiOkLong  = rsi[n] >= 30 && rsi[n] <= 65;
  const rsiOkShort = rsi[n] >= 35 && rsi[n] <= 70;

  // BOS detection (pivot lookback=5)
  let lastPH = null, lastPL = null;
  for (let k = 5; k <= n - 5; k++) {
    let isPH = true, isPL = true;
    for (let d = 1; d <= 5; d++) {
      if (bars[k].h <= bars[k-d].h || bars[k].h <= bars[k+d].h) isPH = false;
      if (bars[k].l >= bars[k-d].l || bars[k].l >= bars[k+d].l) isPL = false;
    }
    if (isPH) lastPH = bars[k].h;
    if (isPL) lastPL = bars[k].l;
  }

  const bosBull = lastPH !== null && bars[n-1].c <= lastPH && bars[n].c > lastPH;
  const bosBear = lastPL !== null && bars[n-1].c >= lastPL && bars[n].c < lastPL;

  // Retest of BOS level (within 0.5×ATR)
  let retestLong = false, retestShort = false;
  if (lastPH !== null && Math.abs(last.c - lastPH) < atr[n] * 0.5 && last.c > lastPH * 0.998) retestLong = true;
  if (lastPL !== null && Math.abs(last.c - lastPL) < atr[n] * 0.5 && last.c < lastPL * 1.002) retestShort = true;

  // S/R (swing high/low proximity)
  const highs50 = sl.slice(-50).map(b=>b.h);
  const lows50  = sl.slice(-50).map(b=>b.l);
  const swH = Math.max(...highs50.slice(0,-3));
  const swL = Math.min(...lows50.slice(0,-3));
  const nearR = Math.abs(last.c - swH) / last.c < 0.004;
  const nearS = Math.abs(last.c - swL) / last.c < 0.004;

  const longScore  = (emaLong?1:0) + (stLong?1:0)  + (rsiOkLong?1:0)  + (retestLong?2:0)  + (nearS?1:0) + (bosBull?1:0);
  const shortScore = (emaShort?1:0)+ (stShort?1:0) + (rsiOkShort?1:0) + (retestShort?2:0) + (nearR?1:0) + (bosBear?1:0);

  const reasons = [];
  if (emaLong)    reasons.push('EMA↑');
  if (stLong)     reasons.push('ST↑');
  if (retestLong) reasons.push('BOS-retest↑');
  if (emaShort)   reasons.push('EMA↓');
  if (stShort)    reasons.push('ST↓');
  if (retestShort)reasons.push('BOS-retest↓');

  return {
    long:  longScore  >= 3,
    short: shortScore >= 3,
    longScore, shortScore,
    reasons,
    atr: atr[n],
    rsi: rsi[n],
  };
}

// ── Virtual trade outcome: given entry at bar[i], scan forward for SL/TP hit ──
function tradeOutcome(bars, entryIdx, dir, slMult=1.5, tpMult=3.0) {
  const atr  = calcATR(bars.slice(0, entryIdx+1));
  const entry = bars[entryIdx].c;
  const sl    = dir === 'long' ? entry - atr[entryIdx]*slMult : entry + atr[entryIdx]*slMult;
  const tp    = dir === 'long' ? entry + atr[entryIdx]*tpMult : entry - atr[entryIdx]*tpMult;
  const slDist = Math.abs(entry - sl);
  const maxBars = Math.min(bars.length - entryIdx - 1, 48); // max 48 bars forward

  for (let k = entryIdx+1; k <= entryIdx+maxBars; k++) {
    const b = bars[k];
    if (!b) break;
    const hitTP = dir === 'long' ? b.h >= tp : b.l <= tp;
    const hitSL = dir === 'long' ? b.l <= sl : b.h >= sl;
    if (hitTP) return { result: 'WIN',  pips: Math.round(slDist*tpMult*10000)/10000, bars: k-entryIdx, entry, sl, tp };
    if (hitSL) return { result: 'LOSS', pips: -Math.round(slDist*10000)/10000,        bars: k-entryIdx, entry, sl, tp };
  }
  return { result: 'OPEN', pips: Math.round((bars[Math.min(bars.length-1, entryIdx+maxBars)].c - entry)*(dir==='long'?1:-1)*10000)/10000, bars: maxBars, entry, sl, tp };
}

// ── Trend context: was instrument in a clear trend during the week? ──
function weekTrend(weekBars) {
  if (weekBars.length < 3) return 'flat';
  const open  = weekBars[0].o;
  const close = weekBars[weekBars.length-1].c;
  const high  = Math.max(...weekBars.map(b=>b.h));
  const low   = Math.min(...weekBars.map(b=>b.l));
  const range = high - low;
  const move  = close - open;
  const pct   = range > 0 ? Math.abs(move) / range : 0;
  if (pct > 0.5) return move > 0 ? 'strong-bull' : 'strong-bear';
  if (pct > 0.25) return move > 0 ? 'bull' : 'bear';
  return 'range';
}

async function setChart(sym, tf) {
  await evaluate(`(function(){
    var a = window.TradingViewApi._activeChartWidgetWV.value();
    a.setSymbol('${sym}', null, true);
    a.setResolution('${tf}');
  })()`);
  await sleep(2000);
}

async function getBars(count = 500) {
  return evaluate(`(function() {
    try {
      var bars = window.TradingViewApi._activeChartWidgetWV.value()
                   ._chartWidget.model().mainSeries().bars();
      if (!bars || typeof bars.lastIndex !== 'function') return null;
      var end   = bars.lastIndex();
      var start = Math.max(bars.firstIndex(), end - ${count} + 1);
      var result = [];
      for (var i = start; i <= end; i++) {
        var v = bars.valueAt(i);
        if (v) result.push({ t: v[0], o: v[1], h: v[2], l: v[3], c: v[4], v: v[5] || 0 });
      }
      return result.length > 10 ? result : null;
    } catch(e) { return null; }
  })()`);
}

function fmt(n, d=4) { return n == null ? 'n/a' : Number(n).toFixed(d); }
function pct(n) { return (n >= 0 ? '+' : '') + Number(n).toFixed(1) + '%'; }

// ── Main analysis ──
const report = [];
const allTrades = [];
const patterns = {};

report.push('═══════════════════════════════════════════════════════════════════');
report.push('  WEEKLY TRADE AUDIT — 2026-04-13 22:00 UTC → 2026-04-18 22:00 UTC');
report.push('═══════════════════════════════════════════════════════════════════');
report.push('');

for (const inst of INSTRUMENTS) {
  report.push(`\n┌── ${inst.label} ─────────────────────────────────────`);
  const instTrades = [];
  const instSummary = {};

  for (const { tf, label: tfLabel } of TIMEFRAMES) {
    await setChart(inst.sym, tf);
    const bars = await getBars(500);
    if (!bars || bars.length < 60) {
      report.push(`│  [${tfLabel}] no data`);
      continue;
    }

    const weekBars = bars.filter(b => b.t >= WEEK_START && b.t <= WEEK_END);
    if (weekBars.length < 3) {
      report.push(`│  [${tfLabel}] insufficient bars in window (${weekBars.length})`);
      continue;
    }

    const trend = weekTrend(weekBars);
    const weekHigh = Math.max(...weekBars.map(b=>b.h));
    const weekLow  = Math.min(...weekBars.map(b=>b.l));
    const weekOpen = weekBars[0].o;
    const weekClose= weekBars[weekBars.length-1].c;
    const weekMove = ((weekClose - weekOpen) / weekOpen * 100).toFixed(2);

    report.push(`│`);
    report.push(`│  [${tfLabel}] ${weekBars.length} bars | Trend: ${trend} | Move: ${weekMove}% | H:${fmt(weekHigh,2)} L:${fmt(weekLow,2)}`);

    // Only simulate trades on 15M and H1 (enough granularity, not too much noise)
    if (tf === '15' || tf === '60') {
      // Find all bars in the full dataset, then filter signal bars to week window
      const dirs = ['long', ...(inst.autoShort ? ['short'] : [])];
      let wins = 0, losses = 0, opens = 0;
      const signals = [];

      for (let i = 60; i < bars.length - 10; i++) {
        if (bars[i].t < WEEK_START || bars[i].t > WEEK_END) continue;
        const sig = detectSignals(bars, i);

        for (const dir of dirs) {
          if ((dir === 'long' && sig.long) || (dir === 'short' && sig.short)) {
            const outcome = tradeOutcome(bars, i, dir);
            const ts = new Date(bars[i].t * 1000).toISOString().replace('T',' ').substring(0,16);
            signals.push({ ts, dir, outcome, score: dir==='long'?sig.longScore:sig.shortScore, rsi: sig.rsi });
            if (outcome.result === 'WIN')  wins++;
            if (outcome.result === 'LOSS') losses++;
            if (outcome.result === 'OPEN') opens++;
            instTrades.push({ sym: inst.label, tf: tfLabel, dir, ...outcome, ts });
            allTrades.push({ sym: inst.label, tf: tfLabel, dir, ...outcome, ts, trend });
          }
        }
      }

      const total = wins + losses + opens;
      const wr = total > 0 ? Math.round(wins/total*1000)/10 : 0;
      report.push(`│  [${tfLabel}] Signals: ${total} | W:${wins} L:${losses} Open:${opens} | WR: ${wr}%`);

      if (signals.length > 0) {
        report.push(`│  [${tfLabel}] Trades:`);
        for (const s of signals.slice(0, 12)) {
          const icon = s.outcome.result === 'WIN' ? '✅' : s.outcome.result === 'LOSS' ? '❌' : '⏳';
          report.push(`│    ${icon} ${s.ts} ${s.dir.toUpperCase()} | ${s.outcome.result} in ${s.outcome.bars}bars | entry:${fmt(s.outcome.entry,2)} sl:${fmt(s.outcome.sl,2)} tp:${fmt(s.outcome.tp,2)} | RSI:${Math.round(s.rsi)}`);
        }
      }

      // Pattern: note if trend aligned with EMA
      instSummary[tfLabel] = { trend, total, wins, losses, wr };
    } else {
      // For H4 and D1: just describe the context (trend, key levels)
      const ema21 = calcEMA(weekBars, Math.min(21, weekBars.length-1));
      const ctx = weekClose > ema21[ema21.length-1] ? 'above EMA21 (bullish)' : 'below EMA21 (bearish)';
      report.push(`│  [${tfLabel}] Price: ${ctx} | Week range: ${fmt(weekHigh-weekLow,2)} pts`);
    }
  }

  // Instrument summary
  report.push(`│`);
  report.push(`│  SUMMARY for ${inst.label}:`);
  for (const [tfLabel, s] of Object.entries(instSummary)) {
    report.push(`│    ${tfLabel}: ${s.trend} | ${s.total} signals | WR ${s.wr}% (${s.wins}W/${s.losses}L)`);
  }

  // Missed big moves: was there a 3×ATR+ move with no signal at the start?
  try {
    await setChart(inst.sym, '60');
    const h1bars = await getBars(300);
    if (h1bars) {
      const wb = h1bars.filter(b => b.t >= WEEK_START && b.t <= WEEK_END);
      if (wb.length >= 5) {
        const atrVals = calcATR(h1bars);
        const atrAtStart = atrVals[h1bars.findIndex(b => b.t >= WEEK_START)] || 1;
        // Find biggest single-direction runs
        let maxBullRun = 0, maxBearRun = 0, maxBullStart = null, maxBearStart = null;
        for (let i = 1; i < wb.length - 3; i++) {
          const run3 = wb[i+2].h - wb[i].l;  // bull run
          const bear3 = wb[i].h - wb[i+2].l; // bear run
          if (run3 > maxBullRun) { maxBullRun = run3; maxBullStart = new Date(wb[i].t*1000).toISOString().substring(0,16); }
          if (bear3 > maxBearRun) { maxBearRun = bear3; maxBearStart = new Date(wb[i].t*1000).toISOString().substring(0,16); }
        }
        if (maxBullRun > atrAtStart * 3) report.push(`│  📈 Biggest bull run: ${fmt(maxBullRun,2)} (${(maxBullRun/atrAtStart).toFixed(1)}×ATR) starting ~${maxBullStart}`);
        if (maxBearRun > atrAtStart * 3) report.push(`│  📉 Biggest bear run: ${fmt(maxBearRun,2)} (${(maxBearRun/atrAtStart).toFixed(1)}×ATR) starting ~${maxBearStart}`);
      }
    }
  } catch(_) {}

  report.push(`└─────────────────────────────────────────────────`);
}

// ── Global summary ──
report.push('\n\n═══════════════════════════════════════════════════');
report.push('  GLOBAL WEEKLY SUMMARY');
report.push('═══════════════════════════════════════════════════');

const bySymbol = {};
for (const t of allTrades) {
  const k = `${t.sym}/${t.tf}`;
  if (!bySymbol[k]) bySymbol[k] = { wins:0, losses:0, opens:0, pips:0 };
  const b = bySymbol[k];
  if (t.result === 'WIN')  { b.wins++;  b.pips += t.pips; }
  if (t.result === 'LOSS') { b.losses++; b.pips += t.pips; }
  if (t.result === 'OPEN') { b.opens++; b.pips += t.pips; }
}

let globalW=0, globalL=0, globalPips=0;
for (const [k, s] of Object.entries(bySymbol).sort((a,b)=>(b[1].wins-b[1].losses)-(a[1].wins-a[1].losses))) {
  const tot = s.wins + s.losses + s.opens;
  const wr = tot > 0 ? Math.round(s.wins/tot*1000)/10 : 0;
  const sign = s.pips >= 0 ? '+' : '';
  report.push(`  ${k.padEnd(14)} | ${tot} signals | WR:${String(wr+'%').padStart(6)} | P&L: ${sign}${fmt(s.pips,2)} pts`);
  globalW += s.wins; globalL += s.losses; globalPips += s.pips;
}
const globalTot = globalW + globalL;
const globalWR  = globalTot > 0 ? Math.round(globalW/globalTot*1000)/10 : 0;
report.push('');
report.push(`  TOTAL: ${globalTot} signals | WR: ${globalWR}% | Net: ${globalPips>=0?'+':''}${fmt(globalPips,2)} pts`);

// ── Pattern insights ──
report.push('\n\n═══════════════════════════════════════════════════');
report.push('  PATTERN INSIGHTS');
report.push('═══════════════════════════════════════════════════');

// Best performing instrument+TF combos
const sorted = Object.entries(bySymbol).sort((a,b) => {
  const wrA = (a[1].wins/(a[1].wins+a[1].losses||1));
  const wrB = (b[1].wins/(b[1].wins+b[1].losses||1));
  return wrB - wrA;
}).filter(([k,s]) => (s.wins+s.losses) >= 2);

if (sorted.length) {
  report.push('  Best WR combinations this week:');
  for (const [k, s] of sorted.slice(0, 5)) {
    const tot = s.wins+s.losses;
    report.push(`    ${k}: ${Math.round(s.wins/tot*100)}% WR (${s.wins}/${tot})`);
  }
  report.push('  Worst WR combinations:');
  for (const [k, s] of sorted.slice(-3)) {
    const tot = s.wins+s.losses;
    if (tot >= 2) report.push(`    ${k}: ${Math.round(s.wins/tot*100)}% WR (${s.wins}/${tot})`);
  }
}

// Trend vs win rate
const trendStats = {};
for (const t of allTrades) {
  const key = t.trend || 'unknown';
  if (!trendStats[key]) trendStats[key] = { wins:0, total:0 };
  if (t.result !== 'OPEN') {
    trendStats[key].total++;
    if (t.result === 'WIN') trendStats[key].wins++;
  }
}
report.push('\n  WR by weekly trend context:');
for (const [trend, s] of Object.entries(trendStats)) {
  const wr = s.total > 0 ? Math.round(s.wins/s.total*100) : 0;
  report.push(`    ${trend.padEnd(14)}: ${wr}% WR (${s.wins}/${s.total})`);
}

report.push('\n\n  RECOMMENDED ACTIONS:');
if (sorted.length) {
  const best = sorted.slice(0,3).map(([k])=>k);
  report.push(`  → Prioritise: ${best.join(', ')}`);
}
const bullTrades = allTrades.filter(t=>t.dir==='long'&&t.result!=='OPEN');
const bearTrades = allTrades.filter(t=>t.dir==='short'&&t.result!=='OPEN');
const bullWR = bullTrades.length ? Math.round(bullTrades.filter(t=>t.result==='WIN').length/bullTrades.length*100) : 0;
const bearWR = bearTrades.length ? Math.round(bearTrades.filter(t=>t.result==='WIN').length/bearTrades.length*100) : 0;
report.push(`  → Long WR: ${bullWR}% (${bullTrades.length} trades) | Short WR: ${bearWR}% (${bearTrades.length} trades)`);
if (bullWR > bearWR + 10) report.push('  → This week favoured LONGS strongly — consider raising bar for shorts');
if (bearWR > bullWR + 10) report.push('  → This week favoured SHORTS strongly — consider raising bar for longs');

report.push('\n═══════════════════════════════════════════════════\n');

const output = report.join('\n');
console.log(output);
writeFileSync('/tmp/weekly_review.txt', output);
writeFileSync('/tmp/weekly_review_trades.json', JSON.stringify(allTrades, null, 2));
console.log('\nReport saved to /tmp/weekly_review.txt');
console.log('Raw trades saved to /tmp/weekly_review_trades.json');
