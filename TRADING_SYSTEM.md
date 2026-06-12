# Trading System — Reference Documentation

Live automated day-trading system running on an Oracle Cloud VM. Scans 22 instruments across
8 timeframes every 15 minutes, scores setups against 5 confluence strategies, and places
structured orders via BlackBull Markets through TradingView Desktop. All positions are closed
by 20:00 UTC — no overnight exposure.

_Last updated: 2026-06-01_

> **NOTE:** sections below this status block predate the cTrader migration and may be stale.
> Order execution is now via the **cTrader Open API** (`scripts/trading/broker_ctrader.mjs`),
> not the TradingView/BlackBull DOM path. TradingView (Chrome on the VM, CDP 9222) is used for
> **chart reading only**.

---

## Current Operational Status (2026-06-11)

**Account** — cTrader **demo** (acct 2118552): started **$10,000** (Apr 15) → peaked **$15,090** → currently **~$1,074** (net ≈ −$8,900). Authoritative P&L via `pnl_reconcile.mjs` / `broker_ctrader.getAllClosedDeals()`. **Recommend resetting the demo balance to $10k** — at $1k, min-lot granularity distorts sizing stats.

**Loss anatomy** — three execution-bug blowups account for −$14.5k of the −$8.9k net (the system is profitable without them): USDJPY −$3,856 (Apr 30), XAGUSD −$4,949 (May 20), **USDCHF −$5,659 (Jun 6–7)**. The June 6 chain: chart feed froze on a **Saturday** (no Saturday gate existed) → same stale signal fired 11×, 1-pip SL → 10-lot sizing → every attempt marked VOID (caps only counted W/L, so the loop never tripped them) → cTrader queued the orders into the **Sunday open**, where the 1-pip SLs were swept with 10-lot slippage. The signal layer itself (Jun 8–11, small size) is roughly breakeven.

**2026-06-11 safety rebuild (deployed):**

| Layer | Guard |
|---|---|
| `broker_ctrader.assertOrderSafety()` (all runners) | SL required + correct side; min SL distance by class (FX 0.08%); per-class lot caps (FX 3, was 10); anti-stacking (no new order while symbol has open volume); price-sanity vs live broker M1 bars (rejects frozen-chart entries deviating >0.4% FX, and any market with bars >30 min old) |
| `inline_trader` | EVERY attempt (incl. VOID/open) counts toward daily caps; 24h identical-signal block (persisted `attempted_orders.json`); pre-submit SL-distance check (covers TV-DOM path); **Saturday hard block**; per-class lot caps in `calcLots` |
| `execute_trade` | ORDER_SAFETY_REJECT is never routed around via the TV-DOM fallback |
| `eod_close` | cTrader-API-first close with **verify-flat + 3 retries + CRITICAL log**; new `eod_close_cron.sh` (sources creds); **Saturday 00:30 UTC `--weekend-check` backstop cron** |
| `naked_guard_cron.sh` | `timeout -k 15 110` (777 hung guard processes were strangling the VM on Jun 11 — killed) |

**Scanner** — LIVE, params v21: scoreThreshold 11, requireWithTrendBias, sessions **NY + LONDON-NY-OVERLAP only** (overlap re-enabled 2026-06-11; hermes had blocked it off stats poisoned by the USDCHF bug trades), riskPct [5, 3.5, 2.5] (operator), maxDailyTotal/PerSymbol 4/1, **maxDailyDrawdownPct 6 (kill-switch armed; was 20 ≈ off)**.

**Edge (validated)** — `edge_replay.mjs` + cTrader ledger + FundedNext 17k-trader study all converge: **BTCUSD (+$5.5k lifetime, the only consistent winner) and indices, NY/overlap, with-trend, score ≥ 11, few trades**. Longs/London/Asian/metals/FX-majors bleed. 1-minute scalping rejected (spread cost ≈ 24% of a 5-pip target). Next evidence-backed upgrade: relative-volume ("in play") filter on the ORB runner, per Zarattini/Barbon/Aziz.

**Blocked symbols** — XAGUSD, WTI, HK50, USDCAD, LTCUSD, ETHUSD, GER40, AUS200, NZDCHF, NZDUSD, id188, XRPUSD, EURUSD, COPPER, BRENT, DOTUSD, SOLUSD, AVAXUSD, USDCHF, NZDCAD, AUDJPY, **USDJPY, GBPUSD, AUDUSD** (added 2026-06-11). (`id188` = an unmapped DAX/GER40 contract; the GER40→GER30 name gap routes fills to it.)

**Kill-switch fixed** — the daily-drawdown halt now reads REAL cTrader P&L (`getTodayRealizedPnl()`); it previously summed `trades.csv` (mostly VOID/0) and was blind through a −9.6% day.

**`scale_risk_to_goal` DISABLED** (commented out in `/home/ubuntu/run_eod_hermes.sh`) — it was cranking risk toward the **$500k-in-55-days moonshot** even on a negative edge (a root cause of blow-up risk). Risk is now operator-set and fixed. The remaining Hermes steps (eod_agent + hermes_reflect --apply) still run nightly.

**ORB strategy** — dedicated time-gated runner `orb_runner.mjs` in **DRY-RUN** (logs would-be trades to `orb_signals.jsonl`, places nothing). Pairings from a 90-day isolated backtest (`orb_backtest.mjs`): **Gold@Asia, indices/AUD-NZD/JPY-cross cluster@London, AUDJPY@NY**, 2R target, SL = opposite OR boundary. Has its own allowlist — **not** gated by `blockedSymbols` (so it trades WTI@London despite the scanner block).

**Automations (cron, UTC):**

| When | Job | Action |
|---|---|---|
| 06:00 Mon–Fri | `morning_review_cron.sh` | emails edge read + tuning proposals; auto-blocks persistent bleeders (WR<30% & net<0 over 14d **and** 30d) |
| 07:00–11:55 / 13:30–18:55 / 00:00–04:55 | `orb_runner_cron.sh` | ORB dry-run, every 5 min in session windows |
| 20:00 & 21:45 Mon–Fri | `eod_close.mjs` | force-close all positions |
| 20:30 Mon–Fri | `run_eod_hermes.sh` | eod_agent + hermes_reflect (scale_risk disabled) |
| 20:35 Mon–Fri | `daily_report_cron.sh` | EOD email — **that day's trades only** (replaced the rolling-30d email) |
| every 5 min | `scanner_freshness_check.sh` | respawns scanner if stale/dead |
| every 5 min | `scripts/vm/watchdog.mjs` | heals dead chart tab (path fixed 2026-06-01) |

**Open issues** — (1) GER40 name mapping (→ unmapped id188); (2) the `goal.json` $500k/55-day target is mathematically incompatible with capital preservation — consider steady-state (targetReturn30d 0.05).

---

## Architecture

```
Oracle Cloud VM (ubuntu@132.145.44.68)
│
├── Xvfb (virtual display :1)
│   └── TradingView Desktop (Electron, CDP port 9222)
│
├── market_scanner.mjs  ← persistent process; continuous scan → scanner.log + live_signals.json
│
└── Cron jobs
    ├── session_runner.mjs   ← main orchestrator (every 15 min Mon–Fri + Sun 22-23 UTC)
    ├── eod_close.mjs        ← force-close all positions (20:00 + 21:45 UTC)
    ├── position_monitor.mjs ← per-trade watcher (spawned detached per order)
    └── review_params.mjs    ← daily performance review (20:30 UTC Mon–Fri)
```

**Data files** — all at `/home/ubuntu/trading-data/`:

| File | Purpose |
|------|---------|
| `scanner.log` | Per-instrument scores every 15 min; signals emitted |
| `cron_runner.log` | session_runner execution log (trades placed, errors) |
| `trade_log/trades.csv` | Append-only trade history (one row per order pair) |
| `live_signals.json` | Active signals; updated each scan |
| `daily_context/{date}.jsonl` | PDH/PDL/ADR snapshots per instrument per scan |
| `trading_params.json` | Tunable parameters (see below) |
| `session_runner.lock` | PID lock — prevents concurrent session_runner instances |

---

## Cron Schedule

| UTC Time | Days | Script | Purpose |
|----------|------|--------|---------|
| `*/15` | Mon–Fri | `session_runner.mjs` | Main scan cycle |
| `*/15 22-23` | Sun | `session_runner.mjs` | Forex Sunday open (Asian session) |
| `*/5` | Daily | `scripts/vm/watchdog.mjs` | Keep TradingView + BlackBull alive |
| 09:00 | Mon–Fri | `run_jobs.sh` | Job pipeline |
| 20:00 | Mon–Fri | `eod_close.mjs` | EOD force-close (first pass) |
| 20:30 | Mon–Fri | `review_params.mjs` | Daily parameter review |
| 21:45 | Mon–Fri | `eod_close.mjs` | EOD force-close (backup) |

**Entry window:** Sun 22:00 UTC → Fri 19:30 UTC.
**Last entry cutoff:** 19:30 UTC Mon–Fri. No new entries after 21:00 UTC Friday.

---

## Session Windows

| Session | UTC Hours | Priority Instruments |
|---------|-----------|----------------------|
| Asian | 00:00–07:59 (+ Sun 22:00+) | BTCUSD, ETHUSD, XAUUSD, USDJPY, EURJPY |
| London | 08:00–12:59 | XAUUSD, WTI, EURUSD, USDJPY, UK100, GER40 |
| London–NY Overlap | 13:00–16:59 | NAS100, US30, SPX500, WTI, XAUUSD, BTCUSD |
| NY | 17:00–19:59 | NAS100, US30, SPX500, BTCUSD, ETHUSD, XAUUSD |
| Dead Zone | 20:00–23:59 | No trades |

---

## Instrument Universe

22 instruments scanned in tier order. All scan all 8 timeframes: **1M 5M 15M 30M 1H 4H D W**.

| Tier | Symbols | Auto-short |
|------|---------|------------|
| 1 | WTI, NAS100, US30, XAUUSD, SPX500, XAGUSD | All except NAS100, US30, SPX500 |
| 2 | EURUSD, USDJPY, EURJPY, GBPJPY, GBPUSD | All |
| 3 | BTCUSD, ETHUSD, LTCUSD, XRPUSD, AUDUSD, USDCAD, NZDUSD, USDCHF, AUDJPY, GER40, UK100 | All except GER40, UK100 |

**Correlated groups** — one instrument per group maximum per session:

| Group | Members |
|-------|---------|
| US Indices | NAS100, US30, SPX500 |
| Crypto | BTCUSD, ETHUSD, LTCUSD, XRPUSD |
| Metals | XAUUSD, XAGUSD |
| USD Forex | EURUSD, GBPUSD, AUDUSD, NZDUSD, USDCAD, USDCHF |
| JPY Pairs | USDJPY, EURJPY, GBPJPY, AUDJPY |
| Oil | WTI |
| EU Indices | GER40, UK100 |

---

## Strategies & Scoring

**5 strategies. Max base score = 8. Signal threshold = 6.**

| Code | Name | Points | Condition |
|------|------|--------|-----------|
| **A** | SmartTrail | +1 | ATR trailing stop (len=22, mult=3.0) direction matches trade direction |
| **T** | Weekly Trend | +1 | W1 EMA proxy rising (long) or falling (short). **REQUIRED — no T = no signal** |
| **U** | PDH/PDL Zone | +1 | Price in bottom 40% of yesterday's range (long) or top 40% (short) |
| **C** | S/R Zone | +2 fresh / +3 retested | Price inside a wick-to-body pivot supply/demand zone |
| **F** | Fair Value Gap | +2 | Price inside an unmitigated 3-candle institutional imbalance zone |

**EMA flatness gate:** If EMA 8/21/50 spread < 0.4% of EMA50 → ranging market → score
hard-returns as 2. No signal possible regardless of other factors.

**Signal gate:** T must be present. Total score (base + MTF bonus) ≥ 6.

**Example combinations reaching threshold (without U):**

| Combination | Points |
|-------------|--------|
| A + T + C(fresh) + F | 1+1+2+2 = 6 ✓ |
| T + C(retested) + F | 1+3+2 = 6 ✓ |
| A + T + U + C(fresh) | 1+1+1+2 = 5 ✗ (needs F or MTF bonus) |
| A + T + U + F | 1+1+1+2 = 5 ✗ (needs C or MTF bonus) |
| A + T + U + C(fresh) + F | 1+1+1+2+2 = 7 ✓ |

---

## MTF Confluence Bonus

Higher timeframes carry more weight. The bonus is added to the base score after Pass 2.

| Total TF weight | Bonus |
|----------------|-------|
| ≥ 5.0 (e.g. W+D) | +3 |
| ≥ 3.0 (e.g. D+4H) | +2 |
| ≥ 1.5 (e.g. 1H alone) | +1 |
| < 1.5 | +0 |

| TF | Weight |
|----|--------|
| W | 4.0 |
| D | 3.0 |
| 4H | 2.5 |
| 1H | 1.5 |
| 30M | 1.0 |
| 15M | 1.0 |
| 5M | 0.5 |
| 1M | 0.25 |

---

## Scan Flow (Two-Pass MTF)

**Pass 1 — all 8 TFs per instrument:**
- Switch chart to each TF; fetch 300 bars
- Score long (and short if `autoShort` enabled) independently
- Keep as candidate if: score ≥ 6 AND strategy T is present

**Pass 2 — 15M entry per direction:**
- Switch to 15M; fetch 200 bars
- **15M alignment gate:** SmartTrail (A) or Weekly Trend (T) must be aligned on 15M —
  otherwise logged as "waiting" and skipped this cycle
- Compute entry, SL, TP from 15M structure
- Apply ATR hard caps; enforce minimum 2:1 R:R
- If R:R unachievable within caps → setup skipped entirely

One setup emitted per instrument+direction per cycle (not per TF).

---

## Stop Loss

1. Find nearest active S/R zone below entry (long) / above entry (short),
   within 0.25–0.75×ATR from entry
2. If an active FVG boundary is tighter: use FVG boundary (min floor: 0.2×ATR)
3. Buffer: 10% ATR outside the zone to avoid stop hunts
4. **Hard cap: 0.75×ATR from entry** — overrides all of the above

At 15M, 0.75×ATR ≈ 1–3 hours of normal directional movement.

---

## Take Profits & R:R

| Order | Target | Cap | Min R:R |
|-------|--------|-----|---------|
| **O1** (half lots) | Nearest opposing S/R zone ahead | 2.0×ATR max | 2:1 enforced |
| **O2 / Runner** (half lots) | Next zone beyond O1 | 2.5×ATR max | — |

If 2:1 cannot be achieved within the 2.0×ATR cap → **setup is rejected, no trade placed.**

EOD force-close at 20:00 UTC is the backstop for O2 if the runner target is not reached.

---

## Position Sizing

Two orders are placed per signal (O1 + O2), both sharing the same SL.

### Risk per trade

| Concurrent trades open | Base risk | Score ≥ 8 bonus |
|------------------------|-----------|-----------------|
| 1 | **5.0%** of equity | +0.5% → 5.5% |
| 2 | **3.5%** per trade | +0.5% → 4.0% |
| 3–4 | **2.5%** per trade | +0.5% → 3.0% |

**Crypto volatility cap:** BTC, ETH, SOL, ADA, XRP → hard-capped at **1.0% of equity**
regardless of concurrent trade count.

### Lot calculation by instrument

| Instrument | Contract size | Point value |
|------------|---------------|-------------|
| XAUUSD | 100 oz / lot | $100 / $1 move |
| NAS100, US30, SPX500 | 1 / lot | $1 / point |
| BTCUSD, ETHUSD, crypto | 1 / lot | $1 / point |
| JPY pairs | 100,000 units | ~$6.50 / pip / lot |
| Forex majors | 100,000 units | $10.00 / pip / lot |

**Formula:** `lots = (equity × riskPct%) ÷ (contractSize × pipSize × SL_distance)`

**Hard limits:** Min 0.01 lots · Step 0.01 · Max 10 lots per order.

---

## Safeguards & Risk Rules

| Rule | Detail |
|------|--------|
| **News filter** | High-impact Forex Factory event within ±30 min → instrument (or full session) skipped |
| **Consecutive loss stop** | 2+ consecutive losses in `trades.csv` → session skipped until a win resets it |
| **EOD force-close** | 20:00 UTC first pass + 21:45 UTC backup — nothing held overnight |
| **Last entry cutoff** | 19:30 UTC — no new entries in the 30 min before EOD close |
| **Friday cutoff** | 21:00 UTC Friday — no new entries before weekend |
| **Correlated group cap** | One instrument per group per session (see Instrument Universe) |
| **Open position dedup** | If instrument is already open in trades.csv → skipped |
| **Max concurrent** | 4 open positions maximum (configurable) |
| **15M alignment gate** | Higher TF signal ignored if 15M SmartTrail or Weekly Trend is not aligned |
| **EMA flatness gate** | Score capped at 2 if EMAs are within 0.4% of each other (ranging market) |
| **Asian crypto gate** | Crypto requires score ≥ 10 during Asian session (thin/noisy liquidity) |
| **PID lock** | `session_runner.lock` prevents concurrent cron instances; crash-safe via `process.kill(pid,0)` |

---

## Tunable Parameters (`data/trading_params.json`)

Edit locally, deploy to VM with `scp`, picked up on next scan cycle.

| Parameter | Current value | Description |
|-----------|---------------|-------------|
| `scoreThreshold` | **6** | Minimum score to emit a signal |
| `stopRuleLosses` | 2 | Consecutive losses before session pause |
| `riskPct` | **[5.0, 3.5, 2.5]** | Risk % for 1 / 2 / 3+ concurrent trades |
| `slAtrMult` | **0.75** | Hard SL cap as ATR multiple |
| `tp1Mult` | 1.0 | TP1 fallback R multiple (when no zone found) |
| `tp2Mult` | 2.0 | TP2 runner fallback R multiple |
| `minRR` | 2.0 | Minimum R:R — setup skipped if unachievable |
| `maxConcurrent` | 4 | Max open trades at once |
| `blockedSymbols` | [] | Temporarily blocked instruments |
| `blockedSessions` | [] | Temporarily blocked sessions |

---

## On-Chart Indicator (`strategy_dashboard.pine`)

Overlay indicator on TradingView showing a live table with all 5 strategy readings, current
score, and signal status for whichever chart is open. Uses identical logic to the scanner —
if the table shows a signal, the scanner will catch it.

**Inject updated Pine to TradingView:**
```bash
scp -i ~/.ssh/id_rsa_oracle scripts/strategy_dashboard.pine \
  ubuntu@132.145.44.68:/home/ubuntu/tradingview-mcp-jackson/scripts/strategy_dashboard.pine

ssh -i ~/.ssh/id_rsa_oracle ubuntu@132.145.44.68 \
  "cd /home/ubuntu/tradingview-mcp-jackson && DISPLAY=:1 node inject_pine.mjs"
```

---

## Deploy Workflow

```bash
# Deploy scanner + params
scp -i ~/.ssh/id_rsa_oracle \
  scripts/trading/setup_finder.mjs \
  ubuntu@132.145.44.68:/home/ubuntu/tradingview-mcp-jackson/scripts/trading/setup_finder.mjs

scp -i ~/.ssh/id_rsa_oracle \
  data/trading_params.json \
  ubuntu@132.145.44.68:/home/ubuntu/trading-data/trading_params.json

# IMPORTANT: market_scanner.mjs caches setup_finder.mjs at startup.
# After updating setup_finder.mjs, always restart market_scanner:
ssh -i ~/.ssh/id_rsa_oracle ubuntu@132.145.44.68 \
  "pkill -f market_scanner.mjs; sleep 1; \
   cd /home/ubuntu/tradingview-mcp-jackson && \
   DISPLAY=:1 nohup node scripts/trading/market_scanner.mjs \
   >> /home/ubuntu/trading-data/scanner.log 2>&1 &"
```

---

## Monitoring

```bash
# Live scan output
ssh -i ~/.ssh/id_rsa_oracle ubuntu@132.145.44.68 "tail -f /home/ubuntu/trading-data/scanner.log"

# Session runner (trade placement) log
ssh -i ~/.ssh/id_rsa_oracle ubuntu@132.145.44.68 "tail -f /home/ubuntu/trading-data/cron_runner.log"

# Current active signals
ssh -i ~/.ssh/id_rsa_oracle ubuntu@132.145.44.68 "cat /home/ubuntu/trading-data/live_signals.json"

# Trade history
ssh -i ~/.ssh/id_rsa_oracle ubuntu@132.145.44.68 "cat /home/ubuntu/trading-data/trade_log/trades.csv"

# Check running processes
ssh -i ~/.ssh/id_rsa_oracle ubuntu@132.145.44.68 \
  "ps aux | grep -E 'market_scanner|session_runner' | grep -v grep"
```
