# Institutional Algorithm Project — Findings Report (2026-07-19)

## Verdict

**No candidate passed Stage 1. The experiment account keeps its current strategy set —
no cutover.** Under the charter, this is a valid project outcome: the frozen thresholds
did their job and rejected two strategy families that would have lost money live. One
genuine lead survives (see §4) — it needs more sample, not more optimism.

Charter compliance: thresholds never loosened; calibration touched IS data only; both
families used exactly their 2 redesign cycles (logged in SPEC.md); zero orders placed.

## 1. What was tested

- **Family B — SMORB** (session opening-range breakout, relative-volume "in play" gate;
  Zarattini/Gao lineage): 3y of M5 broker bars, 6 symbols, brackets 2R, all costs from
  a table measured off 45 days of real fills.
- **Family A — TREND-PB** (unanimous 1/3/12-month time-series momentum + pullback
  entries; Moskowitz/Hurst lineage, Baltas-Kosowski turnover control): 6y of D1/H4
  broker bars, walk-forward 60/40 with 4 OOS folds.

## 2. Final numbers (OOS, net of measured costs)

| Family | n | PF | ExpR | WR | Fold PFs | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| SMORB (as specced) | 198 | 0.86 | −0.11R | 41% | 1.25 / 0.87 / 0.93 / 0.36 | FAIL |
| SMORB (best honest config) | proj. ~36 | — | IS +0.47R | IS 54% | — | FAIL (n-infeasible) |
| TREND-PB (final config) | 88 | 0.57 | −0.25R | 27% | 0.62 / 0.37 / 0.79 / 0.38 | FAIL |

## 3. Why they failed (measured, not guessed)

1. **Costs and slippage dominate at this scale.** Realized losses averaged −1.39R
   against a −1R design: tight opening ranges on CFDs make spread+gap slippage a
   ~0.4R/trade tax. The literature's edges are quoted on exchange futures/equities
   with opening auctions; our venue pays retail costs.
2. **TSMOM needs breadth we don't have.** The papers diversify across 50–67 futures;
   on ~12 correlated FX pairs + gold, the same signal is noise-dominated (WR 27%
   with payoff 1.5 is exactly "trend following without diversification").
3. **The real edge is rare.** Where the in-play hypothesis worked (high relVol AND
   cost-rational OR), it fired ~2–3×/week across 3 configs — mathematically unable
   to reach n≥100 OOS on 14 months of data.
4. **Engine-level honesty mattered**: a single corrupt feed bar fabricated −763R;
   missing signal-exits bled 614 nights of swap. Both were caught by trade-level
   autopsy before they could masquerade as "strategy performance" in either direction.

## 4. The surviving lead — SMORB cost-rational subset

Asia-session XAUUSD/NAS100/SPX500, relVol ≥ 1.5, round-trip cost ≤ 0.2R:
**IS PF 1.91, ExpR +0.47R/trade, WR 54%, n = 54** — the only configuration in the
project with institutional-quality numbers. It failed Stage 1 ONLY on projected
sample size. Options (none require loosening a threshold):

- **(Recommended) Signal-only paper collector**: run `ia_paper_runner.mjs --smorb`
  on a VM cron for 2–3 months. Signals accumulate in a jsonl; when live-collected
  n ≥ 100, grade against the frozen thresholds. Zero risk, zero orders, experiment
  account untouched.
- **Widen the session universe** (e.g., DAX/FTSE/Nikkei CFDs if tradable on the
  account) to multiply cost-rational sessions — requires a new evidence pass.
- **Accept the negative** and shelve.

## 5. Reusable assets produced

- `scripts/trading/institutional/` — pure signal modules + engine + paper runner,
  **36 unit tests**, all green on Windows and the VM.
- Measured per-symbol cost table (SPEC §3) — useful to EVERY current and future
  strategy, including the live scanner (its backtests assume zero costs).
- 44 cached bar series (3–6y, `/home/ubuntu/trading-data/ia_cache/`).
- The walk-forward + frozen-threshold + redesign-budget methodology itself
  (CHARTER/SPEC/PROGRESS pattern) — reusable for any future strategy candidate.

## 5b. Addendum (2026-07-19, post-report): the lead failed cross-sectional OOS

The widened-universe test was run (user-approved): the frozen config (relVol ≥ 1.5,
costR ≤ 0.2, natural session, 2R brackets) applied to **six index CFDs it was never
fitted on** (UK100, EUSTX50, FRA40, GER40, JP225, AUS200 — 3y M5 each, entire
history OOS by construction):

- **Combined: n = 232, PF 0.82, ExpR −0.12R, WR 38%** — fold PFs 0.32/0.58/0.99/1.22.
- Per symbol: only GER40 positive (PF 1.15 at n = 17 — noise); JP225 worst (0.55).
- 1.5× cost stress: PF 0.74.

**Interpretation**: the in-play/cost-rational edge does NOT generalize. The
XAU/NAS/SPX IS result (PF 1.91, n = 54) must be down-weighted toward what it always
could have been: small-sample selection on the fitted cluster. The paper collector
already running is the correct final arbiter for those three configs (live signals
= true OOS), but the prior is now weak. **Do not run further universe searches** —
scanning markets until one passes is the multiple-comparisons trap this charter
exists to prevent.

## 6. Recommendation summary

1. Keep `confirm_runner` running unchanged (cutover criteria were never met).
2. Approve the SMORB paper collector cron (signal-only) to grow the lead's sample.
3. Treat the measured cost table as the new baseline for ALL backtests in this repo.
4. Do not pursue TSMOM variants on this venue/universe again — the failure is
   structural (breadth + costs), not parametric.
