/**
 * test-board.mjs — the Board area and the board's own page, in a real browser
 * ============================================================================
 * Serves public/ (with the admin's real CSP from public/_headers) and answers
 * /api/board-* with the real handlers behind the real sign-in middleware, on
 * an in-memory D1 (sql.js) and R2. Each browser tab is signed in as someone
 * (an RS256 Access token made here): a founder, another staff member, or a
 * board member. Made-up people only (the repo is public). Checks, at 1440px
 * and 390px:
 *   - Board shows in the menu and ⌘K for its admins only; other staff are refused
 *   - bringing in an old agenda (pasted text): the preview, then the meeting
 *   - the editor: notes, a private note, confidential, attendance, a motion,
 *     an action item, a file (PDF), Shared, Save, a save someone else made meanwhile
 *   - the packet: numbers locked in, Send it to me, Email the board
 *   - Documents (one asking for a signature), Members (Cloudflare's steps), Settings
 *   - a board member opening /admin/ lands on /admin/board/; Home, the meeting
 *     (never the private note or a staff-only file), the file viewer, answering
 *     whether they'll come, ticking off their action, signing, Financials,
 *     Reveals, People, Documents; the founders see it as the board does
 *   - nothing past the page's right edge on a phone, no console errors
 * Screenshots land in test-results/board/. Exits non-zero on any failure.
 *
 *   node scripts/test-board.mjs
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
import { provideBoardFinance } from '../functions/api/_board.js';
import { FIELD_JOB_STATUS } from '../functions/api/_reveals.js';
import { generateKeyPairSync } from 'node:crypto';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/board/');
mkdirSync(OUT, { recursive: true });
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// ── People and the world they live in ──
const FOUNDER = 'jane@soardcharity.com';
const STAFF = 'pat@soardcharity.com';
const MEMBER = 'alex.board@example.com';
const PEOPLE = {
  'jane-doe': { name: 'Jane Doe', group: 'team', title: 'Co-Founder/President', order: 1 },
  'pat-lee': { name: 'Pat Lee', group: 'team', title: 'Program Director', order: 2 },
  'alex-rivera': { name: 'Alex Rivera', group: 'board', title: 'Board Chair', organization: 'Rivera Builders', committees: ['Governance'], order: 1 },
  'sam-ortiz': { name: 'Sam Ortiz', group: 'board', title: 'Board Treasurer', organization: 'Ortiz & Co', committees: ['Finance'], order: 2 },
  'kim-park': { name: 'Kim Park', group: 'board', title: 'Board Member', organization: 'Park Media', order: 3 },
  'ada-advisor': { name: 'Ada Advisor', group: 'advisory', title: 'Advisory Board Member', order: 1 },
};
const KIDS = { 'maya-2026': { name: 'Maya', year: 2026, childCount: 1, roomCount: 1 }, 'leo-2026': { name: 'Leo', year: 2026, childCount: 2, roomCount: 2 }, 'zoe-2025': { name: 'Zoe', year: 2025 } };
const OLD_AGENDA = `MEETING Example Board – Agenda DATE ${day(-60).slice(5, 7)}/${day(-60).slice(8, 10)}/${day(-60).slice(0, 4)}
LOCATION Example Hall TIME 8:00a -
10:00a
ATTENDEE COMPANY ATTENDEE COMPANY
x Alex Rivera Rivera Builders x Jane Doe SOARD
Kim Park Park Media
x Sam Ortiz Ortiz & Co
1. CALL TO ORDER
1. Roll Call
2. Welcome new members (Jane)
2. COMMITTEE REPORTS
1. Financial (Sam/Alex)
a. 2026 Financials
i. Cash is healthy
1. Expenses are down
ii. Budget approved
2. Events (Alex & Jane)
a. Golf
b. Gala
3. OPEN FORUM`;

const certsKey = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', certsKey.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
async function tokenFor(email) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ iss: 'https://soard.cloudflareaccess.com', aud: ['aud-tag'], email, iat: now, nbf: now, exp: now + 3600 }));
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
for (const [slug, email] of [['alex-rivera', MEMBER], ['sam-ortiz', 'sam.board@example.org']]) await DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind(slug, email).run();
for (const [slug, d] of Object.entries(KIDS)) await DB.prepare('INSERT INTO kids (slug, name, year, data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.year, JSON.stringify(d)).run();
await DB.prepare('INSERT INTO events (slug, data) VALUES (?, ?)').bind('golf', JSON.stringify({ title: 'Sunshine Golf Classic', date: day(20), time: '8:00 AM', location: 'Example Country Club' })).run();
const site = {
  reveals: { reveals: [], upcoming: [{ slug: 'maya-2026', name: 'Maya', confirmed: true, date: day(9), time: '10:00', kidUrl: '/kids/maya-2026/' }, { slug: 'leo-2026', name: 'Leo', confirmed: false, window: { label: 'mid December', through: day(60) }, kidUrl: '/kids/leo-2026/' }], updatedAt: new Date().toISOString() },
  financials: { documents: [{ title: '2025 990 Tax Return', year: 2025, type: '990', url: 'https://files.sunshineonaranneyday.com/financials/example-990.pdf' }] },
  'financial-snapshot': { year: 2025, totalRevenue: 1000000, totalExpenses: 900000, programExpenses: 750000, netAssets: 400000, contributions: 600000, storeRevenue: 300000, programPct: 83, managementPct: 9, fundraisingPct: 8 },
};
for (const [key, data] of Object.entries(site)) await DB.prepare('INSERT INTO site_config (key, data) VALUES (?, ?)').bind(key, JSON.stringify(data)).run();

// Google Calendar: a real service-account key (made here) and the founder's calendar, empty until the calendar check
const { privateKey: saPem } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const calendar = { [FOUNDER]: [] };
const env = { GOOGLE_CALENDAR_KEY: JSON.stringify({ type: 'service_account', client_email: 'reader@example.iam.gserviceaccount.com', private_key: saPem }), DB, FILES: new FakeR2(), CF_ACCESS_TEAM_DOMAIN: 'soard', CF_ACCESS_AUD: 'aud-tag', RESEND_API_KEY: 're_test', MERCURY_API_TOKEN: 'mercury-test', MERCURY_RELAY_KEY: 'relay-test', JOBTREAD_GRANT_KEY: 'jt-test' };
const mail = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === 'https://soard.cloudflareaccess.com/cdn-cgi/access/certs') return Response.json({ keys: [jwk] });
  if (url.startsWith('https://api.resend.com/')) { const list = JSON.parse(init.body); mail.push(...list); return Response.json({ data: list.map((_, i) => ({ id: `em_${mail.length}_${i}` })) }); }
  if (url === 'https://mercury-relay.sunshineonaranneyday.com/api/v1/accounts') return Response.json({ accounts: [{ name: 'Operating', kind: 'checking', type: 'mercury', status: 'active', currentBalance: 312500 }, { nickname: 'Reserve', kind: 'savings', type: 'mercury', status: 'active', currentBalance: 62500 }] });
  if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'g-test', expires_in: 3600 });
  const gcal = url.match(/^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/([^/]+)\/events\?/);
  if (gcal && (init.method || 'GET') === 'GET') return Response.json({ items: calendar[decodeURIComponent(gcal[1])] || [] });
  if (url === 'https://api.jobtread.com/pave') {
    const job = (id, name, status) => ({ id, name, customFieldValues: { nodes: [{ value: status, customField: { id: FIELD_JOB_STATUS } }] } });
    return Response.json({ organization: { jobs: { nodes: [job('j1', 'Maya (2026)', 'Build'), job('j2', 'Leo (2026)', 'Design'), job('j3', 'Someone Else (2026)', 'Awaiting Funding'), job('j4', 'Not Published Yet (2026)', 'Design')], nextPage: null } } });
  }
  return realFetch(input, init);
};
_resetKeyCacheForTests();
// Job Costs' finance summary, the way _finance.js registers it (totals only, whole dollars)
provideBoardFinance(async () => ({
  at: new Date().toISOString(),
  months: Array.from({ length: 12 }, (_, i) => ({ month: new Date(Date.UTC(2025, 10 + i, 15)).toISOString().slice(0, 7), income: 80000 + i * 1000, makeovers: 40000, store: 12000, operating: 18000, storeSales: 25000, net: 10000 + i * 1000 })),
  ytd: { year: 2026, through: day(0), income: 900000, makeovers: 500000, store: 150000, operating: 200000, net: 50000 },
  lastYtd: { year: 2025, through: day(-365), income: 800000, makeovers: 480000, store: 140000, operating: 200000, net: -20000 },
  cash: { today: 375000, lowest: { dollars: 210000, week: day(40) }, cautiousLowest: { dollars: 180000, week: day(47) }, in13Weeks: 260000, floor: 150000, belowFloor: false },
  close: { month: '2026-09', label: 'September', state: 'ready', closedAt: null },
  perMakeover: { count: 12, average: 21000 },
}));

// ── The server ──
const ROUTES = { '/api/board-admin': boardAdmin, '/api/board-portal': boardPortal, '/api/board-file': boardFile };
const csp = (() => {
  const lines = readFileSync(join(ROOT, 'public/_headers'), 'utf8').split('\n');
  const at = lines.findIndex((l) => l.trim() === '/admin/*');
  return lines.slice(at + 1).find((l) => /^\s+Content-Security-Policy:/.test(l)).split('Content-Security-Policy:')[1].trim();
})();
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const apiCalls = [];
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const who = req.headers['x-test-user'] || '';
    if (url.pathname === '/cdn-cgi/access/get-identity') { res.writeHead(who ? 200 : 401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(who ? { email: who, name: '' } : {})); return; }
    if (url.pathname.startsWith('/cdn-cgi/imagedelivery/')) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG); return; }
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !['host', 'connection', 'content-length'].includes(k)) headers.set(k, v);
      if (who) headers.set('CF-Access-JWT-Assertion', await tokenFor(who));
      const request = new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks), duplex: 'half' });
      apiCalls.push({ who, method: req.method, path: url.pathname + url.search });
      const ctx = { request, env, data: {}, waitUntil: () => {} };
      ctx.next = async () => {
        const mod = ROUTES[url.pathname];
        const fn = mod?.[`onRequest${req.method[0]}${req.method.slice(1).toLowerCase()}`];
        if (fn) return fn(ctx);
        if (url.pathname === '/api/list-content' && /team/.test(url.searchParams.get('dir') || '')) return Response.json({ success: true, items: Object.entries(PEOPLE).map(([slug, d]) => ({ name: `${slug}.json`, content: { ...d, slug } })), pages: 1 });
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

const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-gpu-vsync', '--disable-frame-rate-limit', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'] });
const consoleErrors = [];
async function tab(email, width = 1440) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 1000, deviceScaleFactor: 1, isMobile: width < 600, hasTouch: width < 600 });
  await page.setExtraHTTPHeaders({ 'x-test-user': email });
  // Not errors in production: the admin's logo is an absolute sunshineonaranneyday.com address (same-origin there), and this test's sign-in header trips Google Fonts' CORS
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|sunshineonaranneyday\.com\/cdn-cgi\/imagedelivery|x-test-user/.test(m.text())) consoleErrors.push(`${email} ${width}: ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`${email} ${width}: ${e.message}`));
  await answerAsks(page);
  return page;
}
const text = (page) => page.evaluate(() => document.body.innerText);
const waitText = (page, re, timeout = 8000) => page.waitForFunction((src) => new RegExp(src).test(document.body.innerText), { timeout }, re.source).then(() => true, () => false);
const clickText = (page, selector, re) => page.evaluate((sel, src) => {
  const el = [...document.querySelectorAll(sel)].find((e) => new RegExp(src).test(e.textContent.trim()));
  if (el) el.click();
  return !!el;
}, selector, re.source);
const overflow = (page) => page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
async function shot(page, name) {
  // A taller window rather than fullPage, which squeezes the admin's fixed sidebar
  const vp = page.viewport();
  const h = await page.evaluate(() => Math.min(6000, document.scrollingElement.scrollHeight));
  await page.setViewport({ ...vp, height: Math.max(vp.height, h) });
  await sleep(300);
  await page.screenshot({ path: join(OUT, `${name}.png`), captureBeyondViewport: false });
  await page.setViewport(vp);
}
async function type(page, selector, value) { await page.click(selector, { clickCount: 3 }); await page.keyboard.type(value); }

try {
  // ─── A founder: the Board area ───
  console.log('A founder, the Board area');
  const jane = await tab(FOUNDER);
  await jane.goto(`${SITE}/admin/#board`, { waitUntil: 'networkidle0' });
  await jane.reload({ waitUntil: 'networkidle0' });
  ok(await waitText(jane, /Board meetings/), 'the Board area opens for a founder');
  ok(await jane.$('a.nav-item[href="#board"]') !== null, 'Board is in the menu');
  ok(await waitText(jane, /No meeting coming up/), 'no meeting yet: says so, with the way to add one');
  await shot(jane, '01-meetings-empty');

  await clickText(jane, 'button', /^Bring in an old agenda$/);
  await jane.waitForSelector('#bd-import-text');
  await jane.click('#bd-import-text');
  await jane.evaluate((t) => { const el = document.querySelector('#bd-import-text'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(el, t); el.dispatchEvent(new Event('input', { bubbles: true })); }, OLD_AGENDA);
  ok(await waitText(jane, /3 people there, 1 absent/), 'the preview: who was there and who wasn’t');
  ok(/Financial\s*Sam, Alex/.test(await text(jane)), 'the preview: presenters from the brackets');
  await shot(jane, '02-import-preview');
  await clickText(jane, 'button', /^Add this meeting$/);
  ok(await waitText(jane, /When and where/), 'the meeting opens after it’s added');
  ok(/approved minutes|Minutes approved/i.test(await text(jane)), 'a past agenda comes in as approved minutes');
  const pastId = decodeURIComponent((await jane.evaluate(() => location.hash)).split('/').pop());

  // A new meeting ahead
  await jane.goto(`${SITE}/admin/#board`, { waitUntil: 'networkidle0' });
  await clickText(jane, 'button', /^New meeting$/);
  await jane.waitForSelector('input[aria-label="Meeting date"]');
  await jane.evaluate((d) => { const el = document.querySelector('input[aria-label="Meeting date"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, d); el.dispatchEvent(new Event('input', { bubbles: true })); }, day(14));
  await clickText(jane, 'button', /^Add$/);
  ok(await waitText(jane, /Agenda and notes/), 'a new meeting opens in the editor');
  const t1 = await text(jane);
  ok(/Minutes of the .* Board Meeting/.test(t1.replace(/\n/g, ' ')) || await jane.evaluate(() => [...document.querySelectorAll('input[aria-label="Item"]')].some((i) => /^Minutes of the /.test(i.value))), 'the last meeting’s minutes are up for approval');
  ok(await jane.evaluate(() => document.querySelectorAll('.bd-person').length) === 4, 'the board (3) and the founder are on the list');
  ok(/\$375,000 in Mercury/.test(t1), 'the Financial item shows today’s cash in Mercury');
  ok(/2026 so far \(through \w+\): \$900,000 in, \$850,000 out, net \$50,000/.test(t1), 'and the year so far from Job Costs’ finance summary');
  ok(/3 makeovers in progress: 2 in Design, 1 in Build/.test(t1) && /Design: Leo and 1 more/.test(t1) && !/Not Published Yet/.test(t1), 'the projects item shows JobTread’s makeovers, by published kid only');

  // Notes, a private note, confidential, an action, a motion
  const firstNotes = 'textarea[aria-label^="Notes for Governance"]';
  ok(await jane.$(firstNotes) !== null, 'each item has its notes box');
  await jane.type(firstNotes, '- Insurance renewal is on track\n  - Broker sends the quote Friday');
  await clickText(jane, '.bd-item:has(textarea[aria-label^="Notes for Governance"]) button', /^Add your own note$/);
  await jane.waitForSelector('textarea[aria-label="Your own note"]');
  await jane.type('textarea[aria-label="Your own note"]', 'PRIVATE: ask counsel first');
  await jane.evaluate(() => { const item = document.querySelector('textarea[aria-label^="Notes for Governance"]').closest('.bd-item'); item.querySelector('.bd-check input').click(); });
  await clickText(jane, 'button', /^Add an action item$/);
  await jane.type('.bd-line--action input[aria-label="Action item"]', 'Send the venue contract');
  await jane.select('.bd-line--action select[aria-label="Whose it is"]', 'alex-rivera');
  await clickText(jane, 'button', /^Add a motion$/);
  await jane.type('.bd-line--motion input[aria-label="Motion"]', 'Approve the 2027 budget');
  await jane.evaluate(() => { const b = [...document.querySelectorAll('.seg button')].find((x) => x.textContent === 'Present'); b?.click(); });
  ok(/Unsaved changes/.test(await text(jane)), 'the save bar says there are unsaved changes');
  await clickText(jane, 'button', /^Save$/);
  ok(await waitText(jane, /Saved (just now|\d+ min ago)/), 'Save saves');

  // A file
  const input = await jane.$('.bd-drop input[type="file"]');
  const pdf = join(OUT, 'Balance-sheet-financials.pdf');
  (await import('node:fs')).writeFileSync(pdf, '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF');
  await input.uploadFile(pdf);
  ok(await waitText(jane, /Balance-sheet-financials\.pdf/), 'a PDF uploads to the meeting');
  ok(await jane.evaluate(() => document.querySelector('.bd-line--file select').value) === 'financials', 'a file named like financials is filed as one');
  ok(!/Unsaved changes/.test(await text(jane)), 'an upload isn’t an unsaved change');

  // Share, lock the numbers, Send it to me, Email the board
  await jane.evaluate(() => document.querySelector('.bc-switch input').click());
  await clickText(jane, 'button', /^Save$/);
  await waitText(jane, /On the board page/);
  await clickText(jane, 'button', /^Lock in today’s numbers$/);
  ok(await waitText(jane, /Numbers locked/), 'today’s numbers lock into the packet');
  await clickText(jane, 'button', /^Send it to me$/);
  await waitText(jane, /Sent to/);
  ok(mail.length === 1 && mail[0].to[0] === FOUNDER, 'Send it to me goes only to the founder');
  ok(!/Insurance renewal|ask counsel|Governance/.test(mail[0].html) && /A board-only item/.test(mail[0].html), 'the email has no notes and hides the confidential item');
  await clickText(jane, 'button', /^Email the board$/);
  ok(await waitText(jane, /Emailed to 2 board members/), 'Email the board reaches the two members with emails');
  ok(mail.slice(1).map((m) => m.to[0]).sort().join() === [MEMBER, 'sam.board@example.org'].sort().join(), 'each board member got their own copy');
  await shot(jane, '03-meeting-editor');
  const meetingId = decodeURIComponent((await jane.evaluate(() => location.hash)).split('/').pop());

  // Someone else saved meanwhile
  const stale = await jane.evaluate(async (id) => { const r = await fetch('/api/board-admin').then((x) => x.json()); return r.meetings.find((m) => m.id === id); }, meetingId);
  await jane.evaluate(async (m) => { await fetch('/api/board-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'save-meeting', meeting: { ...m, location: 'Changed by Holly' }, base: m.updatedAt }) }); }, stale);
  await type(jane, '#bd-loc', 'Example Hall');
  await clickText(jane, 'button', /^Save$/);
  ok(await waitText(jane, /Changed by Holly/), 'a save made meanwhile: the editor asks, and loads theirs');

  // Documents, Members, Settings
  await jane.goto(`${SITE}/admin/#board/documents`, { waitUntil: 'networkidle0' });
  await clickText(jane, 'button', /^Add a document$/);
  await jane.type('#bd-doc-title', 'Conflict of interest policy');
  await jane.select('#bd-doc-kind', 'policy');
  await jane.evaluate(() => [...document.querySelectorAll('.bd-check input')].at(-1).click());
  await clickText(jane, 'button', /^Save$/);
  ok(await waitText(jane, /0 of 3 signed/), 'a document asking for signatures counts them');
  await shot(jane, '04-documents');
  await jane.goto(`${SITE}/admin/#board/members`, { waitUntil: 'networkidle0' });
  ok(await waitText(jane, /Board members can’t sign in yet/), 'Members: says plainly that board members can’t sign in yet');
  ok(/CF_ACCESS_API_TOKEN/.test(await text(jane)) && /No email on file for Kim Park/.test(await text(jane)), 'Members: the steps, and who has no email on file');
  await shot(jane, '05-members');
  await jane.goto(`${SITE}/admin/#board/settings`, { waitUntil: 'networkidle0' });
  ok(await waitText(jane, /jane@soardcharity\.com/), 'Settings: the founder can open it until it’s saved');
  await shot(jane, '06-settings');

  // A board meeting on the founder's calendar becomes a meeting in Board, its day, time and place kept to the calendar
  const calDay = day(35);
  calendar[FOUNDER].push({ id: 'q1', iCalUID: 'q1@google.com', summary: 'SOARD Q4 Board Meeting', status: 'confirmed', start: { dateTime: `${calDay}T13:00:00Z` }, end: { dateTime: `${calDay}T15:00:00Z` }, location: 'Example Design Group, 100 Example St, Roswell, GA', hangoutLink: 'https://meet.google.com/abc-defg-hij', htmlLink: 'https://www.google.com/calendar/event?eid=q1' });
  await DB.exec("DELETE FROM board_state WHERE key = 'calendar'");
  await jane.goto(`${SITE}/admin/#board`, { waitUntil: 'networkidle0' });
  await jane.reload({ waitUntil: 'networkidle0' }); // a new hash alone doesn't load the page again
  ok(await waitText(jane, /Meetings come from Jane’s calendar: any event named like “Board Meeting”/), 'Meetings says where meetings come from');
  ok(await waitText(jane, /From the calendar/), 'the event on the founder’s calendar is a meeting in Board');
  const calId = await jane.evaluate(async () => (await (await fetch('/api/board-admin')).json()).meetings.find((m) => m.calendar)?.id);
  await jane.goto(`${SITE}/admin/#board/meeting/${calId}`, { waitUntil: 'networkidle0' });
  await jane.reload({ waitUntil: 'networkidle0' });
  ok(await waitText(jane, /From Jane’s calendar \(“SOARD Q4 Board Meeting”\)/), 'its editor says it follows the calendar');
  ok(await jane.$eval('.bd-head h2', (e) => e.textContent) === 'SOARD Q4 Board Meeting', 'and goes by the event’s own name');
  ok(await jane.evaluate(() => document.querySelector('#bd-date').disabled && document.querySelector('#bd-start').value === '08:00' && document.querySelector('#bd-loc').disabled && document.querySelector('#bd-loc').value === 'Example Design Group' && document.querySelector('#bd-video').value === 'https://meet.google.com/abc-defg-hij'), 'its day, time, place and video link come from the event, and are changed there');
  await shot(jane, '09-calendar-meeting');

  // ⌘K
  await jane.keyboard.down('Meta'); await jane.keyboard.press('k'); await jane.keyboard.up('Meta');
  await jane.keyboard.type('Board');
  ok(await waitText(jane, /Meetings, minutes and documents/), '⌘K finds Board for an admin');
  await jane.keyboard.press('Escape');

  // ─── Other staff ───
  console.log('Other staff');
  const pat = await tab(STAFF);
  await pat.goto(`${SITE}/admin/`, { waitUntil: 'networkidle0' });
  await sleep(500);
  ok(await pat.$('a.nav-item[href="#board"]') === null, 'Board isn’t in the menu for other staff');
  await pat.goto(`${SITE}/admin/#board`, { waitUntil: 'networkidle0' });
  await pat.reload({ waitUntil: 'networkidle0' });
  ok(await waitText(pat, /open only to the people its Settings list/), 'the Board area refuses other staff');
  await pat.goto(`${SITE}/admin/board/`, { waitUntil: 'networkidle0' });
  ok(await waitText(pat, /This page is for SOARD’s board/), 'the board page refuses other staff, with a way back to the admin');

  // ─── A board member ───
  for (const width of [1440, 390]) {
    console.log(`A board member at ${width}px`);
    const alex = await tab(MEMBER, width);
    await alex.goto(`${SITE}/admin/`, { waitUntil: 'networkidle0' });
    await alex.waitForFunction(() => location.pathname === '/admin/board/', { timeout: 8000 }).catch(() => {});
    ok(new URL(alex.url()).pathname === '/admin/board/', 'opening /admin/ takes a board member to their page');
    ok(await waitText(alex, /Good (morning|afternoon|evening), Alex/), 'Home greets them by name');
    const home = await text(alex);
    ok(/Next meeting/i.test(home) && /See the agenda/.test(home), 'Home: the next meeting');
    ok(width === 1440 ? /Send the venue contract/.test(home) : !/Send the venue contract/.test(home), width === 1440 ? 'Home: their own action item' : 'Home: the action item they ticked off is gone');
    ok(/\$375,000/.test(home) && /children served/.test(home), 'Home: at a glance');
    ok(/Maya’s reveal/.test(home) && /Sunshine Golf Classic/.test(home), 'Home: reveals and events coming up');
    ok(await overflow(alex) <= 0, 'Home: nothing past the right edge');
    await shot(alex, `10-home-${width}`);
    if (width === 1440) {
      await clickText(alex, 'button', /^I’ll join by video$/);
      await alex.waitForFunction(() => [...document.querySelectorAll('button[aria-pressed="true"]')].some((b) => b.textContent === 'Joining by video'), { timeout: 5000 }).catch(() => {});
      ok(await alex.evaluate(() => [...document.querySelectorAll('button[aria-pressed="true"]')].some((b) => b.textContent === 'I’ll join by video')), 'they answer whether they’re coming');
      await alex.evaluate(() => document.querySelector('.bp-todo input').click());
      await sleep(1200);
    }

    await alex.goto(`${SITE}/admin/board/#/meetings/${meetingId}`, { waitUntil: 'networkidle0' });
    ok(await waitText(alex, /Insurance renewal is on track/), 'the meeting: the notes, as points');
    const page = await text(alex);
    ok(!/ask counsel/.test(page) && !/ask counsel/.test(await alex.content()), 'the meeting: never the private note, not even in the page source');
    ok(/Confidential/.test(page), 'the meeting: the confidential item is marked');
    ok(/Approve the 2027 budget/.test(page), 'the meeting: the motion');
    ok(/As of/i.test(page), 'the meeting: the locked numbers say when they’re from');
    ok(await overflow(alex) <= 0, 'the meeting: nothing past the right edge');
    await shot(alex, `11-meeting-${width}`);
    if (width === 1440) {
      await clickText(alex, 'a', /^Balance-sheet-financials\.pdf$/);
      ok(await alex.waitForSelector('.fv-host *', { timeout: 6000 }).then(() => true, () => false), 'a file opens in the viewer over the page');
      await alex.keyboard.press('Escape');
      const res = await alex.evaluate(async () => (await fetch('/api/board-admin')).status);
      ok(res === 403, 'the Board area’s API refuses a board member');
    }

    for (const [p, re] of [['financials', /Cash[\s\S]*\$375,000 in Mercury[\s\S]*Lowest point: \$210,000[\s\S]*Money in and out[\s\S]*\$900,000[\s\S]*−\$20,000[\s\S]*September’s books are ready to close[\s\S]*Financial statements[\s\S]*Balance-sheet/], ['reveals', /Coming up[\s\S]*Maya[\s\S]*Each reveal comes to alex\.board@example\.com as a calendar invite[\s\S]*Being built now/], ['people', /Board of Directors[\s\S]*Alex Rivera[\s\S]*The team[\s\S]*Jane Doe/], ['documents', /Conflict of interest policy/]]) {
      await alex.goto(`${SITE}/admin/board/#/${p}`, { waitUntil: 'networkidle0' });
      ok(await waitText(alex, re), `${p} shows what it should`);
      ok(await overflow(alex) <= 0, `${p}: nothing past the right edge`);
      await shot(alex, `12-${p}-${width}`);
    }
    if (width === 1440) {
      await alex.type('.bp-sign input', 'Alex Rivera');
      await clickText(alex, 'button', /^I’ve read it and agree$/);
      ok(await waitText(alex, /Signed\s*by Alex Rivera/), 'they sign the policy with their typed name');
      await alex.goto(`${SITE}/admin/board/#/meetings/${pastId}`, { waitUntil: 'networkidle0' });
      ok(!(await waitText(alex, /Expenses are down/, 2000)), 'a meeting not shared stays off the board page');
    }
    await alex.close();
  }

  // ─── The founder sees what the board did, and sees the board page as they do ───
  console.log('Back to the founder');
  await jane.goto(`${SITE}/admin/#board/meeting/${meetingId}`, { waitUntil: 'networkidle0' });
  await jane.reload({ waitUntil: 'networkidle0' });
  ok(await waitText(jane, /Said by video/), 'the founder sees Alex’s answer');
  ok(await jane.evaluate(() => [...document.querySelectorAll('.bd-line--action')].some((l) => l.classList.contains('is-done'))), 'and that Alex ticked off the action item');
  await jane.goto(`${SITE}/admin/#board/documents`, { waitUntil: 'networkidle0' });
  ok(await waitText(jane, /Signed by Alex Rivera/), 'and who signed the policy');
  await jane.goto(`${SITE}/admin/board/`, { waitUntil: 'networkidle0' });
  ok(await waitText(jane, /seeing the board page the way board members do/), 'the founder sees the board page as the board does');
  ok(!(await jane.$('.bp-rsvp')), 'with no answers to give for anyone');

  // The editor on a phone
  const phone = await tab(FOUNDER, 390);
  await phone.goto(`${SITE}/admin/#board/meeting/${meetingId}`, { waitUntil: 'networkidle0' });
  await phone.reload({ waitUntil: 'networkidle0' });
  await waitText(phone, /Agenda and notes/);
  ok(await overflow(phone) <= 0, 'the meeting editor fits a phone');
  await shot(phone, '07-editor-390');
  await phone.goto(`${SITE}/admin/#board/members`, { waitUntil: 'networkidle0' });
  await waitText(phone, /The board/);
  ok(await overflow(phone) <= 0, 'Members fits a phone');
  await shot(phone, '08-members-390');

  ok(!consoleErrors.length, `no console errors${consoleErrors.length ? `: ${consoleErrors.slice(0, 5).join(' | ')}` : ''}`);
} catch (err) {
  failures.push(`crashed: ${err.stack || err.message}`);
  console.error(err);
} finally {
  await browser.close();
  server.close();
  globalThis.fetch = realFetch;
}
console.log(failures.length ? `\n${failures.length} failed:\n- ${failures.join('\n- ')}` : '\nAll board checks passed. Screenshots in test-results/board/');
process.exit(failures.length ? 1 : 0);
