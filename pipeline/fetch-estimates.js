#!/usr/bin/env node
/**
 * Pull consensus earnings data from Finnhub and record it. This script does NOT
 * change the corridor — it only observes.
 *
 * The cutover rule is deliberate: AJ's estimates stay live until a company
 * actually reports, because a report is the event that invalidates his number.
 * Until then his estimate is the better input and we keep it. apply-estimates.js
 * reads what we record here and flips a name to consensus only once its
 * lastReport date is newer than the asOf date on AJ's estimate.
 *
 * Rolling NTM, not forward-fiscal-year. Finnhub's metric.forwardPE points at the
 * next fiscal YEAR, so the horizon it covers shrinks as the year progresses and
 * snaps back when the FY rolls — that sawtooth would move the corridor with no
 * underlying news. We therefore sum discrete forward quarters instead.
 *
 * Needs FINNHUB_KEY in .env or the environment.
 * Usage: node pipeline/fetch-estimates.js [--verbose]
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..');
const outPath = join(__dir, 'data', 'estimates.json');
const VERBOSE = process.argv.includes('--verbose');

function loadKey() {
  if (process.env.FINNHUB_KEY) return process.env.FINNHUB_KEY;
  const envFile = join(root, '.env');
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0 && line.slice(0, i).trim() === 'FINNHUB_KEY') return line.slice(i + 1).trim();
    }
  }
  return null;
}

const KEY = loadKey();
if (!KEY) {
  console.error('FINNHUB_KEY not found in .env or environment.');
  console.error('Add it with:  printf "FINNHUB_KEY=%s\\n" \'<key>\' >> .env');
  process.exit(1);
}

const config = JSON.parse(readFileSync(join(__dir, 'config.json'), 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const iso = d => d.toISOString().slice(0, 10);

async function fh(path, params) {
  const qs = new URLSearchParams({ ...params, token: KEY });
  const res = await fetch(`https://finnhub.io/api/v1/${path}?${qs}`);
  if (res.status === 429) { await sleep(2500); return fh(path, params); }
  const body = await res.text();
  // The free tier answers premium endpoints with a marketing HTML page rather
  // than a 4xx, so treat any HTML response as "not available on this plan".
  if (body.trimStart().startsWith('<')) return { premium: true };
  if (!res.ok) return { error: `HTTP ${res.status}` };
  try { return { data: JSON.parse(body) }; } catch { return { error: 'bad JSON' }; }
}

/** Sum the next four forward fiscal quarters into a rolling NTM figure. */
function buildNtm(forward) {
  const q = forward.filter(e => e.epsEstimate != null).sort((a, b) => a.date < b.date ? -1 : 1);
  if (!q.length) return null;
  const use = q.slice(0, 4);
  const sum = use.reduce((s, e) => s + e.epsEstimate, 0);
  // The free tier usually returns three forward quarters, not four. Scaling a
  // three-quarter sum to a four-quarter year is an approximation, so it gets
  // flagged and the dashboard can show it as such rather than implying precision.
  const approx = use.length < 4;
  return {
    eps: Math.round((approx ? sum * 4 / use.length : sum) * 10000) / 10000,
    quarters: use.length,
    approx,
    periods: use.map(e => `${e.year}Q${e.quarter}`),
    nextReport: q[0]?.date || null
  };
}

async function main() {
  const out = {};
  const notes = [];
  console.log(`Fetching consensus for ${config.stocks.length} stocks...\n`);

  for (const s of config.stocks) {
    const rec = { ticker: s.t, ajEps: config.corridors[s.t]?.eps ?? null };
    let symbol = null;

    // Finnhub keys US listings off the plain ticker; try ours first, then Yahoo's.
    for (const cand of [...new Set([s.t, s.yahoo])]) {
      const r = await fh('stock/earnings', { symbol: cand });
      await sleep(1100);
      if (r.data && Array.isArray(r.data) && r.data.length) {
        symbol = cand;
        const hist = r.data.sort((a, b) => a.period < b.period ? 1 : -1);
        rec.lastReport = hist[0]?.period ?? null;
        rec.lastActual = hist[0]?.actual ?? null;
        rec.history = hist.slice(0, 8).map(h => ({ period: h.period, actual: h.actual, est: h.estimate }));
        break;
      }
    }

    if (!symbol) {
      rec.status = 'no-coverage';
      notes.push(`${s.t}: no Finnhub coverage`);
      out[s.t] = rec;
      console.log(`  ✗ ${s.t.padEnd(6)} no coverage`);
      continue;
    }
    rec.symbol = symbol;

    const from = iso(new Date());
    const to = iso(new Date(Date.now() + 800 * 864e5));
    const cal = await fh('calendar/earnings', { symbol, from, to });
    await sleep(1100);
    const ntm = cal.data ? buildNtm(cal.data.earningsCalendar || []) : null;

    if (ntm) {
      rec.consensusNtm = ntm.eps;
      rec.quarters = ntm.quarters;
      rec.approx = ntm.approx;
      rec.periods = ntm.periods;
      rec.nextReport = ntm.nextReport;
      rec.status = 'ok';
      const d = rec.ajEps ? ((ntm.eps - rec.ajEps) / rec.ajEps * 100) : null;
      rec.vsAj = d == null ? null : Math.round(d * 10) / 10;
      console.log(`  ✓ ${s.t.padEnd(6)} NTM ${String(ntm.eps).padStart(8)}` +
        `${ntm.approx ? '~' : ' '} (${ntm.quarters}q)  AJ ${String(rec.ajEps ?? '—').padStart(7)}` +
        `  ${d == null ? '' : (d >= 0 ? '+' : '') + d.toFixed(0) + '%'}` +
        `  next ${rec.nextReport ?? '—'}`);
    } else {
      rec.status = 'no-forward';
      notes.push(`${s.t}: history but no forward estimates`);
      console.log(`  ~ ${s.t.padEnd(6)} history only, no forward estimates`);
    }
    out[s.t] = rec;
  }

  const okCount = Object.values(out).filter(r => r.status === 'ok').length;
  writeFileSync(outPath, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    source: 'finnhub-free',
    note: 'Observational only. apply-estimates.js decides when a name switches off AJ.',
    coverage: `${okCount}/${config.stocks.length}`,
    estimates: out
  }, null, 2) + '\n');

  console.log(`\n✓ ${okCount}/${config.stocks.length} with forward consensus → ${outPath}`);
  if (notes.length) console.log('  ' + notes.join('\n  '));
}

main();
