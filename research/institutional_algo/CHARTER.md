# Institutional Algorithm Project — Charter

## Goal

Research, design, build, and validate a systematic trading algorithm of the kind used by
trading/investment firms — grounded in published research, not retail indicator mashups —
and, **only after explicit user approval**, deploy it on the experiment account
(cTrader demo **2131377**), replacing the current `confirm_runner.mjs` strategy set.

It must be profitable in the plainest sense: **the account's equity grows** — every
evaluation window ends with more money than it started with, after costs. Its win/loss
profile must be asymmetric **by construction**: one loss can never overturn one win, and
one win overturns two or more losses (payoff ratio ≥ 2, min 2:1 R:R on every order).
Long-run mission: compound total profit beyond the account's starting equity (≥100%
return) — tracked on the benchmark dashboard as the destination, but NEVER a reason to
raise risk (the scale_risk moonshot lesson: chasing a dollar target on a weak edge is
how the account got burned before).

## What "institutional-grade" means here (working definition)

- **Evidence first**: every rule traces to a peer-reviewed paper, SSRN/arXiv q-fin preprint,
  or reputable practitioner research (AQR, Man/AHL, CFM, Robeco, journal articles).
  No rule exists because "it looks good on the chart."
- **Economic rationale**: the strategy must have a stated reason the edge exists
  (risk premium, behavioral bias, structural flow) — not just a backtest.
- **Portfolio-level risk**: volatility-targeted position sizing, correlation awareness,
  max-drawdown limits. Sizing is part of the algorithm, not an afterthought.
- **Costs modeled**: spread + slippage per symbol baked into every backtest.
  An edge that dies after costs is not an edge (see: prior 1m-scalping rejection).
- **Anti-overfitting discipline**: hypotheses and pass/fail thresholds are written down
  BEFORE validation runs (pre-registration). Walk-forward / out-of-sample splits mandatory.
  Max 2 redesign cycles per strategy family, then drop it — no threshold-tweaking until green.

## Candidate strategy families (starting list — expand/prune via Phase R evidence)

- Time-series momentum / CTA trend following (Moskowitz–Ooi–Pedersen lineage)
- Cross-sectional momentum across the tradable universe
- Carry (FX forward premium; watch cTrader swap data availability)
- Short-term mean reversion / overnight reversal effects
- Volatility-managed / vol-targeted overlays on any of the above
- Intraday opening-range + relative-volume filters (Zarattini line — already partly validated in-house)

## Infrastructure constraints (design within these)

- Data: OHLCV bars via `fetchBarsResilient` (cTrader broker bars fallback; chart optional).
  cTrader `getTrendbars()` gives deep history. TV getBars caps ~300 bars. bar.t is SECONDS.
- Execution: `scripts/trading/broker_ctrader.mjs` (cTrader Open API). Netting account —
  respect the known bracket-attach and orphan-limit lessons.
- Universe: current scanner symbol list minus permanently blocked symbols
  (WTI, XAGUSD, COPPER, BRENT non-tradable).
- Runs on the Oracle ARM VM (`ubuntu@145.241.220.213`), Node.js, cron-scheduled.
- Hard house rules that apply to ANY strategy: never a position without SL+TP
  (`assertOrderSafety`), min SL distances, Saturday block, EOD flatten conventions,
  fib-veto stays unless evidence overturns it.

## Measurement of success (pre-registered — may be TIGHTENED in SPEC.md, never loosened)

The yardstick is the existing house scorecard, `STRATEGY_BENCHMARK.md` (repo root): same
metrics (WR vs breakeven-for-payoff, TP-hit %, ExpR, PF bands, MaxDD, n), same ledger-truth
rules (`getAllClosedDeals`, bracketed-only). The algorithm is graded in three stages, each
harder to fake than the last.

### Profitability & asymmetry requirements (apply at every stage)

- **Equity growth**: cumulative net P&L after costs > 0 at every stage gate —
  Stage 1: in every OOS fold; Stage 2: over the paper window; Stage 3: since cutover,
  checked at each weekly grading once n ≥ 10.
- **Payoff asymmetry**: average win ≥ 2 × average loss (payoff ratio ≥ 2), so one win
  recovers 2+ losses. Enforced structurally: every order min 2:1 R:R, SL sized so the
  max single-trade loss is capped at 1R — a single loss mathematically cannot erase a
  single win.
- **Win rate with margin**: at 2R payoff the breakeven WR is 33.3%; require **WR ≥ 40%**
  so the asymmetry produces growth, not breakeven churn.
- **Long-run mission (tracked, not a gate)**: compound to total profit ≥ starting equity
  (≥100% return), visible in `benchmark_history.jsonl` deltas. Explicitly NOT to be
  reached by raising risk — risk per trade is fixed in SPEC.md and immutable like the
  other thresholds.

### Stage 1 — OOS backtest, cost-inclusive (gate into paper trading)

- PF ≥ 1.5 on the out-of-sample folds combined (house PASS bar; 1.5–1.75 = "good" band)
- ExpR ≥ +0.2R per trade after spread+slippage (the edge_replay-validated bar)
- n ≥ 100 OOS trades (backtest samples are cheap; PF is unstable below ~100)
- Robustness: PF ≥ 1.25 in EVERY walk-forward fold / regime split — no single-regime
  carry. (The chart-fanatic strategies died exactly here: failed the OOS regime split.)
- Recovery factor ≥ 2 (net gain over the test period ÷ MaxDD)

### Stage 2 — Paper forward run, ≥5 trading days (gate into cutover approval)

- Signal fidelity: ≥ 90% of live signals match what the backtest engine says should have
  fired on the same bars (this is the live↔backtest gap meter — the system's historical
  #1 killer: SCAN-CONFLUENCE backtested PF 2.30 and traded 0.97 live)
- Assumed costs hold: observed spread at signal times ≤ the cost model's assumption

### Stage 3 — Live demo on acct 2131377 (ongoing verdict after cutover)

- Enters `strategy_benchmark.mjs` as a named entrant; graded weekly with the roster
- Success = **PASS** grade: n ≥ 25 & ExpR > 0 & PF ≥ 1.5, from the broker ledger
- Live-vs-backtest ratio: live PF ÷ backtest PF ≥ 0.7 (below that = the same gap that
  killed prior strategies; trips a review, not a silent grind-on)
- Must outperform the entrants it replaced over the same window (they currently grade
  CUT/WATCH/IDLE — a low bar, but it must actually clear it)
- TP-hit % tracked and reported (operator's stated primary success metric)
- Confirmed at n ≥ 100: grade holds → project succeeded; grade decays → autopsy + report

**Failure is a measured outcome too:** if no candidate family clears Stage 1, the project
ends with a findings report. That counts as the benchmark working, not the project failing.

## Phases and exit gates

### Phase R — Research

Survey the literature. For each source record: claim, market/universe, sample period,
effect size after costs, decay/crowding evidence, implementability with our data.
Sources: WebSearch/WebFetch (SSRN, arXiv q-fin, journals, AQR/Man papers), and the
NotebookLM trading library if authenticated (`nlm login`).

**Gate R→D:** `NOTES.md` has ≥10 quality sources summarized AND a shortlist of ≤3
strategy families ranked by (evidence strength × fit to our infra). Write the shortlist
rationale, then CHECKPOINT: summarize for the user before starting Phase D.

### Phase D — Design

Full spec in `SPEC.md`: exact signal math, universe, timeframe/rebalance cadence,
vol-targeted sizing formula, entry/exit + SL/TP logic (never-naked compliant),
per-symbol cost model, portfolio risk limits, kill-switch behavior.
Also restate the Measurement-of-success thresholds in `SPEC.md` — they may be tightened
there but NOT loosened, and may not be edited after Phase B starts.

**Gate D→B:** CHECKPOINT — present SPEC.md summary to the user; proceed on approval
or after 1 loop-iteration pause with no objection recorded.

### Phase B — Build

Implement under `scripts/trading/institutional/` reusing the existing broker bridge and
bar fetchers. Include: dry-run mode (signals logged, no orders), unit tests for signal
math, and a jsonl signal log compatible with existing tooling.

**Gate B→V:** `node --check` clean, tests pass, dry-run over recent history produces
sane, hand-verifiable signals.

### Phase V — Validate

1. Cost-aware backtest with walk-forward / OOS splits per the pre-registered plan.
2. Grade against Stage 1 of the Measurement-of-success section.
3. Signal-only paper run on the VM for ≥5 trading days alongside the current experiment,
   graded against Stage 2.

**Gate V→C:** Stage 1 AND Stage 2 criteria met. If a family fails: record the autopsy in
NOTES.md, take the next shortlisted family (max 2 redesign cycles per family). If all
shortlisted families fail: STOP the loop and deliver a full findings report — a true
negative is a valid project outcome.

### Phase C — Cutover (NEVER autonomous)

**Requires the user to explicitly say "go" in a live conversation.** Then:
pause the `confirm_runner.mjs` cron (comment out, don't delete), deploy the new runner
on acct 2131377 with a file-based kill switch (`rm` a flag file = halt), keep the Notion
trade journal wired, and monitor daily against Stage 3. The scanner account (2118552)
is untouched.

## Loop mechanics

- State file: `PROGRESS.md` in this directory. Every iteration appends:
  timestamp (UTC), phase, what was done, evidence/result, next planned step.
- One meaningful unit of work per iteration (e.g. "read + summarize 2 papers",
  "implement the sizing module", "run walk-forward split 3") — not "do the phase."
- Verify before recording: claims in PROGRESS.md must cite a file, command output, or URL.
- Stuck rule: same step failing 3 consecutive iterations → stop the loop, write a
  blocker report at the top of PROGRESS.md.
- Scope rule: unrelated system problems found along the way (scanner outage etc.) get
  NOTED in PROGRESS.md, not fixed, unless they block this project's current step.

## Hard boundaries

- Demo accounts only. No live-money account is ever touched by this project.
- No orders placed in Phases R–V (dry-run/paper only). Orders only after the Phase C "go".
- Never modify `market_scanner.mjs`, `confirm_runner.mjs`, or risk params — cutover
  pauses the old cron; it does not edit the old code.
- Pre-registered validation thresholds are immutable once Phase B starts.
