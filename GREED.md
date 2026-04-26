# GREED — Greedy Algorithmic Trading System
### Reference Document — Last Updated: 2026-04-24

> "A greedy algorithm that is always trying to get as much money as possible."
> One trade per session. Highest-confidence setup only. Exit the same day.

---

## 1. What Is This?

GREED is a fully automated intraday trading system built on top of the **TradingView MCP** (Model Context Protocol) server. It runs on an **Oracle Cloud VM** (Ubuntu) and communicates with TradingView Desktop via Chrome DevTools Protocol (CDP) on port 9222.

Claude Code acts as the brain — scanning instruments, scoring setups, placing orders, and managing exits — without any human intervention during live sessions.

**Broker:** BlackBull Markets  
**Account currency:** GBP  
**VM:** `ubuntu@132.145.44.68` (Oracle Cloud, always-on)  
**SSH key:** `~/.ssh/id_rsa_oracle`

---

## 2. System Architecture

```
Oracle Cloud VM (Ubuntu)
│
├── TradingView Desktop (Electron) — port 9222 (CDP)
│   └── Live charts, order execution panel
│
├── MCP Server (stdio) — src/connection.js
│   └── Bridge between Node.js scripts and TradingView DOM
│
├── Cron Jobs (UTC times)
│   ├── 00:00  Mon-Fri  → session_runner.mjs  (Asian open)
│   ├── 08:00  Mon-Fri  → session_runner.mjs  (London open)
│   ├── 13:00  Mon-Fri  → session_runner.mjs  (London-NY overlap — BEST)
│   ├── 17:00  Mon-Fri  → session_runner.mjs  (NY continuation)
│   └── 21:45  Mon-Fri  → eod_close.mjs       (End-of-day force close)
│
└── Data directory: /home/ubuntu/trading-data/
    ├── trade_log/trades.csv         — every trade logged
    ├── trade_log/eod_closes.csv     — EOD close log
    ├── daily_context/*.jsonl        — PDH/PDL/ADR snapshots per session
    └── position_monitor.log         — monitor process output
```

---

## 3. A Typical Trading Day

### Timeline

| UTC Time | Event |
|----------|-------|
| 00:00 | Cron fires `session_runner.mjs` — **Asian session** scan (BTC/ETH/XAUUSD only, score ≥ 13) |
| 08:00 | Cron fires — **London open** scan (all Tier 1/2 instruments, score ≥ 12) |
| 13:00 | Cron fires — **London-NY overlap** scan (best session, all instruments pass score ≥ 11) |
| 13:xx | If a setup is found: **3 orders placed simultaneously** (see §6) |
| 13:xx | **Position monitor** spawned as background process — watches for TP hits |
| ~14:xx | **TP1 hit** → Order 1 closes at +0.5R profit |
| ~15:xx | **TP2 hit** → Order 2 closes at +1.0R profit |
| ~16:xx | **TP3 hit** → Order 3 closes at +2.0R profit (best case) |
| 15:30 | **Friday cutoff** — no new trades after 15:30 UTC on Fridays |
| 17:00 | Cron fires — **NY continuation** scan (crypto + indices only, score ≥ 12) |
| 21:45 | Cron fires — **EOD force close** — any remaining positions closed, P&L locked |

### Session Priority (best to worst)

1. **London-NY Overlap (13:00-17:00)** — highest volume, tightest spreads, best WR
2. **London Open (08:00-13:00)** — XAUUSD/WTI dominate
3. **NY Continuation (17:00-22:00)** — indices + crypto only
4. **Asian (00:00-07:00)** — crypto only, very selective (score ≥ 13)

---

## 4. Instrument Universe

All instruments are kept permanently. None are ever removed. Low-WR instruments sit at Tier 3 and only fire when they generate a genuinely high score (which requires EMA trend alignment to pass the flatness gate).

### Tier 1 — Proven high WR in trending weeks (scan first)
| Symbol | WR (Apr 13-18 audit) | Notes |
|--------|---------------------|-------|
| NAS100 | **89%** | Top priority London-NY overlap |
| US30   | 50% | Strong in trending weeks |
| WTI    | 57% | Excellent trend follower |
| XAUUSD | 24% | Volatile, special Alpha Kill strategy |
| BTCUSD | 35% | 24/7, Asian session eligible |
| ETHUSD | 34% | Follows BTC |
| XAGUSD | — | Silver, mirrors gold |
| SPX500 | — | Correlated to NAS100 |

### Tier 2 — Good efficiency, trade when they trend
USDJPY, EURJPY, GBPJPY, LTCUSD, BNBUSD

### Tier 3 — Deprioritised but never removed
GBPUSD, EURUSD, AUDUSD, USDCAD, NZDUSD, USDCHF, AUDJPY, SOLUSD, ADAUSD, XRPUSD, GER40, UK100

> **Why Tier 3 exists:** Every instrument has trending weeks. The EMA flatness gate (§5) blocks ranging entries automatically. A Tier 3 instrument with a genuine high-momentum score still wins over a Tier 1 with a weak score.

---

## 5. Entry Gates (Hard Filters — Must Pass Before Scoring)

### Gate 1: EMA Flatness
If `(max(EMA8, EMA21, EMA50) - min(EMA8, EMA21, EMA50)) / EMA50 < 0.4%` → **score capped at 2, never trades.**

This is the most important gate. The weekly audit (Apr 13-18) proved:
- Range markets → 8–14% system WR
- Trending markets → 44–89% system WR

The flatness gate blocks all ranging-market entries regardless of tier or session.

### Gate 2: News Safety
`news_checker.mjs` fetches high-impact economic events. If a major event is within 30 minutes, the session is skipped for the affected instruments.

### Gate 3: Consecutive Loss Stop
If the log shows 2+ consecutive losses → session skipped. Prevents drawdown spiralling.

### Gate 4: Open Position Guard
If equity ≠ balance (position already open) → session skipped. Only one trade at a time.

### Gate 5: Friday Cutoff
No new trades after 15:30 UTC on Fridays. Prevents holding over the weekend.

---

## 6. Scoring System (0–16+ points, threshold = 11)

Every instrument/timeframe combination is scored across **21 strategies (A–U)**. Each strategy adds 1 point if its condition passes (some add 2). The highest-scoring setup across all instruments is selected.

| Code | Strategy | Points | Notes |
|------|----------|--------|-------|
| A | JG Smart Trail direction aligned | +1 | Trail above/below price for trend |
| B | EMA Stack (8>21>50 for longs) | +1 | All EMAs in order = strong trend |
| C | S/R Proximity (50-bar swing levels) | +1 | Within 0.4% of key level |
| D | Rejection candle (pin bar / engulfing / doji) | +1 | Candle structure confirmation |
| E | RSI in healthy zone (30-65 long, 35-70 short) | +1 | Not overbought/oversold |
| E+ | RSI divergence (price vs momentum) | +1 | High-probability reversal signal |
| F | Bollinger Band squeeze or outer band touch | +1 | Breakout pending or bounce |
| G | Volume spike (>1.3× 20-bar average) | +1 | Institutional participation |
| H | Prime session (London or London-NY overlap) | +1 | Best liquidity hours |
| I | Statistical pattern match (≥62% confidence, n≥5) | +1 | Historical candle sequence WR |
| J | JG HA Scalper (2+ pullback bars + HA flip above/below EMA100) | +1 | Jackson pullback setup |
| K | JG London Breakout (price breaks London range 13-17 UTC) | +1 | Post-London momentum |
| L | Tori Trendline Break (pivot-to-pivot trendline broken) | +1 | Clean structure break |
| M | WOR Break & Retest (major level broken, now retesting) | +1 | Vincent Desiano method |
| N | WOR Mean Reversion (at range extreme with HTF EMA confirmation) | +1 | Marci Silfrain method |
| O | ICT OTE Fibonacci 61.8–79% zone with rejection body | +1 | NBB Power of 3 / AMD model |
| P | Okala Over-Extension Fade (index >1.5×ATR from EMA21) | +1 | NAS100/US30/SPX500 speciality |
| Q | Alpha Kill v1 BOS+Retest (XAUUSD only, D1+H4 aligned) | **+2** | Best XAUUSD config PF=1.209 |
| R | Ironclad MTF Market Structure (D1 EMA200 + 15M MSS break) | **+2** | 72% WR in backtests, 957% 10yr |
| S | Daily Trend Alignment (D1 EMA proxy from current bars) | +1 | Day trade in direction of day |
| T | Weekly Trend Alignment (W1 EMA proxy from current bars) | +1 | Macro direction confirmation |
| U | Daily Extreme Zone (price in lower 40% for longs, upper 40% for shorts vs PDH-PDL) | +1 | Near yesterday's support/resistance |
| — | Strategy convergence bonus (5+ distinct strategies agree) | +1 | Broad consensus = high conviction |

**Maximum theoretical score: ~16+ points**  
**Trade threshold: 11 points** (raised from 10 after audit confirmed 10-point setups had lower WR)

### Daily Context (logged, not scored)
Every scan logs PDH, PDL, PDC, ADR, rangeConsumed, pricePos, and bias to `daily_context/YYYY-MM-DD.jsonl` for post-session review and weekly audits.

---

## 7. Trade Structure — Three-Order Trailing Stop Ladder

When a setup scores ≥ 11, **three orders are placed simultaneously**:

```
Total risk = account equity × riskPct
            (1% for score 11-11, 1.5% for score 12-13, 2.0% for score ≥14)

Each order = totalLots ÷ 3  (rounded down to nearest 0.01 lot)

SL distance = 1.5 × ATR(14) from entry price
```

| Order | Size | TP level | SL | R-multiple | Behaviour |
|-------|------|----------|----|-----------|-----------|
| Order 1 | 1/3 | TP1 (0.5R) | Normal SL (entry − 1.5ATR) | 0.5R | Closes fast (~1-2 hrs). Covers spread + proves setup right. |
| Order 2 | 1/3 | TP2 (1.0R) | **Entry (break-even)** | 1.0R | Risk-free from the start. Can never lose money. |
| Order 3 | 1/3 | TP3 (2.0R) | **Entry (break-even)** | 2.0R | Maximum runner. Also risk-free from the start. |

### What this means in practice

**Scenario A — TP1 hit, then price reverses:**
- Order 1 closed at +0.5R profit ✓
- Orders 2 & 3 stopped at entry = break-even (no loss)
- **Net result: +0.5R on 1/3 of position = +0.17R overall. You cannot lose.**

**Scenario B — TP1 + TP2 hit, then price reverses:**
- Order 1: +0.5R ✓, Order 2: +1.0R ✓
- Order 3 stopped at entry = break-even
- **Net result: +0.5R on 1/3 + 1.0R on 1/3 = +0.5R overall**

**Scenario C — All three TPs hit (best case):**
- Orders 1, 2, 3: +0.5R + 1.0R + 2.0R = **+3.5R total on 1/3 size each = +1.17R overall**

**Scenario D — Original SL hit before TP1 (worst case):**
- Order 1 stopped at −1.0R (full loss on 1/3)
- Orders 2 & 3 stopped at entry (break-even)
- **Net result: −1/3 of the planned risk = maximum daily loss is 1/3 of riskPct**

### EOD Safety Net
At 21:45 UTC Monday-Friday, `eod_close.mjs` force-closes all remaining positions regardless of TP status. This enforces the day-trade rule: no carryover positions with real risk.

---

## 8. Position Sizing

```
lots = riskAmount / (contractSize × pipSize × SL_distance)
```

Instrument-specific formulas in `calcLots()` in `session_runner.mjs`:

| Instrument | Contract | Pip/Point value |
|------------|----------|----------------|
| XAUUSD | 100 oz/lot | $1 per oz move per lot |
| NAS100, US30, SPX500 | 1 index point | $1/point per lot |
| BTCUSD, ETHUSD | 1 coin | $1/point per lot |
| JPY pairs | 100,000 units | ~$6.50/pip per lot |
| Forex majors | 100,000 units | ~$10/pip per lot |

Hard caps: min 0.01 lots, max 10 lots per order, to prevent account blow-up.

---

## 9. Key Files

```
tradingview-mcp-jackson/
│
├── GREED.md                          ← THIS FILE — system reference
│
├── scripts/trading/
│   ├── setup_finder.mjs              ← Scanner: all strategies, scoring, instrument universe
│   ├── session_runner.mjs            ← Orchestrator: news → scan → place 3 orders → monitor
│   ├── eod_close.mjs                 ← EOD force-close at 21:45 UTC (day-trade enforcer)
│   ├── execute_trade.mjs             ← Low-level: placeOrder(), closeAllPositions(), getEquity()
│   ├── news_checker.mjs              ← High-impact event feed + safety gate
│   ├── pattern_recognition.mjs       ← Statistical n-gram pattern matcher
│   ├── performance_tracker.mjs       ← Consecutive loss counter, WR stats
│   └── twitter_feed.mjs              ← X/Twitter sentiment bias (informational)
│
├── scripts/
│   └── weekly_review.mjs             ← Run after each week to audit WR by instrument/trend
│
└── data/                             ← Local (Windows dev); /home/ubuntu/trading-data on VM
    ├── trade_log/trades.csv          ← Every trade: date, session, symbol, score, entry, sl, tp, pnl
    ├── trade_log/eod_closes.csv      ← EOD close history: equity before/after, realised P&L
    └── daily_context/*.jsonl         ← Per-session PDH/PDL/ADR snapshots
```

---

## 10. Weekly Review Process

After each trading week ends (Friday 22:00 UTC), run:

```bash
node scripts/weekly_review.mjs
```

This analyses the last 5 trading days across all instruments and timeframes. Output goes to `/tmp/weekly_review.txt`.

**Use the results to update the tier rankings:**
- WR ≥ 50% → promote to Tier 1
- WR 30–50% → keep/move to Tier 2
- WR < 30% → move to Tier 3 (never remove — every instrument has trending weeks)

Update `FULL_SCAN_LIST` order in `setup_finder.mjs` to match new rankings. Keep the `project_weekly_patterns.md` memory file updated with each week's findings.

---

## 11. Changelog — What Has Been Built

### Phase 1 — Foundation
- TradingView MCP server setup via CDP on Oracle Cloud VM
- `execute_trade.mjs` — DOM automation for order placement via TradingView's trading panel
- `setup_finder.mjs` v1 — 6 initial strategies (A, B, C, D, E, F), OHLCV bar reader
- `session_runner.mjs` v1 — cron-driven orchestrator, news safety gate, logging

### Phase 2 — Strategy Expansion
- Added strategies G (volume), H (session quality), I (pattern match), J (HA scalper), K (London breakout), L (trendline break), M (break & retest), N (mean reversion), O (ICT OTE), P (Okala index fade)
- Added `pattern_recognition.mjs` — n-gram statistical pattern matcher
- Added `twitter_feed.mjs` — X/Twitter sentiment (informational bias)
- Added `performance_tracker.mjs` — consecutive loss stop rule

### Phase 3 — Alpha Kill + Ironclad
- Added Strategy Q: Alpha Kill v1 BOS+Retest (XAUUSD only, +2 pts, PF=1.209)
- Added Strategy R: Ironclad MTF Market Structure (D1 EMA200 + 15M MSS, +2 pts, 72% WR backtest)
- Added Strategies S, T: Daily and Weekly trend alignment proxies

### Phase 4 — Daily Context (Factors U & V)
- Added `buildDailyContext(bars)` — computes PDH, PDL, PDC, ADR, rangeConsumed, pricePos, bias from OHLCV bars
- Added Strategy U: daily extreme zone (+1 when price in lower 40% of PDH-PDL for longs, upper 40% for shorts)
- Strategy V (ADR room filter) was tested and **removed** — it reduced WR on BTC and NAS100
- Daily context logged to `daily_context/YYYY-MM-DD.jsonl` on every scan

### Phase 5 — Weekly Audit & Instrument Re-Ranking
- Built `weekly_review.mjs` — full reverse-engineer of Apr 13-18 across 10 instruments × 4 timeframes
- **Key finding:** NAS100 89% WR, WTI 57%, US30 50% in that trending week
- **Key finding:** Range markets = 8–14% WR system-wide. EMA flatness gate implemented.
- Moved GBPUSD, EURUSD, GBPJPY to Tier 3 (deprioritised, not removed — every instrument has weeks)
- NAS100 promoted to #1 priority in London-NY overlap session list
- `minScore` raised from 10 → 11
- EMA flatness gate added: spread(EMA8,21,50) / EMA50 < 0.4% → score capped at 2

### Phase 6 — Day-Trade Structure
- **Problem:** Old system could carry trades overnight with full SL exposure
- **Solution:** Three-order trailing stop ladder
  - Order 1 (1/3 size): TP1=0.5R, normal SL
  - Order 2 (1/3 size): TP2=1.0R, SL=entry (break-even from day 1)
  - Order 3 (1/3 size): TP3=2.0R, SL=entry (break-even runner)
- Built `eod_close.mjs` — force-closes all positions at 21:45 UTC Mon-Fri
- Added position monitor launch in `session_runner.mjs` (background process)
- Friday 15:30 UTC cutoff added — no new entries late on Fridays

---

## 12. Key Lessons From Backtesting

| Finding | Action Taken |
|---------|-------------|
| Range markets = 8–14% WR | EMA flatness gate blocks all ranging entries |
| NAS100 = 89% WR in trending week | Moved to #1 priority, London-NY overlap |
| GBPUSD/EURUSD = 8–15% WR (range >80% of time) | Moved to Tier 3 (not removed) |
| Factor V (ADR room) hurt BTC/NAS100 WR | Removed entirely — only keep if it improves P&L |
| Factor U (PDH/PDL zones) improved directional accuracy | Kept with 40%/60% threshold |
| Score 10 had lower WR than score 11+ | `minScore` raised to 11 |
| Two-order split was suboptimal (no runner upside) | Upgraded to three-order trailing ladder |

---

## 13. How To Run The System

### On the VM (production)
The cron jobs run automatically. To check status:
```bash
ssh -i ~/.ssh/id_rsa_oracle ubuntu@132.145.44.68
tail -f /home/ubuntu/trading-data/trade_log/trades.csv
```

### Running scripts manually — ALWAYS use run.sh
Any script run manually over SSH must use `run.sh` so it survives if the SSH connection drops.
**Never run `node script.mjs` directly for manual tasks** — it will die if SSH disconnects.

```bash
cd /home/ubuntu/tradingview-mcp-jackson

# Manual scan (test a setup right now)
./run.sh scripts/trading/setup_finder.mjs
tail -f /tmp/setup_finder.log

# Weekly review
./run.sh scripts/weekly_review.mjs
tail -f /tmp/weekly_review.log

# Force close all positions
./run.sh scripts/trading/eod_close.mjs
tail -f /tmp/eod_close.log

# Any backtest
./run.sh scripts/backtest_uv.mjs
tail -f /tmp/backtest_uv.log
```

`run.sh` uses `nohup` internally — the script keeps running even if you close your terminal or the connection drops. Always check results with `cat /tmp/<scriptname>.log`.

> **Cron jobs are not affected by SSH drops** — they run as a VM daemon and are always safe.
> Only manual SSH commands need `run.sh`.

---

*GREED is a living system. After each week, run the weekly review and update instrument tiers. The goal is always the same: highest win rate, highest P&L, minimum overnight risk.*
