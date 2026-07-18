# Phase R — Research Notes

Format per source: claim · market/universe · sample period · effect size (after costs where
reported) · decay/crowding · implementability with our infra (cTrader OHLCV, CFD-style
universe, bracket-only house rules).

## Source 1 — Moskowitz, Ooi & Pedersen (2012), "Time Series Momentum", JFE 104(2):228–250

- **Links**: [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2089463) ·
  [AQR page](https://www.aqr.com/Insights/Research/Journal-Article/Time-Series-Momentum) ·
  [Quantpedia summary](https://quantpedia.com/strategies/time-series-momentum-effect)
- **Claim**: an instrument's own past 12-month excess return positively predicts its next
  1–12 month return, with partial reversal beyond 12 months (under-reaction → delayed
  over-reaction). Signal: sign of trailing 12-month return; size positions inversely to
  volatility; monthly rebalance.
- **Universe**: 58 liquid futures — 24 commodities, 12 FX pairs, 9 equity indices,
  13 government bond futures.
- **Sample**: 1965–2009.
- **Effect size**: diversified TSMOM portfolio Sharpe ≈ 1.31 (gross), annualized alpha
  ≈ 20.7% vs Fama-French factors, vol ≈ 15.7%, MaxDD ≈ −34% (Quantpedia figures).
  **Costs NOT in the headline numbers** — futures costs are small; our CFD costs are not.
- **Decay/crowding**: see Source 3 — post-2009 live performance of trend CTAs much weaker.
- **Implementability**: HIGH for signal (daily bars from `getTrendbars` are ample for a
  12-month lookback; vol scaling is simple ATR/stdev math). TWO structural tensions:
  (1) TSMOM is always-in-market with no per-trade SL/TP — house never-naked rule requires
  brackets, so Phase D must design ATR-wide synthetic brackets that don't distort the
  signal; (2) monthly rebalance on ~20 symbols → far too few trades to reach n ≥ 100 OOS
  in reasonable time → need faster variants (weekly rebalance, multi-lookback 1/3/12m
  blend) and must re-verify the edge survives the shorter horizon + higher costs.

## Source 2 — Hurst, Ooi & Pedersen (2017), "A Century of Evidence on Trend-Following Investing", JPM Fall 2017

- **Links**: [SSRN PDF](https://papers.ssrn.com/sol3/Delivery.cfm/SSRN_ID2993026_code277060.pdf?abstractid=2993026) ·
  [AQR page](https://www.aqr.com/Insights/Research/Journal-Article/A-Century-of-Evidence-on-Trend-Following-Investing) ·
  [Yale mirror PDF](https://fairmodel.econ.yale.edu/ec439/hurst.pdf)
- **Claim**: time-series momentum (1m+3m+12m blend) delivered positive average returns in
  **every decade since 1880**, with low correlation to stocks/bonds.
- **Universe**: 4 asset classes (equity indices, bonds, commodities, currencies),
  67 markets in the extended dataset.
- **Sample**: 1880–2016.
- **Effect size after costs**: results are **net of simulated transaction costs AND net of
  simulated 2/20 fees** — and remain positive each decade. Performed well in 8 of the 10
  largest 60/40-portfolio drawdowns ("crisis alpha").
- **Decay/crowding**: the paper itself notes the most recent decade's net returns are
  lower than the long-term average (low vol environment + possibly crowding), though
  still positive gross of fees.
- **Implementability**: same as Source 1; the 1/3/12-month lookback BLEND is the
  institutional standard implementation and partially fixes our sample-size problem
  (more signal changes than pure 12m).

## Source 3 — Post-publication decay & crowding evidence (Alpha Architect refresh; SG CTA Trend Index)

- **Links**: [Alpha Architect: TSMOM refresh](https://alphaarchitect.com/time-series-momentum-aka-trend-following-the-historical-evidence/) ·
  [Quantpedia TSMOM page](https://quantpedia.com/strategies/time-series-momentum-effect)
- **Claim/evidence**: live trend-CTA performance decayed sharply post-GFC — SG CTA Trend
  Sub-Index annualized **−0.8% Jan 2009–Jun 2013** vs **+8.0%** the prior five years;
  post-crisis-era trend returns run at less than half of no-crisis-period returns.
  Formal capacity-constraint regressions (flows → future performance) find **no
  statistically significant capacity constraint**, but divergence premia (incl. momentum)
  tend to underperform after crowded periods. Trend recovered strongly in 2022's rate
  shock (regime-dependent, not dead).
- **Takeaway for us**: assume the *forward* Sharpe of any TSMOM variant is a fraction of
  the 1965–2009 backtest number; our Stage-1 thresholds (PF ≥ 1.5 after OUR costs on OOS
  folds including post-2010 data) are the honest filter. Regime dependence argues for the
  walk-forward fold requirement (PF ≥ 1.25 in EVERY fold) already pre-registered.

## Source 4 — Asness, Moskowitz & Pedersen (2013), "Value and Momentum Everywhere", JF 68:929–985

- **Links**: [AQR page](https://www.aqr.com/Insights/Research/Journal-Article/Value-and-Momentum-Everywhere) ·
  [Wiley](https://onlinelibrary.wiley.com/doi/10.1111/jofi.12021)
- **Claim**: cross-sectional value and momentum premia are positive and significant in
  **every** of 8 markets/asset classes tested (US/UK/EU/JP equities, country indices,
  bonds, currencies, commodities); value↔momentum correlation ≈ −0.5 to −0.6.
- **Sample**: multi-decade panel to ~2011.
- **Effect size**: premia significant everywhere; funding-liquidity risk partially
  explains them. Headline numbers are gross.
- **Decay/crowding**: factor premia broadly weaker post-publication (general finding).
- **Implementability**: LOW-MEDIUM for us — cross-sectional ranking needs a wide
  cross-section; our ~20-symbol CFD universe is thin, and we have no "value" measure
  for FX/indices. Momentum leg only, and even that is better expressed time-series.

## Source 5 — Menkhoff, Sarno, Schmeling & Schrimpf (2012), "Currency Momentum Strategies", JFE 106(3):660–684

- **Links**: [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1809776) ·
  [BIS WP 366](https://www.bis.org/publ/work366.pdf)
- **Claim**: FX cross-sectional momentum spread up to ~10%/yr winners-minus-losers.
- **Sample**: 48 currencies, 1976–2010.
- **Effect size after costs**: **substantially reduced by bid-ask spreads** — momentum
  concentrates in high-cost, hard-to-arb currencies; costs don't kill it entirely but
  eat a large fraction. Distinct from carry; limits-to-arbitrage keep it alive.
- **Decay/crowding**: majors-only implementations retain little; the juice is in
  exotics we can't trade cheaply.
- **Implementability**: LOW standalone — our universe is majors/liquid crosses where
  the effect is weakest. Demote to confluence input at most.

## Source 6 — Koijen, Moskowitz, Pedersen & Vrugt (2018), "Carry", JFE

- **Links**: [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2298565) ·
  [NBER w19325](https://www.nber.org/papers/w19325)
- **Claim**: carry (expected return if price doesn't change) predicts returns in
  every asset class — equities, bonds, commodities, FX, credit, options.
- **Effect size**: carry-strategy Sharpe avg ≈ 0.74 across classes (vs 0.21 passive);
  global diversified carry ≈ 0.9. Gross of costs.
- **Decay/crowding**: FX carry has documented crash risk (negative skew — rare large
  losses); other classes' carry less crash-prone.
- **Implementability**: MEDIUM — FX swap rates are visible on cTrader (we PAY them as
  costs, and they proxy the carry signal). **BUT negative skew directly violates the
  charter's payoff ≥ 2 / "one loss cannot overturn one win" rule** → carry can only be
  a FILTER/tilt (don't fight carry; prefer entries aligned with it), never standalone.

## Source 7 — Moreira & Muir (2017), "Volatility-Managed Portfolios", JF 72:1611–1644

- **Links**: [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2659431) ·
  [published PDF](https://amoreira2.github.io/alan-moreira.github.io/VolPortfolios_published.pdf)
- **Claim**: scaling exposure DOWN when recent volatility is high produces alpha and
  raises Sharpe across market, momentum, carry and other factors (market: alpha 4.9%,
  ~25% Sharpe improvement).
- **Caveat**: later replications (Cederburg et al.) find real-time implementation
  gains are smaller — treat as overlay, expect modest benefit.
- **Implementability**: HIGH — it's just position-sizing math on data we already
  compute (ATR/stdev). Natural overlay for ANY shortlisted family; aligns with the
  charter's vol-targeted sizing requirement.

## Source 8 — Zarattini, Barbon & Aziz (2023/24), ORB day trading papers

- **Links**: [Can Day Trading Really Be Profitable? (SSRN 4416622)](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4416622) ·
  [A Profitable Day Trading Strategy for the U.S. Equity Market (SSRN 4729284)](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4729284)
- **Claim**: 5-minute opening-range breakout, restricted to "Stocks in Play" (relative
  volume ≫ normal, usually news-driven), with bracket exits.
- **Sample**: 7,000+ US stocks, 2016–2023.
- **Effect size after costs**: top-20 stocks-in-play portfolio net +1,600% total,
  **Sharpe 2.81, annualized alpha 36% net of commissions** (vs SPY +198%).
- **Decay/crowding**: recent, unreplicated-at-scale; but mechanism (attention +
  news-driven range expansion) is structural. In-house corroboration: our own ORB
  paper test shows XAUUSD@Asia +4.0R PF 3.0 (small n).
- **Implementability**: VERY HIGH — bracket-native (SL at opposite side of range,
  R-multiple TP), generates enough trades for n ≥ 100 quickly, matches existing
  orb_runner plumbing and session infrastructure. Transfer risk: their edge filter is
  equity-specific (news/rel-volume); our analog = session relative volume/range vs
  20-day norm on indices, gold, crypto.

## Source 9 — Gao, Han, Li & Zhou (2018), "Market Intraday Momentum", JFE

- **Links**: [SSRN 2440866](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2440866) ·
  [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0304405X18301351)
- **Claim**: first half-hour return (from prior close) predicts last half-hour return;
  predictive R² ≈ 1.6% — rivals monthly-frequency predictability. Stronger on
  high-volatility, high-volume, and macro-news days.
- **Sample**: S&P 500 ETF 1993–2013 + 10 other liquid ETFs (domestic + international).
- **Decay/crowding**: replicated across markets; magnitude varies by era.
- **Implementability**: HIGH for US30/NAS100/SPX500 sessions (we have M5 bars);
  independent corroboration that intraday session momentum is a real, structural
  effect — supports the ORB family from a second methodology.

## Source 10 — Baltas & Kosowski (2020), "Demystifying Time-Series Momentum Strategies"

- **Links**: [SSRN 2140091](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2140091) ·
  [CME-hosted PDF](https://www.cmegroup.com/education/files/demystifiing-time-series-momentum-strategies.pdf)
- **Claim**: implementation choices matter as much as the signal — efficient volatility
  estimators (e.g., Yang-Zhang OHLC-based) + smoother trend rules cut TSMOM turnover
  by **>1/3 with no significant performance loss**; pairwise-correlation-adjusted
  leverage improves post-2008 results.
- **Implementability**: HIGH — this is the engineering manual for making family-A
  survive OUR cost structure (CFD spreads make turnover reduction first-order, not a
  refinement). Use OHLC vol estimators (we have full OHLCV) and continuous trend
  strength rather than binary sign flips.

---

## Gate R→D: SHORTLIST (ranked by evidence strength × infra/charter fit)

1. **Family B — Session momentum / ORB with relative-volume gating** (Sources 8, 9;
   in-house ORB paper test). Bracket-native (charter asymmetry is structural), fast
   sample accrual (n≥100 in weeks not months), fits existing session/orb_runner
   plumbing, evidence net-of-costs and recent. Transfer risk from US equities → our
   indices/gold/crypto is the main open question — exactly what Stage 1 tests.
2. **Family A — Vol-targeted multi-lookback time-series momentum (trend)** (Sources
   1, 2, 3, 10). Deepest evidence base in all of quant finance (140 years, every
   decade, net of costs). Needs adaptation: Baltas-Kosowski turnover reduction for CFD
   costs, pullback-entry variant to satisfy WR ≥ 40% + bracket geometry, and EOD/
   weekend-carry reconciliation for multi-day holds.
3. **Family C — Overlay pack (not standalone): vol-managed sizing + carry filter**
   (Sources 6, 7). Applied to A and B: scale size down in high vol; don't take FX
   trades fighting large carry differentials. Carry never standalone (negative skew
   violates charter asymmetry).

Rejected as standalone: FX cross-sectional momentum (Source 5 — edge lives in
high-cost exotics we don't trade), value/XS ranking (Source 4 — cross-section too
thin at ~20 symbols).

## Open tensions to resolve in Phase D (running list)

- Never-naked rule vs always-in-market TSMOM → synthetic ATR brackets or regime-gated
  entries with natural stops.
- Charter requires WR ≥ 40% AND payoff ≥ 2 — classic trend following is typically
  WR 30–40% with payoff > 2 (positive skew via letting winners run). These constraints
  may exclude pure TSMOM and favor a hybrid (e.g., trend filter + pullback entry, which
  raises WR). Flag for the shortlist ranking; do NOT silently drop the charter rule.
- CFD spread/swap costs ≫ futures costs; carry (swap) on FX CFDs may even be a data
  source. Cost model per symbol is mandatory before any backtest is believed.

## Source count toward Gate R→D: 10 / 10 — GATE MET, checkpoint presented 2026-07-18
