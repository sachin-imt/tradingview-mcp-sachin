#!/usr/bin/env node
/**
 * Scrape AJ Investment Research cockpit + dashboard for corridor and cockpit data.
 * Uses Playwright for authenticated browser automation.
 *
 * Env vars required:
 *   AJ_USERNAME — AJ portal login email
 *   AJ_PASSWORD — AJ portal login password
 *
 * Outputs:
 *   pipeline/data/aj-cockpit.json  — quadrant assignments, PEG, implied upside
 *   pipeline/data/aj-corridors.json — corridor band prices from Details table
 *
 * Usage: node pipeline/fetch-aj.js
 *
 * Install: npx playwright install chromium
 */
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dir, 'config.json'), 'utf8'));

async function main() {
  const { chromium } = await import('playwright');

  const username = process.env.AJ_USERNAME;
  const password = process.env.AJ_PASSWORD;
  if (!username || !password) {
    console.error('Error: AJ_USERNAME and AJ_PASSWORD env vars required');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
  });
  const page = await context.newPage();

  // Step 1: Login
  console.log('Logging in to AJ Investment Research...');
  await page.goto(config.aj.loginUrl, { waitUntil: 'networkidle' });
  await page.fill('#user_login', username);
  await page.fill('#user_pass', password);
  await page.click('#wp-submit');
  await page.waitForNavigation({ waitUntil: 'networkidle' });
  console.log('  ✓ Logged in');

  // Step 2: Scrape Cockpit Overview (scatter plot data via tooltips)
  console.log('Scraping cockpit overview...');
  await page.goto(config.aj.cockpitUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000); // wait for chart render

  // Extract quadrant data from the page's JavaScript context
  const cockpitData = await page.evaluate(() => {
    // The cockpit page renders via Plotly or similar — try to extract data from the DOM
    const stocks = [];

    // Try to read from sidebar chips
    const chips = document.querySelectorAll('[class*="chip"], [class*="badge"], [data-company]');
    chips.forEach(chip => {
      const text = chip.textContent?.trim();
      const title = chip.getAttribute('title') || chip.getAttribute('data-original-title') || '';
      if (text && title) {
        stocks.push({ name: text, tooltip: title });
      }
    });

    // Also try to extract from any embedded data/script
    const scripts = document.querySelectorAll('script');
    let plotData = null;
    scripts.forEach(s => {
      const text = s.textContent;
      if (text && (text.includes('Plotly') || text.includes('scatter') || text.includes('implied'))) {
        // Try to find data arrays
        const match = text.match(/var\s+data\s*=\s*(\[[\s\S]*?\]);/);
        if (match) plotData = match[1];
      }
    });

    return { chips: stocks, hasPlotData: !!plotData, plotDataPreview: plotData?.substring(0, 500) };
  });

  console.log(`  Found ${cockpitData.chips.length} chips, plotData: ${cockpitData.hasPlotData}`);

  // Step 3: Click "Details" tab to get corridor band table
  console.log('Scraping cockpit details (corridor bands)...');
  const detailsBtn = await page.$('text=Details');
  if (detailsBtn) {
    await detailsBtn.click();
    await page.waitForTimeout(2500);
  }

  // Extract corridor bands. AJ's Details view is a scrollable table:
  // rows include "NTM EPS", "-1.5σ P/E", "-1σ P/E", "Median P/E", "+1σ P/E", "+1.5σ P/E"
  // (and their implied share prices), columns are ticker symbols.
  // We try several table shapes and log what we found so selectors can be tuned.
  const corridorData = await page.evaluate(() => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const num = s => {
      if (!s) return null;
      const m = String(s).replace(/[,\s$€£¥₩]/g, '').match(/-?\d+(\.\d+)?/);
      return m ? parseFloat(m[0]) : null;
    };
    const tables = [...document.querySelectorAll('table')];
    const raw = [];
    const details = {}; // ticker → { eps, peBands, priceBands }

    // Row-label patterns for the 5 σ-bands plus median plus NTM EPS
    const labelMap = [
      { key: 'eps',      re: /^ntm\s*eps$/i },
      { key: 'pe_m15',   re: /-\s*1\.5\s*(σ|sigma|std).*(p\/?e|multiple)/i },
      { key: 'pe_m10',   re: /-\s*1(?![.\d])\s*(σ|sigma|std).*(p\/?e|multiple)/i },
      { key: 'pe_med',   re: /median.*(p\/?e|multiple)/i },
      { key: 'pe_p10',   re: /\+?\s*1(?![.\d])\s*(σ|sigma|std).*(p\/?e|multiple)/i },
      { key: 'pe_p15',   re: /\+?\s*1\.5\s*(σ|sigma|std).*(p\/?e|multiple)/i },
      { key: 'price_m15', re: /-\s*1\.5\s*(σ|sigma|std).*(price|share)/i },
      { key: 'price_m10', re: /-\s*1(?![.\d])\s*(σ|sigma|std).*(price|share)/i },
      { key: 'price_med', re: /median.*(price|share)/i },
      { key: 'price_p10', re: /\+?\s*1(?![.\d])\s*(σ|sigma|std).*(price|share)/i },
      { key: 'price_p15', re: /\+?\s*1\.5\s*(σ|sigma|std).*(price|share)/i }
    ];

    tables.forEach((table, tIdx) => {
      const headerCells = [...table.querySelectorAll('thead th, thead td')].map(c => norm(c.textContent));
      const bodyRows = [...table.querySelectorAll('tbody tr')].map(tr =>
        [...tr.querySelectorAll('td, th')].map(td => norm(td.textContent))
      );
      raw.push({ tableIdx: tIdx, headers: headerCells, rowCount: bodyRows.length, sampleRow: bodyRows[0]?.slice(0, 8) });
      // If headers look like tickers, treat this as a per-ticker table
      const tickers = headerCells.slice(1).filter(h => /^[A-Z][A-Z0-9.]{0,6}$/.test(h));
      if (tickers.length >= 5) {
        // Each row is a metric across all tickers
        bodyRows.forEach(row => {
          if (row.length < headerCells.length) return;
          const label = row[0];
          const match = labelMap.find(m => m.re.test(label));
          if (!match) return;
          headerCells.slice(1).forEach((tick, i) => {
            if (!/^[A-Z][A-Z0-9.]{0,6}$/.test(tick)) return;
            const val = num(row[i + 1]);
            if (val == null) return;
            details[tick] = details[tick] || { eps: null, peBands: {}, priceBands: {} };
            if (match.key === 'eps') details[tick].eps = val;
            else if (match.key.startsWith('pe_')) details[tick].peBands[match.key.slice(3)] = val;
            else if (match.key.startsWith('price_')) details[tick].priceBands[match.key.slice(6)] = val;
          });
        });
      }
    });

    return { raw, details, tickerCount: Object.keys(details).length };
  });

  // Step 4: Scrape the Dashboard page for 90-day targets
  console.log('Scraping dashboard page (90-day targets)...');
  await page.goto(config.aj.dashboardUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  const dashboardData = await page.evaluate(() => {
    // The dashboard page has two columns: 12M and 90D targets
    const text = document.body.innerText;
    const tables = document.querySelectorAll('table');
    const result = [];
    tables.forEach(table => {
      const rows = [...table.querySelectorAll('tr')].map(tr =>
        [...tr.querySelectorAll('td, th')].map(td => td.textContent?.trim())
      );
      if (rows.length > 5) {
        result.push(rows);
      }
    });
    return { tableCount: result.length, tables: result, textPreview: text.substring(0, 3000) };
  });

  // Step 5: Take screenshots for reference (Overview + Details)
  console.log('Taking screenshots...');
  await page.goto(config.aj.cockpitUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(__dir, 'data', 'aj-cockpit-screenshot.png'), fullPage: false });

  if (detailsBtn) {
    const detBtn2 = await page.$('text=Details');
    if (detBtn2) await detBtn2.click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join(__dir, 'data', 'aj-details-screenshot.png'), fullPage: true });
  }

  await browser.close();

  // Write raw scraped payload (for debugging + audit)
  const rawOutput = {
    cockpit: cockpitData,
    corridors: corridorData,
    dashboard: dashboardData,
    scrapedAt: new Date().toISOString()
  };
  writeFileSync(join(__dir, 'data', 'aj-raw.json'), JSON.stringify(rawOutput, null, 2));

  // Write structured Details data (5-band multiples + EPS per ticker) if we got it
  const stocks = corridorData?.details || {};
  const tickers = Object.keys(stocks);
  if (tickers.length > 0) {
    const detailsOutput = {
      scrapedAt: new Date().toISOString(),
      date: new Date().toISOString().split('T')[0],
      tickerCount: tickers.length,
      stocks
    };
    writeFileSync(join(__dir, 'data', 'aj-details.json'), JSON.stringify(detailsOutput, null, 2));
    console.log(`\n✓ Wrote pipeline/data/aj-details.json: ${tickers.length} tickers with 5-band multiples`);
    console.log(`  Tickers found: ${tickers.slice(0, 10).join(', ')}${tickers.length > 10 ? '…' : ''}`);
  } else {
    console.log(`\n⚠ Details table not extracted — selectors may need tuning.`);
    console.log(`  Inspect pipeline/data/aj-raw.json ("corridors.raw") to see actual table shapes.`);
    console.log(`  Screenshot: pipeline/data/aj-details-screenshot.png`);
  }

  console.log(`\n✓ Wrote pipeline/data/aj-raw.json`);
  console.log('  Screenshots saved to pipeline/data/aj-*-screenshot.png');
}

main().catch(e => { console.error(e); process.exit(1); });
