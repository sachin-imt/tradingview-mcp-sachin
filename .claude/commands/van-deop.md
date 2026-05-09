Run the Van Deop Buy Zone analysis on the current TradingView chart.

Steps:
1. Use `chart_get_state` to get current symbol and indicators
2. Use `data_get_study_values` to read RSI and MACD values
3. Use `data_get_pine_lines` and `data_get_pine_labels` to get key support/resistance levels
4. Use `quote_get` to get current price
5. Use `data_get_ohlcv` with summary=true for recent price action

Van Deop Buy Zone criteria — signal is VALID when ALL of these are true:
- Price has pulled back INTO a identified support zone (key level from Pine indicators)
- RSI is between 35 and 58 (cooled off but not oversold — still has room)
- MACD histogram is still positive OR just turned positive (momentum intact)
- Price is above the 20 EMA on the current timeframe

Output:
- **BUY ZONE ACTIVE: YES/NO**
- Current RSI: X | MACD: X | Price vs EMA20: above/below
- Nearest support zone: $X
- Entry suggestion: $X | Stop: $X | Target: $X (min 1:2 R:R)
- If no signal: what needs to change for the signal to activate

Then use `capture_screenshot` to take a chart screenshot for visual confirmation.
