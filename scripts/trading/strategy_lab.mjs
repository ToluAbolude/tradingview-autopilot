/**
 * strategy_lab.mjs — which strategy actually makes money on each instrument?
 *
 * Runs every strategy we can execute as code — the plug-in manifests
 * (scripts/trading/strategies/), the modules in confirm/strategies/ that no manifest
 * uses, and every Chart Fanatics detector in cfs/ — over cTrader history for each
 * instrument, re-brackets each one across a small stop/target grid, and scores it in
 * MONEY.
 *
 * THE RULE THAT KEEPS THIS HONEST
 * ~76 entrants x 12 stop/target variants x 8 instruments is ~7,300 lottery tickets;
 * something will look brilliant by luck. So every choice is made on the IN-SAMPLE
 * period only (the first 60% of the calendar) and judged ONCE on the out-of-sample
 * period it never saw. The OOS result of the in-sample winner is the only number
 * that counts, and the promotion bar below is fixed before any result is seen.
 *
 * Money = R x intended risk ($100 = 1% of $10k by default). That assumes sizing that
 * actually hits the intended risk; calcLots does not yet for oil, platinum and small
 * crypto (memory: calclots-sizing-distortion), none of which are core instruments.
 *
 * Replay: a manifest module is called bar by bar on the same trailing window the live
 * strategy_runner fetches (history_days), and only a signal stamped on the latest bar
 * is acted on — the live contract exactly, so there is no lookahead whatever the
 * module does internally. cfs detectors are causal by contract and run in one pass.
 * Simulation, costs and SL-first ordering are cfs_backtest's, shared, not copied.
 *
 * Not replayable, and reported as such: the news_recent filter (no historical
 * calendar), and the scanner account's daily plan (written each morning by an LLM
 * analyst). The Chart Fanatics strategies needing stock, options, VIX or order-flow
 * data are not in cfs/ at all (strategies/chart_fanatics/CATALOG.md).
 *
 * Usage (VM, scanner env loaded — it only reads bars, it never trades):
 *   node scripts/trading/strategy_lab.mjs
 *   node scripts/trading/strategy_lab.mjs --only=cfs: --sym=XAUUSD,NAS100
 *   node scripts/trading/strategy_lab.mjs --selftest
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import assert from 'node:assert/strict';
import { simulate, statsFrom, atr14, SPREADS } from './cfs_backtest.mjs';
import { loadStrategies, TIMEFRAMES } from './lib/strategies.mjs';
import { CORE_UNIVERSE, instrumentClass } from './lib/instruments.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg  = (k, d) => { const a = argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const SYMS     = arg('sym', CORE_UNIVERSE.join(',')).split(',');
const ONLY     = arg('only', '').split(',').filter(Boolean);
const EQUITY   = parseFloat(arg('equity', '10000'));
const RISK_PCT = parseFloat(arg('risk-pct', '1'));
const IS_FRAC  = parseFloat(arg('is-frac', '0.6'));
const MAX_SEC  = parseFloat(arg('max-sec', '420'));     // per module x instrument replay
const RISK_USD = EQUITY * RISK_PCT / 100;
const SLIP     = 0.02;                                  // x ATR, cfs_backtest's default
const OUT_DIR  = existsSync('/home/ubuntu/trading-data') ? '/home/ubuntu/trading-data' : join(HERE, '..', '..', 'data');

// History the broker serves per period (CATALOG.md) and the paging window cfs uses.
const YEARS = { M5: 0.5, M15: 1, M30: 1, H1: 3, H4: 5, D1: 5 };
const PAGE  = { M5: 8, M15: 8, M30: 12, H1: 20, H4: 60, D1: 60 };

// Stop/target grid. 'own' = the strategy's own target. Small on purpose: every extra
// variant is one more chance for luck to win the in-sample round.
const STOP_MULTS = [1, 1.5];
const TARGETS    = ['own', 1, 1.5, 2, 3, 4];

// Promotion bar, fixed before seeing results. Money-first, plus the two checks that
// separate a real edge from luck: enough trades, and profit that survives losing the
// three best trades.
const BAR = { minIsN: 15, minOosN: 20, maxOosDdR: 20 };

const SESSIONS = { ASIA: '00:00', LONDON: '07:00', NY: '13:30' };

/**
 * Re-bracket a signal: stop k x its distance from entry, target r x the NEW risk, or
 * the strategy's own target price. Null if the result is not a valid trade.
 */
export function variant(sig, k, target) {
  const ref  = sig.limit ?? sig.entry;
  const base = Math.abs(ref - sig.stop);
  if (!(base > 0)) return null;
  const long = sig.dir === 'long';
  const risk = k * base;
  const stop = long ? ref - risk : ref + risk;
  const tp   = target === 'own' ? (sig.tp ?? null) : (long ? ref + target * risk : ref - target * risk);
  if (tp != null && (long ? tp <= ref : tp >= ref)) return null;
  return { ...sig, stop, tp };
}

if (argv.includes('--selftest')) {
  const s = { i: 0, dir: 'long', entry: 100, stop: 98, tp: 104 };
  assert.deepEqual([variant(s, 1, 2).stop, variant(s, 1, 2).tp], [98, 104]);
  assert.deepEqual([variant(s, 1.5, 2).stop, variant(s, 1.5, 2).tp], [97, 106]);   // 2R of the WIDER stop
  assert.deepEqual([variant(s, 1.5, 'own').stop, variant(s, 1.5, 'own').tp], [97, 104]);
  const sh = variant({ dir: 'short', entry: 100, stop: 102, tp: 96 }, 1, 3);
  assert.deepEqual([sh.stop, sh.tp], [102, 94]);
  assert.equal(variant({ dir: 'long', entry: 100, stop: 98, tp: 99 }, 1, 'own'), null);
  assert.equal(variant({ dir: 'long', entry: 100, stop: 100 }, 1, 2), null);
  const lim = variant({ dir: 'short', limit: 50, stop: 51, tp: 48 }, 1, 2);        // limit orders re-bracket off the limit
  assert.deepEqual([lim.stop, lim.tp], [51, 48]);
  console.log('selftest OK');
  process.exit(0);
}

const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] || 0; };
const usd    = r => `${r < 0 ? '-' : '+'}$${Math.abs(r * RISK_USD).toFixed(0)}`;

// ── Bars, cached so a re-run costs no broker calls ───────────────────────────
let bridge = null;
async function loadBars(sym, period) {
  const fromMs = Date.now() - YEARS[period] * 365 * 864e5;
  const cache  = `/tmp/lab_${sym}_${period}.json`;
  if (existsSync(cache) && Date.now() - statSync(cache).mtimeMs < 12 * 36e5) {
    try { const c = JSON.parse(readFileSync(cache, 'utf8')); if (c.fromMs <= fromMs + 864e5 && c.bars?.length) return c.bars; } catch {}
  }
  if (!bridge) { bridge = await import('./broker_ctrader.mjs'); await bridge.connect(); }
  const bars = await bridge.getTrendbars(sym, { period, fromMs, windowDays: PAGE[period] });
  try { writeFileSync(cache, JSON.stringify({ fromMs, bars })); } catch {}
  return bars;
}

// ── Entrants ─────────────────────────────────────────────────────────────────
async function entrants() {
  const list = [], skipped = [];
  const { strategies, errors } = await loadStrategies();
  for (const e of errors) skipped.push(`m:${e.id} — ${e.errors.join('; ')}`);
  const used = new Set();
  for (const { manifest: m, logic } of strategies) {
    used.add(m.logic.module ?? m.logic.file);
    const filters = m.filters || [];
    if (filters.includes('news_recent')) { skipped.push(`m:${m.id} — news_recent needs a historical news calendar`); continue; }
    list.push({ name: `m:${m.id}`, kind: 'module', logic, tf: m.timeframe, period: TIMEFRAMES[m.timeframe].period,
                params: m.params || {}, historyDays: m.history_days ?? 20, filters, targetR: m.target?.r ?? 2 });
  }
  for (const f of readdirSync(join(HERE, 'confirm', 'strategies')).filter(f => f.endsWith('.mjs'))) {
    const id = f.replace(/\.mjs$/, '');
    // scanner_confluence needs eight timeframes at once plus the daily plan that gates it live.
    if (used.has(id) || id === 'scanner_confluence') continue;
    const logic = (await import(pathToFileURL(join(HERE, 'confirm', 'strategies', f)).href)).default;
    if (typeof logic?.generateSignals !== 'function') continue;
    const tf = (logic.timeframes || ['60']).find(t => t in TIMEFRAMES) || '60';
    list.push({ name: `mod:${id}`, kind: 'module', logic, tf, period: TIMEFRAMES[tf].period,
                params: {}, historyDays: 20, filters: [], targetR: 2 });
  }
  for (const f of readdirSync(join(HERE, 'cfs')).filter(f => f.endsWith('.mjs'))) {
    const mod = await import(pathToFileURL(join(HERE, 'cfs', f)).href);
    for (const cfg of mod.configs || []) {
      list.push({ name: `cfs:${f.replace(/\.mjs$/, '')}/${cfg.name}`, kind: 'cfs', mod, cfg, period: mod.meta.defaultTf });
    }
  }
  return { list: ONLY.length ? list.filter(e => ONLY.some(o => e.name.includes(o))) : list, skipped };
}

// prior_day_range — the same rule strategy_runner applies live.
function priorDayHL(bars, refTs) {
  const ref = new Date(refTs);
  const dayStart = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate());
  const byDay = {};
  for (const b of bars) {
    if (b.t >= dayStart) continue;
    const d = new Date(b.t);
    (byDay[Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())] ||= []).push(b);
  }
  const days = Object.keys(byDay).map(Number).sort((a, b) => b - a);
  if (!days.length) return null;
  const prev = byDay[days[0]];
  return { hi: Math.max(...prev.map(b => b.h)), lo: Math.min(...prev.map(b => b.l)) };
}

/** Replay a manifest module exactly as strategy_runner calls it live. */
function moduleSignals(e, bars, sym) {
  const out = [], win = e.historyDays * 864e5, t0 = Date.now();
  let lo = 0, truncated = false;
  for (let i = 60; i < bars.length; i++) {
    if ((i & 511) === 0 && (Date.now() - t0) / 1000 > MAX_SEC) { truncated = true; break; }
    const t = bars[i].t;
    while (bars[lo].t < t - win) lo++;
    if (i - lo + 1 < 60) continue;                                     // the runner's floor
    const w = bars.slice(lo, i + 1);
    let sigs;
    try {
      sigs = e.logic.generateSignals(w, { symbol: sym, tf: e.tf, params: e.params, sessions: SESSIONS,
        instrument: { symbol: sym, class: instrumentClass(sym).toLowerCase() } }) || [];
    } catch { continue; }
    const s = sigs.filter(x => x.ts === t && x.dir && x.entry && x.sl).pop();
    if (!s || (s.dir === 'long' ? s.sl >= s.entry : s.sl <= s.entry)) continue;
    if (e.filters.includes('prior_day_range')) {
      const pd = priorDayHL(w, s.ts);
      if (!pd || !(s.dir === 'long' ? s.entry > pd.hi : s.entry < pd.lo)) continue;
    }
    const risk = Math.abs(s.entry - s.sl);
    const own  = s.tp != null && (s.dir === 'long' ? s.tp > s.entry : s.tp < s.entry);
    out.push({ i, dir: s.dir, entry: s.entry, stop: s.sl,
               tp: own ? s.tp : (s.dir === 'long' ? s.entry + e.targetR * risk : s.entry - e.targetR * risk) });
  }
  return { sigs: out, truncated };
}

async function cfsSignals(e, bars, atr, sym) {
  let ctx = null;
  if (e.mod.meta?.aux) {
    const auxSym = e.mod.meta.aux[sym];
    if (!auxSym) return null;                          // a pair strategy with no pair for this symbol
    const aux = await loadBars(auxSym, e.period);
    const m = new Map((aux || []).map(x => [x.t, x]));
    ctx = { auxSym, aux: bars.map(x => m.get(x.t) || null) };
  }
  try { return { sigs: e.mod.signals(bars, atr, e.cfg, ctx) || [], truncated: false }; } catch { return null; }
}

const slim = s => ({ n: s.n, wr: s.wr, pf: s.pf === Infinity ? 99 : s.pf, netR: s.netR, maxDD: s.maxDD, top3: s.netMinusTop3 });

function evaluate(bars, atr, sigs, cost, splitTs) {
  const rows = [];
  for (const k of STOP_MULTS) for (const target of TARGETS) {
    const vs = sigs.map(s => variant(s, k, target)).filter(Boolean);
    if (!vs.length) continue;
    const r = simulate(bars, atr, vs, cost);
    rows.push({ k, target,
                IS:  slim(statsFrom(r.trades.filter(t => t.t <  splitTs))),
                OOS: slim(statsFrom(r.trades.filter(t => t.t >= splitTs))) });
  }
  return rows;
}

const passes = r => r.OOS.n >= BAR.minOosN && r.OOS.netR > 0 && r.OOS.top3 > 0 && r.OOS.maxDD <= BAR.maxOosDdR;
const why = r => [r.OOS.n < BAR.minOosN && `only ${r.OOS.n} OOS trades`, r.OOS.netR <= 0 && 'lost money OOS',
                  r.OOS.top3 <= 0 && 'profit is 3 lucky trades', r.OOS.maxDD > BAR.maxOosDdR && `drawdown ${r.OOS.maxDD}R`]
                 .filter(Boolean).join(', ');

// ── Main ─────────────────────────────────────────────────────────────────────
const { list, skipped } = await entrants();
const periods = [...new Set(list.map(e => e.period))];
console.log(`STRATEGY LAB — ${list.length} entrants x ${STOP_MULTS.length * TARGETS.length} stop/target variants x ${SYMS.length} instruments`);
console.log(`Money at $${RISK_USD.toFixed(0)} risk/trade ($${EQUITY} @ ${RISK_PCT}%). In-sample = first ${IS_FRAC * 100}% of each history; the rest is out-of-sample.`);
console.log(`Promotion bar (fixed in advance): >=${BAR.minOosN} OOS trades, OOS net > $0, OOS net still > $0 without its 3 best trades, OOS drawdown <= ${BAR.maxOosDdR}R.`);
for (const s of skipped) console.log(`  not testable: ${s}`);
console.log('');

const results = [], coverage = {};
for (const sym of SYMS) {
  const t0 = Date.now();
  let nSig = 0;
  for (const period of periods) {
    let bars;
    try { bars = await loadBars(sym, period); } catch (err) { console.log(`  ${sym} ${period}: bars failed — ${err.message}`); continue; }
    if (!bars || bars.length < 300) { console.log(`  ${sym} ${period}: only ${bars?.length ?? 0} bars — skipped`); continue; }
    const atr = atr14(bars);
    const splitTs = bars[0].t + IS_FRAC * (bars[bars.length - 1].t - bars[0].t);
    const cost = { spread: SPREADS[sym] ?? median(bars.map(b => b.c)) * 0.00008, slipFrac: SLIP };
    coverage[`${sym} ${period}`] = `${new Date(bars[0].t).toISOString().slice(0, 10)} | OOS from ${new Date(splitTs).toISOString().slice(0, 10)} | ${bars.length} bars`;
    for (const e of list.filter(x => x.period === period)) {
      const got = e.kind === 'cfs' ? await cfsSignals(e, bars, atr, sym) : moduleSignals(e, bars, sym);
      if (!got) continue;
      if (got.truncated) { console.log(`  ${sym} ${e.name}: replay exceeded ${MAX_SEC}s — excluded (a partial run is in-sample only)`); continue; }
      nSig += got.sigs.length;
      for (const row of evaluate(bars, atr, got.sigs, cost, splitTs)) results.push({ sym, name: e.name, period, ...row });
    }
  }
  console.log(`  ${sym}: ${nSig} signals across ${list.length} entrants (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}

console.log('\n=== DATA ===');
for (const [k, v] of Object.entries(coverage)) console.log(`  ${k.padEnd(12)} ${v}`);

// Does in-sample profit predict out-of-sample profit at all? If not, every "winner" is noise.
const judged = results.filter(r => r.IS.n >= BAR.minIsN && r.OOS.n >= 10);
const isWin  = judged.filter(r => r.IS.netR > 0);
const pct = (a, b) => b ? `${Math.round(100 * a / b)}%` : 'n/a';
console.log('\n=== IS THERE ANY SIGNAL IN THE NOISE? ===');
console.log(`  ${judged.length} strategy/variant/instrument combinations had enough trades to judge.`);
console.log(`  ${pct(judged.filter(r => r.OOS.netR > 0).length, judged.length)} of them made money out of sample.`);
console.log(`  Of those that made money IN sample, ${pct(isWin.filter(r => r.OOS.netR > 0).length, isWin.length)} kept making money out of sample.`);
console.log(`  (If those two numbers are close, in-sample results don't predict anything.)`);

console.log('\n=== BEST PER INSTRUMENT — chosen on in-sample, judged on out-of-sample ===');
const picks = [];
for (const sym of SYMS) {
  const cands = results.filter(r => r.sym === sym && r.IS.n >= BAR.minIsN && r.IS.netR > 0).sort((a, b) => b.IS.netR - a.IS.netR);
  console.log(`\n  ${sym}  (${cands.length} in-sample-profitable candidates)`);
  if (!cands.length) { console.log('    nothing made money in-sample'); picks.push({ sym, pick: null }); continue; }
  const pick = cands[0], ok = passes(pick);
  const ddR  = Math.max(pick.IS.maxDD, pick.OOS.maxDD, 1);
  const riskPct = +Math.min(RISK_PCT, 10 / ddR).toFixed(2);            // worst historical drawdown ~10% of equity
  picks.push({ sym, pick, pass: ok, riskPct });
  console.log(`    PICK ${pick.name}  stop x${pick.k}, target ${pick.target === 'own' ? 'own' : pick.target + 'R'}`);
  console.log(`      in-sample     ${usd(pick.IS.netR).padStart(8)}  n=${pick.IS.n} WR=${pick.IS.wr}% worstDD=${usd(-pick.IS.maxDD)}`);
  console.log(`      OUT-OF-SAMPLE ${usd(pick.OOS.netR).padStart(8)}  n=${pick.OOS.n} WR=${pick.OOS.wr}% worstDD=${usd(-pick.OOS.maxDD)} without-top-3=${usd(pick.OOS.top3)}`);
  console.log(`      ${ok ? `PASS — size at ${riskPct}% risk/trade (keeps the worst drawdown near 10% of equity)` : `FAIL — ${why(pick)}`}`);
  console.log('      next 4 in-sample candidates, and what they did out of sample:');
  for (const c of cands.slice(1, 5)) {
    console.log(`        ${c.name.slice(0, 44).padEnd(44)} x${c.k} ${String(c.target).padEnd(4)} IS ${usd(c.IS.netR).padStart(7)} -> OOS ${usd(c.OOS.netR).padStart(7)} (n=${c.OOS.n})`);
  }
}

console.log('\n=== CURRENT MANIFESTS, AS CONFIGURED (own target, stop x1), OUT OF SAMPLE ===');
for (const name of [...new Set(results.filter(r => r.name.startsWith('m:')).map(r => r.name))]) {
  const rows = results.filter(r => r.name === name && r.k === 1 && r.target === 'own');
  const tot = rows.reduce((a, r) => a + r.OOS.netR, 0), n = rows.reduce((a, r) => a + r.OOS.n, 0);
  const best = [...rows].sort((a, b) => b.OOS.netR - a.OOS.netR)[0];
  console.log(`  ${name.padEnd(26)} all 8 instruments ${usd(tot).padStart(8)} (n=${n})   best: ${best ? `${best.sym} ${usd(best.OOS.netR)}` : '-'}`);
}

const passed = picks.filter(p => p.pass);
console.log(`\n=== VERDICT: ${passed.length} of ${SYMS.length} instruments have a strategy that passed ===`);
for (const p of passed) console.log(`  ${p.sym.padEnd(8)} ${p.pick.name}  stop x${p.pick.k} target ${p.pick.target}  OOS ${usd(p.pick.OOS.netR)} @ ${p.riskPct}%`);

const out = join(OUT_DIR, `strategy_lab_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`);
try {
  writeFileSync(out, JSON.stringify({ ts: new Date().toISOString(), equity: EQUITY, riskPct: RISK_PCT, isFrac: IS_FRAC,
    bar: BAR, coverage, skipped, picks, results }, null, 1));
  console.log(`\nFull results -> ${out}`);
} catch (e) { console.log(`(could not write ${out}: ${e.message})`); }
process.exit(0);
