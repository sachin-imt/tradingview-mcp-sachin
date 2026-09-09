#!/usr/bin/env node
/**
 * Decide which corridors have outlived AJ's estimate, and switch those to
 * consensus. Everything else is left alone.
 *
 * The rule: AJ's NTM estimate stays live until the company actually reports,
 * because the report is what invalidates it. We detect that by watching the
 * company's last reported fiscal period. config records the period that was
 * most recent when AJ's number was taken (epsBaselinePeriod); when Finnhub
 * shows a newer one, that name has reported since and switches.
 *
 * When a name switches we replace the EPS but KEEP AJ's P/E multiples. The
 * observable multiple range is a slow-moving structural property of the stock;
 * earnings are what re-level the corridor. So bands = new EPS x same multiples.
 *
 * A corridor carrying a `sunset` block is retired instead of switched — used
 * where consensus exists but is not usable (TSM reports EPS in TWD against our
 * USD ADR price).
 *
 * Dry run by default so it is safe to call from the daily cron for reporting.
 * Usage: node pipeline/apply-estimates.js [--apply]
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const configPath = join(__dir, 'config.json');
const estPath = join(__dir, 'data', 'estimates.json');
const logPath = join(__dir, 'data', 'cutover-log.json');
const APPLY = process.argv.includes('--apply');

if (!existsSync(estPath)) {
  console.error('No estimates.json — run: node pipeline/fetch-estimates.js');
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const estFile = JSON.parse(readFileSync(estPath, 'utf8'));
const est = estFile.estimates;
const r4 = n => Math.round(n * 10000) / 10000;

const actions = [];

for (const stock of config.stocks) {
  const t = stock.t;
  const cor = config.corridors[t];
  const e = est[t];
  if (!cor || !e) continue;
  if (cor.epsSource === 'cons') continue;           // already switched
  if (!e.lastReport) continue;                       // nothing to compare against

  const baseline = cor.epsBaselinePeriod;
  const reported = baseline && e.lastReport > baseline;
  if (!reported) continue;

  if (cor.sunset) {
    actions.push({ t, kind: 'retire', reason: cor.sunset.reason, reportedPeriod: e.lastReport });
    continue;
  }
  if (e.consensusNtm == null) {
    actions.push({ t, kind: 'blocked', reason: 'reported but no consensus NTM available', reportedPeriod: e.lastReport });
    continue;
  }
  // A corridor is EPS x multiple, so non-positive earnings make it meaningless
  // (the bands invert and the ordering of the sigma levels flips). Loss-making
  // names belong out of scope, which is where AJ put them too.
  if (e.consensusNtm <= 0) {
    actions.push({ t, kind: 'blocked', reason: `consensus NTM is ${e.consensusNtm} — loss-making, keep out of scope`, reportedPeriod: e.lastReport });
    continue;
  }

  actions.push({
    t, kind: 'switch',
    from: cor.eps, to: e.consensusNtm,
    approx: !!e.approx, quarters: e.quarters,
    reportedPeriod: e.lastReport, baseline
  });
}

// ── report ──────────────────────────────────────────────────────────────────
const pending = config.stocks
  .map(s => ({ t: s.t, next: est[s.t]?.nextReport, sunset: !!config.corridors[s.t]?.sunset,
               src: config.corridors[s.t]?.epsSource }))
  .filter(r => r.src === 'aj' && r.next)
  .sort((a, b) => a.next < b.next ? -1 : 1);

console.log(`Estimates fetched ${estFile.fetchedAt?.slice(0, 10) ?? '—'}\n`);

if (!actions.length) {
  console.log('No corridor has outlived its AJ estimate — nothing to change.\n');
} else {
  console.log(`${actions.length} action(s):\n`);
  for (const a of actions) {
    if (a.kind === 'switch') {
      const d = a.from ? ((a.to - a.from) / a.from * 100) : null;
      console.log(`  SWITCH  ${a.t.padEnd(6)} eps ${a.from} -> ${a.to}` +
        `${d == null ? '' : `  (${d >= 0 ? '+' : ''}${d.toFixed(0)}%)`}` +
        `${a.approx ? `  [APPROX: only ${a.quarters}q, scaled]` : '  [exact 4q]'}`);
    } else if (a.kind === 'retire') {
      console.log(`  RETIRE  ${a.t.padEnd(6)} ${a.reason}`);
    } else {
      console.log(`  BLOCKED ${a.t.padEnd(6)} ${a.reason}`);
    }
  }
  console.log();
}

console.log('Still on AJ, next report:');
for (const p of pending.slice(0, 6)) {
  console.log(`  ${p.next}  ${p.t}${p.sunset ? '  (retires)' : ''}`);
}
if (pending.length > 6) console.log(`  ... ${pending.length - 6} more`);

// ── apply ───────────────────────────────────────────────────────────────────
if (!APPLY) {
  if (actions.length) console.log('\nDry run. Re-run with --apply to commit these changes.');
  process.exit(0);
}

let changed = 0;
for (const a of actions) {
  const cor = config.corridors[a.t];
  if (a.kind === 'switch') {
    cor.eps = r4(a.to);
    // Keep AJ's multiples; earnings re-level the corridor, the P/E range persists.
    for (const [b, pe] of [['bL', 'peL'], ['bM', 'peM'], ['bH', 'peH'],
                           ['bL1y', 'peL1y'], ['bM1y', 'peM1y'], ['bH1y', 'peH1y']]) {
      if (cor[pe] != null) cor[b] = r4(cor.eps * cor[pe]);
    }
    cor.epsSource = 'cons';
    cor.epsAsOf = estFile.fetchedAt.slice(0, 10);
    cor.epsBaselinePeriod = a.reportedPeriod;
    cor.epsApprox = a.approx || undefined;
    changed++;
  } else if (a.kind === 'retire') {
    config.stocks = config.stocks.filter(s => s.t !== a.t);
    delete config.corridors[a.t];
    delete config.corrMeta?.[a.t];
    changed++;
  }
}

if (changed) {
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  const log = existsSync(logPath) ? JSON.parse(readFileSync(logPath, 'utf8')) : { events: [] };
  log.events.push({ at: new Date().toISOString(), actions });
  writeFileSync(logPath, JSON.stringify(log, null, 2) + '\n');
  console.log(`\n✓ Applied ${changed} change(s) to config.json; logged to cutover-log.json`);
  console.log('  Re-run: node pipeline/update-data.js && node pipeline/build.js');
} else {
  console.log('\nNothing to apply.');
}
