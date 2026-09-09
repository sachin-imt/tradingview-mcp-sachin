#!/usr/bin/env node
/**
 * Daily corridor briefing: which names crossed into the attractive end of their
 * corridor, which crossed into the stretched end, and what moved.
 *
 * These are mechanical readings of the Corridor Method, not recommendations. A
 * name is "attractive" only in the sense that its price sits low against its own
 * observable multiple range — the model knows nothing about why.
 *
 * The interesting part is WHY a name crossed, and there are two causes:
 *   price moved      — the stock fell (or rose) against a stationary corridor
 *   earnings accrued — the corridor rose underneath a stock that barely moved
 * The second is invisible without the daily accrual series, and it is the one
 * that creeps up on you: nothing happens, day after day, and a name is suddenly
 * cheap. We decompose every crossing into the two.
 *
 * Usage: node pipeline/briefing.js [--date YYYY-MM-DD] [--json]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..');
const cfg = JSON.parse(readFileSync(join(__dir, 'config.json'), 'utf8'));
const prices = JSON.parse(readFileSync(join(__dir, 'data', 'prices.json'), 'utf8'));
const bands = JSON.parse(readFileSync(join(__dir, 'data', 'bands.json'), 'utf8'));
const estPath = join(__dir, 'data', 'estimates.json');
const est = existsSync(estPath) ? JSON.parse(readFileSync(estPath, 'utf8')).estimates : {};

const ZONES = [
  { name: 'Attractive', max: 0.45 },
  { name: 'Fair Value', max: 0.75 },
  { name: 'Stretched', max: Infinity }
];
const zoneOf = p => ZONES.find(z => p < z.max).name;
const pct = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + '%';

const DATES = prices.dates;
const argDate = (() => { const i = process.argv.indexOf('--date'); return i > -1 ? process.argv[i + 1] : null; })();

/** Last session with a usable cross-section, so a half-filled day is not read as news. */
function lastFullIdx() {
  const tk = Object.keys(prices.prices);
  for (let i = DATES.length - 1; i > 0; i--) {
    const filled = tk.filter(t => prices.prices[t]?.[i] != null).length;
    if (filled >= tk.length / 2) return i;
  }
  return DATES.length - 1;
}
const idx = argDate ? DATES.indexOf(argDate) : lastFullIdx();
if (idx < 1) { console.error('Not enough history.'); process.exit(1); }

function posAt(t, i) {
  const p = prices.prices[t]?.[i];
  const b = bands.bands[t];
  if (p == null || !b) return null;
  const lo = b.m15?.[i], hi = b.p15?.[i];
  if (lo == null || hi == null || hi <= lo) return null;
  return { p, lo, hi, med: b.med?.[i], pos: (p - lo) / (hi - lo) };
}

const rows = [];
for (const s of cfg.stocks) {
  const now = posAt(s.t, idx);
  const prev = posAt(s.t, idx - 1);
  if (!now || !prev) continue;

  const move = (now.p - prev.p) / prev.p * 100;
  const width = now.hi - now.lo;
  // Split the change in corridor position into its two causes. Price effect is
  // the price change measured against today's band width; whatever remains is
  // the corridor itself having moved under the stock.
  const dPosPrice = (now.p - prev.p) / width;
  const dPosTotal = now.pos - prev.pos;
  const dPosBands = dPosTotal - dPosPrice;

  const tier = cfg.alerts.tiers.find(t => t.name === s.tier) || cfg.alerts.tiers[cfg.alerts.tiers.length - 1];
  const threshold = cfg.alerts.overrides?.[s.t] ?? tier.movePct;

  rows.push({
    t: s.t, n: s.n, tier: s.tier, threshold,
    price: now.p, move,
    zone: zoneOf(now.pos), prevZone: zoneOf(prev.pos),
    pos: now.pos, prevPos: prev.pos,
    dPosPrice, dPosBands, dPosTotal,
    lo: now.lo, hi: now.hi, med: now.med,
    epsSource: cfg.corridors[s.t]?.epsSource ?? 'aj',
    nextReport: est[s.t]?.nextReport ?? null,
    breached: Math.abs(move) >= threshold
  });
}

const zoneRank = { Attractive: 0, 'Fair Value': 1, Stretched: 2 };
const becameAttractive = rows.filter(r => zoneRank[r.zone] < zoneRank[r.prevZone]);
const becameStretched  = rows.filter(r => zoneRank[r.zone] > zoneRank[r.prevZone]);
const movers = rows.filter(r => r.breached).sort((a, b) => Math.abs(b.move) - Math.abs(a.move));
const deepValue = rows.filter(r => r.pos <= 0.02);
const extreme   = rows.filter(r => r.pos >= 0.98);
const soon = rows.filter(r => r.nextReport &&
  (Date.parse(r.nextReport) - Date.parse(DATES[idx])) / 864e5 <= 14 &&
  Date.parse(r.nextReport) >= Date.parse(DATES[idx]));

const cause = r => {
  const a = Math.abs(r.dPosPrice), b = Math.abs(r.dPosBands);
  if (b > a * 2) return 'earnings accrual';
  if (a > b * 2) return 'price';
  return 'both';
};

// Earnings accrue about 0.15% a day, so over a single session price movement
// almost always dominates and every crossing reads as "price". The accrual
// effect is a slow drift: nothing happens for weeks and a name is quietly
// cheap. That only shows up over a longer window, so we measure one.
const LOOKBACK = 20;
const drift = [];
if (idx >= LOOKBACK) {
  for (const s of cfg.stocks) {
    const now = posAt(s.t, idx), then = posAt(s.t, idx - LOOKBACK);
    if (!now || !then) continue;
    const move = (now.p - then.p) / then.p * 100;
    const dPrice = (now.p - then.p) / (now.hi - now.lo);
    const dTotal = now.pos - then.pos;
    const dBands = dTotal - dPrice;
    drift.push({ t: s.t, move, dTotal, dPrice, dBands, pos: now.pos, zone: zoneOf(now.pos) });
  }
}
// The interesting ones: corridor position fell materially, and it was the
// corridor rising rather than the price falling that did most of the work.
const creeping = drift
  .filter(d => d.dTotal <= -0.08 && Math.abs(d.dBands) > Math.abs(d.dPrice) * 0.5)
  .sort((a, b) => a.dTotal - b.dTotal);

// ── console ─────────────────────────────────────────────────────────────────
const D = DATES[idx];
console.log(`\n═══ Corridor briefing — ${D} ═══\n`);

if (becameAttractive.length) {
  console.log('BECAME MORE ATTRACTIVE');
  for (const r of becameAttractive)
    console.log(`  ${r.t.padEnd(6)} ${r.prevZone} → ${r.zone}   ${pct(r.move)}   at ${(r.pos * 100).toFixed(0)}% of corridor   [${cause(r)}]`);
  console.log();
}
if (becameStretched.length) {
  console.log('BECAME LESS ATTRACTIVE');
  for (const r of becameStretched)
    console.log(`  ${r.t.padEnd(6)} ${r.prevZone} → ${r.zone}   ${pct(r.move)}   at ${(r.pos * 100).toFixed(0)}% of corridor   [${cause(r)}]`);
  console.log();
}
if (!becameAttractive.length && !becameStretched.length)
  console.log('No corridor zone changes today.\n');

if (creeping.length) {
  console.log(`DRIFTING CHEAPER over ${LOOKBACK} sessions  (earnings accruing under a quiet price)`);
  for (const c of creeping)
    console.log(`  ${c.t.padEnd(6)} corridor position ${(c.dTotal * 100 >= 0 ? '+' : '') + (c.dTotal * 100).toFixed(0)}pp → now ${(c.pos * 100).toFixed(0)}% (${c.zone})` +
      `   price ${pct(c.move)}, of which accrual did ${(Math.abs(c.dBands) / (Math.abs(c.dBands) + Math.abs(c.dPrice)) * 100).toFixed(0)}%`);
  console.log();
}

if (deepValue.length) console.log(`AT OR BELOW −1.5σ: ${deepValue.map(r => r.t).join(', ')}\n`);
if (extreme.length)   console.log(`AT OR ABOVE +1.5σ: ${extreme.map(r => r.t).join(', ')}\n`);

console.log(`MOVERS (mega >${cfg.alerts.tiers[0].movePct}%, others >${cfg.alerts.tiers[1].movePct}%)`);
if (movers.length) {
  for (const r of movers)
    console.log(`  ${r.t.padEnd(6)} ${pct(r.move).padStart(7)}  ${r.tier.padEnd(5)} (>${r.threshold}%)  now ${(r.pos * 100).toFixed(0)}% of corridor, ${r.zone}`);
} else console.log('  none');
console.log();

if (soon.length) {
  console.log('REPORTS WITHIN 14 DAYS  (corridor least reliable here; cutover risk)');
  for (const r of soon.sort((a, b) => a.nextReport < b.nextReport ? -1 : 1))
    console.log(`  ${r.nextReport}  ${r.t.padEnd(6)} still on ${r.epsSource === 'cons' ? 'consensus' : "AJ's estimate"}`);
  console.log();
}

const out = {
  date: D, generatedAt: new Date().toISOString(),
  becameAttractive: becameAttractive.map(r => ({ ...r, cause: cause(r) })),
  becameStretched: becameStretched.map(r => ({ ...r, cause: cause(r) })),
  movers, creeping, deepValue: deepValue.map(r => r.t), extreme: extreme.map(r => r.t),
  reportsSoon: soon.map(r => ({ t: r.t, date: r.nextReport, epsSource: r.epsSource })),
  all: rows
};
mkdirSync(join(__dir, 'data'), { recursive: true });
writeFileSync(join(__dir, 'data', 'briefing-latest.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`✓ pipeline/data/briefing-latest.json`);
export {};
