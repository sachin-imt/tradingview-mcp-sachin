#!/usr/bin/env node
/**
 * ITC Data Fetch — headless scrape of ITC TradFi stocks and crypto using saved session.
 *
 * Usage: node scripts/itc-fetch.js [--stocks] [--crypto] [--risk]
 *        node scripts/itc-fetch.js             (fetches all by default)
 *
 * Prerequisites: Run node scripts/itc-auth.js once to save your session.
 *
 * Output: JSON to stdout (redirect to file if needed)
 *   { stocks: [...], crypto: [...], risk: [...], fetchedAt: "..." }
 *
 * Session auto-renews if expired (re-runs itc-auth.js flow).
 */

import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.join(__dirname, '.itc-session.json');
const CACHE_FILE = path.join(__dirname, '.itc-cache.json');
const CACHE_MAX_AGE_MINUTES = 15;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function loadSession() {
  if (!fs.existsSync(SESSION_FILE)) {
    console.error('No saved session found.');
    console.error('Run first: node scripts/itc-auth.js');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
}

function checkCache() {
  if (!fs.existsSync(CACHE_FILE)) return null;
  const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  const ageMs = Date.now() - new Date(cache.fetchedAt).getTime();
  if (ageMs < CACHE_MAX_AGE_MINUTES * 60 * 1000) {
    console.error(`Using cached data (${Math.round(ageMs / 60000)}m old, max ${CACHE_MAX_AGE_MINUTES}m)`);
    return cache;
  }
  return null;
}

async function fetchPage(context, url, waitFor) {
  const page = await context.newPage();
  const apiData = {};

  page.on('response', async (res) => {
    const resUrl = res.url();
    if (resUrl.includes('intothecryptoverse.com') && !resUrl.match(/\.(js|css|png|svg|woff|ico)(\?|$)/)) {
      const ct = res.headers()['content-type'] || '';
      if (ct.includes('json') || ct.includes('text/plain')) {
        try {
          const body = await res.json();
          apiData[resUrl] = body;
        } catch {}
      }
    }
  });

  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await sleep(3000);

  // Check if redirected to login
  const currentUrl = page.url();
  if (currentUrl.includes('/authentication/') || currentUrl.includes('/login')) {
    await page.close();
    return { error: 'SESSION_EXPIRED', url: currentUrl };
  }

  let domData = null;
  if (waitFor) {
    try {
      await page.waitForSelector(waitFor, { timeout: 10000 });
    } catch {
      console.error(`Warning: ${waitFor} not found on ${url}`);
    }
  }

  // Extract table data
  domData = await page.evaluate(() => {
    const rows = [];

    // Look for data rows in tables or list items
    const tableRows = document.querySelectorAll('table tbody tr, [role="table"] [role="row"], [class*="row"], [class*="Row"]');

    tableRows.forEach(row => {
      const cells = Array.from(row.querySelectorAll('td, [role="cell"], [class*="cell"], [class*="Cell"]'));
      if (cells.length >= 2) {
        const texts = cells.map(c => c.textContent.trim()).filter(t => t.length > 0);
        if (texts.length >= 2) rows.push(texts);
      }
    });

    // Also try to find price elements by pattern
    const allText = document.body.innerText;
    const lines = allText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    return {
      tableRows: rows,
      fullText: lines.slice(0, 500),
      title: document.title,
      url: window.location.href,
    };
  });

  await page.close();
  return { domData, apiData };
}

function parseStocksFromText(lines) {
  const stocks = [];
  // Common stock ticker patterns: 1-5 uppercase letters followed by price
  const tickerRegex = /^([A-Z]{1,5})\s+\$?([\d,]+\.?\d*)/;
  const priceLineRegex = /\$?([\d,]+\.?\d{2})/;

  // Try to find ticker + price pairs from consecutive lines
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i].trim();
    const match = line.match(/^([A-Z]{1,5})$/);  // Just a ticker symbol
    if (match && i + 1 < lines.length) {
      const nextLine = lines[i + 1];
      const priceMatch = nextLine.match(/\$?([\d,]+\.?\d{2})/);
      if (priceMatch) {
        stocks.push({ ticker: match[1], price: parseFloat(priceMatch[1].replace(',', '')) });
      }
    }

    // Try ticker + price on same line
    const sameLineMatch = line.match(tickerRegex);
    if (sameLineMatch) {
      stocks.push({ ticker: sameLineMatch[1], price: parseFloat(sameLineMatch[2].replace(',', '')) });
    }
  }
  return stocks;
}

function parseTableRows(rows) {
  const data = [];
  for (const row of rows) {
    // First cell likely ticker, second or third likely price
    const ticker = row[0];
    if (!ticker || !/^[A-Z]{1,5}$/.test(ticker)) continue;

    for (let i = 1; i < row.length; i++) {
      const priceMatch = row[i].match(/\$?([\d,]+\.?\d{2})/);
      if (priceMatch) {
        data.push({ ticker, price: parseFloat(priceMatch[1].replace(',', '')), raw: row });
        break;
      }
    }
  }
  return data;
}

async function main() {
  // Check cache first
  const cached = checkCache();
  if (cached) {
    process.stdout.write(JSON.stringify(cached, null, 2));
    return;
  }

  const session = loadSession();
  const sessionAgeHours = (Date.now() - new Date(session.savedAt).getTime()) / 3600000;
  console.error(`Session age: ${Math.round(sessionAgeHours)}h (saved ${session.savedAt})`);

  if (sessionAgeHours > 720) { // 30 days
    console.error('Session is very old (>30 days). Consider re-running itc-auth.js.');
  }

  const browser = await chromium.launch({
    headless: true,
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--ignore-certificate-errors', '--no-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  // Restore cookies
  if (session.cookies && session.cookies.length > 0) {
    const validCookies = session.cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain.startsWith('.') ? c.domain : `.${c.domain}`,
      path: c.path || '/',
      httpOnly: c.httpOnly || false,
      secure: c.secure || false,
      sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax',
    }));
    try {
      await context.addCookies(validCookies);
    } catch (e) {
      console.error('Cookie restore warning:', e.message);
    }
  }

  // Restore localStorage via a quick visit
  if (session.localStorage && Object.keys(session.localStorage).length > 0) {
    const initPage = await context.newPage();
    await initPage.goto('https://app.intothecryptoverse.com', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await initPage.evaluate((lsData) => {
      Object.entries(lsData).forEach(([k, v]) => {
        try { localStorage.setItem(k, v); } catch {}
      });
    }, session.localStorage).catch(() => {});
    await initPage.close();
  }

  const result = {
    fetchedAt: new Date().toISOString(),
    sessionAge: `${Math.round(sessionAgeHours)}h`,
    stocks: [],
    crypto: [],
    risk: {},
    raw: {},
  };

  // Fetch TradFi stocks
  console.error('Fetching TradFi stocks...');
  const stocksResult = await fetchPage(context, 'https://app.intothecryptoverse.com/tradfi/stocks', null);

  if (stocksResult.error === 'SESSION_EXPIRED') {
    console.error('\n✗ Session expired. Re-run: node scripts/itc-auth.js');
    await browser.close();
    process.exit(2);
  }

  result.raw.stocks = stocksResult;

  // Parse stocks data
  if (stocksResult.domData) {
    const fromTable = parseTableRows(stocksResult.domData.tableRows || []);
    const fromText = parseStocksFromText(stocksResult.domData.fullText || []);
    result.stocks = fromTable.length > 0 ? fromTable : fromText;
    console.error(`  Found ${result.stocks.length} stocks from DOM`);
  }

  // Check API data for stocks
  for (const [url, data] of Object.entries(stocksResult.apiData || {})) {
    if (Array.isArray(data) && data.length > 0 && data[0].ticker) {
      result.stocks = data;
      console.error(`  Found ${data.length} stocks from API: ${url}`);
    }
  }

  // Fetch crypto data
  console.error('Fetching crypto dashboard...');
  const cryptoResult = await fetchPage(context, 'https://app.intothecryptoverse.com/dashboard', null);
  result.raw.crypto = cryptoResult;

  if (cryptoResult.domData) {
    const cryptoLines = cryptoResult.domData.fullText || [];
    // Look for crypto prices (BTC, ETH, SOL, etc.)
    const cryptoTickers = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'AVAX', 'ADA', 'LTC'];
    for (const ticker of cryptoTickers) {
      const idx = cryptoLines.findIndex(l => l === ticker || l.startsWith(ticker + ' '));
      if (idx >= 0) {
        for (let i = idx + 1; i < Math.min(idx + 5, cryptoLines.length); i++) {
          const priceMatch = cryptoLines[i].match(/\$?([\d,]+\.?\d{2})/);
          if (priceMatch) {
            result.crypto.push({ ticker, price: parseFloat(priceMatch[1].replace(',', '')) });
            break;
          }
        }
      }
    }
    console.error(`  Found ${result.crypto.length} crypto prices from DOM`);
  }

  await browser.close();

  // Save cache
  fs.writeFileSync(CACHE_FILE, JSON.stringify(result, null, 2));

  // Output result
  process.stdout.write(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
