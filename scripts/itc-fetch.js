#!/usr/bin/env node
/**
 * ITC Data Fetch — headless scrape using the persistent browser profile from itc-auth.js.
 *
 * The profile directory (scripts/.itc-profile/) stores ALL browser state including IndexedDB
 * auth tokens, so this script is always authenticated as long as the profile exists.
 *
 * Usage: node scripts/itc-fetch.js
 * Output: JSON to stdout  { stocks: [...], crypto: [...], fetchedAt: "..." }
 *
 * Prerequisites: Run node scripts/itc-auth.js once to create the profile.
 */

import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(__dirname, '.itc-profile');
const CACHE_FILE = path.join(__dirname, '.itc-cache.json');
const CACHE_MAX_AGE_MIN = 15;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function checkCache() {
  if (!fs.existsSync(CACHE_FILE)) return null;
  const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  const ageMs = Date.now() - new Date(cache.fetchedAt).getTime();
  if (ageMs < CACHE_MAX_AGE_MIN * 60 * 1000) {
    console.error(`Using cache (${Math.round(ageMs / 60000)}m old)`);
    return cache;
  }
  return null;
}

// Known exchange names to skip
const EXCHANGE_NAMES = new Set(['NYSE', 'NASDAQ', 'PINK', 'OTCQX', 'OTCQB', 'AMEX', 'BATS']);

function parseStocks(lines) {
  const results = [];
  const seen = new Set();
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i].trim();

    // ITC format: "Company NameTICKER" — requires lowercase (company name) + uppercase suffix (ticker)
    // e.g. "NVIDIA CorporationNVDA", "Apple IncAAPL", "Meta Platforms Inc.FB"
    if (!/[a-z]/.test(line)) continue; // skip all-caps headers/labels

    const tickerMatch = line.match(/([A-Z]{1,5})$/);
    if (!tickerMatch) continue;

    const ticker = tickerMatch[1];
    if (seen.has(ticker) || EXCHANGE_NAMES.has(ticker)) continue;
    if (ticker.length === 1 && /^[A-Z]$/.test(ticker)) continue; // skip single letters from "Class A" etc.

    // Next line should be the price (starts with $)
    for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
      const m = lines[j].match(/^\$?([\d,]+\.?\d{1,4})$/);
      if (m) {
        const price = parseFloat(m[1].replace(/,/g, ''));
        if (price > 0 && price < 5000000) {
          results.push({ ticker, price });
          seen.add(ticker);
        }
        break;
      }
    }
  }
  return results;
}

function parseCrypto(lines) {
  const results = [];
  const seen = new Set();
  for (let i = 0; i < lines.length - 2; i++) {
    // ITC crypto format: "Bitcoin" then "(BTC)" then "$73,397.50"
    const tickerParenMatch = lines[i].match(/^\(([A-Z]{2,6})\)$/);
    if (tickerParenMatch) {
      const ticker = tickerParenMatch[1];
      if (seen.has(ticker)) continue;
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
        const m = lines[j].match(/^\$?([\d,]+\.?\d+)$/);
        if (m) {
          const price = parseFloat(m[1].replace(/,/g, ''));
          if (price > 0) { results.push({ ticker, price }); seen.add(ticker); }
          break;
        }
      }
    }
  }
  return results;
}

async function main() {
  const cached = checkCache();
  if (cached) { process.stdout.write(JSON.stringify(cached, null, 2)); return; }

  if (!fs.existsSync(PROFILE_DIR)) {
    console.error('No browser profile found. Run: node scripts/itc-auth.js');
    process.exit(1);
  }

  console.error('Launching browser with saved profile...');
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--ignore-certificate-errors', '--no-sandbox', '--disable-dev-shm-usage'],
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const result = {
    fetchedAt: new Date().toISOString(),
    stocks: [],
    crypto: [],
    raw: {},
  };

  async function fetchAndScrape(url, label) {
    const page = await context.newPage();
    const apiResponses = [];

    page.on('response', async res => {
      const u = res.url();
      if (u.includes('intothecryptoverse.com') && !u.match(/\.(js|css|png|svg|woff|ico)(\?|$)/)) {
        const ct = res.headers()['content-type'] || '';
        if (ct.includes('json')) {
          try { apiResponses.push({ url: u, body: await res.json() }); } catch {}
        }
      }
    });

    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await sleep(6000); // Wait for React to render data

    const finalUrl = page.url();
    if (finalUrl.includes('/authentication/') || finalUrl.includes('/login')) {
      console.error(`Session expired on ${label}. Re-run: node scripts/itc-auth.js`);
      await page.close();
      return { expired: true };
    }

    const domData = await page.evaluate(() => {
      const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(l => l);
      const tableRows = Array.from(document.querySelectorAll('table tbody tr, [role="row"]')).map(row =>
        Array.from(row.querySelectorAll('td, [role="cell"]')).map(c => c.textContent.trim()).filter(t => t)
      ).filter(r => r.length >= 2);
      return { lines, tableRows, title: document.title, url: window.location.href };
    });

    await page.screenshot({ path: `/tmp/itc-${label}.png` });
    await page.close();
    return { domData, apiResponses };
  }

  // Fetch stocks
  console.error('Fetching TradFi stocks...');
  const stocksResult = await fetchAndScrape('https://app.intothecryptoverse.com/tradfi/stocks', 'stocks');

  if (stocksResult.expired) {
    await context.close();
    process.exit(2);
  }

  result.raw.stocksTitle = stocksResult.domData?.title;
  result.raw.stocksUrl = stocksResult.domData?.url;

  // Parse from API responses first
  for (const { url, body } of stocksResult.apiResponses || []) {
    if (Array.isArray(body) && body.length > 5) {
      const first = body[0];
      if (first && (first.ticker || first.symbol || first.name)) {
        result.stocks = body.map(item => ({
          ticker: item.ticker || item.symbol,
          price: item.price || item.close || item.last,
          ...item,
        }));
        console.error(`Stocks from API (${result.stocks.length}): ${url}`);
        break;
      }
    }
  }

  // Parse from DOM if no API data
  if (result.stocks.length === 0 && stocksResult.domData) {
    result.stocks = parseStocks(stocksResult.domData.lines || []);
    console.error(`Stocks from DOM: ${result.stocks.length}`);
  }

  // Save raw page text for debugging / fallback parsing by Claude
  result.raw.stocksLines = stocksResult.domData?.lines?.slice(0, 300) || [];

  // Fetch crypto dashboard
  console.error('Fetching crypto dashboard...');
  const cryptoResult = await fetchAndScrape('https://app.intothecryptoverse.com/dashboard', 'crypto');

  if (!cryptoResult.expired && cryptoResult.domData) {
    const lines = cryptoResult.domData.lines || [];
    result.crypto = parseCrypto(lines);
    result.raw.cryptoLines = lines.slice(0, 200);
    console.error(`Crypto from DOM: ${result.crypto.length}`);
  }

  await context.close();

  fs.writeFileSync(CACHE_FILE, JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
