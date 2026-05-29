Run the morning brief by pulling live price data from ITC via automated session, then applying bias criteria from rules.json.

## STEP 0: Fetch ITC Data Automatically

Run this bash command to pull live ITC data:
```bash
node scripts/itc-fetch.js 2>/dev/null
```

Parse the JSON output. It returns:
```json
{
  "stocks": [{"ticker": "NVDA", "price": 211.14}, ...],
  "crypto": [{"ticker": "BTC", "price": 107000}, ...],
  "fetchedAt": "...",
  "raw": { ... }
}
```

**If exit code 2 (session expired):** Tell the user:
> "ITC session expired. Run this once to re-authenticate: `npm run itc:auth`"
> "It will open a headless browser, enter your email, then prompt you to paste the OTP code from your inbox."
> "After that, re-run the morning brief."

**If output is empty or stocks array is empty:** Fall back to Yahoo Finance for each symbol.

**If raw.stocks.domData.fullText is available but stocks array is empty:**
Parse the full page text directly — look for ticker symbols followed by prices on adjacent lines.

## STEP 1: Pull Prices — Fallback Sources

If ITC fetch fails, use WebFetch on Yahoo Finance per symbol (only for top 10 movers):
- https://finance.yahoo.com/quote/{SYMBOL}/

For crypto prices (BTC/ETH/SOL), if ITC crypto array is empty:
- Use WebSearch: "BTC price today" / "ETH price today"

For ETF prices (SMH, SOXX, SOXL, IVV, IWM, VOO, VTI, GLD, SLV, XLE, URA, IBIT, ETHA, ARKB):
- https://finance.yahoo.com/quote/{SYMBOL}/

## STEP 2: Pull Barchart Technicals for Watchlist

For EACH symbol in the watchlist (or at minimum the top movers), fetch:
- https://www.barchart.com/stocks/quotes/{SYMBOL}/technical-analysis
Extract: RSI (14-day), 20-day EMA, 50-day SMA, 200-day SMA, overall signal, volume vs average.

For crypto: https://www.barchart.com/crypto/quotes/%5E{SYMBOL}USD/technical-analysis

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
- Use ITC data (via itc-fetch.js) as primary source. Only fall back to Yahoo/Barchart if ITC fetch fails.
- Prices must be current-day. Never use estimated prices — if you can't get a price, write "N/A".
- Format for easy scanning on mobile.
- Apply risk rules from rules.json at the bottom as a reminder.
