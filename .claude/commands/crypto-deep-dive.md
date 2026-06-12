Run a comprehensive crypto technical analysis with options data, risk metrics, MK Strategy v2 scoring, and precise ATR-based entry/stop levels.

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
Extract: RSI (9/14), Stochastic %K, ADX, +DI/-DI, **ATR (14-day)**, **200-day MA**, **50-day MA**, Historic Volatility, overall signal.
The ATR and moving averages from this step feed directly into Step 5 (MK v2 scoring).

## STEP 5: Meet Kevin Strategy v2 Scoring
For EACH asset, apply the v2 criteria using data from Steps 1 and 4.
The full Pine Script is at `src/indicators/meet-kevin-strategy-v2.pine`.

### Hard Gate (not a score point)
- `above_200` = price > 200-day MA
  - If TRUE → **STANDARD MODE** (score 0–4 below)
  - If FALSE → **RECOVERY MODE** (use recovery criteria below)

### Standard Mode Score (0–4, requires above_200 = TRUE)
| # | Criterion | Pass condition |
|---|-----------|----------------|
| 1 | Above 50 MA | price > 50-day MA |
| 2 | RSI in zone | RSI(14) between 30 and 60 |
| 3 | MACD 2-bar rise | histogram rising for 2 consecutive bars |
| 4 | Volume 2/3 bars | volume above 20-day avg on ≥2 of last 3 bars |

- Score ≥ 3 → **▲ BUY**
- Score = 4 → **★ STRONG BUY**
- Score = 2 → **◆ WATCH** (no entry)
- Score ≤ 1 → **— WAIT**

### Recovery Mode Score (0–4, used when above_200 = FALSE)
| # | Criterion | Pass condition |
|---|-----------|----------------|
| 1 | 50 MA Rising | 50-day MA higher than it was 3 bars ago |
| 2 | RSI recovering | RSI(14) ≥ 40 |
| 3 | MACD 2-bar rise | histogram rising for 2 consecutive bars |
| 4 | Volume 2/3 bars | volume above 20-day avg on ≥2 of last 3 bars |

- Recovery score = 4 → **⟳ RECOVERY BUY** (note: higher risk, size down)
- Recovery score = 3 → **◆ RECOVERY WATCH**
- Recovery score ≤ 2 → **✗ AVOID**

### ATR-Based Entry/Stop/Target (replaces manual S/R stops)
Using ATR(14) from Barchart:
- **Entry**: current price (or nearest support on a 4H pullback)
- **Stop Loss**: Entry − (2 × ATR)  →  Drawdown % = (2 × ATR) / Entry × 100
- **Take Profit**: Entry + (4 × ATR)  →  Upside % = (4 × ATR) / Entry × 100
- **R:R**: always 2:1 by construction — flag any asset where 2×ATR > 10% of price
- **Trailing Stop** (if in profit): activates at Entry + 1×ATR, trails at 2.5×ATR

## STEP 6: Support/Resistance Research
Use WebSearch: "{SYMBOL} crypto technical analysis support resistance {current_month} {current_year}"
Extract key support and resistance levels to validate or refine ATR-based levels from Step 5.
If a major S/R level sits between the ATR stop and current price, tighten the stop to just below it.

## OUTPUT FORMAT

### Section 1: Market-Wide Context Table
| Metric | Value | Signal |
Show: BTC max pain, P/C ratios, IBIT flow data, IV vs HV, overall options market verdict

### Section 2: Per-Asset Deep Dive
For EACH asset, output:

#### {SYMBOL} — ${PRICE}

**Price Action (Live TradingView)**
| Timeframe | Open | High | Low | Close | Range |
Daily and 4H data

**Technical Indicators**
| Indicator | Value | Signal |
RSI, Stochastic, ADX, +DI/-DI, ATR, Historic Vol, 200-day MA, 50-day MA

**ITC Risk Model** (if available)
| Risk Level | Confidence | Interpretation |

**Options/Flow Data**
P/C ratio, max pain, OI, IV

**Key Levels**
| Level | Type | Notes |

**MK Strategy v2 Signal**
| Field | Value |
| Mode | STANDARD / RECOVERY |
| 200 MA Gate | ✓ PASS / ✗ FAIL — price vs 200 MA |
| Score | X / 4 |
| Above 50 MA | ✓ / ✗ |
| RSI Zone (30–60) | ✓ RSI=XX / ✗ RSI=XX |
| MACD 2-bar rise | ✓ / ✗ |
| Volume 2/3 bars | ✓ / ✗ |
| Signal | ★ STRONG BUY / ▲ BUY / ⟳ RECOVERY BUY / ◆ WATCH / ✗ AVOID |
| ATR Stop | Entry − 2×ATR = $X (drawdown X%) |
| ATR Target | Entry + 4×ATR = $X (upside X%) |
| R:R | 2:1 (flag if ATR stop > 10%) |

**Verdict**: Emoji + BIAS + 2-sentence reasoning referencing MK v2 signal

### Section 3: MK v2 Signal + Drawdown Ranking Table (MOST IMPORTANT)
Rank ALL assets by ATR drawdown % (lowest = safest = highest priority):

| Rank | Asset | Price | MK Signal | Entry | ATR Stop | Drawdown % | ATR Target | Upside % | R:R | Action |

### Section 4: Portfolio Allocation
Based on $10,000 hypothetical allocation — weight by inverse drawdown % (lower drawdown = larger allocation):
| Asset | Allocation % | $ Amount | Max Loss (ATR Stop) | Max Loss % of Portfolio |
With total max portfolio drawdown at bottom.

### Section 5: Bracket Order Setup (for Coinbase)
For each asset with MK signal ▲ BUY or better:
| Asset | Buy Limit (Entry) | Stop Loss (Entry − 2×ATR) | Take Profit (Entry + 4×ATR) | Time in Force |

### Section 6: Flags & Warnings
- RSI > 70 overbought or < 30 oversold (blocks standard RSI zone entry)
- Recovery mode entries (⟳): reduce position size by 50% — higher risk
- Unusual volume (>2× average)
- Parabolic moves (>15% single day) — wait for pullback before entry
- Any asset where ATR drawdown % > 10% — flag prominently, skip or halve size
- ETH within $20 of 200 MA — flip risk: one red day switches Standard → Recovery

## RULES
- Be direct and actionable. No preamble.
- MK v2 scoring is the primary entry filter. Do not recommend entry on WATCH or AVOID signals.
- ATR-based stop/target is the default. Use S/R levels only to tighten (never widen) the ATR stop.
- Always rank by ATR drawdown % (lowest = safest = highest priority).
- Recovery mode signals are valid but size down (half normal position).
- Include the disclaimer: "This is technical analysis only, not investment advice."
- Format for easy scanning on mobile.
- If TradingView connection fails, complete the analysis using web data sources (Barchart for ATR/MAs).
- If ITC data can't be fetched, note "ITC data unavailable" and proceed with other sources.
