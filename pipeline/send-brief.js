#!/usr/bin/env node
/**
 * Email the daily brief. Runs in GitHub Actions, so it works whether or not any
 * local machine is awake.
 *
 * Written for a reader who has not been staring at the model all day. Every
 * stock gets one number, 0-100, for how cheap it is against its own normal
 * valuation range. No jargon, no "pp", no Greek letters. If a sentence needs a
 * glossary it does not belong in here.
 *
 * Zero-dependency: raw SMTP over TLS rather than nodemailer or a marketplace
 * action. This job holds a mail credential, so the smaller the supply chain the
 * better.
 *
 * Env: SMTP_USER, SMTP_PASS (Google App Password), BRIEF_TO, [SMTP_HOST], [SMTP_PORT]
 * Usage: node pipeline/send-brief.js [--dry-run] [--force] [--html]
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import tls from 'tls';

const __dir = dirname(fileURLToPath(import.meta.url));
const briefPath = join(__dir, 'data', 'briefing-latest.json');
const sentPath = join(__dir, 'data', 'last-brief-sent.json');
const DRY = process.argv.includes('--dry-run');
const SHOW_HTML = process.argv.includes('--html');
const FORCE = process.argv.includes('--force');

if (!existsSync(briefPath)) { console.error('No briefing-latest.json — run briefing.js first.'); process.exit(1); }
const b = JSON.parse(readFileSync(briefPath, 'utf8'));

// ── freshness gate ──────────────────────────────────────────────────────────
const sent = existsSync(sentPath) ? JSON.parse(readFileSync(sentPath, 'utf8')) : {};
const ageDays = (Date.now() - Date.parse(b.date + 'T21:00:00Z')) / 864e5;
if (!FORCE) {
  if (sent.date === b.date) { console.log(`Session ${b.date} already sent at ${sent.sentAt}. Nothing to do.`); process.exit(0); }
  if (ageDays > 4) { console.log(`Latest session ${b.date} is ${ageDays.toFixed(1)} days old — feed looks stale, not sending.`); process.exit(0); }
}

// ── plain-language helpers ──────────────────────────────────────────────────
const NAMES = { NVDA:'Nvidia', AAPL:'Apple', GOOGL:'Alphabet', MSFT:'Microsoft', AMZN:'Amazon',
  AVGO:'Broadcom', META:'Meta', TSLA:'Tesla', MU:'Micron', TSM:'TSMC', AMD:'AMD', ASML:'ASML',
  INTC:'Intel', ORCL:'Oracle', PLTR:'Palantir', AMAT:'Applied Materials', SNDK:'SanDisk',
  MRVL:'Marvell', UBER:'Uber', LITE:'Lumentum', COHR:'Coherent', XPEV:'XPeng' };
const nameOf = t => NAMES[t] || t;
const score = pos => Math.round(pos * 100);
// 0 and 100 are the edges of the range the stock normally trades in, not hard
// limits — that range covers roughly 87% of days, so about one day in eight the
// score lands outside it. Going outside is a stronger signal than sitting at
// the edge, so we report it rather than clamping the number and losing it.
const band = s =>
  s < 0   ? 'below its normal range' :
  s < 45  ? 'cheap end' :
  s < 75  ? 'middle' :
  s <= 100 ? 'expensive end' :
             'above its normal range';
const bandColour = s =>
  s < 0    ? '#0d5c40' :
  s < 45   ? '#1a7f5a' :
  s < 75   ? '#8a6d1f' :
  s <= 100 ? '#a33' :
             '#7a1010';
const movePct = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + '%';
// Was the move driven by the share price, or by earnings rising underneath it?
const driver = (dBands, dPrice) => {
  const share = Math.abs(dBands) / (Math.abs(dBands) + Math.abs(dPrice) || 1);
  if (share > 0.6) return 'mostly because earnings rose';
  if (share < 0.35) return 'mostly on the share price';
  return 'price and earnings both';
};

// ── build the sections ──────────────────────────────────────────────────────
const cheaper = (b.becameAttractive || []).map(r => ({
  t: r.t, s: score(r.pos), was: score(r.prevPos), move: r.move,
  why: r.cause === 'earnings accrual' ? 'mostly because earnings rose'
     : r.cause === 'price' ? 'mostly on the share price' : 'price and earnings both' }));
const pricier = (b.becameStretched || []).map(r => ({
  t: r.t, s: score(r.pos), was: score(r.prevPos), move: r.move,
  why: r.cause === 'earnings accrual' ? 'mostly because earnings rose'
     : r.cause === 'price' ? 'mostly on the share price' : 'price and earnings both' }));
const WEEKS = Math.max(1, Math.round((b.lookbackSessions || 20) / 5));
const drifting = (b.creeping || []).map(c => ({
  t: c.t, s: score(c.pos), was: score(c.pos - c.dTotal), move: c.move,
  why: driver(c.dBands, c.dPrice), ago: `${WEEKS} weeks ago` }));
const movers = (b.movers || []).map(r => ({ t: r.t, s: score(r.pos), move: r.move }));
const quads = b.quadrantMoves || [];
const cut = b.cutovers || { applied: [], held: [] };
const reports = (b.reportsSoon || []).map(r => ({ t: r.t, date: r.date }));

const nothing = !cheaper.length && !pricier.length && !drifting.length && !movers.length && !quads.length;

const prettyDate = new Date(b.date + 'T12:00:00Z')
  .toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });

// ── subject ─────────────────────────────────────────────────────────────────
const bits = [];
if (quads.length) bits.push(`${quads.length} changed quadrant`);
if (cheaper.length) bits.push(`${cheaper.length} cheaper`);
if (pricier.length) bits.push(`${pricier.length} pricier`);
if (!cheaper.length && !pricier.length && drifting.length) bits.push(`${drifting.length} drifting cheaper`);
if (movers.length) bits.push(`${movers.length} big move${movers.length === 1 ? '' : 's'}`);
const subject = bits.length ? `Tideline — ${bits.join(', ')}` : 'Tideline — quiet day';

// ── plain text ──────────────────────────────────────────────────────────────
const T = [];
T.push(`TIDELINE`, prettyDate, '');
T.push(`Each stock scores against the range it normally trades in.`);
T.push(`  0  = the cheap edge of that range`);
T.push(`  100 = the expensive edge`);
T.push(`Scores can go past either end. Above 100 means it is more expensive`);
T.push(`than it normally gets; below 0, cheaper. That happens about one day`);
T.push(`in eight, and is a stronger signal than sitting at the edge.`, '');
const textRows = (title, rows, withWas) => {
  if (!rows.length) return;
  T.push(title.toUpperCase());
  for (const r of rows) {
    T.push(`  ${nameOf(r.t)} (${r.t})  —  ${r.s}/100, ${band(r.s)}`);
    T.push(`     ${withWas ? `Was ${r.was} ${r.ago || 'yesterday'}. ` : ''}Share price ${movePct(r.move)}${r.why ? `, ${r.why}` : ''}.`);
  }
  T.push('');
};
textRows('Moved to the cheap end', cheaper, true);
textRows('Moved to the expensive end', pricier, true);
textRows('Quietly got cheaper over the last month', drifting, true);
if (cut.applied.length || cut.held.length) {
  T.push('EARNINGS ESTIMATE UPDATED');
  for (const a of cut.applied)
    T.push(a.retired
      ? `  ${nameOf(a.t)} (${a.t}) removed from coverage.`
      : `  ${nameOf(a.t)} (${a.t}) now uses the market's forecast (${a.from} -> ${a.to} per share) after reporting.`);
  for (const a of cut.held)
    T.push(`  ${nameOf(a.t)} (${a.t}) NEEDS YOUR CALL — ${(a.reasons || [a.reason]).join('; ')}`);
  T.push('');
}
if (quads.length) {
  T.push('CHANGED QUADRANT');
  for (const q of quads) T.push(`  ${nameOf(q.t)} (${q.t})  ${q.from} -> ${q.to}   (${q.fromLabel} -> ${q.toLabel})`);
  T.push('');
}
T.push(`ALERTS — moves over 2% (big caps) or 4% (rest)`);
if (!movers.length) T.push('  Nothing moved that far today.', '');
if (movers.length) {
  for (const r of movers) T.push(`  ${nameOf(r.t)} (${r.t})  ${movePct(r.move)}  —  now ${r.s}/100`);
  T.push('');
}
if (reports.length) {
  T.push('EARNINGS COMING UP');
  for (const r of reports) T.push(`  ${r.date}  ${nameOf(r.t)} (${r.t})`);
  T.push('');
}
if (nothing) T.push('Nothing moved enough to flag today.', '');
T.push('—', 'This is a valuation gauge, not advice. It only knows where the price sits',
  'against the range this stock usually trades in. It knows nothing about the news.', '',
  'Dashboard: https://sachin-imt.github.io/tradingview-mcp-sachin/');
const text = T.join('\n');

// ── html ────────────────────────────────────────────────────────────────────
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const row = (r, withWas) => {
  const col = bandColour(r.s);
  // Simple position bar: a track with a marker at the score.
  const bar = `<div style="position:relative;height:6px;background:#e8e8e8;border-radius:3px;margin:7px 0 0">
      <div style="position:absolute;left:${Math.max(0, Math.min(100, r.s))}%;top:-3px;width:12px;height:12px;
        margin-left:-6px;border-radius:50%;background:${col}"></div></div>`;
  return `<tr><td style="padding:14px 0;border-bottom:1px solid #eee">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font:600 15px -apple-system,Segoe UI,Roboto,sans-serif;color:#111">
        ${esc(nameOf(r.t))} <span style="color:#999;font-weight:400">${esc(r.t)}</span></td>
      <td align="right" style="font:700 20px -apple-system,Segoe UI,Roboto,sans-serif;color:${col};white-space:nowrap">
        ${r.s}<span style="font-size:12px;color:#aaa;font-weight:400">/100</span></td>
    </tr></table>
    ${bar}
    <div style="font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#666;margin-top:8px">
      ${withWas && r.was != null ? `Was <b>${r.was}</b> ${esc(r.ago || 'yesterday')}. ` : ''}Share price ${movePct(r.move)}${r.why ? `, ${esc(r.why)}` : ''}.
      <span style="color:#999">Sitting at the ${band(r.s)} of its normal range.</span>
    </div></td></tr>`;
};
const section = (title, rows, withWas) => rows.length ? `
  <tr><td style="padding:26px 0 4px;font:600 12px -apple-system,Segoe UI,Roboto,sans-serif;
    letter-spacing:.08em;text-transform:uppercase;color:#888">${esc(title)}</td></tr>
  <tr><td><table width="100%" cellpadding="0" cellspacing="0">${rows.map(r => row(r, withWas)).join('')}</table></td></tr>` : '';

const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f6f6f4">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f4;padding:24px 12px">
<tr><td align="center">
<table width="100%" style="max-width:560px;background:#fff;border-radius:10px;padding:28px 26px" cellpadding="0" cellspacing="0">

  <tr><td style="font:700 21px -apple-system,Segoe UI,Roboto,sans-serif;color:#111">Tideline</td></tr>
  <tr><td style="font:14px -apple-system,Segoe UI,Roboto,sans-serif;color:#888;padding-top:3px">${esc(prettyDate)}</td></tr>

  <tr><td style="padding:18px 0 0">
    <div style="background:#f4f7fb;border-left:3px solid #cbd8e8;padding:12px 14px;border-radius:0 6px 6px 0;
      font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#445">
      Each stock scores against the range it normally trades in.<br>
      <b>0</b> = the cheap edge &nbsp;·&nbsp; <b>100</b> = the expensive edge.<br>
      <span style="color:#667">Scores can go past either end &mdash; above 100 is more expensive than it
      normally gets, below 0 is cheaper. Happens roughly one day in eight.</span>
    </div></td></tr>

  ${section('Moved to the cheap end', cheaper, true)}
  ${section('Moved to the expensive end', pricier, true)}
  ${section('Quietly got cheaper over the last month', drifting, true)}
  ${(cut.applied.length || cut.held.length) ? `
  <tr><td style="padding:26px 0 4px;font:600 12px -apple-system,Segoe UI,Roboto,sans-serif;
    letter-spacing:.08em;text-transform:uppercase;color:#888">Earnings estimate updated</td></tr>
  <tr><td style="font:13px/1.7 -apple-system,Segoe UI,Roboto,sans-serif;color:#555;padding-top:4px">
    ${cut.applied.map(a => a.retired
      ? `<b>${esc(nameOf(a.t))}</b> removed from coverage.`
      : `<b>${esc(nameOf(a.t))}</b> now uses the market's forecast (${a.from} &rarr; ${a.to} per share) after reporting.`).join('<br>')}
    ${cut.held.map(a => `<span style="color:#a33"><b>${esc(nameOf(a.t))}</b> needs your call &mdash; ${esc((a.reasons||[a.reason]).join('; '))}</span>`).join('<br>')}
  </td></tr>` : ''}

  ${quads.length ? `
  <tr><td style="padding:26px 0 4px;font:600 12px -apple-system,Segoe UI,Roboto,sans-serif;
    letter-spacing:.08em;text-transform:uppercase;color:#888">Changed quadrant</td></tr>
  <tr><td><table width="100%" cellpadding="0" cellspacing="0">${quads.map(q => `
    <tr><td style="padding:11px 0;border-bottom:1px solid #eee">
      <div style="font:600 15px -apple-system,Segoe UI,Roboto,sans-serif;color:#111">
        ${esc(nameOf(q.t))} <span style="color:#999;font-weight:400">${esc(q.t)}</span></div>
      <div style="font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#666;margin-top:4px">
        <b>${esc(q.from)} &rarr; ${esc(q.to)}</b> &nbsp;
        <span style="color:#999">${esc(q.fromLabel)} &rarr; ${esc(q.toLabel)}</span></div>
    </td></tr>`).join('')}</table></td></tr>` : ''}

  <tr><td style="padding:26px 0 4px;font:600 12px -apple-system,Segoe UI,Roboto,sans-serif;
    letter-spacing:.08em;text-transform:uppercase;color:#888">Alerts &mdash; moves over 2% (big caps) or 4% (rest)</td></tr>
  ${!movers.length ? `<tr><td style="font:14px -apple-system,Segoe UI,Roboto,sans-serif;color:#777;padding:6px 0 0">
    Nothing moved that far today.</td></tr>` : ''}
  ${movers.length ? `
  <tr><td><table width="100%" cellpadding="0" cellspacing="0">${movers.map(r => `
    <tr><td style="padding:9px 0;border-bottom:1px solid #eee;font:14px -apple-system,Segoe UI,Roboto,sans-serif;color:#111">
      ${esc(nameOf(r.t))} <span style="color:#999">${esc(r.t)}</span></td>
    <td align="right" style="padding:9px 0;border-bottom:1px solid #eee;font:600 14px -apple-system,Segoe UI,Roboto,sans-serif;
      color:${r.move >= 0 ? '#1a7f5a' : '#a33'}">${movePct(r.move)}</td>
    <td align="right" style="padding:9px 0 9px 14px;border-bottom:1px solid #eee;font:13px -apple-system,Segoe UI,Roboto,sans-serif;color:#999">
      ${r.s}/100</td></tr>`).join('')}</table></td></tr>` : ''}

  ${reports.length ? `
  <tr><td style="padding:26px 0 4px;font:600 12px -apple-system,Segoe UI,Roboto,sans-serif;
    letter-spacing:.08em;text-transform:uppercase;color:#888">Earnings coming up</td></tr>
  <tr><td style="font:13px/1.9 -apple-system,Segoe UI,Roboto,sans-serif;color:#555">
    ${reports.map(r => `${esc(r.date)} &nbsp; <b>${esc(nameOf(r.t))}</b>`).join('<br>')}</td></tr>` : ''}

  ${nothing ? `<tr><td style="padding:26px 0;font:14px -apple-system,Segoe UI,Roboto,sans-serif;color:#666">
    Nothing moved enough to flag today.</td></tr>` : ''}

  <tr><td style="padding:26px 0 0;border-top:1px solid #eee">
    <div style="font:12px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#999">
      This is a valuation gauge, not advice. It only knows where the price sits against the range
      this stock usually trades in &mdash; nothing about the news or the business.
    </div>
    <div style="padding-top:12px">
      <a href="https://sachin-imt.github.io/tradingview-mcp-sachin/"
        style="font:13px -apple-system,Segoe UI,Roboto,sans-serif;color:#2c6bb3;text-decoration:none">View the dashboard &rarr;</a>
    </div></td></tr>

</table></td></tr></table></body></html>`;

if (DRY) { console.log(SHOW_HTML ? html : `Subject: ${subject}\n\n${text}`); process.exit(0); }

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
    let buf = '', waiting = null; const queue = [];
    sock.setEncoding('utf8');
    sock.setTimeout(30000, () => reject(new Error('SMTP timeout')));
    sock.on('error', reject);
    sock.on('data', chunk => {
      buf += chunk;
      let m;
      while ((m = buf.match(/^(?:\d{3}-[^\n]*\n)*(\d{3}) [^\n]*\n/))) {
        const code = Number(m[1]), full = m[0];
        buf = buf.slice(full.length);
        if (waiting) { const w = waiting; waiting = null; w(code, full); }
      }
      pump();
    });
    const say = (line, expect) => new Promise((res, rej) => {
      queue.push(() => {
        waiting = (code, full) => {
          if (expect && !expect.includes(code)) return rej(new Error(`SMTP ${code}: ${full.trim()}`));
          res(code);
        };
        if (line !== null) sock.write(line);
      });
      pump();
    });
    function pump() { if (!queue.length || waiting) return; queue.shift()(); }

    (async () => {
      await say(null, [220]);
      await say(`EHLO localhost\r\n`, [250]);
      await say(`AUTH LOGIN\r\n`, [334]);
      await say(`${b64(SMTP_USER)}\r\n`, [334]);
      await say(`${b64(SMTP_PASS)}\r\n`, [235]);
      await say(`MAIL FROM:<${SMTP_USER}>\r\n`, [250]);
      await say(`RCPT TO:<${BRIEF_TO}>\r\n`, [250, 251]);
      await say(`DATA\r\n`, [354]);
      const bnd = 'b_' + Math.random().toString(36).slice(2);
      const stuff = s => s.split('\n').map(l => (l === '.' ? '..' : l)).join('\r\n');
      const msg = [
        `From: Tideline <${SMTP_USER}>`,
        `To: ${BRIEF_TO}`,
        `Subject: ${subject}`,
        `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${bnd}"`,
        '', `--${bnd}`,
        'Content-Type: text/plain; charset=utf-8', '', stuff(text),
        `--${bnd}`,
        'Content-Type: text/html; charset=utf-8', '', stuff(html),
        `--${bnd}--`, ''
      ].join('\r\n');
      await say(`${msg}\r\n.\r\n`, [250]);
      await say(`QUIT\r\n`, [221]);
      sock.end();
      resolve();
    })().catch(reject);
  });
}

smtpSend().then(() => {
  writeFileSync(sentPath, JSON.stringify({ date: b.date, sentAt: new Date().toISOString(), to: BRIEF_TO, subject }, null, 2) + '\n');
  console.log(`✓ Sent "${subject}" to ${BRIEF_TO}`);
}).catch(e => { console.error(`Send failed: ${e.message}`); process.exit(1); });
