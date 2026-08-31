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
    const fx = config.fx?.[ticker] ?? 1;
    const out = { m15: [], m10: [], med: [], p10: [], p15: [] };
    for (let i = 0; i < dates.length; i++) {
      const e = epsSeries[i];
      if (e == null) {
        Object.keys(out).forEach(k => out[k].push(null));
      } else {
        out.m15.push(e * mult.m15 * fx);
        out.m10.push(e * mult.m10 * fx);
        out.med.push(e * mult.med * fx);
        out.p10.push(e * mult.p10 * fx);
        out.p15.push(e * mult.p15 * fx);
      }
    }
    bands[ticker] = out;
  }
  return { dates, bands, source: ajDetails ? 'aj-details.json (exact) + config fallback' : 'config only (interpolated)', lastUpdated: new Date().toISOString() };
}

function computeQuadrant(stock, price, corridor) {
  if (!corridor || !corridor.eps) return 'OOS';
  const upside = stock.iu;
  const peg = stock.ajPeg;
  if (upside == null || peg == null) return 'OOS';
  if (upside > 0 && peg <= 1) return 'UI';
  if (upside > 0 && peg > 1) return 'UE';
  if (upside <= 0 && peg <= 1) return 'DI';
  return 'DE';
}

function computeCorrPos(price, corridor) {
  if (!corridor) return null;
  const low = corridor.bL || (corridor.eps * corridor.peL);
  const high = corridor.bH || (corridor.eps * corridor.peH);
  if (high === low) return 0.5;
  return Math.max(0, Math.min(1, (price - low) / (high - low)));
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

  // Load existing snapshots or start fresh
  let snapData = { dates: [], snapshots: {} };
  if (existsSync(snapPath)) {
    snapData = JSON.parse(readFileSync(snapPath, 'utf8'));
  }

  // Compute latest snapshot
  const snapshot = {};
  const summary = { UI: 0, UE: 0, DI: 0, DE: 0, OOS: 0 };

  for (const stock of config.stocks) {
    const price = prices[stock.t]?.[lastIdx];
    if (price == null) {
      snapshot[stock.t] = 'OOS';
      summary.OOS++;
      continue;
    }

    const corridor = config.corridors[stock.t];
    const quad = computeQuadrant(stock, price, corridor);
    snapshot[stock.t] = quad;
    summary[quad]++;

    const corrPos = computeCorrPos(price, corridor);
    if (corrPos !== null) {
      const label = corrPos < 0.45 ? 'Attractive' : corrPos < 0.75 ? 'Fair Value' : 'Stretched';
      console.log(`  ${stock.t.padEnd(6)} $${price.toLocaleString().padEnd(10)} ${quad.padEnd(3)} Corridor: ${(corrPos * 100).toFixed(0).padStart(3)}% ${label}`);
    }
  }

  // Append today's snapshot (avoid duplicates)
  const todayLabel = new Date(today + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (!snapData.dates.includes(todayLabel)) {
    snapData.dates.push(todayLabel);
    for (const [ticker, quad] of Object.entries(snapshot)) {
      if (!snapData.snapshots[ticker]) snapData.snapshots[ticker] = [];
      snapData.snapshots[ticker].push(quad);
    }
  }

  // Trim to last 20 snapshots
  if (snapData.dates.length > 20) {
    const trim = snapData.dates.length - 20;
    snapData.dates = snapData.dates.slice(trim);
    for (const ticker of Object.keys(snapData.snapshots)) {
      snapData.snapshots[ticker] = snapData.snapshots[ticker].slice(trim);
    }
  }

  snapData.lastUpdated = new Date().toISOString();
  writeFileSync(snapPath, JSON.stringify(snapData, null, 2));

  console.log(`\nQuadrant summary: UI=${summary.UI} UE=${summary.UE} DI=${summary.DI} DE=${summary.DE} OOS=${summary.OOS}`);
  console.log(`Wrote ${snapPath}`);

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
  if (newDates.length > 0 || epsData.dates.length !== dates.length) {
    const oldEps = epsData.eps;
    const oldDates = epsData.dates;
    const dateToIdx = new Map(oldDates.map((d, i) => [d, i]));
    const newEps = {};
    for (const [ticker, corridor] of Object.entries(config.corridors)) {
      const ajEps = ajDetails?.stocks?.[ticker]?.eps;
      const currentEps = ajEps != null ? ajEps : corridor.eps;
      if (currentEps == null) continue;
      const series = dates.map(d => {
        const idx = dateToIdx.get(d);
        if (idx != null && oldEps[ticker]?.[idx] != null) return oldEps[ticker][idx];
        return currentEps; // carry forward from AJ Details (preferred) or config
      });
      newEps[ticker] = series;
    }
    epsData = {
      dates,
      eps: newEps,
      lastUpdated: new Date().toISOString(),
      _comment: 'NTM EPS estimates per stock per date, in native currency. Maintained by update-data.js: new dates use current config.corridors[t].eps, older dates preserved.'
    };
    writeFileSync(epsPath, JSON.stringify(epsData, null, 2));
    console.log(`Synced ${epsPath}: ${Object.keys(newEps).length} tickers × ${dates.length} dates (${newDates.length} new)`);
  }

  // Compute bands time series from eps × P/E multiples × fx (AJ Details preferred)
  const bandsData = computeBands(config, epsData, ajDetails);
  writeFileSync(bandsPath, JSON.stringify(bandsData, null, 2));
  console.log(`Wrote ${bandsPath}: ${Object.keys(bandsData.bands).length} tickers × ${bandsData.dates.length} dates × 5 σ-bands (${bandsData.source})`);
}

main();
