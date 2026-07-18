// Metrics + Stage-1 grading vs the FROZEN thresholds (SPEC.md §5). Pure.

export function computeMetrics(trades) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const rs = trades.map(t => t.netR);
  const wins = rs.filter(r => r > 0), losses = rs.filter(r => r <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  let cum = 0, peak = 0, maxDD = 0;
  for (const r of rs) { cum += r; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }
  const totalR = cum;
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  return {
    n,
    wr: wins.length / n,
    expR: totalR / n,
    pf: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    payoff: avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? Infinity : 0),
    totalR, maxDD,
    recovery: maxDD > 0 ? totalR / maxDD : (totalR > 0 ? Infinity : 0),
  };
}

/** Time-based split: IS = first isFrac of [tStart,tEnd]; OOS remainder in nFolds. */
export function splitFolds(trades, { tStart, tEnd, isFrac = 0.6, nFolds = 4 }) {
  const isEnd = tStart + (tEnd - tStart) * isFrac;
  const is = trades.filter(t => t.entryTs < isEnd);
  const oos = trades.filter(t => t.entryTs >= isEnd);
  const foldMs = (tEnd - isEnd) / nFolds;
  const folds = Array.from({ length: nFolds }, (_, i) =>
    oos.filter(t => t.entryTs >= isEnd + i * foldMs && t.entryTs < isEnd + (i + 1) * foldMs));
  return { is, oos, folds, isEnd };
}

/** Stage-1 verdict vs SPEC §5 (FROZEN — do not edit thresholds here). */
export function gradeStage1({ oos, folds }) {
  const m = computeMetrics(oos);
  const foldMs = folds.map(computeMetrics);
  const checks = {
    'PF >= 1.5 (OOS combined)': m.pf >= 1.5,
    'ExpR >= +0.2R': m.expR >= 0.2,
    'n >= 100': m.n >= 100,
    'PF >= 1.25 in EVERY fold': foldMs.every(f => (f.n ?? 0) > 0 && f.pf >= 1.25),
    'recovery factor >= 2': m.recovery >= 2,
    'equity growth in every fold': foldMs.every(f => (f.totalR ?? 0) > 0),
    'payoff ratio >= 2': m.payoff >= 2,
    'WR >= 40%': m.wr >= 0.4,
  };
  return { pass: Object.values(checks).every(Boolean), checks, oosMetrics: m, foldMetrics: foldMs };
}
