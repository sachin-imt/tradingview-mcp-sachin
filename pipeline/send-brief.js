#!/usr/bin/env node
/**
 * Email the daily corridor brief over SMTP. Runs in GitHub Actions, so it works
 * whether or not any local machine is awake — the scheduled routine cannot make
 * that promise.
 *
 * Deliberately zero-dependency: raw SMTP over TLS rather than nodemailer or a
 * marketplace action. This job holds a mail credential, so the smaller the
 * supply chain the better. It is ~80 lines and entirely auditable.
 *
 * Env:
 *   SMTP_USER  gmail address to authenticate as
 *   SMTP_PASS  Google App Password (NOT the account password)
 *   BRIEF_TO   recipient
 *   SMTP_HOST  default smtp.gmail.com
 *   SMTP_PORT  default 465 (implicit TLS)
 *
 * Usage: node pipeline/send-brief.js [--dry-run] [--force]
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import tls from 'tls';

const __dir = dirname(fileURLToPath(import.meta.url));
const briefPath = join(__dir, 'data', 'briefing-latest.json');
const sentPath = join(__dir, 'data', 'last-brief-sent.json');
const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

if (!existsSync(briefPath)) { console.error('No briefing-latest.json — run briefing.js first.'); process.exit(1); }
const b = JSON.parse(readFileSync(briefPath, 'utf8'));

// ── freshness gate ──────────────────────────────────────────────────────────
// A brief that restates the previous session teaches the reader to ignore the
// mail, which is worse than sending nothing. US holidays land here.
const sent = existsSync(sentPath) ? JSON.parse(readFileSync(sentPath, 'utf8')) : {};
const ageDays = (Date.now() - Date.parse(b.date + 'T21:00:00Z')) / 864e5;
if (!FORCE) {
  if (sent.date === b.date) { console.log(`Session ${b.date} already sent at ${sent.sentAt}. Nothing to do.`); process.exit(0); }
  if (ageDays > 4) { console.log(`Latest session ${b.date} is ${ageDays.toFixed(1)} days old — feed looks stale, not sending.`); process.exit(0); }
}

// ── compose ─────────────────────────────────────────────────────────────────
const pct = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + '%';
const posOf = r => `${(r.pos * 100).toFixed(0)}% of corridor`;
const L = [];
const section = (title, lines) => { if (lines.length) { L.push(title, ...lines, ''); } };

section('BECAME MORE ATTRACTIVE', (b.becameAttractive || []).map(r =>
  `  ${r.t.padEnd(6)} ${r.prevZone} → ${r.zone}   ${pct(r.move)}   ${posOf(r)}   [${r.cause}]`));
section('BECAME LESS ATTRACTIVE', (b.becameStretched || []).map(r =>
  `  ${r.t.padEnd(6)} ${r.prevZone} → ${r.zone}   ${pct(r.move)}   ${posOf(r)}   [${r.cause}]`));
section('DRIFTING CHEAPER (20 sessions — earnings accruing under a quiet price)',
  (b.creeping || []).map(c =>
    `  ${c.t.padEnd(6)} corridor position ${(c.dTotal * 100).toFixed(0)}pp → now ${(c.pos * 100).toFixed(0)}% (${c.zone})` +
    `, price ${pct(c.move)}, accrual did ${(Math.abs(c.dBands) / (Math.abs(c.dBands) + Math.abs(c.dPrice)) * 100).toFixed(0)}%`));
section('MOVERS (mega >2%, others >4%)', (b.movers || []).map(r =>
  `  ${r.t.padEnd(6)} ${pct(r.move).padStart(7)}  ${posOf(r)}, ${r.zone}`));
section('AT OR THROUGH THE OUTER BANDS', [
  ...(b.deepValue || []).map(t => `  ${t} at or below −1.5σ`),
  ...(b.extreme || []).map(t => `  ${t} at or above +1.5σ`)]);
section('REPORTS WITHIN 14 DAYS (corridor least reliable; cutover risk)',
  (b.reportsSoon || []).map(r => `  ${r.date}  ${r.t.padEnd(6)} on ${r.epsSource === 'cons' ? 'consensus' : "AJ's frozen estimate"}`));

if (b.truncated) L.push(`Capped at ${b.maxChanges} changes (market-cap order). Held back: ${(b.suppressed || []).map(s => s.t).join(', ')}`, '');

const quiet = !(b.becameAttractive?.length || b.becameStretched?.length || b.movers?.length || b.creeping?.length);
if (quiet) L.push('No corridor zone changes, no moves through threshold, no drift.', '');

const body = [
  `Corridor brief — US session ${b.date}`,
  '='.repeat(46), '',
  ...L,
  '—',
  'Mechanical readings of the Corridor Method: where price sits against each',
  "name's own observable multiple range. No view on the business or the news.",
  'Not investment advice.',
  '',
  'Dashboard: https://sachin-imt.github.io/tradingview-mcp-sachin/'
].join('\n');

// changeCount counts same-session transitions and threshold breaches only, so a
// day whose news is entirely 20-session drift would otherwise be titled
// "0 changes" above a body full of content. Describe what is actually in it.
const bits = [];
const nZone = (b.becameAttractive?.length || 0) + (b.becameStretched?.length || 0);
if (nZone) bits.push(`${nZone} zone change${nZone === 1 ? '' : 's'}`);
if (b.movers?.length) bits.push(`${b.movers.length} mover${b.movers.length === 1 ? '' : 's'}`);
if (b.creeping?.length) bits.push(`${b.creeping.length} drifting cheaper`);
const subject = bits.length
  ? `Corridor brief ${b.date} — ${bits.join(', ')}`
  : `Corridor brief ${b.date} — quiet session`;

if (DRY) { console.log(`To: ${process.env.BRIEF_TO || '(BRIEF_TO unset)'}\nSubject: ${subject}\n\n${body}`); process.exit(0); }

// ── send ────────────────────────────────────────────────────────────────────
const { SMTP_USER, SMTP_PASS, BRIEF_TO } = process.env;
const HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const PORT = Number(process.env.SMTP_PORT || 465);
if (!SMTP_USER || !SMTP_PASS || !BRIEF_TO) {
  console.log('SMTP_USER / SMTP_PASS / BRIEF_TO not all set — skipping send (this is not an error).');
  process.exit(0);
}

const b64 = s => Buffer.from(s, 'utf8').toString('base64');

function smtpSend() {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: HOST, port: PORT, servername: HOST }, () => {});
    let buf = '';
    const queue = [];
    let waiting = null;
    sock.setEncoding('utf8');
    sock.setTimeout(30000, () => reject(new Error('SMTP timeout')));
    sock.on('error', reject);
    sock.on('data', chunk => {
      buf += chunk;
      // A reply ends on a line whose 4th char is a space, e.g. "250 OK".
      let m;
      while ((m = buf.match(/^(?:\d{3}-[^\n]*\n)*(\d{3}) [^\n]*\n/))) {
        const code = Number(m[1]);
        const full = m[0];
        buf = buf.slice(full.length);
        if (waiting) { const w = waiting; waiting = null; w(code, full); }
      }
      pump();
    });
    const say = (line, expect) => new Promise((res, rej) => {
      queue.push(() => {
        waiting = (code, full) => {
          if (expect && !expect.includes(code)) return rej(new Error(`SMTP ${code}: ${full.trim()} (after ${line.split('\r')[0].slice(0, 20)})`));
          res(code);
        };
        if (line !== null) sock.write(line);
      });
      pump();
    });
    let running = false;
    function pump() { if (running || !queue.length || waiting) return; running = true; const fn = queue.shift(); running = false; fn(); }

    (async () => {
      await say(null, [220]);                                   // greeting
      await say(`EHLO localhost\r\n`, [250]);
      await say(`AUTH LOGIN\r\n`, [334]);
      await say(`${b64(SMTP_USER)}\r\n`, [334]);
      await say(`${b64(SMTP_PASS)}\r\n`, [235]);
      await say(`MAIL FROM:<${SMTP_USER}>\r\n`, [250]);
      await say(`RCPT TO:<${BRIEF_TO}>\r\n`, [250, 251]);
      await say(`DATA\r\n`, [354]);
      const headers = [
        `From: Corridor Brief <${SMTP_USER}>`,
        `To: ${BRIEF_TO}`,
        `Subject: ${subject}`,
        `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: 8bit'
      ].join('\r\n');
      // Dot-stuffing: a line that is just "." would end DATA early.
      const safe = body.split('\n').map(l => (l === '.' ? '..' : l)).join('\r\n');
      await say(`${headers}\r\n\r\n${safe}\r\n.\r\n`, [250]);
      await say(`QUIT\r\n`, [221]);
      sock.end();
      resolve();
    })().catch(reject);
  });
}

smtpSend().then(() => {
  writeFileSync(sentPath, JSON.stringify({ date: b.date, sentAt: new Date().toISOString(), to: BRIEF_TO, subject }, null, 2) + '\n');
  console.log(`✓ Sent "${subject}" to ${BRIEF_TO}`);
}).catch(e => {
  console.error(`Send failed: ${e.message}`);
  process.exit(1);
});
