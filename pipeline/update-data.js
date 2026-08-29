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
  const lastIdx = dates.length - 1;
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
}

main();
