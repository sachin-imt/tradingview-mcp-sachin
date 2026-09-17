#!/usr/bin/env node
/**
 * Recompute derived data (corridor positions, quadrant snapshots) from
 * prices.json + config.json. Writes snapshots.json.
 *
 * Usage: node pipeline/update-data.js
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dir, 'config.json'), 'utf8'));
const pricesPath = join(__dir, 'data', 'prices.json');
const snapPath = join(__dir, 'data', 'snapshots.json');
const epsPath = join(__dir, 'data', 'eps.json');
const bandsPath = join(__dir, 'data', 'bands.json');
const ajDetailsPath = join(__dir, 'data', 'aj-details.json');

// Derive 5 P/E multiples from AJ's 3-point corridor (peL=-1.5σ, peM=median, peH=+1.5σ).
// Assumes linear P/E ↔ σ mapping.
function deriveMultiples(peL, peM, peH) {
  return {
    m15: peL,
    m10: peL + (peM - peL) * (1/3),
    med: peM,
    p10: peM + (peH - peM) * (2/3),
    p15: peH
  };
}

// Compute daily 5-band time series in USD-equivalent for all stocks.
// Prefer AJ Details data (exact 5 multiples + EPS) when available; fall back to
// config-interpolated multiples otherwise.
// AJ publishes two corridors per name: one built on the median forward multiple
// observed over the last 90 days, one over the last 12 months. They routinely
// disagree (Micron is -30% on the 12-month view and +28% on the 90-day), so both
// are carried through the pipeline as parallel series.
function computeBands1y(config, epsData) {
  const dates = epsData.dates;
  const bands = {};
  for (const [ticker, corridor] of Object.entries(config.corridors)) {
    if (corridor.peL1y == null || corridor.peM1y == null || corridor.peH1y == null) continue;
    const epsSeries = epsData.eps[ticker];
    if (!epsSeries) continue;
    const mult = deriveMultiples(corridor.peL1y, corridor.peM1y, corridor.peH1y);
    const out = { m15: [], m10: [], med: [], p10: [], p15: [] };
    for (let i = 0; i < dates.length; i++) {
      const e = epsSeries[i];
      if (e == null) { Object.keys(out).forEach(k => out[k].push(null)); continue; }
      out.m15.push(e * mult.m15); out.m10.push(e * mult.m10); out.med.push(e * mult.med);
      out.p10.push(e * mult.p10); out.p15.push(e * mult.p15);
    }
    bands[ticker] = out;
  }
  return bands;
}

function computeBands(config, epsData, ajDetails) {
  const dates = epsData.dates;
  const bands = {};
  const ajStocks = ajDetails?.stocks || {};
  for (const [ticker, corridor] of Object.entries(config.corridors)) {
    const aj = ajStocks[ticker];
    let mult;
    let epsSeries = epsData.eps[ticker];
    if (aj && aj.peBands && aj.peBands.m15 != null && aj.peBands.p15 != null && aj.peBands.med != null) {
      // Use AJ's exact 5 multiples
      mult = {
        m15: aj.peBands.m15,
        m10: aj.peBands.m10 != null ? aj.peBands.m10 : aj.peBands.m15 + (aj.peBands.med - aj.peBands.m15) * (1/3),
        med: aj.peBands.med,
        p10: aj.peBands.p10 != null ? aj.peBands.p10 : aj.peBands.med + (aj.peBands.p15 - aj.peBands.med) * (2/3),
        p15: aj.peBands.p15
      };
    } else if (corridor.peL && corridor.peM && corridor.peH) {
      mult = deriveMultiples(corridor.peL, corridor.peM, corridor.peH);
    } else {
      continue;
    }
    if (!epsSeries) continue;
    // No fx here. `fx` is a PRICE display scale, applied once in fetch-prices.js to
    // bring the raw Yahoo quote into the units AJ publishes in. eps and the multiples
    // are both already expressed in those same units (both derive from AJ's Details
    // view), so eps x multiple lands in AJ's units directly. Applying fx again would
    // rescale the bands a second time and detach them from the price.
    const out = { m15: [], m10: [], med: [], p10: [], p15: [] };
    for (let i = 0; i < dates.length; i++) {
      const e = epsSeries[i];
      if (e == null) {
        Object.keys(out).forEach(k => out[k].push(null));
      } else {
        out.m15.push(e * mult.m15);
        out.m10.push(e * mult.m10);
        out.med.push(e * mult.med);
        out.p10.push(e * mult.p10);
        out.p15.push(e * mult.p15);
      }
    }
    bands[ticker] = out;
  }
  return { dates, bands, source: ajDetails ? 'aj-details.json (exact) + config fallback' : 'config only (interpolated)', lastUpdated: new Date().toISOString() };
}

/**
 * Cockpit quadrant for one stock on one day.
 *
 * AJ published implied upside (iu) and PEG for each name on a reference date.
 * Both move with the market afterwards, and both move the same way: with the
 * share price relative to fair value. So one ratio drives both axes:
 *
 *   r = (price / refPrice) x (refMedian / medianToday)
 *   upside = (1 + iu) / r - 1          PEG = peg x r
 *
 * At the reference date r = 1 and this reproduces AJ's Cockpit exactly. After
 * it, a falling price pushes r down, and so does the median rising underneath
 * as earnings accrue — either one moves a name toward Upside + Inexpensive.
 *
 * The previous version accepted a price and then ignored it, reading AJ's
 * static iu/ajPeg, so every day recorded the same quadrant for every name.
 */
function cockpitPoint(price, corridor, medNow) {
  const ref = corridor?.cockpitRef;
  if (!ref || price == null || medNow == null || medNow <= 0) return null;
  const r = (price / ref.price) * (ref.med / medNow);
  return { upside: (1 + ref.iu) / r - 1, peg: ref.peg * r, r };
}

function computeQuadrant(price, corridor, medNow) {
  const pt = cockpitPoint(price, corridor, medNow);
  if (!pt) return 'OOS';
  if (pt.upside > 0 && pt.peg <= 1) return 'UI';
  if (pt.upside > 0 && pt.peg > 1) return 'UE';
  if (pt.upside <= 0 && pt.peg <= 1) return 'DI';
  return 'DE';
}

/** Position within the day's own ±1.5σ bands — can pass 0 or 1. */
function computeCorrPos(price, lo, hi) {
  if (price == null || lo == null || hi == null || hi <= lo) return null;
  return (price - lo) / (hi - lo);
}

function main() {
  if (!existsSync(pricesPath)) {
    console.error('No prices.json found. Run fetch-prices.js first.');
    process.exit(1);
  }

  const priceData = JSON.parse(readFileSync(pricesPath, 'utf8'));
  const { dates, prices } = priceData;
  // Find the last date where at least half the tickers have a real price.
  // Yahoo returns nulls on non-trading days (weekends, holidays, pre-open).
  let lastIdx = dates.length - 1;
  const tickers = Object.keys(prices);
  while (lastIdx > 0) {
    const filled = tickers.filter(t => prices[t]?.[lastIdx] != null).length;
    if (filled >= tickers.length / 2) break;
    lastIdx--;
  }
  const today = dates[lastIdx];

  console.log(`Computing data for ${dates.length} dates, latest: ${today}`);

  // Load AJ Details data if present (preferred source for 5-band multiples + EPS)
  let ajDetails = null;
  if (existsSync(ajDetailsPath)) {
    ajDetails = JSON.parse(readFileSync(ajDetailsPath, 'utf8'));
    console.log(`Loaded AJ Details data: ${Object.keys(ajDetails.stocks || {}).length} tickers, scraped ${ajDetails.scrapedAt}`);
  }

  // Sync eps.json to prices.json dates: for any new date, prefer AJ's EPS from
  // aj-details.json, else use current config eps. Carries forward for older dates.
  let epsData;
  if (existsSync(epsPath)) {
    epsData = JSON.parse(readFileSync(epsPath, 'utf8'));
  } else {
    epsData = { dates: [], eps: {}, lastUpdated: null };
  }
  const oldDateSet = new Set(epsData.dates);
  const newDates = dates.filter(d => !oldDateSet.has(d));
  // build-eps-series.js produces a daily accrual curve: earnings accrue
  // continuously, so NTM rises a little each day and the corridor slopes. The
  // carry-forward logic below would flatten that back into one value per
  // ticker, so leave an accrual series alone and let its own builder own it.
  const accrual = epsData.method === 'accrual';
  if (accrual) {
    const stale = dates.filter(d => !oldDateSet.has(d)).length;
    console.log(`eps.json is an accrual series (built ${epsData.builtAt?.slice(0, 10) ?? '?'}) — left as is.` +
      (stale ? `  ${stale} price date(s) not yet covered: re-run build-eps-series.js.` : ''));
  }
  if (!accrual) {
    const oldEps = epsData.eps;
    const dateToIdx = new Map(epsData.dates.map((d, i) => [d, i]));
    const newEps = {};
    const revised = [];
    const lastIdxOut = dates.length - 1;
    for (const [ticker, corridor] of Object.entries(config.corridors)) {
      const ajEps = ajDetails?.stocks?.[ticker]?.eps;
      const currentEps = ajEps != null ? ajEps : corridor.eps;
      if (currentEps == null) continue;
      const series = dates.map((d, i) => {
        // The newest date always reflects the current estimate, so a revision in
        // config (or a fresh AJ Details scrape) takes effect immediately and the
        // band slopes from that point. Earlier dates keep what they had.
        if (i === lastIdxOut) return currentEps;
        const idx = dateToIdx.get(d);
        if (idx != null && oldEps[ticker]?.[idx] != null) return oldEps[ticker][idx];
        return currentEps;
      });
      const prev = oldEps[ticker]?.[dateToIdx.get(dates[lastIdxOut])];
      if (prev != null && prev !== currentEps) revised.push(`${ticker} ${prev}→${currentEps}`);
      newEps[ticker] = series;
    }
    epsData = {
      dates,
      eps: newEps,
      lastUpdated: new Date().toISOString(),
      _comment: 'NTM EPS estimates per stock per date, in native currency. Maintained by update-data.js: the newest date always takes the current estimate (AJ Details scrape if present, else config.corridors[t].eps); earlier dates are preserved so revisions slope the bands forward rather than rewriting history.'
    };
    writeFileSync(epsPath, JSON.stringify(epsData, null, 2));
    console.log(`Synced ${epsPath}: ${Object.keys(newEps).length} tickers × ${dates.length} dates (${newDates.length} new)`
      + (revised.length ? `; EPS revised: ${revised.join(', ')}` : ''));
  }

  // Compute both corridor series: 90-day (default) and 12-month
  const bandsData = computeBands(config, epsData, ajDetails);
  bandsData.bands1y = computeBands1y(config, epsData);
  writeFileSync(bandsPath, JSON.stringify(bandsData, null, 2));
  console.log(`Wrote ${bandsPath}: ${Object.keys(bandsData.bands).length} tickers 90-day + ${Object.keys(bandsData.bands1y).length} tickers 12-month × ${bandsData.dates.length} dates × 5 σ-bands`);

  // ── quadrant snapshots ─────────────────────────────────────────────────────
  // Recomputed for every session in the window rather than appended one day at
  // a time. Every input is now derivable from prices and bands, so there is
  // nothing to preserve between runs — and recomputing means a correction to
  // the method fixes history too, instead of leaving months of stale rows.
  const CARRY_MAX = 5;
  const priceAt = (ticker, i) => {
    const series = prices[ticker];
    if (!series) return null;
    for (let k = i; k >= 0 && k > i - CARRY_MAX; k--) if (series[k] != null) return series[k];
    return null;
  };
  const SNAP_KEEP = 20;
  const snapIdx = [];
  for (let i = 0; i <= lastIdx; i++) {
    const filled = tickers.filter(t => prices[t]?.[i] != null).length;
    if (filled >= tickers.length / 2) snapIdx.push(i);
  }
  const keep = snapIdx.slice(-SNAP_KEEP);
  const label = d => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const snapData = { dates: keep.map(i => label(dates[i])), snapshots: {} };
  for (const stock of config.stocks) {
    const b = bandsData.bands[stock.t];
    snapData.snapshots[stock.t] = keep.map(i =>
      computeQuadrant(priceAt(stock.t, i), config.corridors[stock.t], b?.med?.[i]));
  }
  snapData.lastUpdated = new Date().toISOString();
  writeFileSync(snapPath, JSON.stringify(snapData, null, 2));

  const summary = { UI: 0, UE: 0, DI: 0, DE: 0, OOS: 0 };
  for (const stock of config.stocks) {
    const q = snapData.snapshots[stock.t].at(-1);
    summary[q]++;
    const b = bandsData.bands[stock.t];
    const price = priceAt(stock.t, lastIdx);
    const pos = computeCorrPos(price, b?.m15?.[lastIdx], b?.p15?.[lastIdx]);
    if (pos != null) {
      const zone = pos < 0.45 ? 'Attractive' : pos < 0.75 ? 'Fair Value' : 'Stretched';
      console.log(`  ${stock.t.padEnd(6)} ${String(price).padEnd(10)} ${q.padEnd(3)} Corridor: ${(pos * 100).toFixed(0).padStart(4)}% ${zone}`);
    }
  }
  console.log(`\nQuadrant summary (${today}): UI=${summary.UI} UE=${summary.UE} DI=${summary.DI} DE=${summary.DE} OOS=${summary.OOS}`);
  console.log(`Wrote ${snapPath}: ${snapData.dates.length} sessions recomputed`);
}

main();
