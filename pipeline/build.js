#!/usr/bin/env node
/**
 * Build the dashboard HTML by injecting data from pipeline/data/ + config.json
 * into the template. Outputs to docs/index.html for GitHub Pages.
 *
 * Usage: node pipeline/build.js
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..');
const templatePath = join(root, 'sachins-dashboard.html');
const outPath = join(root, 'docs', 'index.html');

const configPath = join(__dir, 'config.json');
const pricesPath = join(__dir, 'data', 'prices.json');
const snapPath = join(__dir, 'data', 'snapshots.json');

function main() {
  if (!existsSync(templatePath)) {
    console.error(`Template not found: ${templatePath}`);
    process.exit(1);
  }

  let html = readFileSync(templatePath, 'utf8');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));

  // Inject STOCKS array from config
  const stocksJs = JSON.stringify(config.stocks);
  html = html.replace(
    /const STOCKS=\[[\s\S]*?\];/,
    `const STOCKS=${stocksJs};`
  );

  // Inject C (corridors) object from config
  const corrLines = Object.entries(config.corridors)
    .map(([k, v]) => `  ${k}:${JSON.stringify(v)}`)
    .join(',\n');
  html = html.replace(
    /const C=\{[\s\S]*?\};/,
    `const C={\n${corrLines}\n};`
  );

  // Inject CORR_META from config
  const metaLines = Object.entries(config.corrMeta)
    .map(([k, v]) => `  ${k}:${JSON.stringify(v)}`)
    .join(',\n');
  html = html.replace(
    /const CORR_META=\{[\s\S]*?\};/,
    `const CORR_META={\n${metaLines}\n};`
  );

  // Inject prices if available
  if (existsSync(pricesPath)) {
    const priceData = JSON.parse(readFileSync(pricesPath, 'utf8'));
    const datesJs = JSON.stringify(priceData.dates);
    html = html.replace(
      /const DATES=\[[\s\S]*?\];/,
      `const DATES=${datesJs};`
    );

    const priceLines = Object.entries(priceData.prices)
      .map(([k, v]) => `  ${k}:${JSON.stringify(v)}`)
      .join(',\n');
    html = html.replace(
      /const P=\{[\s\S]*?\};/,
      `const P={\n${priceLines}\n};`
    );

    console.log(`Injected ${priceData.dates.length} days of price data`);
  }

  // Inject snapshots if available
  if (existsSync(snapPath)) {
    const snapData = JSON.parse(readFileSync(snapPath, 'utf8'));
    const snapDatesJs = JSON.stringify(snapData.dates);
    html = html.replace(
      /const SNAP_DATES=\[[\s\S]*?\];/,
      `const SNAP_DATES=${snapDatesJs};`
    );

    const snapLines = Object.entries(snapData.snapshots)
      .map(([k, v]) => `  ${k}:${JSON.stringify(v)}`)
      .join(',\n');
    html = html.replace(
      /const SNAP=\{[\s\S]*?\};/,
      `const SNAP={\n${snapLines}\n};`
    );

    console.log(`Injected ${snapData.dates.length} snapshots`);
  }

  // Strip artifact frame-runtime wrapper if present (from Claude artifact export)
  html = html.replace(/<!-- frame-runtime -->.*?<!-- \/frame-runtime -->/s, '');
  html = html.replace(/<base href="[^"]*">\s*/, '');

  // Update the "LIVE" date badge
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
  html = html.replace(/LIVE [A-Z]{3} \d+/i, `LIVE ${dateStr}`);

  writeFileSync(outPath, html);
  console.log(`\n✓ Built dashboard → ${outPath}`);
  console.log('  Serve docs/ via GitHub Pages or any static host.');
}

main();
