# Chart Fanatics — Strategy Catalog, Triage & Backtest Queue

All 40 strategies from chartfanatics.com/strategies, captured 2026-07-02.

## Where everything lives

| Asset | Location |
|---|---|
| Full rules text (step-by-step, per strategy) | `strategies/chart_fanatics/raw/<slug>.md` (this repo) |
| PDF playbooks (32; richer, with charts) | `C:\Users\Tda-d\OneDrive\Alpha\Desktop\Trading\Chart Fanatics Playbooks\` |
| NotebookLM (queryable) | ["Chart Fanatics Strategies"](https://notebooklm.google.com/notebook/5d89abcb-32fc-4a03-8f41-60ddfefa02ff) (40 pages + 10 PDFs, full at 50-cap) + ["Chart Fanatics PDF Playbooks"](https://notebooklm.google.com/notebook/9eb2bdbc-b08f-4a5b-8eb7-9b27829f97a8) (22 PDFs) |
| Backtest harness | `scripts/trading/cfs_backtest.mjs` + detectors in `scripts/trading/cfs/` |

## Triage — can we backtest it with cTrader OHLCV data?

Verdicts: **Q1/Q2** = queued for backtest (batch 1 / 2) · **DONE** = already exhaustively tested ·
**LIVE** = already forward-testing on the confirm experiment (acct 2131377) ·
**NO-DATA** = needs US small-cap stocks / options chains / VIX — none of which exist on cTrader ·
**NO-OF** = depends on order-flow / DOM / volume-profile data our trendbars don't carry ·
**EDU** = educational framework, not a mechanical strategy · **SKIP-COST** = 1-min scalping, already
proven cost-prohibitive (spread ≈ 24% of target; see reference_profitability_evidence).

| # | Strategy | Author | Market / Style | Verdict |
|---|---|---|---|---|
| 1 | Liquidity Strategy | Marco Trades | Fut/FX/Crypto, day | **Q1** (sweep→reversal; implementing first) |
| 2 | PO3, OTE + ADR | NBB Trader | Forex, swing | **Q1** (session PO3 + OTE retrace + ADR target) |
| 3 | Unique High RR "Trident" | TG Capital | Fut/FX, swing | **Q1** (London-session swing) |
| 4 | Intraday Liquidity & Volatility | Jade Cap | Fut/FX, day | **Q1** (session liquidity grab) |
| 5 | Liquidity Inversion Model | Dhesi | Fut/FX, day/swing | **Q1** (HTF sweep + FVG inversion — mechanical) |
| 6 | Structure + OTE | Trader Mayne | FX/Fut/Crypto, swing | **Q1** (OTE 61.8–79% retrace; cousin of live amd_ote) |
| 7 | Measured Move Trend | Marci Silfrain | Stk/Fut/Crypto, swing | **Q1** |
| 8 | SMT Divergence + PO3 | Trader Kane | Crypto/Fut | **Q2** (needs synced pairs: BTC/ETH, US500/USTEC) |
| 9 | Stage Analysis | Ted Zhang | Multi-asset, swing | **Q2** (Weinstein stages on D1/W1) |
| 10 | 80/20 Nasdaq | Okala | NQ, day | **Q2** (USTEC round-number 20/80 levels; M15 history limited) |
| 11 | Futures Trading Strategy | Anthony Crudele | Futures, swing | **Q2** (environment classifier, semi-mechanical) |
| 12 | Universal Strategy | Traveling Trader | Multi, any | **Q2** |
| 13 | AMD Model | Tanja Trades | Futures, day | **Q2** faithful port (**LIVE** cousin: amd_ote) |
| 14 | Momentum Model Perf. Dev. | Jeff Holden | Stk/Fut, day | **Q2** review (may be NO-DATA) |
| 15 | Trendline Break Pocket | Ali Crooks | Forex, swing | **DONE** — failed OOS broad; only gold-H1/USDJPY-H1 pockets survived (cf_backtest) |
| 16 | Trendline Strategy | Tori Trades | Multi, swing | **DONE** — part of TL+S&R family test |
| 17 | Support & Resistance | Brando Elite | Options, swing | **DONE** (method) — S&R zones ported; zone limits validated as the limit edge. Options leg = NO-DATA |
| 18 | Break & Retest | Vincent Desiano | Stk/Opt/Fut, day | **LIVE** — wor_break_retest_ntz, GBPJPY H1, confirm experiment |
| 19 | Nasdaq ICT & OF Scalping | Abraham Perez | NQ, M1 scalp | **SKIP-COST** |
| 20 | Mean Reversion | Lance Breitstein | Stocks, day | **NO-DATA** (stock-specific; high-WR fade math already disproven on CFDs) |
| 21 | Parabolic Short | Marios Stamatoudis | Stocks | **NO-DATA** (small-caps) |
| 22 | First Red Day | Alex Temiz | Stocks/Options | **NO-DATA** |
| 23 | First Red Day Strategy | Kyle Williams | Stocks | **NO-DATA** |
| 24 | Small-Cap Short Statistics | Steven Dux | Stocks | **NO-DATA** |
| 25 | Small-Cap Shorting | Kris Verma | Stocks | **NO-DATA** |
| 26 | Episodic Pivot | Pradeep Bonde | Stocks | **NO-DATA** (needs catalyst/earnings data) |
| 27 | Real Simple Strategy | Ariel Hernandez | Stocks, swing | **NO-DATA** |
| 28 | VIX Futures | Dylan O'Neil | VIX futures | **NO-DATA** (no VIX product on cTrader) |
| 29 | Order Flow (Trapped Traders) | Trader Yush | NQ | **NO-OF** |
| 30 | Auction Market Theory | Andrea Cimitan | Futures | **NO-OF** |
| 31 | Auction Market Strategy | Fabio Valentini | Futures, scalp | **NO-OF** |
| 32 | Market Auction Theory | Rajan Dhall | Stk/Fut | **NO-OF** |
| 33 | Low Volume Node | Carmine Rosato | Fut/Indices | **NO-OF** (needs volume profile) |
| 34 | Market DNA | Jay Awtani | Stk/Opt/Fut | **NO-OF** |
| 35 | Volume Profile | Forrest Knight | Opt/Fut | **NO-OF** |
| 36 | OrderFlow Masterclass | Carmine Rosato | — | **EDU** |
| 37 | Options Masterclass | Usman Ashraf | Options | **EDU** + NO-DATA |
| 38 | Full Psychology MasterClass | Jared Tendler | — | **EDU** |
| 39 | 5 Stage Trading Framework | Umar Ashraf | — | **EDU** |
| 40 | Algorithmic Strategy | Naoufel Taief | Meta | **EDU** (its robustness-filter process = what cfs_backtest does) |

**Net: 14 backtestable (7 Q1 + 7 Q2), 3 done, 2 live, 21 untestable with our data.**
Options execution is impossible on our cTrader stack regardless (no options market) — options
strategies can inform ideas only.

## Backtest method (mirrors cf_backtest.mjs / orb_backtest.mjs)

- Data: cTrader `getTrendbars` via `broker_ctrader.mjs` on the VM. History limits per TF:
  **D1/H4 ≈ 5y+, H1 ≈ 3y, M15/M5 ≈ months–1y** — "5 years on every timeframe" is bounded by
  what the broker serves; each strategy is tested on its playbook TF ± one adjacent TF.
- Basket: EURUSD GBPUSD USDJPY GBPJPY AUDJPY XAUUSD XAGUSD XPTUSD US30 USTEC US500 BTCUSD ETHUSD.
- Outcomes in R, SL-first on straddle bars, cost model = spread + 2×0.02×ATR slippage.
- Robustness gauntlet **every strategy must pass before demo deployment**: netPF>1 after costs,
  positive net−top3 (fragility), maxDD sane, and **OOS regime split** (the filter that killed the
  TL+S&R fusion). High WR alone ≠ edge (break-even at 85.7% WR with 0.17R wins — proven).
- Winners → new combo slots in `confirm_runner.mjs` on demo acct 2131377 (swap out losers), then
  scanner strategy vote after forward-test survival.
