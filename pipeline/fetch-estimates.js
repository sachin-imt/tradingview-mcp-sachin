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

/**
 * Sum the next four forward fiscal quarters into a rolling NTM figure.
 *
 * The free tier publishes three forward quarters, not four, so the fourth has
 * to be derived. Two candidate methods:
 *
 *   year-over-year — grow the same fiscal quarter from last year's actual.
 *     Rejected: it disintegrates through a cycle. Micron's forward quarters
 *     imply YoY growth of 10.6x, then 7.5x, then 3.2x, so the derived quarter
 *     lands anywhere between 80 and 188 depending which ratio you pick.
 *
 *   sequential — extrapolate the quarter-on-quarter progression of the forward
 *     estimates themselves. Chosen: analysts build those three as a coherent
 *     series, so the step between them is far steadier than the YoY ratio
 *     (Micron: +11%, +8%). We take the geometric mean of the observed steps and
 *     clamp it, so one odd quarter cannot compound into a runaway figure.
 *
 * Flat 4/3 scaling — the previous approach — is strictly worse than either: it
 * assumes the missing quarter equals the average of the known ones, which
 * understates every compounding business, and the omitted quarter is normally
 * the largest.
 */
const GEO_CLAMP = [0.6, 1.6];   // per-quarter step, guards against runaway compounding

function buildNtm(forward) {
  const q = forward.filter(e => e.epsEstimate != null)
                   .sort((a, b) => a.date < b.date ? -1 : 1);
  if (!q.length) return null;

  const vals = q.map(e => e.epsEstimate);
  const periods = q.map(e => `FY${e.year}Q${e.quarter}`);
  let derived = 0;

  // Sequential step, as the geometric mean of the observed quarter-on-quarter
  // ratios. Only meaningful while the series stays positive — a sign flip makes
  // a ratio meaningless, so we bail to the plain sum in that case.
  const ratios = [];
  for (let i = 1; i < vals.length; i++) {
    if (vals[i - 1] > 0 && vals[i] > 0) ratios.push(vals[i] / vals[i - 1]);
  }
  let step = null;
  if (ratios.length) {
    const geo = Math.exp(ratios.reduce((s, r) => s + Math.log(r), 0) / ratios.length);
    step = Math.min(GEO_CLAMP[1], Math.max(GEO_CLAMP[0], geo));
  }

  while (vals.length < 4 && step != null && vals[vals.length - 1] > 0) {
    vals.push(vals[vals.length - 1] * step);
    periods.push('derived');
    derived++;
  }

  if (vals.length < 4) return null;   // cannot build a credible twelve months

  const sum = vals.slice(0, 4).reduce((s, v) => s + v, 0);
  return {
    eps: Math.round(sum * 10000) / 10000,
    quarters: q.length,
    derived,
    step: step ? Math.round(step * 1000) / 1000 : null,
    approx: derived > 0,
    periods: periods.slice(0, 4),
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
      rec.derived = ntm.derived;
      rec.step = ntm.step;
      // Raw forward quarters, kept so build-eps-series.js can slide a 12-month
      // window across them. NTM is not one number that steps at each report —
      // earnings accrue daily, so the corridor should rise a little every day.
      rec.forward = (cal.data.earningsCalendar || [])
        .filter(e => e.epsEstimate != null)
        .sort((a, b) => a.date < b.date ? -1 : 1)
        .map(e => ({ fy: e.year, q: e.quarter, reportDate: e.date, eps: e.epsEstimate }));
      rec.approx = ntm.approx;
      rec.periods = ntm.periods;
      rec.nextReport = ntm.nextReport;
      rec.status = 'ok';
      const d = rec.ajEps ? ((ntm.eps - rec.ajEps) / rec.ajEps * 100) : null;
      rec.vsAj = d == null ? null : Math.round(d * 10) / 10;
      console.log(`  ✓ ${s.t.padEnd(6)} NTM ${String(ntm.eps).padStart(9)}` +
        `  ${ntm.derived ? `${ntm.quarters}q+${ntm.derived}d @${ntm.step}` : `${ntm.quarters}q exact`}`.padEnd(16) +
        `  AJ ${String(rec.ajEps ?? '—').padStart(7)}` +
        `  ${d == null ? '' : (d >= 0 ? '+' : '') + d.toFixed(0) + '%'}`.padEnd(8) +
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
