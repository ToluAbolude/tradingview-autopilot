// robustness.mjs — the validation pillars the backtest stack was missing, taken
// from the algo-trading workflow in the reference video (Jesse + AI agent):
//   1. Sharpe ratio (annualized) as a first-class acceptance metric.
//   2. Monte Carlo bootstrap — resample the trade sequence to see whether the
//      observed result sits inside the body of the outcome distribution or out
//      at the lucky best-5% tail (the "is it overfit?" read).
//   3. Entry-edge significance — a sign-permutation test whose null hypothesis
//      is "the entries have no directional edge" (the video's "rule
//      significance test": are the entry rules real or luck?).
//
// Pure (no I/O). Operates on the SAME trade shape metrics.mjs uses:
//   { netR: Number, entryTs: Number(ms) }
// so it composes with computeMetrics/splitFolds on the same book.

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;

/** Deterministic PRNG (mulberry32) so every report is reproducible from a seed. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per-observation Sharpe of a return series: mean / sample-stddev. */
export function sharpe(rs) {
  const n = rs.length;
  if (n < 2) return 0;
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const variance = rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  return sd > 0 ? mean / sd : 0;
}

/** Trades per year implied by the entryTs span (fallback: trade count). */
export function tradesPerYear(trades) {
  const ts = trades.map(t => t.entryTs).filter(Number.isFinite).sort((a, b) => a - b);
  if (ts.length < 2) return trades.length;
  const years = (ts[ts.length - 1] - ts[0]) / MS_PER_YEAR;
  return years > 0 ? trades.length / years : trades.length;
}

/**
 * Annualized Sharpe: per-trade Sharpe scaled by sqrt(trades/year). This is what
 * the video quotes (values ~1.5–1.9). With no usable timestamps it falls back to
 * scaling by sqrt(n), which is only comparable across equal-length books.
 */
export function sharpeAnnualized(trades) {
  const rs = trades.map(t => t.netR);
  return sharpe(rs) * Math.sqrt(tradesPerYear(trades));
}

function percentileOf(sortedAsc, value) {
  // fraction of samples <= value, via binary search
  let lo = 0, hi = sortedAsc.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sortedAsc[mid] <= value) lo = mid + 1; else hi = mid; }
  return lo / sortedAsc.length;
}
function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.round(q * (sortedAsc.length - 1))));
  return sortedAsc[idx];
}

/**
 * Monte Carlo bootstrap: resample trades WITH replacement `iters` times and
 * rebuild totalR / Sharpe / maxDD each time. Returns the observed value, the
 * distribution's median and best-5% (p95), and the observed's percentile within
 * the distribution. Interpretation (matches the video):
 *   - observed Sharpe near the median  => robust, not a lucky draw
 *   - observed Sharpe out near p95      => likely overfit / lucky sample
 *   - maxDD p95 is the drawdown you should plan capital around, not the observed
 */
export function monteCarloBootstrap(trades, { iters = 5000, seed = 12345 } = {}) {
  const n = trades.length;
  if (n < 2) return null;
  const rng = mulberry32(seed);
  const rs = trades.map(t => t.netR);
  const sharpes = new Array(iters), totals = new Array(iters), dds = new Array(iters);
  for (let k = 0; k < iters; k++) {
    let cum = 0, peak = 0, dd = 0;
    const sample = new Array(n);
    for (let i = 0; i < n; i++) {
      const r = rs[(rng() * n) | 0];
      sample[i] = r; cum += r;
      if (cum > peak) peak = cum;
      if (peak - cum > dd) dd = peak - cum;
    }
    totals[k] = cum; dds[k] = dd; sharpes[k] = sharpe(sample);
  }
  const sortAsc = arr => arr.slice().sort((a, b) => a - b);
  const sSorted = sortAsc(sharpes), tSorted = sortAsc(totals), dSorted = sortAsc(dds);

  const obsSharpe = sharpe(rs);
  let cum = 0, peak = 0, obsDD = 0;
  for (const r of rs) { cum += r; if (cum > peak) peak = cum; if (peak - cum > obsDD) obsDD = peak - cum; }

  return {
    iters,
    sharpe: {
      observed: obsSharpe,
      median: quantile(sSorted, 0.5),
      best5pct: quantile(sSorted, 0.95),
      worst5pct: quantile(sSorted, 0.05),
      percentile: percentileOf(sSorted, obsSharpe),
    },
    totalR: {
      observed: cum,
      median: quantile(tSorted, 0.5),
      percentile: percentileOf(tSorted, cum),
      p05: quantile(tSorted, 0.05),
    },
    maxDD: {
      observed: obsDD,
      median: quantile(dSorted, 0.5),
      p95: quantile(dSorted, 0.95), // plan capital around this
    },
  };
}

/**
 * Entry-edge significance via sign permutation. Null hypothesis: the entries
 * carry no directional edge, so each trade's magnitude |R| is equally likely to
 * come out + or −. We flip signs at random `iters` times and count how often the
 * permuted mean R meets or beats the observed mean R. p = (count+1)/(iters+1).
 * p < 0.05 => the realized expectancy is unlikely to be luck given these
 * magnitudes. (Assumes trade outcomes are independent; serial dependence would
 * weaken it — same caveat the video's rule-significance test carries.)
 */
export function signPermutationTest(trades, { iters = 5000, seed = 999 } = {}) {
  const n = trades.length;
  if (n < 2) return null;
  const rng = mulberry32(seed);
  const mags = trades.map(t => Math.abs(t.netR));
  const observedMeanR = trades.reduce((a, t) => a + t.netR, 0) / n;
  let ge = 0;
  for (let k = 0; k < iters; k++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += (rng() < 0.5 ? -mags[i] : mags[i]);
    if (s / n >= observedMeanR) ge++;
  }
  return { observedMeanR, pValue: (ge + 1) / (iters + 1), iters };
}

/**
 * Full robustness verdict against the video's acceptance gates. Thresholds are
 * defaults you can override; they mirror what the video treated as "good":
 *   Sharpe ≥ 1.5, statistically-significant entries (p < 0.05), a sample that is
 *   both large enough (n) and long enough (spanYears) to trust, and a Monte Carlo
 *   that does NOT place the observed Sharpe out at the lucky tail.
 */
export function validate(trades, {
  minSharpe = 1.5, maxPValue = 0.05, minTrades = 100, minSpanYears = 1.0,
  mcOverfitPercentile = 0.95, iters = 5000, seed = 12345,
} = {}) {
  const n = trades.length;
  const spanYears = (() => {
    const ts = trades.map(t => t.entryTs).filter(Number.isFinite).sort((a, b) => a - b);
    return ts.length >= 2 ? (ts[ts.length - 1] - ts[0]) / MS_PER_YEAR : 0;
  })();
  const sharpeAnn = sharpeAnnualized(trades);
  const mc = monteCarloBootstrap(trades, { iters, seed });
  const perm = signPermutationTest(trades, { iters, seed: seed + 1 });

  const checks = {
    [`Sharpe (annualized) >= ${minSharpe}`]: sharpeAnn >= minSharpe,
    [`entry edge significant (p < ${maxPValue})`]: !!perm && perm.pValue < maxPValue,
    [`sample size n >= ${minTrades}`]: n >= minTrades,
    [`data span >= ${minSpanYears}y`]: spanYears >= minSpanYears,
    [`Monte Carlo not lucky-tail (obs Sharpe pct < ${mcOverfitPercentile})`]:
      !!mc && mc.sharpe.percentile < mcOverfitPercentile,
  };
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    metrics: { n, spanYears, sharpeAnnualized: sharpeAnn },
    monteCarlo: mc,
    permutation: perm,
  };
}
