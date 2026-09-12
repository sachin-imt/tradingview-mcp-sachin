Capture the day's market data and recompute the Tideline corridor model. This is
the DATA step. It sends nothing — `/tideline-brief` does that.

## What Tideline is

A valuation model in the style of AJ Investment Research's Corridor Method, now
running entirely on its own sources. Each stock is scored against the range it
normally trades in: 0 is the cheap edge, 100 the expensive edge, and the score
can pass either end.

The name is the point. The corridor **rises every day** as earnings accrue, so a
stock that does not move gets cheaper while you watch — the tide coming in under
a boat. That daily accrual is the part that makes this a timing tool rather than
a static channel, and it is easy to break: if the bands ever go flat, something
upstream has failed.

## Sources

| Input | Source | Status |
|---|---|---|
| Daily prices | Yahoo Finance v8 | live, no key |
| Forward EPS (consensus) | Finnhub free tier | live, `FINNHUB_KEY` |
| NTM EPS estimates | AJ's Sep 8 values, per name | frozen until that name reports |
| P/E multiples (5 bands) | AJ's Sep 8 Details view | frozen |

AJ portal access ended 2026-09-09. Do not attempt to scrape
ajinvestmentresearch.com or X — those sources are gone, and do not ask the user
for portal credentials. AJ's last published state is archived at
`docs/archive/2026-09-08.html`; it is the baseline everything is measured
against and is not recoverable if lost.

## The cutover rule

Each name keeps AJ's EPS estimate until **that company reports**, because the
report is what invalidates it. Then it switches to consensus — per name,
event-driven, never a flag day.

Switches that pass both sanity gates now **apply automatically**. Only held ones
wait for a human. Never edit `epsSource` by hand; `apply-estimates.js` owns it.

## Run

```bash
node pipeline/fetch-prices.js         # rolling 45 sessions
node pipeline/fetch-estimates.js      # consensus + forward quarters (FINNHUB_KEY)
node pipeline/apply-estimates.js --apply   # commits passing cutovers, holds the rest
node pipeline/build-eps-series.js     # daily NTM accrual, so the corridor slopes
node pipeline/update-data.js          # bands, quadrants, snapshots
node pipeline/build.js                # docs/index.html
node pipeline/briefing.js             # writes data/briefing-latest.json
```

Order matters twice over. `apply-estimates` must precede `build-eps-series`,
which anchors a name still on AJ's estimate to his level and only takes the raw
consensus curve once it has switched. And `build-eps-series` must precede
`update-data`, which consumes `eps.json` to compute the bands.

## Then check three things

**1. Was anything held?** A switch blocked by the gate (EPS moving >25%, or
implied forward P/E outside 3–250) needs a human. Surface the numbers to the
user — never approve one silently. A wrong switch does not crash; it redraws
every band and quietly changes what the dashboard calls cheap.

**2. Is the accrual series current?** `update-data.js` warns if `eps.json` does
not cover every price date. If so, re-run `build-eps-series.js`. Flat bands mean
the accrual has broken.

**3. Did the corridors stay sane?** Quadrants should be stable day to day. A
sudden mass reclassification means an input broke, not that the market moved.

## Publish

```bash
git add pipeline/data/ docs/ && git commit && git push
```

That is the whole deploy — GitHub Pages serves `docs/` and updates within a
minute. There is no artifact step any more: the Claude artifact mirror was
retired on 2026-09-13 because the daily cron deploys on its own and the mirror
went stale, and republishing it required reading back a 250KB page of generated
data. **Pages is the single dashboard.**

## Known faults, carried deliberately

- **TSM** reports EPS, market cap and everything else in TWD against a USD ADR
  price. Marked `sunset`; retires at its 2026-10-14 report rather than switching
  to consensus. Do not try to fix the conversion.
- **The free tier returns three forward quarters, not four.** The fourth is
  derived by extrapolating the quarter-on-quarter step, flagged `derived` in
  `estimates.json`. Never present those figures as exact.
- **XPEV** is loss-making; consensus NTM is negative, so it is blocked from
  switching and stays out of scope. A corridor on negative earnings inverts.
- We model a **consensus** corridor. AJ's edge was that his estimates differed
  from consensus, and that is gone. Do not write copy implying the dashboard
  carries his conviction — it carries his method.

## Related

- `/tideline-brief` — sends the brief and alerts (run after this)
- Dashboard: https://sachin-imt.github.io/tradingview-mcp-sachin/
- Runs: https://github.com/sachin-imt/tradingview-mcp-sachin/actions
- AJ's final state: `docs/archive/2026-09-08.html`
