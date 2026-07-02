/**
 * limit_vs_market.mjs — Does entering with a LIMIT at the level (S&R / OR boundary)
 * beat a MARKET entry at the breakout? Tests the user's idea: if you know the area
 * of interest, a limit there gets a better price / catches retests — but may MISS
 * trades that never pull back.
 *
 * Testbed = the validated ORB setups (clear, objective level = the OR boundary):
 *   MARKET : enter at the first close beyond the OR boundary (as orb_backtest).
 *   LIMIT  : after that breakout, rest a limit AT the boundary (the level). Fills
 *            only if a later bar trades back to it within the day; entry = boundary
 *            (better price). If price never retests → NO FILL (missed trade).
 * Both: SL = opposite OR boundary, TP = R×risk, hold → 20:00 UTC. Outcomes in R.
 *
 * Reports per config: market n/WR/expR/netR vs limit fill% / n/WR/expR/netR, the
 * avg entry improvement, and a few sample trades with entry/SL/TP for each.
 *
 * Usage (VM, env sourced): node scripts/trading/limit_vs_market.mjs --days=180
 */
import { getTrendbars, connect } from './broker_ctrader.mjs';

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const TF = 'M5', DAYS = parseInt(arg('days', '180'));
const OR_MIN = 30, BREAKOUT_H = 4, HOLD_UTC = 20;
const RETEST_MAX_H = 3;          // limit must fill within 3h of the breakout, else missed

const CONFIGS = [
  { sym: 'XAUUSD', open: '00:00', R: 2, label: 'Gold  Asia @2R' },
  { sym: 'US30',   open: '00:00', R: 2, label: 'US30  Asia @2R' },
  { sym: 'SPX500', open: '07:00', R: 2, label: 'SPX500 Lon @2R' },
  { sym: 'NAS100', open: '00:00', R: 1, label: 'NAS100 Asia @1R' },
];
const dayKey = ts => new Date(ts).toISOString().slice(0, 10);

function simulate(rawBars, openUTC, R) {
  const tfMin = parseInt(TF.slice(1), 10);
  const [oh, om] = openUTC.split(':').map(Number);
  const bars = rawBars.map(b => ({ ...b, t: b.t < 1e12 ? b.t * 1000 : b.t }));
  const byDay = new Map();
  for (const b of bars) { const d = dayKey(b.t); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(b); }
  const minOrBars = Math.max(2, Math.floor(OR_MIN / tfMin) - 1);
  const mkt = [], lim = [];             // trades: {r, entry, sl, tp}
  let breakouts = 0, limitFills = 0, entryImpSum = 0;

  for (const [dk, dayBars] of byDay) {
    const d = new Date(dk + 'T00:00:00.000Z');
    const sStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), oh, om);
    const orEnd = sStart + OR_MIN * 60000, boEnd = orEnd + BREAKOUT_H * 3600000;
    const holdEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), HOLD_UTC, 0);
    const orBars = dayBars.filter(b => b.t >= sStart && b.t < orEnd);
    if (orBars.length < minOrBars) continue;
    const orHigh = Math.max(...orBars.map(b => b.h)), orLow = Math.min(...orBars.map(b => b.l));
    if (!(orHigh > orLow)) continue;
    const post = dayBars.filter(b => b.t >= orEnd && b.t <= boEnd).sort((a, b) => a.t - b.t);
    let eb = null, dir = null, lvl = null, sl = null;
    for (const b of post) {
      if (b.c > orHigh) { eb = b; dir = 'long'; lvl = orHigh; sl = orLow; break; }
      if (b.c < orLow) { eb = b; dir = 'short'; lvl = orLow; sl = orHigh; break; }
    }
    if (!eb) continue;
    breakouts++;
    const risk = Math.abs(eb.c - sl);
    if (!(risk > 0)) continue;

    // ── MARKET: enter at breakout close ──
    const mEntry = eb.c, mTP = dir === 'long' ? mEntry + R * risk : mEntry - R * risk;
    mkt.push({ ...walk(dayBars, eb.t, holdEnd, dir, mEntry, sl, mTP, risk), entry: mEntry, sl, tp: mTP, t: eb.t });

    // ── LIMIT: rest at the boundary (level); fill if price returns within RETEST_MAX_H ──
    const retestEnd = eb.t + RETEST_MAX_H * 3600000;
    const after = dayBars.filter(b => b.t > eb.t && b.t <= Math.min(retestEnd, holdEnd)).sort((a, b) => a.t - b.t);
    let fillBar = null;
    for (const b of after) {
      if (dir === 'long' ? b.l <= lvl : b.h >= lvl) { fillBar = b; break; }   // price traded back to the level
    }
    if (fillBar) {
      limitFills++;
      const lEntry = lvl;                                   // filled AT the level (better than breakout close)
      const lRisk = Math.abs(lEntry - sl);
      const lTP = dir === 'long' ? lEntry + R * lRisk : lEntry - R * lRisk;
      entryImpSum += dir === 'long' ? (mEntry - lEntry) : (lEntry - mEntry);   // +ve = better entry
      lim.push({ ...walk(dayBars, fillBar.t, holdEnd, dir, lEntry, sl, lTP, lRisk), entry: lEntry, sl, tp: lTP, t: fillBar.t });
    }
  }
  return { mkt, lim, breakouts, limitFills, entryImp: limitFills ? entryImpSum / limitFills : 0 };
}

// walk forward from entry bar → SL/TP/hold-end, outcome in R (SL-first)
function walk(dayBars, entryT, holdEnd, dir, entry, sl, tp, risk) {
  const fwd = dayBars.filter(b => b.t > entryT && b.t <= holdEnd).sort((a, b) => a.t - b.t);
  for (const b of fwd) {
    const hitSL = dir === 'long' ? b.l <= sl : b.h >= sl;
    const hitTP = dir === 'long' ? b.h >= tp : b.l <= tp;
    if (hitSL) return { r: -1 };
    if (hitTP) return { r: (dir === 'long' ? (tp - entry) : (entry - tp)) / risk };
  }
  const last = fwd.length ? fwd[fwd.length - 1].c : entry;
  return { r: (dir === 'long' ? (last - entry) : (entry - last)) / risk };
}

function stat(trades) {
  const n = trades.length; if (!n) return { n: 0, wr: 0, expR: 0, netR: 0 };
  let w = 0, net = 0; for (const t of trades) { net += t.r; if (t.r > 0) w++; }
  return { n, wr: +(w / n * 100).toFixed(1), expR: +(net / n).toFixed(3), netR: +net.toFixed(2) };
}

async function main() {
  await connect();
  const fromMs = Date.now() - DAYS * 86400000;
  console.log(`\n═══ LIMIT (at level) vs MARKET (at breakout) — ORB, ${TF}, ${DAYS}d ═══`);
  console.log('MARKET = enter at breakout close | LIMIT = rest at the OR boundary, fill on retest within 3h (else MISSED)\n');
  const cache = {};
  for (const c of CONFIGS) {
    if (!cache[c.sym]) { try { cache[c.sym] = await getTrendbars(c.sym, { period: TF, fromMs, windowDays: 5 }); } catch (e) { console.log(`${c.label}: ${e.message}`); continue; } }
    const bars = cache[c.sym]; if (!bars || bars.length < 500) { console.log(`${c.label}: thin data`); continue; }
    const r = simulate(bars, c.open, c.R);
    const m = stat(r.mkt), l = stat(r.lim);
    const fillPct = r.breakouts ? (r.limitFills / r.breakouts * 100).toFixed(0) : 0;
    console.log(`■ ${c.label}   (${r.breakouts} breakouts)`);
    console.log(`   MARKET  n=${String(m.n).padStart(3)}  WR=${String(m.wr).padStart(4)}%  expR=${String(m.expR).padStart(6)}  netR=${String(m.netR).padStart(7)}`);
    console.log(`   LIMIT   n=${String(l.n).padStart(3)}  WR=${String(l.wr).padStart(4)}%  expR=${String(l.expR).padStart(6)}  netR=${String(l.netR).padStart(7)}  | fill ${fillPct}% (missed ${r.breakouts - r.limitFills}) | avg better entry ${r.entryImp >= 0 ? '+' : ''}${r.entryImp.toFixed(2)}`);
    const s = r.mkt[r.mkt.length - 1], sl = r.lim[r.lim.length - 1];
    if (s) console.log(`   e.g. MARKET entry ${s.entry} SL ${s.sl} TP ${s.tp} → ${s.r.toFixed(2)}R`);
    if (sl) console.log(`   e.g. LIMIT  entry ${sl.entry} SL ${sl.sl} TP ${sl.tp} → ${sl.r.toFixed(2)}R`);
    console.log('');
  }
  console.log('Verdict guide: LIMIT wins if its expR is clearly higher AND fill% is high enough that missed trades don\'t offset the edge.');
  process.exit(0);
}
main().catch(e => { console.error('FATAL:', e.stack); process.exit(1); });
