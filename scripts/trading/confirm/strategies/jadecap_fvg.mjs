/**
 * jadecap_fvg.mjs — Jade Cap "Intraday Liquidity & Volatility Model", live
 * port of the backtest winner config `fvg bias swing` (scripts/trading/cfs/
 * jadecap_intraday.mjs; OOS: basket positive both halves, cfs_jadecap_H1_oos).
 *
 * Model: a session liquidity level (PDH/PDL, Asia 00–06 UTC H/L, London 07–11
 * UTC H/L) gets raided during the NY window (13:30–16:30 UTC); an opposing
 * 3-candle FVG forms within 6 bars; entry when price RETRACES to the FVG
 * midpoint within 8 bars. SL beyond the sweep extreme, TP = nearest opposite
 * session liquidity (own TP — no fixed R). HTF bias = H1 EMA(500): shorts only
 * below it, longs only above. Swing hold (no EOD exit).
 *
 * Live adaptation: the backtest fills a LIMIT at the midpoint; the runner
 * market-fills on the signal bar's close, so the signal only fires if that
 * close is within FILL_TOL×ATR of the midpoint — keeps live fills honest to
 * the backtested prices.
 */

const NY_START = 13.5, NY_END = 16.5;   // UTC raid window
const FVG_WITHIN = 6;                   // bars after raid for the FVG to form
const EXPIRY = 8;                       // bars the retrace stays valid
const BUF_ATR = 0.15;                   // SL buffer beyond sweep extreme
const FILL_TOL = 0.5;                   // close must be within this ×ATR of the FVG mid
const EMA_LEN = 500;

const hourUTC = t => { const d = new Date(t); return d.getUTCHours() + d.getUTCMinutes() / 60; };
const dayKey = t => new Date(t).toISOString().slice(0, 10);

function atr14(bars) {
  const n = bars.length, out = new Array(n).fill(null);
  let prevClose = null, atr = null; const len = 14, trs = [];
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

export default {
  name: 'jadecap_fvg',
  generateSignals(bars, _ctx) {
    const n = bars.length;
    const sigs = [];
    if (n < 50) return sigs;
    const atr = atr14(bars);

    const ema = new Array(n).fill(null);
    { const k = 2 / (EMA_LEN + 1); let e = bars[0].c;
      for (let i = 0; i < n; i++) { e = bars[i].c * k + e * (1 - k); if (i >= Math.min(EMA_LEN, Math.floor(n * 0.8))) ema[i] = e; } }

    let curDay = null, dayHi = null, dayLo = null, pdh = null, pdl = null;
    let asiaHi = null, asiaLo = null, ldnHi = null, ldnLo = null;
    let raidHi = null, raidLo = null;     // { level, extreme, start }
    let pendShort = null, pendLong = null; // { mid, stop, tp, born }

    for (let i = 1; i < n; i++) {
      const b = bars[i], a = atr[i];
      const h = hourUTC(b.t);
      const dk = dayKey(b.t);
      if (dk !== curDay) {
        if (curDay != null && dayHi != null) { pdh = dayHi; pdl = dayLo; }
        curDay = dk; dayHi = b.h; dayLo = b.l;
        asiaHi = null; asiaLo = null; ldnHi = null; ldnLo = null;
        raidHi = null; raidLo = null;
      } else { dayHi = Math.max(dayHi, b.h); dayLo = Math.min(dayLo, b.l); }
      if (h >= 0 && h < 6)  { asiaHi = asiaHi == null ? b.h : Math.max(asiaHi, b.h); asiaLo = asiaLo == null ? b.l : Math.min(asiaLo, b.l); }
      if (h >= 7 && h < 11) { ldnHi = ldnHi == null ? b.h : Math.max(ldnHi, b.h);  ldnLo = ldnLo == null ? b.l : Math.min(ldnLo, b.l); }
      if (!a) continue;

      const bear = ema[i] != null && b.c < ema[i];
      const bull = ema[i] != null && b.c > ema[i];
      const upLevels = [pdh, asiaHi, ldnHi].filter(x => x != null);
      const dnLevels = [pdl, asiaLo, ldnLo].filter(x => x != null);

      // raid detection in the NY window
      if (h >= NY_START && h < NY_END) {
        if (!raidHi) {
          const lvl = upLevels.filter(L => b.h > L && bars[i - 1].h <= L).sort((x, y) => y - x)[0];
          if (lvl != null) raidHi = { level: lvl, extreme: b.h, start: i };
        }
        if (!raidLo) {
          const lvl = dnLevels.filter(L => b.l < L && bars[i - 1].l >= L).sort((x, y) => x - y)[0];
          if (lvl != null) raidLo = { level: lvl, extreme: b.l, start: i };
        }
      }

      // FVG after an upside raid → pending short at the midpoint retrace
      if (raidHi) {
        raidHi.extreme = Math.max(raidHi.extreme, b.h);
        if (i - raidHi.start > FVG_WITHIN) raidHi = null;
        else if (bear && i >= raidHi.start + 2 && bars[i - 2].l > b.h) {   // bearish FVG
          const mid = (bars[i - 2].l + b.h) / 2;
          const stop = raidHi.extreme + BUF_ATR * a;
          const tp = dnLevels.filter(L => L < mid).sort((x, y) => y - x)[0];
          raidHi = null;
          if (tp != null && stop > mid) pendShort = { mid, stop, tp, born: i };
        }
      }
      if (raidLo) {
        raidLo.extreme = Math.min(raidLo.extreme, b.l);
        if (i - raidLo.start > FVG_WITHIN) raidLo = null;
        else if (bull && i >= raidLo.start + 2 && bars[i - 2].h < b.l) {   // bullish FVG
          const mid = (bars[i - 2].h + b.l) / 2;
          const stop = raidLo.extreme - BUF_ATR * a;
          const tp = upLevels.filter(L => L > mid).sort((x, y) => x - y)[0];
          raidLo = null;
          if (tp != null && stop < mid) pendLong = { mid, stop, tp, born: i };
        }
      }

      // retrace to the midpoint → fire the signal on this bar
      if (pendShort) {
        if (i - pendShort.born > EXPIRY || b.h >= pendShort.stop) pendShort = null;
        else if (b.h >= pendShort.mid) {
          const p = pendShort; pendShort = null;
          if (Math.abs(b.c - p.mid) <= FILL_TOL * a && b.c > p.tp)
            sigs.push({ ts: b.t, dir: 'short', entry: b.c, sl: p.stop, tp: p.tp,
                        reason: 'jadecap: NY raid + bearish FVG retrace → opposite liquidity' });
        }
      }
      if (pendLong) {
        if (i - pendLong.born > EXPIRY || b.l <= pendLong.stop) pendLong = null;
        else if (b.l <= pendLong.mid) {
          const p = pendLong; pendLong = null;
          if (Math.abs(b.c - p.mid) <= FILL_TOL * a && b.c < p.tp)
            sigs.push({ ts: b.t, dir: 'long', entry: b.c, sl: p.stop, tp: p.tp,
                        reason: 'jadecap: NY raid + bullish FVG retrace → opposite liquidity' });
        }
      }
    }
    return sigs;
  },
};
