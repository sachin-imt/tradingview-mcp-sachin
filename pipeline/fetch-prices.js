#!/usr/bin/env node
/**
 * Fetch latest closing prices for all tracked stocks via Yahoo Finance v8 API.
 * No API key required. Outputs to pipeline/data/prices.json.
 *
 * Usage: node pipeline/fetch-prices.js [--days 45]
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dir, 'config.json'), 'utf8'));
const dataPath = join(__dir, 'data', 'prices.json');
const MAX_DAYS = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--days') || '45');

async function fetchYahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
  });
  if (!res.ok) throw new Error(`Yahoo ${symbol}: ${res.status}`);
  const json = await res.json();
  const result = json.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo ${symbol}: no data`);
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const points = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] == null) continue;
    const d = new Date(timestamps[i] * 1000);
    const dateStr = d.toISOString().split('T')[0];
    points.push({ date: dateStr, close: Math.round(closes[i] * 100) / 100 });
  }
  return points;
}

async function main() {
  let existing = { dates: [], prices: {}, lastUpdated: null };
  if (existsSync(dataPath)) {
    existing = JSON.parse(readFileSync(dataPath, 'utf8'));
  }

  const yahooSymbols = config.stocks.map(s => ({ ticker: s.t, yahoo: s.yahoo }));
  console.log(`Fetching prices for ${yahooSymbols.length} stocks...`);

  const results = {};
  const errors = [];
  const allDatesSet = new Set(existing.dates || []);

  for (const { ticker, yahoo } of yahooSymbols) {
    try {
      const points = await fetchYahooQuote(yahoo);
      // Apply fx to convert native → USD-equivalent so prices align with bands
      const fx = config.fx?.[ticker] ?? 1;
      if (fx !== 1) {
        points.forEach(p => { p.close = Math.round(p.close * fx * 100) / 100; });
      }
      results[ticker] = points;
      points.forEach(p => allDatesSet.add(p.date));
      console.log(`  ✓ ${ticker} (${yahoo}): ${points.length} bars${fx !== 1 ? ` (fx ${fx})` : ''}`);
      await new Promise(r => setTimeout(r, 300)); // rate limit
    } catch (e) {
      console.error(`  ✗ ${ticker} (${yahoo}): ${e.message}`);
      errors.push(ticker);
    }
  }

  // Merge: build unified date array, trim to MAX_DAYS trading days
  const allDates = [...allDatesSet].sort();
  const trimmedDates = allDates.slice(-MAX_DAYS);

  const prices = {};
  for (const s of config.stocks) {
    const newData = results[s.t];
    const oldData = existing.prices?.[s.t] || [];
    // Build a date→price map from both old and new
    const map = {};
    if (Array.isArray(oldData)) {
      // Old format: array aligned with existing.dates
      (existing.dates || []).forEach((d, i) => { if (oldData[i] != null) map[d] = oldData[i]; });
    }
    if (newData) {
      newData.forEach(p => { map[p.date] = p.close; });
    }
    prices[s.t] = trimmedDates.map(d => map[d] ?? null);
  }

  const output = {
    dates: trimmedDates,
    prices,
    lastUpdated: new Date().toISOString(),
    errors: errors.length ? errors : undefined
  };

  writeFileSync(dataPath, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${dataPath}`);
  console.log(`  ${trimmedDates.length} trading days, ${Object.keys(prices).length} stocks`);
  if (errors.length) console.log(`  ⚠ Failed: ${errors.join(', ')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
