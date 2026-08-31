Scan AJ Investment Research portal and @alojohhardcore X account for the latest signals, then update Sachin's Dashboard — publishing to the Claude artifact FIRST, then pushing to git (which redeploys the public GitHub Pages site).

## RULE ZERO — SOURCE OF TRUTH & UPDATE MODEL

The dashboard now has a **pipeline** in the git repo. There are TWO deploy targets and the repo is the master source:

| Location | Role |
|---|---|
| `sachins-dashboard.html` (repo root) | **Master template** — HTML, CSS, JS rendering, data placeholders |
| `pipeline/config.json` | Stock metadata, corridor params, corrMeta, macro, fx |
| `pipeline/data/prices.json` | Daily prices time series (Yahoo, auto-fetched) |
| `pipeline/data/eps.json` | Daily NTM EPS time series (native currency) |
| `pipeline/data/bands.json` | Computed 5-band time series (USD-equiv) |
| `pipeline/data/snapshots.json` | Daily quadrant snapshots |
| `pipeline/data/aj-details.json` | AJ Details view scrape (5 P/E multiples + EPS per ticker), preferred over config |
| `docs/index.html` | Pipeline output — deployed by GitHub Pages |
| Claude Artifact (URL below) | Mirror of the built dashboard, for Sachin's review |

**Never** create a new artifact or rebuild `sachins-dashboard.html` from scratch. Edit the data sources, run the pipeline, then publish.

**Dashboard Artifact URL** (always pass as `url` to Artifact tool):
https://claude.ai/code/artifact/51860e0b-f148-4afa-ac41-db6965a28419

**GitHub Pages URL**:
https://sachin-imt.github.io/tradingview-mcp-sachin/

## RULE ONE — PUBLISH ORDER (STRICT)

For every dashboard change, in this exact order:

1. Edit `sachins-dashboard.html` (signal cards, macro strip, Deep Dive HTML) and/or `pipeline/config.json` (corridors, stocks, corrMeta)
2. Run `node pipeline/update-data.js` (recompute snapshots + bands; syncs eps.json)
3. Run `node pipeline/build.js` (rebuild `docs/index.html`)
4. **PUBLISH TO ARTIFACT FIRST** — strip frame-runtime from the built HTML into a scratchpad file, then `Artifact({file_path, url: <dashboard URL>, favicon: "📊"})`
5. **THEN commit and push to git** — the GitHub Actions daily workflow will handle the routine daily price/snapshot append on its own

Never git-push before publishing the artifact.

## Rolling Window

- The pipeline maintains **45 trading days** in `pipeline/data/prices.json` (auto-trimmed by `fetch-prices.js`)
- Snapshots keep the last 20 (auto-trimmed by `update-data.js`)
- No manual trimming needed — the pipeline handles it

---

## Step 1: Read the Portal (Chrome MCP — user is logged in)

Use Chrome MCP tools (mcp__claude-in-chrome__*) to access subscriber content. The in-app browser pane cannot authenticate.

1. Navigate to https://www.ajinvestmentresearch.com/ — read the homepage for latest reports
2. Read the latest **weekly update** ("Market Valuation & Featured Coverage Update") — extract:
   - S&P 500 level, forward P/E, Nasdaq weekly performance
   - Top/worst weekly performers
   - Corridor Method rankings: Best Buys (1Y + 90D), Least Attractive (1Y + 90D)
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
   - Out of scope — stocks without corridor data
5. **Screenshot the Cockpit → Details view** — this is the definitive source for corridor bands. Extract the 5-band P/E multiples per stock: -1.5σ, -1σ, Median, +1σ, +1.5σ. If any changed vs current config, update `pipeline/config.json` corridors OR let `pipeline/fetch-aj.js` (with `AJ_USERNAME`/`AJ_PASSWORD`) scrape it into `pipeline/data/aj-details.json`.

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
- **Corridor data**: 5 P/E multiples if changed
- **Thesis context**: WHY, key metrics, catalysts, risks

## Step 4: Update Data Sources (EDIT, NOT REBUILD)

Follow this exact order:

### 4a. Update `pipeline/config.json` (corridors, corrMeta, macro)

Only touch what actually changed:
- `corridors.<ticker>.eps` — if AJ published a new NTM EPS estimate
- `corridors.<ticker>.peL/peM/peH` — if AJ's Details view shows new multiples
- `corrMeta.<ticker>` — new memo, signal, ajVsCons, consEps
- `macro` — S&P level, fwd P/E, outlook, bearTrigger

### 4b. Update signal cards in `sachins-dashboard.html`

The 5 tabs' HTML content lives directly in this file. Use Edit tool for surgical changes:
- **Signals tab** — hero cards under "X Trade Alerts", "Portal Investment Memos", "Cockpit Quadrants"
- **Deep Dive tab** — investment memo cards
- **Portfolio tab** — ranked positions table
- **Macro & Weekly tab** — weekly progression, macro thesis cards
- Add `.fresh` class to today's new cards; drop old fresh classes

Do NOT touch:
- The template's data-placeholder arrays (`const STOCKS`, `const C`, `const DATES`, `const P`, `const SNAP_DATES`, `const SNAP`, `const CORR_META`, `const BANDS`) — these are injected by `build.js` from `pipeline/config.json` + `pipeline/data/*.json`
- The `<script>` rendering functions
- The CSS
- Tab structure

### 4c. Run the pipeline

```bash
node pipeline/fetch-prices.js     # optional — usually the GitHub Actions cron handles this
node pipeline/update-data.js       # recompute snapshots, sync eps, produce bands.json
node pipeline/build.js             # inject data into template → docs/index.html
```

### 4d. Publish to Claude Artifact FIRST

Prepare a scratchpad copy without the frame-runtime wrapper:

```bash
node -e "
const fs=require('fs');
let h=fs.readFileSync('sachins-dashboard.html','utf8');
h=h.replace(/^[\s\S]*?<body>/,'').replace(/<\/body>\s*<\/html>/,'');
fs.writeFileSync('<scratchpad>/sachins-dashboard-artifact.html', h);
"
```

Then publish:

```
Artifact({
  file_path: "<scratchpad>/sachins-dashboard-artifact.html",
  url: "https://claude.ai/code/artifact/51860e0b-f148-4afa-ac41-db6965a28419",
  title: "Sachin's Dashboard",
  favicon: "📊"
})
```

If publish is refused because the remote has drifted, `action: "read"` the URL first, merge onto the returned source, publish again.

### 4e. Commit and push to git

```bash
git add sachins-dashboard.html pipeline/config.json pipeline/data/ docs/index.html
git commit -m "Daily update: <date> AJ signals + prices"
git push
```

The GitHub Actions daily workflow (6 PM ET) handles routine daily price/snapshot updates on its own — this manual run is only for signal/memo/config changes that need human input.

### EPS & Valuation Estimates — Source Priority

1. **AJ Details view scrape** (`pipeline/data/aj-details.json`) — most authoritative; 5-band multiples + AJ's NTM EPS per ticker. Set by `fetch-aj.js` when credentials available.
2. **AJ portal memos** — extract manually via Chrome MCP; update `pipeline/config.json` corridor entries.
3. **Consensus estimates** — fallback for stocks without AJ estimates.
4. **Flag which is which** — `est: "aj"` vs `est: "cons"` in `pipeline/config.json` stocks array.

### Dashboard Structure Reference

5 tabs (DO NOT modify tab structure):
1. **Signals** — hero signal cards grouped by source (X trades, Portal, Cockpit)
2. **Deep Dive** — investment memo summaries with thesis, metrics, catalysts
3. **Portfolio** — AJ's top holdings ranked by position size
4. **Cockpit & Corridors** — 4 sub-views: Cockpit scatter, Corridors card grid (with 5-band sparklines + legend), Corridor Bars, Daily Snapshots
5. **Macro & Weekly** — weekly progression strip, macro thesis cards

Design system (DO NOT modify):
- Border coding: red=X trade, blue=Portal, amber=Cockpit
- Signal badges: BUY/SELL/TRIM/HOLD/AVOID/SHORT/MIXED/NEW
- `.fresh` class on today's cards
- Cockpit quadrant colors: UI=#e8622c, UE=#2bb5a0, DI=#5b9bd5, DE=#8b95a5
- Corridor sparkline colors: red (±1.5σ), green (±1σ), dashed white (median), blue price line
- PEG formula: `peg = fpe / epsGr` (epsGr is raw number, NOT divided by 100)
- Dark/light theme via CSS variables

## Step 5: Report Changes

After updating, summarize what changed day-over-day:
- New signals or signal changes
- New investment memos published
- Position ranking changes
- Corridor position shifts
- Cockpit quadrant changes
- Macro thesis shifts
- Confirm: artifact URL updated ✓ and git pushed ✓

## Context Management

- Use `get_page_text` for article content
- Use `computer screenshot` for the Cockpit page (interactive chart)
- Cap at reading 6-8 full reports per run
- Prioritize reports for stocks with X trade alerts
- Close all Chrome MCP tabs when done

## Related Artifacts

- **Sachin's Dashboard** (artifact mirror): https://claude.ai/code/artifact/51860e0b-f148-4afa-ac41-db6965a28419
- **GitHub Pages** (public): https://sachin-imt.github.io/tradingview-mcp-sachin/
- **Git repo**: https://github.com/sachin-imt/tradingview-mcp-sachin
- **Corridor Engine** (reference only): https://claude.ai/code/artifact/3105c0ef-751f-42af-b374-65360ca69540
- **Old Cockpit** (DEPRECATED — merged into Dashboard): https://claude.ai/code/artifact/3541f246-927e-450d-8220-eb62bb51cac3
