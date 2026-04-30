# Trading System — Full Reference

Automated day-trading system running 24/7 on an Oracle Cloud VM. Connects to TradingView Desktop
via Chrome DevTools Protocol (CDP), scans 22 instruments across 6 timeframes, and places
structured orders using a multi-strategy scoring engine. All positions are closed by 20:00 UTC —
no overnight exposure.

---

## Architecture

```
Oracle Cloud VM (ubuntu@132.145.44.68)
│
├── Xvfb (virtual display :1)
│   └── TradingView Desktop (Electron, CDP port 9222)
│
├── Node.js MCP server (stdio)
│   └── CDP bridge → TradingView
│
└── Cron jobs
    ├── session_runner.mjs   ← main orchestrator (fires at session opens)
    ├── eod_close.mjs        ← force-close enforcer (20:00 + 21:45 UTC)
    └── position_monitor.mjs ← per-trade watcher (spawned per order, detached)
```

**Data files** (all at `/home/ubuntu/trading-data/`):

| File | Purpose |
|------|---------|
| `trade_log/trades.csv` | Append-only trade log (one row per instrument per session) |
| `trade_log/eod_closes.csv` | EOD close audit trail |
| `position_monitor.log` | Real-time position poll log |
| `daily_context/{date}.jsonl` | PDH/PDL/ADR snapshots per instrument per scan |
| `trade_log/scheduler_logs/` | Per-run cron output logs |

---

## Cron Schedule

All times UTC. Timezone set to Europe/London on the VM.

| UTC Time | Days | Script | Purpose |
|----------|------|--------|---------|
| 01:07 | Daily | `session_runner.mjs` | Asian Open fire (exits immediately — outside entry window) |
| 09:07 | Mon–Fri | `session_runner.mjs` | **London Open** — active entry window |
| 14:07 | Mon–Fri | `session_runner.mjs` | **NY Open / London-NY Overlap** — highest priority |
| 18:03 | Mon–Fri | `session_runner.mjs` | London Close fire (outside entry window after 16:00) |
| 20:00 | Mon–Fri | `eod_close.mjs` | EOD close — first pass |
| 21:45 | Mon–Fri | `eod_close.mjs` | EOD close — backup pass |
| 04:03 | Sundays | `session_runner.mjs` | Strategy research scan |

**Active entry window: 08:00–16:00 UTC only.**
The 01:07 and 18:03 crons fire `session_runner.mjs` but it exits immediately when outside the
entry window — no trades are placed. The 04:03 Sunday run is for scanning/logging context only.

**Friday cutoff:** No new entries after 15:30 UTC on Fridays.

---

## Session Flow (session_runner.mjs)

Each active cron fires runs this sequence:

```
1. EOD check      → if UTC hour ≥ 20, close all positions and exit
2. Entry window   → if outside 08:00–16:00 UTC, exit
3. Friday cutoff  → if Friday after 15:30, exit
4. Equity log     → fetch and log current equity/balance/float P&L (informational)
5. News filter    → fetch high-impact events; exit if event within ±30 min
6. Consec-loss    → read trades.csv; exit if 2+ consecutive losses
7. Sentiment      → fetch F&G / Reddit signals (non-blocking — failure skipped)
8. Scan           → scanForSetups() across all 22 instruments × 6 TFs
9. News per-sym   → filter any setup whose symbol has news <30 min
10. Group select  → one setup per correlated group, up to 4 concurrent
11. Deduplication → skip symbol if already open; skip if correlated group member open
12. Place orders  → 2 orders per instrument (O1 at TP1, O2 at TP2)
13. Log trade     → append row to trades.csv
14. Monitor       → spawn position_monitor.mjs detached per instrument
```

---

## Instrument Universe

22 instruments, scanned in tier order (higher tiers scanned first within each session).
All instruments scan all 6 timeframes: **1M, 5M, 15M, H1, H4, D**.

### Tier 1 — Proven High WR (ranked by Apr 13-25 audit)

| Symbol | Shorts? | Notes |
|--------|---------|-------|
| WTI | Yes | 58% WR on H1 — top performer |
| NAS100 | No | 48% WR on H1 — requires Okala strategy (P) gate |
| US30 | No | 42% WR on H1 |
| XAUUSD | Yes | 34% WR on H1 — Alpha Kill (Q) strategy active |
| SPX500 | No | Correlated with NAS100/US30 |
| XAGUSD | Yes | Correlated with XAUUSD |

### Tier 2 — Situational (good in trending weeks)

| Symbol | Shorts? |
|--------|---------|
| EURUSD | Yes |
| USDJPY | Yes |
| EURJPY | Yes |
| GBPJPY | Yes |
| GBPUSD | Yes |

### Tier 3 — Deprioritised (low recent WR, kept for trending opportunities)

| Symbol | Shorts? |
|--------|---------|
| BTCUSD | Yes |
| ETHUSD | Yes |
| LTCUSD | Yes |
| XRPUSD | Yes |
| AUDUSD | Yes |
| USDCAD | Yes |
| NZDUSD | Yes |
| USDCHF | Yes |
| AUDJPY | Yes |
| GER40 | No |
| UK100 | No |

**Correlated groups** (one instrument per group maximum):

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

## Scanning Engine (setup_finder.mjs)

### Two-Pass MTF Approach

**Pass 1** — Scan every TF (1M, 5M, 15M, H1, H4, D) for each instrument.
Each TF/direction combination is scored independently. A candidate is kept if:
- Score ≥ 8
- Strategies T (Weekly trend) **and** U (Daily zone) are both present

**Pass 2** — For each instrument that has ≥1 qualifying candidate, switch to 15M and verify:
- SmartTrail (A) **or** EMA stack (B) must be aligned on 15M (entry-TF alignment gate)
- If not aligned, the setup is rejected and logged as "waiting"

One setup is emitted per instrument+direction (not per TF). MTF bonus is applied to the score.

### Scoring Gates

| Gate | Rule |
|------|------|
| EMA flatness | If EMA8/21/50 are within 0.4% of each other → score hard-capped at 2 (ranging market, no edge) |
| T+U requirement | Both weekly trend (T) and daily zone (U) must fire for the setup to qualify |
| 15M alignment | SmartTrail or EMA stack must be aligned on the 15M entry chart |
| NAS100 gate | Okala over-extension strategy (P) must be present |
| Min score | ≥ 8 points after MTF bonus |

### Strategies (A–U)

Each strategy scores 1 point unless noted. Max possible score: ~16+ (with MTF bonus and convergence bonus).

| Code | Name | Signal |
|------|------|--------|
| A | JG Smart Trail | SmartTrail direction aligned with trade |
| B | EMA Stack | 8 > 21 > 50 > 100 for longs (reversed for shorts) |
| C | Adaptive S/R Zone | Price within 0.5×ATR of active BigBeluga pivot zone |
| D | Rejection Candle | Pin bar, engulfing, or doji at key level |
| E | RSI + Divergence | RSI in non-extreme zone (30-65 long / 35-70 short); +1 extra for divergence |
| F | Bollinger Band | Squeeze (BW < 0.5%) or outer band touch |
| G | Volume Spike | Current volume > 1.3× 20-bar average |
| H | Session Quality | Prime session hours (informational only — no score) |
| I | Pattern Match | n-gram statistical pattern ≥62% confidence, n≥5 samples |
| J | HA Scalper | 2+ HA pullback bars then flip, above/below EMA100 |
| K | London Breakout | Price breaks London range (08:00-13:00 UTC) after 13:00 |
| L | Trendline Break | Pivot-based resistance/support trendline broken decisively |
| M | Break & Retest | Major level broken 5-20 bars ago, now retesting; or broken zone flip |
| N | Mean Reversion | Price at bottom 20% (long) or top 20% (short) of 50-bar range + EMA50 slope |
| O | ICT OTE | Price entered 61.8-79% Fibonacci retracement zone + rejection body at boundary |
| P | Okala Scalper | Indices only — over-extended >1.5×ATR from EMA21, NY morning (13-17 UTC) |
| Q | Alpha Kill v1 | XAUUSD only — BOS retest with D1+H4 trend confirmation (+2 pts) |
| R | Ironclad MSS | EMA200 daily trend + 15M market structure shift break (+2 pts) |
| S | Daily Trend | D1 EMA rising/falling (proxy from current TF bars) |
| T | Weekly Trend | W1 EMA rising/falling (5× daily lookback) — **required** |
| U | Daily Zone | Price in lower 40% of PDH-PDL for longs / upper 40% for shorts — **required** |
| — | Convergence bonus | 5+ distinct strategies agree → +1 |
| — | MTF bonus | 2 TFs agree → +1; 3+ TFs agree → +2 |

---

## SL / TP Calculation

SL and TP are anchored to actual S/R structure (BigBeluga adaptive zones on the 15M chart).
ATR-based fallbacks apply when no suitable zone is found.

### Stop Loss
- **Long:** nearest active *support* zone below entry, within 0.5–2.5×ATR of entry → SL placed 10% ATR below that zone
- **Short:** nearest active *resistance* zone above entry, within 0.5–2.5×ATR of entry → SL placed 10% ATR above that zone
- **Fallback:** entry ± 1.5×ATR

### Take Profit — TP1 (main target, Order 1)
- **Long:** nearest active *resistance* zone ahead, 0.5–4×slDist away
- **Short:** nearest active *support* zone ahead, 0.5–4×slDist away
- **Fallback:** entry + 1.0×slDist (1R)

### Take Profit — TP2 (runner, Order 2)
- Next S/R zone beyond TP1 (at least 0.3×slDist further)
- **Fallback:** entry + 2.0×slDist (2R)

### Order Structure
Two orders are placed per instrument (both with the same SL):

| Order | Lots | Target |
|-------|------|--------|
| O1 | ½ of total lots | TP1 — main target (closes at 1R or nearest resistance) |
| O2 | ½ of total lots | TP2 — runner (EOD close is the backstop if not hit) |

---

## Position Sizing

Formula: `lots = riskAmount / (pipValuePerLot × slPips)`

| Instrument type | Pip size | Pip value per lot |
|----------------|----------|-------------------|
| Forex majors (GBPUSD, EURUSD, etc.) | 0.0001 | $10.00 |
| JPY pairs (USDJPY, GBPJPY, etc.) | 0.01 | $6.50 (approx) |
| XAUUSD (gold) | 1.0 (per oz) | $100 (1 lot = 100 oz) |
| Indices / Crypto (NAS100, BTCUSD, etc.) | 1.0 (per point) | $1.00 |

**Risk percentages per trade:**

| Concurrent instruments | Risk per trade |
|-----------------------|---------------|
| 1 | 3.5% of equity |
| 2 | 2.5% each |
| 3 or more | 1.75% each |
| High-score bonus (score ≥ 12) | +0.5% added |

**Hard caps:** Min 0.01 lots | Step 0.01 lots | Max 10 lots per order.

---

## Safeguards & Risk Rules

### 1. News Filter
Fetches Forex Factory high-impact events. If any high-impact event is within ±30 minutes:
- Global block → entire session skipped
- Per-symbol block → that instrument skipped even if other instruments trade

### 2. Consecutive Loss Stop
Reads `trades.csv` before each session. If the last 2+ completed trades are losses (negative P&L),
the session is skipped entirely. Resets when a winning trade is recorded.

### 3. EOD Hard Close (Day-Trade Enforcer)
No overnight positions. Three layers:

| Layer | When | How |
|-------|------|-----|
| position_monitor.mjs | Any position open at UTC 20:00 | Closes position, records result |
| eod_close.mjs (first) | 20:00 UTC cron | 3-attempt retry with verification |
| eod_close.mjs (backup) | 21:45 UTC cron | Catches anything that slipped through |

### 4. Friday Cutoff
No new entries after 15:30 UTC on Fridays — ensures all positions have time to resolve before weekend gap.

### 5. Open Position Deduplication
Before placing any order, `trades.csv` is scanned for rows without a result (column 10 empty).
Any instrument with an open position is skipped — prevents stacking duplicate trades on the same symbol.

### 6. Correlated Group Deduplication
If any instrument from a correlated group is already open, the entire group is blocked.
Example: NAS100 open → US30 and SPX500 are also skipped for that session.

### 7. 15M Alignment Gate
Even if higher timeframes confirm the setup, the 15M entry chart must show the SmartTrail or
EMA stack aligned in the trade direction. Counter-trend entries on the execution TF are rejected.

### 8. EMA Flatness Gate
If EMA8, EMA21, and EMA50 are all within 0.4% of each other, the market is ranging — score is
hard-capped at 2, preventing the setup from ever reaching the 8-point threshold.

### 9. Max Concurrent Instruments
Hard cap of 4 simultaneous instruments. Combined with the correlated group rule, maximum
real exposure is typically 3-4 uncorrelated directional bets.

---

## Position Monitor (position_monitor.mjs)

Spawned detached per instrument after order placement. Polls every 60 seconds, max 12 hours.

| Event | Action |
|-------|--------|
| First tick — no position detected | Waits 2 more ticks (broker panel may lag) then exits |
| TP1 hit (partial close — balance rises) | Logs TP1 hit; reminds to move SL to break-even |
| Position closed (equity = balance) | Determines W/L from balance delta; updates trades.csv |
| UTC hour ≥ 20 (EOD) | Force-closes position, records result, exits |
| 12 hours elapsed | Records result=? (timeout), exits |

---

## VNC / Remote Access

x11vnc runs bound to localhost only (security). External access requires an SSH tunnel:

```bash
ssh -i ~/.ssh/id_rsa_oracle -L 5900:localhost:5900 ubuntu@132.145.44.68 -N
```

Then connect RealVNC Viewer to `localhost:5900`. The TradingView chart is on display `:1`.

---

## Deployment

To push updated scripts to the Oracle VM:

```bash
scp -i ~/.ssh/id_rsa_oracle \
  scripts/trading/session_runner.mjs \
  scripts/trading/setup_finder.mjs \
  scripts/trading/position_monitor.mjs \
  scripts/trading/eod_close.mjs \
  ubuntu@132.145.44.68:/home/ubuntu/tradingview-mcp-jackson/scripts/trading/
```

To reinstall cron jobs after server reboot:
```bash
ssh -i ~/.ssh/id_rsa_oracle ubuntu@132.145.44.68 \
  "bash /home/ubuntu/tradingview-mcp-jackson/scripts/cloud/install_cron_linux.sh"
```

To watch live session logs:
```bash
ssh -i ~/.ssh/id_rsa_oracle ubuntu@132.145.44.68 \
  "tail -f /home/ubuntu/trading-data/trade_log/scheduler_logs/session_*.log"
```
