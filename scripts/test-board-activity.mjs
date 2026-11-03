/**
 * test-board-activity.mjs: Board → Members shows who signed in and what they did, in a real browser
 * ==================================================================================================
 * Serves public/ (with the admin's real CSP) and answers /api/board-* with the real handlers behind the
 * real sign-in middleware, on an in-memory D1 and R2 (as scripts/test-board.mjs does). Made-up people only.
 *   - a board member uses the board page: Home, a meeting, a document read in the viewer, the video call,
 *     their answer; the page's tracker reports it, the server keeps it (pages and files with the time spent)
 *   - an admin looking at the board page is never recorded
 *   - a founder opens Board → Members: who has signed in and who hasn't (with the sign-in email), last on the
 *     page and on what, the five-week strip, the next meeting's documents read, then the member's own sheet:
 *     each sitting, what they read and for how long, their answer
 *   - at 320, 375, 390, 768, 820, 1025, 1100, 1180, 1280 and 1440: nothing past the edge, the filter whole with a
 *     13-member board's counts, no console errors
 * Screenshots land in test-results/board-activity/. Exits non-zero on any failure.
 *
 *   node scripts/test-board-activity.mjs
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
import { saveMeeting, ensureSchema, patchMeeting, saveDoc } from '../functions/api/_board.js';
import { newMeeting } from '../public/admin/board-shared.js';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/board-activity/');
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
  // A long name and address, to prove nothing runs off a phone
  'bart-montgomery': { name: 'Bartholomew Montgomery-Fitzgerald', group: 'board', title: 'Board Member', order: 4 },
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
for (const [slug, email] of [['alex-rivera', MEMBER], ['sam-ortiz', OTHER], ['bart-montgomery', 'bartholomew.montgomery-fitzgerald.board@a-very-long-company-name-example.com']]) await DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind(slug, email).run();

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

// The next meeting, shared, with two documents (one with an item); an earlier one
await ensureSchema(DB);
const pdfOf = async (title) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText(title, { x: 72, y: 700, size: 20, font });
  return Buffer.from(await doc.save());
};
const m = newMeeting({ date: day(3), defaults: { start: '18:00', end: '19:30', location: 'Example Hall', address: '1 Example St, Roswell, GA' } });
m.video = 'https://meet.google.com/abc-defg-hij';
const saved = await saveMeeting(DB, { ...m, shared: true }, { by: FOUNDER });
for (const [id, name] of [['f_statement', 'September financial statements.pdf'], ['f_budget', '2027 budget draft.pdf']]) {
  const bytes = await pdfOf(name);
  await env.FILES.put(`board/meeting/${saved.id}/${id}`, bytes, { httpMetadata: { contentType: 'application/pdf' } });
  await DB.prepare('INSERT INTO board_files (id, owner_type, owner_id, r2_key, name, type, size, kind, staff_only, at, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, 'meeting', saved.id, `board/meeting/${saved.id}/${id}`, name, 'application/pdf', bytes.length, 'financials', 0, new Date().toISOString(), FOUNDER).run();
}
await saveMeeting(DB, { ...newMeeting({ date: day(-10) }), shared: true }, { by: FOUNDER });
// A paper written in Board that every member signs (no file: its words are on the board page)
await saveDoc(DB, { title: 'Board Member Expectations', body: 'Come to the meetings, read the documents first.', sign: true, shared: true }, { by: FOUNDER });
// Jane's calendar invite: Alex said yes, Sam hasn't answered, Kim isn't on it
await patchMeeting(DB, saved.id, (x) => ({ ...x, calendar: { uid: 'q4@google.com', title: 'SOARD Board Meeting', from: FOUNDER, organizer: FOUNDER, eventId: 'evq4', replies: { 'alex-rivera': 'accepted', 'sam-ortiz': 'invited' } } }));

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
      const ctx = { request, env, data: {} };
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
// Members' summary, or one member's sheet, not answering (D1 down for a moment), for the tab that tries it
let failOverview = false;
let failSheet = false;
async function tab(email, width = 1440) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 1000, deviceScaleFactor: 1, isMobile: width < 600, hasTouch: width < 600 });
  await page.setExtraHTTPHeaders({ 'x-test-user': email });
  // Each tab as the window someone's at (headless Chrome gives only one tab the focus; the tracker counts that one)
  await (await page.createCDPSession()).send('Emulation.setFocusEmulationEnabled', { enabled: true });
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource|sunshineonaranneyday\.com\/cdn-cgi\/imagedelivery|x-test-user/.test(msg.text())) consoleErrors.push(`${email} ${width}: ${msg.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`${email} ${width}: ${e.message}`));
  // The video call opens in a new tab: never really leave for Google
  await page.setRequestInterception(true);
  page.on('request', (r) => (/^https:\/\/meet\.google\.com\//.test(r.url()) ? r.abort()
    : (failOverview && /\/api\/board-admin\?activity=$/.test(r.url())) || (failSheet && /\/api\/board-admin\?activity=[a-z]/.test(r.url())) ? r.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'D1_ERROR: Network connection lost.' }) })
      : r.continue()));
  await answerAsks(page);
  return page;
}
const text = (page) => page.evaluate(() => document.body.innerText);
const waitText = (page, re, timeout = 8000) => page.waitForFunction((src) => new RegExp(src).test(document.body.innerText), { timeout }, re.source).then(() => true, () => false);
const rows = async (slug) => (await DB.prepare('SELECT kind, ref, sub, secs FROM board_activity WHERE slug = ? ORDER BY id').bind(slug).all()).results || [];
const overflow = (page) => page.evaluate(() => {
  const main = document.querySelector('.main') || document.body;
  const edge = main.getBoundingClientRect().right + 1;
  // (Board's tabs scroll sideways on a phone, past the edge on purpose; the filter is measured on its own)
  const scrolls = (el) => !!el.parentElement?.closest('.hub-tabs, .seg');
  const past = [...main.querySelectorAll('*')].filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > edge && getComputedStyle(el).position !== 'fixed' && !scrolls(el)).slice(0, 3).map((el) => el.className || el.tagName);
  return { page: document.scrollingElement.scrollWidth - innerWidth, past };
});
async function shot(page, name) {
  const vp = page.viewport();
  const h = await page.evaluate(() => Math.min(6000, document.scrollingElement.scrollHeight));
  await page.setViewport({ ...vp, height: Math.max(vp.height, h) });
  await sleep(250);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  await page.setViewport(vp);
}

try {
  // ─── A board member uses the board page ───
  console.log('A board member on the board page');
  const alex = await tab(MEMBER);
  await alex.goto(`${SITE}/admin/board/`, { waitUntil: 'networkidle0' });
  ok(await waitText(alex, /Q4|Board Meeting/), 'the board page opens for a member');
  await alex.mouse.move(200, 200);
  await sleep(2600);
  await alex.evaluate((id) => { location.hash = `#/meetings/${id}`; }, saved.id);
  ok(await waitText(alex, /September financial statements|2027 budget/), 'the meeting with its documents');
  await alex.mouse.move(300, 300);
  await sleep(2200);
  // A document, in the viewer
  const opened = await alex.evaluate(() => { const a = [...document.querySelectorAll('a[href*="/api/board-file?id=f_statement"]')].find((x) => x.getClientRects().length); if (a) a.click(); return !!a; });
  ok(opened, 'a document link on the meeting');
  ok(await alex.waitForSelector('.fv[role="dialog"]', { timeout: 6000 }).then(() => true, () => false), 'it opens in the viewer');
  for (let i = 0; i < 4; i++) { await alex.mouse.move(400 + i * 10, 400); await sleep(1000); }
  await alex.keyboard.press('Escape');
  await sleep(1200);
  // The video call
  // A real click (the tracker leaves out clicks a script makes)
  for (const a of await alex.$$('a[href^="https://meet.google.com/"]')) { if (await a.boundingBox()) { await a.click(); break; } }
  await sleep(500);
  // Whether they're coming: their calendar invite's answer, never buttons here
  ok(await waitText(alex, /You’re coming/) && /You said yes on the calendar invite/.test(await text(alex)), 'their answer, as the calendar invite has it');
  ok(!(await alex.$('.bp-choice')), 'no answer buttons on the board page');
  await alex.evaluate(() => window.__boardActivity?.flush());
  await sleep(800);
  const got = await rows('alex-rivera');
  const kinds = got.map((r) => `${r.kind}:${r.ref}`);
  ok(got.some((r) => r.kind === 'view' && r.ref === 'home' && r.secs >= 1), `Home, with its time (${kinds.join(', ')})`);
  ok(got.some((r) => r.kind === 'view' && r.ref === `meeting/${saved.id}` && r.secs >= 1), 'the meeting, with its time');
  const read = got.find((r) => r.kind === 'file' && r.ref === 'f_statement');
  ok(read && read.secs >= 2 && read.sub === saved.id, `the document read in the viewer, ${read?.secs}s, from that meeting`);
  ok(!got.some((r) => r.kind === 'file' && r.ref === 'f_budget'), 'a document only drawn as a thumbnail isn’t counted as read');
  ok(got.some((r) => r.kind === 'video' && r.ref === saved.id), 'opening the video call');
  const signins = (await DB.prepare('SELECT * FROM board_signins').all()).results;
  ok(signins.length === 1 && signins[0].slug === 'alex-rivera' && signins[0].iat === signedAt && /Linux|Mac|Windows/.test(signins[0].device), `one sign-in, when the code was typed, with the device (${signins[0]?.device})`);
  await shot(alex, '01-member-meeting');

  // ─── A founder looking at the board page isn't anyone's activity ───
  const janeLook = await tab(FOUNDER);
  await janeLook.goto(`${SITE}/admin/board/#/meetings/${saved.id}`, { waitUntil: 'networkidle0' });
  await sleep(2200);
  await janeLook.evaluate(() => window.__boardActivity?.flush());
  await sleep(500);
  const all = (await DB.prepare('SELECT DISTINCT slug FROM board_activity').all()).results.map((r) => r.slug);
  ok(all.length === 1 && all[0] === 'alex-rivera', `only the member is recorded (${all.join(', ')})`);
  ok((await DB.prepare('SELECT COUNT(*) AS n FROM board_signins').first()).n === 1, 'an admin’s sign-in isn’t kept');
  await janeLook.close();

  // ─── A founder: Board → Members ───
  console.log('A founder, Board → Members');
  for (const width of [1440, 1280, 1180, 1100, 1025, 820, 768, 390, 375, 320]) {
    const jane = await tab(FOUNDER, width);
    await jane.goto(`${SITE}/admin/#board/members`, { waitUntil: 'networkidle0' });
    await jane.reload({ waitUntil: 'networkidle0' });
    ok(await waitText(jane, /Each square is a day/), `${width}: Members opens, with what each member did`);
    const t = await text(jane);
    if (width === 1440) {
      ok(/Signed in\s*1/.test(t) && /Not yet\s*3/.test(t), 'the filter counts who has signed in');
      ok(/Yes\s*Earlier on [A-Z][a-z]{2} \d+/.test(t), 'Alex: signed in before Board began keeping sign-ins, so only that (never a “since” it didn’t see)');
      ok(/Opened 1 of 2 documents/.test(t), 'Alex: what they’ve read of the next meeting’s documents');
      ok(/Coming\s*Opened 1 of 2/.test(t), 'Alex: Coming, from the calendar invite');
      ok(/No answer yet\s*Hasn’t opened/.test(t), 'Sam: on the invite, no answer yet');
      ok(/Not on the invite\s*Hasn’t opened/.test(t), 'Kim: not on the invite, flagged');
      ok(/Each square is a day/.test(t), 'the strip says what it shows');
      ok(/Signed this year/i.test(t) && /0 of 1/.test(t), 'the paper written in Board counts among what they sign');
      ok(/Hasn’t opened the 2 documents/.test(t), 'Sam: hasn’t opened them');
      ok(/Never/.test(t) && /No email on file/.test(t), 'Kim: never, and no email to send to');
      ok(await jane.$$eval('.ba-day--1, .ba-day--2, .ba-day--3', (x) => x.length) >= 1, 'the strip marks today');
      ok(await jane.$$eval('.ba-day--meeting', (x) => x.length) >= 1, 'and the past meeting’s day');
      await shot(jane, `02-members-${width}`);
      // Not yet: just those
      await jane.evaluate(() => [...document.querySelectorAll('.ba-seg button')].find((b) => /^Not yet/.test(b.textContent.trim()))?.click());
      await sleep(200);
      const shown = await jane.$$eval('.ba-tr', (x) => x.length);
      ok(shown === 3, `Not yet shows the three who haven’t (${shown})`);
      await jane.evaluate(() => [...document.querySelectorAll('.ba-seg button')].find((b) => /^All/.test(b.textContent.trim()))?.click());
      // Alex's sheet
      await jane.evaluate(() => [...document.querySelectorAll('.ba-name')].find((b) => b.textContent.trim() === 'Alex Rivera')?.click());
      ok(await waitText(jane, /What Alex did/), 'Alex’s row opens their sheet');
      await sleep(200);
      ok(await jane.evaluate(() => { const el = document.activeElement; const by = el?.getAttribute('aria-labelledby'); return el?.getAttribute('role') === 'region' && document.getElementById(by)?.textContent.trim() === 'Alex Rivera'; }), 'its first focus is named by the title, never read out whole');
      ok(await waitText(jane, /Opened “September financial statements”/), 'it says what they opened (a few seconds: opened, not read)');
      const s = await text(jane);
      ok(/Looked at Home/.test(s) && /Looked at the Q\d \d{4} Board Meeting/.test(s), 'the pages they were on, by name');
      ok(/Opened the video call for the/.test(s), 'the video call');
      ok(/On the calendar invite: Coming/.test(s), 'their answer, from the invite');
      ok(/Signed in on /.test(s), 'the sign-in, with its device');
      ok(/For the Q\d \d{4} Board Meeting/.test(s) && /Not opened/.test(s), 'the next meeting’s documents, read and not');
      await shot(jane, '03-sheet-1440');
      await jane.keyboard.press('Escape');
      await sleep(300);
      ok(!(await jane.$('.ba-dialog')), 'Escape closes it');
      ok(await jane.evaluate(() => document.activeElement?.matches('.ba-name[data-slug="alex-rivera"]')), 'and the focus is back on their name');
      // Sam's: nothing yet, and the email to send
      await jane.evaluate(() => [...document.querySelectorAll('.ba-name')].find((b) => b.textContent.trim() === 'Sam Ortiz')?.click());
      ok(await waitText(jane, /Once Sam signs in/), 'a member who hasn’t signed in: says what will show');
      await shot(jane, '04-sheet-not-yet');
      await jane.keyboard.press('Escape');
      // Members when what they did doesn't load: the board is all there, it says what didn't load, and Try again
      failOverview = true;
      const down = await tab(FOUNDER, 1440);
      await down.goto(`${SITE}/admin/#board/members`, { waitUntil: 'networkidle0' });
      ok(await waitText(down, /didn’t load/), 'what didn’t load says so');
      const dt = await text(down);
      ok(/Alex Rivera/.test(dt) && /Sam Ortiz/.test(dt) && /Kim Park/.test(dt) && /Never/.test(dt), 'and the board is all there, as Board knows it');
      ok(!/Hasn’t opened|Opened \d/.test(dt), 'never a guess at what they opened');
      await shot(down, '07-members-not-loaded');
      failOverview = false;
      await down.evaluate(() => [...document.querySelectorAll('.ba-status button')].find((b) => /Try again/.test(b.textContent))?.click());
      ok(await waitText(down, /Each square is a day/), 'Try again loads it');
      ok(/Opened 1 of 2 documents/.test(await text(down)), 'with what each opened');
      // A member's sheet that doesn't load: says so, and Try again
      failSheet = true;
      await down.evaluate(() => [...document.querySelectorAll('.ba-name')].find((b) => b.textContent.trim() === 'Alex Rivera')?.click());
      ok(await waitText(down, /What Alex did didn’t load/), 'a sheet that didn’t load says so');
      failSheet = false;
      await down.evaluate(() => [...document.querySelectorAll('.ba-dialog button')].find((b) => /Try again/.test(b.textContent))?.click());
      ok(await waitText(down, /Looked at Home/), 'Try again loads it');
      await down.close();
    }
    const o = await overflow(jane);
    ok(o.page <= 0 && !o.past.length, `${width}: nothing past the edge (${o.page}px${o.past.length ? `; ${o.past.join(', ')}` : ''})`);
    // The table inside its card (the arrow at the end of each row in view, nothing cut off at its edge)
    const inCard = await jane.evaluate(() => { const c = document.querySelector('.ba-card')?.getBoundingClientRect(); const t = document.querySelector('.ba-table')?.getBoundingClientRect(); return c && t ? Math.round(t.right - c.right) : 0; });
    ok(inCard <= 1, `${width}: the table fits its card (${inCard}px over)`);
    // A board of 13: two-figure counts on every choice still fit, none of it scrolled out of sight
    const seg = await jane.evaluate(() => { const el = document.querySelector('.ba-seg'); el.querySelectorAll('.count').forEach((c) => { c.textContent = '13'; }); return el.scrollWidth - el.clientWidth; });
    ok(seg <= 0, `${width}: the filter’s three choices fit (${seg}px over)`);
    if (width === 390) {
      await shot(jane, '05-members-390');
      await jane.evaluate(() => [...document.querySelectorAll('.ba-name')].find((b) => b.textContent.trim() === 'Alex Rivera')?.click());
      await waitText(jane, /What Alex did/);
      await sleep(300);
      const so = await overflow(jane);
      ok(so.page <= 0, `390: the sheet fits a phone (${so.page}px)`);
      await jane.keyboard.press('Escape');
      await sleep(300);
      await jane.evaluate(() => [...document.querySelectorAll('.ba-name')].find((b) => /^Bartholomew/.test(b.textContent.trim()))?.click());
      await waitText(jane, /What Bartholomew did/);
      await sleep(300);
      const close = await jane.evaluate(() => { const r = document.querySelector('.ba-dialog .kd-x')?.getBoundingClientRect(); return r ? { left: r.left, right: r.right } : null; });
      ok(close && close.right <= 390 && close.left >= 0, `390: a long name keeps the sheet’s Close on the screen (${JSON.stringify(close)})`);
      await shot(jane, '06-sheet-390');
    }
    if (width === 768 || width === 1025) await shot(jane, `02-members-${width}`);
    await jane.close();
  }
  ok(!consoleErrors.length, `no console errors${consoleErrors.length ? `: ${consoleErrors.slice(0, 4).join(' | ')}` : ''}`);
} catch (err) {
  failures.push(`crashed: ${err.stack || err.message}`);
  console.error(err);
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} failed:\n- ${failures.join('\n- ')}` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
