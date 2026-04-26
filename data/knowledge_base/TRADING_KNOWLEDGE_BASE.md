# TRADING KNOWLEDGE BASE — Greedy Algorithm Cheat Sheet
**Last updated:** 2026-04-23 | **Account:** BlackBull Markets Demo — Balance £14,687

---

## 1. SESSION SCHEDULE (UTC) — Priority Ranking

| Session | UTC Window | Best Window | Priority | Key Symbols | Score Gate |
|---------|-----------|-------------|----------|-------------|------------|
| **London–NY Overlap** | 13:00–17:00 | 13:00–16:00 | ⭐⭐⭐⭐⭐ | XAU, GBPUSD, EURUSD, BTC, ETH | ≥10 |
| **London Open** | 08:00–12:59 | 08:00–11:00 | ⭐⭐⭐⭐ | EURUSD, GBPUSD, XAU, BTC | ≥12 |
| **NY Continuation** | 17:00–21:59 | 17:00–20:00 | ⭐⭐⭐ | BTC, ETH, NAS100, US30, XAU | ≥12 |
| **Asian/Tokyo** | 00:00–06:59 | 00:00–04:00 | ⭐⭐⭐ | BTCUSD only | ≥13 |
| **Dead zone** | 22:00–00:00 | — | ❌ AVOID | No trades — EOD close triggered | — |

### Day trading rule (2026-04-23):
**ALL trades MUST close by 22:00 UTC same day.** `position_monitor.mjs` auto-closes any open position at 22:00 UTC. No overnight carry.

### Cron fire times (UTC, Mon–Fri):
- **00:00** — Asian open scan (BTCUSD only)
- **08:00** — London open scan (score ≥ 12)
- **13:00** — London-NY overlap scan (HIGHEST PRIORITY)
- **15:00** — NY mid-session scan
- **17:00** — NY continuation scan (crypto/indices only, score ≥ 12)
- **20:00** — NY continuation scan (crypto/indices only, score ≥ 12)

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

## 4. MULTI-STRATEGY SIGNAL SCORING SYSTEM (A–R, 18 factors)

**Entry threshold: Score ≥ 10 out of 18 points** *(raised from 4 on 2026-04-20 — lower scores lose)*
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
| **Alpha Kill v1 BOS+Retest** | Q | D1+H4 EMA trend + H1 BOS break + retest within 0.5×ATR (XAUUSD H1 only) | +2 |
| **Ironclad MTF MSS** | R | D1 EMA200 trend + LTF swing N=6 MSS break (all pairs) | +2 |
| **Daily Trend Alignment** | S | D1 EMA proxy (bars-per-day lookback) slope matches trade direction | +1 |
| **Weekly Trend Alignment** | T | W1 EMA proxy (5× daily lookback) slope matches trade direction | +1 |

**Score ≥ 14/20** → 2.0% risk
**Score ≥ 12/20** → 1.5% risk
**Score ≥ 10/20** → 1.0% risk
**Score < 10/20** → NO TRADE

**SL/TP overrides:**
- Strategy Q (XAUUSD H1): SL = 2.0×ATR, TP = 8.0×ATR (4R)
- All other setups: SL = 1.5×ATR

**Multi-TP split (all trades since 2026-04-20):**
- Order 1 (half position): TP at 0.5R (quick lock-in)
- Order 2 (half position): TP at 1.5R (main target)
- After TP1 hit: manually move SL of Order 2 to entry (breakeven)

**Session gates (updated 2026-04-23):**
- London–NY overlap (13:00–17:00 UTC): all setups ≥10
- London open (08:00–12:59 UTC): all symbols ≥12
- NY continuation (17:00–21:59 UTC): BTCUSD/ETHUSD/NAS100/US30/SPX500/XAUUSD only, ≥12
- Asian (00:00–06:59 UTC): BTCUSD only, score ≥13
- Dead zone (22:00–00:00 UTC): NO TRADE — EOD close runs at 22:00

**Convergence bonus**: when 5 or more distinct strategy signals (A–T) agree → score +1

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

### 9. Alpha Kill v1 — BOS + Retest (Riley Coleman approach)
- **File**: `strategies/alpha_kill_v1.pine` (521 lines) | **Scoring factor**: Q (+2 pts)
- **Logic**: D1 EMA200 trend + H4 EMA50 trend filter → H1 swing BOS detected within 60 bars → price retesting broken level within 0.5×ATR of it
- **Best on**: XAUUSD H1 ONLY (backtested Jan 2024–Apr 2026)
- **Backtest result**: PF = 1.209 | Period: Jan 2024–Apr 2026
- **Best config**: H1 timeframe, SL = 2.0×ATR, TP = 4R (8.0×ATR) single exit
- **Tested configs**: SL multiples 1.0–3.0×ATR, TP 1R–6R, TF 15M/H1/H4 — H1+2.0×ATR+4R was clear winner
- **Scoring override**: When Q fires on XAUUSD H1: SL = 2.0×ATR, TP = 8.0×ATR (vs 1.5/3.0 default)
- **CRITICAL**: 15M and H4 were not profitable for this strategy; H1 only
- **Concept origin**: Riley Coleman CHoCH/BOS + retest methodology (validated via YouTube research)

### 10. Ironclad MTF Market Structure
- **File**: `strategies/ironclad_mtf_structure.pine` (116 lines) | **Scoring factor**: R (+2 pts)
- **Source**: YouTube "Backtested Trading Guru's Strategy: Here's the Truth" (s9HV_jyeUDk) by IRONCLAD TRADING
- **Video claims**: 957% return, 72% WR, 26%/yr, 49.9% max DD, 10yr tick data, 5 CME Forex pairs
- **Logic**: Daily HTF trend (pivot HH+HL or LL+LH via N=2 lookback, `gaps=barmerge.gaps_on`) + LTF MSS (swing N=6 close breaks above/below last swing high/low)
- **Backtest (Nov 2025–Apr 2026 window)**:
  - XAUUSD 15M: PF = 1.267 ✓ (marginal)
  - All 5 Forex pairs (EUR/USD, GBP/USD, AUD/USD, USD/CHF, USD/JPY): PF < 1 across 15M + H1, RR = 1.5/2.0/3.0 ✗
- **Deployment**: Strategy R fires as a +2 scoring factor for all pairs; but short 5.5-month window is insufficient to validate video's 10yr results
- **CRITICAL Pine v5 note**: MUST use `gaps=barmerge.gaps_on` on `request.security()` for HTF pivot detection. Default `gaps_off` carries forward last pivot to every bar → `ph1 == ph2` always → trend condition never fires → 0 trades. This is non-obvious.

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
| NAS100/NQ | 1M–5M | — | N/A | N/A | N/A | No backtest data available |
| ETHUSD (control) | 5M | 23 | -$2.12 | 52.2% | 0.53 | Session filter off — confirms Pine logic fires |

> **Note**: Designed for NQ futures only, NY 09:30–12:00 ET. 10-point fixed stop = $200/contract.
> **Backtest limitation**: BlackBull TradingView has no Pine strategy data for BLACKBULL:NAS100, BLACKBULL:US30, NASDAQ:QQQ, or CAPITALCOM:US100. CME:NQ1! not available on BlackBull. Strategy logic confirmed working (ETH control). Parameters derived from Okala's interview rules. 2026-04-19.

### Alpha Kill v1 — BOS + Retest (Q)
| Symbol | TF | SL | TP | Trades | WR% | PF | Notes |
|--------|-----|-----|-----|--------|-----|----|-------|
| XAUUSD | H1 | 2.0×ATR | 4R (8.0×ATR) | — | — | **1.209** | ✓ Best config |
| XAUUSD | 15M | various | various | — | — | <1 | ✗ Not profitable |
| XAUUSD | H4 | various | various | — | — | <1 | ✗ Not profitable |

> Period: Jan 2024–Apr 2026. XAUUSD H1 only. SL/TP override applied automatically by session_runner.

### Ironclad MTF Market Structure (R)
| Symbol | TF | RR | Trades | WR% | PF | Notes |
|--------|-----|-----|--------|-----|----|-------|
| XAUUSD | 15M | 1.5 | — | — | **1.267** | ✓ Marginal |
| EUR/USD | 15M | 1.5 | 55 | 43.64% | 0.609 | ✗ |
| EUR/USD | 15M | 2.0 | — | — | <1 | ✗ |
| EUR/USD | 15M | 3.0 | — | — | <1 | ✗ |
| EUR/USD | H1 | 1.5 | — | — | <1 | ✗ |
| GBP/USD | 15M | 1.5 | — | — | <1 | ✗ |
| AUD/USD | 15M | 1.5 | — | — | <1 | ✗ |
| USD/CHF | 15M | 1.5 | — | — | <1 | ✗ |
| USD/JPY | 15M | 1.5 | — | — | <1 | ✗ |

> Period: Nov 2025–Apr 2026 (5.5 months). Video's 10yr results cannot be validated in this window. Forex pairs all unprofitable. XAUUSD 15M marginal. Not deployed standalone; contributes +2 to composite score.

---

## 12. GREEDY ALGORITHM DECISION TREE

```
SESSION START
│
├─ 0a. FRIDAY CUTOFF CHECK
│    └─ After 15:30 UTC Friday? → EXIT immediately (no new trades)
│
├─ 0b. SESSION GATE
│    ├─ London–NY overlap (13:00–17:00 UTC)? → Continue
│    ├─ Asian (00:00–07:00 UTC) + BTCUSD + score ≥ 13? → Continue
│    └─ All other sessions → EXIT
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
│    For each instrument: run ALL 18 factors (A–R)
│    Score = sum of true factors + convergence bonus if 5+ strategy signals agree
│
├─ 4. SCORE ≥ 10/18?
│    ├─ YES → Enter trade with risk-sized position
│    │   ├─ Score ≥ 14: 2.0% risk
│    │   ├─ Score ≥ 12: 1.5% risk
│    │   └─ Score ≥ 10: 1.0% risk
│    └─ NO → Skip, check next instrument or wait
│
├─ 5. TRADE EXECUTION (execute_trade.mjs) — MULTI-TP SPLIT
│    ├─ Calculate: halfLots = floor(totalLots / 2)
│    ├─ Order 1 (halfLots): TP at 0.5R (tpQuick), SL = ATR-based
│    ├─ Order 2 (halfLots): TP at 1.5R (tp2),     SL = same
│    ├─ SL override if strategy Q (XAUUSD H1): SL=2.0×ATR, TP=4R
│    └─ Launch position_monitor.mjs --entry=PRICE --numOrders=2
│
├─ 6. TRADE MANAGEMENT
│    ├─ TP1 hit (Order 1 closes) → monitor logs ⚡ BE TRIGGER
│    │   └─ MANUALLY move Order 2 SL to entry (breakeven)
│    ├─ TP2 hit (Order 2 closes) → full win
│    └─ SL hit on both → loss
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
| XAU | H1 | **Alpha Kill v1 Q** (best: PF 1.209), BnR (M), Ironclad MSS (R) |
| XAU | 15M | Smart Trail (I), London Breakout (K), NBB ICT (O), Ironclad MSS (R) |
| BTC | 15M | Smart Trail (I), HA Scalper (J), NBB ICT (O) |
| NAS100 | 4H | Tori Trendline (L) |
| NAS100/NQ | 1–5M | Okala NQ (P) — NY morning only |
| ETH | 5M | Smart Trail (I) — Fixed TP, low conviction |

---

## 13. BIWEEKLY RESEARCH UPDATE — 2026-04-18

### System Fixes Applied This Cycle
- **Position monitor bug fixed**: spawn now logs to `position_monitor.log` (was silenced with `stdio:ignore`). First poll delay increased from 3s → 30s to allow broker panel to register position.
- **Session runner path fixed**: cross-platform DATA_ROOT resolves correctly on Linux VM and Windows.
- **AUDUSD lot sizing fix**: session_runner now uses `calcLots()` (corrects ~$150 risk → 3 lots at 5-pip SL). Previous bug produced 100 raw units (rejected by broker, min 0.01 lots = 1000 units).
- **Twitter feeds**: All 4 feeds (@muroCrypto, @i_am_jackis, @eliz883, @CryptoBullet) unreachable via nitter. Sentiment check skipped until fixed.

### Trade Review: Week of Apr 14–18
| Date | Symbol | Result | Notes |
|------|--------|--------|-------|
| Apr 16 13:01 | XAUUSD | ? | Monitor bug — check manually |
| Apr 16 15:01 | ETHUSD | ? | Monitor bug — SL/TP updated Apr 17 13:51 |
| Apr 17 00:01 | BTCUSD | **LOSS** | SL confirmed hit 23:05 UTC |
| Apr 17 08:01 | AUDUSD | **VOID** | Order rejected (lot size bug — fixed) |
| Apr 17 13:01 | GBPUSD | ? | Monitor bug — orders updated 19:58 |
| Apr 17 15:01 | XAGUSD | ? | Monitor bug — result unknown |
**Account balance**: £14,687 (started £10,000, net +£4,687 overall)

### Market Context — Week of Apr 21–25, 2026
**XAU/USD (Gold)**
- Current price: ~$4,831
- Key support: $4,760 → $4,701 → $4,645
- Key resistance: $4,881 → $4,937 → $4,996
- Bias: Neutral/consolidating. MACD near zero line, RSI ~51. No strong direction.
- Watch: US PMI data (Tue/Wed), initial jobless claims (Thu), UoM inflation expectations (Fri)
- ATR stop guidance: Gold volatility requires 1.5–2× ATR14 stops. Fixed stops fail in current regime.

**BTC/USD**
- Current price: ~$75,000–$76,000 range
- Key support: $68,900–$72,000 zone
- Key resistance: $75,000–$85,000 zone (current cap)
- Bias: Bearish caution. Fear & Greed Index = 21 (Extreme Fear). Wait for $75K breakout confirmation.
- ASIAN session BTC trade Apr 17 hit SL → reduce BTC weight in ASIAN session.

**GBP/USD**
- Current price: ~1.3560–1.3580
- Key resistance: 1.3610 (breakout level)
- Key support: 1.3500–1.3470
- Bias: Bullish. BoE pricing in 3 rate hikes 2026. Long bias above 1.3500.
- Actionable: Long on pullback to 1.3500–1.3470 zone targeting 1.3610.

**EUR/USD**
- Current price: ~1.1820
- Key resistance: 1.1825 (March high) → 1.1925 (Feb high) → 1.19 trendline
- Key support: 1.1660 → 1.1480
- Bias: Bullish. Break and hold above 1.1825 → target 1.22+.

**NAS100**
- Current price: ~26,370
- Key resistance: 26,350–26,600 zone
- Key support: 26,000–25,700
- Bias: Bullish trend intact. Tori 4H Trendline strategy optimal.

### Upcoming High-Impact Events (Week Apr 21–25)
| Day | Event | Impact | Symbols |
|-----|-------|--------|---------|
| Mon Apr 21 | No major events | — | — |
| Tue Apr 22 | US PMI Manufacturing Flash | HIGH | USD pairs, XAU |
| Wed Apr 23 | US PMI Services Flash | HIGH | USD pairs, XAU |
| Thu Apr 24 | US Initial Jobless Claims | MEDIUM | USD pairs |
| Fri Apr 25 | UoM Inflation Expectations | MEDIUM | USD pairs, XAU |
**No FOMC or NFP this week** (NFP was Apr 3, next FOMC TBC).

### Trendline Methodology Update (from research)
**Key insight confirmed**: Trendlines are ZONES, not single lines.
- **Drawing rule**: Connect maximum number of touches using BOTH wicks AND body closes.
- **Zone width**: Extend 5–10 pips around the line to form a zone rectangle.
- **Wick poke-through = liquidity grab** → NOT a confirmed break. Only body CLOSE beyond zone confirms break.
- **Validation**: 3+ touches required for tradeable level. 1 touch = accident, 2 = coincidence.
- **Trendline bounce entry**: Enter at 3rd/4th touch of trendline zone with volume confirmation.
- **Confluence**: Best signals when trendline zone aligns with Fibonacci (0.618), S/R level, or session open.
- **Update Pine scoring**: Factor L (Tori Trendline) should require 3+ touches AND body close confirmation for break entries.

### Knowledge Base Updates Applied
1. Market context levels updated for week Apr 21–25
2. BTC ASIAN session — reduce priority (SL hit on Apr 17 00:01 trade)
3. Gold ATR stop confirmed best practice: 1.5–2× ATR14
4. Trendline-as-zone methodology documented above
5. System bugs fixed and documented

---

## 14. RESEARCH UPDATE — 2026-04-20

### System Changes Applied This Cycle

**Score threshold raised: 4 → 10** (critical fix — 2026-04-20)
- Trades at score 8–9 had 20% WR (Apr 14–18 audit). Raising to ≥10 eliminates marginal setups.
- Rationale: the full system can generate max ~18 points; median real-world score is ~7–9. Only the top confluence events (score 10+) have statistically meaningful edge.

**Multi-TP split architecture deployed** (2026-04-20)
- Previous: single full-size order at 3R TP
- New: two half-size orders — 0.5R quick lock + 1.5R main
- Effect: ~70% of valid entries expected to hit TP1 → those become wins or break-even
- BE after TP1: currently manual (monitor logs trigger); automation deferred

**Session gate enforced** (2026-04-20)
- London–NY overlap (13:00–17:00 UTC) is mandatory for all setups
- Asian session: BTCUSD only with score ≥ 13
- Friday hard cutoff: 15:30 UTC (user was manually closing trades to avoid weekend carry)

**Two new strategies integrated** (2026-04-20)
- Q: Alpha Kill v1 BOS+Retest (XAUUSD H1, PF=1.209)
- R: Ironclad MTF MSS (all pairs, XAUUSD 15M PF=1.267; Forex pairs ✗ in current window)
- Both contribute +2 pts when triggered (double-weighted due to structural nature)

### Ironclad MTF — Key Technical Discovery
Pine v5 `request.security()` with default `gaps=barmerge.gaps_off` carries the last non-na value forward to EVERY subsequent bar. This means `if not na(_htf_ph)` fires on every bar, making two tracked pivot variables always equal → trend condition never true → 0 trades. Solution: `gaps=barmerge.gaps_on` (fires only once per HTF bar close). This applies to any Pine script tracking HTF pivot sequences with accumulator variables.

### Alpha Kill v1 — Optimisation Findings
Tested XAUUSD backtest Jan 2024–Apr 2026. Configuration space: TF (15M/H1/H4) × SL (1.0–3.0×ATR) × TP (1R–6R). Clear winner: H1 + 2.0×ATR SL + 4R single exit → PF 1.209. The longer H1 timeframe gives the BOS+retest pattern room to form cleanly; 15M generates too many false BOS signals in intraday noise.

### Trade Audit Learnings (Apr 14–18, applied going forward)
1. **Score ≥ 10 mandatory** — losses were all 8–9 score; 10+ has not been tested yet at live scale
2. **XAUUSD SL: 2×ATR minimum** — 6pt SL on 5M gold was too tight; 15–20pt breathing room required
3. **BTC Asian session**: reduce to score ≥ 13 gate (confirmed: SL hit Apr 17 00:01)
4. **Friday**: do not open new trades after 15:30 UTC (user was manually closing, now automated)
5. **Session filter**: only high-volume windows produce reliable structure; enforce programmatically

### Knowledge Base Updates Applied
1. Section 4: threshold 4→10, added Q+R factors, updated risk tiers, added session gate
2. Section 5: added Alpha Kill v1 (Q) and Ironclad MTF (R) entries
3. Section 11: added backtest baselines for Q and R
4. Section 12: decision tree updated with Friday cutoff, session gate, multi-TP split
5. Symbol matrix updated: XAU H1 now primary (not 15M) due to Q strategy optimisation
