/**
 * prop_sim.mjs — Monte-Carlo prop-firm challenge simulator.
 *
 * Answers the only questions that matter for getting funded:
 *   • Given an edge (per-trade win rate + win/loss in R) and a firm's rules,
 *     what's my PROBABILITY OF PASSING?
 *   • What risk-per-trade MAXIMISES that probability (before the daily-loss /
 *     max-drawdown rules knock me out)?
 *   • Is it +EV after the challenge fee?
 *
 * Key truths this makes concrete:
 *   • Without a real edge, pass-prob ≈ target/(target+maxDD) and EV is NEGATIVE
 *     after fees — that's the firm's business model.
 *   • For the SAME expectancy, a HIGHER win rate (lower variance) passes far
 *     more reliably than a low-WR / big-winner profile. Variance is the enemy.
 *   • Over-sizing risk raises the drawdown-bust rate faster than the pass rate —
 *     there is an optimal risk, and it's usually small.
 *
 * Rules modelled (FTMO-style defaults; override any):
 *   Phase target(s), max daily loss (from day-start balance, % of initial),
 *   max total drawdown (static from initial), optional 2-step, optional time cap.
 *
 * Usage:
 *   node scripts/trading/prop_sim.mjs                         # defaults + edge sweep
 *   node scripts/trading/prop_sim.mjs --wr=0.55 --winR=1.55 --lossR=1
 *   node scripts/trading/prop_sim.mjs --target=8 --daily=4 --maxdd=6 --steps=1
 */
const argv = process.argv.slice(2);
const arg = (k, d) => { const a = argv.find(x => x.startsWith(`--${k}=`)); return a ? +a.split('=')[1] : d; };

// ── Presets ──────────────────────────────────────────────────────────────────
// Tradovate/futures-style 25k eval: dollar rules, TRAILING drawdown, no daily
// loss, effectively 1 phase. Numbers are typical for a $25k futures eval
// (Apex/Tradeify-class: ~$1,500 target, ~$1,500 trailing) — CONFIRM your firm's.
const PRESET = (argv.find(x => x.startsWith('--preset=')) || '').split('=')[1] || '';
const isL25 = PRESET === 'tradeify25kL';   // CONFIRMED rules 2026-07-10: Tradeify Lightning 25k
const isFut25 = PRESET === 'tradovate25k' || PRESET === 'fut25' || isL25;

// ── Firm rules (FTMO-style % defaults, or futures $ preset) ──────────────────
const ACCOUNT   = arg('account', isFut25 ? 25000 : 100000);
const FEE       = arg('fee', isL25 ? 300 : isFut25 ? 150 : 500);
const STEPS     = arg('steps', isFut25 ? 1 : 2);
const TARGET_USD = arg('targetUSD', isFut25 ? 1500 : 0);
const MAXDD_USD  = arg('maxddUSD', isL25 ? 1000 : isFut25 ? 1500 : 0);
const TARGET1   = TARGET_USD ? TARGET_USD / ACCOUNT * 100 : arg('target', 10);
const TARGET2   = arg('target2', STEPS === 2 ? 5 : 0);
const DAILY     = arg('daily', isFut25 ? 0 : 5);        // 0 = no daily loss limit
const MAXDD     = MAXDD_USD ? MAXDD_USD / ACCOUNT * 100 : arg('maxdd', 10);
const TRAILING  = isFut25 || argv.includes('--trailing'); // futures DD trails the peak
// EOD trailing: the DD floor is (best END-OF-DAY balance − maxDD$); it only
// ratchets up at day close, but a breach still triggers INTRADAY if equity
// touches the current floor. Gentler than intraday-high-water trailing.
const EOD_TRAIL = isL25 || argv.includes('--eodtrail');
// Consistency rule: best single day's profit must be ≤ CONSIST × total profit
// at the moment you claim the target/payout — forces small, steady days.
const CONSIST   = arg('consist', isL25 ? 0.20 : 0);
// Trail lock: the DD floor stops rising once it reaches start + TRAILCAP$.
// Tradeify Lightning 25k: broker autoLiq shows trailingMaxDrawdownLimit=25100
// → floor caps at start+$100 (confirmed via API 2026-07-10).
const TRAILCAP  = arg('trailcap', isL25 ? 100 : Infinity);
const TPD       = arg('tpd', 3);
const MAXDAYS   = arg('maxdays', isFut25 ? 0 : 60);     // futures evals: no time cap
const SIMS      = arg('sims', 30000);

// ── Edge (per-trade). lossR positive; a loss subtracts lossR×risk. ───────────
const WR    = arg('wr', null);                  // if given, run this single edge
const WINR  = arg('winR', 2.0);
const LOSSR = arg('lossR', 1.0);
const RISK  = arg('risk', null);                // if given, run this single risk %

// simple RNG
const rnd = () => Math.random();

// One phase: returns { pass, reason, days }
function runPhase(targetPct, wr, winR, lossR, riskPct) {
  const start = ACCOUNT;
  const riskDollars = riskPct / 100 * ACCOUNT;   // fixed-fractional on INITIAL balance
  const targetEq = start * (1 + targetPct / 100);
  const ddFloorStatic = start * (1 - MAXDD / 100);
  const dailyLoss = DAILY / 100 * start;
  let bal = start, peak = start, eodPeak = start;
  let bestDay = 0;
  let day = 0;
  while (MAXDAYS === 0 ? day < 400 : day < MAXDAYS) {
    day++;
    const dayStart = bal;
    for (let t = 0; t < TPD; t++) {
      bal += (rnd() < wr ? winR : -lossR) * riskDollars;
      if (bal > peak) peak = bal;
      const refPeak = EOD_TRAIL ? eodPeak : peak;                              // EOD trail ratchets only at day close
      const ddFloor = TRAILING
        ? Math.min(refPeak - MAXDD / 100 * start, start + TRAILCAP)            // floor locks at start+cap
        : ddFloorStatic;                                                       // breach still checked intraday
      if (bal <= ddFloor) return { pass: false, reason: 'maxdd', days: day };
      if (DAILY > 0 && bal <= dayStart - dailyLoss) return { pass: false, reason: 'daily', days: day };
      if (bal >= targetEq) {
        if (!CONSIST) return { pass: true, reason: 'target', days: day };
        const bd = Math.max(bestDay, bal - dayStart);
        if (bd <= CONSIST * (bal - start)) return { pass: true, reason: 'target', days: day };
        // consistency not yet satisfied → keep trading (target effectively 5× best day)
      }
    }
    if (bal - dayStart > bestDay) bestDay = bal - dayStart;
    if (bal > eodPeak) eodPeak = bal;
  }
  return { pass: false, reason: 'timeout', days: day };
}

// Full challenge (both phases must pass); returns aggregate stats over SIMS
function simulate(wr, winR, lossR, riskPct) {
  let pass = 0, failDaily = 0, failDD = 0, failTimeout = 0, totalDays = 0;
  const daysToPass = [];
  for (let s = 0; s < SIMS; s++) {
    const p1 = runPhase(TARGET1, wr, winR, lossR, riskPct);
    let ok = p1.pass, days = p1.days, reason = p1.reason;
    if (ok && STEPS === 2 && TARGET2 > 0) { const p2 = runPhase(TARGET2, wr, winR, lossR, riskPct); ok = p2.pass; days += p2.days; reason = p2.reason; }
    totalDays += days;
    if (ok) { pass++; daysToPass.push(days); }
    else if (reason === 'daily') failDaily++;
    else if (reason === 'maxdd') failDD++;
    else failTimeout++;
  }
  daysToPass.sort((a, b) => a - b);
  const medDays = daysToPass.length ? daysToPass[Math.floor(daysToPass.length / 2)] : 0;
  return {
    passPct: pass / SIMS * 100,
    failDailyPct: failDaily / SIMS * 100,
    failDDPct: failDD / SIMS * 100,
    failTimeoutPct: failTimeout / SIMS * 100,
    medDays,
    feePerPass: pass ? FEE / (pass / SIMS) : Infinity,     // $ of fees burned per funded account
  };
}

function pct(x) { return x.toFixed(1).padStart(5); }

const tgtStr = TARGET_USD ? `$${TARGET_USD}` : `${TARGET1}%${STEPS === 2 ? `+${TARGET2}%` : ''}`;
const ddStr = MAXDD_USD ? `$${MAXDD_USD}` : `${MAXDD}%`;
console.log(`\n═══ PROP CHALLENGE SIM ═══  $${(ACCOUNT / 1000)}k  ${STEPS}-step  target=${tgtStr}  daily=${DAILY > 0 ? DAILY + '%' : 'none'}  maxDD=${ddStr}${TRAILING ? (EOD_TRAIL ? ' EOD-TRAILING' : ' TRAILING') : ' static'}${CONSIST ? `  consistency≤${CONSIST * 100}%/day` : ''}  ${TPD} trades/day  ${MAXDAYS ? MAXDAYS + 'd cap' : 'no time cap'}  fee=$${FEE}  n=${SIMS}`);
console.log(`(risk% is of the $${(ACCOUNT / 1000)}k account → 1% = $${(ACCOUNT / 100).toFixed(0)}/trade of risk)`);

// Edge profiles to compare (same expectancy where noted → shows variance effect)
const E = (wr, w, l) => wr * w - (1 - wr) * l;
const PF = (wr, w, l) => (wr * w) / ((1 - wr) * l);
const profiles = WR != null
  ? [{ name: 'custom', wr: WR, winR: WINR, lossR: LOSSR }]
  : [
      { name: 'edge_replay-like (WR55, 1.55R)', wr: 0.55, winR: 1.55, lossR: 1.0 },
      { name: 'trend-follower  (WR35, 3.0R)',   wr: 0.35, winR: 3.0,  lossR: 1.0 },
      { name: 'high-WR fade    (WR85, 0.17R)',  wr: 0.85, winR: 0.17, lossR: 1.0 },
      { name: 'NO EDGE         (WR50, 1.0R)',   wr: 0.50, winR: 1.0,  lossR: 1.0 },
    ];
const risks = RISK != null ? [RISK] : [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0];

for (const p of profiles) {
  console.log(`\n■ ${p.name}   expectancy=${E(p.wr, p.winR, p.lossR).toFixed(3)}R  PF=${PF(p.wr, p.winR, p.lossR).toFixed(2)}`);
  console.log('   risk%   pass%  failDaily%  failMaxDD%  timeout%  medDays  $fee/pass');
  let best = null;
  for (const r of risks) {
    const s = simulate(p.wr, p.winR, p.lossR, r);
    if (!best || s.passPct > best.passPct) best = { r, ...s };
    console.log(`   ${String(r).padStart(4)}   ${pct(s.passPct)}   ${pct(s.failDailyPct)}     ${pct(s.failDDPct)}     ${pct(s.failTimeoutPct)}    ${String(s.medDays).padStart(4)}   ${s.feePerPass === Infinity ? '   ∞' : '$' + Math.round(s.feePerPass)}`);
  }
  if (RISK == null) console.log(`   → best pass-prob at risk ${best.r}%: ${best.passPct.toFixed(1)}%  ($${Math.round(best.feePerPass)} fees per funded account)`);
}

console.log(`\nNote: risk% is fixed-fractional on the INITIAL balance. Daily loss from day-start, max DD ${TRAILING ? 'trailing from peak' : 'static from initial'}.`);
console.log('A profile only makes money long-run if pass% is high enough that (P(pass) × funded-account value) > fee. Edge + low variance + right sizing.');
