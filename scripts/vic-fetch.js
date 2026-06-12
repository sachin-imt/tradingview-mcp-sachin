#!/usr/bin/env node
/**
 * VIC Idea Fetch — search valueinvestorsclub.com for write-ups on a ticker using the
 * shared persistent browser profile (login saved by vic-auth.js).
 *
 * Usage:
 *   node scripts/vic-fetch.js NVDA              → list ideas for ticker
 *   node scripts/vic-fetch.js NVDA --full       → also fetch the most recent idea's full text
 *   node scripts/vic-fetch.js --url <ideaUrl>   → fetch a specific idea's full text
 *
 * Output: JSON to stdout { ticker, ideas: [{title, company, date, author, url, performance}], idea?: {...} }
 * Exit codes: 0 ok, 1 error, 2 not logged in (run vic-auth.js)
 */

import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(__dirname, '.itc-profile');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const args = process.argv.slice(2);
const urlIdx = args.indexOf('--url');
const directUrl = urlIdx >= 0 ? args[urlIdx + 1] : null;
const wantFull = args.includes('--full');
const ticker = args.find(a => !a.startsWith('--') && a !== directUrl);

if (!ticker && !directUrl) {
  console.error('Usage: node scripts/vic-fetch.js <TICKER> [--full] | --url <ideaUrl>');
  process.exit(1);
}

if (!fs.existsSync(PROFILE_DIR)) {
  console.error('No browser profile found. Run: node scripts/vic-auth.js');
  process.exit(2);
}

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--ignore-certificate-errors', '--no-sandbox', '--disable-dev-shm-usage'],
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = context.pages()[0] || await context.newPage();
  const result = { fetchedAt: new Date().toISOString() };

  async function checkLoggedOut() {
    const out = await page.evaluate(() =>
      /log in here/i.test(document.body.innerText) && !/log\s?out/i.test(document.body.innerText)
    );
    if (out) {
      console.error('Not logged in to VIC. Run: node scripts/vic-auth.js');
      await context.close();
      process.exit(2);
    }
  }

  async function fetchIdeaText(url) {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await sleep(3000);
    return page.evaluate(() => {
      const text = document.body.innerText;
      // Cap at 60KB to avoid context bloat; VIC write-ups can be long
      return {
        url: window.location.href,
        title: document.title,
        text: text.length > 60000 ? text.slice(0, 60000) + '\n...[truncated]' : text,
      };
    });
  }

  if (directUrl) {
    result.idea = await fetchIdeaText(directUrl);
    await checkLoggedOut();
  } else {
    // VIC search: /ideas/search?term=<ticker> — fall back to site search box if route changes
    await page.goto(`https://www.valueinvestorsclub.com/ideas/search?term=${encodeURIComponent(ticker)}`, {
      waitUntil: 'load', timeout: 30000,
    });
    await sleep(4000);
    await checkLoggedOut();

    result.ticker = ticker.toUpperCase();
    result.ideas = await page.evaluate(() => {
      // Idea links look like /idea/COMPANY_NAME/<id>
      const links = Array.from(document.querySelectorAll('a[href*="/idea/"]'));
      const seen = new Set();
      return links.map(a => {
        const url = a.href;
        if (seen.has(url)) return null;
        seen.add(url);
        const row = a.closest('tr, .idea_row, li, div');
        const rowText = row ? row.innerText.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
        return { title: a.textContent.trim(), url, context: rowText };
      }).filter(Boolean).slice(0, 25);
    });

    if (wantFull && result.ideas.length > 0) {
      result.idea = await fetchIdeaText(result.ideas[0].url);
    }
  }

  await context.close();
  process.stdout.write(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
