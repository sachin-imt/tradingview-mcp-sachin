#!/usr/bin/env node
/**
 * Build a DAILY NTM EPS series, so the corridor slopes instead of sitting flat.
 *
 * This is the mechanic that makes the Corridor Method a timing tool rather than
 * a static channel. Earnings accrue continuously, not in quarterly jumps, so
 * next-twelve-months earnings rise a little every day: the 12-month window
 * [t, t+365] slides forward, taking on a fraction of a further-out (larger)
 * quarter and shedding a fraction of a nearer (smaller) one. A stock whose price
 * does not move is therefore getting cheaper every day, and the corridor has to
 * express that. Ours previously could not — NVDA and MU carried a single EPS
 * value across all 45 days, drawing horizontal bands where AJ's slope upward.
 *
 * NTM(t) = sum over quarters q of  EPS_q * overlap(q, [t, t+365]) / length(q)
 *
 * Quarters come from estimates.json: reported actuals looking back, consensus
 * estimates looking forward, plus the sequentially-derived quarter that
 * fetch-estimates.js adds when the free tier returns only three.
 *
 * A name still on AJ's estimate keeps AJ's LEVEL and borrows only the SHAPE of
 * the consensus curve. We rescale the accrual path so it passes exactly through
 * AJ's number today: his estimate is preserved, but it now grows through the
 * window instead of standing still.
 *
 * Usage: node pipeline/build-eps-series.js [--verbose]
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(__dir, 'config.json'), 'utf8'));
const estPath = join(__dir, 'data', 'estimates.json');
const pricesPath = join(__dir, 'data', 'prices.json');
const epsPath = join(__dir, 'data', 'eps.json');
const VERBOSE = process.argv.includes('--verbose');

if (!existsSync(estPath)) { console.error('Run fetch-estimates.js first.'); process.exit(1); }
const est = JSON.parse(readFileSync(estPath, 'utf8')).estimates;
const prices = JSON.parse(readFileSync(pricesPath, 'utf8'));
const DATES = prices.dates;

const DAY = 864e5;
const d = s => Date.parse(s + 'T00:00:00Z');
const addMonths = (ms, n) => { const x = new Date(ms); x.setUTCMonth(x.getUTCMonth() + n); return x.getTime(); };

/**
 * Assemble a continuous quarterly EPS timeline: actuals behind, estimates ahead.
 * Finnhub reports a period END date for actuals; forward entries carry only a
 * report date, so we continue the quarterly cadence from the last actual.
 */
function timeline(rec) {
  const qs = [];
  const hist = (rec.history || []).filter(h => h.actual != null)
    .sort((a, b) => a.period < b.period ? -1 : 1);
  for (const h of hist) {
    const end = d(h.period);
    qs.push({ start: addMonths(end, -3), end, eps: h.actual, kind: 'actual' });
  }
  let cursor = qs.length ? qs[qs.length - 1].end : null;
  const fwd = rec.forward || [];
  for (const f of fwd) {
    if (cursor == null) break;
    const start = cursor, end = addMonths(cursor, 3);
    qs.push({ start, end, eps: f.eps, kind: 'estimate' });
    cursor = end;
  }
  // Extend with the sequential step so the window always has 12 months of
  // forward cover; without this NTM would decay near the end of the horizon.
  if (cursor != null && fwd.length >= 2) {
    const ratios = [];
    for (let i = 1; i < fwd.length; i++)
      if (fwd[i - 1].eps > 0 && fwd[i].eps > 0) ratios.push(fwd[i].eps / fwd[i - 1].eps);
    if (ratios.length) {
      let step = Math.exp(ratios.reduce((s, r) => s + Math.log(r), 0) / ratios.length);
      step = Math.min(1.6, Math.max(0.6, step));
      let last = qs[qs.length - 1].eps;
      for (let k = 0; k < 5; k++) {
        const start = cursor, end = addMonths(cursor, 3);
        last = last * step;
        qs.push({ start, end, eps: last, kind: 'derived' });
        cursor = end;
      }
    }
  }
  return qs;
}

/** NTM at date t: quarterly EPS weighted by each quarter's overlap with [t, t+365]. */
function ntmAt(qs, t) {
  const from = t, to = t + 365 * DAY;
  let sum = 0, covered = 0;
  for (const q of qs) {
    const lo = Math.max(q.start, from), hi = Math.min(q.end, to);
    if (hi <= lo) continue;
    const len = q.end - q.start;
    if (len <= 0) continue;
    sum += q.eps * (hi - lo) / len;
    covered += hi - lo;
  }
  // Require most of the year to be covered, else the figure is not an NTM.
  return covered >= 0.9 * (365 * DAY) ? sum : null;
}

const outEps = {};
const report = [];

for (const s of cfg.stocks) {
  const rec = est[s.t];
  const cor = cfg.corridors[s.t];
  if (!rec || !cor) continue;

  const qs = timeline(rec);
  const raw = DATES.map(dt => ntmAt(qs, d(dt)));
  const valid = raw.filter(v => v != null);
  if (valid.length < DATES.length * 0.5) {
    // Not enough quarterly cover — keep the flat value rather than invent a slope.
    if (cor.eps != null) outEps[s.t] = DATES.map(() => cor.eps);
    report.push({ t: s.t, mode: 'flat (insufficient quarterly cover)' });
    continue;
  }

  let series = raw;
  if (cor.epsSource !== 'cons' && cor.eps != null) {
    // Still on AJ: keep his level, adopt the consensus curve's SHAPE. Anchor at
    // the date his estimate was TRUE (epsAsOf), not at the last date. Anchoring
    // at the last date rescaled the whole curve every run so that "today" always
    // equalled his number — the slope existed only as a redrawn history and the
    // corridor never actually rose from one day to the next, which is the one
    // thing accrual is supposed to do.
    const asOf = cor.epsAsOf || DATES[DATES.length - 1];
    let ai = -1;
    for (let i = DATES.length - 1; i >= 0; i--) if (DATES[i] <= asOf && raw[i] != null) { ai = i; break; }
    if (ai < 0) for (let i = 0; i < raw.length; i++) if (raw[i] != null) { ai = i; break; }
    const anchor = ai >= 0 ? raw[ai] : null;
    if (anchor && anchor > 0) {
      const k = cor.eps / anchor;
      series = raw.map(v => v == null ? null : v * k);
    }
  }
  // Carry across any gaps so the band series has no holes.
  let last = null;
  series = series.map(v => (v == null ? last : (last = v)));
  for (let i = 0; i < series.length && series[i] == null; i++) series[i] = valid[0];

  outEps[s.t] = series.map(v => v == null ? null : Math.round(v * 10000) / 10000);
  const a = outEps[s.t][0], b = outEps[s.t][outEps[s.t].length - 1];
  const growth = a && b ? ((b / a - 1) * 100) : null;
  report.push({ t: s.t, mode: cor.epsSource === 'cons' ? 'consensus' : 'AJ level + consensus shape',
                from: a, to: b, growth });
}

writeFileSync(epsPath, JSON.stringify({
  dates: DATES,
  eps: outEps,
  method: 'accrual',
  builtAt: new Date().toISOString(),
  _comment: 'DAILY NTM EPS. Built by build-eps-series.js as a 12-month window sliding across quarterly EPS (actuals behind, consensus ahead), so earnings accrue continuously and the corridor slopes. Names still on AJ keep his level and take only the shape of the consensus curve. Do not overwrite with a flat value.'
}, null, 2) + '\n');

console.log(`Daily NTM EPS over ${DATES.length} sessions (${DATES[0]} → ${DATES[DATES.length - 1]})\n`);
console.log('ticker  mode                          EPS start → end     accrual over window');
for (const r of report.sort((a, b) => (b.growth ?? -99) - (a.growth ?? -99))) {
  if (r.growth == null) { console.log(`  ${r.t.padEnd(6)} ${r.mode}`); continue; }
  console.log(`  ${r.t.padEnd(6)} ${r.mode.padEnd(28)} ${String(r.from).padStart(9)} → ${String(r.to).padEnd(9)} ${(r.growth >= 0 ? '+' : '') + r.growth.toFixed(2)}%`);
}
console.log(`\n✓ ${epsPath}`);
