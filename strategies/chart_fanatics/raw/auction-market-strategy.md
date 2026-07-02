# Auction Market Strategy — Fabio Valentini

Source: https://chartfanatics.com/strategies/auction-market-strategy
Captured: 2026-07-02

Built For 
 Instruments:Futures
Trading Style: Scalping
 Strategy Overview 
 This Strategy is built on the principles of Auction Market Theory (AMT) , Volume Profile , and Order Flow .
 The core idea is simple: the market is an auction that moves between two conditions:
 Balance – where price rotates around fair value and most trading activity happens.

 Imbalance – where one side is aggressive, pushing the price away to search for a new fair value.

 Most traders lose because they try to trade every breakout or market structure pattern without checking if the market is balanced or not. In balance, 70% of the time, the market stays stuck, so trying to trade breakouts there usually ends in multiple stop-outs. The key is to only act when the market is giving you clear conditions.
 This model solves that problem by combining three simple steps:
 Market State – First, read whether the market is in balance or out of balance.

 Location – Next, use the Volume Profile to find the exact levels that matter, like LVNs (low-volume nodes) and POC (Point of Control).

 Aggression – Finally, wait for clear order flow confirmation at those levels, big prints, imbalances, or strong CVD pressure.
 When these three align, you have a trade. If even one is missing, you stay flat.
 The playbook has two complementary setups:
 Trend Model – Trade continuation when the market is out of balance and searching for new value.

 Mean Reversion Model – Trade the snap-back when the market fails outside balance and comes back inside.
 Both setups are intraday, risk-controlled, and built to adapt to different market conditions. Together, they give a trader structure to handle both trending and ranging environments without relying on prediction.
 Strategy Setups 
 Setup 1: Trend Model (Out-of-Balance → Seek New Balance) 
 This setup is designed for when the market is out of balance and pushing directionally. Instead of guessing breakouts inside balance, you wait until the market clearly shows it’s moving away from value and then ride that continuation into the next balance area.
 When to Use 
 Works best in the New York session (NASDAQ, ES).
 Avoid the London open, too many fake breakouts.
 Use this setup when the market is out of balance and moving with momentum.

 Step 1 – Market State 
 Confirm that the market is out of balance.
 You should see displacement and momentum away from the prior value.
 If the price is just rotating up and down, skip this setup.

 Step 2 – Location 
 Take the impulse leg that broke the structure.
 Apply a Volume Profile to that leg.
 Identify Low-Volume Nodes (LVNs) inside that move. These LVNs are key reaction points.
 Place alerts just before LVNs — don’t place blind limit orders.
 Step 3 – Execution Trigger 
 When the price comes back into the LVN, check the order flow. Look for aggression in the direction of the trend:
 Big sell bubbles or footprint imbalance for shorts.
 Big buy bubbles or imbalance for longs.
 Only enter when you see aggression. No aggression = no trade.
 Step 4 – Risk Management 
 Stop Loss: Place just beyond the aggressive print. Add a 1–2 tick buffer before the obvious swing high/low to avoid slippage.
 Break-even: If CVD (Cumulative Volume Delta) shows strong pressure, move the stop to break-even early.
 Risk Size: Keep risk small, 0.25% to 0.5% of the account per trade.
 Step 5 – Target 
 Target the previous balance POC (Point of Control).
 Close the full position there.
 On rare strong trend days, you can trail beyond, but the main rule is to exit at the POC because 70% of the time, the price reverses from balance.
 Setup 2: Mean Reversion Model (Out-of-Balance → Back Into Balance) ‍
 This setup is the opposite of the Trend Model. Instead of following a strong move away from balance, you watch for times when the price breaks out but can’t hold. When that happens, the most likely outcome is that the market returns to the Point of Control (POC) inside the balance area where most trading activity occurred.
 When to Use 
 Works best in the London session or during compressed summer conditions.
 Use this when the market tries to break out of balance but fails.
 Step 1 – Market State 
 Market must be in balance or consolidation.
 Simple approach: use the previous day’s profile as the balance reference.
 Watch for the price to push out of balance and then fail.

 Step 2 – Location 
 Do not take the first move back; that’s risky.
 Wait for: 
 A clear reclaim inside balance.
 A pullback into the reclaim leg.

 Apply volume profile on the reclaim leg and mark the LVNs.
 Step 3 – Execution Trigger 
 On the pullback into the LVN, check the order flow.
 Look for aggression in the direction of the snap-back: 
 Big buy prints for longs after reclaim.
 Big sell prints for shorts after failed upside breaks.

 Enter only when aggression shows up.
 Step 4 – Risk Management 
 Stop Loss : Place just beyond the aggressive print. Add a 1–2 tick buffer before obvious highs/lows.
 Risk Size : Keep risk small (0.25–0.5% of account per trade).
 Invalidation : If you’re wrong, you should be wrong immediately. Never widen the stop.
 Step 5 – Target 
 Target the balance POC (center of value).
 Exit full position there.
 Don’t stretch for the other side of the range unless conditions are exceptional.
 Pros and Cons of the Strategy 
 This strategy is designed to deliver high-quality, repeatable setups — but like any trading strategy, there are key things to understand before using it.
 Note: The cons listed here aren’t disadvantages. They are things to be aware of — important characteristics that require patience, discipline, and proper management to make the strategy work effectively.
 Pros 
 Clear and structured. The model simplifies trading into three steps: market state, location, and aggression, making decisions straightforward and rule-based.

 Adaptable to conditions. With one model for trending days and another for ranging days, the playbook provides coverage across different market environments.

 Tight and efficient risk. Stops are placed just beyond aggression, keeping losses small and allowing quick invalidation.

 Frequent trade opportunities. The approach generates a large sample of trades, helping traders build consistency and recover quickly from drawdowns.

 Built-in discipline. If the conditions aren’t present, no trade is taken. This naturally prevents overtrading and revenge trades.

 Scalable returns. Normal trades often deliver 1:2.5 to 1:5 reward-to-risk, and on strong days, much larger ratios are possible.
 Cons 
 Mentally demanding. Multiple small stop-outs in a row are common, and seeing consecutive losses can be difficult to handle.

 Requires focus and time. The setups demand full attention during the London or New York sessions. It’s not suitable for casual or part-time trading.

 Lower win rate in choppy markets. On compressed or indecisive days, expect more failed trades and a reduced strike rate.

 Psychological pressure with size. Managing large position sizes intraday can be stressful, even if the model has positive expectancy over time.
 Trade Breakdown 
 Model 1: Trend Continuation (Out of Balance → New Balance) 
 Market Condition: 
 New York session, market is out of balance and trending higher.
 Trade Breakdown 
 Price breaks out of balance in New York and pushes strongly upward.

 Plot the profile from the start of the impulse to the top of the move. A clear low-volume node (LVN) forms in the retracement zone.

 On the footprint, big buy aggression hitting right at that LVN — the confirmation to wait for.

 Enter long with a stop just below the LVN.

 Price continues higher in line with the flow. As momentum builds, sellers try to fight back, but there’s no follow-through. Buyers remain in control.

 As sellers appear with aggression and start to challenge the move, the trade is exited to protect profits.

 Model 2: Mean Reversion (Failed Breakout → Back to Balance 
 Market Condition:
 London session, market is balanced and attempting a breakout out of the balance range. ‍ 
 Trade Breakdown 
 Price first pushes above the balance area and looks like it might continue higher, but there’s no real follow-through. That first attempt ends up failing.
 A second breakout attempt also fails, and this is where the reversion model comes into play.
 On the volume profile, price rejects above the value area and comes back inside balance.
 Order flow confirms it — buyers are hitting, but they can’t push the market through. Aggression dies out.
 Enter short once price is firmly back inside balance, with a stop just above the failed high.
 Target is the POC inside the balance, and price rotates cleanly back into value to hit it.
