/**
 * edge_replay.mjs — Prove (or disprove) the strategy's edge from REAL setups.
 *
 * Why this exists: trades.csv's `result`/`pnl` columns are corrupted by broker
 * VOIDs (292 VOID / 482 blank / only 54W+111L recorded out of ~970 rows), so we
 * cannot read edge off the live log. Instead we take every setup the bot logged
 * (with its real entry/sl/tp + Trifecta breakdown) and REPLAY it against real
 * cTrader M5 history, modelling live behaviour (TP1-vs-SL, force-closed at the
 * 20:00 UTC EOD cutoff). Then we segment expectancy by setup quality so we can
 * arm only the buckets that actually print money.
 *
 * Caveats (all make this an OPTIMISTIC upper bound, so a losing bucket is damning):
 *   - intrabar ordering approximated on M5; when a bar spans both SL & TP we take
 *     SL-first (conservative).
 *   - spread/commission/slippage NOT modelled (real edge is a touch worse).
 *   - entry assumed filled at the logged price (ignores VOIDs / partial fills).
 *
 * Usage (on VM, env loaded):
 *   node scripts/trading/edge_replay.mjs                 # full report
 *   node scripts/trading/edge_replay.mjs --no-eod        # ignore EOD close (room test)
 *   node scripts/trading/edge_replay.mjs --horizon 48    # alt MTM horizon hrs (no-eod)
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { getTrendbars, getAllClosedDeals, getEquity } from './broker_ctrader.mjs';

const IS_LINUX  = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX ? '/home/ubuntu/trading-data' : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const TRADES_CSV = join(DATA_ROOT, 'trade_log', 'trades.csv');

const args = process.argv.slice(2);
const NO_EOD = args.includes('--no-eod');
const HORIZON_H = (() => { const i = args.indexOf('--horizon'); return i >= 0 ? parseFloat(args[i + 1]) : 48; })();
const EOD_HOUR = 20; // UTC — matches eod_close cron

// cTrader symbol-name fallbacks (trades.csv label -> cTrader symbol name candidates)
const SYM_ALIASES = {
  US30: ['US30', 'US30.', 'DJ30', 'US Wall Street 30'],
  NAS100: ['NAS100', 'USTEC', 'US Tech 100', 'NAS100.'],
  GER40: ['GER40', 'DE40', 'DAX40'],
  UK100: ['UK100', 'FTSE100'],
  AUS200: ['AUS200', 'AU200'],
  SPX500: ['SPX500', 'US500'],
};

function parseTrades() {
  const raw = readFileSync(TRADES_CSV, 'utf8').trim().split('\n');
  const rows = [];
  for (let i = 1; i < raw.length; i++) {
    const f = raw[i].split(',');
    if (f.length < 12) continue;
    const [date, session, symbol, tf, direction, score, entry, sl, tp, rr, result, pnl] = f;
    const notes = f.slice(12).join(',');
    if (!symbol || symbol === 'NONE') continue;
    const e = parseFloat(entry), s = parseFloat(sl);
    const tp1 = parseFloat((tp || '').split('/')[0]);
    if (!isFinite(e) || !isFinite(s) || !isFinite(tp1) || e === s) continue;
    const dir = /short/i.test(direction) ? 'short' : 'long';
    const ts = Date.parse(date);
    if (!isFinite(ts)) continue;
    const trifM = notes.match(/Trifecta=(\d)\/3/);
    const trif = trifM ? +trifM[1] : null;
    rows.push({ ts, date, session: session || '?', symbol, dir, score: parseInt(score) || 0,
                entry: e, sl: s, tp1, trif, rawResult: result });
  }
  return rows;
}

function eodCutoff(ts) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), EOD_HOUR, 0, 0);
}

// Returns { outcome:R, kind:'tp'|'sl'|'eod'|'mtf'|'open', exitTs }
function replay(trade, bars) {
  const { ts, dir, entry, sl, tp1 } = trade;
  const risk = Math.abs(entry - sl);
  const horizonEnd = NO_EOD ? ts + HORIZON_H * 3600e3 : Math.max(eodCutoff(ts), ts + 60 * 60e3);
  const window = bars.filter(b => b.t > ts && b.t <= horizonEnd);
  if (!window.length) return { outcome: null, kind: 'open', exitTs: null };
  for (const b of window) {
    if (dir === 'long') {
      if (b.l <= sl)  return { outcome: -1, kind: 'sl', exitTs: b.t };
      if (b.h >= tp1) return { outcome: Math.abs(tp1 - entry) / risk, kind: 'tp', exitTs: b.t };
    } else {
      if (b.h >= sl)  return { outcome: -1, kind: 'sl', exitTs: b.t };
      if (b.l <= tp1) return { outcome: Math.abs(tp1 - entry) / risk, kind: 'tp', exitTs: b.t };
    }
  }
  // neither hit -> mark to market at last bar (EOD force-close / horizon)
  const last = window[window.length - 1];
  const mtm = (dir === 'long' ? (last.c - entry) : (entry - last.c)) / risk;
  return { outcome: mtm, kind: NO_EOD ? 'mtf' : 'eod', exitTs: last.t };
}

function stats(rows) {
  const resolved = rows.filter(r => r.outcome != null);
  const n = resolved.length;
  if (!n) return null;
  const wins = resolved.filter(r => r.outcome > 0);
  const losses = resolved.filter(r => r.outcome <= 0);
  const grossWin = wins.reduce((s, r) => s + r.outcome, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r.outcome, 0));
  const totalR = resolved.reduce((s, r) => s + r.outcome, 0);
  return {
    n, wr: wins.length / n,
    avgR: totalR / n,
    totalR,
    pf: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    tpRate: resolved.filter(r => r.kind === 'tp').length / n,
  };
}

function fmt(s) {
  if (!s) return 'n=0';
  const pf = s.pf === Infinity ? '∞' : s.pf.toFixed(2);
  const sign = s.avgR >= 0 ? '+' : '';
  return `n=${String(s.n).padStart(3)}  WR=${(s.wr * 100).toFixed(0).padStart(3)}%  ` +
         `expectancy=${sign}${s.avgR.toFixed(3)}R  totalR=${s.totalR >= 0 ? '+' : ''}${s.totalR.toFixed(1)}  PF=${pf}`;
}

function groupReport(label, rows, keyFn, minN = 1) {
  const groups = new Map();
  for (const r of rows) { const k = keyFn(r); if (k == null) continue; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  console.log(`\n── ${label} ──`);
  const entries = [...groups.entries()].map(([k, rs]) => [k, stats(rs)]).filter(([, s]) => s && s.n >= minN);
  entries.sort((a, b) => (b[1].avgR) - (a[1].avgR));
  for (const [k, s] of entries) console.log(`  ${String(k).padEnd(14)} ${fmt(s)}`);
}

async function main() {
  const all = parseTrades();
  console.log(`Parsed ${all.length} replayable setups from trades.csv (${new Date(Math.min(...all.map(r=>r.ts))).toISOString().slice(0,10)} → ${new Date(Math.max(...all.map(r=>r.ts))).toISOString().slice(0,10)})`);
  console.log(`Mode: ${NO_EOD ? `NO-EOD (mark-to-market at +${HORIZON_H}h)` : 'LIVE (force-close at 20:00 UTC EOD)'}`);

  const bySym = new Map();
  for (const r of all) { if (!bySym.has(r.symbol)) bySym.set(r.symbol, []); bySym.get(r.symbol).push(r); }

  const minTs = Math.min(...all.map(r => r.ts)) - 6 * 3600e3;
  const maxTs = Math.max(...all.map(r => r.ts)) + (NO_EOD ? HORIZON_H : 30) * 3600e3;

  const resolvedRows = [];
  const symStatus = [];
  for (const [sym, rows] of bySym) {
    const candidates = SYM_ALIASES[sym] || [sym];
    let bars = null, used = null;
    const cacheFile = `/tmp/edge_bars_${sym}.json`;
    if (existsSync(cacheFile)) {
      try { const c = JSON.parse(readFileSync(cacheFile, 'utf8'));
        if (c.fromMs <= minTs && c.toMs >= maxTs && c.bars?.length) { bars = c.bars; used = c.used + ' [cache]'; } } catch {}
    }
    if (!bars) for (const name of candidates) {
      try { const b = await getTrendbars(name, { period: 'M5', fromMs: minTs, toMs: maxTs, windowDays: 5 });
        if (b && b.length) { bars = b; used = name;
          try { writeFileSync(cacheFile, JSON.stringify({ used: name, fromMs: minTs, toMs: maxTs, bars: b })); } catch {}
          break; } } catch (e) { /* try next */ }
    }
    if (!bars) { symStatus.push(`✗ ${sym} (no cTrader bars — ${rows.length} setups unresolved)`); continue; }
    symStatus.push(`✓ ${sym} via "${used}" (${bars.length} M5 bars, ${rows.length} setups)`);
    for (const r of rows) { const res = replay(r, bars); resolvedRows.push({ ...r, ...res }); }
  }

  console.log('\n=== SYMBOL DATA ===');
  for (const s of symStatus) console.log('  ' + s);

  const resolved = resolvedRows.filter(r => r.outcome != null);
  console.log(`\n=== OVERALL (${resolved.length} resolved of ${resolvedRows.length}) ===`);
  console.log('  ALL            ' + fmt(stats(resolvedRows)));

  // Tradable universe = symbols that resolved on cTrader (i.e. actually on the account)
  groupReport('BY TRIFECTA (setup quality)', resolvedRows, r => r.trif == null ? null : `${r.trif}/3`);
  groupReport('BY SCORE BUCKET', resolvedRows, r => r.score >= 11 ? '>=11 (live gate)' : r.score >= 8 ? '8-10' : r.score >= 6 ? '6-7' : '<6');
  groupReport('BY DIRECTION', resolvedRows, r => r.dir);
  groupReport('BY SESSION', resolvedRows, r => r.session);
  groupReport('BY SYMBOL (n>=8)', resolvedRows, r => r.symbol, 8);

  // The money question: would TODAY's live gate (3/3 AND score>=11) have an edge?
  const liveGate = resolvedRows.filter(r => r.trif === 3 && r.score >= 11);
  const skipped3of3 = resolvedRows.filter(r => r.trif === 3 && r.score < 11);
  console.log('\n=== THE GATE QUESTION ===');
  console.log('  3/3 & score>=11 (passes live gate)  ' + fmt(stats(liveGate)));
  console.log('  3/3 & score<11  (BLOCKED by gate)   ' + fmt(stats(skipped3of3)));

  // ── ARMED PROFILE ladder — does the proposed positive-edge subset hold? ──
  const CRYPTO_PLUS = new Set(['BTCUSD','ETHUSD','XRPUSD','LTCUSD','SOLUSD','ADAUSD','DOTUSD','NAS100']);
  const NY_SESSIONS = new Set(['NY','LONDON-NY-OVERLAP']);
  const f = (pred) => resolvedRows.filter(pred);
  console.log('\n=== ARMED PROFILE LADDER (each filter adds onto the previous) ===');
  console.log('  A. score>=11                         ' + fmt(stats(f(r => r.score >= 11))));
  console.log('  B. A + short-only                    ' + fmt(stats(f(r => r.score >= 11 && r.dir === 'short'))));
  console.log('  C. B + NY/overlap session            ' + fmt(stats(f(r => r.score >= 11 && r.dir === 'short' && NY_SESSIONS.has(r.session)))));
  console.log('  D. C + crypto/NAS100 universe        ' + fmt(stats(f(r => r.score >= 11 && r.dir === 'short' && NY_SESSIONS.has(r.session) && CRYPTO_PLUS.has(r.symbol)))));
  console.log('  --- counter-checks ---');
  console.log('  longs @ score>=11 (should be weak)   ' + fmt(stats(f(r => r.score >= 11 && r.dir === 'long'))));
  console.log('  score>=11 + NY/overlap (both dirs)    ' + fmt(stats(f(r => r.score >= 11 && NY_SESSIONS.has(r.session)))));

  // ── RECENCY walk-forward — is the edge recent or only early-period? ──
  const sorted = resolved.map(r => r.ts).sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  const half = (rows, recent) => rows.filter(r => recent ? r.ts >= mid : r.ts < mid);
  console.log(`\n=== RECENCY (split @ ${new Date(mid).toISOString().slice(0,10)}) ===`);
  console.log('  EARLY  all                ' + fmt(stats(half(resolvedRows, false))));
  console.log('  RECENT all                ' + fmt(stats(half(resolvedRows, true))));
  console.log('  EARLY  score>=11+short    ' + fmt(stats(half(f(r => r.score >= 11 && r.dir === 'short'), false))));
  console.log('  RECENT score>=11+short    ' + fmt(stats(half(f(r => r.score >= 11 && r.dir === 'short'), true))));

  // Ground-truth cross-check: real account P&L over same window
  try {
    const deals = await getAllClosedDeals(minTs, Date.now(), { windowDays: 7 });
    const net = deals.reduce((s, d) => s + (d.net || 0), 0);
    const wins = deals.filter(d => (d.net || 0) > 0).length;
    const eq = await getEquity().catch(() => ({}));
    console.log('\n=== GROUND TRUTH (real cTrader closed deals, same window) ===');
    console.log(`  ${deals.length} closing deals  net=$${net.toFixed(0)}  WR=${(wins / deals.length * 100).toFixed(0)}%  equity now=$${(eq.equity||eq.balance||0).toFixed(0)}`);
  } catch (e) { console.log('  (ground-truth pull failed: ' + e.message + ')'); }

  // Machine-readable results for the nightly reflection stack (eod_agent):
  // trades.csv result/pnl are VOID-corrupted, so these replayed outcomes are
  // the trustworthy per-setup record for downstream analysis.
  const outFile = join(DATA_ROOT, 'replay_results.json');
  writeFileSync(outFile, JSON.stringify({
    generated: new Date().toISOString(),
    mode: NO_EOD ? `no-eod-${HORIZON_H}h` : 'live-eod',
    window: {
      from: new Date(Math.min(...all.map(r => r.ts))).toISOString().slice(0, 10),
      to:   new Date(Math.max(...all.map(r => r.ts))).toISOString().slice(0, 10),
    },
    resolved: resolved.length,
    unresolved: resolvedRows.length - resolved.length + (all.length - resolvedRows.length),
    setups: resolved.map(r => ({
      date: r.date, session: r.session, symbol: r.symbol, dir: r.dir,
      score: r.score, trif: r.trif, r: Math.round(r.outcome * 1000) / 1000, exit: r.kind,
    })),
  }, null, 2));
  console.log(`\n✓ Machine-readable results → ${outFile}`);

  console.log('\nDone.');
  process.exit(0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
