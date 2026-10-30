/**
 * test-board.mjs — the Board area and the board's own page, in a real browser
 * ============================================================================
 * Serves public/ (with the admin's real CSP from public/_headers) and answers
 * /api/board-* with the real handlers behind the real sign-in middleware, on
 * an in-memory D1 (sql.js) and R2, with Google Calendar and Meet, Gmail,
 * Resend, Mercury and JobTread faked. Each browser tab is signed in as
 * someone (an RS256 Access token made here): a founder, another staff
 * member, or a board member. Made-up people only (the repo is public).
 * Checks, at 1440px and 390px:
 *   - Board shows in the menu and ⌘K for its admins only; other staff are refused
 *   - bringing in an old agenda (pasted text): the preview, then the meeting;
 *     its minutes dropped in as a Word file and read into the meeting by
 *     themselves (the notes; the motions and action items from Workers AI,
 *     faked here), and the signed copy
 *   - a meeting's three steps. Before: the agenda ready as drafted, a
 *     board-only item, its background as points, a private note, a file
 *     that goes with its item by itself, then Getting ready: the invite from
 *     the president's calendar with Google Meet and transcripts on, the place
 *     added after (one update, once it settles), shared, the documents
 *     emailed with nothing attached; the numbers lock themselves on the day.
 *     A save someone else made meanwhile merges. During: the agenda in
 *     order, a vote.
 *   - Documents (one asking for a signature), Members (Cloudflare's steps,
 *     the sign-in email), Settings (who invites come from)
 *   - a board member opening /admin/ lands on /admin/board/; Home (the next
 *     meeting with its place, Google Meet, already on their calendar, the
 *     makeovers by stage, coming up), answering whether they'll come, ticking
 *     off their action, search (⌘K) landing on a point in the minutes, the
 *     meeting (never the private note or a staff-only file), the file viewer,
 *     Financials, People, Documents (signing, every meeting's files), the
 *     phone's tab bar; the founders see it as the board does
 *   - nothing past the page's right edge on a phone, no console errors
 * Screenshots land in test-results/board/. Exits non-zero on any failure.
 *
 *   node scripts/test-board.mjs
 */
import puppeteer from 'puppeteer';
import http from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import { answerAsks } from './lib/ask.mjs';
import { onRequest as middleware, _resetKeyCacheForTests } from '../functions/api/_middleware.js';
import * as boardAdmin from '../functions/api/board-admin.js';
import * as bankAdmin from '../functions/api/bank-admin.js';
import * as booksAdmin from '../functions/api/books-admin.js';
import * as boardPortal from '../functions/api/board-portal.js';
import * as boardFile from '../functions/api/board-file.js';
import { provideBoardFinance, maybeLockNumbers } from '../functions/api/_board.js';
import { maybeRefreshInvites, maybeCheckInvites } from '../functions/api/_board-invite.js';
import { FIELD_JOB_STATUS } from '../functions/api/_reveals.js';
import { generateKeyPairSync } from 'node:crypto';
import { PDFDocument, StandardFonts } from 'pdf-lib';

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
const OTHER = 'sam.board@example.org';
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

/** A real ZIP (a .docx is one) of { name: text } */
function zip(files) {
  const enc = new TextEncoder();
  const locals = []; const central = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameB = enc.encode(name); const raw = enc.encode(text); const data = deflateRawSync(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameB.length, 26);
    locals.push(lh, nameB, data);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
/** Minutes the way a Word file holds them: Word numbers the lists itself */
function minutesDocx() {
  const wp = (text, ilvl) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const lvls = ['decimal', 'decimal', 'lowerLetter', 'lowerRoman'].map((f, i) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${f}"/></w:lvl>`).join('');
  const body = [wp('CALL TO ORDER', 0), wp('Roll Call', 1), wp('COMMITTEE REPORTS', 0), wp('Financial (Sam)', 1), wp('Reserves grew this quarter', 2), wp('OPEN FORUM', 0), wp('Questions from the board', 1)].join('');
  return zip({ 'word/document.xml': `<w:document><w:body>${body}</w:body></w:document>`, 'word/numbering.xml': `<w:numbering><w:abstractNum w:abstractNumId="0">${lvls}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`, '[Content_Types].xml': '<Types/>' });
}

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
for (const [slug, email] of [['alex-rivera', MEMBER], ['sam-ortiz', OTHER]]) await DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind(slug, email).run();
for (const [slug, d] of Object.entries(KIDS)) await DB.prepare('INSERT INTO kids (slug, name, year, data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.year, JSON.stringify(d)).run();
await DB.prepare('INSERT INTO events (slug, data) VALUES (?, ?)').bind('golf', JSON.stringify({ title: 'Sunshine Golf Classic', date: day(20), time: '8:00 AM', location: 'Example Country Club' })).run();
const site = {
  reveals: { reveals: [], upcoming: [{ slug: 'maya-2026', name: 'Maya', confirmed: true, date: day(9), time: '10:00', kidUrl: '/kids/maya-2026/' }, { slug: 'leo-2026', name: 'Leo', confirmed: false, window: { label: 'mid December', through: day(60) }, kidUrl: '/kids/leo-2026/' }], updatedAt: new Date().toISOString() },
  financials: { documents: [{ title: '2025 990 Tax Return', year: 2025, type: '990', url: 'https://files.sunshineonaranneyday.com/financials/example-990.pdf' }] },
  'financial-snapshot': { year: 2025, totalRevenue: 1000000, totalExpenses: 900000, programExpenses: 750000, netAssets: 400000, contributions: 600000, storeRevenue: 300000, programPct: 83, managementPct: 9, fundraisingPct: 8 },
};
for (const [key, data] of Object.entries(site)) await DB.prepare('INSERT INTO site_config (key, data) VALUES (?, ?)').bind(key, JSON.stringify(data)).run();

// Google: a real service-account key (made here), and Calendar and Meet that keep what Board writes
const { privateKey: saPem } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const calendar = { [FOUNDER]: [] };
const google = []; // Calendar writes and Meet calls: { method, url, body }
const env = { GOOGLE_CALENDAR_KEY: JSON.stringify({ type: 'service_account', client_email: 'reader@example.iam.gserviceaccount.com', client_id: '1234567890', project_id: 'example-project', private_key: saPem }), DB, FILES: new FakeR2(), CF_ACCESS_TEAM_DOMAIN: 'soard', CF_ACCESS_AUD: 'aud-tag', RESEND_API_KEY: 're_test', MERCURY_API_TOKEN: 'mercury-test', MERCURY_RELAY_KEY: 'relay-test', JOBTREAD_GRANT_KEY: 'jt-test' };
// Workers AI as the minutes reader asks it (./_board-minutes.js): the motions and action items it finds
env.AI = { run: async () => ({ response: { attendance: [], motions: [{ text: 'Approve the 2027 budget', by: 'Alex Rivera', second: 'Sam Ortiz', result: 'passed' }], actions: [{ text: 'Send the venue contract', owner: 'Alex Rivera', due: '' }], approvedPrev: false } }) };
const mail = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const method = init.method || 'GET';
  if (url === 'https://soard.cloudflareaccess.com/cdn-cgi/access/certs') return Response.json({ keys: [jwk] });
  if (url.startsWith('https://api.resend.com/')) {
    // A batch (no attachments) or one email at a time (with them)
    const b = JSON.parse(init.body);
    const list = Array.isArray(b) ? b : [b];
    mail.push(...list);
    return Response.json(Array.isArray(b) ? { data: list.map((_, i) => ({ id: `em_${mail.length}_${i}` })) } : { id: `em_${mail.length}` });
  }
  if (url === 'https://mercury-relay.sunshineonaranneyday.com/api/v1/accounts') return Response.json({ accounts: [{ name: 'Operating', kind: 'checking', type: 'mercury', status: 'active', currentBalance: 312500 }, { nickname: 'Reserve', kind: 'savings', type: 'mercury', status: 'active', currentBalance: 62500 }] });
  if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'g-test', expires_in: 3600 });
  if (url.startsWith('https://gmail.googleapis.com/')) return Response.json({ messages: [], resultSizeEstimate: 0 });
  // The Board folder in Google Drive: an empty one here (tests/board-drive.test.mjs covers what's in it)
  if (url.startsWith('https://www.googleapis.com/drive/v3/')) return Response.json({ files: [], id: 'root', name: 'Board', mimeType: 'application/vnd.google-apps.folder' });
  // Who joined a Meet (the invite check reads a space's records): none here
  if (url.startsWith('https://meet.googleapis.com/v2/conferenceRecords')) { google.push({ method, url, body: null }); return Response.json({ conferenceRecords: [], participants: [] }); }
  const meet = url.match(/^https:\/\/meet\.googleapis\.com\/v2\/spaces\/([^?]+)/);
  if (meet) {
    google.push({ method, url, body: init.body ? JSON.parse(init.body) : null });
    const on = google.some((c) => c.method === 'PATCH' && c.url.includes(`/spaces/${meet[1]}?`));
    const config = { artifactConfig: { transcriptionConfig: { autoTranscriptionGeneration: method === 'PATCH' || on ? 'ON' : 'OFF' } } };
    return Response.json(method === 'GET' ? { name: `spaces/${meet[1]}-space`, config } : { name: `spaces/${meet[1]}`, config });
  }
  const gcal = url.match(/^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/([^/?]+)\/events(?:\/([^?]+))?(?:\?.*)?$/);
  if (gcal) {
    const list = (calendar[decodeURIComponent(gcal[1])] ||= []);
    const id = gcal[2] && decodeURIComponent(gcal[2]);
    const body = init.body ? JSON.parse(init.body) : null;
    if (method !== 'GET') google.push({ method, url, body });
    const withMeet = (e) => (body?.conferenceData?.createRequest && !e.hangoutLink ? { ...e, hangoutLink: 'https://meet.google.com/abc-defg-hij', conferenceData: { conferenceId: 'abc-defg-hij' } } : e);
    if (!id && method === 'GET') return Response.json({ items: list });
    if (!id && method === 'POST') { const e = withMeet({ status: 'confirmed', iCalUID: `${body.id}@google.com`, organizer: { email: decodeURIComponent(gcal[1]), self: true }, ...body }); list.push(e); return Response.json(e); }
    const i = list.findIndex((e) => e.id === id);
    if (i < 0) return Response.json({ error: { message: 'Not Found' } }, { status: 404 });
    if (method === 'GET') return Response.json(list[i]);
    if (method === 'PATCH') { list[i] = withMeet({ ...list[i], ...body }); return Response.json(list[i]); }
    if (method === 'DELETE') { list[i] = { ...list[i], status: 'cancelled' }; return new Response(null, { status: 204 }); }
    return Response.json({ error: { message: `unexpected ${method}` } }, { status: 400 });
  }
  if (url === 'https://api.jobtread.com/pave') {
    const job = (id, name, status) => ({ id, name, customFieldValues: { nodes: [{ value: status, customField: { id: FIELD_JOB_STATUS } }] } });
    return Response.json({ organization: { jobs: { nodes: [job('j1', 'Maya (2026)', 'Build'), job('j2', 'Leo (2026)', 'Design'), job('j3', 'Someone Else (2026)', 'Awaiting Funding'), job('j4', 'Not Published Yet (2026)', 'Design')], nextPage: null } } });
  }
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url)) throw new Error(`test-board: unexpected outside call ${url}`);
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
  perMakeover: { count: 12, average: 21000 },
}));

/** A two-page made-up Statement of Financial Position, for the screen and Print it all to show page by page */
async function statementPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const [n, lines] of [[1, [['Bank Accounts', ''], ['  Example Operating', '$250,000.00'], ['  Example Reserve', '$125,000.00'], ['Total for Bank Accounts', '$375,000.00']]], [2, [['Liabilities', ''], ['  Credit card', '($1,200.00)'], ['Total Liabilities', '($1,200.00)']]]]) {
    const page = doc.addPage([612, 792]);
    page.drawText('Statement of Financial Position', { x: 72, y: 700, size: 20, font: bold });
    page.drawText(`Example Organization · page ${n}`, { x: 72, y: 676, size: 11, font });
    lines.forEach(([label, amount], i) => {
      const y = 630 - i * 24;
      page.drawText(label, { x: 72, y, size: 12, font: /^Total/.test(label) ? bold : font });
      if (amount) page.drawText(amount, { x: 430, y, size: 12, font: /^Total/.test(label) ? bold : font });
    });
  }
  return Buffer.from(await doc.save());
}

// ── The server ──
const ROUTES = { '/api/board-admin': boardAdmin, '/api/board-portal': boardPortal, '/api/board-file': boardFile, '/api/bank-admin': bankAdmin, '/api/books-admin': booksAdmin };
const csp = (() => {
  const lines = readFileSync(join(ROOT, 'public/_headers'), 'utf8').split('\n');
  const at = lines.findIndex((l) => l.trim() === '/admin/*');
  return lines.slice(at + 1).find((l) => /^\s+Content-Security-Policy:/.test(l)).split('Content-Security-Policy:')[1].trim();
})();
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
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

// No --disable-frame-rate-limit: in headless Chrome it stops all drawing once a view transition starts (the board
// page's page changes), and every screenshot after it times out. --disable-gpu keeps screenshots working while the display sleeps
const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-gpu', '--disable-gpu-vsync', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'] });
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
const saved = (page) => page.waitForFunction(() => /^Saved/.test(document.querySelector('.bm-saved')?.textContent.trim() || ''), { timeout: 10000 }).then(() => true, () => false);
const meetingNow = (page, id) => page.evaluate(async (x) => (await (await fetch('/api/board-admin')).json()).meetings.find((m) => m.id === x), id);
/** The ⋯ menu of the agenda item whose notes box is labelled `item`, then one of its choices */
async function itemMenu(page, item, choice) {
  const found = await page.evaluate((name) => {
    const s = [...document.querySelectorAll('.bd-menu > summary')].find((x) => x.getAttribute('aria-label').startsWith(`More for ${name}`));
    if (s) s.click();
    return !!s;
  }, item);
  await sleep(150);
  return found && clickText(page, '.bd-menu[open] .bd-menu__item', choice);
}
const step = (page, name) => clickText(page, '.bm-stage', new RegExp(`^\\d?${name}`));

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

  // An old agenda, pasted in
  await clickText(jane, 'button', /^Add a past meeting from a file$/);
  await jane.waitForSelector('#bd-import-text');
  await jane.evaluate((t) => { const el = document.querySelector('#bd-import-text'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(el, t); el.dispatchEvent(new Event('input', { bubbles: true })); }, OLD_AGENDA);
  ok(await waitText(jane, /3 people there, 1 absent/), 'the preview: who was there and who wasn’t');
  ok(/Financial\s*Sam, Alex/.test(await text(jane)), 'the preview: presenters from the brackets');
  await shot(jane, '02-import-preview');
  await clickText(jane, 'button', /^Add this meeting$/);
  ok(await waitText(jane, /The minutes/), 'a past meeting opens on After: its minutes');
  ok(/Approved/.test(await text(jane)), 'a past agenda comes in as approved minutes');
  const pastId = decodeURIComponent((await jane.evaluate(() => location.hash)).split('/')[2]);

  // Its minutes, written elsewhere: a Word file dropped in and read into the meeting at once; then the signed copy
  const docx = join(OUT, 'Board-minutes.docx');
  writeFileSync(docx, minutesDocx());
  await (await jane.$('.bm-minutes-drop input[type="file"]')).uploadFile(docx);
  ok(await waitText(jane, /Read from the minutes: [^\n]*notes under/), 'dropped minutes (Word) are read into the meeting by themselves, and it says what they gave');
  ok(await waitText(jane, /Undo/), 'with a way to undo it');
  const pastNow = await meetingNow(jane, pastId);
  ok(pastNow.sections.some((s) => s.items.some((it) => /Reserves grew this quarter/.test(it.notes))) && pastNow.files.some((f) => f.kind === 'minutes') && pastNow.minutesFrom?.name === 'Board-minutes.docx', 'the meeting now holds what the minutes say, and keeps the file');
  ok(pastNow.motions.some((x) => x.text === 'Approve the 2027 budget' && x.by === 'Alex Rivera') && pastNow.actions.some((a) => a.text === 'Send the venue contract' && a.owner === 'alex-rivera'), 'the motions and action items the minutes name are in it, people matched to the board');
  ok(/Approve the 2027 budget/.test(await text(jane)), 'the minutes on the page show the decision');
  const pdf = join(OUT, 'Balance-sheet-financials.pdf');
  writeFileSync(pdf, await statementPdf());
  const signedInput = await jane.evaluateHandle(() => [...document.querySelectorAll('.bm-task input[type="file"]')].find((i) => /Upload it|Replace it/.test(i.closest('label').textContent)));
  ok(!(await jane.$('.bm-choice')) && !/Mark them in During/.test(await text(jane)), 'nobody is asked to take attendance');
  await signedInput.asElement().uploadFile(pdf);
  ok(await waitText(jane, /Signed copy kept/), 'the signed copy uploads');
  await shot(jane, '02b-after');

  // ─── A new meeting ahead: Before ───
  await jane.goto(`${SITE}/admin/#board`, { waitUntil: 'networkidle0' });
  await clickText(jane, 'button', /^New meeting$/);
  await jane.waitForSelector('input[aria-label="Meeting date"]');
  await jane.evaluate((d) => { const el = document.querySelector('input[aria-label="Meeting date"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, d); el.dispatchEvent(new Event('input', { bubbles: true })); }, day(14));
  await clickText(jane, 'button', /^Add$/);
  ok(await waitText(jane, /Getting ready/), 'a new meeting opens on Before, with Getting ready');
  ok(!/Use this agenda|Write the agenda|Lock them/.test(await text(jane)), 'the agenda is ready as drafted: nothing to approve, write or lock');
  const meetingId = decodeURIComponent((await jane.evaluate(() => location.hash)).split('/')[2]);
  const t1 = await text(jane);
  ok(await jane.evaluate(() => [...document.querySelectorAll('input[aria-label="Item"]')].some((i) => /^Minutes of the /.test(i.value))), 'the last meeting’s minutes are up for approval');
  ok(/Money: the bank balances and the finance summary/.test(t1) && /Makeovers in progress \(JobTread\)/.test(t1), 'the agenda marks the items that show live numbers');

  // Board only, and a private note, from an item's ⋯ menu
  ok(await itemMenu(jane, 'Governance', /^Board only/), 'an item’s menu marks it board only');
  ok(await waitText(jane, /Board only/), 'and it shows as board only');
  ok(await itemMenu(jane, 'Governance', /^A private note/), 'an item’s menu adds a private note');
  await jane.waitForSelector('textarea[aria-label="Your private note"]');
  await jane.click('textarea[aria-label="Your private note"]');
  await sleep(100);
  await jane.keyboard.type('PRIVATE: ask counsel first');
  // A file
  await (await jane.$('.bd-drop input[type="file"]')).uploadFile(pdf);
  ok(await waitText(jane, /Balance sheet financials/), 'a PDF uploads to the meeting, by its readable name');
  ok(await jane.evaluate(() => [...document.querySelectorAll('.bf-group')].some((g) => /Financial statements/i.test(g.querySelector('.bm-group').textContent) && /Balance sheet financials/.test(g.textContent))), 'a file named like financials is filed as one');
  ok(await waitText(jane, /Balance sheet financials goes with Financial/), 'and goes with the Financial item by itself');
  const finRow = () => jane.evaluate(() => [...document.querySelectorAll('.ag-item')].find((li) => li.querySelector('input[aria-label="Item"]')?.value === 'Financial')?.textContent || '');
  ok(/Balance sheet financials/.test(await finRow()), 'it shows under that item on the agenda');
  ok(await jane.evaluate(() => /Financial/.test([...document.querySelectorAll('.bf-file')].find((li) => /Balance sheet financials/.test(li.textContent))?.querySelector('.bd-goes')?.textContent || '')), 'the file says which item it goes with');
  // Who presents: People, with their faces, searched by name
  await jane.evaluate(() => [...document.querySelectorAll('.ag-item')].find((li) => li.querySelector('input[aria-label="Item"]')?.value === 'Financial').querySelector('.bd-who .bd-pop__btn').click());
  ok(await jane.waitForSelector('.bd-pop__panel .bd-picker__find', { timeout: 3000 }).then(() => true, () => false), 'Who presents opens a list of the board and staff');
  ok(await jane.evaluate(() => document.activeElement?.classList.contains('bd-picker__find')), 'ready to type a name at once');
  ok(await jane.evaluate(() => [...document.querySelectorAll('.bd-picker__group')].map((g) => g.textContent).join() === 'Board,Staff' && [...document.querySelectorAll('.bd-picker__opt')].some((o) => /Sam Ortiz/.test(o.textContent) && /Board Treasurer/.test(o.textContent))), 'board first, then staff, each with their seat');
  await jane.keyboard.type('sam');
  await jane.keyboard.press('Enter');
  await jane.keyboard.press('Escape');
  ok(/Sam Ortiz/.test(await finRow()) && await jane.evaluate(() => !document.querySelector('.bd-pop__panel')), 'typing a name and Enter picks them; Escape closes the list');
  ok(await saved(jane) && (await meetingNow(jane, meetingId)).sections.flatMap((x) => x.items).find((it) => it.title === 'Financial').who.join() === 'sam-ortiz', 'saved as the person, not just a name');
  // Background for the board under an item, written as points
  ok(await itemMenu(jane, 'Governance', /^Add background for the board$/), 'an item’s menu adds background for the board');
  await jane.waitForSelector('textarea[aria-label^="Background for Governance"]');
  await jane.click('textarea[aria-label^="Background for Governance"]');
  await sleep(100);
  await jane.keyboard.type('Insurance renewal is on track');
  await jane.keyboard.press('Enter');
  await jane.keyboard.press('Tab');
  await jane.keyboard.type('Broker sends the quote Friday');
  const notes = await jane.$eval('textarea[aria-label^="Background for Governance"]', (e) => e.value);
  ok(notes === '- Insurance renewal is on track\n  - Broker sends the quote Friday', `background writes as points: Enter makes the next one, Tab moves it in${notes.startsWith('- Insurance renewal is on track\n  - Broker') ? '' : ` (${JSON.stringify(notes)})`}`);
  ok(await saved(jane), 'it all saves by itself');
  // Someone else saved meanwhile: both changes are kept, item by item
  const stale = await meetingNow(jane, meetingId);
  await jane.evaluate(async (m) => { await fetch('/api/board-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'save-meeting', meeting: { ...m, title: 'Fall board meeting' }, base: m.updatedAt }) }); }, stale);
  await jane.click('textarea[aria-label^="Background for Governance"]');
  await jane.keyboard.press('End');
  await jane.keyboard.type(' (or Monday)');
  ok(await saved(jane), `a save made meanwhile doesn’t stop this one (${await jane.$eval('.bm-saved', (e) => e.textContent.trim())})`);
  const merged = await meetingNow(jane, meetingId);
  ok(merged.title === 'Fall board meeting' && merged.sections.some((s) => s.items.some((it) => /or Monday/.test(it.notes))), 'both the other save and this one are kept');
  ok(merged.actions.some((a) => a.text === 'Send the venue contract' && a.owner === 'alex-rivera'), 'the last meeting’s open action item carries over');

  // Getting ready 1: the invite, from the president's calendar, with Google Meet and transcripts on
  ok(/From Jane’s calendar to the board and you: Google Meet with transcripts on/.test(await text(jane)), 'Getting ready says who the invite comes from and who it goes to');
  await clickText(jane, 'button', /^Send the invite$/);
  ok(await waitText(jane, /Invite sent from Jane’s calendar/), 'Send the invite sends it');
  // The invite's write (opening Board also runs the invite check, whose event has no guests)
  const post = google.find((c) => c.method === 'POST' && c.body?.attendees);
  ok(post && post.url.includes(`/calendars/${encodeURIComponent(FOUNDER)}/events?conferenceDataVersion=1&sendUpdates=all`), 'from the president’s own calendar, and Google emails the guests');
  ok(post && post.body.attendees.map((a) => a.email).sort().join() === [MEMBER, OTHER].sort().join(), 'to every board member with an email');
  ok(post?.body.conferenceData?.createRequest?.conferenceSolutionKey?.type === 'hangoutsMeet' && google.some((c) => c.method === 'PATCH' && /meet\.googleapis\.com/.test(c.url) && c.body.config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration === 'ON'), 'with Google Meet, its transcripts turned on');
  ok(/2 guests · Google Meet · transcript on · the place goes on it when you add one/.test(await text(jane)), 'the step says what went out');
  // The place, added after: one update once it has settled
  const before = google.length;
  await clickText(jane, 'button', /^Add the place$/);
  await jane.waitForSelector('#bd-loc');
  await type(jane, '#bd-loc', 'Example Hall');
  await type(jane, '#bd-addr', '100 Example St, Roswell, GA');
  ok(await saved(jane), 'the place saves');
  ok(await waitText(jane, /the new place goes on it a couple of minutes after you stop typing/), 'the step says the new place is on its way to the invite');
  ok(google.length === before, 'nothing goes to Google while it’s being typed');
  await maybeRefreshInvites(env, { now: Date.now() + 3 * 60 * 1000 });
  const updates = google.slice(before).filter((c) => c.url.includes('/calendar/v3/'));
  ok(updates.length === 1 && updates[0].method === 'PATCH' && updates[0].body.location === 'Example Hall, 100 Example St, Roswell, GA', 'then one update to the invite with the place');

  // Getting ready 2-3: the board page, the documents by email
  await clickText(jane, 'button', /^Share with the board$/);
  ok(await waitText(jane, /Board members see the agenda and files/), 'Share with the board puts it on the board page');
  mail.length = 0;
  await clickText(jane, 'button', /^Send it to me$/);
  await waitText(jane, /Sent to jane@soardcharity\.com/);
  ok(mail.length === 1 && mail[0].to[0] === FOUNDER, 'Send it to me goes only to the founder');
  ok(!mail[0]?.attachments && /Balance sheet financials/.test(mail[0]?.html || '') && /Open the agenda and documents/.test(mail[0]?.html || ''), 'the link to the agenda and documents, the documents by name, nothing attached');
  ok(!/ask counsel|Governance/.test(mail[0]?.html || ''), 'the email has no private note and no board-only item');
  await clickText(jane, 'button', /^Email the board$/);
  ok(await waitText(jane, /Emailed 2 board members/), 'Email the board reaches the two members with emails');
  ok(mail.slice(1).map((m) => m.to[0]).sort().join() === [MEMBER, OTHER].sort().join() && mail.slice(1).every((m) => !m.attachments), 'each board member got their own, with nothing attached');
  await shot(jane, '03-before');

  // The numbers lock themselves on the meeting's day (the heartbeat), so the minutes keep what the board saw
  ok((await maybeLockNumbers(env, { now: Date.parse(`${day(14)}T15:00:00Z`) })).includes(meetingId) && !!(await meetingNow(jane, meetingId)).snapshot, 'on the meeting’s day its numbers lock by themselves');
  ok((await maybeLockNumbers(env, { now: Date.parse(`${day(14)}T16:00:00Z`) })).length === 0, 'once');

  // ─── During: presenting, the agenda in order, a vote ───
  await jane.reload({ waitUntil: 'networkidle0' });
  await step(jane, 'During');
  ok(await waitText(jane, /The agenda, in order/), 'During opens on presenting: the agenda in order');
  ok(!(await jane.$('.bm-choice')) && !(await jane.$('textarea[aria-label^="Notes for"]')) && !(await jane.$('.bd-line--action')), 'no roll to take, no notes or action items to type');
  ok(await jane.evaluate(() => [...document.querySelectorAll('.bm-order__item')].some((li) => /Financial/.test(li.textContent) && /The money/.test(li.textContent) && /Balance sheet financials/.test(li.textContent)) && [...document.querySelectorAll('.bm-order__item')].some((li) => /Project updates/.test(li.textContent) && /Makeovers board/.test(li.textContent))), 'each item with what it shows: the money, the makeovers board, its documents');
  await clickText(jane, 'button', /^Put a motion to a vote$/);
  await jane.type('.bd-line--vote input[aria-label="The motion"]', 'Renew the insurance policy');
  ok(await saved(jane), 'During saves by itself');
  await shot(jane, '04-during');

  // Documents, Members, Settings
  await jane.goto(`${SITE}/admin/#board/documents`, { waitUntil: 'networkidle0' });
  await clickText(jane, 'button', /^Add a document$/);
  await jane.type('#bd-doc-title', 'Conflict of interest policy');
  await jane.select('#bd-doc-kind', 'policy');
  ok(await jane.evaluate(() => [...document.querySelectorAll('.bd-check input')].at(-1).disabled), 'signing can’t be asked for before there’s a file to read');
  await (await jane.$('#bd-doc-file')).uploadFile(pdf);
  await jane.evaluate(() => [...document.querySelectorAll('.bd-check input')].at(-1).click());
  await clickText(jane, 'button', /^Save$/);
  ok(await waitText(jane, /0 of 3 signed/), 'a document asking for signatures counts them');
  await shot(jane, '05-documents');
  await jane.goto(`${SITE}/admin/#board/members`, { waitUntil: 'networkidle0' });
  ok(await waitText(jane, /Board members can’t sign in yet/), 'Members: says plainly that board members can’t sign in yet');
  ok(/CF_ACCESS_API_TOKEN/.test(await text(jane)) && /No email on file for Kim Park/.test(await text(jane)), 'Members: the steps, and who has no email on file');
  mail.length = 0;
  await clickText(jane, 'button', /^Send it to me$/);
  ok(await waitText(jane, /Sent to jane@soardcharity\.com/) && mail.length === 1 && /board page/i.test(mail[0].subject), 'Members: the sign-in email, sent to the founder first');
  await shot(jane, '06-members');
  await jane.goto(`${SITE}/admin/#board/settings`, { waitUntil: 'networkidle0' });
  ok(await waitText(jane, /Who can open the Board area/), 'Settings opens');
  ok(await jane.$eval('#bd-from', (e) => e.value) === FOUNDER, 'Settings: invites come from the president until another is chosen');
  ok(!(await jane.$('.bk-banks, .bk-books')) && /System → Settings/.test(await text(jane)), 'Board settings: no banks or QuickBooks, just where they are');
  await shot(jane, '07-settings');
  // The money's sources: System → Settings, in the menu for the Board area's admins
  await jane.goto(`${SITE}/admin/#settings`, { waitUntil: 'networkidle0' });
  await jane.reload({ waitUntil: 'networkidle0' });
  ok(await jane.evaluate(() => [...document.querySelectorAll('a.nav-item, .nav-item')].some((a) => /^\s*Settings\s*$/.test(a.textContent))), 'System → Settings is in the menu');
  ok(await waitText(jane, /Read through SOARD’s relay/), 'Settings: Bank balances, Mercury read through the relay');
  const banks = await jane.$eval('.bk-banks', (e) => e.textContent);
  ok(/Chase[\s\S]*PLAID_CLIENT_ID[\s\S]*PLAID_SECRET/.test(banks) && !/\$/.test(banks) && !(await jane.$('.bk-banks .btn-primary')), 'Settings: Chase waits for Plaid’s two keys, with no button until they’re in, and no amounts');
  ok(await waitText(jane, /QBO_CLIENT_SECRET/), 'Settings: QuickBooks');
  const books = await jane.$eval('.bk-books', (e) => e.textContent);
  ok(/https:\/\/sunshineonaranneyday\.com\/api\/books-callback[\s\S]*QBO_CLIENT_ID/.test(books) && !/\$/.test(books) && !(await jane.$('.bk-books .btn-primary')), 'Settings: QuickBooks waits for its two keys, with the redirect URI to give Intuit, no button until they’re in, and no amounts');
  await shot(jane, '07b-system-settings');

  // A board meeting on the founder's calendar becomes a meeting in Board; Board's own invite isn't brought in again
  const calDay = day(35);
  calendar[FOUNDER].push({ id: 'q1', iCalUID: 'q1@google.com', summary: 'SOARD Q4 Board Meeting', status: 'confirmed', start: { dateTime: `${calDay}T13:00:00Z` }, end: { dateTime: `${calDay}T15:00:00Z` }, location: 'Example Design Group, 100 Example St, Roswell, GA', organizer: { email: FOUNDER, self: true }, attendees: [{ email: MEMBER, responseStatus: 'accepted' }, { email: OTHER }], htmlLink: 'https://www.google.com/calendar/event?eid=q1' });
  // Alex said yes to Board's invite in their calendar
  const boards = calendar[FOUNDER].find((e) => /^board[0-9a-f]/.test(e.id) && e.attendees);
  boards.attendees = boards.attendees.map((a) => (a.email === MEMBER ? { ...a, responseStatus: 'accepted' } : a));
  await DB.exec("DELETE FROM board_state WHERE key = 'calendar'");
  // The heartbeat's check of Calendar, Meet and transcripts (an event with no guests, deleted again)
  const checked = await maybeCheckInvites(env);
  ok(checked?.ok && calendar[FOUNDER].some((e) => /^boardcheck/.test(e.id) && e.status === 'cancelled'), 'the invite check passes and deletes its event');
  await jane.goto(`${SITE}/admin/#board`, { waitUntil: 'networkidle0' });
  await jane.reload({ waitUntil: 'networkidle0' }); // a new hash alone doesn't load the page again
  ok(await waitText(jane, /Meetings come from Jane’s calendar by themselves/), 'Meetings says where meetings come from');
  ok(await waitText(jane, /Ready\. The board was emailed the link/), 'the next meeting: everything done says Ready');
  ok(/Also coming up/i.test(await text(jane)) && /SOARD Q4 Board Meeting/.test(await text(jane)), 'the meeting after it is listed as also coming up');
  const all = await jane.evaluate(async () => (await (await fetch('/api/board-admin')).json()).meetings);
  ok(all.length === 3, `the event on the calendar is a meeting, and Board’s own invite isn’t a second one (${all.length})`);
  ok(all.find((m) => m.id === meetingId)?.invite?.replies?.['alex-rivera'] === 'accepted', 'the reply to Board’s invite comes back onto its meeting');
  await shot(jane, '08-meetings');
  await jane.goto(`${SITE}/admin/#board/settings`, { waitUntil: 'networkidle0' });
  await jane.reload({ waitUntil: 'networkidle0' });
  ok(await waitText(jane, /Invites with Google Meet\s+Board can put meetings on the calendar with a Meet/) && /Meet transcripts\s+Turned on for every invite/.test(await text(jane)) && /Attendance from Google Meet\s+After a meeting, who joined is marked/.test(await text(jane)), 'Settings: the invite check says Calendar, Meet, transcripts and attendance all work');
  const calId = all.find((m) => m.calendar)?.id;
  await jane.goto(`${SITE}/admin/#board/meeting/${calId}/before`, { waitUntil: 'networkidle0' });
  await jane.reload({ waitUntil: 'networkidle0' });
  ok(await jane.$eval('.bm-title h2', (e) => e.textContent) === 'SOARD Q4 Board Meeting', 'its editor goes by the event’s own name');
  await clickText(jane, 'button', /^Change when and where$/);
  ok(await waitText(jane, /From Jane’s calendar \(“SOARD Q4 Board Meeting”\)/), 'and says it follows the calendar');
  ok(await jane.evaluate(() => document.querySelector('#bd-date').disabled && document.querySelector('#bd-start').value === '08:00' && document.querySelector('#bd-loc').disabled && document.querySelector('#bd-loc').value === 'Example Design Group'), 'its day, time and place come from the event, and are changed there');
  ok(await waitText(jane, /Add everyone and Meet/), 'its invite is the calendar’s own: Board offers to add everyone and Meet to it');
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
    ok(/Next board meeting/i.test(home) && /See the agenda and 1 file/.test(home), 'Home: the next meeting, and its packet');
    ok(/Example Hall/.test(home) && await alex.$('.bp-next a[href^="https://www.google.com/maps/search/"]') !== null, 'Home: its place, the address opening in Maps');
    ok(await alex.$('.bp-next a[href="https://meet.google.com/abc-defg-hij"]') !== null && /Google Meet/.test(home), 'Home: the Google Meet link, in the meeting’s one line');
    ok(width === 1440 ? /Calendar invite: Coming\./.test(home) : /You said “By video\.”/.test(home), width === 1440 ? 'Home: their reply to the invite shows' : 'Home: the answer they gave here shows');
    ok(width === 1440 ? /Send the venue contract/.test(home) : !/Send the venue contract/.test(home), width === 1440 ? 'Home: their own action item' : 'Home: the action item they ticked off is gone');
    const figs = await alex.evaluate(() => Object.fromEntries([...document.querySelectorAll('.bp-fig')].map((f) => [f.querySelector('.bp-fig__label').textContent, f.querySelector('.bp-fig__value').textContent])));
    ok(Object.keys(figs).length === 4 && figs['Makeovers'] === '3' && figs['Cash in the bank'] === '$375K' && !/Recently|The money/.test(home), `Home: four figures (Mercury's cash, the makeovers), nothing repeated below (${JSON.stringify(figs)})`);
    ok(await alex.$$eval('.bp-next .bp-peek li', (l) => l.length) > 0, 'Home: the next meeting’s agenda headings, right there');
    const cols = await alex.$$eval('#makeovers .bk-col', (c) => c.map((e) => e.textContent));
    ok(/^Awaiting funding1[\s\S]*1 family/.test(cols[0]) && /^Design2[\s\S]*Leo[\s\S]*\+1 more family/.test(cols[1]) && /^Build1[\s\S]*Maya/.test(cols.at(-1)) && !/Not Published Yet|Someone Else|Coming up/.test(home), `Home: the makeovers as a kanban, Awaiting funding first, then Design to Build; published kids by name only (${JSON.stringify(cols)})`);
    const kids = await alex.$$eval('#makeovers .bk-card:not(.is-quiet)', (c) => c.map((e) => ({ text: e.querySelector('.bk-card__body').textContent, img: !!e.querySelector('.bk-card__photo img, .bk-card__initials') })));
    ok(kids.length === 2 && kids.every((k) => k.img) && kids.some((k) => /^Maya\s*Reveal \w{3} \d+ · 10 AM$/.test(k.text)) && kids.some((k) => /^Leo\s*Reveal mid December$/.test(k.text)), `Home: each kid’s card leads with their photo and carries their reveal, a set day or the part of the month (${JSON.stringify(kids)})`);
    ok(await alex.evaluate(() => /kids served/.test(document.querySelector('#impact')?.textContent || '') && document.querySelector('#impact').getBoundingClientRect().top < document.querySelector('.bp-next').getBoundingClientRect().top), 'Home: Impact near the top, under the figures');
    await alex.evaluate(() => document.querySelector('#impact .bp-impact__more').click());
    ok(await alex.waitForFunction(() => { const bars = [...document.querySelectorAll('#impact .bp-years__hit')]; return bars.length >= 1 && bars.every((b) => /^\d{4}: \d+ (kids?|rooms?)( so far)?, \d+ makeovers?$/.test(b.getAttribute('aria-label') || '')) && /\d{4}/.test(document.querySelector('.bp-yearpanel__head')?.textContent || ''); }, { timeout: 3000 }).then(() => true, () => false), 'Home: Explore by year opens a bar a year, each saying its numbers, and the year’s makeovers');
    ok(await overflow(alex) <= 0, 'Home: nothing past the right edge');
    if (width === 390) {
      const bar = await alex.evaluate(() => { const n = getComputedStyle(document.querySelector('.bp-nav')); return { pos: n.position, bottom: n.bottom, top: getComputedStyle(document.querySelector('.bp-top')).position, tabs: document.querySelectorAll('.bp-nav a').length }; });
      ok(bar.pos === 'fixed' && bar.bottom === '0px' && bar.top === 'static' && bar.tabs === 5, 'on a phone: the five pages are a bar along the bottom, and the header scrolls away');
    }
    await shot(alex, `10-home-${width}`);
    if (width === 1440) {
      await clickText(alex, '.bp-choice', /^By video$/);
      ok(await waitText(alex, /Thanks\. Jane can see your answer\./), 'they answer whether they’re coming, and it says who sees it');
      ok(await alex.evaluate(() => document.querySelector('.bp-choice[aria-pressed="true"]')?.textContent.trim() === 'By video' && getComputedStyle(document.querySelector('.bp-seg')).getPropertyValue('--at').trim() === '1'), 'their answer stays picked, the yellow marker under it');
      await alex.evaluate(() => document.querySelector('.bp-todo input').click());
      await sleep(1500);
      // Search: ⌘K, a word from the meeting's notes, Enter opens the meeting at that point
      await alex.keyboard.down('Meta'); await alex.keyboard.press('k'); await alex.keyboard.up('Meta');
      ok(await alex.waitForSelector('dialog.bp-finder[open]', { timeout: 4000 }).then(() => true, () => false), '⌘K opens search');
      await alex.keyboard.type('insurance renewal');
      // textContent, not innerText: the group's label is set in capitals by CSS
      ok(await alex.waitForFunction(() => /In agendas and minutes[\s\S]*Insurance renewal/.test(document.querySelector('.bp-finder__list')?.textContent || ''), { timeout: 4000 }).then(() => true, () => false), 'search finds the point in the agenda');
      ok(!/ask counsel/.test(await text(alex)), 'search never shows the private note');
      await alex.keyboard.press('Enter');
      ok(await alex.waitForFunction((id) => location.hash === `#/meetings/${id}`, { timeout: 4000 }, meetingId).then(() => true, () => false), 'Enter opens the meeting');
      ok(await alex.waitForSelector('.bp-item.is-found', { timeout: 4000 }).then(() => true, () => false), 'and marks the point it found');
    }

    await alex.goto(`${SITE}/admin/board/#/meetings/${meetingId}`, { waitUntil: 'networkidle0' });
    ok(await waitText(alex, /Insurance renewal is on track/), 'the meeting: the notes, as points');
    ok(/It’s on your calendar: the invite went to alex\.board@example\.com/.test(await text(alex)), 'the meeting: it’s already on their calendar, so no file to add');
    const page = await text(alex);
    ok(!/ask counsel/.test(page) && !/ask counsel/.test(await alex.content()), 'the meeting: never the private note, not even in the page source');
    ok(/Board only · please don’t share/.test(page), 'the meeting: the board-only item is marked');
    ok(/locked for this meeting/i.test(page), 'the meeting: the locked numbers say when they’re from');
    ok(await alex.evaluate(() => { const it = [...document.querySelectorAll('.bp-agitem')].find((x) => /Project updates/.test(x.textContent)); return !!it && it.querySelectorAll('.bk-col').length >= 3 && /Leo/.test(it.textContent) && /Maya/.test(it.textContent); }), 'the meeting: its makeovers item is the kanban, kids by stage');
    ok(await alex.evaluate(() => { const it = [...document.querySelectorAll('.bp-agitem')].find((x) => /^Financial/.test(x.querySelector('.bp-agitem__title')?.textContent || '')); return !!it && /Cash in the bank\s*\$375,000/.test(it.textContent) && /2026 so far/.test(it.textContent); }), 'the meeting: the Financial item shows the money as figures');
    ok(await alex.evaluate(() => [...document.querySelectorAll('.bp-agsec__n')].map((n) => n.textContent).slice(0, 3).join() === '01,02,03'), 'the meeting: its parts as numbered chapters');
    ok(await alex.evaluate(() => /^8:00 AM · \d+ min$/.test(document.querySelector('.bp-agsec__time')?.textContent.trim() || '')), 'the meeting: each part’s time, the run of show');
    ok(/Financial[\s\S]*Balance sheet financials/.test(page), 'the meeting: the statement under its Financial item, by readable name');
    if (width === 390) {
      ok(await alex.evaluate(() => document.querySelector('.bp-aghero .bp-rsvp').getBoundingClientRect().top < document.querySelector('.bp-ag__body').getBoundingClientRect().top), 'on a phone: their answer comes before the agenda');
    }
    ok(await overflow(alex) <= 0, 'the meeting: nothing past the right edge');
    await shot(alex, `11-meeting-${width}`);
    if (width === 1440) {
      await clickText(alex, '.bp-doctile', /Balance sheet financials/);
      ok(await alex.waitForSelector('.fv-host *', { timeout: 6000 }).then(() => true, () => false), 'a file opens in the viewer over the page');
      await alex.keyboard.press('Escape');
      ok(await alex.evaluate(async () => (await fetch('/api/board-admin')).status) === 403, 'the Board area’s API refuses a board member');
    }

    for (const [p, re] of [
      ['financials', /Cash in the bank[\s\S]*\$375,000[\s\S]*Straight from Mercury, read today at[\s\S]*The latest statements[\s\S]*Balance sheet financials[\s\S]*Money in and out[\s\S]*Money in\s+\$900,000\s+\$800,000[\s\S]*Money out\s+\$850,000[\s\S]*Makeovers[\s\S]*Net\s+\$50,000\s+−\$20,000[\s\S]*Live from Mercury’s record\. The official books are in Mercury Books\.[\s\S]*Cash over time[\s\S]*The lowest point: \$210,000[\s\S]*The least we keep in the bank: \$150,000[\s\S]*Tax returns and audits[\s\S]*2025/],
      ['people', /Board of Directors[\s\S]*Alex Rivera[\s\S]*The team[\s\S]*Jane Doe/],
      ['documents', width === 1440 ? /Conflict of interest policy[\s\S]*Read it[\s\S]*Type your full name to sign it[\s\S]*Every meeting’s files[\s\S]*Balance sheet financials/ : /Conflict of interest policy[\s\S]*Read it[\s\S]*Signed\s*by Alex Rivera/],
    ]) {
      await alex.goto(`${SITE}/admin/board/#/${p}`, { waitUntil: 'networkidle0' });
      ok(await waitText(alex, re), `${p} shows what it should`);
      ok(await overflow(alex) <= 0, `${p}: nothing past the right edge`);
      await shot(alex, `12-${p}-${width}`);
    }
    if (width === 1440) {
      await clickText(alex, 'button', /^I’ve read it and agree$/);
      ok(await waitText(alex, /Type your full name, the way you sign it/), 'signing with no name says what to do');
      await alex.type('.bp-sign input', 'Alex Rivera');
      await clickText(alex, 'button', /^I’ve read it and agree$/);
      ok(await waitText(alex, /Signed\s*by Alex Rivera/), 'they sign the policy with their typed name');
      await alex.goto(`${SITE}/admin/board/#/reveals`, { waitUntil: 'networkidle0' });
      ok(await alex.evaluate(() => location.hash) === '#/' && await waitText(alex, /awaiting funding, from JobTread/), 'the old Reveals link opens Home, where reveals are now');
      await alex.goto(`${SITE}/admin/board/#/meetings/${pastId}`, { waitUntil: 'networkidle0' });
      ok(!(await waitText(alex, /Reserves grew/, 2000)), 'a meeting not shared stays off the board page');
    } else {
      await alex.goto(`${SITE}/admin/board/#/`, { waitUntil: 'networkidle0' });
      await clickText(alex, '.bp-nav a', /^Meetings$/);
      ok(await waitText(alex, /Every agenda, with the notes/), 'the tab bar opens Meetings');
    }
    await alex.close();
  }

  // ─── The founder sees what the board did, and sees the board page as they do ───
  console.log('Back to the founder');
  await jane.goto(`${SITE}/admin/#board/meeting/${meetingId}/before`, { waitUntil: 'networkidle0' });
  await jane.reload({ waitUntil: 'networkidle0' });
  ok(await waitText(jane, /By video\s+1\s+Alex Rivera/), 'the founder sees Alex’s answer');
  ok((await meetingNow(jane, meetingId)).actions.some((a) => a.text === 'Send the venue contract' && a.done), 'and that Alex ticked off the action item');
  await jane.goto(`${SITE}/admin/#board/documents`, { waitUntil: 'networkidle0' });
  ok(await waitText(jane, /Signed by Alex Rivera/), 'and who signed the policy');
  await jane.goto(`${SITE}/admin/board/`, { waitUntil: 'networkidle0' });
  ok(await waitText(jane, /awaiting funding, from JobTread/) && !/the way board members do/.test(await text(jane)), 'the founder sees the board page as the board does, with no banner saying so');
  ok(await jane.evaluate(() => !document.querySelector('.bp-choice') && !document.querySelector('.bp-sign')), 'with nothing to answer or sign for anyone');
  await jane.click('.bp-me__btn');
  ok(await jane.evaluate(() => [...document.querySelectorAll('.bp-menu a')].some((a) => a.getAttribute('href') === '/admin/#board' && /Back to the Board area/.test(a.textContent))), 'the account menu has the way back to the Board area');

  // ─── The chair runs a meeting live (board-meeting.js During), in the practice meeting with simulated members ───
  console.log('The chair, running a practice meeting live');
  await jane.goto(`${SITE}/admin/#board/practice`, { waitUntil: 'networkidle0' });
  await jane.reload({ waitUntil: 'networkidle0' });
  ok(await waitText(jane, /Practice meeting\.[\s\S]*Only you/), 'Practice opens a meeting only the admins see, its members simulated');
  ok(await jane.evaluate(() => !document.querySelector('.bm-stages') && !!document.querySelector('.bm-run.is-ready')), 'just the meeting as it’s held, ready to start');
  const practiceId = await jane.$eval('a[href*="/admin/board/#/meetings/"]', (a) => a.getAttribute('href').split('/').pop());
  await clickText(jane, 'button', /^Start the meeting$/);
  ok(await jane.waitForSelector('.bm-run.is-live', { timeout: 5000 }).then(() => true, () => false), 'Start puts it live, with a clock');
  ok(await saved(jane), 'and saves at once');
  const firstItem = await jane.$eval('.bm-run__title', (e) => e.textContent);
  await jane.evaluate(() => document.activeElement?.blur());
  await jane.keyboard.press('ArrowRight');
  ok(firstItem === 'The cover', 'Start puts the cover on the screen: the meeting and its agenda');
  ok(await jane.waitForFunction(() => /Call to order|Since we last met/.test(document.querySelector('.bm-run__title')?.textContent || ''), { timeout: 4000 }).then(() => true, () => false), 'the next press opens the first part with its card');
  ok(await jane.waitForFunction((t) => document.querySelector('.bm-run__title')?.textContent !== t, { timeout: 4000 }, firstItem).then(() => true, () => false), '→ moves to the next item');
  // Past the part's card and its first item, so one item is done and one is on now
  for (let k = 0; k < 2; k++) {
    const was = await jane.$eval('.bm-run__title', (e) => e.textContent);
    await jane.keyboard.press('ArrowRight');
    await jane.waitForFunction((t) => document.querySelector('.bm-run__title')?.textContent !== t, { timeout: 4000 }, was).catch(() => {});
  }
  ok(await jane.evaluate(() => !!document.querySelector('.bm-order__item.is-now .bm-live-dot')), 'the item being discussed is marked in the agenda, in order');
  ok(await saved(jane), 'each move saves at once');
  let follow = await jane.evaluate(async (id) => (await fetch(`/api/board-portal?live=${id}`)).json(), practiceId);
  ok(follow.practice && follow.me.canAct && follow.live.itemId && follow.live.startedAt, 'the board page follows it: live, on the same item; the founder acts as one more member there');
  ok(await jane.waitForFunction(() => Number(document.querySelector('.bm-quorum__n b')?.textContent || 0) > 0, { timeout: 45000 }).then(() => true, () => false), 'the simulated members check in, and the count toward the quorum fills itself in');
  await clickText(jane, 'button', /^Open the vote$/);
  ok(await jane.waitForSelector('.bm-vote', { timeout: 5000 }).then(() => true, () => false), 'Open the vote shows it live');
  await saved(jane);
  follow = await jane.evaluate(async (id) => {
    for (let n = 0; n < 20; n++) { const j = await (await fetch(`/api/board-portal?live=${id}`)).json(); if (j.vote?.motionId) return j; await new Promise((r) => setTimeout(r, 250)); }
    return (await fetch(`/api/board-portal?live=${id}`)).json();
  }, practiceId);
  ok(!!follow.vote?.motionId, 'and the board page has the vote open');
  // ─── The same meeting on the board page (portal.js): the live room, checking in and voting ───
  console.log('The board page, following the practice meeting');
  const room = await tab(FOUNDER, 1440);
  await room.goto(`${SITE}/admin/board/#/meetings/${practiceId}`, { waitUntil: 'networkidle0' });
  ok(await room.waitForSelector('.bp-livehead', { timeout: 8000 }).then(() => true, () => false), 'the board page opens the meeting live');
  ok(await room.evaluate(() => /Live/.test(document.querySelector('.bp-livechip.is-live')?.textContent || '') && /Practice/.test(document.querySelector('.bp-livehead').textContent)), 'marked Live, and Practice');
  ok(await room.evaluate(() => !!document.querySelector('.bp-now .bp-now__title')?.textContent.trim() && !!document.querySelector('.bp-liveag__item.is-now') && !!document.querySelector('.bp-liveag__item.is-done')), 'Now discussing: the chair’s item, the one before it done');
  ok(await room.evaluate(() => !!document.querySelector('.bp-vote') && [...document.querySelectorAll('.bp-vote__choice')].every((b) => b.disabled)), 'the vote is up; voting waits for checking in');
  await clickText(room, '.bp-checkin button', /^I’m in the room$/);
  ok(await room.waitForSelector('.bp-here', { timeout: 5000 }).then(() => true, () => false) && !(await room.$('.bp-checkin')), 'one tap checks in');
  await clickText(room, '.bp-vote__choice', /^For$/);
  ok(await room.waitForFunction(() => document.querySelector('.bp-vote__choice[aria-pressed="true"]')?.textContent.trim() === 'For', { timeout: 5000 }).then(() => true, () => false), 'one tap votes, and stays picked');
  ok(/You voted for\. You can change it until the chair closes the vote\./.test(await text(room)), 'and says it can change until the vote closes');
  ok(await room.waitForFunction(() => /[1-9]\d* of \d+ here ha(s|ve) voted/.test(document.querySelector('.bp-vote__of')?.textContent || ''), { timeout: 30000 }).then(() => true, () => false), 'the count fills in as the board votes');
  ok(await overflow(room) <= 0, 'the live room: nothing past the right edge');
  await shot(room, '17-board-page-live-1440');
  const roomPhone = await tab(FOUNDER, 390);
  await roomPhone.goto(`${SITE}/admin/board/#/meetings/${practiceId}`, { waitUntil: 'networkidle0' });
  ok(await roomPhone.waitForSelector('.bp-vote', { timeout: 8000 }).then(() => true, () => false) && await overflow(roomPhone) <= 0, 'on a phone: the vote first, nothing past the edge');
  await shot(roomPhone, '17-board-page-live-390');
  await roomPhone.close();
  ok(await jane.waitForFunction(() => document.querySelectorAll('.bm-vote__who li').length > 0, { timeout: 30000 }).then(() => true, () => false), 'votes arrive as the members tap them');
  await shot(jane, '15-practice-voting');
  await clickText(jane, 'button', /^Close the vote$/);
  ok(await waitText(jane, /(Passed|Did not pass) \d+–\d+/), 'Close records the result with its tally');
  ok(await saved(jane), 'and saves it');
  await clickText(jane, 'button', /^End the meeting$/);
  ok(await jane.waitForSelector('.bm-run.is-ended', { timeout: 5000 }).then(() => true, () => false), 'End closes the meeting');
  await shot(jane, '16-practice-ended');
  // The board tab was behind the chair's (a hidden tab asks every 15s, a shown one every 3s): look at it, as a person would
  await room.bringToFront();
  ok(await room.waitForSelector('.bp-livehead.is-ended', { timeout: 20000 }).then(() => true, () => false) && /The meeting is over/i.test(await text(room)) && /(Passed|Did not pass) \d+–\d+/.test(await text(room)), 'the board page follows the end: over, with the decision and its tally');
  await shot(room, '18-board-page-ended-1440');
  await room.close();
  await jane.goto(`${SITE}/admin/#board`, { waitUntil: 'networkidle0' });
  await jane.reload({ waitUntil: 'networkidle0' });
  await waitText(jane, /Past meetings/);
  ok(!(await jane.evaluate(() => [...document.querySelectorAll('.bd-row-list a, .bh-next a')].some((a) => /Practice meeting/.test(a.textContent)))), 'the practice meeting is never in the Board area’s list');
  ok(await jane.$('a[href="#board/practice"]') !== null, 'one quiet link leads to it');

  // ─── Presenting the meeting (board-present.js, board/screen.js): rehearse, start, a document page by page ───
  console.log('Presenting the meeting on the screen');
  await jane.goto(`${SITE}/admin/#board/meeting/${meetingId}/during`, { waitUntil: 'networkidle0' });
  await jane.reload({ waitUntil: 'networkidle0' });
  ok(await jane.waitForSelector('.bm-run.is-ready', { timeout: 8000 }).then(() => true, () => false), 'During: ready to start');
  const scr = await tab(FOUNDER, 1280);
  await scr.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await scr.goto(`${SITE}/admin/board/#/meetings/${meetingId}/screen`, { waitUntil: 'networkidle0' });
  ok(await scr.waitForSelector('.bs-cover', { timeout: 8000 }).then(() => true, () => false), 'the screen opens on the cover');
  ok(await scr.evaluate(() => !document.querySelector('.bp-top') && /Committee reports/.test(document.querySelector('.bs-outline')?.textContent || '')), 'full window, no board page header; the agenda’s sections on the cover');
  await shot(scr, '20-screen-cover');
  await jane.bringToFront();
  ok(await jane.waitForSelector('.bm-run.is-rehearsing', { timeout: 6000 }).then(() => true, () => false), 'the chair’s During knows the screen is open, to rehearse on');
  const screenFoot = () => scr.evaluate(() => document.querySelector('.bs-foot__what')?.textContent || '');
  let hops = 0;
  while (hops < 25 && !/Balance sheet financials/.test(await screenFoot())) { await jane.keyboard.press('ArrowRight'); await sleep(250); hops += 1; }
  ok(await scr.waitForFunction(() => /Financial.*Balance sheet financials.*Page 1 of 2/.test(document.querySelector('.bs-foot__what')?.textContent || ''), { timeout: 8000 }).then(() => true, () => false), '→ steps the screen through the items to the Financial item’s statement, page 1 of 2');
  ok(await scr.waitForFunction(() => document.querySelector('.bs-page__sheet canvas')?.width > 0, { timeout: 8000 }).then(() => true, () => false), 'the page is drawn, as big as the screen allows');
  ok(await scr.evaluate(() => /Sam Ortiz/.test(document.querySelector('.bs-foot__who')?.textContent || '')), 'with who presents it');
  await shot(scr, '21-screen-document');
  await jane.keyboard.press('ArrowRight');
  ok(await scr.waitForFunction(() => /Page 2 of 2/.test(document.querySelector('.bs-foot__what')?.textContent || ''), { timeout: 3000 }).then(() => true, () => false), 'the next press is page 2');
  await scr.bringToFront();
  await scr.keyboard.press('ArrowLeft');
  ok(await scr.waitForFunction(() => /Page 1 of 2/.test(document.querySelector('.bs-foot__what')?.textContent || ''), { timeout: 3000 }).then(() => true, () => false), 'a key pressed on the screen (a clicker) moves it too');
  await scr.keyboard.press('ArrowLeft');
  ok(await scr.waitForSelector('.bs-item', { timeout: 3000 }).then(() => true, () => false) && await scr.evaluate(() => /Financial/.test(document.querySelector('.bs-item__title')?.textContent || '') && /Sam Ortiz/.test(document.querySelector('.bs-who')?.textContent || '') && /Balance sheet financials/.test(document.querySelector('.bs-coming')?.textContent || '')), 'the item’s card: its title, who presents with their face, its documents');
  await shot(scr, '22-screen-item');
  // The makeovers item on the screen: the kanban, every card in view
  while (hops < 60 && !(await scr.$('.bk--screen'))) { await jane.bringToFront(); await jane.keyboard.press('ArrowRight'); await sleep(200); hops += 1; }
  ok(await scr.waitForSelector('.bk--screen .bk-col', { timeout: 4000 }).then(() => true, () => false) && await scr.evaluate(() => { const b = document.querySelector('.bk--screen').getBoundingClientRect(); return b.bottom <= innerHeight && b.right <= innerWidth && /Maya/.test(document.querySelector('.bk--screen').textContent); }), 'the makeovers item on the screen is the kanban, all of it in view');
  await shot(scr, '22b-screen-makeovers');
  ok((await meetingNow(jane, meetingId)).live.startedAt === '', 'rehearsing never puts the meeting live');
  await jane.bringToFront();
  await clickText(jane, 'button', /^Start the meeting$/);
  ok(await jane.waitForSelector('.bm-run.is-live', { timeout: 5000 }).then(() => true, () => false), 'Start puts it live');
  ok(await scr.waitForSelector('.bs-cover', { timeout: 4000 }).then(() => true, () => false), 'and the screen opens on the cover');
  ok(await saved(jane), 'saved');
  await clickText(jane, '.bm-showdoc', /^Balance sheet financials$/);
  ok(await scr.waitForFunction(() => /Balance sheet financials.*Page 1 of 2/.test(document.querySelector('.bs-foot__what')?.textContent || ''), { timeout: 4000 }).then(() => true, () => false), 'a document tapped in the agenda goes straight on the screen');
  ok(await scr.evaluate(() => !!document.querySelector('.bs-rail li.is-on') && /Next: Page 2/i.test(document.querySelector('.bs-rail__next')?.textContent || '')), 'the rail along the bottom: where the meeting is, and what the next press shows');
  ok(await scr.waitForFunction(() => /\d+:\d\d left/.test(document.querySelector('.bs-timer')?.textContent || '') && /Sam Ortiz has the floor/.test(document.querySelector('.bs-floor')?.textContent || ''), { timeout: 4000 }).then(() => true, () => false), 'the screen: the part’s time left, and who has the floor (whoever presents the item)');
  ok(await jane.evaluate(() => /left/.test(document.querySelector('.bm-timer')?.textContent || '') && /Sam Ortiz has the floor/.test(document.querySelector('.bm-floor')?.textContent || '')), 'the chair sees the same: the time left and who has the floor');
  await jane.evaluate(() => document.querySelector('.bm-floor .bd-menu > summary').click());
  await sleep(150);
  ok(await clickText(jane, '.bd-menu[open] .bd-menu__item', /^Alex Rivera$/), 'the chair can give the floor to someone else');
  ok(await scr.waitForFunction(() => /Alex Rivera has the floor/.test(document.querySelector('.bs-floor')?.textContent || ''), { timeout: 4000 }).then(() => true, () => false), 'and the screen follows');
  ok(await saved(jane), 'and saves where the screen is');
  // The save that follows Show may start a moment after the last one's "Saved": ask until it's there
  const liveNow = await jane.evaluate(async (id) => {
    for (let n = 0; n < 20; n++) { const j = await (await fetch(`/api/board-portal?live=${id}`)).json(); if (j.live?.fileId) return j; await new Promise((r) => setTimeout(r, 250)); }
    return (await fetch(`/api/board-portal?live=${id}`)).json();
  }, meetingId);
  ok(liveNow.live.fileId && liveNow.live.page === 0 && liveNow.files.length >= 1 && !JSON.stringify(liveNow).includes('PRIVATE'), 'the board page’s live view has the document on the screen, never a private note');
  await shot(jane, '23-chair-presenting');
  // A board member following on their own screen
  const alexLive = await tab(MEMBER, 1440);
  await alexLive.goto(`${SITE}/admin/board/#/meetings/${meetingId}`, { waitUntil: 'networkidle0' });
  ok(await alexLive.waitForSelector('.bp-peek', { timeout: 8000 }).then(() => true, () => false) && /On the screen: Balance sheet financials, page 1/.test(await text(alexLive)), 'a member’s live room shows the page on the screen, with Follow the screen');
  ok(await alexLive.waitForFunction(() => document.querySelector('.bp-peek__page canvas')?.width > 0, { timeout: 8000 }).then(() => true, () => false), 'drawn small on their page');
  await shot(alexLive, '24-member-follows');
  await clickText(alexLive, '.bp-peek a', /^Follow the screen$/);
  ok(await alexLive.waitForFunction(() => /Page 1 of 2/.test(document.querySelector('.bs-foot__what')?.textContent || ''), { timeout: 8000 }).then(() => true, () => false), 'Follow the screen: the same page, full size, following the chair');
  await alexLive.close();
  await jane.bringToFront();
  await clickText(jane, 'button', /^End the meeting$/);
  ok(await scr.waitForSelector('.bs-end', { timeout: 5000 }).then(() => true, () => false), 'End: the screen says thank you');
  await shot(scr, '25-screen-end');
  await scr.close();

  // ─── Print it all (board/print.js), on the board page ───
  console.log('Print it all');
  const alexPrint = await tab(MEMBER, 1440);
  await alexPrint.goto(`${SITE}/admin/board/#/meetings/${meetingId}`, { waitUntil: 'networkidle0' });
  ok(await waitText(alexPrint, /Balance sheet financials/) && await alexPrint.evaluate(() => [...document.querySelectorAll('.bp-item')].some((x) => /Financial/.test(x.querySelector('.bp-item__title')?.textContent || '') && /Balance sheet financials/.test(x.querySelector('.bp-item__docs')?.textContent || ''))), 'on the board page the statement is under the Financial item');
  await alexPrint.evaluate(() => { window.print = () => { window.__printing = true; }; });
  await clickText(alexPrint, 'button', /Print it all/);
  ok(await alexPrint.waitForFunction(() => window.__printing, { timeout: 15000 }).then(() => true, () => false), 'Print it all gets every page ready, then opens the print window');
  const printed = await alexPrint.evaluate(() => ({ pages: document.querySelectorAll('.bpp-page').length, imgs: document.querySelectorAll('.bpp-page img').length, agenda: document.querySelector('.bpp-agenda')?.innerText || '' }));
  ok(printed.pages === 2 && printed.imgs === 2, `the statement’s 2 pages, drawn (${printed.pages} pages, ${printed.imgs} pictures)`);
  ok(/Financial/.test(printed.agenda) && /Sam Ortiz/.test(printed.agenda) && /With it: Balance sheet financials/.test(printed.agenda) && !/PRIVATE/.test(printed.agenda), 'the agenda first: who presents, what goes with each item, never a private note');
  await alexPrint.pdf({ path: join(OUT, '26-print-it-all.pdf'), format: 'letter', printBackground: true });
  await alexPrint.evaluate(() => dispatchEvent(new Event('afterprint')));
  ok(await alexPrint.waitForFunction(() => !document.querySelector('.bpp') && !document.querySelector('.bp-printing'), { timeout: 5000 }).then(() => true, () => false), 'afterwards it’s all taken away again');
  await alexPrint.close();

  // The editor on a phone
  const phone = await tab(FOUNDER, 390);
  for (const s of ['before', 'during', 'after']) {
    await phone.goto(`${SITE}/admin/#board/meeting/${meetingId}/${s}`, { waitUntil: 'networkidle0' });
    await phone.reload({ waitUntil: 'networkidle0' });
    await waitText(phone, /All meetings/);
    ok(await overflow(phone) <= 0, `the meeting editor’s ${s} step fits a phone`);
    await shot(phone, `13-editor-${s}-390`);
  }
  await phone.goto(`${SITE}/admin/#board/members`, { waitUntil: 'networkidle0' });
  await waitText(phone, /The board/);
  ok(await overflow(phone) <= 0, 'Members fits a phone');
  await shot(phone, '14-members-390');

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
