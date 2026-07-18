# Institutional Algorithm Project — Progress Log

Current phase: **CONCLUDED 2026-07-19** — both families failed Stage 1 (cycles
exhausted); FINDINGS.md delivered; loop stopped per charter. One live lead:
SMORB cost-rational subset (see FINDINGS §4) — pending user decision on the
signal-only paper collector.
Blockers: none.

---

## 2026-07-18 — Iteration 0 (setup)

- Project initialized. Charter written to CHARTER.md.
- Next step: Phase R — first research sweep: time-series momentum survey papers
  (Moskowitz/Ooi/Pedersen 2012 and successors), then breadth-first across the
  candidate families before going deep on any one.

## 2026-07-18 ~19:40 UTC — Iteration 1 (Phase R)

- **Done**: TSMOM literature sweep — 3 sources summarized into NOTES.md:
  (1) Moskowitz/Ooi/Pedersen 2012 (JFE) — 58 futures, 1965–2009, diversified Sharpe
  ≈1.31 gross; (2) Hurst/Ooi/Pedersen 2017 (JPM) — positive every decade 1880–2016 NET
  of simulated costs+2/20 fees, crisis alpha 8/10; (3) decay evidence — SG CTA Trend
  −0.8%/yr 2009–2013 vs +8.0% prior 5y; no formal capacity constraint found but
  regime-dependent.
- **Evidence**: research/institutional_algo/NOTES.md (source links inline); PDF of MOP
  2012 fetched but unreadable locally (no poppler) — HTML sources used instead; RePEc
  fetch blocked by permission hook (noted, not needed).
- **Tensions logged for Phase D**: never-naked rule vs always-in-market TSMOM;
  WR≥40%+payoff≥2 charter rule vs trend-following's typical WR 30–40%; CFD costs ≫
  futures costs.
- **Next step**: Iteration 2 — cross-sectional momentum (Jegadeesh–Titman lineage +
  modern FX/commodity XS-momentum) and FX carry evidence, 2 sources each if possible.

## 2026-07-18 ~20:05 UTC — Iterations 2–4 (Phase R, run inline at user request — "continue, no delay")

- **Done**: 7 more sources → 10/10. Added to NOTES.md: (4) Value & Momentum Everywhere
  (AMP 2013) — XS premia everywhere but our cross-section too thin; (5) Currency
  Momentum (Menkhoff et al. 2012) — FX XS momentum eaten by spreads in majors, demoted;
  (6) Carry (KMPV 2018) — Sharpe 0.74 avg but FX carry negative skew violates charter
  asymmetry → filter only; (7) Vol-Managed Portfolios (Moreira-Muir 2017) — overlay,
  HIGH fit; (8) Zarattini ORB papers — net Sharpe 2.81 stocks-in-play, bracket-native,
  VERY HIGH fit; (9) Market Intraday Momentum (Gao et al. 2018) — independent intraday
  corroboration; (10) Baltas-Kosowski — turnover reduction >1/3, the engineering manual
  for CFD-cost survival.
- **Gate R→D**: MET. Shortlist written to NOTES.md: B (session momentum/ORB w/
  rel-volume) ranked 1 on charter fit + sample velocity; A (vol-targeted multi-lookback
  TSMOM) ranked 2 on evidence depth; C (vol-managed sizing + carry filter) as overlay
  pack only. XS momentum and standalone carry rejected with reasons.
- **Evidence**: NOTES.md sources 4–10 with links; one RePEc fetch permission-blocked
  (immaterial).
- **Next step**: checkpoint with user on shortlist; on approval enter Phase D (SPEC.md).

## 2026-07-18 ~20:20 UTC — Iteration 5 (Gate R→D passed; Phase D begun)

- **Gate R→D**: user approved shortlist, chose **both families in parallel** —
  head-to-head Stage 1 validation.
- **Done**: SPEC.md v0 written — SMORB (Family B: 15-min OR, relVol≥1.5 + relRange≥1.0
  in-play gate, stop-entry, SL=opposite OR side, TP=2R, one/symbol-session) and
  TREND-PB (Family A: unanimous 21/63/252d sign blend recomputed weekly, pullback-to-
  EMA20/1×ATR entry on H4 resume, SL=2×ATR, TP=2R, max 6 positions) + shared sizing
  (1% vol-scaled, never up), carry filter as Family C overlay, walk-forward plan
  (60% IS / 40% OOS in 4 folds), frozen thresholds restated.
- **Open items logged**: (1) TREND-PB vs EOD flatten rules — needs user decision at
  D→B; (2) empirical per-symbol cost table from broker; (3) M5 history depth check;
  (4) exact session-open UTC times from orb_runner.
- **Evidence**: research/institutional_algo/SPEC.md.
- **Next step**: open item #2/#3 — SSH to VM, measure per-symbol spreads (live quotes
  or logs) and probe cTrader M5 history depth for the SMORB universe.

## 2026-07-18 ~20:50 UTC — Iteration 6 (Phase D, open item #3 resolved)

- **Done**: depth/tradability probe run on VM (scanner acct env). All 6 SMORB symbols
  enabled, tradingMode 0. M5 ≥ 3y everywhere (indices' M5 starts 3–4y back, metals/
  crypto ≥ 4y). D1: XAUUSD/BTC/ETH → 2018-07; indices → 2023-05 only (~1.3y of
  signal-ready data after the 252d lookback burn-in — TREND-PB index sleeve will be
  sample-limited; FX expected deeper, unprobed).
- **Method notes**: bridge `send` is not exported → no live spot subscription without
  touching live code; cost measurement will use realized close-deal execPrice vs M1
  mid instead (better evidence anyway). SSH gotcha: use Windows-style key path
  (`-i "C:/Users/..."`) WITH `MSYS_NO_PATHCONV=1` or Windows OpenSSH can't find the key.
- **Evidence**: probe output in session log; probe script archived at
  research/institutional_algo/ia_probe_depth.mjs; VM copy removed after run.
- **Next step**: open item #2 — realized-cost table: pull last ~30d closed deals per
  symbol (getAllClosedDeals, both accts), compare execPrice to M1 bar mid at exec
  minute → per-symbol effective spread+slippage estimate; also D1 depth for the FX
  universe in the same script.

## 2026-07-18 ~21:05 UTC — Iteration 7 (Phase D, open item #2 resolved)

- **Done**: realized-cost probe on BOTH accounts (45d of real fills, 14 symbols with
  n≥3). Cost table written into SPEC §3 with pre-registered rule: round-trip =
  2×max(medDev, p75Dev/2). Highlights: EURUSD 2 bps r/t, majors 4–5, XAUUSD 6,
  US30 6, SPX500/NAS100 4, BTCUSD 15, USDCHF 9 (flagged — fat p75 tail). Swap costs
  still placeholder estimates (verify in Stage-2 paper run).
- **Also**: FX D1 depth confirmed ≥ 8 years for all 13 TREND-PB FX pairs (probe was
  request-limited at 8y; XAUUSD/BTC/ETH same). Only indices are short (2023-05).
- **Evidence**: probe output in session log; script archived at
  research/institutional_algo/ia_probe_costs.mjs; VM copy removed.
- **Remaining open items**: #1 (TREND-PB vs EOD flatten — USER DECISION at D→B gate),
  #4 (pin session-open UTC times from orb_runner — read-only, local).
- **Next step**: resolve #4 from orb_runner.mjs source, then Gate D→B checkpoint
  (present SPEC summary + open item #1 decision to user).

## 2026-07-18 ~21:20 UTC — Iteration 8 (Gate D→B PASSED; Phase B begins)

- **Done**: open item #4 resolved (Asia 00:00 UTC / London 07:00 UTC fixed per
  orb_runner house convention; NY = 09:30 America/New_York tz-resolved for BTC/ETH).
  Gate D→B checkpoint presented; **user approved build** and decided open item #1:
  **TREND-PB positions EXEMPT from EOD flatten** — ride to server-side brackets incl.
  weekends; backtest must model gap-through-bracket fills at next bar open; EOD-cron
  config change deferred to the Phase C checklist. SPEC marked APPROVED, §5
  thresholds now FROZEN.
- **Evidence**: SPEC.md header + §2 EOD block updated; AskUserQuestion answers in
  session log.
- **Next step**: Phase B unit 1 — scaffold `scripts/trading/institutional/`:
  `lib.mjs` (cost table from SPEC §3, session defs, bar fetch helpers, gap-aware
  bracket-fill simulator) with unit tests. Signal functions MUST be pure (same code
  path for backtest and live — that IS the Stage-2 fidelity requirement).

## 2026-07-18 ~21:35 UTC — Iteration 9 (Phase B unit 1: shared lib + tests)

- **Done**: created `scripts/trading/institutional/lib.mjs` — pure module (no I/O):
  frozen COST_RT_BPS table (SPEC §3), SESSIONS defs, DST-aware nyOpenUtcMs, ema/atr
  (Wilder)/median, gap-aware `simulateBracket` (open-beyond-level fills at bar open;
  both-touch = LOSS per house convention), `netR` cost deduction. Plus
  `lib.test.mjs`: **12 tests, all pass** (`node --test scripts/trading/institutional/`)
  — covers DST boundary (13:30Z summer / 14:30Z winter), gap-through-SL at −3R,
  both-touch loss, cost-in-R math, unknown-symbol throw.
- **Evidence**: test run output `# pass 12 / fail 0` in session log.
- **Next step**: Phase B unit 2 — `smorb.mjs`: pure signal function
  (computeSmorbSignal(sessionBars5m, history) → null | {direction, entry, sl, tp,
  relVol, relRange}) + tests with synthetic sessions.

## 2026-07-18 ~21:50 UTC — Iteration 10 (Phase B unit 2: SMORB signal module)

- **Done**: `scripts/trading/institutional/smorb.mjs` — pure: orWindow (15-min OR,
  tolerates 1 missing M5 bar), smorbGate (relVol≥1.5 & relRange≥1.0 vs 20-session
  medians, ≥10 sessions history required), resolveSmorbEntry (first-breakout-wins
  stop semantics, gap fills at bar open, both-sides-in-one-bar = ambiguous → NO
  trade), computeSmorbSignal (composes; SL = far OR side, TP = 2R). 9 new tests —
  **21/21 total pass** incl. gap-entry slippage, ambiguous bar, 3h expiry, data-gap
  refusal, short-before-long ordering.
- **Evidence**: `node --test scripts/trading/institutional/` → pass 21 / fail 0.
- **Next step**: Phase B unit 3 — `trendpb.mjs`: pure TREND-PB signal (weekly
  unanimous 21/63/252d sign blend; pullback-to-EMA20/1×ATR detection; H4 resume
  entry; SL 2×ATR beyond pullback extreme; TP 2R) + synthetic tests.

## 2026-07-18 ~22:05 UTC — Iteration 11 (Phase B unit 3: TREND-PB signal module)

- **Done**: `scripts/trading/institutional/trendpb.mjs` — pure: trendScore
  (unanimous 21/63/252d signs), detectPullback (EMA20 touch OR ≥1×ATR retrace,
  5-bar recency window), detectResumption (directional H4 close with progress),
  computeTrendPbSignal (SL = min(entry−2×ATR, pullback extreme), TP = 2R).
- **Bug caught by tests before it reached the backtest**: retrace originally
  compared bar lows to the window-global 20d high → every grinding uptrend
  false-flagged as "in pullback". Fixed to as-of-bar reference extreme. This is
  exactly the class of bug that creates phantom backtest edges.
- **Evidence**: `node --test scripts/trading/institutional/` → **pass 30 / fail 0**
  (12 lib + 9 smorb + 9 trendpb).
- **Next step**: Phase B unit 4 — `institutional_backtest.mjs`: data-driven engine
  (fetch M5/H4/D1 via bridge on VM; walk sessions/H4 closes; call the SAME pure
  signal fns; resolve via simulateBracket; net R via cost table; emit per-fold
  metrics vs SPEC §5 thresholds + jsonl trade log). Also add vol-overlay sizing and
  portfolio caps (max 6 concurrent, ≤2/currency) inside the engine loop.

## 2026-07-18 ~22:25 UTC — Iteration 12 (Phase B unit 4: backtest engine built)

- **Done**: `metrics.mjs` (computeMetrics incl. maxDD/recovery/payoff; time-based
  splitFolds 60/40×4; gradeStage1 vs FROZEN §5 — thresholds hardcoded with a
  do-not-edit banner) + 5 tests. `institutional_backtest.mjs`: --fetch phase (VM:
  M5×3y for 6 SMORB syms, H4+D1×6y for 19 TREND syms → JSON cache in
  /home/ubuntu/trading-data/ia_cache) and --run phase (pure: walks sessions/H4
  closes, calls the SAME pure signal modules, OR-history assembled with no
  look-ahead, Saturday entry block, SMORB 20:00 UTC EOD force-exit, TREND-PB rides
  brackets w/ per-night swap deduction, portfolio caps 6/2-per-ccy chronological).
  Output: ia_backtest_summary.json + ia_backtest_trades.jsonl.
- **Test-data bug caught**: my "passing book" fixture assigned folds by i%4 while
  alternating W/L by i%2 → all losses landed in odd folds; grader correctly failed
  it. Fixed fixture (contiguous 30-trade folds). Grader logic unchanged.
- **Evidence**: `node --check` clean; **35/35 tests pass**.
- **Next step**: deploy institutional/ to VM, run `--fetch` (est. 10–20 min, run
  under nohup), then `--run` for the first full walk-forward result. IS results are
  calibration-only; OOS grades are the Stage-1 verdict. NOTE: engine currently uses
  spec-default gates (relVol 1.5 etc.) — any calibration happens on IS only, and
  only by editing smorb.mjs constants via a documented IS-calibration commit.

## 2026-07-18 ~22:40 UTC — Iteration 13 (Phase B: deployed to VM, fetch running)

- **Done**: scp'd scripts/trading/institutional/ to VM; `node --check` clean on VM;
  launched `--fetch` under nohup (scanner acct env, output →
  /home/ubuntu/trading-data/ia_fetch.log, cache → trading-data/ia_cache/).
  Verified live: XAUUSD M5 = 211,788 bars fetched in 75s; process running.
- **Gotcha logged**: `A && B && nohup C & sleep; head` backgrounds the WHOLE chain —
  the ssh session is now held until fetch ends (harmless here: nohup + redirect
  means fetch survives ssh death; the held session doubles as a completion signal).
- **Next step**: when fetch completes (~15 min), run `--run` on VM → first full
  walk-forward result; scp summary + trades jsonl back; review IS vs OOS.

## 2026-07-18 ~23:15 UTC — Iterations 14–15 (first walk-forward + autopsy + fixes)

- **Fetch complete**: 44/44 caches (M5 ~211k bars/symbol; BTC 281k). Tests pass
  35/35 ON THE VM. Self-match footgun hit AGAIN (while-pgrep loop matched its own
  cmdline; killed with [b]racket trick — memory pattern confirmed twice now).
- **Run 1 (raw)**: SMORB OOS PF 0.86 / ExpR −0.11 / WR 41% / payoff 1.22 (n=198);
  TREND-PB IS ExpR **−7.15** ← mechanically impossible → autopsy on worst trades:
  (1) corrupt NZDCAD H4 bar (o=23.1 on 0.81 pair) → single −763R fake fill;
  (2) EURGBP long held **614 nights** (no signal-based exit) → 2.4R swap bleed.
- **Fixes**: engine bar-sanity filter (drop non-positive / >50%-jump opens);
  TREND-PB **signal-flip exit** = Family A redesign cycle 1 (logged in SPEC §2).
- **Run 2 (clean)**: SMORB unchanged (OOS PF 0.86, folds [1.25, 0.87, 0.93, 0.36]);
  TREND-PB now honest: IS ExpR −0.20 PF 0.61; OOS ExpR −0.23 PF 0.57 WR 29%
  payoff 1.43 (n=181), all folds < 1. **Both families FAIL Stage 1 as-specced.**
- **Charter position**: SMORB → IS-only calibration is allowed & next (per-symbol/
  session breakdown, gate threshold sweep ON IS ONLY, then single OOS re-verdict);
  TREND-PB → 1 redesign cycle remains, then drop per charter.
- **Next step**: SMORB IS breakdown by symbol×session (does any subset carry the
  edge, as in-house ORB found gold@Asia did?) + relVol/relRange sweep on IS.

## 2026-07-19 ~00:00 UTC — Iterations 16–17 (SMORB IS analysis + failed cycle-1 redesign)

- **IS breakdown (original config)**: dose-dependent in-play effect CONFIRMED —
  PF 0.80→1.34 monotone as relVol gate 1.5→3.0, ExpR +0.20 at rv≥3 (n=36 IS).
  Positive configs: XAUUSD@ASIA (PF 1.28), NAS100@ASIA (1.20); bleeders:
  US30@ASIA (0.42), BTCUSD@NY (0.57). Outcome mix: TP avg +1.61R, SL avg −1.39R
  → ~0.4R/loss of slippage+cost drag beyond the −1R design (tight ORs on CFDs).
- **Family B redesign cycle 1 (SPENT, negative result)**: evaluated all 6 symbols
  × all 3 sessions with per-session OR-history (correctness fix kept). Aggregate
  WORSENED (rv≥3: PF 0.92 vs 1.34) — added session-pairs are bleeders; the
  original fixed assignment (from the house 90d ORB backtest) was information.
- **Analysis tool**: institutional/ia_analyze_smorb.mjs (repo + VM).
- **Charter state**: Family A: 1 cycle left. Family B: 1 cycle left.
- **Next step**: Family B cycle 2 (FINAL): Asia cluster only (XAUUSD/NAS100/
  SPX500@ASIA) + cost-rationality floor (skip sessions where OR range makes
  round-trip cost > 0.15R) + single IS-chosen relVol gate. Then the ONE OOS
  verdict. If it fails → both families' cycles exhausted → STOP per charter and
  write the findings report.

## 2026-07-19 ~00:20 UTC — Iteration 18 (Family B FINAL VERDICT: FAIL, n-infeasible)

- **Cycle 2 executed** via strict filtering (ia_cycle2_verdict.mjs; pre-stated
  selection rule written into the script BEFORE any OOS look). Result: **NO
  eligible config** — every rv×costFloor combo projects OOS n < 100 (best: 36).
- **Key finding (positive but unusable under frozen thresholds)**: the
  cost-rational subset (costR ≤ 0.2, Asia cluster) shows **IS PF 1.91, ExpR
  +0.47R, n=54** — the strongest numbers in the project. The in-play + cheap-OR
  edge appears REAL but occurs ~2-3×/week across 3 configs → cannot reach n≥100
  in a 14-month OOS window. Failure mode = sample scarcity, not absent edge.
- **Charter state**: Family B cycles EXHAUSTED → verdict FAIL (Stage 1
  n-infeasible on available data). Family A: 1 cycle remains.
- **Next step**: Family A cycle 2 (FINAL): FX-majors+gold universe (deep history,
  lowest costs), pullback depth cap ≤50% of the trend leg (house fib-veto
  evidence: ≥61.8% retrace = reversal risk), then re-run → final verdict → write
  the findings report and STOP the loop per charter (checkpoint user with
  options: longer paper-collection for the SMORB cost-rational subset, wider
  session universe, or accept the negative).

## 2026-07-19 ~00:50 UTC — Iterations 19–20 (PROJECT CONCLUDED)

- **Family A cycle 2 (FINAL)**: majors+gold universe + 50% pullback-depth cap
  (36/36 tests). Verdict: **FAIL** — OOS PF 0.57, ExpR −0.245R, WR 27%, all folds
  <1, n=88. Both families' redesign budgets exhausted.
- **FINDINGS.md delivered** — validated negative, no cutover; confirm_runner
  untouched. Key structural causes: CFD cost/slippage tax (−1.39R realized
  losses), TSMOM breadth requirement, edge scarcity vs frozen n≥100.
- **User approved the paper collector**: ia_paper_runner.mjs deployed to VM,
  smoke-tested (SMOKE-OK), cron installed
  (`*/10 0-2,7-9,13-17 * * 1-5`, scanner env, signal-only → ia_paper_signals.jsonl
  and ia_paper.log). Grade vs frozen thresholds when collected n ≥ 100 (~2-3 months).
- **Memory saved**: project_institutional_algo.md. Loop STOPPED per charter.

## 2026-07-19 ~01:30 UTC — Post-conclusion addendum (user-driven "continue")

- **Widened-universe cross-sectional OOS test**: 7 new index CFDs probed; 6 with
  usable M5 (UK100/EUSTX50/FRA40/GER40/JP225/AUS200; HK50 no qualifying trades).
  Frozen config on never-fitted symbols: **n=232, PF 0.82, ExpR −0.12R — FAIL**;
  only GER40 positive (n=17, noise). 1.5× cost stress: PF 0.74.
- **Conclusion**: the SMORB lead does not generalize; XAU/NAS/SPX IS numbers
  down-weighted to probable small-sample selection. Paper collector (already
  live, zero-risk) is the final arbiter for the original cluster. NO further
  universe searches — multiple-comparisons trap. FINDINGS.md §5b added.
