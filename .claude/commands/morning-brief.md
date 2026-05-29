Run the morning brief by pulling live price data, then applying bias criteria from rules.json.

## STEP 1: Pull Prices from ITC TradFi

Use WebFetch on https://app.intothecryptoverse.com/tradfi/stocks to get stock prices.
If the page returns empty/auth-blocked, fall back to fetching each watchlist ticker from Yahoo Finance:
- https://finance.yahoo.com/quote/{SYMBOL}/ for each symbol in rules.json watchlist

For crypto prices, use WebFetch on:
- https://app.intothecryptoverse.com/dashboard
- Fallback: https://www.coingecko.com/en/coins/bitcoin/historical_data (and /ethereum, /solana)

For ETF prices (SMH, SOXX, SOXL, IVV, IWM, VOO, VTI, GLD, SLV, XLE, URA, IBIT, ETHA, ARKB), use:
- https://finance.yahoo.com/quote/{SYMBOL}/

## STEP 2: Pull Barchart Technicals for Watchlist

For EACH symbol in the watchlist (or at minimum the top movers), fetch:
- https://www.barchart.com/stocks/quotes/{SYMBOL}/technical-analysis
Extract: RSI (14-day), 20-day EMA, 50-day SMA, 200-day SMA, overall signal, volume vs average.

## STEP 3: Apply Bias Criteria from rules.json

For EACH symbol, apply these rules:

**BULLISH** (all 3 must be true):
1. Price is above the 20 EMA
2. RSI is below 60 (room to run)
3. Trend direction is up (price > 50 SMA, or positive 5-day momentum)

**BEARISH** (all 3 must be true):
1. Price is below the 20 EMA
2. RSI is above 40 (room to drop)
3. Trend direction is down (price < 50 SMA, or negative 5-day momentum)

**NEUTRAL** (if neither bullish nor bearish criteria fully met):
1. Price is chopping around the 20 EMA (within 1%)
2. RSI is between 45 and 55
3. No clear trend direction

## OUTPUT FORMAT

For each symbol output exactly:

**SYMBOL** | BIAS: [BULLISH/BEARISH/NEUTRAL] | PRICE: $X | WATCH: [key level or condition to monitor]

Group by sector:
- MEGA-CAP TECH
- SEMICONDUCTORS
- SOFTWARE / CLOUD
- FINANCIALS / FINTECH
- CHINA TECH
- BTC MINERS / CRYPTO PROXIES
- CRYPTO ETFs
- CRYPTO SPOT
- BROAD MARKET ETFs
- COMMODITIES / SPECIALTY

Then after all symbols:
- List top 3 BULLISH setups with entry reasoning
- List top 3 BEARISH setups with short/avoid reasoning
- Give ONE overall market read sentence
- Flag any symbols with RSI extremes (>70 or <30) or unusual volume (>2x average)

## RULES
- Be direct and actionable. No preamble.
- Use ITC data as primary source. Only fall back to Yahoo/Barchart if ITC is auth-blocked.
- Prices must be current-day. Never use estimated prices — if you can't get a price, write "N/A".
- Format for easy scanning on mobile.
- Apply risk rules from rules.json at the bottom as a reminder.
