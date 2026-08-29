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
    await page.waitForTimeout(2000);
  }

  // Extract the corridor band table
  const corridorData = await page.evaluate(() => {
    const tables = document.querySelectorAll('table');
    const result = [];
    tables.forEach(table => {
      const headers = [...table.querySelectorAll('th')].map(th => th.textContent?.trim());
      const rows = [...table.querySelectorAll('tbody tr')].map(tr =>
        [...tr.querySelectorAll('td')].map(td => td.textContent?.trim())
      );
      if (headers.length > 5) {
        result.push({ headers, rows });
      }
    });

    // Also try reading from the rendered chart/data layer
    // The Details view has a table with columns per stock
    // Try to find it by looking for elements with price-like content
    const allText = document.body.innerText;
    const currencies = [];
    const priceRows = {};

    // Look for the "Corridor Bands Implied Share Prices" section
    const section = document.querySelector('[class*="corridor"], [id*="corridor"]');
    if (section) {
      const sectionText = section.innerText;
      result.push({ type: 'corridor-section', text: sectionText.substring(0, 2000) });
    }

    return result;
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

  // Step 5: Take screenshots for reference
  console.log('Taking screenshots...');
  await page.goto(config.aj.cockpitUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(__dir, 'data', 'aj-cockpit-screenshot.png'), fullPage: false });

  if (detailsBtn) {
    const detBtn2 = await page.$('text=Details');
    if (detBtn2) await detBtn2.click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: join(__dir, 'data', 'aj-details-screenshot.png'), fullPage: true });
  }

  await browser.close();

  // Write raw scraped data
  const output = {
    cockpit: cockpitData,
    corridors: corridorData,
    dashboard: dashboardData,
    scrapedAt: new Date().toISOString()
  };
  writeFileSync(join(__dir, 'data', 'aj-raw.json'), JSON.stringify(output, null, 2));
  console.log(`\n✓ Wrote pipeline/data/aj-raw.json`);
  console.log('  Review the raw data and update config.json corridor/cockpit values as needed.');
  console.log('  Screenshots saved to pipeline/data/aj-*-screenshot.png');
}

main().catch(e => { console.error(e); process.exit(1); });
