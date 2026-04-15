# TRADING KNOWLEDGE BASE — Greedy Algorithm Cheat Sheet
**Last updated:** 2026-04-15 | **Account:** BlackBull Markets Demo £10,000

---

## 1. SESSION SCHEDULE (UTC) — Priority Ranking

| Session | UTC Window | Best Window | Priority | Key Symbols |
|---------|-----------|-------------|----------|-------------|
| **London–NY Overlap** | 13:00–17:00 | 13:00–16:00 | ⭐⭐⭐⭐⭐ | XAU, GBPUSD, EURUSD, BTC, ETH |
| **London Open** | 08:00–17:00 | 08:00–11:00 | ⭐⭐⭐⭐ | EURUSD, GBPUSD, XAU, BTC |
| **NY Open** | 13:00–22:00 | 13:00–17:00 | ⭐⭐⭐⭐ | BTC, ETH, XAU, NAS100, GBPUSD |
| **Asian/Tokyo** | 00:00–09:00 | 00:00–04:00 | ⭐⭐⭐ | USDJPY, AUDUSD, BTC, XAU |
| **Dead zones** | 22:00–00:00, 09:00–11:00 | — | ❌ AVOID | Low volume, choppy |

### Cron fire times (UTC):
- **07:30** — Pre-London: news check, mark S/R levels
- **08:05** — London open scan
- **12:30** — Pre-NY: news check
- **13:05** — NY open scan (HIGHEST PRIORITY)
- **17:00** — London close check (manage open trades)
- **23:30** — Pre-Asian: news check
- **00:05** — Asian open scan

---

## 2. INSTRUMENT RANKINGS (BlackBull Markets)

### Tier 1 — Best R:R, Volume, Spread ratio:
| Symbol | Session | Spread | Volatility | Notes |
|--------|---------|--------|------------|-------|
| **XAUUSD** | London–NY overlap | Tight | ★★★★★ | Trending, best for trail exits |
| **BTCUSD** | All sessions | Low % | ★★★★★ | 24/7, strong trends |
| **EURUSD** | London–NY | Tightest | ★★★ | Highest volume, predictable |
| **GBPUSD** | London | Moderate | ★★★★ | More volatile than EUR |
| **ETHUSD** | All sessions | Low % | ★★★★ | Short-bias validated |
| **USDJPY** | Asian | Tight | ★★★ | Carry trade, trending |

### Tier 2 — Use when Tier 1 is ranging:
- AUDUSD (Asian session), USDCAD, NAS100 (Long Only, NY session)

### AVOID:
- Any index on 1M (noise + commission)
- BTC/ETH on 1M-3M (noise)
- Thinly traded pairs: USDMXN, exotic crosses

---

## 3. NEWS AVOIDANCE PROTOCOL

**Rule:** NO trades within ±30 min of HIGH-IMPACT news.

### High-impact events to track (Forex Factory red flags):
| Event | Frequency | Affected Symbols |
|-------|-----------|-----------------|
| **FOMC Rate Decision** | 8x/year | ALL markets |
| **US NFP** (Non-Farm Payrolls) | 1st Fri/month, 13:30 UTC | USD pairs, XAU, indices |
| **US CPI/PPI** | Monthly | USD pairs, XAU |
| **ECB Rate Decision** | 8x/year | EURUSD, EURJPY |
| **BOE Rate Decision** | 8x/year | GBPUSD, GBPJPY |
| **US GDP** | Quarterly | USD pairs |
| **Fed Chair Speech** | Variable | ALL markets |

### News sources to check daily:
1. **Forex Factory**: `https://www.forexfactory.com/calendar` — Filter: High Impact only
2. **X (Twitter)**: @muroCrypto, @i_am_jackis, @eliz883, @CryptoBullet
3. **TradingView News** panel on chart

### Protocol:
```
IF next_news_event ≤ 30 min away → SKIP SESSION, reschedule +90 min
IF trade open AND news_event ≤ 15 min → CLOSE or move to breakeven
```

---

## 4. MULTI-STRATEGY SIGNAL SCORING SYSTEM (A–P, 16 factors)

**Entry threshold: Score ≥ 4 out of 16 points**
**Convergence bonus: 5+ unique strategies agree → +1 extra point**

| Factor | ID | What it checks | Points |
|--------|----|----------------|--------|
| **HTF Trend** | A | D1 EMA slope bullish/bearish | +1 |
| **Price at S/R** | B | Within 0.5% of swing high/low | +1 |
| **Rejection candle** | C | Pin bar or engulfing at level | +1 |
| **Volume spike** | D | Volume > 1.2× 20-bar SMA | +1 |
| **RSI/MFI momentum** | E | RSI 35–60 long / 40–65 short | +1 |
| **Session quality** | F | London–NY overlap (13:00–17:00 UTC) | +1 |
| **EMA alignment** | G | Fast EMA above slow (long) / below (short) | +1 |
| **HA doji pullback** | H | HA candle body ≤ 30% of range | +1 |
| **Smart Trail signal** | I | Smart Trail direction matches trade | +1 |
| **JG HA Scalper** | J | HA pullback + EMA100 filter | +1 |
| **JG London Breakout** | K | London range active (UTC 13:00–18:00) + breakout | +1 |
| **Tori Trendline Break** | L | Pivot-based projected trendline break | +1 |
| **WOR Break & Retest** | M | Major level broken then retested (±0.5×ATR) | +1 |
| **WOR Marci HTF MR** | N | Range pos <20% or >80% + EMA50 slope confluence | +1 |
| **WOR NBB ICT OTE** | O | Fibonacci 61.8–79% OTE zone retracement | +1 |
| **WOR Okala NQ** | P | Over-extension >1.5×ATR from EMA21 (indices, NY morning) | +1 |

**Score ≥ 12/16** → 2.0% risk
**Score ≥ 9/16** → 1.5% risk
**Score ≥ 4/16** → 1.0% risk
**Score < 4/16** → NO TRADE

**Convergence bonus**: when 5 or more distinct strategy signals (I–P) agree → score +1

---

## 5. STRATEGIES LIBRARY

All Pine files: `C:\Users\Tda-d\tradingview-autopilot\strategies\`

### 1. JG Smart Trail HA Scalper
- **Author**: Jooviers Gems | **File**: `jooviers_gems_smart_trail_scalper.pine`
- **Logic**: Smart Trail direction + Heiken-Ashi doji pullback + MFI gate
- **WR**: 29–33% | **PF**: 1.93–3.78 | **Edge**: large winners vs small losers
- **Best on**: BTC 15M (Extended), XAU 15M/30M (Extended), ETH 5M (Fixed TP)
- **Exit modes**: Extended (trail until flip) for BTC/XAU; Fixed TP (2R) for ETH
- **Session**: NY 09:30–16:00 ET | **Scoring factor**: I

### 2. JG HA Scalper
- **Author**: Jooviers Gems | **File**: `jooviers_gems_ha_scalper.pine`
- **Logic**: HA reversal candle + EMA100 trend filter
- **WR**: ~30% | **PF**: 1.27 (BTC only)
- **Best on**: BTC 15M ($80, PF 1.27). ETH and XAU negative — **disable for ETH/XAU in scanner**
- **Session**: Any | **Scoring factor**: J

### 3. JG London Breakout
- **Author**: Jooviers Gems | **File**: `jooviers_gems_london_breakout.pine`
- **Logic**: London session range (08:00–13:00 UTC) breakout continuation
- **WR**: ~37% | **PF**: 1.14 (XAU only)
- **Best on**: XAU 15M ($342, PF 1.14). GBPUSD/EURUSD both negative on 15M
- **Session**: London–NY (13:00–18:00 UTC only) | **Scoring factor**: K

### 4. Tori 4H Trendline Break
- **Author**: Tori Trades | **File**: `tori_trades_trendline_strategy.pine`
- **Logic**: Pivot-based projected trendlines; entry on confirmed break with HA confirmation
- **WR**: ~36% | **PF**: 1.17 (NAS100 4H)
- **Best on**: NAS100 4H ($3,655, PF 1.17). GBPUSD/EURUSD both deeply negative on 4H
- **Timeframe**: Designed for 4H — do not use below 1H | **Scoring factor**: L

### 5. WOR Break & Retest (Vincent Desiano)
- **Author**: Words of Rizdom #031 | **File**: `wor_break_and_retest.pine`
- **Logic**: Swing high/low break → decisive close → wait for pullback retest → enter at level
- **WR**: ~36% | **PF**: 1.05 (XAU 1H)
- **Best on**: XAU 1H ($637, PF 1.05). BTC 1H and GBPUSD 15M negative
- **Key rule**: Patience — skip any retest that isn't clean; stop beyond broken level | **Scoring factor**: M

### 6. WOR Marci HTF Mean Reversion (Marci Silfrain)
- **Author**: Words of Rizdom #009 | **File**: `wor_marci_silfrain_htf_mean_reversion.pine`
- **Logic**: Top-down trend context (Weekly/Daily EMA) → enter at intraday extreme (range top/bottom) with RSI filter
- **WR**: ~33% | **PF**: 0.76 on all tested 15M combos — **all negative on 15M**
- **Best on**: Designed for 1H/4H — 15M combos all lose. Only enable scoring factor on 1H+ charts
- **Key rule**: STATIC stop — never trail, never move | **Scoring factor**: N (1H/4H only)

### 7. WOR NBB ICT Power of 3 (NBB)
- **Author**: Words of Rizdom (ICT-based) | **File**: `wor_nbb_ict_power_of_3.pine`
- **Logic**: ICT OTE zone (Fibonacci 61.8–79% retracement), session bias, FVG + BOS confirmation
- **WR**: 34–37% | **PF**: 1.07–1.14 across BTC/NAS100/XAU
- **Best on**: XAU 15M ($342, PF 1.14), BTC 15M ($294, PF 1.07), NAS100 15M ($168, PF 1.08)
- **Surprisingly consistent** — only strategy profitable on all 3 tested symbols | **Scoring factor**: O

### 8. WOR Okala NQ Scalper (OkalaNQ)
- **Author**: Words of Rizdom #003 | **File**: `wor_okala_nq_scalper.pine`
- **Logic**: Over-extension fade — price >1.5×ATR from EMA21, reversion entry, fixed 10-point stop
- **Best on**: NQ/NAS100 ONLY (indices). NY morning 09:30–12:00 ET only
- **Key rule**: Fixed 10-point stop always. Stop after 2 consecutive losses | **Scoring factor**: P (indices, NY morning only)
- **Baseline**: Pending (Pine v6 compile errors fixed 2026-04-15; rerun required)

---

## 6. SUPPORT & RESISTANCE METHODOLOGY

### How to draw S/R rectangles (institutional method):
1. **Switch to H4 or D1** — mark major swing highs/lows
2. **Draw zone** (not a line): extend 5–10 pips above/below wick tip
3. **Strength ranking**:
   - Multiple touches = stronger
   - Tested after long time away = stronger
   - Round numbers (1.2000, 2300, 45000) = psychological support
   - Fibonacci levels (0.618, 0.5, 0.382) = additional confluence
4. **Key zones to always mark**:
   - Previous day high/low
   - Previous week high/low
   - Monthly open
   - 50% of prior major move
5. **Invalidation**: S/R invalidated when price CLOSES beyond by >1× ATR

### Fibonacci Levels (most important):
- **0.382** — shallow retracement, continuation expected
- **0.500** — 50% midpoint, high probability reversal
- **0.618** — "golden ratio", strongest reversal zone
- **0.786** — deep retracement, last chance before invalidation

---

## 7. RISK MANAGEMENT RULES

| Rule | Value | Why |
|------|-------|-----|
| Max risk per trade | 1–2% of account | Protect capital above all |
| Max daily loss | 4% | Stop trading session if hit |
| Max drawdown limit | 10% | Below this = review strategy |
| Breakeven rule | Move SL to entry at 1R profit | Lock in no-loss scenario |
| Partial close | Take 50% at 1R, trail rest | Boost WR mechanically |
| Max trades/session | 3 | Quality > quantity |
| Max trades/day | 5 | Overtrading kills edge |
| Stop after | 2 consecutive losses | Revenge trading prevention |
| Position sizing | Fixed % of equity | Compounds correctly |

---

## 8. OPTIMAL TRADE COUNT PER SESSION

**Research conclusion**: 1–3 high-quality trades per session outperforms 5–10 lower-quality trades.

- **1 perfect trade**: Best outcome if well-selected
- **2–3 trades**: Optimal for diversification without overtrading
- **4+ trades**: Diminishing returns, increased mistakes

**Why fewer trades = more profit:**
- Each setup requires full concentration
- More setups = lower average quality
- Commission drag compounds on small accounts
- Better position sizing on high-confidence setups

---

## 9. PATTERN RECOGNITION FRAMEWORK

Think of each candle pattern as having a *probability score* based on:
1. **Where it forms** (at S/R = higher probability)
2. **What preceded it** (strong impulse = continuation more likely)
3. **Volume** (volume spike = institutional participation)
4. **Candle body ratio** (large body = conviction, small body = indecision)

### High-probability patterns (sorted by reliability):
| Pattern | Direction | Win Rate | Notes |
|---------|-----------|----------|-------|
| Engulfing at S/R | Both | 68–72% | Must be at key level |
| Pin bar at S/R | Both | 65–70% | Wick = 2× body minimum |
| Morning/Evening Star | Both | 63–68% | 3-candle reversal |
| Inside bar breakout | Both | 58–65% | Directional filter required |
| Doji at S/R + volume | Both | 60–68% | JG strategy signal |
| Double top/bottom | Both | 65–72% | Confirmed with neckline break |
| Head & Shoulders | Both | 65–70% | Wait for neckline break |

---

## 10. DAILY ROUTINE CHECKLIST

### Pre-Session (30 min before):
- [ ] Check Forex Factory for high-impact news (±30 min buffer)
- [ ] Check @muroCrypto, @i_am_jackis, @eliz883, @CryptoBullet on X
- [ ] Mark D1/H4 S/R levels on top instruments
- [ ] Check HTF trend direction (Smart Trail on D1/H4)
- [ ] Note previous day high/low for all instruments
- [ ] Check overall market sentiment (risk-on/risk-off)

### Session Start:
- [ ] Check if score ≥ 4/16 for any setup (A–P system, see Section 4)
- [ ] If no setup found within 30 min → skip session
- [ ] Max 3 setups per session
- [ ] Set alerts at key levels

### Trade Management:
- [ ] Move to breakeven at 1R
- [ ] Take partial (50%) at 1.5R
- [ ] Trail remainder with Smart Trail
- [ ] Hard TP at 3R (Extended mode: 4R)

### Post-Session Review:
- [ ] Log trade result (W/L, entry/exit, setup type, score)
- [ ] Note what worked / what didn't
- [ ] Update knowledge base if pattern learned

---

## 11. FULL STRATEGY SUITE BASELINES (April 2026, $100K simulated, 0.05% commission)

### JG Smart Trail HA Scalper
| Symbol | TF | Mode | Trades | Net P&L | WR% | PF | Notes |
|--------|-----|------|--------|---------|-----|----|-------|
| BTC | 15M | Extended | 17 | +$165.75 | 29.4% | 1.933 | ✓ Best overall |
| XAU | 15M | Extended | 7 | +$114.50 | 28.6% | 3.782 | ✓ Highest PF |
| XAU | 30M | Extended | 9 | +$82.36 | 33.3% | 2.678 | ✓ |
| ETH | 5M | Fixed TP | 11 | +$13.61 | 18.2% | 1.136 | ⚠ Weak |
| ETH | 1M | Fixed TP | 6 | +$4.84 | 33.3% | 1.223 | ⚠ Low volume |

### JG HA Scalper
| Symbol | TF | Trades | Net P&L | WR% | PF | Notes |
|--------|-----|--------|---------|-----|----|-------|
| BTC | 15M | 10 | +$80.97 | 30% | 1.274 | ✓ BTC only |
| ETH | 5M | 9 | -$67.59 | 33.3% | 0.731 | ✗ Disable |
| XAU | 15M | 3 | -$95.32 | 0% | 0 | ✗ Disable |

### JG London Breakout
| Symbol | TF | Trades | Net P&L | WR% | PF | Notes |
|--------|-----|--------|---------|-----|----|-------|
| XAU | 15M | 94 | +$342.57 | 37.2% | 1.137 | ✓ XAU only |
| EURUSD | 15M | 87 | -$266.82 | 36.8% | 0.639 | ✗ Disable |
| GBPUSD | 15M | 96 | -$540.46 | 33.3% | 0.467 | ✗ Disable |

### Tori 4H Trendline Break
| Symbol | TF | Trades | Net P&L | WR% | PF | Notes |
|--------|-----|--------|---------|-----|----|-------|
| NAS100 | 4H | 296 | +$3,655.02 | 35.8% | 1.171 | ✓ 4H only |
| EURUSD | 4H | 308 | -$1,477.18 | 34.7% | 0.846 | ✗ Disable |
| GBPUSD | 4H | 321 | -$2,584.02 | 29.6% | 0.764 | ✗ Disable |

### WOR Break & Retest
| Symbol | TF | Trades | Net P&L | WR% | PF | Notes |
|--------|-----|--------|---------|-----|----|-------|
| XAU | 1H | 335 | +$637.54 | 36.4% | 1.051 | ✓ Best |
| BTC | 1H | 271 | -$2,624.52 | 28.8% | 0.864 | ✗ |
| GBPUSD | 15M | 96 | -$540.46 | 33.3% | 0.467 | ✗ |

### WOR Marci HTF Mean Reversion
| Symbol | TF | Trades | Net P&L | WR% | PF | Notes |
|--------|-----|--------|---------|-----|----|-------|
| NAS100 | 15M | 296 | -$1,295.93 | 32.8% | 0.76 | ✗ Wrong TF |
| SPX500 | 15M | 296 | -$1,295.93 | 32.8% | 0.76 | ✗ Wrong TF |
| US30 | 15M | 296 | -$1,295.93 | 32.8% | 0.76 | ✗ Wrong TF |

> **Note**: All 15M results negative. This strategy is designed for 1H/4H. Only use scoring factor N on 1H+ charts.

### WOR NBB ICT Power of 3
| Symbol | TF | Trades | Net P&L | WR% | PF | Notes |
|--------|-----|--------|---------|-----|----|-------|
| XAU | 15M | 94 | +$342.57 | 37.2% | 1.137 | ✓ Best |
| BTC | 15M | 102 | +$294.72 | 35.3% | 1.073 | ✓ |
| NAS100 | 15M | 99 | +$168.92 | 34.3% | 1.080 | ✓ Consistent |

> **Note**: Only strategy profitable across ALL 3 tested symbols. Strong ICT-based edge.

### WOR Okala NQ Scalper
| Symbol | TF | Trades | Net P&L | WR% | PF | Notes |
|--------|-----|--------|---------|-----|----|-------|
| NAS100/NQ | 1M–5M | — | TBD | TBD | TBD | Baseline pending |

> **Note**: Designed for NQ futures only, NY 09:30–12:00 ET. 10-point fixed stop = $200/contract. Rerun baseline after 2026-04-15 compile fixes.

---

## 12. GREEDY ALGORITHM DECISION TREE

```
SESSION START
│
├─ 1. CHECK NEWS (news_checker.mjs)
│    ├─ High-impact news in <30 min? → WAIT, reschedule +90 min
│    └─ Clear? → Continue
│
├─ 2. CHECK TWITTER SIGNALS (twitter_feed.mjs)
│    └─ @muroCrypto, @i_am_jackis, @eliz883, @CryptoBullet sentiment check
│
├─ 3. SCAN INSTRUMENTS (setup_finder.mjs — session_runner.mjs)
│    Priority: XAU → BTC → GBPUSD → EURUSD → ETH → NAS100 → ...
│    For each instrument: run ALL 16 factors (A–P)
│    Score = sum of true factors + convergence bonus if 5+ strategy signals agree
│
├─ 4. SCORE ≥ 4/16?
│    ├─ YES → Enter trade with risk-sized position
│    │   ├─ Score ≥ 12: 2.0% risk
│    │   ├─ Score ≥ 9:  1.5% risk
│    │   └─ Score ≥ 4:  1.0% risk
│    └─ NO → Skip, check next instrument or wait
│
├─ 5. TRADE EXECUTION (execute_trade.mjs)
│    ├─ Open ticket in correct direction (buy-order-button / sell-order-button)
│    ├─ Set TP1 (partial 50%), TP2/SL
│    └─ Launch position_monitor.mjs in background
│
├─ 6. TRADE MANAGEMENT
│    ├─ At 1R → Move to breakeven
│    ├─ At 1.5R → Close 50% partial (TP1)
│    └─ Remainder → Trail or fixed TP2 per strategy mode
│
└─ 7. SESSION END / POST-TRADE
     ├─ position_monitor.mjs records W/L + PnL to trades.csv on close
     ├─ Close any open positions 30 min before session end
     └─ Strategy researcher runs biweekly (Sundays 04:03 UTC) to analyse
        weak spots and generate experimental Pine variants
```

### Symbol × Strategy matrix (validated profitable combos only):
| Symbol | TF | Strategies to weight |
|--------|-----|---------------------|
| XAU | 15M | Smart Trail, London Breakout, NBB ICT |
| XAU | 1H | BnR |
| BTC | 15M | Smart Trail, HA Scalper, NBB ICT |
| NAS100 | 4H | Tori Trendline |
| NAS100/NQ | 1–5M | Okala NQ (NY morning only) |
| ETH | 5M | Smart Trail (Fixed TP, low conviction) |
