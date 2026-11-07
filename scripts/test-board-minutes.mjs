/**
 * test-board-minutes.mjs: the minutes after the meeting, in a real browser
 * ================================================================
 * The real handlers behind the real sign-in middleware on an in-memory D1 and R2, as scripts/test-board-signing.mjs
 * does. Made-up people only (the repo is public).
 *   - the secretary sends typed notes: the lines that read as to-dos are offered, added with who and by when
 *   - a member on their phone reads the draft, suggests a correction, takes it back, suggests it again
 *   - another marks who was there and says something else
 *   - the secretary sees them under For you and makes one in a press; a founder keeps another as it is
 *   - the vote on the next meeting approves them, and the secretary signs them on the page
 *   - Board: corrections and the signature in After, action item reminders off until turned on
 *   - at 390 and 1440: nothing past the edge, no console errors
 * Screenshots land in test-results/board-minutes/. Exits non-zero on any failure.
 *
 *   node scripts/test-board-minutes.mjs
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
import { ensureSchema, saveMeeting, getMeeting } from '../functions/api/_board.js';
import { buildMinutesRecord } from '../functions/api/_board-minutes-sign.js';
import { saveNotes, sendNotes } from '../functions/api/_board-notes.js';
import { writeState } from '../functions/api/_board-roles.js';
import { boardSignIns } from '../functions/api/_board-access.js';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/board-minutes/');
mkdirSync(OUT, { recursive: true });
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

const FOUNDER = 'jane@soardcharity.com';
const SECRETARY = 'kim.board@example.com';
const MEMBER = 'sam.board@example.org';
const OTHER = 'alex.board@example.com';
const PEOPLE = {
  'jane-doe': { name: 'Jane Doe', group: 'team', title: 'Co-Founder/President', order: 1 },
  'alex-rivera': { name: 'Alex Rivera', group: 'board', title: 'Board Chair', organization: 'Rivera Builders', order: 1 },
  'sam-ortiz': { name: 'Sam Ortiz', group: 'board', title: 'Board Treasurer', order: 2 },
  'kim-park': { name: 'Kim Park', group: 'board', title: 'Board Secretary', order: 3 },
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
for (const [slug, email] of [['alex-rivera', OTHER], ['sam-ortiz', MEMBER], ['kim-park', SECRETARY]]) await DB.prepare('INSERT INTO reveal_board_emails (slug, email, updated_at) VALUES (?, ?, ?)').bind(slug, email, new Date().toISOString()).run();
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
// Everyone has been on the board page (so nobody's row is about the sign-in email)
for (const slug of Object.keys(PEOPLE)) await DB.prepare('INSERT OR REPLACE INTO board_seen (slug, at) VALUES (?, ?)').bind(slug, new Date(Date.now() - 3600e3).toISOString()).run();
await writeState(DB, 'welcome', { sentAt: new Date(Date.now() - 30 * 86400e3).toISOString(), members: {}, addresses: {} });
// The board page's sign-in works (Cloudflare's list kept to the board), so Members can ask, remind and show the code
{ const { emails } = await boardSignIns(DB); const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(emails.join('\n')))); await writeState(DB, 'access', { groupId: 'g1', hash: [...b.slice(0, 8)].map((x) => x.toString(16).padStart(2, '0')).join('') }); }
// The server's browser, for the signed copy: a real PDF of the page's words (Cloudflare's browser isn't here)
const fakeRender = async () => { const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica); d.addPage([612, 792]).drawText('printed', { x: 72, y: 700, size: 12, font: f }); return d.save(); };

// The last meeting, its notes typed and not sent; the next one, whose vote approves them
const ID = 'm_q4minutes';
const NEXT = 'm_nextmeet1';
const KIM = { member: { slug: 'kim-park', name: 'Kim Park', email: SECRETARY, seat: 'secretary' }, admin: false };
await saveMeeting(DB, {
  id: ID, date: day(-10), start: '08:00', end: '10:00', title: 'Q4 Board Meeting', shared: true, location: 'The office',
  attendance: Object.entries(PEOPLE).filter(([, p]) => p.group === 'board').map(([slug, p]) => ({ slug, name: p.name, kind: 'board' })),
  sections: [
    { id: 's_reports', title: 'Committee reports', items: [{ id: 'i_events', title: 'Events Committee' }, { id: 'i_fin', title: 'Financial' }] },
    { id: 's_new', title: 'New business', items: [{ id: 'i_page', title: 'The board page' }] },
  ],
}, { by: FOUNDER });
await saveMeeting(DB, { id: NEXT, date: day(-1), start: '08:00', end: '10:00', title: 'Q1 Board Meeting', shared: true, attendance: [], sections: [{ id: 's_min', title: 'Approve meeting minutes', items: [{ id: 'i_min', title: 'The minutes', live: 'minutes', about: ID }] }] }, { by: FOUNDER });
await saveMeeting(DB, { id: 'm_ahead0001', date: day(60), start: '08:00', end: '10:00', title: 'Q2 Board Meeting', shared: true, attendance: [], sections: [] }, { by: FOUNDER });
await saveNotes(env, ID, { changes: {
  'r:alex-rivera': 'present', 'r:sam-ortiz': 'present', 'r:kim-park': 'present',
  'n:i_events': 'Gala date: Aug 28\nSame venue\n\nGolf tournament May 11 or 17\nHill Country Club\nSam to confirm by end of December',
  'n:i_fin': 'Revenue is up 87%\nGrant revenue up to $142k',
  'n:i_page': 'Pulling fresh data\nJane to send out the link\nKim to fix the typo',
} }, KIM);
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
  // ── The secretary sends them: the to-dos in the notes are offered, in their own words
  const kim = await tab(SECRETARY);
  await kim.goto(`${SITE}/admin/board/#/meetings/${ID}`, { waitUntil: 'networkidle0' });
  await kim.waitForSelector('.bp-minutes__open', { timeout: 8000 });
  await kim.click('.bp-minutes__open');
  await kim.waitForSelector('.bn-found', { timeout: 8000 });
  const lines = await kim.$$eval('.bn-found li p', (x) => x.map((e) => e.textContent));
  ok(JSON.stringify(lines) === JSON.stringify(['Golf tournament May 11 or 17: Sam to confirm by end of December', 'The board page: Jane to send out the link', 'The board page: Kim to fix the typo']), `the to-dos in the notes are found (${lines.join(' | ')})`);
  ok(await kim.$eval('.bn-found li small', (e) => /^Sam Ortiz · by Dec 31$/.test(e.textContent)), 'with who and by when');
  await clickText(kim, '.bn-found li:nth-child(3) button', /^Not a to-do$/);
  ok(await kim.waitForFunction(() => document.querySelectorAll('.bn-found li').length === 2, { timeout: 3000 }).then(() => true, () => false), 'Not a to-do takes one away');
  await shot(kim, 'notes-found');
  await clickText(kim, '.bn-send', /^Send the minutes$/);
  ok(await waitText(kim, /2 lines read like to-dos and aren’t action items yet\./), 'Send asks about them first');
  await shot(kim, 'notes-ask');
  await clickText(kim, '.bn-send', /^Add them and send$/);
  ok(await waitText(kim, /Thank you\. Board has the minutes/), 'Add them and send');
  await sleep(300);
  {
    const m = await getMeeting(DB, ID);
    ok(m.actions.length === 2 && m.actions[0].owner === 'sam-ortiz' && /-12-31$/.test(m.actions[0].due) && m.actions[0].from === 'i_events' && m.actions[1].owner === 'jane-doe', `they’re action items (${JSON.stringify(m.actions.map((a) => [a.owner, a.due, a.from]))})`);
    ok(!!m.minutesFrom.first, 'when they first went in is kept');
  }
  await clickText(kim, '.bn-close', /^$/);

  // ── A member on their phone: their to-do, then the draft
  const sam = await tab(MEMBER, 390);
  await sam.goto(`${SITE}/admin/board/`, { waitUntil: 'networkidle0' });
  ok(await waitText(sam, /Golf tournament May 11 or 17: Sam to confirm by end of December/), 'the to-do is on their Home');
  await sam.goto(`${SITE}/admin/board/#/meetings/${ID}`, { waitUntil: 'networkidle0' });
  ok(await waitText(sam, /Read before the vote/) && await waitText(sam, /The board votes on these at the Q2 Board Meeting/), 'the draft says when the vote is, the next meeting still to come');
  const offers = await sam.$$eval('.mfix-open', (x) => x.map((e) => e.textContent));
  ok(offers.filter((t) => t === 'Suggest a correction').length >= 3 && offers.includes('Correct who was there'), `a correction can start anywhere (${offers.length})`);
  ok(await sam.$$eval('.mfix-open', (x) => x.every((e) => e.getBoundingClientRect().height >= 44)), 'each one is a full tap tall on a phone');
  ok(await sam.$eval('#i-i_fin .mfix-open', (e) => /^Suggest a correction: Financial$/.test(e.getAttribute('aria-label') || '')), 'each says what it’s about to a screen reader');
  ok(await sam.$eval('#i-i_fin .mfix-open', (e) => Math.abs(e.getBoundingClientRect().left - e.closest('.bp-agitem__body').getBoundingClientRect().left) < 3), 'Suggest a correction lines up with the words');
  mail.length = 0;
  await clickText(sam, '#i-i_fin .mfix-open', /Suggest a correction/);
  await sam.waitForSelector('#i-i_fin textarea', { timeout: 3000 });
  ok(await sam.waitForFunction(() => { const t = document.querySelector('#i-i_fin textarea'); return t.value === 'Revenue is up 87%\nGrant revenue up to $142k' && document.activeElement === t; }, { timeout: 3000 }).then(() => true, () => false), 'the box opens on the words, with the focus');
  await sam.evaluate(() => { const t = document.querySelector('#i-i_fin textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'Revenue is up 78%\nGrant revenue up to $142k'); t.dispatchEvent(new Event('input', { bubbles: true })); });
  await clickText(sam, '#i-i_fin button', /^Send the correction$/);
  ok(await waitText(sam, /You suggested this correction/), 'it’s theirs, waiting');
  ok(await sam.waitForFunction(() => /^c-/.test(document.activeElement?.id || ''), { timeout: 3000 }).then(() => true, () => false), 'the focus goes to what they sent');
  ok(await sam.evaluate(() => { const row = document.querySelector('#i-i_fin .mfix-row'); const who = row.querySelector('.mfix-who').getBoundingClientRect(); const said = row.querySelector('.mfix-said').getBoundingClientRect(); return getComputedStyle(row).display === 'block' && said.top >= who.bottom - 1 && Math.abs(said.left - who.left) < 2; }), 'the correction reads top to bottom');
  ok(await sam.$eval('#i-i_fin .mfix-said', (e) => !!e.querySelector('ins') && !!e.querySelector('del') && /78%/.test(e.querySelector('ins').textContent) && /87%/.test(e.querySelector('del').textContent)), 'what would change is marked');
  await sleep(300);
  ok(mail.length === 2 && mail.every((x) => /^A correction to the minutes: /.test(x.subject)) && [SECRETARY, FOUNDER].every((a) => mail.some((x) => [].concat(x.to).includes(a))), `the secretary and the founders are told (${mail.map((x) => x.to).join(', ')})`);
  ok(mail.every((x) => !/78%|87%/.test(`${x.html}${x.text}`) && /Sam Ortiz suggested a correction/.test(x.text) && /under Financial/.test(x.text)), 'the email says who and where, never the words');
  ok((await overflow(sam)) <= 0, 'nothing past the edge at 390');
  await shot(sam, 'member-suggested-390');
  await clickText(sam, '#i-i_fin button', /^Take it back$/);
  ok(await sam.waitForFunction(() => !document.querySelector('#i-i_fin .mfix-row'), { timeout: 3000 }).then(() => true, () => false), 'it can be taken back');
  await clickText(sam, '#i-i_fin .mfix-open', /Suggest a correction/);
  await sam.waitForSelector('#i-i_fin textarea', { timeout: 3000 });
  await sam.evaluate(() => { const t = document.querySelector('#i-i_fin textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'Revenue is up 78%\nGrant revenue up to $142k'); t.dispatchEvent(new Event('input', { bubbles: true })); });
  await clickText(sam, '#i-i_fin button', /^Send the correction$/);
  ok(await waitText(sam, /You suggested this correction/), 'and said again');

  // ── Words that change while the box is open: never written back over
  await clickText(sam, '#i-i_page .mfix-open', /Suggest a correction/);
  await sam.waitForSelector('#i-i_page textarea', { timeout: 3000 });
  await sam.evaluate(() => { const t = document.querySelector('#i-i_page textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'Old words, changed by me'); t.dispatchEvent(new Event('input', { bubbles: true })); });
  await saveNotes(env, ID, { changes: { 'n:i_page': 'Pulling fresh data\nJane to send out the link\nKim to fix the typo\nThe secretary added this' } }, KIM);
  await sendNotes(env, ID, KIM);
  await clickText(sam, '#i-i_page button', /^Send the correction$/);
  ok(await waitText(sam, /These words changed while you had them open\. They read:/) && await waitText(sam, /The secretary added this/), 'the box says the words changed, and what they say now');
  ok(!await sam.evaluate(() => [...document.querySelectorAll('#i-i_page button')].some((b) => /Send the correction/.test(b.textContent))), 'and nothing can go until they’ve read them');
  await shot(sam, 'member-moved-390');
  await clickText(sam, '#i-i_page button', /^Start from the new words$/);
  ok(await sam.$eval('#i-i_page textarea', (t) => /The secretary added this/.test(t.value)), 'they start again from the new words');
  await clickText(sam, '#i-i_page button', /^Cancel$/);
  ok(!(await DB.prepare("SELECT count(*) AS n FROM board_minutes_corrections WHERE target = 'n:i_page'").first()).n, 'nothing was sent');

  // ── Another member: who was there, and anything else
  const alex = await tab(OTHER);
  await alex.goto(`${SITE}/admin/board/#/meetings/${ID}`, { waitUntil: 'networkidle0' });
  ok(await waitText(alex, /Sam Ortiz suggested this correction/), 'the whole board sees what’s waiting');
  ok(!await alex.$('#i-i_fin .mfix-do'), 'and only who decides can decide it');
  await clickText(alex, '.bp-who .mfix-open', /Correct who was there/);
  await alex.waitForSelector('.bp-who select', { timeout: 3000 });
  ok(await alex.$eval('.bp-who select', (s) => s.options[s.selectedIndex].textContent === 'Alex Rivera'), 'it starts on them');
  await clickText(alex, '.bp-who .mfix-pick button', /^On video$/);
  await clickText(alex, '.bp-who button', /^Send the correction$/);
  ok(await waitText(alex, /Alex Rivera was on video\. The minutes said here\./), 'who was there, in words');
  await clickText(alex, '#corrections .mfix-open', /Suggest a correction/);
  await alex.waitForSelector('#corrections textarea', { timeout: 3000 });
  await alex.type('#corrections textarea', 'The vote was seconded by Sam, not Kim.');
  await clickText(alex, '#corrections button', /^Send the correction$/);
  ok(await waitText(alex, /The vote was seconded by Sam, not Kim\./), 'anything else');
  await shot(alex, 'member-page');

  // ── The secretary decides, from For you
  await kim.goto(`${SITE}/admin/board/`, { waitUntil: 'networkidle0' });
  ok(await waitText(kim, /3 corrections to the minutes of the Q4 Board Meeting/), 'For you says what’s waiting');
  await shot(kim, 'secretary-for-you');
  await clickText(kim, '.bp-todo--link', /3 corrections to the minutes/);
  ok(await waitText(kim, /3 corrections are waiting\./), 'the meeting says so too');
  ok(await kim.waitForFunction(() => /^c-/.test(document.activeElement?.id || ''), { timeout: 4000 }).then(() => true, () => false), 'and takes them to the first one');
  mail.length = 0;
  await clickText(kim, '#i-i_fin .mfix-do button', /^Make this change$/);
  ok(await waitText(kim, /Made\. The minutes say that now\./), 'one press makes it');
  ok(await waitText(kim, /Revenue is up 78%/) && await waitText(kim, /Corrected [A-Z][a-z]{2} \d+\. Suggested by Sam Ortiz, made by Kim Park\./), 'the page says it, and that it was corrected');
  await sleep(300);
  ok(mail.some((x) => [].concat(x.to).includes(MEMBER) && /^Your correction was made: /.test(x.subject)), 'who suggested it is told');
  {
    const m = await getMeeting(DB, ID);
    ok(m.sections[0].items[1].notes === 'Revenue is up 78%\nGrant revenue up to $142k', 'it’s on the meeting');
    ok(m.minutesFrom.first && m.minutesFrom.first !== m.minutesFrom.at, 'and the first date stays');
    const row = await DB.prepare('SELECT sent FROM board_minutes_notes WHERE meeting_id = ?').bind(ID).first();
    ok(JSON.parse(row.sent).by === 'Kim Park', 'who typed them doesn’t change');
  }
  await clickText(kim, '.bp-who .mfix-do button', /^Make this change$/);
  ok(await waitText(kim, /1 by video/), 'who was there changes');

  // ── A founder keeps the last one as it is, and says why
  const jane = await tab(FOUNDER);
  await jane.goto(`${SITE}/admin/board/#/meetings/${ID}`, { waitUntil: 'networkidle0' });
  ok(await waitText(jane, /A correction is waiting\./), 'a founder sees what’s left');
  await clickText(jane, '#corrections .mfix-do button', /^Keep them as they are$/);
  await jane.waitForSelector('#corrections .mfix-keep input', { timeout: 3000 });
  await jane.type('#corrections .mfix-keep input', 'The tape says Kim.');
  await clickText(jane, '#corrections .mfix-keep button', /^Keep them as they are$/);
  ok(await waitText(jane, /The minutes stay as they are\./), 'kept as they are');
  await alex.reload({ waitUntil: 'networkidle0' });
  ok(await waitText(alex, /Your correction: Jane Doe kept the minutes as they are\. “The tape says Kim\.”/), 'who suggested it sees why');
  await sam.reload({ waitUntil: 'networkidle0' });
  await sleep(500);
  ok(!/The tape says Kim/.test(await sam.evaluate(() => document.body.innerText)), 'nobody else does');
  ok(/Corrected/.test(await sam.evaluate(() => document.body.innerText)), 'and the board sees what was corrected');
  ok(!await sam.$('.mfix-row .mfix-do'), 'nothing left to press');
  await shot(sam, 'member-corrected-390');
  ok((await overflow(sam)) <= 0, 'nothing past the edge at 390, corrected');

  // ── The vote on the next meeting approves them, and the secretary signs
  await saveNotes(env, NEXT, { changes: { 'r:alex-rivera': 'present', 'r:sam-ortiz': 'present', 'r:kim-park': 'present', 'm:i_min': { result: 'passed', by: 'Alex Rivera', second: 'Sam Ortiz' } } }, KIM);
  await kim.goto(`${SITE}/admin/board/#/meetings/${NEXT}`, { waitUntil: 'networkidle0' });
  await kim.reload({ waitUntil: 'networkidle0' });
  await kim.waitForSelector('.bp-minutes__open', { timeout: 8000 });
  ok(await waitText(kim, /2 corrections made/), 'the vote’s item says what was corrected');
  await kim.click('.bp-minutes__open');
  await kim.waitForSelector('.bn-send', { timeout: 8000 });
  await kim.waitForFunction(() => !document.querySelector('.bn-send')?.disabled, { timeout: 6000 });
  await clickText(kim, '.bn-send', /^Send the minutes$/);
  ok(await waitText(kim, /The minutes that vote approved now show as approved\./), 'the vote approves them');
  await kim.goto(`${SITE}/admin/board/`, { waitUntil: 'networkidle0' });
  ok(await waitText(kim, /Sign the minutes of the Q4 Board Meeting/), 'For you asks the secretary to sign');
  ok(!await waitText(jane, /Sign the minutes/, 500), 'nobody else is asked');
  await clickText(kim, '.bp-todo--link', /Sign the minutes/);
  await kim.waitForSelector(`#sign-minutes-${ID}`, { timeout: 5000 });
  await shot(kim, 'secretary-sign');
  await clickText(kim, `#sign-minutes-${ID} button`, /^Choose how you sign$/);
  await kim.waitForSelector('dialog.bp-adopt[open] #bp-adopt-name', { timeout: 4000 });
  await kim.$eval('#bp-adopt-name', (i) => { i.value = ''; });
  await kim.type('#bp-adopt-name', 'Kim Park');
  await kim.click('.bp-adopt button[type="submit"]');
  await kim.waitForFunction(() => !document.querySelector('dialog.bp-adopt[open]'), { timeout: 4000 });
  await clickText(kim, `#sign-minutes-${ID} button`, /^Sign the minutes$/);
  ok(await waitText(kim, /Tick that you agree to sign electronically, then sign\./), 'agreeing to sign electronically comes first');
  await kim.click(`#sign-minutes-${ID} .bp-check`);
  await clickText(kim, `#sign-minutes-${ID} button`, /^Sign the minutes$/);
  ok(await waitText(kim, /Signed\. Thank you\./), 'signed');
  ok((await buildMinutesRecord(env, ID, { render: fakeRender })).built, 'the signed copy is made');
  await kim.reload({ waitUntil: 'networkidle0' });
  ok(await waitText(kim, /Signed by Kim Park, [A-Z][a-z]{2} \d+/), 'the meeting says who signed');
  ok(await waitText(kim, /The signed copy/), 'and the signed copy is there to open');
  ok(!await kim.$(`#sign-minutes-${ID}`), 'and it doesn’t ask again');
  await shot(kim, 'secretary-signed');
  await sam.reload({ waitUntil: 'networkidle0' });
  await sleep(400);
  ok(!await sam.$('.mfix-open'), 'approved minutes take no more corrections');

  // ── Board: what happened, and reminders off until they're turned on
  const asked = [];
  await answerAsks(jane, { onAsk: (t) => asked.push(t) });
  await jane.goto(`${SITE}/admin/#board`, { waitUntil: 'networkidle0' });
  await jane.waitForSelector('.bh-remind', { timeout: 10000 });
  ok(await jane.$eval('.bh-remind select', (s) => s.value === 'off'), 'reminders start off');
  await jane.select('.bh-remind select', 'on');
  ok(await waitText(jane, /Reminders are on/), 'turned on, asked first');
  ok(asked.some((t) => /Sam Ortiz, Jane Doe get an email a week before/.test(t)), `it says who (${asked.join(' | ')})`);
  ok(JSON.parse((await DB.prepare("SELECT data FROM board_state WHERE key = 'settings'").first())?.data || '{}').actionRemind === 'on', 'and it stays on');
  mail.length = 0;
  await clickText(jane, '.bh-remind button', /^Send me the email$/);
  ok(await waitText(jane, /Sent to jane@soardcharity\.com/), 'Send me the email');
  await sleep(200);
  ok(mail.some((x) => /^\[Preview\] Your board to-dos/.test(x.subject) && [].concat(x.to).includes(FOUNDER)), `the preview comes (${mail.map((x) => x.subject).join(' | ')})`);
  await shot(jane, 'board-home');
  await jane.goto(`${SITE}/admin/#board/meeting/${ID}`, { waitUntil: 'networkidle0' });
  ok(await waitText(jane, /2 corrections made/) && await waitText(jane, /Signed by Kim Park/), 'After says what was corrected and who signed');
  ok(await waitText(jane, /Sent [A-Z][a-z]{2} \d+/), 'the first date is what Board says');
  await shot(jane, 'board-after');
  ok(!consoleErrors.length, `no console errors${consoleErrors.length ? `: ${consoleErrors.slice(0, 3).join(' | ')}` : ''}`);
} catch (err) {
  failures.push(`crashed: ${err.stack || err}`);
  console.error(err);
} finally {
  await browser.close();
  server.close();
}
if (failures.length) { console.log(`\n${failures.length} failed:\n- ${failures.join('\n- ')}`); process.exit(1); }
console.log('\nAll minutes checks passed. Screenshots in test-results/board-minutes/');
process.exit(0);
