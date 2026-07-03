/**
 * stage_analysis.mjs — Ted Zhang "Stage Analysis" (Chart Fanatics), Weinstein
 * stages. Rules source: strategies/chart_fanatics/raw/stage-analysis-strategy.md
 *
 * Weekly framework mapped onto daily bars (10/20/30/40-week SMA ≈ 50/100/150/
 * 200-day SMA):
 *  • Stage 2 = close above all four SMAs, SMA50 > SMA100 > SMA150, SMA50
 *    rising. Stage 4 = mirror (below all, SMA50 < SMA150 < SMA200, falling).
 *  • Entry: daily breakout — close crosses above the prior BASE_LEN-day high
 *    while Stage 2 is active (continuation base). Short mirror in Stage 4.
 *  • Stop below the base low (capped at MAX_STOP_ATR).
 *  • Exit: ride while the stage holds — close crossing back through SMA50 ends
 *    the trade ("reduce or exit when price slices the averages"); fixed 2R/3R
 *    TP variants for comparison.
 */

const BASE_LEN = 20;       // breakout lookback (≈ one month base)
const MAX_STOP_ATR = 4.0;
const BUF_ATR = 0.25;

export const meta = {
  name: 'Ted Zhang — Stage Analysis (Stage-2 breakout / Stage-4 breakdown)',
  defaultTf: 'D1',
  note: 'Weekly SMAs ≈ 50/100/150/200-day. Exit = SMA50 recross (ride) or fixed R.',
};

export const configs = [
  { name: 's2 long ride',   stage: 2, exit: 'sma' },
  { name: 's2 long tp2R',   stage: 2, exit: '2r' },
  { name: 's2 long tp3R',   stage: 2, exit: '3r' },
  { name: 's4 short ride',  stage: 4, exit: 'sma' },
  { name: 'both ride',      stage: 0, exit: 'sma' },
];

function smaArr(bars, len) {
  const out = new Array(bars.length).fill(null);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].c;
    if (i >= len) sum -= bars[i - len].c;
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

export function signals(bars, atr, cfg) {
  const n = bars.length;
  const sigs = [];
  const s50 = smaArr(bars, 50), s100 = smaArr(bars, 100), s150 = smaArr(bars, 150), s200 = smaArr(bars, 200);

  const stage2 = i => s200[i] != null && bars[i].c > s50[i] && bars[i].c > s100[i] && bars[i].c > s150[i] && bars[i].c > s200[i]
                      && s50[i] > s100[i] && s100[i] > s150[i] && s50[i] > s50[i - 5];
  const stage4 = i => s200[i] != null && bars[i].c < s50[i] && bars[i].c < s100[i] && bars[i].c < s150[i] && bars[i].c < s200[i]
                      && s50[i] < s150[i] && s150[i] < s200[i] && s50[i] < s50[i - 5];

  // first bar after i where close recrosses SMA50 against the trade
  const exitAfter = (i, dir) => {
    for (let k = i + 1; k < n; k++) {
      if (s50[k] == null) continue;
      if (dir === 'long' && bars[k].c < s50[k]) return k;
      if (dir === 'short' && bars[k].c > s50[k]) return k;
    }
    return n - 1;
  };

  for (let i = 205; i < n - 1; i++) {
    const b = bars[i], a = atr[i];
    if (!a) continue;
    let hi = -Infinity, lo = Infinity;
    for (let k = i - BASE_LEN; k < i; k++) { hi = Math.max(hi, bars[k].h); lo = Math.min(lo, bars[k].l); }

    if ((cfg.stage === 2 || cfg.stage === 0) && stage2(i) && b.c > hi && bars[i - 1].c <= hi) {
      const entry = b.c;
      const stop = Math.max(lo - BUF_ATR * a, entry - MAX_STOP_ATR * a);
      const risk = entry - stop;
      if (risk > 0) {
        const sig = { i, dir: 'long', entry, stop, tp: null, label: 's2-breakout' };
        if (cfg.exit === 'sma') sig.timeExit = exitAfter(i, 'long');
        else sig.tp = entry + (cfg.exit === '2r' ? 2 : 3) * risk;
        sigs.push(sig);
      }
    }
    if ((cfg.stage === 4 || cfg.stage === 0) && stage4(i) && b.c < lo && bars[i - 1].c >= lo) {
      const entry = b.c;
      const stop = Math.min(hi + BUF_ATR * a, entry + MAX_STOP_ATR * a);
      const risk = stop - entry;
      if (risk > 0) {
        const sig = { i, dir: 'short', entry, stop, tp: null, label: 's4-breakdown' };
        if (cfg.exit === 'sma') sig.timeExit = exitAfter(i, 'short');
        else sig.tp = entry - (cfg.exit === '2r' ? 2 : 3) * risk;
        sigs.push(sig);
      }
    }
  }
  return sigs;
}
