/**
 * orb_preview.mjs — replays the EXACT orb_runner pairings + rules over the last
 * N days and lists every trade it would have taken, with outcome. A concrete
 * preview of what the dry-run produces (the live dry-run only logs going forward).
 *
 * Usage: node scripts/trading/orb_preview.mjs --days=10
 */
const DAYS = parseInt((process.argv.find(a => a.startsWith('--days=')) || '').split('=')[1]) || 10;

// MUST match orb_runner.mjs
const OR_MIN = 30, BRK_H = 4, TARGET_R = 2, HOLD_UTC = 20, MIN_OR_BARS = 4;
const PAIRINGS = [
  { session: 'ASIA',   openUTC: '00:00', symbols: ['XAUUSD'] },
  { session: 'LONDON', openUTC: '07:00', symbols: ['WTI', 'SPX500', 'US30', 'AUDUSD', 'NZDUSD', 'AUDJPY', 'GBPJPY'] },
  { session: 'NY',     openUTC: '13:30', symbols: ['AUDJPY'] },
];
const day = ms => new Date(ms).toISOString().slice(0, 10);
const hhmm = ms => new Date(ms).toISOString().slice(11, 16);

function simDay(bars, openUTC, dayStr) {
  const [oh, om] = openUTC.split(':').map(Number);
  const d = new Date(dayStr + 'T00:00:00Z');
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), oh, om);
  const orEnd = start + OR_MIN * 60000, brkEnd = orEnd + BRK_H * 3600000;
  const hold = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), HOLD_UTC, 0);

  const orBars = bars.filter(b => b.t >= start && b.t < orEnd);
  if (orBars.length < MIN_OR_BARS) return null;
  const orHigh = Math.max(...orBars.map(b => b.h)), orLow = Math.min(...orBars.map(b => b.l));
  if (!(orHigh > orLow)) return null;

  const post = bars.filter(b => b.t >= orEnd && b.t <= brkEnd).sort((a, b) => a.t - b.t);
  let e = null, dir = null;
  for (const b of post) { if (b.c > orHigh) { e = b; dir = 'long'; break; } if (b.c < orLow) { e = b; dir = 'short'; break; } }
  if (!e) return null;

  const entry = e.c, sl = dir === 'long' ? orLow : orHigh, risk = Math.abs(entry - sl);
  if (!(risk > 0)) return null;
  const tp = dir === 'long' ? entry + TARGET_R * risk : entry - TARGET_R * risk;
  const fwd = bars.filter(b => b.t > e.t && b.t <= hold).sort((a, b) => a.t - b.t);
  let outR = null, exit = 'open@close';
  for (const b of fwd) {
    const hitSL = dir === 'long' ? b.l <= sl : b.h >= sl;
    const hitTP = dir === 'long' ? b.h >= tp : b.l <= tp;
    if (hitSL) { outR = -1; exit = 'SL'; break; }
    if (hitTP) { outR = TARGET_R; exit = 'TP'; break; }
  }
  if (outR === null) { const last = fwd.length ? fwd[fwd.length-1].c : entry; outR = (dir==='long'?(last-entry):(entry-last))/risk; }
  return { entryT: e.t, dir, entry, sl, tp, orHigh, orLow, outR, exit };
}

async function main() {
  const b = await import('./broker_ctrader.mjs');
  await b.connect();
  const eq = await b.getEquity().catch(() => ({}));
  const equity = eq.balance || 10000;
  const riskPct = 2; // matches rebuilt riskPct[0]
  const toMs = Date.now(), fromMs = toMs - (DAYS + 2) * 864e5;

  const syms = [...new Set(PAIRINGS.flatMap(p => p.symbols))];
  const barsBySym = {};
  for (const s of syms) { try { barsBySym[s] = await b.getTrendbars(s, { period:'M5', fromMs, toMs }); } catch (e) { barsBySym[s] = []; } }

  const days = [...Array(DAYS)].map((_, i) => day(toMs - i * 864e5)).reverse();
  const trades = [];
  for (const p of PAIRINGS) for (const sym of p.symbols) for (const ds of days) {
    const r = simDay(barsBySym[sym] || [], p.openUTC, ds);
    if (r) trades.push({ date: ds, session: p.session, sym, ...r });
  }
  trades.sort((a, b2) => a.entryT - b2.entryT);

  console.log(`\n=== ORB DRY-RUN PREVIEW — last ${DAYS} days, exact runner pairings + rules ===`);
  console.log(`equity $${equity.toFixed(0)}, risk ${riskPct}%/trade (~$${(equity*riskPct/100).toFixed(0)} risked, +2R win ≈ +$${(equity*riskPct/100*2).toFixed(0)})\n`);
  console.log('Date       Sess   Symbol  Dir   Entry      SL         TP         Exit  R');
  console.log('---------- ------ ------- ----- ---------- ---------- ---------- ----- -----');
  let sumR = 0, w = 0, l = 0;
  for (const t of trades) {
    sumR += t.outR; if (t.outR > 0) w++; else if (t.outR < 0) l++;
    const f = n => n.toFixed(n < 10 ? 5 : n < 1000 ? 3 : 2);
    console.log(`${t.date} ${t.session.padEnd(6)} ${t.sym.padEnd(7)} ${t.dir.padEnd(5)} ${f(t.entry).padStart(10)} ${f(t.sl).padStart(10)} ${f(t.tp).padStart(10)} ${t.exit.padEnd(5)} ${t.outR.toFixed(2).padStart(5)}`);
  }
  const riskAmt = equity * riskPct / 100;
  console.log('---------- ------ ------- ----- ---------- ---------- ---------- ----- -----');
  console.log(`\n${trades.length} trades | ${w}W / ${l}L | net ${sumR.toFixed(2)}R ≈ ${(sumR*riskAmt>=0?'+$':'-$')}${Math.abs(sumR*riskAmt).toFixed(0)} | avg ${(trades.length?sumR/trades.length:0).toFixed(3)}R/trade`);
  console.log('(Outcomes assume SL-first if a bar straddles both. No spread/commission modeled.)');
  process.exit(0);
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
