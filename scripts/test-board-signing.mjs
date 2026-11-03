/**
 * test-board-signing.mjs: how the board signs, in a real browser
 * ================================================================
 * Serves public/ (with the admin's real CSP) and answers /api/board-* with the real handlers behind the real
 * sign-in middleware, on an in-memory D1 and R2 (as scripts/test-board.mjs does). Made-up people only.
 *   - a member on their phone (390): the paper's due date; "Can't sign it as written?" with why, the admins
 *     emailed; How signing works; then signing it after all (initials, the answer, a typed signature, agreeing
 *     to sign electronically); their signed copy to download once it's made, and their signed copies by year
 *   - another member declines on a laptop
 *   - a founder (1440): Board → Members says Declined, turns Remind by email on (asked first), shows a member's
 *     code to sign in person, opens a signed copy; Documents → Who's signed with the reason, the due date in the
 *     editor, the year's record downloaded as a ZIP
 *   - at 390 and 1440: nothing past the edge, no console errors
 * Screenshots land in test-results/board-signing/. Exits non-zero on any failure.
 *
 *   node scripts/test-board-signing.mjs
 */
import puppeteer from 'puppeteer';
import http from 'node:http';
import { mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import { answerAsks } from './lib/ask.mjs';
import { onRequest as middleware, _resetKeyCacheForTests } from '../functions/api/_middleware.js';
import * as boardAdmin from '../functions/api/board-admin.js';
import * as boardPortal from '../functions/api/board-portal.js';
import * as boardFile from '../functions/api/board-file.js';
import { ensureSchema, saveDoc, putFile, listDocs } from '../functions/api/_board.js';
import { buildRecord, maybeRemindSigners } from '../functions/api/_board-sign.js';
import { writeState } from '../functions/api/_board-roles.js';
import { boardSignIns } from '../functions/api/_board-access.js';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/board-signing/');
mkdirSync(OUT, { recursive: true });
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

const FOUNDER = 'jane@soardcharity.com';
const MEMBER = 'alex.board@example.com';
const OTHER = 'sam.board@example.org';
const PEOPLE = {
  'jane-doe': { name: 'Jane Doe', group: 'team', title: 'Co-Founder/President', order: 1 },
  'alex-rivera': { name: 'Alex Rivera', group: 'board', title: 'Board Chair', organization: 'Rivera Builders', order: 1 },
  'sam-ortiz': { name: 'Sam Ortiz', group: 'board', title: 'Board Treasurer', order: 2 },
  'kim-park': { name: 'Kim Park', group: 'board', title: 'Board Member', order: 3 },
};

const certsKey = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', certsKey.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
// Each person's sign-in happened once, an hour ago (the token's iat)
const signedAt = Math.floor(Date.now() / 1000) - 3600;
async function tokenFor(email) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ iss: 'https://soard.cloudflareaccess.com', aud: ['aud-tag'], email, iat: signedAt, nbf: signedAt, exp: now + 3600 }));
  return `${h}.${p}.${b64u(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', certsKey.privateKey, new TextEncoder().encode(`${h}.${p}`))))}`;
}
class FakeR2 {
  constructor() { this.map = new Map(); }
  async put(key, bytes, opts) { this.map.set(key, { bytes: new Uint8Array(bytes), type: opts?.httpMetadata?.contentType }); }
  async get(key) { const o = this.map.get(key); return o ? { body: o.bytes, size: o.bytes.length, httpMetadata: { contentType: o.type } } : null; }
  async delete(key) { this.map.delete(key); }
}

const DB = await createD1();
for (const sql of [
  'CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)',
  'CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)',
  'CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)',
  'CREATE TABLE kids (slug TEXT PRIMARY KEY, name TEXT, year INTEGER, data TEXT)',
  'CREATE TABLE community (slug TEXT PRIMARY KEY, data TEXT)',
  'CREATE TABLE events (slug TEXT PRIMARY KEY, data TEXT)',
  'CREATE TABLE audit_log (id INTEGER PRIMARY KEY, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)',
]) await DB.exec(sql);
for (const [slug, d] of Object.entries(PEOPLE)) await DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.group, JSON.stringify(d)).run();
for (const [slug, email] of [['alex-rivera', MEMBER], ['sam-ortiz', OTHER], ['kim-park', 'kim.board@example.com']]) await DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind(slug, email).run();

const env = { DB, FILES: new FakeR2(), CF_ACCESS_TEAM_DOMAIN: 'soard', CF_ACCESS_AUD: 'aud-tag', RESEND_API_KEY: 're_test' };
const mail = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === 'https://soard.cloudflareaccess.com/cdn-cgi/access/certs') return Response.json({ keys: [jwk] });
  if (url.startsWith('https://api.resend.com/')) { const b = JSON.parse(init.body); const list = Array.isArray(b) ? b : [b]; mail.push(...list); return Response.json({ data: list.map((_, i) => ({ id: `em_${i}` })) }); }
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url)) throw new Error(`unexpected outside call ${url}`);
  return realFetch(input, init);
};
_resetKeyCacheForTests();

await ensureSchema(DB);
const YEAR = Number(day(0).slice(0, 4));
// The expectations, marked for initials and an answer, due January 31; a paper read as its PDF
const BODY = '### Attendance\n\n- Attend three of four board meetings {initials}\n\n### Giving\n\n- Annual minimum $6,000.00 Donation/Sponsorship {initials}\n- My giving commitment for the year: {answer}\n\nI have read and agreed to the terms of this commitment document.';
const exp = await saveDoc(DB, { title: 'Board Member Expectations', kind: 'policy', body: BODY, sign: true, shared: true, due: '01-31' }, { by: FOUNDER });
const pdfOf = async (title) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText(title, { x: 72, y: 700, size: 20, font });
  return Buffer.from(await doc.save());
};
const coi = await saveDoc(DB, { title: 'Conflict of Interest Policy', kind: 'policy', sign: true, shared: true }, { by: FOUNDER });
await putFile(env, { ownerType: 'doc', ownerId: coi.id, file: new File([await pdfOf('Conflict of Interest Policy')], 'Conflict of Interest Policy.pdf', { type: 'application/pdf' }) });
// Everyone has been on the board page (so nobody's row is about the sign-in email)
for (const slug of Object.keys(PEOPLE)) await DB.prepare('INSERT OR REPLACE INTO board_seen (slug, at) VALUES (?, ?)').bind(slug, new Date(Date.now() - 3600e3).toISOString()).run();
await writeState(DB, 'welcome', { sentAt: new Date(Date.now() - 30 * 86400e3).toISOString(), members: {}, addresses: {} });
// The board page's sign-in works (Cloudflare's list kept to the board), so Members can ask, remind and show the code
{ const { emails } = await boardSignIns(DB); const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(emails.join('\n')))); await writeState(DB, 'access', { groupId: 'g1', hash: [...b.slice(0, 8)].map((x) => x.toString(16).padStart(2, '0')).join('') }); }
// The server's browser, for the signed copy: a real PDF of the page's words (Cloudflare's browser isn't here)
const fakeRender = async () => { const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica); d.addPage([612, 792]).drawText('printed', { x: 72, y: 700, size: 12, font: f }); return d.save(); };

const ROUTES = { '/api/board-admin': boardAdmin, '/api/board-portal': boardPortal, '/api/board-file': boardFile };
const csp = (() => {
  const lines = readFileSync(join(ROOT, 'public/_headers'), 'utf8').split('\n');
  const at = lines.findIndex((l) => l.trim() === '/admin/*');
  return lines.slice(at + 1).find((l) => /^\s+Content-Security-Policy:/.test(l)).split('Content-Security-Policy:')[1].trim();
})();
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const who = req.headers['x-test-user'] || '';
    if (url.pathname === '/cdn-cgi/access/get-identity') { res.writeHead(who ? 200 : 401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(who ? { email: who, name: '' } : {})); return; }
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !['host', 'connection', 'content-length'].includes(k)) headers.set(k, v);
      if (who) headers.set('CF-Access-JWT-Assertion', await tokenFor(who));
      const request = new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks), duplex: 'half' });
      // (Pages' waitUntil: what runs after the answer, the admins' email about a decline say)
      const ctx = { request, env, data: {}, waitUntil: (p) => { Promise.resolve(p).catch((err) => console.error('waitUntil', err)); } };
      ctx.next = async () => {
        const fn = ROUTES[url.pathname]?.[`onRequest${req.method[0]}${req.method.slice(1).toLowerCase()}`];
        if (fn) return fn(ctx);
        return Response.json({ success: true, ok: true, items: [], pages: 1, files: [], entries: [] });
      };
      const out = await middleware(ctx);
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
      return;
    }
    let file = join(ROOT, 'public', decodeURIComponent(url.pathname));
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) { res.writeHead(404); res.end('Not found'); return; }
    const head = { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' };
    if (url.pathname.startsWith('/admin/')) head['Content-Security-Policy'] = csp;
    res.writeHead(200, head);
    res.end(readFileSync(file));
  } catch (err) {
    console.error('server', err);
    res.writeHead(500); res.end(String(err));
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const SITE = `http://localhost:${server.address().port}`;

const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-gpu', '--disable-gpu-vsync', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'] });
const consoleErrors = [];
async function tab(email, width = 1440) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900, deviceScaleFactor: 1, isMobile: width < 600, hasTouch: width < 600 });
  await page.setExtraHTTPHeaders({ 'x-test-user': email });
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource|sunshineonaranneyday\.com\/cdn-cgi\/imagedelivery|x-test-user/.test(msg.text())) consoleErrors.push(`${email} ${width}: ${msg.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`${email} ${width}: ${e.message}`));
  await answerAsks(page);
  return page;
}
const waitText = (page, re, timeout = 8000) => page.waitForFunction((src) => new RegExp(src).test(document.body.innerText), { timeout }, re.source).then(() => true, () => false);
const clickText = (page, selector, re) => page.evaluate((sel, src) => {
  const el = [...document.querySelectorAll(sel)].find((e) => new RegExp(src).test(e.textContent.trim()));
  if (el) el.click();
  return !!el;
}, selector, re.source);
const overflow = (page) => page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
async function shot(page, name) {
  const vp = page.viewport();
  const h = await page.evaluate(() => Math.min(6000, document.scrollingElement.scrollHeight));
  await page.setViewport({ ...vp, height: Math.max(vp.height, h) });
  await sleep(250);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  await page.setViewport(vp);
}

try {
  // ── Alex, on their phone
  const alex = await tab(MEMBER, 390);
  await alex.goto(`${SITE}/admin/board/#/documents/${exp.id}`, { waitUntil: 'networkidle0' });
  await alex.waitForSelector('.bp-sign', { timeout: 8000 });
  // (due January 31: ahead in January, gone by the rest of the year, and said as such)
  ok(await waitText(alex, day(0) <= `${YEAR}-01-31` ? /Sign by January 31\s+By choosing Sign, I sign the Board Member Expectations for \d{4}\./ : /Was due January 31\s+By choosing Sign, I sign the Board Member Expectations for \d{4}\./), 'the paper says when it’s due, or that it was, apart from what they agree to');
  // How signing works: there to open, in plain words
  await alex.evaluate(() => document.querySelector('.bp-sign__how summary')?.click());
  ok(await alex.evaluate(() => document.querySelector('.bp-sign__how')?.open && /a code emailed to you/.test(document.querySelector('.bp-sign__how p')?.textContent || '')), 'How signing works opens');
  // Can't sign it as written
  ok(await clickText(alex, '.bp-sign__or button', /^Tell SOARD why$/), 'Can’t sign it as written? Tell SOARD why');
  await alex.waitForSelector('.bp-sign__decline textarea', { timeout: 3000 });
  ok(await alex.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA', { timeout: 2000 }).then(() => true, () => false), 'the box has the focus');
  await clickText(alex, '.bp-sign__decline button', /^Send to SOARD$/);
  ok(await waitText(alex, /Say what you can’t agree to, so SOARD can answer\./), 'an empty reason is asked for');
  await alex.type('.bp-sign__decline textarea', 'The $6,000 minimum is more than I can give this year.');
  mail.length = 0;
  await clickText(alex, '.bp-sign__decline button', /^Send to SOARD$/);
  ok(await waitText(alex, /You told SOARD on [A-Z][a-z]{2} \d+, \d{4} that you can’t sign it as written: “The \$6,000 minimum is more than I can give this year\.” They’ll answer you by email, and you can still sign it here\./), 'their page says what they told SOARD, and that they can still sign');
  await sleep(300);
  ok(mail.some((m) => /^Alex Rivera can’t sign the Board Member Expectations as written$/.test(m.subject) && m.to.includes(FOUNDER)), `the admins are emailed (${mail.map((m) => m.subject).join(' | ')})`);
  ok((await overflow(alex)) <= 0, 'nothing past the edge at 390');
  await shot(alex, 'member-declined-390');
  // Signing it after all: each initial, the answer, a typed signature, agreeing once
  const initials = await alex.$$('.bp-field__btn');
  ok(initials.length === 2, `two points to initial (${initials.length})`);
  await initials[0].click();
  await alex.waitForSelector('dialog.bp-adopt[open] #bp-adopt-name', { timeout: 4000 });
  await alex.$eval('#bp-adopt-name', (i) => { i.value = ''; });
  await alex.type('#bp-adopt-name', 'Alex Rivera');
  await alex.click('.bp-adopt button[type="submit"]');
  await sleep(300);
  await sleep(200);
  ok(await alex.evaluate(() => document.activeElement?.matches?.('.bp-field__btn')), 'once adopted, the first point is initialed and the focus is on the next one to initial');
  // (a person taps once the page has scrolled to the next point)
  for (const b of await alex.$$('.bp-field__btn')) { await sleep(700); await b.click(); }
  await sleep(700);
  ok(await alex.evaluate(() => document.activeElement?.matches?.('input.bp-field__input')), 'then on the answer');
  await alex.type('input.bp-field__input', '$6,000 as a Reveal Day sponsor');
  await sleep(700);
  // (scrolled to the middle first, as a person would: at the bottom it's under the signing bar and the tab bar)
  await alex.$eval('.bp-sign__agree input', (el) => el.scrollIntoView({ block: 'center' }));
  await sleep(200);
  await alex.click('.bp-sign__agree input');
  await sleep(300);
  await clickText(alex, '.bp-sign button[type="submit"]', /^Sign$/);
  const signedOk = await waitText(alex, /Signed: Board Member Expectations\. Thank you\./, 10000);
  if (!signedOk) { await shot(alex, 'debug-not-signed'); console.log('DEBUG', (await alex.evaluate(() => document.querySelector('.bp-docpage__sign')?.innerText || document.body.innerText.slice(0, 600))).replace(/\s+/g, ' ').slice(0, 700)); }
  ok(signedOk, `signed${signedOk ? '' : ` (${await alex.evaluate(() => [document.querySelector('.bp-sign__problem')?.textContent, document.querySelector('.bp-toast')?.textContent, document.querySelector('.bp-sign__agree input')?.checked, document.querySelector('dialog.bp-adopt[open]') ? 'dialog open' : ''].join(' | '))})`}`);
  const row = await DB.prepare("SELECT * FROM board_signatures WHERE slug = 'alex-rivera' AND doc_id = ?").bind(exp.id).first();
  ok(row && JSON.parse(row.fields).map((f) => f.value).join('|') === 'AR|AR|$6,000 as a Reveal Day sponsor' && row.process_v === 1, 'kept with each initial and the answer');
  ok(!(await listDocs(DB)).find((d) => d.id === exp.id).declined['alex-rivera'], 'Declined ends once they sign');
  // Their signed copy, once it's made (the server's browser, here a stand-in)
  const made = await buildRecord(env, { docId: exp.id, slug: 'alex-rivera', year: YEAR }, { render: fakeRender });
  ok(made.built, 'the signed copy is made');
  // (and last year's, signed then: kept, theirs to open again)
  const lastYears = await putFile(env, { ownerType: 'record', ownerId: exp.id, slug: 'alex-rivera', by: 'SOARD board page', file: new File([await pdfOf(`Signed ${YEAR - 1}`)], `Board Member Expectations, signed by Alex Rivera ${YEAR - 1}.pdf`, { type: 'application/pdf' }) });
  await DB.prepare('INSERT INTO board_signatures (doc_id, slug, year, version, name, at, how, record_id) VALUES (?, ?, ?, 1, ?, ?, ?, ?)').bind(exp.id, 'alex-rivera', YEAR - 1, 'Alex Rivera', `${YEAR - 1}-03-02T15:00:00.000Z`, 'typed', lastYears.id).run();
  await alex.reload({ waitUntil: 'networkidle0' });
  await alex.waitForSelector('.bp-signed', { timeout: 8000 });
  ok(await waitText(alex, /Your signed copy \(PDF\)/), 'Your signed copy (PDF) to open');
  ok(await waitText(alex, new RegExp(`Your signed copies\\s+Your ${YEAR - 1} signed copy · signed Mar 2, ${YEAR - 1}`)), `their signed copies from other years, this year’s in its card (${(await alex.evaluate(() => document.querySelector('.bp-copies')?.innerText || document.querySelector('.bp-docpage__sign')?.innerText || '')).replace(/\s+/g, ' ').slice(0, 300)})`);
  ok((await overflow(alex)) <= 0, 'nothing past the edge at 390, signed');
  await shot(alex, 'member-signed-390');

  // ── Sam declines on a laptop
  const sam = await tab(OTHER, 1440);
  await sam.goto(`${SITE}/admin/board/#/documents/${exp.id}`, { waitUntil: 'networkidle0' });
  await sam.waitForSelector('.bp-sign', { timeout: 8000 });
  await clickText(sam, '.bp-sign__or button', /^Tell SOARD why$/);
  await sam.waitForSelector('.bp-sign__decline textarea', { timeout: 3000 });
  await sam.type('.bp-sign__decline textarea', 'The attendance rule: I travel every other month.');
  await clickText(sam, '.bp-sign__decline button', /^Send to SOARD$/);
  ok(await waitText(sam, /You told SOARD on/), 'Sam’s decline is in');
  await sam.close();

  // ── Jane, the founder: Members
  const jane = await tab(FOUNDER, 1440);
  await jane.goto(`${SITE}/admin/#board/members`, { waitUntil: 'networkidle0' });
  await jane.waitForSelector('.ba-table', { timeout: 10000 });
  const samRow = await jane.evaluate(() => [...document.querySelectorAll('.ba-tr')].find((r) => /Sam Ortiz/.test(r.innerText))?.innerText || '');
  ok(/Declined/.test(samRow), `Sam’s row says Declined (${samRow.replace(/\s+/g, ' ').slice(0, 140)})`);
  // Remind by email: off, then on (asked first)
  ok(await jane.evaluate(() => document.querySelector('.ba-remind select')?.value === 'off'), 'Remind by email starts off');
  await jane.select('.ba-remind select', '3');
  ok(await waitText(jane, /Reminders are on, every 3 days\./), 'turned on, after saying who gets what');
  ok((await DB.prepare("SELECT data FROM board_state WHERE key = 'settings'").first().then((r) => JSON.parse(r.data))).remind === '3', 'saved');
  await jane.select('.ba-remind select', 'off');
  ok(await waitText(jane, /Reminders are off\./), 'and off again');
  // Kim's sheet: Sign in person
  await jane.evaluate(() => [...document.querySelectorAll('.ba-name')].find((b) => /Kim Park/.test(b.textContent))?.click());
  await jane.waitForSelector('.ba-dialog', { timeout: 4000 });
  ok(await clickText(jane, '.ba-dialog button', /^Sign in person$/), 'Sign in person');
  const qr = await jane.evaluate(() => ({ svg: !!document.querySelector('.ba-qr__code svg rect, .ba-qr__code svg path'), url: document.querySelector('.ba-qr__url')?.textContent || '' }));
  ok(qr.svg && /\/board\/documents$/.test(qr.url), `a code for Kim’s phone, to her papers (${JSON.stringify(qr)})`);
  await shot(jane, 'members-inperson-1440');
  await jane.keyboard.press('Escape');
  // Alex's sheet: the signed copy
  await jane.evaluate(() => [...document.querySelectorAll('.ba-name')].find((b) => /Alex Rivera/.test(b.textContent))?.click());
  await jane.waitForSelector('.ba-dialog', { timeout: 4000 });
  ok(await waitText(jane, /Signed copy \(PDF\)/), 'Alex’s signed copy, from their sheet');
  await jane.keyboard.press('Escape');
  ok((await overflow(jane)) <= 0, 'Members: nothing past the edge');
  // Documents: Who's signed, the due date, the year's record
  await jane.goto(`${SITE}/admin/#board/documents`, { waitUntil: 'networkidle0' });
  await jane.waitForSelector('[data-edit]', { timeout: 10000 });
  ok(await waitText(jane, /Due January 31 each year/), 'the paper’s row says when it’s due');
  await jane.evaluate((id) => [...document.querySelectorAll('.bd-row')].find((r) => r.querySelector(`[data-edit="${id}"]`))?.querySelector('button[aria-expanded]')?.click(), exp.id);
  ok(await waitText(jane, /Declined on [A-Z][a-z]{2} \d+, \d{4}: The attendance rule: I travel every other month\./), `Who’s signed: Declined, with why (${(await jane.evaluate(() => [...document.querySelectorAll('.bd-signer')].map((x) => x.innerText).join(' | '))).replace(/\s+/g, ' ').slice(0, 400)})`);
  const href = await jane.evaluate(() => [...document.querySelectorAll('.bd-signers__foot a')].find((a) => /^Download the \d{4} record$/.test(a.textContent.trim()))?.getAttribute('href') || '');
  ok(new RegExp(`^/api/board-admin\\?record=${exp.id}&year=${YEAR}$`).test(href), `Download the ${YEAR} record (${href})`);
  const zip = await jane.evaluate(async (u) => { const r = await fetch(u); const b = new Uint8Array(await r.arrayBuffer()); return { status: r.status, type: r.headers.get('Content-Type'), pk: b[0] === 0x50 && b[1] === 0x4b, size: b.length }; }, href);
  ok(zip.status === 200 && zip.type === 'application/zip' && zip.pk && zip.size > 1000, `it downloads a ZIP (${JSON.stringify(zip)})`);
  await shot(jane, 'documents-signers-1440');
  await jane.click(`[data-edit="${exp.id}"]`);
  await jane.waitForSelector('#bd-doc-due', { timeout: 6000 });
  ok(await jane.$eval('#bd-doc-due', (i) => i.value) === `${YEAR}-01-31`, 'the editor has its due date');
  // Enter in the middle of a point marked for an answer: the mark stays on that point, the new one has none
  const marksBefore = await jane.evaluate(() => document.querySelectorAll('.rp-edit p[data-field]').length);
  await jane.evaluate(() => {
    const p = document.querySelector('.rp-edit p[data-field="answer"]');
    const t = p.firstChild;
    const r = document.createRange();
    r.setStart(t, Math.floor(t.textContent.length / 2));
    r.collapse(true);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    p.closest('.rp-edit').focus();
  });
  await jane.keyboard.press('Enter');
  await sleep(200);
  ok(await jane.evaluate(() => document.querySelectorAll('.rp-edit p[data-field]').length) === marksBefore, `Enter mid-point keeps one mark (${marksBefore})`);
  await clickText(jane, 'button', /^Cancel$/);
  // On a phone, the founder's Members
  const janePhone = await tab(FOUNDER, 390);
  await janePhone.goto(`${SITE}/admin/#board/members`, { waitUntil: 'networkidle0' });
  await janePhone.waitForSelector('.ba-table', { timeout: 10000 });
  ok((await overflow(janePhone)) <= 0, 'Members at 390: nothing past the edge');
  await shot(janePhone, 'members-390');
  ok(!consoleErrors.length, `no console errors${consoleErrors.length ? `: ${consoleErrors.slice(0, 3).join(' | ')}` : ''}`);
} catch (err) {
  failures.push(`crashed: ${err.stack || err}`);
  console.error(err);
} finally {
  await browser.close();
  server.close();
}
if (failures.length) { console.log(`\n${failures.length} failed:\n- ${failures.join('\n- ')}`); process.exit(1); }
console.log('\nAll signing checks passed. Screenshots in test-results/board-signing/');
process.exit(0);
