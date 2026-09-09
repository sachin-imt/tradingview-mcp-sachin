Capture the day's market data and recompute the corridor model. This is the
DATA step. It does not send anything — `/daily-brief` does that.

## What changed

AJ Investment Research portal access ended on 2026-09-09. Every instruction in
the previous version of this skill — logging into ajinvestmentresearch.com,
screenshotting the Cockpit, reading @alojohhardcore — is dead. Do not attempt
any of it, and do not ask the user for portal credentials.

The model now stands on its own:

| Input | Source | Status |
|---|---|---|
| Daily prices | Yahoo Finance v8 | live, no key |
| Forward EPS (consensus) | Finnhub free tier | live, `FINNHUB_KEY` |
| NTM EPS estimates | AJ's Sep 8 values, per name | frozen until that name reports |
| P/E multiples (5 bands) | AJ's Sep 8 Details view | frozen |

AJ's last published state is archived at `docs/archive/2026-09-08.html`. That is
the baseline everything is measured against, and it is not recoverable if lost.

## The cutover rule

Each name keeps AJ's EPS estimate until **that company reports**, because a
report is the event that invalidates it. Then it switches to consensus. This is
per-name and event-driven — never a flag day. `apply-estimates.js` decides;
never edit `epsSource` by hand.

## Run

```bash
node pipeline/fetch-prices.js        # rolling 45 sessions
node pipeline/fetch-estimates.js     # consensus + forward quarters (needs FINNHUB_KEY)
node pipeline/build-eps-series.js    # daily NTM accrual, so the corridor slopes
node pipeline/apply-estimates.js     # DRY RUN — reports cutovers, changes nothing
node pipeline/update-data.js         # bands, quadrants, snapshots
node pipeline/build.js               # docs/index.html
node pipeline/briefing.js            # writes data/briefing-latest.json
```

Order matters: `build-eps-series` needs the price date axis and must precede
`update-data`, which consumes `eps.json` to compute the bands.

## Then check three things

**1. Did anything hit a cutover?** `apply-estimates.js` prints it. If a switch is
HELD by the sanity gate (EPS moving >25%, or implied forward P/E outside 3–250),
do not approve it silently — surface the number to the user and let them decide.
A wrong switch does not crash; it redraws every band and quietly changes what
the dashboard calls cheap.

**2. Is the accrual series current?** `update-data.js` prints a warning if
`eps.json` does not cover every price date. If so, re-run `build-eps-series.js`.

**3. Did the corridors stay sane?** Quadrants should be stable day to day. A
sudden mass reclassification means an input broke, not that the market moved.

## Publish order — STRICT

1. Artifact first: https://claude.ai/code/artifact/51860e0b-f148-4afa-ac41-db6965a28419
2. Then `git add pipeline/data/ docs/ && git commit && git push`

Never push to git before publishing the artifact. This is a standing user
instruction, not a preference.

## Known faults, carried deliberately

- **TSM** reports EPS, market cap and everything else in TWD against a USD ADR
  price. It is marked `sunset` and retires at its 2026-10-14 report rather than
  switching to consensus. Do not try to fix the conversion.
- **The free tier returns three forward quarters, not four.** The fourth is
  derived by extrapolating the quarter-on-quarter step. It is flagged `derived`
  in `estimates.json` — never present those figures as exact.
- **XPEV** is loss-making; consensus NTM is negative, so it is blocked from
  switching and stays out of scope. A corridor on negative earnings inverts.
- We now model a **consensus** corridor. AJ's edge was that his estimates
  differed from consensus, and that is gone. Do not write copy implying the
  dashboard carries his conviction — it carries his method.

## Related

- `/daily-brief` — sends the briefing and alerts (run after this)
- Dashboard: https://sachin-imt.github.io/tradingview-mcp-sachin/
- Archive of AJ's final state: `docs/archive/2026-09-08.html`
