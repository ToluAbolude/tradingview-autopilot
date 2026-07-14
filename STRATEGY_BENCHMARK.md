# Strategy Benchmark — Trading Standards Scorecard

A repeatable benchmark suite for **every unit in this system that decides a trade** — the
trading equivalent of an AI-benchmark leaderboard. Fixed roster of entrants, fixed metrics
computed from the **realised broker ledger** (never the bot's own logs), a grade per entrant,
a backtest baseline each must live up to, an industry-standard reference band, and an
append-only history so every re-run measures improvement against the last run.

Runner: [strategy_benchmark.mjs](scripts/trading/strategy_benchmark.mjs) ·
Latest machine-written snapshot: `/home/ubuntu/trading-data/benchmark_results.md` on the VM ·
Run-over-run history: `/home/ubuntu/trading-data/benchmark_history.jsonl` ·
**Visual dashboard:** <https://claude.ai/code/artifact/c4afdbfe-69be-4367-aca7-7e3555296e03>
(live-vs-backtest PF dumbbell, equity curves, per-symbol P&L, ORB paper test, full graded board)

## How to re-run (on the VM)

```bash
/home/ubuntu/run_confirm_job.sh strategy_benchmark.mjs --phase=confirm   # experiment acct 2131377
/home/ubuntu/run_scanner_job.sh strategy_benchmark.mjs --phase=scanner   # scanner acct 2118552 + ORB replay
/home/ubuntu/run_scanner_job.sh strategy_benchmark.mjs --phase=report    # merge → MD + history append
```

Epoch = **2026-06-29** (the bracket-attach fix — first date both accounts' data is a valid
test; override with `--from=YYYY-MM-DD`). Two phases exist because each cTrader account
needs its own env file.

---

## The entrants (every trade decision-maker)

A collection of sub-signals that can only execute together counts as **one** entrant.

| Entrant | What decides the trade | Venue / account | Status |
|---|---|---|---|
| **SCAN-CONFLUENCE** | The whole scanner voting stack — `market_scanner --scan-only` votes A–Z (trend, S/R zones, FVG, patterns, EMA, MTF…) → score≥threshold + Trifecta gate → `signal_executor`/`inline_trader` → `assertOrderSafety` + fib veto. The votes are not independently executable, so the stack is one entrant. | cTrader **2118552** | LIVE |
| **EXP/wor_break_retest** | WOR break-retest, AUDUSD H1 | cTrader **2131377** | LIVE (demo) |
| **EXP/jackson_gold** | Jackson gold setup, XAUUSD H1 | cTrader 2131377 | LIVE (demo) |
| **EXP/amd_ote** | AMD/OTE (ICT), GBPUSD H1 | cTrader 2131377 | LIVE (demo) |
| **EXP/confluence_trifecta** | Trifecta confluence, EURUSD H1 | cTrader 2131377 | LIVE (demo) |
| **EXP/orb** | Opening-range breakout, NZDCAD M15 | cTrader 2131377 | LIVE (demo) |
| **EXP/wor_break_retest_ntz** | A/B variant: + prior-day-range (NTZ) filter, GBPJPY H1 | cTrader 2131377 | LIVE (demo) |
| **EXP/amd_ote_newsgated** | A/B variant: + high-impact-news gate, USDJPY H1 | cTrader 2131377 | LIVE (demo) |
| **EXP/jadecap_fvg** | JadeCap session-raid → FVG retrace, BTCUSD H1 | cTrader 2131377 | LIVE (demo) |
| **EXP/stage_s2** | Stage-2 daily breakout (3R cap), US30 + ETHUSD D1 | cTrader 2131377 | LIVE (demo) |
| **ORB-SESSIONS** | `orb_runner` session ORB: XAUUSD/US30/NAS100 @ Asia, SPX500 @ London — dry-run; outcomes replayed against real M5 bars | paper (cTrader data) | FORWARD-TEST |
| **TVO-TRADEIFY** | Same ORB signals routed to Tradeify Lightning 25k futures (`broker_tradovate.mjs`, `.tvo_live` kill switch) | Tradovate **55798247** | ARMED 2026-07-10, no fills yet |
| **ZONE-LIMITS** | `zone_limit_runner` — resting limits at active S/R zones | dry-run | FORWARD-TEST, no fills yet |
| **KURISKO-2020** | Kurisko 20/20 bull/bear flag (conditioned slice) | — | BUILT, not scheduled |

## Metrics & industry standards

R = realised net / risk-$ sized at placement. Ledger truth: positions reconciled via
`getAllClosedDeals` (per-position summed nets), not per-symbol queries.

| Metric | Definition | Industry standard / reference |
|---|---|---|
| **WR** (win rate) | closed trades with R > 0 | Meaningless alone — judge against breakeven WR for the payoff: **2R systems break even at 33.3%** (1R: 50%, 3R: 25%). A 2R system needs WR ≳ 40% for a real margin. |
| **TP-hit %** | trades reaching ≥90% of target R | The operator's primary success metric ("TP-hit rate, not trade count"). No external norm; tracked for trend. |
| **ExpR** (expectancy) | mean R per closed trade | > 0 required; **≥ +0.2R/trade** sustained is a solid intraday edge; the system's own validated subset (edge_replay) ran **+0.4R**. |
| **PF** (profit factor) | gross win R / gross loss R | < 1.0 losing · 1.0–1.25 noise/marginal · 1.25–1.5 workable · **1.5–1.75 good** · **> 1.75 strong**. The FundedNext 17k-account study (see RESEARCH notes): consistently-paid funded traders clustered at **PF > 1.75, ≤ 15 trades/wk, 1–3 symbols**. |
| **MaxDD** | peak-to-trough on the cumulative R (or $) curve | Prop-firm hard limits: **Tradeify 25k = $1,000 EOD-trailing (4%)**, FTMO 10%. Professional norm: drawdown smaller than annual gain (recovery factor > 1, ideally > 2). |
| **n** (sample) | closed trades since epoch | **n ≥ 25–30 before grading** (this repo's weekly-review rule matches the common statistical minimum); n ≥ 100 for a stable PF estimate. Anything under ~10 is anecdote. |
| **Consistency** | largest day / total profit | Tradeify enforces **20%** — relevant to TVO-TRADEIFY payouts. |
| Sharpe / Sortino | risk-adjusted daily returns | > 1 acceptable, > 2 good. **Not yet computed** — the valid-data window (since 2026-06-29) is too short for a meaningful daily series; add once ~60 trading days exist. |

Grades (same thresholds as the Friday weekly review): **PASS** = n≥25 & ExpR>0 & PF≥1.5 ·
**EARLY** = n<5 with positive ExpR · **WATCH** = ExpR>0 · **CUT** = ExpR≤0 · **IDLE** = no fills yet.

---

## Snapshot — first benchmark run, 2026-07-11 (epoch 2026-06-29)

| Entrant | Grade | n (open) | WR | TP-hit | Exp/tr | Total | PF | Backtest PF | vs industry standard |
|---|---|---|---|---|---|---|---|---|---|
| SCAN-CONFLUENCE | **CUT** | 39 (0) | 31% | — | -$1 | **-$47** | 0.97 | 2.30 | Below the 33.3% breakeven WR for 2R payoffs; PF in the losing band; huge gap to its own backtest baseline |
| EXP/orb (NZDCAD) | WATCH | 8 (0) | 38% | 0% | +0.02R | +0.14R | 1.03 | 1.81 | PF in the noise band (1.0–1.25); WR clears 2R breakeven by a hair; underperforming baseline |
| EXP/wor_break_retest (AUDUSD) | **CUT** | 2 (0) | 0% | 0% | -1.00R | -2.00R | 0.00 | 2.53 | Worst live-vs-backtest gap on the board; n=2 is anecdote but already weekly-review CUT |
| EXP/confluence_trifecta (EURUSD) | EARLY | 3 (0) | 67% | 33% | +0.36R | +1.08R | **2.05** | 1.87 | Only entrant in the "strong" PF band (>1.75) AND beating its backtest — but n=3 vs the n≥25 standard: not yet evidence |
| EXP/stage_s2 (US30) | CUT | 1 (0) | 0% | 0% | -0.08R | -0.08R | 0.00 | — | n=1; slot exists to validate execution (~1–2 trades/yr by design) |
| EXP/jackson_gold (XAUUSD) | IDLE | 0 | — | — | — | — | — | 2.19 | No bracketed fills since epoch |
| EXP/amd_ote (GBPUSD) | IDLE | 0 | — | — | — | — | — | 1.71 | No bracketed fills since epoch |
| EXP/wor_break_retest_ntz (GBPJPY) | IDLE | 0 | — | — | — | — | — | — | A/B variant — must beat EXP/wor_break_retest live |
| EXP/amd_ote_newsgated (USDJPY) | IDLE | 0 | — | — | — | — | — | — | A/B variant — must beat EXP/amd_ote live |
| EXP/jadecap_fvg (BTCUSD) | IDLE | 0 | — | — | — | — | — | — | Signals emitted but fib-veto/safety-gated so far |
| ORB-SESSIONS *(paper)* | CUT | 15 (0) | 33% | 33% | -0.13R | -2.00R | 0.80 | mixed | Aggregate below standard, but see per-config split below |
| ZONE-LIMITS | IDLE | 0 | — | — | — | — | — | 1.18 | Dry-run: 96 limit placements logged, no fills measurable yet |
| TVO-TRADEIFY | IDLE | 0 | — | — | — | — | — | — | Armed 2026-07-10; graded once fills exist (then also vs Tradeify's 4% trail + 20% consistency) |
| KURISKO-2020 | IDLE | 0 | — | — | — | — | — | 1.35 | Built + validated, not scheduled |

**ORB per config (paper):** XAUUSD@Asia 5tr **+4.00R PF 3.00** · NAS100@Asia 4tr +0.00R PF 1.00 ·
US30@Asia 2tr −2.00R · SPX500@London 4tr **−4.00R (0/4)** — gold is tracking its backtest
(PF 1.59); SPX500-London is diverging from its PF 1.35 baseline and is the config to watch.

**Funnels:** scanner — 57 session checks → 18 no-setup, 8 broker-voided; experiment — 48
signals emitted → 14 placed + bracketed (the rest rejected by order-safety/fib-veto gates,
which is the gates working, not lost trades).

### Read of the first run

1. **Nothing PASSes yet.** No entrant meets n≥25 & PF≥1.5 & ExpR>0. That is the honest
   baseline this benchmark exists to move; per the weekly-review rule, don't add risk to
   chase it.
2. **The live↔backtest gap is the story.** SCAN-CONFLUENCE backtests at PF 2.30 on its
   validated subset but trades at 0.97 live; wor_break_retest 2.53 → 0.00. Execution,
   gating and regime — not signal generation — remain the deficit (consistent with the
   edge_replay finding that the realised -$3k era was execution, not signal).
3. **confluence_trifecta/EURUSD is the one green shoot** — the only unit beating both its
   baseline and the industry "strong" band — but at n=3 it needs ~22 more closed trades
   before it means anything.
4. **Sample sizes are the bottleneck everywhere.** At current fill rates most combos need
   weeks-to-months to reach n=25. That is the cost of the per-strategy isolation design —
   accepted, since attribution is the point.

## How improvement is measured over time

Every `--phase=report` run appends one line per active entrant to
`benchmark_history.jsonl` (`runTs, n, wr, expR/net$, pf, totalR, maxDD`) and the next run's
table shows the delta vs the previous run — same idea as tracking a model's score across
benchmark revisions. Suggested cadence: **weekly, after the Friday weekly review** (the
two share grading thresholds, so a WATCH→PASS flip shows up in both).

## Data-integrity rules (what keeps the benchmark honest)

- **Ledger truth**: all realised results come from `getAllClosedDeals` on the broker, never
  from the bot's own success logs.
- **Valid-test filter**: experiment trades count only when `bracketed === true` and after
  2026-06-29 (pre-fix trades opened naked and were force-closed — scratches, not samples).
- **Conservative paper replay**: ORB dry-run outcomes replayed on real M5 bars; a bar that
  touches both SL and TP counts as a **loss**; unresolved trades exit at the 21:00 UTC
  intraday cutoff.
- **Fixed roster**: entrants with zero fills stay on the board as IDLE so the suite's
  coverage is visible (nothing quietly drops out).

## Known gaps / next steps

- **NotebookLM grounding pending** — the trading-library notebooks (40 strategies + PDF
  playbooks) need re-auth (`nlm login`); once back, pull the library's own performance
  standards in as additional reference bands.
- **Sharpe/Sortino** once ~60 trading days of valid daily returns exist.
- **Scanner R-normalisation** — the scanner is graded in $ because per-trade risk varies;
  joining the ledger to `trades.csv` entry/SL/lots would let it be graded in R like the rest.
- **ZONE-LIMITS fill simulation** — replay whether resting limits would have filled and at
  what R, so the dry-run gets a paper grade like ORB.
- **TVO-TRADEIFY**: once fills exist, grade additionally against Tradeify's own standards
  ($1,000 EOD-trail, 20% consistency, flat by 4:59pm ET).
