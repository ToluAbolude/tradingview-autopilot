# Futures Trading Strategy — Anthony Crudele

Source: https://chartfanatics.com/strategies/futures-trading-strategy
Captured: 2026-07-02

Built For 
 Instruments: Futures
Trading Style: Swing Trading
 Strategy Overview 
 This strategy is built around one idea: trade better by first identifying the market environment.
 Instead of forcing one “setup” every day, the process starts by answering a single question on the daily chart:
 Is the market in:
 Consolidation (two-way tape).
 Trend / Expansion (one-directional).
 Mean Reversion (pullback against the primary trend).
 Once the environment is clear, the execution becomes simple:
 Consolidation → two-way tape (trade edges, avoid the middle).
 Expansion → pick one direction only (long-only or short-only).
 Mean reversion → take the pullback to a defined target, smaller size if against the primary trend.
 This strategy is primarily designed for index markets (S&P / Nasdaq / Russell) and is traded as a 1–5 day swing, with occasional intraday execution for entries.
 Markets and Timeframe 
 Primary timeframe: Daily (everything starts here)
 Execution timeframes (as needed): 60-min, 30-min, sometimes 3-min (only to refine entries in consolidation or to improve execution)
 Typical holding time: 1 to 5 trading days
 Tools and Chart Settings (Must Match) 
 Core Indicator (Required) 
 Bollinger Bands: 
 Length: 20
 Standard deviations: 3
 Purpose : identify environment fast (consolidation vs expansion vs mean reversion)
 The 3-standard-deviation setting is intentional. It provides “enough room” for index volatility and avoids constant “overbought/oversold” noise you’d get with tighter bands.
 Beacon (Anthony’s Tool) 
 Beacon: an automatic tool that draws the mean reversion Fib levels based on Bollinger Band peaks once the peaks are formed. It’s essentially an auto “fib overlay” for the mean reversion phase.
 Tools (Do Not Use for Entries) 
 Moving averages:  
 Purpose: trend context + exit help
 RSI (optional): 
 Purpose: only to confirm whether the market is oversold/overbought during a mean reversion opportunity. It does not generate entries.
 Anchored VWAP (situational): 
 Used during extreme volatility to help manage exits and structure risk. 
 Strategy Setups 
 Consolidation (Two-Way Tape) 
 What it looks like (Daily chart) 
 Bollinger Bands contract (they come in / narrow).
 Price becomes rangebound.
 Often follows a meaningful high or low (commonly forms after a move, not during clean trend progression).
 What it means 
 The market is likely to produce fake breakouts that snap back into the range.
 This is where traders get chopped up if they chase a bigger trend without adjusting.
 Trading approach 
 Two-way tape: can be long or short.
 Trade the edges of the range. Stay out of the middle.
 Expect stop-runs above recent highs/lows and reversion back into the range.
 Execution rule 
 When daily is in consolidation:
 Drop down in timeframe (60-min / 30-min / sometimes 3-min).
 Reason: in consolidation, short-term technicals matter more.
 Risk note 
 This is the environment most likely to chop up multi-day swing traders. If trading it, be selective and focus on edges.
 Trend / Expansion (One-Directional Only) 
 What it looks like (Daily chart) 
 Bollinger Bands go from flat to pointing outward.
 Bands expand (range expansion).
 Price touch the upper band in uptrends or the lower band in downtrends.
 Typically begins with a breakout from the prior consolidation range.

 What it means 
 Once expansion is confirmed:
 Pick one direction and only trade that direction.
 No fading rallies in an up-expansion.
 No buying dips in a down-expansion.
 Directional rules 
 Bullish expansion 
 Bands expanding upward + price breaks out → Long-only 
 Bearish expansion 
 Bands expanding downward + breakdown → Short-only 
 Targets inside expansion 
 Anthony uses two main target ideas:
 Bigger picture targets 
 Higher timeframe levels (weekly highs/lows, major reference points)
 Also includes referencing other trusted “big picture” levels (the concept is: use larger context targets)
 “Unfinished Business” target (Bollinger Peak concept) 
 A prior Bollinger Band peak becomes a future target.
 Logic: when the band peaked before and price later trends again, that prior peak is treated as an objective (“unfinished business”) in the next directional move.
 Position vehicle 
 Most often: options on futures
 Why: allows staying with the move through volatility and avoids impossible futures stops.
 Typical selection: calls/puts 3 to 5 days out (not too far out, focused on the next directional push).
 Management: scale out into targets/levels.
 Mean Reversion = Pullback Phase (Defined Trigger + Target) 
 What it looks like (Daily chart) 
 After an expansion move, the market stops extending.
 Bollinger Bands start coming back in (contracting). This is the “you missed the top/bottom” phase — the strategy does not try to nail tops or bottoms.
 Core concept 
 Mean reversion changes posture:
 Even if the primary trend is up, mean reversion means: no longer long
 You can trade against the primary trend, but that’s where discretion = smaller sizing
 The Mean Reversion Trigger and Target 
 Anthony uses a Fibonacci-style framework, but not in the traditional way:
 Instead of fibbing “price,” it’s applied to the Bollinger Band peak-to-peak move (he describes it as using a fib on volatility rather than price).
 Key levels used:
 30% 
 50% (main target)
 70% 
 Bearish mean reversion rule: 
 Once there is a daily close below the 30% line, the target becomes 50%.
 Action: buy puts or short futures until a daily close back above the relevant level.
 Exit idea: once 50% is hit, the mean reversion objective is considered done.

 What happens after 50% hits? 
 This becomes the “hands in pocket” zone:
 Price may chop and consolidate
 Or it may transition into a new expansion phase
 The strategy waits for the environment to become clear again.
 Execution Rules 
 Daily Process (Non-negotiable) 
 Open the daily chart.
 Identify environment using Bollinger Bands: 
 contracting = consolidation
 expanding = trend
 contracting after a peak + Beacon levels = mean reversion phase

 Set posture: 
 consolidation = two-way edges
 expansion = one direction only
 mean reversion = trade to 50%, smaller size if against primary trend

 Only then drop to a lower timeframe to improve execution.
 Entry Guidelines  
 This system is not a “one candle entry signal.” Entries are built from:
 Environment + direction first
 Then execution tools (lower timeframe structure, order flow tools, etc.) to improve entry quality
 In practice:
 Expansion: enter after breakout/confirmation; manage as trend continuation
 Consolidation: enter near range edges; avoid center
 Mean reversion: execute after daily trigger (close below 30% line), aim for 50%
 Stops and Risk Management (Matches His Discretion) 
 Position sizing is the biggest discretion 
 Risk is managed in dollars, not in “one contract every time.”
 If the risk distance is large, the size must shrink.
 Futures vs options decision 
 If the stop becomes unrealistically wide on futures:
 Use options instead (risk is predefined by the premium)
 Often, out-of-the-money puts/calls are used so the risk is capped and survivable.
 Key stop logic in volatility 
 During extreme volatility and gaps:
 The “correct” stop may be above a key high (or below a key low), which is often too large for futures sizing.
 This is where options become the primary tool.

 Trade Management and Exits  
 Anthony repeatedly highlights that the hardest part is:
 targets
 exits
 stop placement
 Tools used to solve this:
 8/21/34 moving averages (exit context, not entry signals)
 anchored VWAP (when volatility is extreme)
 Anchored VWAP method (situational but important) 
 Anchor VWAP to the candle/level where the tape turned (key high/low)
 Use VWAP + 1/2/3 standard deviation bands as a framework: 
 “Can it stay below VWAP?” (bear case)
 Use deviation bands as trim/exit guides

 Pros and Cons of the Strategy 
 This strategy is designed to deliver high-quality, repeatable setups — but like any trading strategy, there are key things to understand before using it.
 Note: The cons listed here aren’t disadvantages. They are things to be aware of — important characteristics that require patience, discipline, and proper management to make the strategy work effectively.
 Pros 
 This framework makes the market easy to understand.
 It reduces overtrading.
 It prevents fading strong trends.
 It works in both bull and bear markets.
 It simplifies decision-making.
 Cons 
 It requires patience.
 The in-between phases are difficult.
 Targets are discretionary.
 Volatility and news can disrupt structure.
 Sometimes the correct trade is no trade.
 Trade Breakdown – Bearish Expansion Into Mean Reversion 
 Context  
 The market was in a downtrend for the year.
 There was a consolidation zone where Bollinger Bands contracted.
 Then bands expanded down → idea became short-only.
 Volatility complication (gap + extreme range) 
 A key high formed where “the tape turned.” Because of the gap and the distance needed for a proper stop (above the high), managing risk with futures became difficult.
 Solution used: buy out-of-the-money puts (risk defined by premium).

 Tools for futures, currency & options involves substantial risk & is not appropriate for everyone. Only risk capital should be used for trading. Testimonials appearing on this website may not be representative of other clients or customers and is not a guarantee of future performance or success.
