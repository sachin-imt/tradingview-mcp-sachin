#!/usr/bin/env node
/**
 * VIC Idea Fetch — search valueinvestorsclub.com write-ups for a ticker using the
 * shared persistent browser profile (session imported by vic-cookies.js / vic-auth.js).
 *
 * Uses VIC's own autocomplete endpoint: POST /search with query=<ticker>, which
 * returns JSON {result: [{idea_id, comp, symbol, link, add_date}]}.
 *
 * Usage:
 *   node scripts/vic-fetch.js NVDA              → list all ideas for ticker
 *   node scripts/vic-fetch.js NVDA --full       → also fetch the most recent idea's full text
 *   node scripts/vic-fetch.js NVDA --full=2     → fetch the 2 most recent ideas' full text
 *   node scripts/vic-fetch.js --url <ideaUrl>   → fetch a specific idea's full text
 *
 * Output: JSON to stdout
 * Exit codes: 0 ok, 1 error, 2 not logged in (run vic-cookies.js or vic-auth.js)
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
const fullArg = args.find(a => a.startsWith('--full'));
const fullCount = fullArg ? (fullArg.includes('=') ? parseInt(fullArg.split('=')[1], 10) : 1) : 0;
const ticker = args.find(a => !a.startsWith('--') && a !== directUrl);

if (!ticker && !directUrl) {
  console.error('Usage: node scripts/vic-fetch.js <TICKER> [--full[=N]] | --url <ideaUrl>');
  process.exit(1);
}

if (!fs.existsSync(PROFILE_DIR)) {
  console.error('No browser profile found. Run: node scripts/vic-cookies.js');
  process.exit(2);
}

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--ignore-certificate-errors', '--no-sandbox', '--disable-dev-shm-usage'],
    ignoreHTTPSErrors: true,
  });

  const page = context.pages()[0] || await context.newPage();
  const result = { fetchedAt: new Date().toISOString() };

  await page.goto('https://www.valueinvestorsclub.com/ideas', { waitUntil: 'load', timeout: 30000 });
  await sleep(2500);

  const loggedOut = await page.evaluate(() =>
    /log in here/i.test(document.body.innerText) && !/log\s?out/i.test(document.body.innerText)
  );
  if (loggedOut) {
    console.error('Not logged in to VIC. Run: node scripts/vic-cookies.js');
    await context.close();
    process.exit(2);
  }

  async function fetchIdeaText(url) {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await sleep(3000);
    return page.evaluate(() => {
      const text = document.body.innerText;
      // Cap at 60KB; VIC write-ups + comment threads can be very long
      return {
        url: window.location.href,
        title: document.title,
        text: text.length > 60000 ? text.slice(0, 60000) + '\n...[truncated]' : text,
      };
    });
  }

  if (directUrl) {
    result.idea = await fetchIdeaText(directUrl);
  } else {
    result.ticker = ticker.toUpperCase();

    const search = await page.evaluate(async (q) => {
      const r = await fetch('/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
        body: 'query=' + encodeURIComponent(q),
      });
      return r.json();
    }, ticker);

    const all = (search.result || []).map(r => ({
      company: r.comp,
      symbol: r.symbol,
      date: r.add_date,
      url: 'https://www.valueinvestorsclub.com' + r.link,
      isShort: r.l === 1 ? false : undefined, // flag meaning uncertain; raw fields below
      _l: r.l, _d: r.d,
    }));

    // Exact ticker matches first, then fuzzy (VIC search also matches company names)
    const exact = all.filter(i => (i.symbol || '').toUpperCase().split(/[^A-Z]+/).includes(ticker.toUpperCase()));
    result.ideas = (exact.length > 0 ? exact : all).slice(0, 20);
    result.totalMatches = all.length;

    if (fullCount > 0 && result.ideas.length > 0) {
      result.fullIdeas = [];
      for (const idea of result.ideas.slice(0, fullCount)) {
        result.fullIdeas.push(await fetchIdeaText(idea.url));
      }
    }
  }

  await context.close();
  process.stdout.write(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
