Scan AJ Investment Research portal and @alojohhardcore X account for the latest signals, then update Sachin's Dashboard with daily data.

## RULE ZERO — NEVER RECREATE THE DASHBOARD

Sachin's Dashboard already exists as a fully built, unified artifact. It contains all HTML structure, CSS design system, JavaScript rendering logic, and historical data arrays. **You must NEVER recreate it.** On every run:

1. **Read the existing artifact** (`action: "read"` with the URL below) to get the current HTML
2. **Write it to the scratchpad** as a working file
3. **Edit only the data arrays** (STOCKS, C, DATES, P, SNAP_DATES, SNAP, CORR_META, signal cards) — leave all HTML structure, CSS, and JS rendering code untouched
4. **Append** new daily prices, dates, and snapshots — never overwrite historical data
5. **Republish** with `url` parameter to keep the same link

**Dashboard URL** (always pass as `url` to Artifact tool):
https://claude.ai/code/artifact/51860e0b-f148-4afa-ac41-db6965a28419

What "update only" means in practice:
- **DO**: Edit `var DATES=[...]` to append today's date
- **DO**: Edit `var P={...}` to append today's closing price to each stock's array
- **DO**: Edit `var SNAP_DATES=[...]` and `var SNAP={...}` to append today's quadrant snapshot
- **DO**: Edit signal card HTML to update changed signals, add new ones
- **DO**: Edit `var C=[...]` to update corridor params IF AJ published new estimates
- **DO**: Edit macro strip values if new macro data available
- **DO NOT**: Regenerate the HTML skeleton, CSS, tab structure, or JS rendering functions
- **DO NOT**: Create a new artifact or a new file from scratch
- **DO NOT**: Rewrite the entire file — use surgical edits to the data sections only

If the artifact read fails or returns empty, STOP and ask the user — do not rebuild from memory.

### Rolling Window

- Maintain **45 trading days** of daily data
- When DATES exceeds 45 entries, drop the oldest date and corresponding entries from P arrays, SNAP_DATES, and SNAP
- Always preserve the most recent 45 days

---

## Step 1: Read the Portal (Chrome MCP — user is logged in)

Use Chrome MCP tools (mcp__claude-in-chrome__*) to access subscriber content. The in-app browser pane cannot authenticate.

1. Navigate to https://www.ajinvestmentresearch.com/ — read the homepage for latest reports
2. Read the latest **weekly update** ("Market Valuation & Featured Coverage Update") — extract:
   - S&P 500 level, forward P/E, Nasdaq weekly performance
   - Top/worst weekly performers
   - Corridor Method rankings: Best Buys (1Y + 90D), Least Attractive (1Y + 90D)
   - Long-term upside ranking
   - PEG analysis (cheapest and most expensive growth)
   - Trading volume interest (most traded stocks globally)
3. Read **new investment memos** published since the last update — extract from each:
   - Recommendation and price target (12M and 24M)
   - AJ's NTM EPS estimate vs consensus (and the gap %)
   - Forward P/E at current price
   - Core thesis in 2-3 sentences (WHY he is buying/selling/avoiding)
   - Key risks, specific catalysts with dates
   - Forecast track record if mentioned
   - **Corridor data**: NTM EPS, P/E range (low/mid/high), implied corridor prices
4. **Screenshot the Cockpit page** (https://www.ajinvestmentresearch.com/cockpit) — it renders as an interactive chart. Extract quadrant assignments:
   - Upside + Inexpensive (UI) — bullish
   - Upside + Expensive (UE) — hold/watch
   - Downside + Inexpensive (DI) — value trap risk
   - Downside + Expensive (DE) — avoid
   - Out of scope — stocks without corridor data (e.g., pre-earnings companies)

## Step 2: Read X (@alojohhardcore)

Navigate to https://x.com/alojohhardcore in Chrome MCP. Read recent posts AND the "Replies" tab. Extract:
- **Trade alerts**: specific buys, sells, trims with price levels
- **Position sizing changes**: "#1 largest position", "now #4 largest", etc.
- **Portfolio rankings**: search for posts mentioning "largest position", "#1", "#2"
- **Thesis commentary**: why he is adding or cutting
- **Macro views**: market-level observations, Fed/CPI/jobs commentary
- **New coverage**: stocks being added or dropped

X trade alerts carry the HIGHEST weight — they reflect actual positions and override portal signals.

## Step 3: Build the Signal Hierarchy

For each of the ~29 covered stocks, determine the MOST RECENT signal:
1. **X trade alert** (actual position change) — highest weight
2. **Portal investment memo** (detailed thesis with price target)
3. **Weekly Corridor Method** (entry point attractiveness ranking)
4. **Cockpit quadrant** (valuation scatter plot positioning)

Recent overrides old. Tag each stock with:
- **Signal**: BUY / HOLD / TRIM / SELL / AVOID / SHORT / MIXED
- **Date** of the most recent signal
- **Source**: X / Portal / Cockpit
- **Price levels** if available (entry, trim, target)
- **Portfolio rank** if disclosed
- **Corridor data**: corridor low/mid/high, current price position %, forward P/E
- **Thesis context**: WHY, key metrics, catalysts, risks

## Step 4: Update the Dashboard Data (EDIT, NOT REBUILD)

### 4a. Read the existing artifact

```
Artifact({ action: "read", url: "https://claude.ai/code/artifact/51860e0b-f148-4afa-ac41-db6965a28419" })
```

Write the returned HTML to the scratchpad. All edits happen on this file.

### 4b. Identify what changed today

Compare the data you gathered (Steps 1-3) against the existing data arrays in the artifact:
- Are there new dates to append to DATES?
- Are there new closing prices to append to P?
- Did any quadrant assignments change (compare SNAP with today's Cockpit screenshot)?
- Did AJ publish new estimates that change C (corridor params)?
- Are there new X trade alerts or portal memos that change signal cards?

### 4c. Make surgical edits to data arrays only

Use the Edit tool to update specific data sections:

**Daily price append** — add today's date to DATES and today's price to each stock in P:
```
Edit: var DATES=[...existing dates...] → var DATES=[...existing dates...,"2026-08-29"]
Edit: "NVDA":[...existing prices...] → "NVDA":[...existing prices...,148.50]
```

**Quadrant snapshot append** — add today to SNAP_DATES and each stock's quadrant to SNAP:
```
Edit: var SNAP_DATES=[...] → var SNAP_DATES=[...,"2026-08-29"]
Edit: "NVDA":[...existing quads...] → "NVDA":[...existing quads...,"UI"]
```

**Corridor param updates** — ONLY if AJ published new estimates:
```
Edit: {t:"NVDA",n:"Nvidia",...,eps:OLD,...} → {t:"NVDA",n:"Nvidia",...,eps:NEW,...}
```

**Signal card updates** — update only changed signals in the HTML body.

**Macro strip** — update S&P level, P/E, outlook text if new data.

### 4d. Republish to the same URL

```
Artifact({ file_path: "scratchpad/sachins-dashboard.html", url: "https://claude.ai/code/artifact/51860e0b-f148-4afa-ac41-db6965a28419", favicon: "..." })
```

### EPS & Valuation Estimates — Source Priority

1. **AJ's estimates first** — world-class (0-2% forecast error). Extract from portal memos.
2. **Consensus estimates as fallback** — if AJ hasn't published an estimate for a stock.
3. **Flag which is which** — mark "AJ Est" vs "Cons Est" in the data.
4. **Update when AJ publishes new estimates** — his override consensus immediately.

### Dashboard Structure Reference

The dashboard has 5 tabs (DO NOT modify tab structure):
1. **Signals** — hero signal cards grouped by source (X trades, Portal, Cockpit)
2. **Deep Dive** — investment memo summaries with thesis, metrics, catalysts
3. **Portfolio** — AJ's top holdings ranked by position size
4. **Cockpit & Corridors** — 4 sub-views: Cockpit scatter, Corridors card grid, Corridor Bars, Daily Snapshots
5. **Macro & Weekly** — weekly progression strip, macro thesis cards

Design system (DO NOT modify):
- Border coding: red=X trade, blue=Portal, amber=Cockpit
- Signal badges: BUY/SELL/TRIM/HOLD/AVOID/SHORT/MIXED/NEW
- `.fresh` class on today's cards
- Cockpit quadrant colors: UI=#e8622c, UE=#2bb5a0, DI=#5b9bd5, DE=#8b95a5
- PEG formula: `peg = fpe / epsGr` (epsGr is raw number, NOT divided by 100)
- Dark/light theme via CSS variables

## Step 5: Report Changes

After updating, summarize what changed day-over-day:
- New signals or signal changes
- New investment memos published
- Position ranking changes
- Corridor position shifts (e.g., "AMAT moved from 82% to 65% in corridor")
- Cockpit quadrant changes (e.g., "MRVL moved from UI to UE")
- Macro thesis shifts
- New stocks added to or dropped from coverage

## Context Management

- Use `get_page_text` for article content (reports, weekly updates)
- Use `computer screenshot` for the Cockpit page (interactive chart, not text)
- Cap at reading 6-8 full reports per run to avoid context bloat
- Prioritize reports for stocks with X trade alerts
- Close all Chrome MCP tabs when done

## Related Artifacts

- **Sachin's Dashboard** (THE single artifact — never recreate): https://claude.ai/code/artifact/51860e0b-f148-4afa-ac41-db6965a28419
- **Corridor Engine** (reference only): https://claude.ai/code/artifact/3105c0ef-751f-42af-b374-65360ca69540
- **Old Cockpit** (DEPRECATED — merged into Dashboard): https://claude.ai/code/artifact/3541f246-927e-450d-8220-eb62bb51cac3
