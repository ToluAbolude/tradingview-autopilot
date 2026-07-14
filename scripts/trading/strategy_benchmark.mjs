/**
 * strategy_benchmark.mjs — Trading-standards benchmark for EVERY live decision-maker.
 *
 * Like an AI benchmark suite: a FIXED registry of entrants (each unit that decides
 * a trade — a voting stack counts as ONE entrant), a FIXED metric set computed from
 * the realised broker ledger (not the bot's own logs), a PASS/WATCH/CUT grade, a
 * backtest baseline to compare live vs expected, and an append-only history file so
 * every re-run measures improvement against the previous run.
 *
 * Entrants:
 *   SCAN-CONFLUENCE  — the whole scanner voting stack (market_scanner --scan-only +
 *                      signal_executor + inline_trader + session_runner), acct 2118552.
 *                      One entrant: the votes A–Z are not independently executable.
 *   EXP/<combo>      — each confirm_runner combo on acct 2131377 (independent,
 *                      per-strategy-tagged trades; bracketed===true only, the same
 *                      validity rule as confirm_report / the weekly review).
 *   ORB-SESSIONS     — orb_runner dry-run forward-test, outcomes replayed from real
 *                      cTrader M5 bars (TP/SL first-touch, conservative both-touch =
 *                      loss, 21:00 UTC intraday cutoff exit).
 *   ZONE-LIMITS / TVO-TRADEIFY / KURISKO-2020 — status rows (dry-run / armed /
 *                      not scheduled): registered so the suite is complete, graded
 *                      only once they produce fills.
 *
 * Metrics: n closed, open, WR%, TP-hit% (R ≥ 0.9×target — the operator's success
 * metric), ExpR, TotalR, PF, MaxDD (peak-to-trough on the cumulative R curve),
 * PF delta vs backtest baseline. Scanner is measured in $ (per-trade 1R varies).
 * Grade (same thresholds as confirm_weekly_review): PASS = n≥25 & ExpR>0 & PF≥1.5;
 * EARLY = n<5; WATCH = ExpR>0; CUT = ExpR≤0.
 *
 * Phases (each cTrader account needs its own env, so run via the job wrappers):
 *   /home/ubuntu/run_confirm_job.sh strategy_benchmark.mjs --phase=confirm
 *   /home/ubuntu/run_scanner_job.sh strategy_benchmark.mjs --phase=scanner
 *   /home/ubuntu/run_scanner_job.sh strategy_benchmark.mjs --phase=report
 * confirm/scanner write benchmark_confirm.json / benchmark_scanner.json; report
 * merges them → benchmark_results.md + appends benchmark_history.jsonl (the
 * "score over time" record) and prints per-entrant deltas vs the previous run.
 *
 * Epoch: 2026-06-29T00:00:00Z (bracket-attach fix — first date both accounts'
 * data is a valid test). Override with --from=YYYY-MM-DD.
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';
import os from 'os';

const IS_LINUX  = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX ? '/home/ubuntu/trading-data' : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const PHASE = ((process.argv.find(a => a.startsWith('--phase=')) || '').split('=')[1]) || 'report';
const FROM  = ((process.argv.find(a => a.startsWith('--from='))  || '').split('=')[1]) || '2026-06-29';
const EPOCH = Date.parse(`${FROM}T00:00:00Z`);

const F = {
  confirm: join(DATA_ROOT, 'benchmark_confirm.json'),
  scanner: join(DATA_ROOT, 'benchmark_scanner.json'),
  outMd:   join(DATA_ROOT, 'benchmark_results.md'),
  history: join(DATA_ROOT, 'benchmark_history.jsonl'),
  signals: join(DATA_ROOT, 'confirm_signals.jsonl'),
  orb:     join(DATA_ROOT, 'orb_signals.jsonl'),
  csv:     join(DATA_ROOT, 'trade_log', 'trades.csv'),
};

// Backtest baselines — the "expected score" each entrant must live up to.
const BASELINE = {
  'SCAN-CONFLUENCE':     { pf: 2.30, note: 'edge_replay conditioned subset: score≥11 + with-trend + NY/overlap + crypto/NAS100 → +0.4R/tr' },
  'EXP/wor_break_retest':    { pf: 2.53, n: 25 },
  'EXP/jackson_gold':        { pf: 2.19, note: 'WR75% (90d 1h matrix)' },
  'EXP/amd_ote':             { pf: 1.71, n: 43 },
  'EXP/confluence_trifecta': { pf: 1.87, n: 37 },
  'EXP/orb':                 { pf: 1.81, n: 103 },
  'EXP/wor_break_retest_ntz':{ note: 'A/B variant (prior-day-range filter) — baseline = beat EXP/wor_break_retest live' },
  'EXP/amd_ote_newsgated':   { note: 'A/B variant (news gate) — baseline = beat EXP/amd_ote live' },
  'EXP/jadecap_fvg':         { note: 'weak edge ~+0.04R/tr, OOS held both halves — slot exists to resolve it' },
  'EXP/stage_s2':            { note: 'IS +15.6R / OOS +37.9R (3R-capped), ~1-2 trades/yr — validates execution not stats' },
  'ORB-SESSIONS':        { note: 'per-config: XAUUSD@2R PF1.59 · US30@2R PF1.29 · NAS100@1R WR56% · SPX500@2R PF1.35 (orb_oos survivors)' },
  'ZONE-LIMITS':         { pf: 1.18, note: '+703R reversal_sr_backtest, robust OOS — dry-run, no fills yet' },
  'TVO-TRADEIFY':        { note: 'routes ORB signals to Tradeify 25k futures; armed 2026-07-10, no fills yet' },
  'KURISKO-2020':        { pf: 1.35, note: 'PF1.35 @0.08R cost on conditioned slice — built, NOT scheduled' },
};

const grade = m => !m || !m.n ? 'IDLE'
  : m.n >= 25 && m.expR > 0 && m.pf >= 1.5 ? 'PASS'
  : m.n < 5 && m.expR > 0 ? 'EARLY'
  : m.expR > 0 ? 'WATCH' : 'CUT';

// Standard metric block from a list of R-denominated trades [{ts, R, tpHit}]
function metricsR(trades) {
  if (!trades.length) return { n: 0, open: 0 };
  trades.sort((a, b) => a.ts - b.ts);
  let sum = 0, gw = 0, gl = 0, wins = 0, tp = 0, peak = 0, maxDD = 0, cum = 0;
  for (const t of trades) {
    sum += t.R;
    if (t.R > 0) { wins++; gw += t.R; } else gl += Math.abs(t.R);
    if (t.tpHit) tp++;
    cum += t.R; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum);
  }
  return {
    n: trades.length, wr: Math.round(100 * wins / trades.length),
    tpHit: Math.round(100 * tp / trades.length),
    expR: sum / trades.length, totalR: sum,
    pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0), maxDD_R: maxDD,
  };
}

// ── phase: confirm — experiment combos from the ledger (acct 2131377) ─────────
async function phaseConfirm() {
  const recs = !existsSync(F.signals) ? [] :
    readFileSync(F.signals, 'utf8').trim().split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(r => r && r.mode === 'live-demo' && Date.parse(r.ts) >= EPOCH);
  const valid = recs.filter(r => r.positionId && r.bracketed === true);

  const bridge = await import('./broker_ctrader.mjs');
  await bridge.connect();
  const deals = await bridge.getAllClosedDeals(EPOCH);
  const netByPos = new Map(), closeTs = new Map();
  for (const d of deals) {
    netByPos.set(d.positionId, (netByPos.get(d.positionId) || 0) + d.net);
    closeTs.set(d.positionId, Math.max(closeTs.get(d.positionId) || 0, d.execTs));
  }

  const byLabel = {};
  for (const t of valid) {
    const label = t.label || t.strategy;
    const b = byLabel[label] ||= { trades: [], open: 0, symbols: new Set() };
    b.symbols.add(t.symbol);
    if (!netByPos.has(t.positionId)) { b.open++; continue; }
    const risk$ = (t.equity * t.riskPct) / 100;
    const R = risk$ > 0 ? netByPos.get(t.positionId) / risk$ : 0;
    b.trades.push({ ts: closeTs.get(t.positionId), R, tpHit: R >= 0.9 * (t.riskR || 2) });
  }

  const out = { runTs: new Date().toISOString(), epoch: FROM, emitted: recs.length, placed: valid.length, entrants: {} };
  for (const [label, b] of Object.entries(byLabel))
    out.entrants[`EXP/${label}`] = { symbols: [...b.symbols].join('+'), open: b.open, ...metricsR(b.trades),
      series: b.trades.map(t => ({ ts: t.ts, R: +t.R.toFixed(3) })) };
  writeFileSync(F.confirm, JSON.stringify(out, null, 2));
  console.log(`confirm phase → ${F.confirm} (${valid.length} placed / ${recs.length} emitted)`);
}

// ── phase: scanner — account ledger in $ + ORB paper replay (acct 2118552) ────
async function phaseScanner() {
  const bridge = await import('./broker_ctrader.mjs');
  await bridge.connect();
  const deals = await bridge.getAllClosedDeals(EPOCH);
  const pos = new Map();
  for (const d of deals) {
    let p = pos.get(d.positionId);
    if (!p) pos.set(d.positionId, p = { net: 0, ts: 0, symbol: d.symbolName });
    p.net += d.net; p.ts = Math.max(p.ts, d.execTs);
  }
  const trades = [...pos.values()].sort((a, b) => a.ts - b.ts);
  let net = 0, gw = 0, gl = 0, wins = 0, peak = 0, maxDD = 0, cum = 0;
  const bySym = {};
  for (const t of trades) {
    net += t.net; cum += t.net;
    if (t.net > 0) { wins++; gw += t.net; } else gl += Math.abs(t.net);
    peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum);
    bySym[t.symbol] = (bySym[t.symbol] || 0) + t.net;
  }
  const scan = {
    n: trades.length, wr: trades.length ? Math.round(100 * wins / trades.length) : 0,
    net$: net, pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0), maxDD$: maxDD,
    expR: net, // $-domain: sign carries the grade; expR>0 ⇔ net$>0
    bestSym: Object.entries(bySym).sort((a, b) => b[1] - a[1])[0] || null,
    worstSym: Object.entries(bySym).sort((a, b) => a[1] - b[1])[0] || null,
    bySym,
    series: trades.map(t => ({ ts: t.ts, net: +t.net.toFixed(2), symbol: t.symbol })),
  };

  // ORB dry-run replay against real M5 bars
  const sigs = !existsSync(F.orb) ? [] :
    readFileSync(F.orb, 'utf8').trim().split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(s => s && s.mode === 'dry-run' && Date.parse(s.ts) >= EPOCH);
  const orbTrades = [], perCfg = {};
  for (const s of sigs) {
    const t0 = Date.parse(s.ts);
    const cutoff = new Date(t0); cutoff.setUTCHours(21, 0, 0, 0); // intraday: flat by 21:00 UTC
    let bars = [];
    try { bars = await bridge.getTrendbars(s.symbol, { period: 'M5', fromMs: t0, toMs: Math.min(+cutoff, Date.now()) }); }
    catch (e) { console.log(`  orb replay skip ${s.symbol}@${s.ts}: ${e.message}`); continue; }
    bars = bars.filter(b => b.t >= t0 && b.t <= +cutoff);
    if (!bars.length) continue;
    const riskDist = Math.abs(s.entry - s.sl);
    let R = null;
    for (const b of bars) {
      const slHit = s.dir === 'long' ? b.l <= s.sl : b.h >= s.sl;
      const tpHit = s.dir === 'long' ? b.h >= s.tp : b.l <= s.tp;
      if (slHit) { R = -1; break; }            // both-touch = conservative loss
      if (tpHit) { R = s.riskR; break; }
    }
    if (R === null) {
      const c = bars[bars.length - 1].c;
      R = (s.dir === 'long' ? c - s.entry : s.entry - c) / riskDist; // cutoff exit
    }
    const trade = { ts: t0, R, tpHit: R >= 0.9 * s.riskR, cfg: `${s.symbol}@${s.session}` };
    orbTrades.push(trade);
    (perCfg[`${s.symbol}@${s.session}`] ||= []).push(trade);
  }

  // Funnel counts from the scanner's own log (setups seen vs executed vs broker-voided)
  let funnel = null;
  if (existsSync(F.csv)) {
    const rows = readFileSync(F.csv, 'utf8').trim().split('\n').slice(1).filter(l => Date.parse(l.split(',')[0]) >= EPOCH);
    funnel = {
      checks: rows.length,
      noSetup: rows.filter(r => r.includes(',NONE,')).length,
      voided: rows.filter(r => r.includes('VOID')).length,
    };
  }

  const out = {
    runTs: new Date().toISOString(), epoch: FROM,
    scan, funnel,
    orb: { ...metricsR(orbTrades), open: 0,
      series: orbTrades.map(t => ({ ts: t.ts, R: +t.R.toFixed(3), cfg: t.cfg })) },
    orbPerConfig: Object.fromEntries(Object.entries(perCfg).map(([k, v]) => [k, metricsR(v)])),
  };
  writeFileSync(F.scanner, JSON.stringify(out, null, 2));
  console.log(`scanner phase → ${F.scanner} (${trades.length} ledger trades, ${orbTrades.length}/${sigs.length} ORB signals replayed)`);
}

// ── phase: report — merge, grade, diff vs previous run, write MD + history ────
function phaseReport() {
  const cj = existsSync(F.confirm) ? JSON.parse(readFileSync(F.confirm, 'utf8')) : null;
  const sj = existsSync(F.scanner) ? JSON.parse(readFileSync(F.scanner, 'utf8')) : null;

  // previous run per entrant (for the improvement delta — the benchmark-over-time bit)
  const prev = {};
  if (existsSync(F.history))
    for (const l of readFileSync(F.history, 'utf8').trim().split('\n').filter(Boolean)) {
      try { const r = JSON.parse(l); prev[r.entrant] = r; } catch { /* skip */ }
    }

  const rows = [];
  const add = (id, m, extra = {}) => rows.push({ id, m, base: BASELINE[id] || {}, prev: prev[id] || null, ...extra });

  if (sj) add('SCAN-CONFLUENCE', { ...sj.scan, dollar: true }, { open: 0 });
  if (cj) {
    for (const [id, m] of Object.entries(cj.entrants)) add(id, m, { open: m.open });
    // combos that never placed a valid trade still belong on the board (fixed suite)
    for (const id of Object.keys(BASELINE))
      if (id.startsWith('EXP/') && !cj.entrants[id]) add(id, null);
  }
  if (sj) add('ORB-SESSIONS', sj.orb, { paper: true });
  add('ZONE-LIMITS', null); add('TVO-TRADEIFY', null); add('KURISKO-2020', null);

  const runTs = new Date().toISOString();
  const fR = n => n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(2) + 'R';
  const f$ = n => (n < 0 ? '-$' : '+$') + Math.abs(Math.round(n)).toLocaleString('en-US');
  const fPf = p => p == null ? '—' : p === Infinity || p === null ? '∞' : p.toFixed(2);

  const lines = [`# Strategy Benchmark — ${runTs.slice(0, 10)} (epoch ${cj?.epoch || sj?.epoch})`, ''];
  lines.push('| Entrant | Grade | n (open) | WR | TP-hit | Exp/tr | Total | PF | Baseline PF | Δ vs prev run |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const m = r.m, g = m ? grade(m) : 'IDLE';
    const basePf = r.base.pf != null ? r.base.pf.toFixed(2) : '—';
    let delta = 'first run';
    if (r.prev && m && m.n) {
      const dPf = (m.pf === Infinity ? 99 : m.pf || 0) - (r.prev.pf === 'inf' ? 99 : r.prev.pf || 0);
      delta = `n ${r.prev.n}→${m.n}, PF ${dPf >= 0 ? '+' : ''}${dPf.toFixed(2)}`;
    } else if (!m || !m.n) delta = '—';
    lines.push(m && m.n
      ? `| ${r.id}${r.paper ? ' *(paper)*' : ''} | ${g} | ${m.n} (${r.open || 0}) | ${m.wr}% | ${m.tpHit != null ? m.tpHit + '%' : '—'} | ${m.dollar ? f$(m.net$ / m.n) : fR(m.expR)} | ${m.dollar ? f$(m.net$) : fR(m.totalR)} | ${fPf(m.pf)} | ${basePf} | ${delta} |`
      : `| ${r.id} | ${g} | 0 | — | — | — | — | — | ${basePf} | ${r.base.note || ''} |`);
    // history line (skip status-only rows)
    if (m && m.n) appendFileSync(F.history, JSON.stringify({
      runTs, entrant: r.id, n: m.n, wr: m.wr, expR: m.dollar ? null : +(m.expR).toFixed(3),
      net$: m.dollar ? Math.round(m.net$) : null, pf: m.pf === Infinity ? 'inf' : +(m.pf || 0).toFixed(3),
      totalR: m.dollar ? null : +(m.totalR).toFixed(2), maxDD: m.dollar ? Math.round(m.maxDD$) : +(m.maxDD_R || 0).toFixed(2),
    }) + '\n');
  }
  lines.push('');
  if (sj?.funnel) lines.push(`_Scanner funnel since epoch: ${sj.funnel.checks} session checks, ${sj.funnel.noSetup} no-setup, ${sj.funnel.voided} broker-voided._`);
  if (cj) lines.push(`_Experiment funnel: ${cj.emitted} signals emitted → ${cj.placed} placed+bracketed._`);
  if (sj?.orbPerConfig) {
    lines.push('', '**ORB per config (paper):** ' + Object.entries(sj.orbPerConfig)
      .map(([k, m]) => `${k} ${m.n}tr ${fR(m.totalR)} PF${fPf(m.pf)}`).join(' · '));
  }
  lines.push('', `_Grades: PASS = n≥25 & ExpR>0 & PF≥1.5 · EARLY = n<5 · WATCH = ExpR>0 · CUT = ExpR≤0 · IDLE = no fills. Scanner measured in $ (ledger), combos in R._`);

  const out = lines.join('\n') + '\n';
  writeFileSync(F.outMd, out);
  console.log('\n' + out + `\nWrote ${F.outMd}, appended ${F.history}`);
}

const run = { confirm: phaseConfirm, scanner: phaseScanner, report: phaseReport }[PHASE];
if (!run) { console.error(`unknown --phase=${PHASE}`); process.exit(1); }
Promise.resolve(run()).then(() => process.exit(0)).catch(e => { console.error(`benchmark ${PHASE} failed:`, e); process.exit(1); });
