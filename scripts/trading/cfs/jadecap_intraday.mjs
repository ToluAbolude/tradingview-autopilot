/**
 * jadecap_intraday.mjs — Jade Cap "Intraday Liquidity & Volatility Model"
 * (Chart Fanatics). Rules: strategies/chart_fanatics/raw/intraday-liquidity-volatility-model.md
 *
 * Mechanized on H1 (playbook confirms on 15m/5m or the 1H FVG — the 1H variant
 * maps directly; an M15 pass runs where history allows):
 *  • Session liquidity: previous day's high/low, Asia (00–06 UTC) high/low,
 *    London (07–11 UTC) high/low.
 *  • Raid: one of those levels is taken out during the NY window (13:30–16:30
 *    UTC ≈ 9:30–11:30 ET).
 *  • Confirmation:
 *      mss — price closes back through the raided level (failed breakout);
 *      fvg — an opposing FVG forms after the raid → LIMIT entry at its midpoint.
 *  • SL beyond the sweep extreme. TP = nearest opposite session liquidity.
 *  • Intraday variant force-exits at ~19:00 UTC ("exit around midday / avoid
 *    afternoon chop"); swing variant rides to TP/SL.
 *  • Optional daily bias: H1 EMA-500 — fade raids only against it.
 */

const NY_START = 13.5, NY_END = 16.5;   // UTC
const EOD_HOUR = 19;                    // intraday force-exit (UTC)
const REJECT_WITHIN = 3;                // bars for the reclaim after a raid
const FVG_WITHIN = 6;                   // bars for an FVG to form after a raid
const EXPIRY = 8;                       // bars an FVG limit stays working
const BUF_ATR = 0.15;
const EMA_LEN = 500;

export const meta = {
  name: 'Jade Cap — Intraday Liquidity & Volatility (session raid → MSS/FVG)',
  defaultTf: 'H1',
  note: 'Raids of PDH/PDL + Asia/London H-L in the NY window; TP = opposite session liquidity.',
};

export const configs = [
  { name: 'mss bias eod',    confirm: 'mss', bias: true,  eod: true },
  { name: 'mss bias swing',  confirm: 'mss', bias: true,  eod: false },
  { name: 'mss noBias eod',  confirm: 'mss', bias: false, eod: true },
  { name: 'fvg bias eod',    confirm: 'fvg', bias: true,  eod: true },
  { name: 'fvg bias swing',  confirm: 'fvg', bias: true,  eod: false },
];

const hourUTC = t => { const d = new Date(t); return d.getUTCHours() + d.getUTCMinutes() / 60; };
const dayKey = t => new Date(t).toISOString().slice(0, 10);

export function signals(bars, atr, cfg) {
  const n = bars.length;
  const sigs = [];

  const ema = new Array(n).fill(null);
  { const k = 2 / (EMA_LEN + 1); let e = bars[0].c;
    for (let i = 0; i < n; i++) { e = bars[i].c * k + e * (1 - k); if (i >= EMA_LEN) ema[i] = e; } }

  // first index after i (same day) whose UTC hour ≥ EOD_HOUR — intraday exit
  const eodIdx = i => {
    const dk = dayKey(bars[i].t);
    for (let k = i + 1; k < n; k++) {
      if (dayKey(bars[k].t) !== dk) return k;
      if (hourUTC(bars[k].t) >= EOD_HOUR) return k;
    }
    return n - 1;
  };

  let curDay = null, dayHi = null, dayLo = null, pdh = null, pdl = null;
  let asiaHi = null, asiaLo = null, ldnHi = null, ldnLo = null;
  let raidHi = null, raidLo = null;   // { level, extreme, start }

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

    // ── raid detection inside the NY window
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

    // ── confirmation → short after an upside raid
    if (raidHi) {
      raidHi.extreme = Math.max(raidHi.extreme, b.h);
      const expired = i - raidHi.start > (cfg.confirm === 'fvg' ? FVG_WITHIN : REJECT_WITHIN);
      const stop = raidHi.extreme + BUF_ATR * a;
      const tps = dnLevels.filter(L => L < b.c).sort((x, y) => y - x);
      if (expired) raidHi = null;
      else if ((!cfg.bias || bear) && tps.length) {
        if (cfg.confirm === 'mss' && b.c < raidHi.level && b.c < b.o) {
          const entry = b.c, risk = stop - entry;
          raidHi = null;
          if (risk > 0 && entry - tps[0] > 0) {
            const sig = { i, dir: 'short', entry, stop, tp: tps[0], label: 'raid-short' };
            if (cfg.eod) sig.timeExit = eodIdx(i);
            sigs.push(sig);
          }
        } else if (cfg.confirm === 'fvg' && i >= raidHi.start + 2 && bars[i - 2].l > b.h) {
          const mid = (bars[i - 2].l + b.h) / 2;              // bearish FVG midpoint
          const risk = stop - mid;
          raidHi = null;
          if (risk > 0 && mid - tps[0] > 0) {
            const sig = { i, dir: 'short', limit: mid, expiry: EXPIRY, stop, tp: tps[0], label: 'raid-fvg-short' };
            if (cfg.eod) sig.timeExit = eodIdx(i);
            sigs.push(sig);
          }
        }
      }
    }

    // ── confirmation → long after a downside raid
    if (raidLo) {
      raidLo.extreme = Math.min(raidLo.extreme, b.l);
      const expired = i - raidLo.start > (cfg.confirm === 'fvg' ? FVG_WITHIN : REJECT_WITHIN);
      const stop = raidLo.extreme - BUF_ATR * a;
      const tps = upLevels.filter(L => L > b.c).sort((x, y) => x - y);
      if (expired) raidLo = null;
      else if ((!cfg.bias || bull) && tps.length) {
        if (cfg.confirm === 'mss' && b.c > raidLo.level && b.c > b.o) {
          const entry = b.c, risk = entry - stop;
          raidLo = null;
          if (risk > 0 && tps[0] - entry > 0) {
            const sig = { i, dir: 'long', entry, stop, tp: tps[0], label: 'raid-long' };
            if (cfg.eod) sig.timeExit = eodIdx(i);
            sigs.push(sig);
          }
        } else if (cfg.confirm === 'fvg' && i >= raidLo.start + 2 && bars[i - 2].h < b.l) {
          const mid = (bars[i - 2].h + b.l) / 2;              // bullish FVG midpoint
          const risk = mid - stop;
          raidLo = null;
          if (risk > 0 && tps[0] - mid > 0) {
            const sig = { i, dir: 'long', limit: mid, expiry: EXPIRY, stop, tp: tps[0], label: 'raid-fvg-long' };
            if (cfg.eod) sig.timeExit = eodIdx(i);
            sigs.push(sig);
          }
        }
      }
    }
  }
  return sigs;
}
