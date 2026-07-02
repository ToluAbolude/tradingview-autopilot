/**
 * cf_backtest.mjs — ISOLATED backtest of the "Chart Fanatic — Trendline + S&R"
 * strategy (strategies/chart_fanatic_trendline_sr.pine) on cTrader deep history.
 *
 * TradingView's standard tester only sees ~a few hundred loaded bars and this
 * account has no Deep Backtesting, so PL1! 4H returned 0 trades there. cTrader
 * carries ~5 years of XPTUSD H4 (getTrendbars), so we replay the strategy here.
 *
 * The detection is a faithful JS port of the Pine engine:
 *   • best-fit, price-containing trendlines (auto_trendlines.pine)
 *   • wick-to-body S&R zones (support_resistance_zones.pine)
 *   • Ali Crooks "pocket" momentum-shift + S&R confluence gates
 *   • entry = TL break / bounce; stop = trendline zone, trailed along the line;
 *     TP = next S&R zone floored at a min R:R.
 *
 * Outcomes are in R (risk multiples) so configs/instruments are comparable —
 * SL-first when a bar spans both stop and target (conservative). Reports a
 * config matrix (gates on/off, break vs bounce, direction, TP mode) ranked by
 * expectancy, plus the intended-default config's full stats.
 *
 * Usage (on VM, env sourced):
 *   set -a && . /home/ubuntu/.ctrader.env && set +a
 *   node scripts/trading/cf_backtest.mjs --sym=XPTUSD --tf=H4 --years=5
 *   node scripts/trading/cf_backtest.mjs --sym=XPTUSD,XAUUSD,XAGUSD --tf=H4 --years=5
 */
import { writeFileSync } from 'fs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const a = argv.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const SYMS   = arg('sym', 'XPTUSD').split(',');
const TF     = arg('tf', 'H4');
const YEARS  = parseFloat(arg('years', '5'));
const OUT    = arg('out', '/home/ubuntu/trading-data/cf_backtest.json');

// ── Cost model ───────────────────────────────────────────────────────────────
// Round-trip cost per trade (price) = spread + 2×(slipFrac×ATR).  cTrader
// trendbars are bid; a round trip crosses the spread once, plus fill slippage
// scaled to volatility. Cost is converted to R by dividing by the trade's risk
// (stop distance), so wide ATR-scaled stops absorb spread cheaply. Conservative,
// typical BlackBull/cTrader raw spreads (price units). Override: --slip=, --spread=.
// Wide, known instruments in price units; everything else falls back to
// ~0.8 bps of median price (≈1 pip) so FX/JPY don't get a metals-sized spread.
const SPREADS = { XPTUSD: 0.80, XAUUSD: 0.30, XAGUSD: 0.03, XPDUSD: 1.50, WTI: 0.03,
                  NAS100: 1.5, US30: 3.0, SPX500: 0.5, GER40: 1.0, JP225: 7.0, UK100: 1.0, AUS200: 1.5 };
const SLIP_FRAC = parseFloat(arg('slip', '0.02'));           // slippage per fill = 2% of ATR
const SPREAD_OVR = arg('spread', '');                        // force one spread for all syms
const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] || 0; };

// ── Strategy params (mirror the Pine defaults) ───────────────────────────────
const P = {
  tl_plen: 5, tl_mintouch: 2, tl_minbars: 15, tl_maxpiv: 10,
  tl_classic: true, tl_maxdist: 12, tl_allow2: true, tl_touchtol: 0.5, tl_zone: 0.25,
  sr_pivLen: 5, sr_maxSR: 6,
  conf_atr: 0.75, mss_len: 3,
  buf: 0.5, atrStop: 2.0, maxStop: 4.0, minRR: 2.0,
};

// ── Wilder ATR(14) ───────────────────────────────────────────────────────────
function atr14(bars) {
  const n = bars.length, out = new Array(n).fill(null);
  let prevClose = null, atr = null; const len = 14;
  const trs = [];
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const tr = prevClose == null ? (b.h - b.l)
             : Math.max(b.h - b.l, Math.abs(b.h - prevClose), Math.abs(b.l - prevClose));
    prevClose = b.c;
    if (i < len) { trs.push(tr); if (i === len - 1) { atr = trs.reduce((a, c) => a + c, 0) / len; out[i] = atr; } }
    else { atr = (atr * (len - 1) + tr) / len; out[i] = atr; }
  }
  return out;
}

// Price of a line through (x1,y1)-(x2,y2) at bar x
const lineAt = (x1, y1, x2, y2, x) => x1 === x2 ? y1 : y1 + (y2 - y1) / (x2 - x1) * (x - x1);

// Best-fit resistance/support over a pivot set (direct port of findRes/findSup)
function bestFit(px, py, isRes, tol, atr, close, i) {
  const n = px.length;
  let found = false, bx1 = 0, by1 = 0, bx2 = 0, by2 = 0, bestTouch = 0, bestSpan = 0;
  for (let a = 0; a < n - 1; a++) {
    for (let b = a + 1; b < n; b++) {
      const x1 = px[a], y1 = py[a], x2 = px[b], y2 = py[b];
      const span = x2 - x1;
      const slope = span === 0 ? 0 : (y2 - y1) / span;
      const ok = span >= P.tl_minbars && !(P.tl_classic && (isRes ? slope > 0 : slope < 0));
      if (!ok) continue;
      let touches = 0, contained = true;
      for (let k = 0; k < n; k++) {
        const lv = lineAt(x1, y1, x2, y2, px[k]);
        const diff = py[k] - lv;                 // + = above line
        if (isRes ? diff > tol : diff < -tol) contained = false;
        if (Math.abs(diff) <= tol) touches++;
      }
      const projNow = lineAt(x1, y1, x2, y2, i);
      const relevant = Math.abs(projNow - close) <= P.tl_maxdist * atr;
      const minT = P.tl_allow2 ? 2 : P.tl_mintouch;
      if (contained && relevant && touches >= minT && (touches > bestTouch || (touches === bestTouch && span > bestSpan))) {
        found = true; bx1 = x1; by1 = y1; bx2 = x2; by2 = y2; bestTouch = touches; bestSpan = span;
      }
    }
  }
  return { found, x1: bx1, y1: by1, x2: bx2, y2: by2, touch: bestTouch };
}

const nearAny = (arr, lvl, dist) => lvl != null && arr.some(v => Math.abs(v - lvl) <= dist);

// ── PASS 1: compute per-bar detection state for the whole series ─────────────
function detect(bars) {
  const n = bars.length;
  const atr = atr14(bars);
  const store = new Array(n);

  // trendline pivots
  const phx = [], phy = [], plx = [], ply = [];
  // S&R zones
  const srSup = [], srSupB = [], srSupBrk = [], srRes = [], srResB = [], srResBrk = [];
  // momentum swings
  let lastSwH = null, lastSwL = null;
  // stability + crossover memory
  let prevRx1 = 0, prevRx2 = 0, prevSx1 = 0, prevSx2 = 0;
  let prevClose = null, prevResTop = null, prevSupBot = null;

  const H = i => bars[i].h, L = i => bars[i].l, O = i => bars[i].o, C = i => bars[i].c;

  for (let i = 0; i < n; i++) {
    const a = atr[i] || 0;
    const tol = P.tl_touchtol * a, halfZone = P.tl_zone * a;

    // ---- pivot detection (confirmation lag = plen) ----
    const pv = (len, hi) => {                       // returns center value if bars[i-len] is a pivot
      const c = i - len; if (c < len) return null;
      const cv = hi ? H(c) : L(c);
      for (let k = 1; k <= len; k++) {
        if (hi) { if (!(cv > H(c - k)) || !(cv > H(c + k))) return null; }
        else    { if (!(cv < L(c - k)) || !(cv < L(c + k))) return null; }
      }
      return { cx: c, cv };
    };

    // trendline pivots (tl_plen)
    const ph = pv(P.tl_plen, true), pl = pv(P.tl_plen, false);
    if (ph) { phx.push(ph.cx); phy.push(ph.cv); if (phx.length > P.tl_maxpiv) { phx.shift(); phy.shift(); } }
    if (pl) { plx.push(pl.cx); ply.push(pl.cv); if (plx.length > P.tl_maxpiv) { plx.shift(); ply.shift(); } }

    // S&R pivots (sr_pivLen) — wick-to-body zones
    const sph = pv(P.sr_pivLen, true), spl = pv(P.sr_pivLen, false);
    if (spl) {
      const plv = spl.cv;
      let dup = false;
      for (let z = 0; z < srSup.length; z++) if (plv >= srSup[z] && plv <= srSupB[z]) { dup = true; break; }
      if (!dup) {
        if (srSup.length >= P.sr_maxSR) { srSup.pop(); srSupB.pop(); srSupBrk.pop(); }
        srSup.unshift(plv); srSupBrk.unshift(false);
        let sbv = null, sd = null;
        for (let k = 0; k <= P.sr_pivLen; k++) { const bb = Math.min(O(i - k), C(i - k)); const d = bb - plv; if (d >= 0 && (sd == null || d < sd)) { sd = d; sbv = bb; } }
        srSupB.unshift(sbv == null ? Math.min(O(i - P.sr_pivLen), C(i - P.sr_pivLen)) : sbv);
      }
    }
    if (sph) {
      const prv = sph.cv;
      let dup = false;
      for (let z = 0; z < srRes.length; z++) if (prv >= srResB[z] && prv <= srRes[z]) { dup = true; break; }
      if (!dup) {
        if (srRes.length >= P.sr_maxSR) { srRes.pop(); srResB.pop(); srResBrk.pop(); }
        srRes.unshift(prv); srResBrk.unshift(false);
        let rbv = null, rd = null;
        for (let k = 0; k <= P.sr_pivLen; k++) { const bt = Math.max(O(i - k), C(i - k)); const d = prv - bt; if (d >= 0 && (rd == null || d < rd)) { rd = d; rbv = bt; } }
        srResB.unshift(rbv == null ? Math.max(O(i - P.sr_pivLen), C(i - P.sr_pivLen)) : rbv);
      }
    }
    // broken flags
    for (let z = 0; z < srRes.length; z++) if (!srResBrk[z] && Math.min(O(i), C(i)) > srRes[z]) srResBrk[z] = true;
    for (let z = 0; z < srSup.length; z++) if (!srSupBrk[z] && Math.max(O(i), C(i)) < srSup[z]) srSupBrk[z] = true;

    // momentum swings (mss_len)
    const mh = pv(P.mss_len, true), ml = pv(P.mss_len, false);
    if (mh) lastSwH = mh.cv;
    if (ml) lastSwL = ml.cv;
    const mssUp = lastSwH != null && C(i) > lastSwH;
    const mssDn = lastSwL != null && C(i) < lastSwL;

    // ---- trendlines this bar ----
    const R = bestFit(phx, phy, true,  tol, a, C(i), i);
    const S = bestFit(plx, ply, false, tol, a, C(i), i);
    const rf = R.found, sf = S.found;
    const rStrong = rf && R.touch >= P.tl_mintouch;
    const sStrong = sf && S.touch >= P.tl_mintouch;
    const resLine = rf ? lineAt(R.x1, R.y1, R.x2, R.y2, i) : null;
    const supLine = sf ? lineAt(S.x1, S.y1, S.x2, S.y2, i) : null;
    const resTop = rf ? resLine + halfZone : null;
    const resBot = rf ? resLine - halfZone : null;
    const supTop = sf ? supLine + halfZone : null;
    const supBot = sf ? supLine - halfZone : null;

    const resStable = rf && R.x1 === prevRx1 && R.x2 === prevRx2;
    const supStable = sf && S.x1 === prevSx1 && S.x2 === prevSx2;

    // crossover(close,resTop) / crossunder(close,supBot) using prev-bar values
    const crossUp = prevClose != null && prevResTop != null && resTop != null && prevClose <= prevResTop && C(i) > resTop;
    const crossDn = prevClose != null && prevSupBot != null && supBot != null && prevClose >= prevSupBot && C(i) < supBot;

    const breakUp     = resStable && rStrong && crossUp;
    const breakDn     = supStable && sStrong && crossDn;
    const bounceLong  = sf && sStrong && L(i) <= supTop && C(i) > supTop && C(i) > O(i);
    const bounceShort = rf && rStrong && H(i) >= resBot && C(i) < resBot && C(i) < O(i);

    // confluence: TL aligns with a horizontal S&R level
    const conf = P.conf_atr * a;
    const confRes = nearAny(srRes, resLine, conf);   // break-up long / bounce-short
    const confSup = nearAny(srSup, supLine, conf);   // break-down short / bounce-long
    // at-zone
    let atSup = false, atRes = false;
    for (let z = 0; z < srSup.length; z++) if (C(i) >= srSup[z] && C(i) <= srSupB[z]) { atSup = true; break; }
    for (let z = 0; z < srRes.length; z++) if (C(i) >= srResB[z] && C(i) <= srRes[z]) { atRes = true; break; }
    // nearest non-broken
    let nearRes = null, nearSup = null;
    for (let z = 0; z < srRes.length; z++) if (!srResBrk[z] && srRes[z] >= C(i) && (nearRes == null || srRes[z] < nearRes)) nearRes = srRes[z];
    for (let z = 0; z < srSup.length; z++) if (!srSupBrk[z] && srSup[z] <= C(i) && (nearSup == null || srSup[z] > nearSup)) nearSup = srSup[z];

    store[i] = {
      t: bars[i].t, o: O(i), h: H(i), l: L(i), c: C(i), atr: a,
      sf, supBot, resTop,
      breakUp, breakDn, bounceLong, bounceShort,
      mssUp, mssDn, confRes, confSup, atSup, atRes, nearRes, nearSup,
    };

    prevRx1 = rf ? R.x1 : prevRx1; prevRx2 = rf ? R.x2 : prevRx2;
    prevSx1 = sf ? S.x1 : prevSx1; prevSx2 = sf ? S.x2 : prevSx2;
    prevClose = C(i); prevResTop = resTop; prevSupBot = supBot;
  }
  return store;
}

// ── PASS 2: simulate one config over the detection store ─────────────────────
// cost = { spread (price), slipFrac }.  Net R = gross R − (spread+2·slipFrac·ATR)/risk.
function simulate(store, cfg, cost) {
  const n = store.length;
  const useBreak = cfg.model !== 'bounce', useBounce = cfg.model !== 'break';
  const acc = { n: 0, w: 0, l: 0, grossWin: 0, grossLoss: 0, netR: 0, grossR: 0, costR: 0 };
  const trades = [];
  let i = 1;
  while (i < n) {
    const s = store[i];
    const longBreak   = useBreak  && s.breakUp     && (!cfg.conf || s.confRes) && (!cfg.mss || s.mssUp);
    const longBounce  = useBounce && s.bounceLong  && (!cfg.conf || s.atSup || s.confSup);
    const shortBreak  = useBreak  && s.breakDn     && (!cfg.conf || s.confSup) && (!cfg.mss || s.mssDn);
    const shortBounce = useBounce && s.bounceShort && (!cfg.conf || s.atRes || s.confRes);
    const longSig  = (cfg.dir !== 'short') && (longBreak  || longBounce);
    const shortSig = (cfg.dir !== 'long')  && (shortBreak || shortBounce);
    if (!longSig && !shortSig) { i++; continue; }
    const dir = longSig ? 'long' : 'short';
    const a = s.atr, entry = s.c;

    // initial stop (mirror Pine)
    let stop, risk, tp;
    if (dir === 'long') {
      const base = s.sf ? s.supBot : entry - a * P.atrStop;
      stop = Math.min(base - cfg.buf * a, entry - a * 0.5);
      stop = Math.max(stop, entry - a * P.maxStop);
      risk = entry - stop;
      if (!(risk > 0)) { i++; continue; }
      const floorTP = entry + cfg.minRR * risk;
      tp = !cfg.useTp ? null : (s.nearRes == null ? floorTP : Math.max(s.nearRes, floorTP));
    } else {
      const base = s.sf === false && s.resTop == null ? entry + a * P.atrStop : (s.resTop != null ? s.resTop : entry + a * P.atrStop);
      stop = Math.max(base + cfg.buf * a, entry + a * 0.5);
      stop = Math.min(stop, entry + a * P.maxStop);
      risk = stop - entry;
      if (!(risk > 0)) { i++; continue; }
      const floorTP = entry - cfg.minRR * risk;
      tp = !cfg.useTp ? null : (s.nearSup == null ? floorTP : Math.min(s.nearSup, floorTP));
    }

    // walk forward (trail uses PRIOR completed bar's line → no lookahead)
    let outcomeR = null, exitIdx = n - 1;
    for (let k = i + 1; k < n; k++) {
      const pk = store[k - 1], b = store[k];
      if (cfg.trail) {
        if (dir === 'long' && pk.sf && pk.supBot != null) { const cand = pk.supBot - cfg.buf * pk.atr; stop = Math.max(stop, Math.min(cand, b.c)); }
        if (dir === 'short' && pk.resTop != null)         { const cand = pk.resTop + cfg.buf * pk.atr; stop = Math.min(stop, Math.max(cand, b.c)); }
      }
      const hitSL = dir === 'long' ? b.l <= stop : b.h >= stop;
      const hitTP = tp != null && (dir === 'long' ? b.h >= tp : b.l <= tp);
      if (hitSL) { outcomeR = (dir === 'long' ? (stop - entry) : (entry - stop)) / risk; exitIdx = k; break; }
      if (hitTP) { outcomeR = (dir === 'long' ? (tp - entry) : (entry - tp)) / risk; exitIdx = k; break; }
    }
    if (outcomeR === null) { const last = store[n - 1].c; outcomeR = (dir === 'long' ? (last - entry) : (entry - last)) / risk; exitIdx = n - 1; }
    recordTrade(acc, trades, s.t, dir, outcomeR, (cost.spread + 2 * cost.slipFrac * a) / risk, exitIdx - i);
    i = exitIdx + 1;   // flat until the trade closes (pyramiding 0)
  }
  return finalize(acc, trades);
}

// Shared trade accounting + stats (used by both trend and fade engines)
function recordTrade(acc, trades, t, dir, grossR, costR, dur) {
  const net = grossR - costR;
  acc.n++; acc.grossR += grossR; acc.costR += costR; acc.netR += net;
  if (net > 0) { acc.w++; acc.grossWin += net; } else { acc.l++; acc.grossLoss += Math.abs(net); }
  trades.push({ t, dir, grossR, costR, netR: net, dur });
}
// Rebuild stats from a subset of trades (for out-of-sample splitting)
function statsFrom(trades) {
  const acc = { n: 0, w: 0, l: 0, grossWin: 0, grossLoss: 0, netR: 0, grossR: 0, costR: 0 };
  for (const t of trades) {
    acc.n++; acc.grossR += t.grossR; acc.costR += t.costR; acc.netR += t.netR;
    if (t.netR > 0) { acc.w++; acc.grossWin += t.netR; } else { acc.l++; acc.grossLoss += Math.abs(t.netR); }
  }
  return finalize(acc, trades);
}
function finalize(acc, trades) {
  const wr = acc.n ? Math.round(acc.w / acc.n * 1000) / 10 : 0;
  const pf = acc.grossLoss > 0 ? Math.round(acc.grossWin / acc.grossLoss * 100) / 100 : (acc.grossWin > 0 ? Infinity : 0);
  const expR      = acc.n ? Math.round(acc.netR / acc.n * 1000) / 1000 : 0;
  const grossExpR = acc.n ? Math.round(acc.grossR / acc.n * 1000) / 1000 : 0;
  const avgCostR  = acc.n ? Math.round(acc.costR / acc.n * 1000) / 1000 : 0;
  const netRs = trades.map(t => t.netR);
  const sorted = [...netRs].sort((x, y) => y - x);
  const top3 = sorted.slice(0, 3).reduce((s, x) => s + x, 0);
  const worst = Math.round(Math.min(0, ...netRs, 0) * 100) / 100;         // largest single loss (R)
  const netMinusTop3 = Math.round((acc.netR - top3) * 100) / 100;
  const avgDur = acc.n ? Math.round(trades.reduce((s, t) => s + t.dur, 0) / acc.n) : 0;
  let eq = 0, peak = 0, maxDD = 0;
  for (const r of netRs) { eq += r; if (eq > peak) peak = eq; const dd = peak - eq; if (dd > maxDD) maxDD = dd; }
  maxDD = Math.round(maxDD * 100) / 100;
  return { n: acc.n, w: acc.w, l: acc.l, wr, pf, netR: Math.round(acc.netR * 100) / 100, expR, grossExpR, avgCostR,
    grossWin: acc.grossWin, grossLoss: acc.grossLoss, netMinusTop3, worst, avgDur, maxDD, trades };
}

// ── FADE / mean-reversion engine (high win-rate profile) ─────────────────────
// Enter on a reversal candle at an S&R zone / TL bounce; TIGHT take-profit,
// WIDER stop → hits the small target often (high WR) but the rare stop is big.
function simulateFade(store, cfg, cost) {
  const n = store.length;
  const acc = { n: 0, w: 0, l: 0, grossWin: 0, grossLoss: 0, netR: 0, grossR: 0, costR: 0 };
  const trades = [];
  let i = 1;
  while (i < n) {
    const s = store[i];
    const longFade  = (cfg.dir !== 'short') && s.c > s.o && (s.atSup || s.bounceLong);
    const shortFade = (cfg.dir !== 'long')  && s.c < s.o && (s.atRes || s.bounceShort);
    if (!longFade && !shortFade) { i++; continue; }
    const dir = longFade ? 'long' : 'short';
    const a = s.atr, entry = s.c;
    let stop, tp, risk;
    if (dir === 'long') {
      stop = entry - cfg.slATR * a; risk = entry - stop;
      const zoneTP = s.nearRes;
      tp = cfg.useZoneTP && zoneTP != null ? Math.min(entry + cfg.tpATR * a, zoneTP) : entry + cfg.tpATR * a;
    } else {
      stop = entry + cfg.slATR * a; risk = stop - entry;
      const zoneTP = s.nearSup;
      tp = cfg.useZoneTP && zoneTP != null ? Math.max(entry - cfg.tpATR * a, zoneTP) : entry - cfg.tpATR * a;
    }
    if (!(risk > 0)) { i++; continue; }
    let outR = null, exitIdx = n - 1;
    for (let k = i + 1; k < n; k++) {
      const b = store[k];
      const hitSL = dir === 'long' ? b.l <= stop : b.h >= stop;
      const hitTP = dir === 'long' ? b.h >= tp : b.l <= tp;
      if (hitSL) { outR = (dir === 'long' ? (stop - entry) : (entry - stop)) / risk; exitIdx = k; break; }  // SL-first
      if (hitTP) { outR = (dir === 'long' ? (tp - entry) : (entry - tp)) / risk; exitIdx = k; break; }
    }
    if (outR === null) { const last = store[n - 1].c; outR = (dir === 'long' ? (last - entry) : (entry - last)) / risk; exitIdx = n - 1; }
    recordTrade(acc, trades, s.t, dir, outR, (cost.spread + 2 * cost.slipFrac * a) / risk, exitIdx - i);
    i = exitIdx + 1;
  }
  return finalize(acc, trades);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const bridge = await import('./broker_ctrader.mjs');
  await bridge.connect();
  const fromMs = Date.now() - YEARS * 365 * 24 * 3600 * 1000;
  const windowDays = TF === 'H1' ? 20 : TF === 'M15' ? 8 : 60;

  const configs = [
    { name: 'DEFAULT (both,conf,mss,2R TP)',    model: 'both',   dir: 'both',  conf: true,  mss: true,  useTp: true,  trail: true },
    { name: 'ride: both + conf+mss (no TP)',    model: 'both',   dir: 'both',  conf: true,  mss: true,  useTp: false, trail: true },
    { name: 'ride: both, no gates (no TP)',     model: 'both',   dir: 'both',  conf: false, mss: false, useTp: false, trail: true },
    { name: 'ride: both + conf only (no TP)',   model: 'both',   dir: 'both',  conf: true,  mss: false, useTp: false, trail: true },
    { name: 'ride: break + gates (no TP)',      model: 'break',  dir: 'both',  conf: true,  mss: true,  useTp: false, trail: true },
    { name: 'ride: bounce + conf (no TP)',      model: 'bounce', dir: 'both',  conf: true,  mss: false, useTp: false, trail: true },
    { name: 'ride: long only + gates (no TP)',  model: 'both',   dir: 'long',  conf: true,  mss: true,  useTp: false, trail: true },
    { name: 'ride: short only + gates (no TP)', model: 'both',   dir: 'short', conf: true,  mss: true,  useTp: false, trail: true },
    { name: 'ride: 3R TP floor (both+gates)',   model: 'both',   dir: 'both',  conf: true,  mss: true,  useTp: true,  trail: true, minRR: 3.0 },
  ].map(c => ({ buf: P.buf, minRR: P.minRR, ...c }));

  // --focus = run only the backtest-winning config (long-only ride + gates)
  // --mode=fade = high win-rate mean-reversion sweep (tight TP / wider SL)
  const FOCUS = argv.includes('--focus');
  const MODE = arg('mode', 'trend');
  let runConfigs, simFn;
  if (MODE === 'fade') {
    simFn = simulateFade;
    runConfigs = [];
    for (const dir of ['both', 'long'])
      for (const tpATR of [0.5, 0.75, 1.0])
        for (const slATR of [2.0, 3.0])
          runConfigs.push({ name: `fade ${dir.padEnd(5)} TP${tpATR} SL${slATR}`, dir, tpATR, slATR, useZoneTP: false });
  } else {
    simFn = simulate;
    runConfigs = FOCUS ? configs.filter(c => c.name.startsWith('ride: long only')) : configs;
  }

  // aggregate across instruments per config (a low-frequency swing edge earns
  // trust from a diversified basket, not per-instrument frequency)
  const agg = new Map();   // cfgName -> { n, gw, gl, netR, syms, pos }
  for (const c of runConfigs) agg.set(c.name, { n: 0, gw: 0, gl: 0, netR: 0, syms: 0, pos: 0 });

  const out = { ts: new Date().toISOString(), tf: TF, years: YEARS, params: P, focus: FOCUS, perSymbol: {} };

  for (const sym of SYMS) {
    let bars;
    try { bars = await bridge.getTrendbars(sym, { period: TF, fromMs, windowDays }); }
    catch (e) { console.log(`\n${sym}: ERROR ${e.message}`); continue; }
    if (!bars || bars.length < 200) { console.log(`\n${sym}: only ${bars ? bars.length : 0} bars — skipped`); continue; }
    const span = `${new Date(bars[0].t).toISOString().slice(0, 10)}→${new Date(bars[bars.length - 1].t).toISOString().slice(0, 10)}`;
    const store = detect(bars);
    const spread = SPREAD_OVR ? parseFloat(SPREAD_OVR) : (SPREADS[sym] ?? median(bars.map(b => b.c)) * 0.00008);
    const cost = { spread, slipFrac: SLIP_FRAC };

    const yearsSpan = (bars[bars.length - 1].t - bars[0].t) / (365 * 24 * 3600 * 1000);
    const OOS = argv.includes('--oos');
    console.log(`\n═══ ${sym} ${TF}  (${bars.length} bars, ${span})  spread=${spread} slip=${SLIP_FRAC}×ATR ═══`);
    const rows = [];
    if (OOS) {
      const day = t => new Date(t).toISOString().slice(0, 10);
      console.log('  config                      │  IN-SAMPLE (1st half)          │  OUT-OF-SAMPLE (2nd half)');
      console.log('                              │   n  WR%   PF    netR  n−t3   │   n  WR%   PF    netR  n−t3');
      for (const cfg of runConfigs) {
        const r = simFn(store, cfg, cost);
        const tsAll = r.trades.map(t => t.t).sort((a, b) => a - b);
        const split = tsAll[Math.floor(tsAll.length / 2)] || 0;
        const A = statsFrom(r.trades.filter(t => t.t < split));
        const B = statsFrom(r.trades.filter(t => t.t >= split));
        const fmt = x => `${String(x.n).padStart(4)} ${String(x.wr).padStart(4)} ${String(x.pf === Infinity ? 'inf' : x.pf).padStart(5)} ${String(x.netR).padStart(7)} ${String(x.netMinusTop3).padStart(5)}`;
        console.log(`  ${cfg.name.padEnd(27)} │ ${fmt(A)}  │ ${fmt(B)}`);
        rows.push({ cfg: cfg.name, split: day(split), inSample: { ...A, trades: undefined }, oos: { ...B, trades: undefined } });
      }
      console.log(`  (split at ~${day(bars[Math.floor(bars.length / 2)].t)})`);
      out.perSymbol[sym] = { bars: bars.length, span, spread, oos: true, rows };
      continue;
    }
    console.log('  config                             n  /yr   WR%  netPF  netExpR    netR  maxDD  worst  net−top3');
    for (const cfg of runConfigs) {
      const r = simFn(store, cfg, cost);
      rows.push({ cfg: cfg.name, ...r, trades: undefined });
      const pf = r.pf === Infinity ? '  inf' : String(r.pf).padStart(5);
      const perYr = yearsSpan > 0 ? (r.n / yearsSpan).toFixed(1) : '  -';
      console.log(`  ${cfg.name.padEnd(33)} ${String(r.n).padStart(3)} ${String(perYr).padStart(4)}  ${String(r.wr).padStart(5)}  ${pf}   ${String(r.expR).padStart(6)}  ${String(r.netR).padStart(7)}  ${String(r.maxDD).padStart(5)}  ${String(r.worst).padStart(5)}  ${String(r.netMinusTop3).padStart(7)}`);
      const A = agg.get(cfg.name); A.n += r.n; A.gw += r.grossWin; A.gl += r.grossLoss; A.netR += r.netR; A.syms++; if (r.netR > 0) A.pos++;
    }
    out.perSymbol[sym] = { bars: bars.length, span, spread, slipFrac: SLIP_FRAC, rows };
  }

  // ── AGGREGATE ACROSS THE BASKET (the real sample size for a swing edge) ──
  if (!argv.includes('--oos')) {
  console.log(`\n═══ BASKET AGGREGATE across ${Object.keys(out.perSymbol).length} instruments (${TF}, ${YEARS}y) ═══`);
  console.log('  config                             totalN   aggPF    aggNetR   +syms');
  const aggRows = [...agg.entries()].map(([name, a]) => ({
    name, n: a.n, pf: a.gl > 0 ? Math.round(a.gw / a.gl * 100) / 100 : (a.gw > 0 ? Infinity : 0),
    netR: Math.round(a.netR * 100) / 100, pos: a.pos, syms: a.syms,
  })).sort((x, y) => y.netR - x.netR);
  for (const r of aggRows) {
    const pf = r.pf === Infinity ? '  inf' : String(r.pf).padStart(5);
    console.log(`  ${r.name.padEnd(34)} ${String(r.n).padStart(4)}   ${pf}   ${String(r.netR).padStart(8)}   ${r.pos}/${r.syms}`);
  }
  out.aggregate = aggRows;
  }

  try { writeFileSync(OUT, JSON.stringify(out, null, 2)); console.log(`\nSnapshot → ${OUT}`); } catch (e) { /* dir may not exist locally */ }
  console.log('\nNote: R-multiples. avgDur = bars held (H4 → ×4h). net−top3 = net R with the 3 best trades removed (fragility). SL-first, cost-adjusted.');
  process.exit(0);
}
main().catch(e => { console.error('FATAL:', e.stack); process.exit(1); });
