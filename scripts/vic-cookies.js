#!/usr/bin/env node
/**
 * VIC Cookie Import — injects session cookies copied from the user's own browser
 * into the shared persistent profile, bypassing the Cloudflare-gated login form.
 *
 * Why: VIC's login page uses Cloudflare Turnstile, which rejects requests from
 * datacenter IPs regardless of how the browser is driven. Importing an existing
 * session avoids the login form entirely.
 *
 * Usage:
 *   1. In your own logged-in browser: DevTools → Application → Cookies → valueinvestorsclub.com
 *   2. Write cookies to /tmp/.vic-cookies as either:
 *        "name1=value1; name2=value2"        (cookie-header style)
 *      or JSON: [{"name": "...", "value": "..."}, ...]
 *   3. node scripts/vic-cookies.js
 *
 * The file is deleted immediately after reading. Verifies login state afterwards.
 */

import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(__dirname, '.itc-profile');
const COOKIES_FILE = '/tmp/.vic-cookies';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseCookies(raw) {
  raw = raw.trim();
  if (raw.startsWith('[') || raw.startsWith('{')) {
    const arr = JSON.parse(raw);
    return (Array.isArray(arr) ? arr : [arr]).map(c => ({ name: c.name, value: c.value }));
  }
  // "name=value; name2=value2" style
  return raw.split(/;\s*/).filter(Boolean).map(pair => {
    const eq = pair.indexOf('=');
    return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() };
  }).filter(c => c.name && c.value);
}

async function main() {
  if (!fs.existsSync(COOKIES_FILE)) {
    console.error(`No cookies file at ${COOKIES_FILE}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(COOKIES_FILE, 'utf8');
  fs.unlinkSync(COOKIES_FILE); // never leave session cookies on disk

  const cookies = parseCookies(raw).map(c => ({
    ...c,
    domain: '.valueinvestorsclub.com',
    path: '/',
    secure: true,
    httpOnly: false,
    sameSite: 'Lax',
    expires: Math.floor(Date.now() / 1000) + 180 * 24 * 3600, // 180 days
  }));

  if (cookies.length === 0) {
    console.error('No cookies parsed from input');
    process.exit(1);
  }
  console.log(`Parsed ${cookies.length} cookies: ${cookies.map(c => c.name).join(', ')}`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--ignore-certificate-errors', '--no-sandbox', '--disable-dev-shm-usage'],
    ignoreHTTPSErrors: true,
  });

  await context.addCookies(cookies);

  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://www.valueinvestorsclub.com/', { waitUntil: 'load', timeout: 30000 });
  await sleep(4000);

  const state = await page.evaluate(() => ({
    loggedIn: /log\s?out|sign\s?out/i.test(document.body.innerText) ||
              !/log in here/i.test(document.body.innerText),
    snippet: document.body.innerText.slice(0, 200).replace(/\n+/g, ' '),
  }));

  await page.screenshot({ path: '/tmp/vic-cookie-check.png' });
  await context.close();

  if (state.loggedIn) {
    console.log('✓ VIC session imported and verified. Profile:', PROFILE_DIR);
    console.log('Run: node scripts/vic-fetch.js <TICKER>');
  } else {
    console.error('✗ Cookies imported but session not recognized. Screenshot: /tmp/vic-cookie-check.png');
    console.error('Page said:', state.snippet);
    process.exit(1);
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
