# Trading System Service Map

The reference for splitting the trading system into independent services, so that strategies can be plugged in and run side by side. Read it before adding a runner, a risk rule or a strategy.

Status as of 2026-09-15 (branch `refactor/service-foundations`).

## Goal

A strategy is plugged in as a JavaScript module, as JSON rules, or as a Pine script converted to JavaScript. The system then runs it with the same sizing, safety checks, execution, exit management and reporting as every other strategy. Several strategies can run on the same or different instruments, and on the same account.

## Ground rules

- **Services are module boundaries, not network services.** Everything runs on one VM, and many of the worst outages were infrastructure (CDP, cTrader tokens, cTrader connect). Putting HTTP between sizing and stop placement adds failure modes and no benefit. Separate processes exist only where they already do: cron jobs and daemons that talk through files.
- **Shared logic lives in `scripts/trading/lib/`.** Import it. Never re-type an asset-class regex, a time rule or a lot formula inside a runner. Hand copies drifting apart caused the 2026-08-22..27 scanner starvation (`MIN_SCORE`) and the open 15M gate bug below.
- **`assertOrderSafety` stays the single order chokepoint.** Every entry from every runner goes through it.

## Verified facts

| Fact | Evidence | Consequence |
|---|---|---|
| Both cTrader accounts are **hedging** (2118552 scanner, 2131377 experiment) | `ProtoOATraderReq` returns `accountType = HEDGED`, explicitly set | The broker allows several positions per symbol. Only the system's own one-position-per-symbol rule prevents it. The "NETTING account" comment at inline_trader step 12 is wrong. |
| Orders carry no strategy tag | No `label`, `comment` or `clientOrderId` on any `ProtoOANewOrderReq`; the proto supports all three and returns `label` on positions | No broker position knows which strategy opened it. `trail_runner` and `confirm_eod_close` act on every position on the account. |
| The 15M alignment gate still requires removed votes | `buildSetups` in `setup_finder.mjs`: `['A', 'B', 'T', 'L']`; A, B and T have not been emitted since 2026-08-21 | 90–210 setups/day rejected as "15M not aligned" against 0–4 emitted signals (VM log, Sep 4–15). **Still open**: this branch preserves behaviour exactly. |
| The Tradovate prop account nets positions per contract | `broker_tradovate` reports `netPos` | Keep one strategy per contract there unless virtual positions are built. |

## How the parts connect

```
Reference data: Instruments · Clock/sessions · News · Config    (read by almost everything)

Market data ─► Context (bias, plan) ─► Strategy ─► Signal store
  ─► Entry policy ─► Trade construction (SL/TP) ─► Sizing ─► Account risk
  ─► Safety gate ─► Order management ─► Broker adapter
  ─► Position management + integrity guard
  ─► Ledger & attribution ─► Journal/reports · Evaluation ─► Tuning ─► (back to Config)
```

## Services

**Bold** entries in "Code today" are the shared modules created on this branch.

### Layer 1 — Reference data

| # | Service | Job | Code today | Next |
|---|---|---|---|---|
| 1 | Market data | Bars for any symbol and timeframe, from any source | `broker_ctrader.getTrendbars`; `setup_finder.fetchBarsResilient` (chart, then broker fallback); `chart_lock.mjs`; `src/core/data.js`; most runners fetch their own | One bars API. Timestamps in ms everywhere (chart bars are seconds). Frozen-feed detection here rather than in the safety gate. |
| 2 | Instrument registry | Asset class, contract, aliases, universe, stop floor | **`lib/instruments.mjs`**: `instrumentClass`, `isCrypto`, `CORE_UNIVERSE`, `MIN_SL_FRAC` | Still local: `PRICE_RANGES` and `CORRELATED_GROUPS` (inline_trader), `INST_PROFILE` (setup_finder), `INSTRUMENTS` (confirm_runner), broker aliases (daily_plan) |
| 3 | Clock & sessions | Weekends, Sunday reopen, trade windows, entry cutoffs, sessions | **`lib/clock.mjs`**: `isCalendarWeekend`, `isFxWeekend`, `isSundayReopen`, `inTradeWindow`, `entryCutoff`, `currentSession`, `weekendCryptoOn`, `cryptoLateOn` | Still local: `sessionSymbols` (setup_finder), ORB session windows, zone_limit's 19:00 cutoff, EOD close hours |
| 4 | News & events | Economic calendar and blackout windows | `news_checker.mjs`; daily_plan, daily_brief and weekly_outlook each read their own calendar cache | One cached calendar |
| 5 | Config | Every setting, typed and versioned, with rules on who changes what | `trading_params.json` (frozen keys in `apply_params.mjs`), `params_blocks.mjs`, `scanner_config.json`, 15+ env kill switches, constants (`COMBOS`, zone_limit `CFG`) | Per-strategy settings move into manifests |

### Layer 2 — Analysis & context

| # | Service | Job | Code today | Next |
|---|---|---|---|---|
| 6 | Indicator & structure library | ATR, EMAs, swings, S/R zones, FVGs, AutoTL, fib depth, chart patterns, ADR | `auto_trendline.mjs` (already one shared copy: the model), `confirm/indicators.mjs`, setup_finder and daily_plan internals, `institutional/lib.mjs`; about 25 separate ATR implementations | A shared library of pure functions. Not a running service. |
| 7 | Bias / regime | Directional read per instrument | `daily_selector.mjs` → `daily_watchlist.json`; setup_finder `buildDailyContext`/`classifySetup`; inline_trader sibling and with-trend gates | Output `{symbol, dir, strength, source}` |
| 8 | Trade plan (weekly → daily) | Thesis per instrument: bias, path, entry zones, invalidation, targets, ADR budget; grades yesterday | `weekly_outlook.mjs` → `daily_brief.mjs`; separately `daily_plan.mjs` → `daily_plan.json`, the plan that is enforced | daily_plan never reads the outlook or the brief, so they are two unconnected analyses. Split daily_plan into level engine, LLM analyst, validator and grader. |

### Layer 3 — Decision

| # | Service | Job | Code today | Next |
|---|---|---|---|---|
| 9 | Strategies (plug-ins) | Bars + context → Signals | Module-shaped: `confirm/strategies/*.mjs`, including **`scanner_confluence.mjs`**; `institutional/smorb.mjs`, `trendpb.mjs`. Built into their runners: `orb_runner`, `kurisko_flag_runner`, `zone_limit_runner` | Wrap the built-in ones behind the same `generateSignals` contract |
| 10 | Signal store | Where strategies publish and executors consume: expiry, dedup, one attempt per signal | `live_signals.json` + `signal_executor_state.json` for the scanner (records now carry `strategyId`); private state files elsewhere (`confirm_state.json`, `orb_state.json`, `ia_paper_signals.jsonl`) | One store for every strategy |

### Layer 4 — Trade decision & risk

| # | Service | Job | Code today | Next |
|---|---|---|---|---|
| 11 | Entry policy | Ordered veto filters, each returning ok or a reason | 23 checks in `inline_trader.attemptInlineTrade`; `daily_plan_gate.checkPlan`; `fib_veto.mjs`; confirm_runner NTZ and news filters | Strategy-specific checks (score, Trifecta, MTF depth) belong inside the confluence strategy. `applyPlanLevels` changes the trade from inside a filter — make that an explicit output. |
| 12 | Trade construction | Signal → bracket: stop, targets, R:R, exit legs | Seven recipes: `buildSetups` H1 geometry, `applyPlanLevels`, inline_trader stop-floor widening and `RUNNER_EXIT` legs, `zone_limit_runner.decideOrder` (zone midpoint, ≥2R, tested), confirm_runner fixed 2R, ORB opposite boundary | Output `TradeIntent`; the recipe is chosen per manifest |
| 13 | Position sizing | Lots from risk %, equity, stop distance and contract size | **`lib/sizing.mjs`**: `calcLots`, `splitLegs`, used by inline_trader, confirm_runner, zone_limit_runner, orb_runner, kurisko_flag_runner (six hand copies removed) | Still separate: `trade_notion_sync` risk maths, `broker_tradovate.sizeContracts` (futures) |
| 14 | Account risk | Limits shared by every strategy on one account | inline_trader steps 5b–5d, 9, 10, 12; confirm_runner and ORB kill switches; zone_limit `maxTotal`; anti-stack and twin guard in the safety gate | One per-account budget every strategy draws from |
| 15 | Safety gate | Rules no strategy can override: stop present and on the right side, minimum stop distance, lot caps, stale price, Sunday reopen, chart layer down | `broker_ctrader.assertOrderSafety` | It also holds the plan gate and fib veto (policy inside the broker adapter). Move them into the policy chain only once every runner uses the same pipeline. |

### Layer 5 — Execution

| # | Service | Job | Code today | Next |
|---|---|---|---|---|
| 16 | Order management | Submit, modify, cancel; bracket attach and verify; multi-TP legs; resting limits; retry; recovering a lost position ID | `broker_ctrader.placeOrder` / `placeMultiTpPosition` / `cancelOrphanLimits`; inline_trader retry block; confirm_runner bracket-verify loop; zone_limit_runner resting-order state | `OrderRequest {clientOrderId, strategyId, …}` → `OrderResult {orderId, positionId, bracketed}` |
| 17 | Broker adapters | One interface per broker | `broker_ctrader.mjs` (1,269 lines: socket, protobuf, safety, orders, history, bars), `broker_tradovate.mjs`, legacy TradingView-DOM `execute_trade.mjs`; chosen by `BROKER_PROVIDER` | Split transport from orders, history and bars |
| 18 | Accounts & credentials | Which account a job trades; secrets; token rotation | env files + wrappers (`run_scanner_job.sh` → 2118552, `run_confirm_job.sh` → 2131377); `ctrader_refresh.mjs`; `PLAN_GATE_ACCOUNT` defaulting to 2118552 | Account config: broker, credentials, risk budget, strategies |

### Layer 6 — After the trade

| # | Service | Job | Code today | Next |
|---|---|---|---|---|
| 19 | Position management | Breakeven, trailing, partials, EOD carry-or-close, weekend flatten | `trail_runner.mjs` (`trailDecision` is pure), `confirm_eod_close.mjs` (both accounts), `tvo_eod_flatten.sh`, `position_monitor.mjs` | Manage only positions the job owns, using the owner's exit settings |
| 20 | Integrity guard | No position without both stop and target | `confirm_naked_guard.mjs`, both accounts every 5 min | Stays account-wide on purpose, so it runs even when management logic breaks |
| 21 | Ledger & attribution | Broker deal → position → strategy, signal and plan zone → realised R | cTrader deals; `confirm_signals.jsonl` (experiment); `trades.csv` (scanner, known unreliable); `orb_signals.jsonl`; reconcile/pnl scripts | `strategyId` on every order |

### Layer 7 — Feedback

| # | Service | Job | Code today | Next |
|---|---|---|---|---|
| 22 | Journal & reports | Notion journal with screenshots, daily/weekly emails, plan and outlook pages | `trade_notion_sync.mjs`, `daily_trade_report.mjs`, `confirm_report.mjs`, `confirm_weekly_review.mjs` | Group everything by `strategyId` |
| 23 | Evaluation | Profit factor, expectancy in R, PASS/WATCH/CUT, live vs backtest | `strategy_benchmark.mjs`, `edge_replay.mjs`, `vote_edge.mjs`, `per_symbol_pf_reflection.mjs`, daily_plan's grader | Drives promotion between stages |
| 24 | Tuning agent | Proposes parameter changes; writes only through Config | `run_eod_hermes.sh` → `edge_replay` → `eod_agent` (LLM) → `hermes_reflect` → `apply_params` | — |

### Offline and platform

- **Backtesting:** replays any strategy module over history with costs and out-of-sample splits. About 20 separate scripts exist today; `institutional/` (metrics, robustness checks, tests) is the template. It must run the same strategy modules as live, or backtest-vs-live comparisons can't be trusted.
- **Chart host:** `tv_browser` (Chromium/Xvfb/CDP), x11vnc, the MCP server in `src/`. Chart reads and journal screenshots only — never orders.
- **Scheduler:** the VM crontab plus `keepalive_scanner.sh`. The job wrappers are what bind a job to an account.
- **Health & alerting:** `cdp_watchdog.sh`, `heartbeat.sh`, `snap_hold_guard.sh`, `tvo_session_check.sh`, email.

## Accounts are compositions of services

Each account is one choice per service. A new trading approach should be a new column, not new code along the pipeline.

| Service | Scanner (2118552) | Experiment (2131377) |
|---|---|---|
| Context | selector bias + daily plan | none |
| Strategies | scanner_confluence, plan zone limits, ORB | 10 combos from 7 modules |
| Entry policy | plan gate + 23 inline checks | per-combo filters |
| Construction | H1 structure + plan levels; zone midpoint for limits | strategy's stop; 2R or the strategy's own target |
| Sizing | 5 / 3.5 / 2.5% tiers (crypto capped at 1%) | fixed 0.25% |
| Exits | 1/3 at 2R + trailed runner, EOD carry | bracket only, weekend flatten |
| Attribution | `trades.csv` (unreliable) | `strategyId` per position |

## Contracts

The services only decouple if the messages between them are fixed.

| Contract | Where | Status |
|---|---|---|
| `Bar`, `Signal`, `TradeIntent` | `lib/contracts.mjs` (JSDoc + `signalErrors`) | Defined. `signalErrors` runs in confirm_runner (every strategy signal) and market_scanner (every setup before it reaches `live_signals.json`). |
| `Plan` | `daily_plan.json` | Exists; produced by `daily_plan.mjs`, read by `daily_plan_gate` and `zone_limit_runner` |
| `Manifest` | this document (below) | Target format; built with the generic runner |
| `OrderRequest` / `OrderResult`, `Position` (with owner), `Trade` (ledger row) | — | To define with the generic runner and order tagging |

A `Signal` is a view, not an order: `{strategyId, symbol, tf, dir, ts, entry, sl, targets?, entryType?, score?, reasons?}`. No sizing and no broker fields — later services add those.

## Strategy plug-in design

### A strategy is a folder with two files

```
strategies/orb_nas_ny/
  manifest.json   how it's wired in: instruments, timing, stops, exits, risk, account, stage
  logic.mjs       what it decides   (or rules.json, or a Pine script converted to JavaScript)
```

```json
{
  "id": "orb_nas_ny",
  "version": "1.0.0",
  "enabled": true,
  "stage": "paper",
  "account": "experiment",
  "logic": { "type": "module", "file": "logic.mjs" },
  "instruments": ["NAS100", "US30"],
  "timeframe": "15",
  "evaluate": "bar_close",
  "sessions": ["NY"],
  "params": { "orMinutes": 30, "withTrend": true },
  "entry": { "type": "market" },
  "stops": { "sl": "from_signal", "tp": { "r": 2 }, "minRR": 2 },
  "exits": { "breakevenAtR": 1, "trail": "none", "eod": "flatten_friday" },
  "risk": { "perTradePct": 0.5, "maxOpenPerSymbol": 1, "maxDailyLossPct": 2 }
}
```

The logic file only produces signals. Sizing, order placement, stop attachment and safety checks are shared services; the manifest picks from the options they offer, such as `"trail": "chandelier"` or `"tp": "from_signal"`.

### Logic formats

| Format | Good for | Limits | Verdict |
|---|---|---|---|
| JavaScript module (`generateSignals(bars, ctx)`) | Any logic: sweeps, structure, trendlines | Needs code | The native format; 9 modules already use it |
| JSON rules | Indicator-and-condition strategies, no code | Limited to the building blocks the indicator library offers | The no-code option; compiled into a module. Expressions go through a restricted parser, never `eval`. |
| Pine, converted to JavaScript | Strategies already built and checked visually in TradingView | Conversion effort; the copy can drift | Best route for Pine, with the automatic match check below |
| Pine, running live on the chart | No conversion | Needs the chart browser (the most failure-prone part), one symbol at a time, ~300 bars, can't be backtested by the system | Only for one or two strategies, treated as fragile |
| XML | Nothing JSON doesn't already do | Harder to write | Skip |

**Pine conversions can be checked automatically.** `src/core/data.js` already has `getStrategyResults` and `getTrades`, which read TradingView's own backtest trades for a Pine strategy. The system can backtest the JavaScript version over the same period and refuse it if the trade lists don't match. `amd_ote.mjs` is an existing hand conversion of `amd_ote_runner.pine`.

### What the platform guarantees (not the strategy author)

1. **Checked on load.** Valid manifest, instruments exist in the registry, logic runs, and a trial run on recent bars produces well-formed signals (`signalErrors`). A broken strategy is rejected before it can trade.
2. **Promotion stages: backtest → paper → demo → live.** Each step needs a PASS from Evaluation. A new strategy trading money on day one is how the scanner lost $6,667 over 147 trades. `ia_paper_runner` already works as a paper stage.
3. **Ownership.** Every order carries its strategy ID in cTrader's `label` and `clientOrderId`. Exit, EOD and trailing jobs manage only the positions they own, using that strategy's manifest.
4. **Risk budgets.** Each strategy has its own risk % and daily loss limit inside the account's limit. The account-wide halt overrides every strategy.
5. **Isolation.** Per-strategy timeout, automatic disable after repeated errors, and a cap on signals per period. One bad strategy can't stall or flood the others.
6. **The safety gate stays.** `assertOrderSafety` checks every order.
7. **Scorecard and off switch per strategy.** Results grouped by strategy ID; `"enabled": false` takes effect on the next run without a restart.

### Several strategies on the same instrument

The accounts are hedging, so this is a system rule, not a broker limit. Replace "one position per symbol" with:

- **Per strategy:** at most one open position per symbol by default. This keeps what the current rule was really for — the 2026-06-06 loop that fired one signal 11 times.
- **Per account:** a cap on total risk per symbol across strategies, so three strategies agreeing don't triple exposure unless that is chosen; and opposite directions on one symbol blocked by default (two spreads for no net position), allowed per account when strategies should be free to disagree.
- **Duplicate-order guard:** keyed by strategy + symbol instead of symbol alone.
- **Tradovate:** one strategy per contract (net positions).

### Runtime shape

```
registry   loads and checks every strategies/*/manifest.json
runner     each tick: enabled strategy × instrument → bars → logic → Signal tagged with strategyId
executor   Signal → entry policy → construction → sizing → account risk → safety gate → broker (label = strategyId)
managers   trailing / EOD / integrity guard, per owned position, using that strategy's exit settings
grading    trades grouped by strategyId → PASS/WATCH/CUT → promote, demote or disable
```

One general-purpose runner replaces `confirm_runner`, `orb_runner`, `kurisko_flag_runner` and the scanner's execution path. Same VM, same cron style.

## Build order

| Step | What | Status |
|---|---|---|
| 1 | Contracts: `Bar`, `Signal`, `TradeIntent` | **Done** — `lib/contracts.mjs` |
| 2 | Shared instrument registry, clock and sizing | **Done** — `lib/instruments.mjs`, `lib/clock.mjs`, `lib/sizing.mjs`; tests in `lib/lib.test.mjs` |
| 3 | Scanner as a Signal-emitting strategy module | **Done** — `confirm/strategies/scanner_confluence.mjs` over `scoreTimeframe` + `buildSetups`, the functions the live scan runs |
| 4 | Retire dead runners and their installers | This branch — see below |
| 5 | Manifest schema + generic runner grown from `confirm_runner`; move the experiment's combos into manifests first | Next |
| 6 | Strategy ID on every order + owner-scoped exit jobs | Next — required before two strategies share an account |
| 7 | Replace one-position-per-symbol with per-strategy and per-account exposure rules | |
| 8 | Wrap cfs detectors, institutional functions, ORB and kurisko as modules | |
| 9 | JSON rules compiler | |
| 10 | Pine conversion + automatic trade-matching check | |
| 11 | Promotion stages gated by Evaluation | |

### Retired on this branch

`session_runner` (ran 5×/day on the scanner account; its last attempts were rejected by the plan gate), `zone_limits_preview` (dry-run twin of `zone_limit_runner`), `decision_runner`, `leap_runner`, `morning_agent`, `scale_risk_to_goal`, `eod_close` + `eod_close_cron.sh`, `naked_position_guard` + `naked_guard_cron.sh`, and the installers that would put them back: `install_cron_linux.sh`, `remove_cron_linux.sh`, `scripts/vm/run_session.sh`, the Windows `scripts/scheduler/*_tasks.ps1` + `run_session.bat`, the session_runner cron step in `cloud-init.yaml`, and the `session_runner` duplicate-killer in `cdp_watchdog.sh`. On the VM the matching crontab lines (`session_runner.mjs`, `zone_limits_preview.mjs`) must be removed at deploy time.

### Behaviour changes on this branch

The refactor is behaviour-preserving except for these, all deliberate:

- **zone_limit_runner sizes crypto with the 1% risk cap** that inline_trader and orb_runner already applied. BTCUSD zone limits previously risked the full `riskPct[0]` (5%). Every other runner produces identical lots (checked against every old copy at the lot size the broker receives).
- **zone_limit_runner places nothing outside the trade windows** instead of sending orders the plan gate rejects every 15 minutes.
- **Asset class is now consistent for non-core symbols.** Platinum/copper classify as METAL, NGAS as OIL, DOT/AVAX/DOGE as CRYPTO, and NDX/NQ/YM/DOW/USTEC/DJ30/DE40/GER30 as INDEX — in sizing and in the safety gate's stop floors and lot caps. No core-universe symbol changes class.
- **Invalid signals stop earlier.** confirm_runner skips a signal whose stop is on the wrong side before trying to place it; market_scanner leaves an invalid setup out of `live_signals.json`.
- **`setup_finder.mjs` no longer imports chrome-remote-interface at load time**, so the scoring engine imports on any machine; the chart client still loads on first use.

### Loose ends found while retiring

- **daily_brief's guidance reaches nothing.** `daily_brief.mjs` still writes `daily_context/<date>.json` (skip today, score override, instruments to avoid). Its only reader was `session_runner`; the live scanner path (`signal_executor` → `inline_trader`) never read it. Wire it into the entry policy or stop writing it.
- **`twitter_feed.mjs` has no importers left.** Its only consumer was `session_runner`.
