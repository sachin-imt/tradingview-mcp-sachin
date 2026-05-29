#!/usr/bin/env node
/**
 * ITC Authentication — one-time setup to save session for automated fetches.
 *
 * Usage: node scripts/itc-auth.js [email]
 * Default email: sachin.imt@gmail.com (override via arg or ITC_EMAIL env var)
 *
 * Flow:
 *   1. Opens ITC login page headlessly
 *   2. Enters your email → ITC emails a confirmation code
 *   3. You paste the code in the terminal
 *   4. Session cookies saved to scripts/.itc-session.json
 *   5. Future runs of itc-fetch.js use that session automatically
 */

import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.join(__dirname, '.itc-session.json');

const email = process.argv[2] || process.env.ITC_EMAIL || 'sachin.imt@gmail.com';

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('ITC Auth — starting headless browser...');

  const browser = await chromium.launch({
    headless: true,
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--ignore-certificate-errors', '--no-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  // Step 1: Load login page
  console.log('Loading login page...');
  await page.goto('https://app.intothecryptoverse.com/authentication/login?returnUrl=%2Ftradfi%2Fstocks', {
    waitUntil: 'networkidle',
    timeout: 30000,
  });

  await sleep(2000);

  // Step 2: Enter email
  console.log(`Entering email: ${email}`);
  await page.fill('input[type="email"]', email);
  await sleep(500);
  await page.click('button[type="submit"]');

  console.log(`\nEmail submitted. ITC is sending a confirmation code to ${email}.`);
  console.log('Check your email inbox now.\n');

  // Wait for the code input field to appear
  let codeInputSelector = null;
  const selectors = ['input[type="text"]', 'input[name="code"]', 'input[autocomplete="one-time-code"]', 'input[inputmode="numeric"]'];

  console.log('Waiting for code entry page...');
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const currentUrl = page.url();
    const pageText = await page.textContent('body').catch(() => '');

    for (const sel of selectors) {
      const el = await page.$(sel).catch(() => null);
      if (el) {
        codeInputSelector = sel;
        break;
      }
    }

    if (codeInputSelector || pageText.includes('code') || pageText.includes('Code') || pageText.includes('verify') || currentUrl.includes('verify') || currentUrl.includes('code') || currentUrl.includes('otp')) {
      console.log('Code entry page detected.');
      break;
    }

    // Check if we're already logged in (redirect to stocks)
    if (currentUrl.includes('/tradfi/stocks') || currentUrl.includes('/dashboard')) {
      console.log('Already logged in! URL:', currentUrl);
      await saveSession(context, page, browser);
      return;
    }

    process.stdout.write('.');
  }

  // Take screenshot to verify state
  await page.screenshot({ path: '/tmp/itc-after-email.png' });

  // Step 3: Get OTP from user
  const otp = await prompt('\nPaste the confirmation code from your email: ');

  if (!otp || otp.length < 4) {
    console.error('Invalid code entered. Aborting.');
    await browser.close();
    process.exit(1);
  }

  // Step 4: Enter OTP
  console.log('Entering confirmation code...');

  // Try to fill the OTP
  if (codeInputSelector) {
    await page.fill(codeInputSelector, otp);
  } else {
    // Try all text inputs
    const inputs = await page.$$('input');
    for (const input of inputs) {
      const type = await input.getAttribute('type').catch(() => '');
      if (type !== 'email' && type !== 'hidden') {
        await input.fill(otp);
        break;
      }
    }
  }

  await sleep(500);

  // Submit
  const submitted = await page.evaluate((code) => {
    // Try clicking submit button
    const submitBtn = document.querySelector('button[type="submit"]') ||
                      document.querySelector('button:not([type="button"])') ||
                      Array.from(document.querySelectorAll('button')).find(b => /submit|verify|confirm|continue|log.?in/i.test(b.textContent));
    if (submitBtn) { submitBtn.click(); return true; }
    return false;
  }, otp);

  if (!submitted) {
    await page.keyboard.press('Enter');
  }

  console.log('Code submitted. Waiting for login...');
  await sleep(4000);

  // Wait for redirect to authenticated page
  let authenticated = false;
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const url = page.url();
    if (!url.includes('/authentication/') && !url.includes('/login')) {
      authenticated = true;
      console.log('Authenticated! Redirected to:', url);
      break;
    }

    // Navigate directly to stocks page and see if we have access
    if (i === 7) {
      await page.goto('https://app.intothecryptoverse.com/tradfi/stocks', {
        waitUntil: 'networkidle',
        timeout: 20000,
      }).catch(() => {});
      const url2 = page.url();
      if (!url2.includes('/authentication/') && !url2.includes('/login')) {
        authenticated = true;
        break;
      }
    }
  }

  if (!authenticated) {
    await page.screenshot({ path: '/tmp/itc-auth-failed.png' });
    console.error('Authentication failed. Check /tmp/itc-auth-failed.png for details.');
    await browser.close();
    process.exit(1);
  }

  await saveSession(context, page, browser);
}

async function saveSession(context, page, browser) {
  // Navigate to stocks to trigger data load
  const currentUrl = page.url();
  if (!currentUrl.includes('/tradfi/stocks')) {
    await page.goto('https://app.intothecryptoverse.com/tradfi/stocks', {
      waitUntil: 'networkidle',
      timeout: 20000,
    }).catch(() => {});
  }

  await new Promise(r => setTimeout(r, 3000));

  const cookies = await context.cookies();
  const localStorage = await page.evaluate(() => {
    const data = {};
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      data[key] = window.localStorage.getItem(key);
    }
    return data;
  }).catch(() => ({}));

  const session = {
    email: process.argv[2] || process.env.ITC_EMAIL || 'sachin.imt@gmail.com',
    savedAt: new Date().toISOString(),
    cookies,
    localStorage,
  };

  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));

  console.log(`\n✓ Session saved to ${SESSION_FILE}`);
  console.log(`  Email: ${session.email}`);
  console.log(`  Cookies: ${cookies.length}`);
  console.log(`  localStorage keys: ${Object.keys(localStorage).length}`);
  console.log('\nYou can now run: node scripts/itc-fetch.js');

  await browser.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
