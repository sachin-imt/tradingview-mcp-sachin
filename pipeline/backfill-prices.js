#!/usr/bin/env node
/**
 * One-off backfill of deep price history via Yahoo Finance v8.
 *
 * The daily fetch keeps a rolling 45 trading days, which is all the dashboard
 * renders. Computing the corridor multiples ourselves needs far more: the
 * 12-month lookback alone wants ~252 trading days, and we want a run-up buffer
 * before that so the earliest band point is already backed by a full window.
 *
 * Writes pipeline/data/prices-history.json, kept separate from prices.json so
 * the daily cron's rolling window logic stays untouched.
 *
 * Usage: node pipeline/backfill-prices.js [--range 3y]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dir, 'config.json'), 'utf8'));
const outPath = join(__dir, 'data', 'prices-history.json');
const RANGE = process.argv.find((_, i, a) => a[i - 1] === '--range') || '3y';

const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchSeries(symbol, attempt = 0) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
              `?range=${RANGE}&interval=1d`;
  const res = await fetch(url, { headers: UA });
  if (res.status === 429 && attempt < 4) {
    await sleep(2000 * (attempt + 1));
    return fetchSeries(symbol, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const result = (await res.json()).chart?.result?.[0];
  if (!result) throw new Error('no data');
  const ts = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const pts = [];
  for (let i = 0; i < ts.length; i++) {
    if (closes[i] == null) continue;
    pts.push({
      date: new Date(ts[i] * 1000).toISOString().split('T')[0],
      close: Math.round(closes[i] * 10000) / 10000
    });
  }
  return pts;
}

async function main() {
  mkdirSync(join(__dir, 'data'), { recursive: true });
  const prices = {};
  const meta = {};
  const allDates = new Set();
  const errors = [];

  console.log(`Backfilling ${config.stocks.length} stocks at range=${RANGE}...\n`);

  for (const s of config.stocks) {
    try {
      const pts = await fetchSeries(s.yahoo);
      // fx here is a display scale only (AJ quotes Samsung/SK Hynix in ₩ thousands),
      // matching fetch-prices.js so history and the daily series stay on one scale.
      const fx = config.fx?.[s.t] ?? 1;
      if (fx !== 1) pts.forEach(p => { p.close = Math.round(p.close * fx * 10000) / 10000; });

      prices[s.t] = pts;
      pts.forEach(p => allDates.add(p.date));
      meta[s.t] = { first: pts[0]?.date, last: pts[pts.length - 1]?.date, n: pts.length };
      console.log(`  ✓ ${s.t.padEnd(6)} ${String(pts.length).padStart(4)} bars  ${pts[0]?.date} → ${pts[pts.length - 1]?.date}`);
    } catch (e) {
      errors.push(`${s.t} (${s.yahoo}): ${e.message}`);
      console.log(`  ✗ ${s.t.padEnd(6)} ${e.message}`);
    }
    await sleep(120);
  }

  const dates = [...allDates].sort();
  // Re-index every series onto the union calendar so downstream code can assume
  // a single shared date axis; null means "no close on that date for this name"
  // (a local holiday, or a listing that trades on a different calendar).
  const aligned = {};
  for (const [t, pts] of Object.entries(prices)) {
    const byDate = new Map(pts.map(p => [p.date, p.close]));
    aligned[t] = dates.map(d => byDate.has(d) ? byDate.get(d) : null);
  }

  writeFileSync(outPath, JSON.stringify({
    range: RANGE,
    dates,
    prices: aligned,
    meta,
    fetchedAt: new Date().toISOString()
  }, null, 2) + '\n');

  console.log(`\n✓ ${dates.length} trading days, ${Object.keys(aligned).length} stocks → ${outPath}`);
  console.log(`  ${dates[0]} → ${dates[dates.length - 1]}`);
  if (errors.length) console.log(`\n  ${errors.length} failed:\n   ` + errors.join('\n   '));
}

main();
