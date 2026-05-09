Run the TradingView morning brief using the `morning_brief` tool.

After getting the raw data back, apply the bias criteria from rules.json to EVERY symbol scanned. For each symbol output exactly:

**SYMBOL** | BIAS: [BULLISH/BEARISH/NEUTRAL] | PRICE: $X | WATCH: [key level or condition to monitor]

Then after all symbols:
- List top 3 BULLISH setups with entry reasoning
- List top 3 BEARISH setups with short/avoid reasoning
- Give ONE overall market read sentence
- Flag any symbols with RSI extremes or unusual volume

Be direct and actionable. No preamble. Format for easy scanning.
