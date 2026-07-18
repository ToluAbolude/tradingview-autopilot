# SPEC v0 — Institutional Algorithm (Families A + B in parallel)

Status: **APPROVED at Gate D→B 2026-07-18** (user approved build; EOD decision:
TREND-PB exempt, rides brackets). Thresholds in §5 are now **FROZEN** — Phase B has
started; per CHARTER they may no longer be edited.

## 1. Family B — Session Momentum ORB ("SMORB")

Evidence: Zarattini/Barbon/Aziz (SSRN 4729284, 4416622), Gao et al. 2018, in-house ORB
paper test (XAUUSD@Asia +4R, PF 3.0, n=5).

- **Universe**: XAUUSD, US30, NAS100, SPX500, BTCUSD, ETHUSD. Sessions per in-house ORB
  evidence: XAUUSD+US30+NAS100 @ Asia open, SPX500 @ London open; BTC/ETH @ NY open
  (memory: BTC NY-open momentum papers). One trade max per symbol-session.
- **Opening range (OR)**: first 15 minutes of session (3 × M5 bars): OR_high, OR_low,
  OR_vol = summed volume.
- **"In play" gate (the institutional filter — trade only when attention is abnormal)**:
  relVol = OR_vol / median(OR_vol, prior 20 sessions) ≥ **1.5**, AND
  relRange = (OR_high−OR_low) / median(same, 20 sessions) ≥ **1.0**.
  No gate pass → no trade that session. (Calibrate both ONLY on in-sample split.)
- **Entry**: stop order at OR_high + 1 tick (long) / OR_low − 1 tick (short), first
  breakout direction wins; order expires 3h after session open if untriggered.
- **SL**: opposite side of the OR. If OR range < broker min-SL distance → skip (no
  tightening — tight SLs are a documented house failure mode).
- **TP**: entry ± 2 × (entry − SL) → fixed 2R bracket (charter payoff ≥ 2 structural).
- **EOD**: unresolved positions closed at session-day 20:00 UTC per house convention
  (matches the conservative replay rule already used in the benchmark).
- **Optional D1-trend alignment vote**: OFF in v0 (keep the first test clean).

## 2. Family A — Multi-lookback Trend with Pullback Entries ("TREND-PB")

Evidence: MOP 2012, Hurst/Ooi/Pedersen 2017 (1/3/12m blend), Baltas-Kosowski 2020
(turnover control), Moreira-Muir 2017 (vol overlay).

- **Universe**: full tradable list minus blocked symbols (~20: FX majors/crosses,
  XAUUSD, US30/NAS100/SPX500, BTC/ETH).
- **Trend score** (weekly recompute, Friday close — Baltas-Kosowski turnover control):
  score = mean( sign(r_21d), sign(r_63d), sign(r_252d) ) on D1 closes.
  Tradable trend iff |score| = 1 (all three lookbacks agree). Direction = sign.
- **Entry (converts always-in-market TSMOM to brackets)**: with trend long — wait for
  pullback: low ≤ EMA20(D1) or retrace ≥ 1.0 × ATR14(D1) from 20-day high; then enter
  next H4 close back in trend direction. Mirror for shorts.
- **SL**: 2 × ATR14(D1) beyond entry, beyond the pullback extreme. **TP**: 2R fixed
  (4 × ATR). One position per symbol; re-entry allowed after bracket resolves if trend
  score still unanimous.
- **Portfolio risk**: max 6 concurrent positions; max 2 per currency; skip new entries
  when portfolio open risk > 3R total.
- **Carry filter (Family C)**: FX only — skip if expected swap cost over a 5-day hold
  > 0.3R against the position (cTrader swap rates; carry never generates entries).
- **EOD/weekend — DECIDED at Gate D→B (2026-07-18, user)**: TREND-PB positions are
  **EXEMPT from the EOD loser-flatten** — they ride to their server-side brackets,
  including overnight and over weekends (SL/TP are broker-enforced; never naked).
  Consequences: (1) backtest models NO EOD truncation, but MUST model weekend/
  overnight gap fills — price gapping past SL/TP fills at next bar open, not at the
  bracket price; (2) cutover (Phase C) requires a config change so EOD crons skip
  this runner's positions — implemented behind the kill-switch flag, part of the
  Phase C checklist, NOT touched before then. Saturday entry block still applies
  (house rule — entries, not holds).

## 3. Shared: sizing, costs, execution

- **Risk per trade**: 1.0% of account equity (fixed in spec, immutable), scaled by the
  Moreira-Muir overlay: size × min(1, targetVol/realizedVol20d), floor 0.5×. Never
  scaled UP above 1.0%.
- **Cost model — MEASURED 2026-07-18** (probe: `ia_probe_costs.mjs`; both accounts,
  last 45d of real fills; deviation = |closing-deal execPrice − M1 bar close| ≈
  one-way effective cost incl. slippage, since SL/TP/market closes are all in the
  sample). Pre-registered rule: **round-trip cost = 2 × max(medianDev, p75Dev/2)**,
  rounded up; unmeasured symbols get class defaults. Backtest R is net of this table:

  | Symbol | Round-trip (bps) | Basis |
  | --- | --- | --- |
  | EURUSD | 2 | n=13 measured |
  | AUDUSD | 4 | n=19 measured |
  | NZDUSD | 5 | n=7 measured |
  | NZDCAD | 4 | n=25 measured |
  | GBPJPY | 4 | n=13 measured |
  | AUDJPY | 5 | n=16 measured |
  | USDCHF | 9 | n=19 measured (high p75 — flagged) |
  | GBPUSD | 4 | thin (n=5) → FX default |
  | USDJPY / USDCAD / EURGBP / EURJPY | 4 | unmeasured → FX default |
  | GBPNZD | 8 | unmeasured → wide-cross default |
  | XAUUSD | 6 | n=15 measured |
  | SPX500 | 4 | n=10 measured |
  | US30 | 6 | n=21 measured |
  | NAS100 | 4 | n=7 measured |
  | BTCUSD | 15 | n=7 measured (wide p75) |
  | ETHUSD | 20 | thin → crypto default |

  Swap for multi-day TREND-PB holds: placeholder 1 bp/night FX, 2 bp/night indices,
  crypto per broker schedule — ESTIMATE, to be verified against real position swaps
  during the Stage-2 paper run (charter: observed costs must be ≤ model).
- **Execution**: `broker_ctrader.mjs`, brackets attached at placement with
  poll-and-verify (house lesson: silent bracket no-op bug), `assertOrderSafety` +
  fib-veto untouched, per-family file kill switches (`.smorb_live`, `.trendpb_live`).
- **Data**: cTrader `getTrendbars` (M5 for SMORB, D1/H4 for TREND-PB) via
  `fetchBarsResilient`; chart/CDP not required (survives Chrome outages).

### Redesign log (charter: max 2 cycles per family)

- **Family A cycle 1 (2026-07-18)**: added **signal-flip exit** — position closes at
  H4 close when the weekly trend score is no longer unanimous in the trade's
  direction (first run held dead theses 600+ nights, bleeding swap; positions must
  follow the signal, per TSMOM practice). Engine also gained a bar-sanity filter
  after a mis-scaled NZDCAD H4 bar (open 23.1 on a 0.81 pair) fabricated a −763R
  fill — data hygiene, not a strategy change.

## 4. Validation plan (walk-forward, pre-registered)

- **Data window**: max available depth per symbol (target ≥ 2022-01 for M5 where the
  broker allows; D1 much deeper). **In-sample (calibration)**: first 60% of window —
  the ONLY place relVol/relRange thresholds and ATR multiples may be tuned.
  **OOS**: remaining 40% in 4 sequential folds; no parameter changes after IS lock.
- **Engine**: new `institutional_backtest.mjs` following edge_replay's conservative
  conventions (bar touches both SL and TP in same bar = LOSS; entries at next-bar
  open; all R net of cost table).
- **Head-to-head**: A and B graded independently against §5; either, both, or neither
  may pass — passing family/families go to the 5-day paper run (charter Stage 2).

## 5. Frozen thresholds (restated from CHARTER.md — immutable once Phase B starts)

Stage 1 (per family, OOS only, net of costs): PF ≥ 1.5 combined · ExpR ≥ +0.2R ·
n ≥ 100 · PF ≥ 1.25 in EVERY fold · recovery factor ≥ 2 · equity ends above start in
every fold · payoff ratio ≥ 2 · WR ≥ 40%.
Stage 2: ≥ 90% signal fidelity over ≥ 5 trading days; observed spreads ≤ cost model.
Stage 3: benchmark PASS (n ≥ 25, ExpR > 0, PF ≥ 1.5, ledger truth) · live/backtest
PF ratio ≥ 0.7 · beats replaced entrants · net positive since cutover at each weekly
grading once n ≥ 10.

## 6. Open items before Gate D→B

1. TREND-PB vs EOD flatten rules (§2) — needs user/house decision.
2. Empirical per-symbol cost table (§3) — measure from broker, not assumed.
3. ~~M5 history depth~~ **RESOLVED 2026-07-18** (probe: `ia_probe_depth.mjs`, run on
   VM acct 2118552): all 6 SMORB symbols found/enabled/tradingMode 0. M5 depth ≥ 3
   years for all six (indices' M5 ends between 3–4y back; XAUUSD/BTC/ETH ≥ 4y). D1:
   XAUUSD/BTC/ETH from 2018-07; **indices (US30/NAS100/SPX500) D1 only from 2023-05**
   → TREND-PB's 252-day lookback leaves ~1.3y of signal-ready index data; FX D1 depth
   for the full TREND-PB universe still unprobed (folded into open item #2's next run).
4. ~~Session opens~~ **RESOLVED 2026-07-18** (from `orb_runner.mjs:62-65`): Asia =
   00:00 UTC, London = 07:00 UTC (house convention, fixed UTC — orb_runner does not
   track DST; SMORB follows the same convention for comparability). NY (BTC/ETH
   sleeve) = 09:30 America/New_York, timezone-resolved (the NYSE cash open the BTC
   momentum literature keys on — this one DOES shift with DST by design).
