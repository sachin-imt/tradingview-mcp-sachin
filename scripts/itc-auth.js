#!/usr/bin/env node
/**
 * ITC Authentication — saves a full browser profile (cookies + IndexedDB) for persistent login.
 *
 * Uses Playwright's launchPersistentContext so ALL browser state (including IndexedDB auth
 * tokens) is stored to disk automatically. The fetch script reuses the same profile directory
 * so it's always authenticated without needing to log in again.
 *
 * Driven by Claude Code via file-based OTP handoff:
 *   1. Claude runs this in background
 *   2. Script submits email, writes /tmp/.itc-otp-ready
 *   3. Claude asks you for the OTP from your email
 *   4. You paste it in chat → Claude writes to /tmp/.itc-otp
 *   5. Script enters OTP, saves profile, done
 *
 * Profile saved to: scripts/.itc-profile/  (gitignored)
 * Future fetches: itc-fetch.js reuses this profile — no login needed.
 */

import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROFILE_DIR = path.join(__dirname, '.itc-profile');
const OTP_READY_FILE = '/tmp/.itc-otp-ready';
const OTP_FILE = '/tmp/.itc-otp';
const STATUS_FILE = '/tmp/.itc-auth-status';

const email = process.argv[2] || process.env.ITC_EMAIL || 'sachin.imt@gmail.com';

function writeStatus(msg) {
  fs.writeFileSync(STATUS_FILE, msg);
  console.log(msg);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForOtp() {
  fs.writeFileSync(OTP_READY_FILE, new Date().toISOString());
  writeStatus(`WAITING_FOR_OTP:${email}`);
  console.log(`Waiting for OTP — Claude will write it to ${OTP_FILE} when you provide it.`);

  for (let i = 0; i < 300; i++) {
    await sleep(1000);
    if (fs.existsSync(OTP_FILE)) {
      const otp = fs.readFileSync(OTP_FILE, 'utf8').trim();
      fs.unlinkSync(OTP_FILE);
      if (otp.length >= 4) { console.log('OTP received.'); return otp; }
    }
  }
  throw new Error('Timeout waiting for OTP (5 minutes exceeded)');
}

async function main() {
  [OTP_READY_FILE, OTP_FILE].forEach(f => { try { fs.unlinkSync(f); } catch {} });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  writeStatus('STARTING');
  console.log(`ITC Auth — profile: ${PROFILE_DIR}`);
  console.log(`Email: ${email}`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--ignore-certificate-errors', '--no-sandbox', '--disable-dev-shm-usage'],
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = context.pages()[0] || await context.newPage();

  // Check if already authenticated
  writeStatus('CHECKING_AUTH');
  await page.goto('https://app.intothecryptoverse.com/tradfi/stocks', {
    waitUntil: 'networkidle', timeout: 30000,
  });
  await sleep(2000);

  if (!page.url().includes('/authentication/') && !page.url().includes('/login')) {
    writeStatus('ALREADY_AUTHENTICATED');
    console.log('Already authenticated! URL:', page.url());
    await context.close();
    return;
  }

  // Submit email
  writeStatus('SUBMITTING_EMAIL');
  await page.goto('https://app.intothecryptoverse.com/authentication/login?returnUrl=%2Ftradfi%2Fstocks', {
    waitUntil: 'networkidle', timeout: 30000,
  });
  await sleep(1500);
  await page.fill('input[type="email"]', email);
  await sleep(300);
  await page.click('button[type="submit"]');
  await sleep(3000);

  await page.screenshot({ path: '/tmp/itc-code-page.png' });
  console.log('After email submit, URL:', page.url());

  // Wait for OTP from Claude/user
  const otp = await waitForOtp();

  // Enter OTP — 6 split-digit boxes
  writeStatus('SUBMITTING_OTP');
  console.log('Entering OTP...');

  const numericInputs = await page.$$('input[inputmode="numeric"]');
  const textInputs = await page.$$('input[type="text"]');
  const codeInputs = numericInputs.length > 0 ? numericInputs : textInputs;

  if (codeInputs.length > 1) {
    console.log(`Split-digit boxes (${codeInputs.length}), entering digit by digit...`);
    for (let i = 0; i < Math.min(otp.length, codeInputs.length); i++) {
      await codeInputs[i].click();
      await codeInputs[i].type(otp[i]);
      await sleep(80);
    }
  } else if (codeInputs.length === 1) {
    await codeInputs[0].click();
    await page.keyboard.type(otp);
  } else {
    await page.keyboard.type(otp);
  }

  await sleep(400);

  // Click Verify button
  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"]') ||
      Array.from(document.querySelectorAll('button')).find(b => /verify|confirm|continue|log.?in/i.test(b.textContent));
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (!clicked) await page.keyboard.press('Enter');

  console.log('OTP submitted, waiting for redirect...');
  await sleep(4000);

  // Confirm authenticated
  let authenticated = false;
  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    const url = page.url();
    if (!url.includes('/authentication/') && !url.includes('/login')) {
      authenticated = true;
      console.log('Authenticated! URL:', url);
      break;
    }
    if (i === 8) {
      await page.goto('https://app.intothecryptoverse.com/tradfi/stocks', {
        waitUntil: 'networkidle', timeout: 20000,
      }).catch(() => {});
      if (!page.url().includes('/authentication/') && !page.url().includes('/login')) {
        authenticated = true; break;
      }
    }
  }

  if (!authenticated) {
    await page.screenshot({ path: '/tmp/itc-auth-failed.png' });
    writeStatus('ERROR:auth_failed');
    console.error('Auth failed. Screenshot: /tmp/itc-auth-failed.png');
    await context.close();
    process.exit(1);
  }

  // Navigate to stocks to warm up profile
  if (!page.url().includes('/tradfi/stocks')) {
    await page.goto('https://app.intothecryptoverse.com/tradfi/stocks', {
      waitUntil: 'networkidle', timeout: 20000,
    }).catch(() => {});
  }
  await sleep(3000);

  [OTP_READY_FILE, OTP_FILE].forEach(f => { try { fs.unlinkSync(f); } catch {} });
  writeStatus('DONE');
  console.log('\n✓ Session profile saved to:', PROFILE_DIR);
  console.log('Run: node scripts/itc-fetch.js');

  await context.close();
}

main().catch(err => {
  writeStatus(`ERROR:${err.message}`);
  console.error('Fatal:', err.message);
  process.exit(1);
});
