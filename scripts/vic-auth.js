#!/usr/bin/env node
/**
 * VIC (valueinvestorsclub.com) Authentication — one-time login saved to the shared
 * persistent browser profile (scripts/.itc-profile/, same profile as ITC).
 *
 * Driven by Claude Code via file-based credential handoff:
 *   1. Claude runs this in background
 *   2. Script opens the VIC login page, writes /tmp/.vic-creds-ready
 *   3. User provides VIC username + password in chat
 *   4. Claude writes JSON {"user": "...", "pass": "..."} to /tmp/.vic-creds
 *   5. Script logs in, deletes the creds file, saves session to profile
 *
 * Future fetches: vic-fetch.js reuses the profile — no login needed.
 */

import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(__dirname, '.itc-profile');
const CREDS_READY_FILE = '/tmp/.vic-creds-ready';
const CREDS_FILE = '/tmp/.vic-creds';
const STATUS_FILE = '/tmp/.vic-auth-status';

function writeStatus(msg) {
  fs.writeFileSync(STATUS_FILE, msg);
  console.log(msg);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForCreds() {
  fs.writeFileSync(CREDS_READY_FILE, new Date().toISOString());
  writeStatus('WAITING_FOR_CREDS');
  for (let i = 0; i < 300; i++) {
    await sleep(1000);
    if (fs.existsSync(CREDS_FILE)) {
      const raw = fs.readFileSync(CREDS_FILE, 'utf8').trim();
      fs.unlinkSync(CREDS_FILE); // delete immediately — never leave creds on disk
      try {
        const creds = JSON.parse(raw);
        if (creds.user && creds.pass) return creds;
      } catch {}
      writeStatus('ERROR:bad_creds_format');
      throw new Error('Credentials file was not valid JSON {user, pass}');
    }
  }
  throw new Error('Timeout waiting for credentials (5 minutes exceeded)');
}

async function main() {
  [CREDS_READY_FILE, CREDS_FILE].forEach(f => { try { fs.unlinkSync(f); } catch {} });

  writeStatus('STARTING');
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
  await page.goto('https://www.valueinvestorsclub.com/', { waitUntil: 'load', timeout: 30000 });
  await sleep(3000);

  const alreadyIn = await page.evaluate(() =>
    /log\s?out|sign\s?out/i.test(document.body.innerText) ||
    !/log\s?in here/i.test(document.body.innerText)
  );
  if (alreadyIn) {
    writeStatus('ALREADY_AUTHENTICATED');
    await context.close();
    return;
  }

  const creds = await waitForCreds();

  writeStatus('SUBMITTING_LOGIN');
  await page.goto('https://www.valueinvestorsclub.com/login', { waitUntil: 'load', timeout: 30000 });
  await sleep(2000);

  // VIC login form: username/email + password
  const userInput = await page.$('input[name="login"], input[name="username"], input[name="email"], input[type="text"], input[type="email"]');
  const passInput = await page.$('input[type="password"]');
  if (!userInput || !passInput) {
    await page.screenshot({ path: '/tmp/vic-login-page.png' });
    writeStatus('ERROR:login_form_not_found');
    await context.close();
    process.exit(1);
  }

  await userInput.fill(creds.user);
  await sleep(300);
  await passInput.fill(creds.pass);
  await sleep(300);

  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"], input[type="submit"]') ||
      Array.from(document.querySelectorAll('button, a')).find(b => /^log\s?in$|^sign\s?in$/i.test(b.textContent.trim()));
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (!clicked) await page.keyboard.press('Enter');

  await sleep(5000);

  // Verify: logged-in pages show Logout / member nav and stop showing "Log in here"
  let authenticated = false;
  for (let i = 0; i < 10; i++) {
    const ok = await page.evaluate(() =>
      /log\s?out|sign\s?out/i.test(document.body.innerText) ||
      !/log\s?in here|password/i.test(document.body.innerText)
    );
    if (ok) { authenticated = true; break; }
    await sleep(2000);
  }

  if (!authenticated) {
    await page.screenshot({ path: '/tmp/vic-auth-failed.png' });
    writeStatus('ERROR:auth_failed');
    console.error('Login failed. Screenshot: /tmp/vic-auth-failed.png');
    await context.close();
    process.exit(1);
  }

  writeStatus('DONE');
  console.log('\n✓ VIC session saved to shared profile:', PROFILE_DIR);
  console.log('Run: node scripts/vic-fetch.js <TICKER>');
  await context.close();
}

main().catch(err => {
  writeStatus(`ERROR:${err.message}`);
  console.error('Fatal:', err.message);
  process.exit(1);
});
