Run the Meet Kevin Pricing Power analysis on the current TradingView chart.

Meet Kevin's (Kevin Paffrath) publicly known strategy focuses on:
- PRICING POWER: Companies that can raise prices without losing customers (Apple, Google, NVIDIA, etc.)
- MACRO-FIRST: Is the broader market in a risk-on or risk-off environment?
- 200 SMA as the KEY trend filter — above = bullish bias, below = caution
- 50 SMA for medium-term momentum
- RSI 30-50 dip zones as buy opportunities in strong stocks
- Earnings momentum: only buy companies beating estimates
- Strong margins and low debt (moat companies)

Steps:
1. Use `chart_get_state` to get current symbol
2. Use `data_get_study_values` to get all indicator readings (RSI, MACD, MAs)
3. Use `quote_get` for current price
4. Use `data_get_ohlcv` with summary=true for context
5. Use `capture_screenshot` for visual confirmation

Meet Kevin Score — check each:
[ ] Price ABOVE 200 SMA? (trend filter — most important)
[ ] Price ABOVE 50 SMA? (medium term bullish)
[ ] RSI between 30-50? (ideal buy zone — cooled off, not crashed)
[ ] MACD turning bullish or positive?
[ ] Volume: above average on recent green days?

Output:
- **MEET KEVIN SIGNAL: BUY / WAIT / AVOID**
- Pricing Power Score: X/5 (one point per criteria met)
- Key reason: [what makes this a buy/avoid]
- Entry zone: $X–$X | Target: $X | Stop: below 200 SMA or $X
- Overall verdict: Is this the kind of quality-with-momentum stock MK would buy?
