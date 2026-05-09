NASDAQ Market Open Routine — run this every day at market open.

Execute all three analyses in sequence:

## STEP 1: Morning Brief
Run the `morning_brief` tool. Apply bias criteria from rules.json to all scanned symbols.
Output top 5 bullish and top 5 bearish setups. Give overall market bias.

## STEP 2: Van Deop Scan
For the TOP 3 bullish symbols from Step 1, run the Van Deop Buy Zone check:
- RSI between 35-58
- MACD bullish
- Price in support zone
Flag any with ACTIVE buy zone signals.

## STEP 3: Meet Kevin Filter
For any symbols flagged in Step 2, run the Meet Kevin Pricing Power check:
- Above 200 SMA?
- Strong fundamentals / pricing power company?
- RSI in 30-50 buy zone?
Score each 0-5.

## FINAL OUTPUT
Format as a trading plan for the session:

**TODAY'S MARKET BIAS:** [BULLISH/BEARISH/NEUTRAL]

**TOP TRADES TO WATCH:**
1. SYMBOL — Van Deop: YES/NO | MK Score: X/5 | Entry: $X | Stop: $X | Target: $X
2. ...
3. ...

**RISK REMINDERS:**
- Max 2 open positions
- No trades in first 15 min (wait until 9:45 AM ET)
- Stop for day after 2 losing trades
- Min 1:2 R:R on every trade

**SCREENSHOT:** Take a chart screenshot of the #1 ranked setup.
