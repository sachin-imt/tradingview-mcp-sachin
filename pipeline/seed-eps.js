#!/usr/bin/env node
/**
 * One-time seed: create pipeline/data/eps.json from config.json's current EPS
 * values, flat across all dates in prices.json. Once real EPS time series
 * data is available (from AJ scraper or another source), this file is
 * updated by fetch-aj.js instead.
 *
 * Usage: node pipeline/seed-eps.js
 */
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dir, 'config.json'), 'utf8'));
const prices = JSON.parse(readFileSync(join(__dir, 'data', 'prices.json'), 'utf8'));

const dates = prices.dates;
const eps = {};

for (const [ticker, c] of Object.entries(config.corridors)) {
  if (c.eps == null) continue;
  eps[ticker] = dates.map(() => c.eps);
}

const out = {
  dates,
  eps,
  lastUpdated: new Date().toISOString(),
  _comment: 'NTM EPS estimates per stock per date, in native currency. Bootstrap: flat from config.corridors[t].eps. Once AJ scraper captures daily EPS estimates, this file evolves.'
};

writeFileSync(join(__dir, 'data', 'eps.json'), JSON.stringify(out, null, 2));
console.log(`Seeded eps.json: ${Object.keys(eps).length} tickers × ${dates.length} dates`);
