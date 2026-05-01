# Trading System — Full Reference

Automated day-trading system running 24/5 on an Oracle Cloud VM. Connects to TradingView Desktop
via Chrome DevTools Protocol (CDP), scans 22 instruments across 8 timeframes, and places
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
    ├── session_runner.mjs   ← main orchestrator (every 15 min Mon–Fri)
    ├── eod_close.mjs        ← force-close enforcer (20:00 + 21:45 UTC)
    ├── position_monitor.mjs ← per-trade watcher (spawned per order, detached)
    └── review_params.mjs    ← daily performance review (20:30 UTC Mon–Fri)
```

**Data files** (all at `/home/ubuntu/trading-data/`):

| File | Purpose |
|------|---------|
| `trade_log/trades.csv` | Append-only trade log (one row per instrument per session) |
| `trade_log/eod_closes.csv` | EOD close audit trail |
| `position_monitor.log` | Real-time position poll log |
| `daily_context/{date}.jsonl` | PDH/PDL/ADR snapshots per instrument per scan |
| `trading_params.json` | Tunable parameters — edited via `apply_params.mjs`, never manually |
| `pending_params.json` | Recommended changes awaiting approval (written by `review_params.mjs`) |
| `reviews/` | Archive of applied parameter reviews |
| `review_params.log` | Daily review script output log |

---

## Cron Schedule

All times UTC. Timezone set to Europe/London on the VM.

| UTC Time | Days | Script | Purpose |
|----------|------|--------|---------|
| `*/15` | Mon–Fri | `session_runner.mjs` | Scan every 15 minutes — active entry 00:00–19:30 UTC |
| `*/15 22-23` | Sun | `session_runner.mjs` | Forex market open — Sunday night ASIAN session |
| `*/5` | Daily | `watchdog.mjs` | Keep TradingView + BlackBull alive |
| 09:00 | Mon–Fri | `run_jobs.sh` | Job pipeline (research tasks) |
| 20:00 | Mon–Fri | `eod_close.mjs` | EOD close — first pass |
| 20:30 | Mon–Fri | `review_params.mjs` | Daily performance review + parameter recommendations |
| 21:45 | Mon–Fri | `eod_close.mjs` | EOD close — backup pass |

**Active entry window: Sun 22:00 UTC – Fri 21:00 UTC (true 24/5).**
Forex opens Sunday ~22:00 UTC; the Sunday cron fires at 22:00, 22:15, 22:30, 22:45, 23:00, 23:15, 23:30, 23:45 UTC, then the Mon–Fri cron picks up seamlessly from 00:00 Monday.
The scanner gates itself internally — entry is skipped outside valid hours, if the session is blocked by performance review, if there is news, or if the stop rule has triggered.

**Entry cutoffs:** Last entry at 19:30 UTC Mon–Fri (30 min before EOD force-close). No new entries after 21:00 UTC on Fridays. EOD close is skipped on Sunday night (no positions were open before the market opened).

---

## Session Flow (session_runner.mjs)

Each 15-min cron tick runs this sequence:

```
1. Sunday gate      → if Sunday before 22:00 UTC, exit (Forex not yet open)
2. EOD check        → if UTC hour ≥ 20 (and not Sunday), close all positions and exit
3. Last-entry check → if UTC 19:30–19:59 (and not Sunday), exit (too close to EOD force-close)
4. Friday cutoff    → if Friday after 21:00, exit
5. Session block    → if current session is blocked by review, exit
6. Equity log       → fetch and log current equity/balance/float P&L (informational)
7. News filter      → fetch high-impact events; exit if event within ±30 min
8. Consec-loss      → read today's trades.csv; exit if consecutive losses ≥ stopRuleLosses
9. Sentiment        → fetch F&G / Reddit signals (non-blocking — failure skipped)
10. Scan            → scanForSetups() across all 22 instruments × 8 TFs
11. Symbol filter   → skip blocked symbols; skip symbols with news <30 min
12. Group select    → one setup per correlated group, up to maxConcurrent
13. Deduplication   → skip symbol if already open; skip if correlated group member open
14. Place orders    → 2 orders per instrument (O1 at TP1, O2 at TP2)
15. Log trade       → append row to trades.csv
16. Monitor         → spawn position_monitor.mjs detached per instrument
```

---

## Instrument Universe

22 instruments, scanned in tier order (higher tiers scanned first within each session).
All instruments scan all 8 timeframes: **1M, 5M, 15M, 30M, H1, H4, D, W**.
Higher timeframes carry more weight in the MTF bonus — Weekly/Daily confluence scores +3 bonus vs +1 for low-TF only. This reflects the lower noise and higher reliability of higher-TF signals.

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

**Pass 1** — Scan every TF (1M, 5M, 15M, 30M, H1, H4, D, W) for each instrument.
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
| NAS100 gate | Okala (P) **or** Trend Catcher Switch (V) must be present |
| SPX500 gate | Contrarian FVG (W) **or** Okala (P) must be present |
| Min score | ≥ 8 points after MTF bonus |

### Strategies (A–X)

Each strategy scores 1 point unless noted. Max possible score: ~18+ (with MTF bonus, convergence bonus, and X golden pocket).

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
| V | Trend Catcher Switch | NAS100/SPX500 only — SmartTrail direction flip (-1→+1) in last 5 bars + EMA stack aligned + RSI < 55 (long). Replicates LuxAlgo `{switch_bullish_catcher}` + `{confirmation_uptrend}` + `{hyperwave_below_50}`. 75% WR on NAS100 15M backtest |
| W | SPX500 Contrarian FVG | SPX500 only — recent bearish FVG + MFI(14) < 50 + RSI < 35 for longs (contrarian: gap-down reversal). 70.51% WR on SPX500 15M backtest |
| X | Fibonacci OTE + BOS/CHoCH | **SMC/Harmonic trend continuation.** BOS-confirmed swing A→B impulse; price retracing into golden pocket (0.786-0.88 fib) or OTE zone (0.618-0.786). Scoring: in OTE zone + BOS = +1; in golden pocket (0.786-0.88) + BOS = +2; Order Block confluence = +1 extra. CHoCH tagged when present. **TP extensions: -0.27 (TP1) and -0.618 (TP2) projected beyond the swing.** Settings from Harmonic/SMC framework. |
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
No new entries after 21:00 UTC on Fridays. The 20:00 EOD force-close is the real backstop — the 21:00 cutoff is an extra safety margin before market close (~22:00 UTC Friday).

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

## Semi-Automatic Parameter Tuning

The system adjusts its own trading parameters based on live performance results.
Every weekday at **20:30 UTC** (after EOD close), `review_params.mjs` automatically analyzes
the last 30 days of `trades.csv` and writes recommended changes to `pending_params.json`.
Nothing changes until you explicitly approve.

### Parameters

All tunable values live in `data/trading_params.json` on the VM:

| Parameter | Default | Description |
| --------- | ------- | ----------- |
| `scoreThreshold` | `8` | Minimum setup score required to qualify (T+U gate also required) |
| `stopRuleLosses` | `2` | Number of consecutive daily losses before session is skipped |
| `riskPct` | `[3.5, 2.5, 1.75]` | Risk % for 1 / 2 / 3+ concurrent instruments |
| `slAtrMult` | `1.5` | ATR multiplier for fallback SL when no S/R zone is found |
| `tp1Mult` | `1.0` | O1 fallback TP multiplier (×slDist) |
| `tp2Mult` | `2.0` | O2 runner TP fallback multiplier (×slDist) |
| `maxConcurrent` | `4` | Maximum simultaneous open instruments |
| `blockedSessions` | `[]` | Sessions currently blocked (e.g. `["ASIAN"]`) |
| `blockedSymbols` | `[]` | Symbols currently on cooling-off (e.g. `["XRPUSD"]`) |
| `blockedSymbolExpiry` | `{}` | ISO dates when each blocked symbol auto-unblocks |

### Recommendation Rules

`review_params.mjs` applies these rules against the last 30 days of completed trades:

| Condition | Recommendation |
| --------- | -------------- |
| Overall WR < 40% (≥20 trades) | `scoreThreshold` +1 (cap: 11) — tighten entry quality |
| Overall WR > 70% (≥20 trades) | `scoreThreshold` -1 (floor: 7) — loosen entry slightly |
| Profit factor < 1.2 (≥20 trades) | `slAtrMult` +0.1 (cap: 2.5) — stops too tight, widen fallback |
| Symbol WR < 30% (≥5 trades) | Add to `blockedSymbols` for 30 days |
| Session WR < 35% AND negative PnL (≥10 trades) | Add to `blockedSessions` |
| Blocked symbol past expiry date | Remove from `blockedSymbols` + `blockedSymbolExpiry` |

### Workflow

```text
1. 20:30 UTC (auto)  → review_params.mjs runs, writes data/pending_params.json
2. You review        → node scripts/trading/apply_params.mjs --preview
3. You approve       → node scripts/trading/apply_params.mjs --apply
4. Changes active    → next scan cycle reads updated trading_params.json
5. Old review file   → archived to data/reviews/review_YYYY-MM-DD_<ts>.json
```

**Preview output** shows a full diff: current value → proposed value, with the data-driven reason.
**Apply** writes `trading_params.json` and archives the pending file — no manual file editing needed.

If no changes are warranted, `pending_params.json` is still written with `"noChanges": true`
so you have a daily audit trail of what was evaluated.

### Checking Today's Review

```bash
# On VM — read the latest recommendations:
cat /home/ubuntu/trading-data/pending_params.json

# Or preview what would change without applying:
ssh -i ~/.ssh/id_rsa_oracle ubuntu@132.145.44.68 \
  "cd /home/ubuntu/tradingview-mcp-jackson && node scripts/trading/apply_params.mjs --preview"

# To apply approved changes:
ssh -i ~/.ssh/id_rsa_oracle ubuntu@132.145.44.68 \
  "cd /home/ubuntu/tradingview-mcp-jackson && node scripts/trading/apply_params.mjs --apply"
```

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
