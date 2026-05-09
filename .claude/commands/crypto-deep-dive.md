Run a comprehensive crypto technical analysis with options data, risk metrics, and precise entry/stop-loss levels.

## ASSETS TO ANALYZE
Default watchlist: BTC, ETH, SOL, ONDO, SUI
If the user passes arguments (e.g. `/crypto-deep-dive BTC SOL AVAX`), use those symbols instead.

## STEP 1: TradingView Live Data Pull
For EACH asset, use TradingView MCP tools:

1. `tv_health_check` — verify connection. If it fails, run `tv_launch` first.
2. `chart_get_state` — get current chart state and indicators.
3. For each symbol:
   a. `chart_set_symbol` with exchange prefix (use BITSTAMP: for BTC/ETH/SOL, COINBASE: for ONDO/SUI)
   b. Wait 2 seconds for chart to load
   c. `chart_set_timeframe` to "D" (daily), then `data_get_ohlcv` with `summary: true`
   d. `chart_set_timeframe` to "240" (4H), then `data_get_ohlcv` with `summary: true`
   e. `quote_get` for latest price
   f. `data_get_study_values` for any loaded indicators (RSI, EMA, MACD)

## STEP 2: IntoTheCryptoverse Risk Data
Use WebFetch or Chrome browser tools to pull from https://app.intothecryptoverse.com/charts/risk:
- For each asset that ITC supports (BTC, ETH, SOL, XRP, BNB, TRX), get:
  - Historical Risk Level (latest value)
  - Confidence score
- Also check BTC Logarithmic Regression bands at https://app.intothecryptoverse.com/charts/logarithmic-regression:
  - Upper Bound Value
  - Lower Bound Value
  - Where current price sits relative to bands

## STEP 3: Options & Flow Data
Use WebSearch to find current data for each asset:
1. **BTC/ETH Options**: Search for "BTC max pain options expiry {current_month} {current_year}" and "ETH options put call ratio"
2. **ETF Proxy Options**: Search for "IBIT put call ratio options volume" and "ETHE options data"
3. **SOL/SUI Options**: Search for "SOL futures open interest" and "SUI CME futures volume"
4. Extract: put/call ratios, max pain levels, open interest, implied volatility

## STEP 4: Technical Indicators from Barchart
Use WebFetch on these URLs for each asset:
- https://www.barchart.com/crypto/quotes/%5E{SYMBOL}USD/technical-analysis
Extract: RSI (9/14), Stochastic %K, ADX, +DI/-DI, ATR, Historic Volatility, overall signal

## STEP 5: Support/Resistance Research
Use WebSearch: "{SYMBOL} crypto technical analysis support resistance {current_month} {current_year}"
Extract key support and resistance levels from analyst reports.

## STEP 6: Calculate Entry/Stop-Loss/Drawdown
For each asset, determine:
1. **Entry Zone**: Based on nearest support level, 4H pullback area, or breakout retest
2. **Conservative Stop Loss**: Below the next major support level (wider)
3. **Tight Stop Loss**: Below the nearest swing low (tighter, capital preservation)
4. **Drawdown %**: Calculate (Entry - Stop Loss) / Entry * 100 for BOTH stop options
5. **Target 1**: First resistance level
6. **Target 2**: Second resistance / extended target
7. **Upside %**: Calculate (Target - Entry) / Entry * 100
8. **Risk/Reward Ratio**: Upside % / Drawdown %

## OUTPUT FORMAT

### Section 1: Market-Wide Context Table
| Metric | Value | Signal |
Show: BTC max pain, P/C ratios, IBIT flow data, IV vs HV, overall options market verdict

### Section 2: Per-Asset Deep Dive
For EACH asset, output:

#### {SYMBOL} -- ${PRICE}

**Price Action (Live TradingView)**
| Timeframe | Open | High | Low | Close | Range |
Daily and 4H data

**Technical Indicators**
| Indicator | Value | Signal |
RSI, Stochastic, ADX, +DI/-DI, ATR, Historic Vol

**ITC Risk Model** (if available)
| Risk Level | Confidence | Interpretation |

**Options/Flow Data**
P/C ratio, max pain, OI, IV

**Key Levels**
| Level | Type | Notes |

**Entry/Stop Loss**
| | Level | Rationale |
Entry zone, tight stop, wide stop, targets

**Verdict**: Emoji + BIAS + 2-sentence reasoning

### Section 3: Drawdown Risk Ranking Table (MOST IMPORTANT)
Rank ALL assets by drawdown % (lowest first):

| Rank | Asset | Entry | Tight Stop | Drawdown % | Target | Upside % | R:R | Action |

### Section 4: Portfolio Allocation
Based on $10,000 hypothetical allocation, show:
| Asset | Allocation % | $ Amount | Max Loss at Stop | Max Loss % of Portfolio |
With total max portfolio drawdown

### Section 5: Bracket Order Setup (for Coinbase)
For each recommended asset:
| Asset | Buy Limit (Entry) | Stop Loss Trigger | Take Profit | Time in Force |

### Section 6: Flags & Warnings
- RSI extremes (>70 overbought, <30 oversold)
- Unusual volume (>2x average)
- Parabolic moves (>15% single day)
- Divergences between price and indicators
- Any asset where drawdown % > 10% gets a warning

## RULES
- Be direct and actionable. No preamble.
- Always calculate drawdown % from entry to stop loss for every asset.
- Always rank by drawdown % (lowest = safest = highest priority).
- Include the disclaimer: "This is technical analysis only, not investment advice."
- Format for easy scanning on mobile.
- If TradingView connection fails, still complete the analysis using web data sources.
- If ITC data can't be fetched, note "ITC data unavailable" and proceed with other sources.
