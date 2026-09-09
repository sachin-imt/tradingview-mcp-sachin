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

// ── sanity gate ─────────────────────────────────────────────────────────────
// A switch replaces the earnings the whole corridor is built on, so a wrong one
// does not fail loudly — it silently redraws every band and quietly changes what
// the dashboard calls cheap. These thresholds hold back anything large enough to
// deserve a human look. They are not a correctness check; they are a tripwire.
const argOf = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const MAX_CHANGE = Number(argOf('--max-change', '25')) / 100;
const APPROVED = new Set(argOf('--approve', '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean));
// A forward P/E outside this range almost always means a unit or currency
// mismatch rather than a real valuation — it is how TSM's TWD earnings against a
// USD ADR price shows up (implied P/E ~3.4).
const PE_SANE = [3, 250];

if (!existsSync(estPath)) {
  console.error('No estimates.json — run: node pipeline/fetch-estimates.js');
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const estFile = JSON.parse(readFileSync(estPath, 'utf8'));
const est = estFile.estimates;
const r4 = n => Math.round(n * 10000) / 10000;

// Latest close, for the implied-P/E sanity check. Falls back to the rolling
// file if the deep history has not been backfilled.
const pricesPath = join(__dir, 'data', 'prices.json');
const histPath = join(__dir, 'data', 'prices-history.json');
const priceSrc = existsSync(histPath) ? JSON.parse(readFileSync(histPath, 'utf8'))
               : existsSync(pricesPath) ? JSON.parse(readFileSync(pricesPath, 'utf8'))
               : { prices: {} };
function lastPrice(t) {
  const a = priceSrc.prices?.[t];
  if (!Array.isArray(a)) return null;
  for (let i = a.length - 1; i >= 0; i--) {
    const v = a[i];
    if (v == null) continue;
    return typeof v === 'object' ? v.close ?? null : v;
  }
  return null;
}

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

  const act = {
    t, kind: 'switch',
    from: cor.eps, to: e.consensusNtm,
    approx: !!e.approx, quarters: e.quarters, derived: e.derived,
    reportedPeriod: e.lastReport, baseline
  };

  // Gate 1 — magnitude. A large jump may be perfectly real (SanDisk's earnings
  // genuinely exploded) but it should never apply unseen.
  const change = cor.eps ? Math.abs((e.consensusNtm - cor.eps) / cor.eps) : null;
  act.change = change;

  // Gate 2 — implied forward P/E, which catches unit and currency errors that
  // the magnitude test alone would wave through.
  const px = lastPrice(t);
  const impliedPe = px ? px / e.consensusNtm : null;
  act.impliedPe = impliedPe ? Math.round(impliedPe * 10) / 10 : null;

  const reasons = [];
  if (change != null && change > MAX_CHANGE)
    reasons.push(`EPS moves ${(change * 100).toFixed(0)}% (gate ${(MAX_CHANGE * 100).toFixed(0)}%)`);
  if (impliedPe != null && (impliedPe < PE_SANE[0] || impliedPe > PE_SANE[1]))
    reasons.push(`implied fwd P/E ${impliedPe.toFixed(1)} outside ${PE_SANE[0]}-${PE_SANE[1]} — check units`);

  if (reasons.length && !APPROVED.has(t)) {
    act.kind = 'held';
    act.reasons = reasons;
  } else if (reasons.length) {
    act.overridden = reasons;
  }
  actions.push(act);
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
    if (a.kind === 'switch' || a.kind === 'held') {
      const d = a.from ? ((a.to - a.from) / a.from * 100) : null;
      const tag = a.kind === 'held' ? 'HELD   ' : 'SWITCH ';
      console.log(` ${tag} ${a.t.padEnd(6)} eps ${a.from} -> ${a.to}` +
        `${d == null ? '' : `  (${d >= 0 ? '+' : ''}${d.toFixed(0)}%)`}` +
        `${a.derived ? `  [${a.quarters}q +${a.derived} derived]` : '  [exact 4q]'}` +
        `${a.impliedPe != null ? `  fwdPE ${a.impliedPe}` : ''}`);
      for (const r of a.reasons || []) console.log(`          ↳ held: ${r}`);
      for (const r of a.overridden || []) console.log(`          ↳ OVERRIDDEN: ${r}`);
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
const held = actions.filter(a => a.kind === 'held');
if (held.length) {
  console.log(`\n${held.length} switch(es) held by the sanity gate. Review, then approve by name:`);
  console.log(`  node pipeline/apply-estimates.js --apply --approve ${held.map(a => a.t).join(',')}`);
  console.log(`  (or raise the bar for a run with --max-change <pct>)`);
}

if (!APPLY) {
  if (actions.some(a => a.kind !== 'held')) console.log('\nDry run. Re-run with --apply to commit.');
  process.exit(0);
}

let changed = 0;
for (const a of actions) {
  if (a.kind === 'held' || a.kind === 'blocked') continue;   // gate holds them back
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
