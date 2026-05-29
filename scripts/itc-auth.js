#!/usr/bin/env node
/**
 * ITC Authentication — one-time setup using file-based OTP handoff.
 *
 * Designed to be driven by Claude Code:
 *   1. Claude runs this script in the background
 *   2. Script submits your email to ITC and writes /tmp/.itc-otp-ready
 *   3. Claude sees the ready signal and asks you for the OTP from your email
 *   4. You paste the OTP in chat → Claude writes it to /tmp/.itc-otp
 *   5. Script reads the OTP, completes login, saves session
 *
 * Can also be run manually: node scripts/itc-auth.js
 *   (falls back to stdin if /tmp/.itc-otp-ready doesn't exist within 5s)
 *
 * Session saved to: scripts/.itc-session.json
 */

import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.join(__dirname, '.itc-session.json');
const OTP_READY_FILE = '/tmp/.itc-otp-ready';
const OTP_FILE = '/tmp/.itc-otp';
const STATUS_FILE = '/tmp/.itc-auth-status';

const email = process.argv[2] || process.env.ITC_EMAIL || 'sachin.imt@gmail.com';

function writeStatus(msg) {
  fs.writeFileSync(STATUS_FILE, msg);
  console.log(msg);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForOtp() {
  // Signal that we're waiting for OTP
  fs.writeFileSync(OTP_READY_FILE, new Date().toISOString());
  writeStatus(`WAITING_FOR_OTP:${email}`);

  // Poll for OTP file (written by Claude when user provides the code)
  for (let i = 0; i < 300; i++) { // 5 minutes max
    await sleep(1000);
    if (fs.existsSync(OTP_FILE)) {
      const otp = fs.readFileSync(OTP_FILE, 'utf8').trim();
      fs.unlinkSync(OTP_FILE);
      if (otp.length >= 4) {
        console.log('OTP received from file.');
        return otp;
      }
    }
  }

  // Fallback: try stdin (for manual runs)
  console.log('Timeout waiting for OTP file. Trying stdin...');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('Paste the OTP code: ', answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  // Clean up any stale signal files
  [OTP_READY_FILE, OTP_FILE].forEach(f => { try { fs.unlinkSync(f); } catch {} });

  writeStatus('STARTING');
  console.log(`ITC Auth — email: ${email}`);

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
  writeStatus('LOADING_LOGIN_PAGE');
  await page.goto('https://app.intothecryptoverse.com/authentication/login?returnUrl=%2Ftradfi%2Fstocks', {
    waitUntil: 'networkidle',
    timeout: 30000,
  });
  await sleep(2000);

  // Check if already authenticated
  const initialUrl = page.url();
  if (!initialUrl.includes('/authentication/') && !initialUrl.includes('/login')) {
    writeStatus('ALREADY_AUTHENTICATED');
    console.log('Already logged in! URL:', initialUrl);
    await saveSession(context, page, browser);
    return;
  }

  // Step 2: Enter email and submit
  writeStatus('SUBMITTING_EMAIL');
  console.log('Entering email...');
  await page.fill('input[type="email"]', email);
  await sleep(300);
  await page.click('button[type="submit"]');
  await sleep(3000);

  await page.screenshot({ path: '/tmp/itc-after-email.png' });

  // Check if redirected to code entry page
  const afterEmailUrl = page.url();
  const pageText = await page.textContent('body').catch(() => '');
  const hasCodePage = afterEmailUrl.includes('code') || afterEmailUrl.includes('verify') ||
                      pageText.toLowerCase().includes('confirmation code') ||
                      pageText.toLowerCase().includes('check your email') ||
                      pageText.toLowerCase().includes('enter the code') ||
                      await page.$('input[type="text"]').then(el => !!el).catch(() => false);

  if (!hasCodePage) {
    // Wait a bit longer for the page to transition
    for (let i = 0; i < 10; i++) {
      await sleep(1000);
      const url = page.url();
      if (url.includes('code') || url.includes('verify') || url !== afterEmailUrl) break;
    }
  }

  await page.screenshot({ path: '/tmp/itc-code-page.png' });
  console.log('Email submitted. Current URL:', page.url());

  // Step 3: Wait for OTP from user (via file handoff)
  const otp = await waitForOtp();

  if (!otp || otp.length < 4) {
    writeStatus('ERROR:invalid_otp');
    await browser.close();
    process.exit(1);
  }

  // Step 4: Enter OTP on the page
  writeStatus('SUBMITTING_OTP');
  console.log('Submitting OTP...');

  // Detect split-digit boxes (6 individual inputs) vs single input
  const numericInputs = await page.$$('input[inputmode="numeric"]');
  const textInputs = await page.$$('input[type="text"]');
  const allCodeInputs = numericInputs.length > 0 ? numericInputs : textInputs;

  if (allCodeInputs.length > 1) {
    // Split-digit boxes — type one digit per box
    console.log(`Split-digit OTP input (${allCodeInputs.length} boxes), typing digit by digit...`);
    await allCodeInputs[0].click();
    await sleep(200);
    for (let i = 0; i < Math.min(otp.length, allCodeInputs.length); i++) {
      await allCodeInputs[i].click();
      await allCodeInputs[i].type(otp[i]);
      await sleep(100);
    }
  } else if (allCodeInputs.length === 1) {
    console.log('Single OTP input, filling...');
    await allCodeInputs[0].click();
    await page.keyboard.type(otp);
  } else {
    // Fallback: focus first input and type
    console.log('Fallback: typing OTP via keyboard...');
    await page.keyboard.type(otp);
  }
  console.log('OTP digits entered.');

  await sleep(500);

  // Submit
  const submitted = await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"]') ||
                Array.from(document.querySelectorAll('button')).find(b =>
                  /submit|verify|confirm|continue|log.?in/i.test(b.textContent));
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (!submitted) await page.keyboard.press('Enter');

  console.log('OTP submitted. Waiting for redirect...');
  await sleep(4000);

  // Step 5: Confirm authenticated
  let authenticated = false;
  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    const url = page.url();
    if (!url.includes('/authentication/') && !url.includes('/login')) {
      authenticated = true;
      console.log('Authenticated! URL:', url);
      break;
    }
    // Try navigating directly
    if (i === 8) {
      await page.goto('https://app.intothecryptoverse.com/tradfi/stocks', {
        waitUntil: 'networkidle', timeout: 20000,
      }).catch(() => {});
      const u = page.url();
      if (!u.includes('/authentication/') && !u.includes('/login')) {
        authenticated = true;
        break;
      }
    }
  }

  if (!authenticated) {
    await page.screenshot({ path: '/tmp/itc-auth-failed.png' });
    writeStatus('ERROR:auth_failed');
    console.error('Auth failed. Screenshot: /tmp/itc-auth-failed.png');
    await browser.close();
    process.exit(1);
  }

  await saveSession(context, page, browser);
}

async function saveSession(context, page, browser) {
  writeStatus('SAVING_SESSION');

  if (!page.url().includes('/tradfi/stocks')) {
    await page.goto('https://app.intothecryptoverse.com/tradfi/stocks', {
      waitUntil: 'networkidle', timeout: 20000,
    }).catch(() => {});
  }
  await sleep(3000);

  const cookies = await context.cookies();
  const localStorage = await page.evaluate(() => {
    const data = {};
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      data[key] = window.localStorage.getItem(key);
    }
    return data;
  }).catch(() => ({}));

  const session = { email, savedAt: new Date().toISOString(), cookies, localStorage };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));

  // Clean up signal files
  [OTP_READY_FILE, OTP_FILE].forEach(f => { try { fs.unlinkSync(f); } catch {} });

  writeStatus('DONE');
  console.log(`\n✓ Session saved: ${cookies.length} cookies, ${Object.keys(localStorage).length} localStorage keys`);
  console.log('Morning brief will now fetch ITC data automatically.');

  await browser.close();
}

main().catch(err => {
  writeStatus(`ERROR:${err.message}`);
  console.error('Fatal:', err.message);
  process.exit(1);
});
