/**
 * fib_veto.mjs — HARD-RULE fib-depth veto for pullback entries (pure module).
 *
 * Backtest basis (fib_backtest.mjs, 2y H1 × 7 symbols, 2,943 resolved legs):
 * once an impulse leg's pullback has retraced ≥ 61.8%, the leg continues only
 * 38.6% of the time (78.6% → 25.8%, 100% → 11.7%). A continuation-direction
 * entry ("buy the dip" in an up-leg / "sell the rally" in a down-leg) is
 * therefore vetoed from 61.8% until the leg resolves (new extreme = continued,
 * close beyond origin = reversed). Counter-trend entries are NOT vetoed — deep
 * retraces favour them. Mirrors strategies/fib_retracement_veto.pine.
 *
 * Leg detection is a verbatim port of the backtest's: fractal pivots (len 5),
 * leg ≥ 3×ATR14, 5–100 bars, price fully contained, one tracked leg at a time.
 *
 * Exports are pure (no broker imports — broker_ctrader.mjs supplies bars).
 */

export const VETO_DEPTH = 0.618;
export const FIB_PCONT = { 0.236: 62.0, 0.382: 54.5, 0.5: 47.0, 0.618: 38.6, 0.786: 25.8, 1.0: 11.7 };

const DEF = { plen: 5, minLeg: 3.0, maxLegBars: 100, maxTrack: 150 };

function atr14(bars) {
  const o = new Array(bars.length).fill(null); let pc = null, a = null; const t = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const tr = pc == null ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    pc = b.c;
    if (i < 14) { t.push(tr); if (i === 13) { a = t.reduce((s, x) => s + x, 0) / 14; o[i] = a; } }
    else { a = (a * 13 + tr) / 14; o[i] = a; }
  }
  return o;
}

function pivotAt(bars, i, hi, plen) {
  const c = i - plen; if (c < plen) return null;
  const cv = hi ? bars[c].h : bars[c].l;
  for (let k = 1; k <= plen; k++) {
    if (hi ? !(cv > bars[c - k].h && cv > bars[c + k].h) : !(cv < bars[c - k].l && cv < bars[c + k].l)) return null;
  }
  return { idx: c, px: cv };
}

/**
 * Replay `bars` (ascending OHLC {t,o,h,l,c}) and return the impulse-leg state
 * at the LAST bar:
 *   { status: 'none'|'tracking'|'continued'|'reversed'|'timeout',
 *     dir: +1 up-leg | -1 down-leg | 0, depth: max retrace 0..n,
 *     ext, org, legAtr, ageBars }
 */
export function fibVetoState(rawBars, opts = {}) {
  const P = { ...DEF, ...opts };
  const bars = (rawBars || []).map(b => ({ ...b, t: b.t < 1e12 ? b.t * 1000 : b.t }));
  if (bars.length < 60) return { status: 'none', dir: 0, depth: 0 };
  const atr = atr14(bars);

  let lastLo = null, lastHi = null, active = null, last = null;
  const lowest = (from, to) => { let v = Infinity; for (let k = from; k <= to; k++) v = Math.min(v, bars[k].l); return v; };
  const highest = (from, to) => { let v = -Infinity; for (let k = from; k <= to; k++) v = Math.max(v, bars[k].h); return v; };

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];

    if (active) {
      const e = active;
      e.minRe = e.dir > 0 ? Math.min(e.minRe, b.l) : Math.max(e.minRe, b.h);
      e.depth = Math.abs(e.ext - e.minRe) / Math.abs(e.ext - e.org);
      const cont = e.dir > 0 ? b.h > e.ext : b.l < e.ext;
      const rev = e.dir > 0 ? b.c < e.org : b.c > e.org;
      if (cont || rev || i - e.startIdx >= P.maxTrack) {
        e.status = cont ? 'continued' : rev ? 'reversed' : 'timeout';
        e.endIdx = i;
        last = e; active = null;
      }
    }

    const ph = pivotAt(bars, i, true, P.plen);
    const pl = pivotAt(bars, i, false, P.plen);
    if (pl) lastLo = pl;
    if (ph) lastHi = ph;
    if (active) continue;

    if (ph && lastLo && lastLo.idx < ph.idx) {
      const L = lastLo.px, H = ph.px, a = atr[ph.idx];
      const legBars = ph.idx - lastLo.idx;
      if (a && H - L >= P.minLeg * a && legBars >= P.plen && legBars <= P.maxLegBars
          && highest(lastLo.idx, ph.idx) <= H && lowest(lastLo.idx, ph.idx) >= L) {
        active = { dir: +1, org: L, ext: H, startIdx: i, legAtr: a,
                   minRe: Math.min(lowest(ph.idx + 1, i), H), status: 'tracking', depth: 0 };
        active.depth = Math.abs(active.ext - active.minRe) / Math.abs(active.ext - active.org);
        continue;
      }
    }
    if (pl && lastHi && lastHi.idx < pl.idx) {
      const Hh = lastHi.px, Ll = pl.px, a = atr[pl.idx];
      const legBars = pl.idx - lastHi.idx;
      if (a && Hh - Ll >= P.minLeg * a && legBars >= P.plen && legBars <= P.maxLegBars
          && lowest(lastHi.idx, pl.idx) >= Ll && highest(lastHi.idx, pl.idx) <= Hh) {
        active = { dir: -1, org: Hh, ext: Ll, startIdx: i, legAtr: a,
                   minRe: Math.max(highest(pl.idx + 1, i), Ll), status: 'tracking', depth: 0 };
        active.depth = Math.abs(active.ext - active.minRe) / Math.abs(active.ext - active.org);
      }
    }
  }

  const n = bars.length - 1;
  const e = active || last;
  if (!e) return { status: 'none', dir: 0, depth: 0 };
  return {
    status: active ? 'tracking' : e.status,
    dir: e.dir, depth: e.depth, ext: e.ext, org: e.org, legAtr: e.legAtr,
    ageBars: n - e.startIdx,
  };
}

/** measured continuation odds for the deepest fib threshold reached */
export function pContinue(depth) {
  let p = 70;                                     // shallower than 23.6% — early
  // sort numerically: JS object iteration puts the integer-like "1" key first
  for (const f of Object.keys(FIB_PCONT).map(parseFloat).sort((a, b) => a - b)) {
    if (depth >= f) p = FIB_PCONT[f];
  }
  return p;
}

/**
 * The hard rule. direction = 'long'|'buy'|'short'|'sell'.
 * Vetoes continuation-direction entries while a tracked leg has retraced
 * ≥ VETO_DEPTH. Never vetoes counter-trend entries.
 */
export function checkFibVeto(state, direction) {
  const dir = (direction === 'long' || direction === 'buy') ? 1 : -1;
  if (!state || state.status !== 'tracking' || state.depth < VETO_DEPTH || state.dir !== dir) {
    return { vetoed: false, state };
  }
  const legTxt = state.dir > 0 ? 'up-leg' : 'down-leg';
  return {
    vetoed: true, state,
    reason: `FIB_VETO ${legTxt} retraced ${(state.depth * 100).toFixed(0)}% (≥61.8%) — continuation odds ≈${pContinue(state.depth)}%; no ${state.dir > 0 ? 'long' : 'short'} pullback entries until the leg resolves`,
  };
}
