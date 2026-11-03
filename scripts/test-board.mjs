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
 *     the president's calendar with Google Meet (never transcripts), the place
 *     added after (one update, once it settles), shared, the documents
 *     emailed with nothing attached; the numbers lock themselves on the day.
 *     A save someone else made meanwhile merges. During: the agenda in
 *     order, a vote.
 *   - Documents (one asking for a signature), Members (Cloudflare's steps,
 *     the sign-in email, who runs Board and whose calendar invites come from);
 *     no Settings tab (an old #board/settings link opens Members), the
 *     reports' emails switch beside the reports, the quorum in Who's coming
 *   - a board member opening /admin/ lands on /admin/board/; Home (the next
 *     meeting with its place, Google Meet, already on their calendar, the
 *     makeovers by stage, coming up), answering whether they'll come, ticking
 *     off their action, search (⌘K) landing on a point in the minutes and opening
 *     a file at the words it was found by, the
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
import { provideBoardFinance, maybeLockNumbers, takeSnapshot, saveMeeting, getMeeting, patchMeeting, listDocs } from '../functions/api/_board.js';
import { maybeReadGifts } from '../functions/api/_board-gifts.js';
import { readBoardWords } from '../functions/api/_board-file-words.js';
import { maybeRefreshInvites, maybeCheckInvites } from '../functions/api/_board-invite.js';
import { syncBoardGroup } from '../functions/api/_board-group.js';
import { syncBoardCalendar } from '../functions/api/_board-calendar.js';
import { FIELD_JOB_STATUS } from '../functions/api/_reveals.js';
import { docxText, unzip, cleanMeeting, reportSlides } from '../public/admin/board-shared.js';
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
  'jane-doe': { name: 'Jane Doe', group: 'team', title: 'Co-Founder/President', order: 1, photo: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/team/jane-doe/1/public' },
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
// board@soardcharity.com in Google: its owner, and someone who left the board long ago. The group permission comes later
let boardGroup = [{ email: FOUNDER, role: 'OWNER', type: 'USER' }, { email: 'gone.member@example.com', role: 'MEMBER', type: 'USER' }];
let groupScope = false;
// Board keeps the board's papers itself (Nov 3 2026): it never reads Google Drive
let driveCalls = 0;
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
  if (url === 'https://oauth2.googleapis.com/token') {
    const claims = JSON.parse(Buffer.from(new URLSearchParams(init.body).get('assertion').split('.')[1], 'base64url').toString());
    if (/admin\.directory\.group\.member/.test(claims.scope) && !groupScope) return Response.json({ error: 'unauthorized_client', error_description: 'Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested.' }, { status: 401 });
    return Response.json({ access_token: 'g-test', expires_in: 3600 });
  }
  const groupCall = url.match(/^https:\/\/admin\.googleapis\.com\/admin\/directory\/v1\/groups\/board%40soardcharity\.com\/members(?:\/([^?]+))?/);
  if (groupCall) {
    if (method === 'GET') return Response.json({ members: boardGroup });
    if (method === 'POST') { const b = JSON.parse(init.body); boardGroup.push({ email: b.email, role: b.role, type: 'USER' }); return Response.json(b); }
    if (method === 'DELETE') { boardGroup = boardGroup.filter((x) => x.email !== decodeURIComponent(groupCall[1])); return new Response(null, { status: 204 }); }
  }
  if (url.startsWith('https://gmail.googleapis.com/')) return Response.json({ messages: [], resultSizeEstimate: 0 });
  if (url.startsWith('https://www.googleapis.com/drive/v3/')) { driveCalls += 1; return Response.json({ files: [] }); }
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

/** Made-up expectations, the way a board writes them: the letterhead, a title, headings, points, a paragraph over two lines, the blanks to sign */
async function expectationsPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 792]);
  let y = 740;
  const line = (text, { size = 11, f = font, gap = size * 1.5 } = {}) => { y -= gap; page.drawText(text, { x: 72, y, size, font: f }); };
  line('SUNSHINE ON A RANNEY DAY', { size: 9, f: bold });
  line('Board Member Expectations', { size: 20, f: bold, gap: 34 });
  line('Each member of the board agrees to the following for the year. We ask every', { gap: 30 });
  line('member to read them and sign each January.');
  line('ATTENDANCE', { size: 13, f: bold, gap: 28 });
  line('• Attend at least three of four board meetings');
  line('• Serve on one committee');
  line('Giving and asking', { size: 13, f: bold, gap: 28 });
  line('1. Make a personal gift each year');
  line('2. Open one door for a sponsor or a partner');
  line('Signature: ______________________     Date: __________', { gap: 48 });
  return Buffer.from(await doc.save());
}
/** The caret at the end of the words editor (ProseMirror follows the page's selection) */
const toEnd = (page) => page.evaluate(() => { const el = document.querySelector('.rp-edit'); el.focus(); const r = document.createRange(); r.selectNodeContents(el.lastElementChild || el); r.collapse(false); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); });
const editorText = (page) => page.evaluate(() => document.querySelector('.rp-edit')?.innerText || '');

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
/** The open pop-up is in the top layer, inside the window, and nothing covers it from its top to its bottom */
const onTop = (page) => page.evaluate(() => {
  const p = document.querySelector('.bd-pop__panel');
  if (!p) return 'none open';
  const r = p.getBoundingClientRect();
  if (!p.matches(':popover-open')) return 'not in the top layer';
  if (r.top < 0 || r.bottom > innerHeight + 1 || r.left < 0 || r.right > innerWidth + 1) return `outside the window ${JSON.stringify(r)}`;
  const miss = [0.06, 0.3, 0.5, 0.7, 0.94].filter((f) => !p.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height * f)));
  return miss.length ? `covered at ${miss.join(', ')}` : true;
});


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
  ok(await jane.evaluate(() => document.activeElement?.matches('input[aria-label="Meeting date"]')), 'New meeting puts the focus in its date');
  await jane.keyboard.press('Escape');
  ok(await jane.waitForFunction(() => !document.querySelector('input[aria-label="Meeting date"]') && document.activeElement?.textContent.trim() === 'New meeting', { timeout: 2000 }).then(() => true, () => false), 'Esc puts New meeting back, with the focus on it');
  await clickText(jane, 'button', /^New meeting$/);
  await jane.waitForSelector('input[aria-label="Meeting date"]');
  await jane.evaluate((d) => { const el = document.querySelector('input[aria-label="Meeting date"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, d); el.dispatchEvent(new Event('input', { bubbles: true })); }, day(14));
  await clickText(jane, 'button', /^Add$/);
  ok(await waitText(jane, /Getting ready/), 'a new meeting opens on Before, with Getting ready');
  ok(!/Use this agenda|Write the agenda|Lock them/.test(await text(jane)), 'the agenda is ready as drafted: nothing to approve, write or lock');
  const meetingId = decodeURIComponent((await jane.evaluate(() => location.hash)).split('/')[2]);
  // Its time and place are the last meeting's (there's no setting for the usual ones)
  { const fresh = await meetingNow(jane, meetingId); ok(fresh && [fresh.start, fresh.end, fresh.location, fresh.address].join('|') === '08:00|10:00|Example Hall|', `a new meeting takes the last meeting’s time and place (${fresh && [fresh.start, fresh.end, fresh.location].join(' ')})`); }
  const t1 = await text(jane);
  ok(await jane.evaluate(() => [...document.querySelectorAll('.agx-item__title')].some((i) => /^Minutes of the /.test(i.value))), 'the last meeting’s minutes are up for approval');
  const chips = await jane.evaluate(() => [...document.querySelectorAll('.bd-showpick .agx-live')].map((x) => x.textContent.trim()));
  ok(chips.includes('The money') && chips.includes('Makeovers in progress'), `the agenda marks the items that show live numbers (${chips.join(', ')})`);
  // An item shows more than one live list: the makeovers and the reveals under one item, in the order picked
  await jane.evaluate(() => [...document.querySelectorAll('.agx-item')].find((x) => x.querySelector('.bd-showpick .agx-live.is-projects'))?.querySelector('.bd-showpick .bd-pop__btn').scrollIntoView({ block: 'center' }));
  await sleep(300);
  await jane.evaluate(() => [...document.querySelectorAll('.agx-item')].find((x) => x.querySelector('.bd-showpick .agx-live.is-projects'))?.querySelector('.bd-showpick .bd-pop__btn').click());
  await jane.waitForSelector('.bd-pop__panel .bd-picker__opt', { timeout: 3000 }).catch(() => {});
  { const top = await onTop(jane); ok(top === true, `the Shows list draws over everything (${top})`); }
  // From the keyboard: the list has the focus as it opens (on the one shown), ↓ along it, Enter picks, Alt+↑ moves a
  // picked one earlier, and the order under the list has Earlier
  ok(await jane.evaluate(() => document.activeElement?.getAttribute('role') === 'option' && /Makeovers in progress/.test(document.activeElement.textContent)), 'the Shows list has the focus as it opens, on the one shown');
  await jane.keyboard.press('ArrowDown');
  ok(await jane.evaluate(() => /Upcoming reveals/.test(document.activeElement?.textContent || '')), '↓ moves along the list');
  await jane.keyboard.press('Enter');
  const showOrder = () => jane.$$eval('.bd-showorder .bd-showorder__t', (l) => l.map((x) => x.firstChild.textContent.trim()).join(', '));
  await jane.keyboard.down('Alt'); await jane.keyboard.press('ArrowUp'); await jane.keyboard.up('Alt');
  ok(await showOrder() === 'Upcoming reveals, Makeovers in progress', `Alt+↑ puts a picked one first (${await showOrder()})`);
  await jane.evaluate(() => document.querySelector('.bd-showorder__up')?.click());
  ok(await showOrder() === 'Makeovers in progress, Upcoming reveals', `Earlier puts the other back first (${await showOrder()})`);
  await jane.keyboard.press('Escape');
  let alsoNow = '';
  for (let k = 0; k < 30 && alsoNow !== 'reveals'; k++) { await sleep(300); alsoNow = (await meetingNow(jane, meetingId)).sections.flatMap((x) => x.items).find((it) => it.live === 'projects')?.also?.join() || ''; }
  ok(alsoNow === 'reveals' && await saved(jane), `an item shows a second live list, kept in the order picked (${alsoNow})`);
  ok((await jane.evaluate(() => [...document.querySelectorAll('.agx-item')].find((x) => x.querySelector('.agx-live.is-projects'))?.querySelectorAll('.bd-showpick .agx-live').length)) === 2, 'both show on the item');

  // Board only, and a private note, from an item's ⋯ menu
  ok(await itemMenu(jane, 'Governance', /^Board only/), 'an item’s menu marks it board only');
  ok(await waitText(jane, /Board only/), 'and it shows as board only');
  ok(await itemMenu(jane, 'Governance', /^Private note/), 'an item’s menu adds a private note');
  await jane.waitForSelector('textarea[aria-label="Your private note"]');
  await jane.click('textarea[aria-label="Your private note"]');
  await sleep(100);
  await jane.keyboard.type('PRIVATE: ask counsel first');
  // A file
  await (await jane.$('.bd-drop input[type="file"]')).uploadFile(pdf);
  ok(await waitText(jane, /Balance sheet financials/), 'a PDF uploads to the meeting, by its readable name');
  // (one kind of file so far: the packet has no heading of its own over it)
  ok(await jane.evaluate(async (id) => (await (await fetch('/api/board-admin')).json()).meetings.find((x) => x.id === id)?.files.some((f) => f.kind === 'financials' && /Balance.sheet/i.test(f.name)) && !document.querySelector('#bm-packet .bm-group'), meetingId), 'a file named like financials is filed as one, and one kind of file has no heading over it');
  // Last meeting's minutes, put in the packet for their approval, never become this meeting's minutes
  await (await jane.$('#bm-packet input[type="file"]')).uploadFile(docx);
  await jane.waitForFunction(() => document.querySelectorAll('#bm-packet .bf-file:not(.is-up)').length >= 2, { timeout: 8000 }).catch(() => {});
  const packetMinutes = await jane.evaluate(async (id) => (await (await fetch('/api/board-admin')).json()).meetings.find((x) => x.id === id)?.files.find((f) => /minutes/i.test(f.name)), meetingId);
  ok(packetMinutes && packetMinutes.kind !== 'minutes' && await jane.evaluate((fid) => !!document.querySelector(`#bm-packet [data-file="${fid}"]`), packetMinutes.id), `a minutes file dropped in the packet stays in the packet, filed as ${packetMinutes?.kind}, never as this meeting's minutes`);
  // (it goes again, from its ⋯: the rest of this run reads minutes in from After)
  await jane.evaluate((fid) => document.querySelector(`#bm-packet [data-file="${fid}"]`)?.closest('.bf-file')?.querySelector('.bd-menu summary')?.click(), packetMinutes?.id);
  await sleep(300);
  await clickText(jane, '.bd-menu[open] .bd-menu__item', /^Delete the file$/);
  ok(await jane.waitForFunction((fid) => !document.querySelector(`#bm-packet [data-file="${fid}"]`) && !!document.querySelector('#bm-packet .bf-file'), { timeout: 5000 }, packetMinutes?.id).then(() => true, () => false), 'and its own ⋯ → Delete takes it away again, the statement staying');
  ok(await waitText(jane, /Balance sheet financials goes with Financial/), 'and goes with the Financial item by itself');
  const finRow = () => jane.evaluate(() => [...document.querySelectorAll('.ag-item')].find((li) => li.querySelector('.agx-item__title')?.value === 'Financial')?.textContent || '');
  ok(/Balance sheet financials/.test(await finRow()), 'it shows under that item on the agenda');
  ok(await jane.evaluate(() => /Financial/.test([...document.querySelectorAll('.bf-file')].find((li) => /Balance sheet financials/.test(li.textContent))?.querySelector('.bd-goes')?.textContent || '')), 'the file says which item it goes with');
  // The packet's "Goes with": its list of the agenda over everything, never cut off by the card
  await jane.evaluate(() => [...document.querySelectorAll('.bf-file')].find((li) => /Balance sheet financials/.test(li.textContent))?.querySelector('.bd-goes .bd-pop__btn')?.click());
  await jane.waitForSelector('.bd-pop__panel .bd-picker__find', { timeout: 3000 }).catch(() => {});
  { const top = await onTop(jane); ok(top === true, `the packet’s Goes with list draws over everything, all of it in view (${top})`); }
  await shot(jane, 'packet-goes-with');
  await jane.keyboard.press('Escape');
  // Who presents: People, with their faces, searched by name
  await jane.evaluate(() => [...document.querySelectorAll('.ag-item')].find((li) => li.querySelector('.agx-item__title')?.value === 'Financial').querySelector('.bd-who .bd-pop__btn').click());
  ok(await jane.waitForSelector('.bd-pop__panel .bd-picker__find', { timeout: 3000 }).then(() => true, () => false), 'Who presents opens a list of the board and staff');
  ok(await jane.evaluate(() => document.activeElement?.classList.contains('bd-picker__find')), 'ready to type a name at once');
  { const top = await onTop(jane); ok(top === true, `the list draws over the agenda rows under it (${top})`); }
  await shot(jane, 'who-presents');
  ok(await jane.evaluate(() => [...document.querySelectorAll('.bd-picker__group')].map((g) => g.textContent).join() === 'Board,Staff' && [...document.querySelectorAll('.bd-picker__opt')].some((o) => /Sam Ortiz/.test(o.textContent) && /Board Treasurer/.test(o.textContent))), 'board first, then staff, each with their seat');
  await jane.keyboard.type('sam');
  await jane.keyboard.press('Enter');
  await jane.keyboard.press('Escape');
  ok(/Sam Ortiz/.test(await finRow()) && await jane.evaluate(() => !document.querySelector('.bd-pop__panel')), 'typing a name and Enter picks them; Escape closes the list');
  ok(await saved(jane) && (await meetingNow(jane, meetingId)).sections.flatMap((x) => x.items).find((it) => it.title === 'Financial').who.join() === 'sam-ortiz', 'saved as the person, not just a name');
  // The report under an item, written in place: Markdown as it's typed (### a heading, - points, Tab to go in)
  ok(await itemMenu(jane, 'Governance', /^Write the report$/), 'an item’s menu writes its report');
  ok(await jane.waitForSelector('[aria-label="The report on Governance"][contenteditable="true"]', { timeout: 4000 }).then(() => true, () => false), 'the editor opens in place, ready to type');
  await sleep(150);
  await jane.keyboard.type('### Highlights');
  await jane.keyboard.press('Enter');
  await jane.keyboard.type('- Insurance renewal is on track');
  await jane.keyboard.press('Enter');
  await jane.keyboard.press('Tab');
  await jane.keyboard.type('Broker sends the quote Friday');
  ok(await saved(jane), 'it all saves by itself');
  const govNow = async () => (await meetingNow(jane, meetingId)).sections.flatMap((x) => x.items).find((it) => it.title === 'Governance');
  const gov = await govNow();
  ok(gov.report === '### Highlights\n\n- Insurance renewal is on track\n  - Broker sends the quote Friday', `kept as Markdown: a heading, a point, one under it (${JSON.stringify(gov.report)})`);
  ok(gov.reportBy === 'Jane Doe' && /^\d{4}-\d{2}-\d{2}T/.test(gov.reportAt), `who wrote it and when, set by the server (${gov.reportBy})`);
  ok(await jane.evaluate(() => !!document.querySelector('.agx-report .rp-edit h3') && document.querySelectorAll('.agx-report .rp-edit ul ul li').length === 1), 'the editor shows it as it reads: a heading, a point under a point');
  ok(await jane.evaluate(() => document.querySelector('.bm-saved')?.textContent.trim().startsWith('Saved')), 'and it stays saved: who wrote it and when never count as a change');
  // Someone else saved meanwhile: both changes are kept, item by item
  const stale = await meetingNow(jane, meetingId);
  await jane.evaluate(async (m) => { await fetch('/api/board-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'save-meeting', meeting: { ...m, title: 'Fall board meeting' }, base: m.updatedAt }) }); }, stale);
  await jane.keyboard.type(' (or Monday)');
  ok(await saved(jane), `a save made meanwhile doesn’t stop this one (${await jane.$eval('.bm-saved', (e) => e.textContent.trim())})`);
  const merged = await meetingNow(jane, meetingId);
  ok(merged.title === 'Fall board meeting' && merged.sections.some((s) => s.items.some((it) => /quote Friday \(or Monday\)$/.test(it.report))), 'both the other save and this one are kept');
  // Words that only look like Markdown stay words as they're typed; ⌘K is the link, never Board's search; a link typed
  // at a person's pace keeps every letter; Google Docs' paste keeps its heading, bold and italic (fresh QA, Nov 2)
  for (let k = 0; k < 3; k++) await jane.keyboard.press('Enter');
  await jane.keyboard.type('Sales were 2 * 3 * 4 times');
  await jane.keyboard.press('Enter');
  await jane.keyboard.type('2026. A strong year');
  const typed = await jane.evaluate(() => { const e = document.querySelector('.agx-report .rp-edit'); return { text: e.innerText, em: e.querySelectorAll('em').length, ol: e.querySelectorAll('ol').length }; });
  ok(/Sales were 2 \* 3 \* 4 times/.test(typed.text) && /2026\. A strong year/.test(typed.text) && !typed.em && !typed.ol, `"2 * 3 * 4" and "2026. A strong year" stay as typed (${JSON.stringify({ em: typed.em, ol: typed.ol })})`);
  await jane.keyboard.down('Shift'); await jane.keyboard.down('Alt'); await jane.keyboard.press('ArrowLeft'); await jane.keyboard.up('Alt'); await jane.keyboard.up('Shift');
  await jane.keyboard.down('Meta'); await jane.keyboard.press('k'); await jane.keyboard.up('Meta');
  ok(await jane.waitForSelector('.agx-report .rp-link__box', { timeout: 2000 }).then(() => true, () => false) && !(await jane.$('.cmd-palette')), '⌘K in the report opens its link box, not Board’s search');
  await jane.type('.agx-report .rp-link__box', 'www.example.org/annual-report', { delay: 60 });
  await sleep(1500);
  await jane.keyboard.press('Enter');
  const linked = await jane.waitForFunction(() => !!document.querySelector('.agx-report .rp-edit a[href="https://www.example.org/annual-report"]'), { timeout: 3000 }).then(() => true, () => false);
  ok(linked, `a www. address typed at a person’s pace is the link, every letter of it${linked ? '' : ` (${await jane.evaluate(() => JSON.stringify({ box: document.querySelector('.agx-report .rp-link__box')?.value ?? null, bad: !!document.querySelector('.rp-link__bad'), links: [...document.querySelectorAll('.agx-report .rp-edit a')].map((x) => [x.textContent, x.getAttribute('href')]), sel: getSelection().toString(), active: document.activeElement?.className }))})`}`);
  // On a line of its own, as a person pastes
  await jane.evaluate(() => { const el = document.querySelector('.agx-report .rp-edit'); el.focus(); const sel = getSelection(); sel.selectAllChildren(el); sel.collapseToEnd(); });
  await jane.keyboard.press('ArrowRight');
  await jane.keyboard.press('Enter');
  await jane.evaluate(() => {
    const el = document.querySelector('.agx-report .rp-edit');
    const dt = new DataTransfer();
    dt.setData('text/html', '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1a2b"><h1 dir="ltr"><span style="font-size:20pt;font-weight:400">Finance committee</span></h1><p dir="ltr"><span style="font-weight:700">Revenue</span><span style="font-weight:400"> is up this quarter.</span></p><ul><li dir="ltr"><p dir="ltr"><span style="font-style:italic;font-weight:400">Audit</span><span style="font-weight:400"> firm picked</span></p></li></ul></b>');
    dt.setData('text/plain', 'Finance committee\nRevenue is up this quarter.\nAudit firm picked');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  const pasted = await jane.evaluate(() => { const e = document.querySelector('.agx-report .rp-edit'); return { h: [...e.querySelectorAll('h3')].map((x) => x.textContent), b: [...e.querySelectorAll('strong')].map((x) => x.textContent), i: [...e.querySelectorAll('em')].map((x) => x.textContent) }; });
  ok(pasted.h.includes('Finance committee') && pasted.b.join() === 'Revenue' && pasted.i.join() === 'Audit', `a Google Docs paste keeps its heading, its bold and its italic, and nothing else bold (${JSON.stringify(pasted)})`);
  ok(await saved(jane), 'and it all saves');
  await clickText(jane, '.agx-report button', /^Done$/);
  ok(await jane.waitForSelector('.agx-report:not(.is-writing) .rp h4', { timeout: 3000 }).then(() => true, () => false) && /Report\s*Jane Doe/.test(await jane.$eval('.agx-report__head', (e) => e.textContent)), 'Done: the report reads in place, with who wrote it, and Edit');
  ok(/Reports\s*0 of \d in/.test(await jane.$eval('.bm-reports', (e) => e.innerText).catch(() => '')) && /Financial[\s\S]*Sam Ortiz[\s\S]*Not yet/.test(await jane.$eval('.bm-reports', (e) => e.innerText).catch(() => '')), 'Getting ready says whose reports are in: Sam’s Financial isn’t yet');
  // An item's name wraps rather than being cut off, and an empty Who presents is there to see on every item
  await clickText(jane, '.agx-add', /^\+ Add an item$/);
  await sleep(300);
  const tall = await jane.evaluate(() => {
    const t = [...document.querySelectorAll('.agx-item__title')].find((x) => !x.value);
    if (!t) return null;
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    const one = t.getBoundingClientRect().height;
    set.call(t, 'Personal Best, Business Best and Sunshine Bragging Rights: what each of you has done since we last met');
    t.dispatchEvent(new Event('input', { bubbles: true }));
    return { one, two: t.getBoundingClientRect().height, cut: t.scrollHeight > t.clientHeight + 2 };
  });
  ok(tall && tall.two > tall.one + 10 && !tall.cut, `a long name wraps to more lines, all of it showing (${JSON.stringify(tall)})`);
  await sleep(600); // the page settles after scrolling to the new item (a menu closes itself when the page scrolls)
  ok(await itemMenu(jane, 'Personal Best, Business Best and Sunshine Bragging Rights: what', /^Delete the item$/) && await jane.waitForFunction(() => ![...document.querySelectorAll('.agx-item__title')].some((x) => /since we last met$/.test(x.value)), { timeout: 3000 }).then(() => true, () => false), 'and it goes again from its menu');
  ok(await jane.evaluate(() => [...document.querySelectorAll('.agx-item')].filter((li) => li.querySelector('.bd-who:not(.has-who)')).every((li) => { const b = li.querySelector('.bd-who .bd-pop__btn'); return b && Number(getComputedStyle(li.querySelector('.bd-who')).opacity) === 1 && b.getBoundingClientRect().width > 60; })), 'Who presents shows on every item with nobody picked, without hovering');
  await shot(jane, 'agenda-report');
  // On a phone the agenda fits its card, whatever its parts hold (one wide part once widened them all)
  {
    const vp = jane.viewport();
    await jane.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await jane.reload({ waitUntil: 'networkidle0' });
    const fit = await jane.evaluate(() => { const c = document.querySelector('.card.agx'); return c ? { card: c.clientWidth, content: c.scrollWidth } : null; });
    ok(!!fit && fit.content <= fit.card, `on a phone the agenda fits its card (${JSON.stringify(fit)})`);
    await jane.setViewport(vp);
    await jane.reload({ waitUntil: 'networkidle0' });
  }

  // The presentation beside the agenda (board-meeting.js AgendaStage), there from the start: the slide for the item
  // worked on, every slide in order, a slide picked, Play from here; then the board page as it's typed, and a phone
  const stageCount = () => jane.$eval('.agx-stage__count', (e) => e.textContent.trim()).catch(() => '');
  ok(await jane.waitForFunction(() => /^\d+ of \d+$/.test(document.querySelector('.agx-stage__count')?.textContent.trim() || ''), { timeout: 15000 }).then(() => true, () => false), `the presentation is beside the agenda, on the slide of the item last worked on (${await stageCount()})`);
  const sc = await jane.waitForFrame((fr) => /\?preview#\/meetings\/[^/]+\/screen$/.test(fr.url()), { timeout: 8000 }).catch(() => null);
  ok(!!sc && await sc.evaluate(() => !document.querySelector('.bs-steps') && !document.querySelector('.bs-chip')), 'the slide as the screen draws it, without the presenting window’s own buttons');
  await jane.evaluate(() => { const t = [...document.querySelectorAll('.agx-item__title')].find((x) => x.value === 'Financial'); t.scrollIntoView({ block: 'center' }); t.focus(); t.setSelectionRange(t.value.length, t.value.length); });
  ok(!!sc && await sc.waitForFunction(() => document.querySelector('.bs-item__title')?.textContent === 'Financial', { timeout: 10000 }).then(() => true, () => false), 'working on an item puts its slide up');
  await jane.keyboard.type(' and budget');
  ok(await sc.waitForFunction(() => document.querySelector('.bs-item__title')?.textContent === 'Financial and budget', { timeout: 5000 }).then(() => true, () => false), 'a change shows on the slide as it’s typed, before it’s saved');
  ok(/Financial and budget/.test(await jane.$eval('.agx-stage__now', (e) => e.textContent)), 'and the slide’s name beside its count');
  await shot(jane, 'agenda-stage');
  for (let k = 0; k < ' and budget'.length; k++) await jane.keyboard.press('Backspace');
  ok(await saved(jane) && (await meetingNow(jane, meetingId)).sections.flatMap((x) => x.items).some((it) => it.title === 'Financial'), 'and the agenda itself saves as ever');
  // Every slide in order: a document's pages under their item; one picked goes up, and its item comes into view
  const slides = await jane.$$eval('.agx-slide', (l) => l.map((b) => `${b.className.match(/is-(\w+)/)[1]}:${b.querySelector('.agx-slide__t').textContent}`));
  ok(slides[0] === 'cover:The cover' && slides.some((x) => /^section:/.test(x)) && slides.some((x) => /^doc:Balance sheet financials/.test(x)), `every slide, in order (${slides.length}: ${slides.slice(0, 4).join(' | ')} …)`);
  const docAt = slides.findIndex((x) => /^doc:Balance sheet financials/.test(x));
  await jane.evaluate((i) => document.querySelectorAll('.agx-slide')[i].click(), docAt);
  ok(await sc.waitForFunction(() => document.querySelector('.bs-page__sheet canvas')?.width > 0 || !!document.querySelector('.bs--doc'), { timeout: 10000 }).then(() => true, () => false) && await jane.waitForFunction((n) => (document.querySelector('.agx-stage__count')?.textContent || '').replace(/\s+/g, ' ').trim().startsWith(`${n} of`), { timeout: 10000 }, docAt + 1).then(() => true, () => false), `a slide picked in the list goes up: the statement’s page (${await stageCount()})`);
  await jane.evaluate(() => document.querySelectorAll('.agx-stage__step')[1].click());
  ok(await jane.waitForFunction((n) => document.querySelector('.agx-stage__count')?.textContent.trim().startsWith(`${n} of`), { timeout: 5000 }, docAt + 2).then(() => true, () => false), '› steps to the next slide');
  // Play from here: the presentation in its own window, on this slide
  const played = new Promise((res) => browser.once('targetcreated', res));
  await jane.click('.agx-stage__play');
  const playTarget = await Promise.race([played, sleep(5000).then(() => null)]);
  ok(!!playTarget && /\/admin\/board\/\?present&at=[^#]+#\/meetings\/[^/]+\/screen$/.test(playTarget.url()), `Play from here opens the presentation on this slide (${playTarget?.url().replace(SITE, '')})`);
  await (await playTarget?.page())?.close();
  await clickText(jane, '.agx-stage .bd-seg button', /^Board page$/);
  const pv = await jane.waitForFrame((fr) => /\?preview#\/meetings\/[^/]+$/.test(fr.url()), { timeout: 8000 }).catch(() => null);
  ok(!!pv && await pv.waitForSelector('.bp-agitem', { timeout: 10000 }).then(() => true, () => false), 'Board page: the board’s own page beside the agenda');
  ok(await pv.evaluate(() => getComputedStyle(document.querySelector('.bp-top')).display === 'none' && !document.querySelector('.bp-report-ask')), 'as the board sees it: no page header, no ask of the founder’s own');
  await jane.evaluate(() => { const t = [...document.querySelectorAll('.agx-item__title')].find((x) => x.value === 'Financial'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); });
  await jane.keyboard.type(' and budget');
  ok(await pv.waitForFunction(() => [...document.querySelectorAll('.bp-agitem__title')].some((x) => x.textContent === 'Financial and budget'), { timeout: 5000 }).then(() => true, () => false), 'a change shows on the board page as it’s typed');
  ok(await pv.waitForFunction(() => { const li = [...document.querySelectorAll('.bp-agitem')].find((x) => /Financial and budget/.test(x.textContent)); const r = li?.getBoundingClientRect(); return r && r.top >= -4 && r.top < innerHeight / 2; }, { timeout: 5000 }).then(() => true, () => false), 'the item worked on comes into view there');
  await shot(jane, 'agenda-preview');
  for (let k = 0; k < ' and budget'.length; k++) await jane.keyboard.press('Backspace');
  await clickText(jane, '.agx-stage .bd-seg button', /^Phone$/);
  ok(await pv.waitForFunction(() => innerWidth === 390 && !!document.querySelector('.bp-agitem'), { timeout: 5000 }).then(() => true, () => false), 'Phone: the board page at a phone’s width');
  await shot(jane, 'agenda-preview-phone');
  await clickText(jane, '.agx-stage .bd-seg button', /^Presentation$/);
  ok(await jane.waitForFunction(() => /^\d+ of \d+$/.test(document.querySelector('.agx-stage__count')?.textContent.trim() || ''), { timeout: 10000 }).then(() => true, () => false), 'and back to the presentation');
  ok(await saved(jane), 'saved');
  ok(merged.actions.some((a) => a.text === 'Send the venue contract' && a.owner === 'alex-rivera'), 'the last meeting’s open action item carries over');

  // Getting ready 1: the invite, from the president's calendar, with Google Meet (SOARD's Google plan has no transcripts)
  ok(/From your calendar to the board: Google Meet, the place and the link to the agenda/.test(await text(jane)) && !/transcript/i.test(await text(jane)), 'Getting ready says who the invite comes from and who it goes to (the organizer reads “your calendar”), and nothing about transcripts');
  // The reports' emails, beside the reports (there's no Settings tab): Test until switched on, Off and back kept for every meeting
  ok(await jane.$eval('#bm-asks', (e) => e.value).catch(() => '') === 'test' && /Emails asking for them/.test(await text(jane)), 'the reports’ emails switch is beside the reports, on Test');
  await jane.select('#bm-asks', 'off');
  ok(await waitText(jane, /No emails\. Presenters write their reports on the board page\./) && (await jane.evaluate(async () => (await (await fetch('/api/board-admin')).json()).settings.asks)) === 'off', 'switched Off, it’s saved at once and says what it means');
  await jane.select('#bm-asks', 'test');
  ok(await waitText(jane, /Each email comes to you alone/) && (await jane.evaluate(async () => (await (await fetch('/api/board-admin')).json()).settings.asks)) === 'test', 'and back to Test');
  // The quorum, beside who's coming: a majority until the bylaws' number is set, for every meeting
  ok(/2 of 3\s*make a quorum \(a majority\)/.test(await text(jane)), 'Who’s coming says how many make a quorum');
  await clickText(jane, '.bm-quorum-line button', /^Change$/);
  await jane.waitForSelector('#bm-q');
  await type(jane, '#bm-q', '3');
  await clickText(jane, '.bm-quorum-set button', /^Save$/);
  ok(await waitText(jane, /3 of 3\s*make a quorum\./), 'a number set says so');
  await clickText(jane, '.bm-quorum-line button', /^Change$/);
  await jane.waitForSelector('#bm-q');
  await jane.$eval('#bm-q', (e) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(e, ''); e.dispatchEvent(new Event('input', { bubbles: true })); });
  await clickText(jane, '.bm-quorum-set button', /^Save$/);
  ok(await waitText(jane, /2 of 3\s*make a quorum \(a majority\)/), 'emptied, it’s a majority again');
  await shot(jane, '03c-reports-quorum');
  await clickText(jane, 'button', /^Send the invite$/);
  ok(await waitText(jane, /Invite sent from your calendar/), 'Send the invite asks, naming who Google emails, then sends it');
  // The invite's write (opening Board also runs the invite check, whose event has no guests)
  const post = google.find((c) => c.method === 'POST' && c.body?.attendees);
  ok(post && post.url.includes(`/calendars/${encodeURIComponent(FOUNDER)}/events?conferenceDataVersion=1&sendUpdates=all`), 'from the president’s own calendar, and Google emails the guests');
  ok(post && post.body.attendees.map((a) => a.email).sort().join() === [MEMBER, OTHER].sort().join(), 'to every board member with an email');
  ok(post?.body.conferenceData?.createRequest?.conferenceSolutionKey?.type === 'hangoutsMeet' && !google.some((c) => c.method === 'PATCH' && /meet\.googleapis\.com/.test(c.url)), 'with Google Meet, its settings left alone (no transcripts asked for)');
  ok(/2 guests · Google Meet · at Example Hall/.test(await text(jane)), 'the step says what went out, at the last meeting’s place');
  // The address, added after: one update once it has settled
  const before = google.length;
  await clickText(jane, 'button', /^Change when and where$/);
  await jane.waitForSelector('#bd-loc');
  await type(jane, '#bd-loc', 'Example Hall');
  await type(jane, '#bd-addr', '100 Example St, Roswell, GA');
  await type(jane, '#bd-invite-note', 'Park in the back lot. The side door is open.');
  ok(await saved(jane), 'the place and the notes for the invite save');
  ok(await waitText(jane, /the new place goes on it a couple of minutes after you stop typing/), 'the step says the new place is on its way to the invite');
  ok(google.length === before, 'nothing goes to Google while it’s being typed');
  await maybeRefreshInvites(env, { now: Date.now() + 3 * 60 * 1000 });
  const updates = google.slice(before).filter((c) => c.url.includes('/calendar/v3/'));
  ok(updates.length === 1 && updates[0].method === 'PATCH' && updates[0].body.location === 'Example Hall, 100 Example St, Roswell, GA', 'then one update to the invite with the place');
  ok(/A code comes by email\.\n\nPark in the back lot\. The side door is open\.$/.test(updates[0]?.body.description || ''), `the notes typed for the invite are on it, after the way to the board page (${JSON.stringify(updates[0]?.body.description)})`);
  // A new time, typed in Board (meetings are Board's, Peter, Nov 2 2026): the step says so, then one update Google emails
  // the guests about; and back again
  const setStart = (v) => jane.evaluate((v) => { const i = document.querySelector('#bd-start'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, v); i.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  // Saved once the server has it ("Saved" is already showing from the save before)
  const savedStart = (v) => jane.waitForFunction(async (id, v) => (await (await fetch('/api/board-admin')).json()).meetings.find((x) => x.id === id)?.start === v, { polling: 250, timeout: 10000 }, meetingId, v).then(() => true, () => false);
  const startWas = await jane.$eval('#bd-start', (i) => i.value);
  const beforeTime = google.length;
  await setStart('18:30');
  ok(await savedStart('18:30'), 'the new time saves');
  ok(await waitText(jane, /the new time goes on it a couple of minutes after you stop typing/), 'the step says the new time is on its way to the invite');
  await maybeRefreshInvites(env, { now: Date.now() + 3 * 60 * 1000 });
  const moved = google.slice(beforeTime).filter((c) => c.url.includes('/calendar/v3/'));
  ok(moved.length === 1 && /sendUpdates=all$/.test(moved[0].url) && /T18:30:00$/.test(moved[0].body.start?.dateTime || ''), `then one update with the new time, which Google emails the guests (${JSON.stringify(moved.map((c) => [c.url.slice(-16), c.body.start]))})`);
  await setStart(startWas);
  ok(await savedStart(startWas), 'the time goes back');
  await maybeRefreshInvites(env, { now: Date.now() + 3 * 60 * 1000 });
  ok(google.slice(beforeTime).filter((c) => c.url.includes('/calendar/v3/') && c.method === 'PATCH').length === 2, 'and onto the invite again');

  // Getting ready 2-3: the board page, the documents by email
  await clickText(jane, 'button', /^Share with the board$/);
  ok(await waitText(jane, /Board members see the agenda and files/), 'Share with the board puts it on the board page');
  mail.length = 0;
  await clickText(jane, 'button', /^Send me the email$/);
  await waitText(jane, /Sent to jane@soardcharity\.com/);
  ok(mail.length === 1 && mail[0].to[0] === FOUNDER, 'Send me the email goes only to the founder');
  ok(!mail[0]?.attachments && /Balance sheet financials/.test(mail[0]?.html || '') && /Open the agenda and documents/.test(mail[0]?.html || ''), 'the link to the agenda and documents, the documents by name, nothing attached');
  ok(!/ask counsel|Governance/.test(mail[0]?.html || ''), 'the email has no private note and no board-only item');
  ok(/Park in the back lot\. The side door is open\./.test(mail[0]?.html || '') && /Notes: Park in the back lot/.test(mail[0]?.text || ''), 'the email carries the notes for the invite');
  await clickText(jane, 'button', /^Email the board$/);
  ok(await waitText(jane, /Emailed 2 board members/), 'Email the board reaches the two members with emails');
  ok(mail.slice(1).map((m) => m.to[0]).sort().join() === [MEMBER, OTHER].sort().join() && mail.slice(1).every((m) => !m.attachments), 'each board member got their own, with nothing attached');
  await shot(jane, '03-before');

  // The minutes template (./board-minutes-template.js): this agenda to take the minutes on, printed or typed into Word
  const tmplButtons = await jane.evaluate(() => { const c = [...document.querySelectorAll('.bm-row__side .card')].find((x) => x.querySelector('h3')?.textContent === 'Minutes template'); return c ? [...c.querySelectorAll('button')].map((b) => b.textContent.trim()) : null; });
  ok(JSON.stringify(tmplButtons) === '["Print","Word file"]', `Before has the minutes template, to print or as a Word file (${JSON.stringify(tmplButtons)})`);
  await jane.evaluate(() => { window.__printing = false; window.print = () => { window.__printing = true; }; });
  await clickText(jane, '.bm-row__side .card button', /^Print$/);
  ok(await jane.waitForFunction(() => window.__printing, { timeout: 5000 }).then(() => true, () => false), 'Print opens the print window');
  const paper = await jane.evaluate(() => document.querySelector('.mt-print')?.textContent || '');
  ok(/Who was there/.test(paper) && /Alex Rivera/.test(paper) && /Financial/.test(paper) && /Motion to approve these minutes/.test(paper) && /Action items/.test(paper) && !/ask counsel/i.test(paper), 'on paper: the roll, each item, the vote on the last minutes, the action items, never a private note');
  await jane.pdf({ path: join(OUT, '03b-minutes-template.pdf'), format: 'letter', printBackground: true });
  await jane.evaluate(() => dispatchEvent(new Event('afterprint')));
  ok(await jane.waitForFunction(() => !document.querySelector('.mt-print') && !document.documentElement.classList.contains('mt-printing'), { timeout: 5000 }).then(() => true, () => false), 'and the paper version is taken away after');
  // The Word file, as the browser saves it
  const template = await jane.evaluate(async () => {
    const make = URL.createObjectURL;
    const click = HTMLAnchorElement.prototype.click;
    let blob = null;
    let name = '';
    URL.createObjectURL = (b) => { blob = b; return make.call(URL, b); };
    HTMLAnchorElement.prototype.click = function () { name = this.download; };
    try { [...document.querySelectorAll('.bm-row__side .card button')].find((b) => b.textContent.trim() === 'Word file').click(); } finally { URL.createObjectURL = make; HTMLAnchorElement.prototype.click = click; }
    return blob ? { name, type: blob.type, bytes: [...new Uint8Array(await blob.arrayBuffer())] } : null;
  });
  const templateText = template ? await docxText(new Uint8Array(template.bytes)) : '';
  ok(/ minutes \(\d{4}-\d{2}-\d{2}\)\.docx$/.test(template?.name || '') && /wordprocessingml/.test(template?.type || ''), `Word file saves as “${template?.name}”`);
  ok(/^1\. CALL TO ORDER$/m.test(templateText) && /^ {3}\d\. Financial \(Sam Ortiz\)$/m.test(templateText) && /^\d\. ACTION ITEMS$/m.test(templateText) && /^Alex Rivera$/m.test(templateText), 'it’s the agenda as Board reads minutes: parts in capitals, items with who presents, the roll');

  // The numbers lock themselves on the meeting's day (the heartbeat), so the minutes keep what the board saw
  ok((await maybeLockNumbers(env, { now: Date.parse(`${day(14)}T15:00:00Z`) })).includes(meetingId) && !!(await meetingNow(jane, meetingId)).snapshot, 'on the meeting’s day its numbers lock by themselves');
  ok((await maybeLockNumbers(env, { now: Date.parse(`${day(14)}T16:00:00Z`) })).length === 0, 'once');

  // ─── Nothing to run during the meeting: one page, and the presentation moves itself ───
  await jane.reload({ waitUntil: 'networkidle0' });
  ok(await jane.evaluate(() => !document.querySelector('.bm-stages, .bm-run, .bm-order, .bd-line--vote, [role="tablist"]')), 'one page: no Before / During / After, no run of show to drive, no votes to take');
  const line = await jane.$$eval('.bm-path__step', (l) => l.map((x) => `${x.querySelector('.bm-path__t').textContent}:${x.className.match(/is-(\w+)/)[1]}`));
  ok(line.length === 6 && line.filter((x) => /:next$/.test(x)).length <= 1, `the line under its name says where it stands (${line.join(' | ')})`);
  // The line stays at the top as the page scrolls, Tab along it never moves the page, and a step's card lands below it
  {
    await jane.evaluate(() => scrollTo(0, Math.round((document.scrollingElement.scrollHeight - innerHeight) / 2)));
    await sleep(200);
    const y0 = await jane.evaluate(() => scrollY);
    await jane.evaluate(() => document.querySelector('button.bm-path__btn').focus());
    await jane.keyboard.press('Tab');
    await sleep(150);
    const stuck = await jane.evaluate(() => ({ top: Math.round(document.querySelector('.bm-path').getBoundingClientRect().top), y: scrollY }));
    ok(stuck.top === 0 && stuck.y === y0, `the line under its name stays at the top as the page scrolls, and the keyboard along it leaves the page where it is (${JSON.stringify(stuck)}, from ${y0})`);
    await jane.evaluate(() => [...document.querySelectorAll('.bm-path__btn')].find((b) => /Board emailed/.test(b.textContent)).click());
    await sleep(1200);
    const land = await jane.evaluate(() => ({ card: Math.round(document.getElementById('bm-ready').getBoundingClientRect().top), line: Math.round(document.querySelector('.bm-path').getBoundingClientRect().bottom), end: scrollY >= document.scrollingElement.scrollHeight - innerHeight - 2 }));
    ok(land.card >= land.line && (land.card <= land.line + 40 || land.end), `a step on the line goes to its card, just below the line or as far as the page goes (${JSON.stringify(land)})`);
    // From the bottom of the page: the agenda is lit once the page stops there, not before
    await jane.evaluate(() => scrollTo(0, document.scrollingElement.scrollHeight));
    await sleep(200);
    await jane.evaluate(() => [...document.querySelectorAll('.bm-path__btn')].find((b) => /Agenda/.test(b.textContent)).click());
    await sleep(120);
    await jane.waitForFunction(() => new Promise((r) => { const y = scrollY; setTimeout(() => r(scrollY === y), 100); }), { timeout: 8000, polling: 120 }).catch(() => {});
    ok(await jane.evaluate(() => document.getElementById('bm-work').classList.contains('is-found')), 'a step lights its card once the page has stopped there');
    await jane.evaluate(() => scrollTo(0, 0));
  }
  await shot(jane, '04-one-page');

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
  // The expectations too: required of every member each year (one of them signs by adding a copy signed on paper)
  await clickText(jane, 'button', /^Add a document$/);
  await jane.type('#bd-doc-title', 'Board Member Expectations');
  await jane.select('#bd-doc-kind', 'policy');
  const expPdf = join(OUT, 'Board-Expectations.pdf');
  writeFileSync(expPdf, await expectationsPdf());
  await (await jane.$('#bd-doc-file')).uploadFile(expPdf);
  ok(/^Required: every board member/.test(await jane.evaluate(() => [...document.querySelectorAll('.bd-check')].at(-1).textContent.trim())), 'the box says it’s required of every board member');
  await jane.evaluate(() => [...document.querySelectorAll('.bd-check input')].at(-1).click());
  await clickText(jane, 'button', /^Save$/);
  ok(await waitText(jane, /Board Member Expectations[\s\S]*No one has signed it for \d{4} yet[\s\S]*Required\s*0 of 3 signed/), 'the expectations: required, and no one has signed yet');
  // Their words, written here, starting from the PDF's own (asked for: opening it to change a line about it, or
  // Cancel, changes nothing): its headings and points, without the blanks to sign
  // (Edit opens with the focus on the title, as a person sees before typing: waited for here)
  const editRow = async (title) => {
    await jane.evaluate((t) => [...document.querySelectorAll('.bd-row')].find((r) => r.querySelector('.bd-row__title')?.textContent === t).querySelectorAll('.bd-tags button').forEach((b) => { if (b.textContent.trim() === 'Edit') b.click(); }), title);
    await jane.waitForFunction(() => document.activeElement?.id === 'bd-doc-title', { timeout: 5000 }).catch(() => {});
  };
  await editRow('Board Member Expectations');
  ok(await waitText(jane, /The board reads it as its file now\. Write its words here and the board reads them on the board page, then signs at the end\./) && !(await editorText(jane)).trim(), 'Edit offers to write its words here, and puts none in by itself');
  const leaveAsked = [];
  await answerAsks(jane, { onAsk: (t) => leaveAsked.push(t) });
  await clickText(jane, 'button', /^Cancel$/);
  ok(await jane.waitForFunction(() => !document.querySelector('.rp-edit'), { timeout: 3000 }).then(() => true, () => false) && !leaveAsked.length, 'Cancel straight away closes it without asking (nothing changed)');
  await answerAsks(jane);
  await editRow('Board Member Expectations');
  await jane.waitForSelector('.bd-words__start button');
  await clickText(jane, '.bd-words__start button', /^Start from the PDF’s words$/);
  ok(await jane.waitForFunction(() => /Attendance[\s\S]*Attend at least three of four board meetings[\s\S]*Giving and asking[\s\S]*Open one door for a sponsor/.test(document.querySelector('.rp-edit')?.innerText || ''), { timeout: 8000 }).then(() => true, () => false), 'Start from the PDF’s words: the editor has them');
  const fromPdf = await editorText(jane);
  ok(!/Signature|SUNSHINE ON A RANNEY DAY|^Board Member Expectations/m.test(fromPdf) && /Each member of the board agrees to the following for the year\. We ask every member to read them/.test(fromPdf)
    && await jane.evaluate(() => document.querySelectorAll('.rp-edit h3').length === 2 && document.querySelectorAll('.rp-edit ul li').length === 2 && document.querySelectorAll('.rp-edit ol li').length === 2), `its two headings, its points and its numbered list; one paragraph again; no letterhead, title or blanks (${JSON.stringify(fromPdf.slice(0, 160))})`);
  ok(await waitText(jane, /These are the words from Board Expectations \(open it to compare\)\. Read them over and fix anything, then save[\s\S]*Keep the file instead/), 'it says where the words came from, to read over beside it before saving (or keep the file)');
  ok(await jane.evaluate(() => [...document.querySelectorAll('.bd-words .form-hint a, label[for="bd-doc-file"] a')].filter((a) => /Board Expectations/.test(a.textContent)).length === 2), 'the PDF opens from beside the words, to compare');
  await clickText(jane, 'button', /^Save$/);
  ok(await waitText(jane, /Board Member Expectations[\s\S]*Written here, last changed [A-Z][a-z]{2} \d+/), 'written here now');
  // A paper to read, not to sign: on the board page it goes on its shelf
  await clickText(jane, 'button', /^Add a document$/);
  await jane.type('#bd-doc-title', 'Signed Amended Bylaws');
  await jane.select('#bd-doc-kind', 'policy');
  await (await jane.$('#bd-doc-file')).uploadFile(pdf);
  await clickText(jane, 'button', /^Save$/);
  ok(await waitText(jane, /Signed Amended Bylaws/), 'a paper to read is added');
  await shot(jane, '05-documents');
  await jane.goto(`${SITE}/admin/#board/members`, { waitUntil: 'networkidle0' });
  ok(await waitText(jane, /Board page sign-in\s*Needs you\s*Nobody can sign in yet/), 'Members: Board access says plainly that board members can’t sign in yet');
  ok(/CF_ACCESS_API_TOKEN/.test(await text(jane)) && /No email on file/.test(await text(jane)), 'Members: the steps, and who has no email on file');
  mail.length = 0;
  await clickText(jane, 'button', /^Send it to me$/);
  ok(await waitText(jane, /Sent to jane@soardcharity\.com/) && mail.length === 1 && /board page/i.test(mail[0].subject), 'Members: the sign-in email, sent to the founder first');
  await shot(jane, '06-members');
  // board@soardcharity.com: the heartbeat's first look, before Google allows the group permission, then after
  await syncBoardGroup(env);
  await jane.reload({ waitUntil: 'networkidle0' });
  ok(await waitText(jane, /board@soardcharity\.com\s*Needs you\s*Needs one Google setting before the site can keep it/) && /1234567890/.test(await text(jane)) && /admin\.directory\.group\.member/.test(await text(jane)), 'Members: the board@ group needs one Google setting, with the client ID and the scope to add');
  ok(boardGroup.length === 2, 'Members: nothing in the group changes before Google allows it');
  await shot(jane, '06a-members-group-setup');
  await shot(jane, '06a-members-group-setup');
  groupScope = true;
  await clickText(jane, 'button', /^Check now$/);
  ok(await waitText(jane, /board@soardcharity\.com\s*Has the 2 board members with an email and you\./), 'Members: once allowed, Check now brings the group up to the board');
  ok(/took out gone\.member@example\.com; 2 people added/.test(await text(jane)), 'Members: the group’s last change, by name');
  ok(JSON.stringify(boardGroup.map((x) => x.email).sort()) === JSON.stringify([MEMBER, FOUNDER, OTHER].sort()) && boardGroup.find((x) => x.email === FOUNDER).role === 'OWNER', 'Google’s group holds the board and the founder, who stays its owner');
  await shot(jane, '06b-members-group');
  // Who runs Board, on Members: Board has no Settings, and an old link to it opens here
  await jane.goto(`${SITE}/admin/#board/settings`, { waitUntil: 'networkidle0' });
  await jane.reload({ waitUntil: 'networkidle0' });
  { const runsOk = await waitText(jane, /WHO RUNS BOARD|Who runs Board/); const seen = await jane.evaluate(() => ({ hash: location.hash, tabs: [...document.querySelectorAll('.hub-tab')].map((t) => t.textContent.trim()).join(), on: document.querySelector('.hub-tab.active')?.textContent.trim() }));
    ok(runsOk && seen.tabs === 'Meetings,Documents,Members' && seen.on === 'Members', `an old Board → Settings link opens Members; Board’s tabs are Meetings, Documents and Members (${JSON.stringify(seen)})`); }
  const runs = () => jane.$eval('.bd-runs', (e) => e.innerText);
  ok(/Jane Doe\s*You[\s\S]*Invites come from your calendar/.test(await runs()) && !/Send invites from/.test(await runs()), 'Members: the president runs Board and the invites come from her calendar (“your”, to her); with one admin there’s nothing to choose');
  ok(/Until someone is added or taken off, it’s the founders on People → Team/.test(await text(jane)), 'Members: until it’s saved, it’s the founders');
  ok(!(await jane.$('.bk-banks, .bk-books')), 'Board: no banks or QuickBooks (System → Settings has them)');
  await type(jane, '#bd-runs-add', 'pat@example.com');
  await clickText(jane, '.bd-runs__add button', /^Add$/);
  ok(await waitText(jane, /Only a soardcharity\.com sign-in can run Board/), 'Members: only a soardcharity.com sign-in can be added');
  await type(jane, '#bd-runs-add', STAFF);
  await clickText(jane, '.bd-runs__add button', /^Add$/);
  ok(await waitText(jane, /Pat Lee can open Board now/) && /Pat Lee[\s\S]*Asks presenters for their reports from their Gmail/.test(await runs()) && /Send invites from Pat’s calendar/.test(await runs()), 'Members: someone added saves at once; the other admin asks for the reports, and the invites can come from their calendar');
  ok((await jane.evaluate(async () => (await (await fetch('/api/board-admin')).json()).settings.admins)).join() === [FOUNDER, STAFF].join(), 'saved');
  await shot(jane, '07-runs-board');
  // On a phone: nothing past the edge, every button whole
  await jane.setViewport({ width: 390, height: 900, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await sleep(300);
  ok(await overflow(jane) <= 0 && await jane.$$eval('.bd-runs button, .bd-runs__add button', (bs) => bs.every((b) => b.getBoundingClientRect().right <= innerWidth && b.scrollWidth <= b.clientWidth + 1)), 'Who runs Board fits a phone');
  await jane.evaluate(() => document.querySelector('.bd-runs')?.scrollIntoView({ block: 'start' }));
  await jane.screenshot({ path: join(OUT, '07-runs-board-390.png') });
  await jane.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  // Leaving the phone's isMobile reloads the page: its buttons are back before one is pressed
  await jane.waitForFunction(() => [...document.querySelectorAll('.bd-runs button')].some((b) => b.textContent.trim() === 'Take off'), { timeout: 15000 }).catch(() => {});
  await clickText(jane, '.bd-runs button', /^Take off$/);
  ok(await waitText(jane, /Pat Lee is off Board/) && !/Pat Lee/.test(await runs()), 'Members: taken off, after asking');
  ok((await jane.evaluate(async () => (await (await fetch('/api/board-admin')).json()).settings.admins)).join() === FOUNDER, 'saved');
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

  // A board meeting put on the founder's calendar some other way never becomes a meeting in Board (they're added in
  // Board only); the reply to Board's own invite comes back onto its meeting
  const calDay = day(35);
  calendar[FOUNDER].push({ id: 'q1', iCalUID: 'q1@google.com', summary: 'SOARD Q4 Board Meeting', status: 'confirmed', start: { dateTime: `${calDay}T13:00:00Z` }, end: { dateTime: `${calDay}T15:00:00Z` }, location: 'Example Design Group, 100 Example St, Roswell, GA', organizer: { email: FOUNDER, self: true }, attendees: [{ email: MEMBER, responseStatus: 'accepted' }, { email: OTHER }], htmlLink: 'https://www.google.com/calendar/event?eid=q1' });
  // Alex said yes to Board's invite in their calendar
  const boards = calendar[FOUNDER].find((e) => /^board[0-9a-f]/.test(e.id) && e.attendees);
  boards.attendees = boards.attendees.map((a) => (a.email === MEMBER ? { ...a, responseStatus: 'accepted' } : a));
  await DB.exec("DELETE FROM board_state WHERE key = 'calendar'");
  // The heartbeat's check of Calendar, Meet and attendance (an event with no guests, deleted again)
  const checked = await maybeCheckInvites(env);
  ok(checked?.ok && calendar[FOUNDER].some((e) => /^boardcheck/.test(e.id) && e.status === 'cancelled'), 'the invite check passes and deletes its event');
  await jane.goto(`${SITE}/admin/#board`, { waitUntil: 'networkidle0' });
  await jane.reload({ waitUntil: 'networkidle0' }); // a new hash alone doesn't load the page again
  ok(await waitText(jane, /Past meetings’ agendas and minutes also come in from your email by themselves/) && !/Google Drive|Meetings come from/.test(await text(jane)), 'Meetings says where past meetings’ papers come from (email, never Drive), and nothing about meetings coming from a calendar');
  ok(await waitText(jane, /Ready\. The board was emailed the link/), 'the next meeting: everything done says Ready');
  const all = await jane.evaluate(async () => (await (await fetch('/api/board-admin')).json()).meetings);
  ok(!all.some((m) => m.date === calDay), `the event on the calendar isn’t a meeting (${all.map((m) => m.date).join(', ')})`);
  ok(await waitText(jane, /A board meeting on the calendar isn’t in Board\./) && /Board\. Meetings are added here/.test(await text(jane)) && /“SOARD Q4 Board Meeting”, \w+day, [A-Z][a-z]+ \d+, \d{4}, on your calendar/.test(await text(jane)), 'Meetings names the board meeting on the calendar that isn’t in Board');
  await shot(jane, '08a-not-in-board');
  // Added from there, its calendar event is then a second invite for it, which the meeting asks to have cancelled
  await clickText(jane, '.bh-strays button', /^Add /);
  await jane.waitForFunction(() => /#board\/meeting\//.test(location.hash), { timeout: 10000 });
  const strayId = decodeURIComponent((await jane.evaluate(() => location.hash)).split('/')[2]);
  ok((await getMeeting(DB, strayId))?.date === calDay, 'Add makes the meeting on that day, and opens it');
  await syncBoardCalendar(env);
  await jane.reload({ waitUntil: 'networkidle0' });
  ok(await waitText(jane, /Another invite for this meeting is on your calendar: “SOARD Q4 Board Meeting”\. Cancel it, so the board has one invite and one call\./), 'the meeting names the other invite, for whoever sent it to cancel');
  await shot(jane, '08b-other-invite');
  const gone = await jane.evaluate(async (id) => (await fetch('/api/board-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete-meeting', id }) })).json(), strayId);
  ok(gone.ok && gone.cancelled === false, 'deleting it (no invite sent) cancels nothing');
  await syncBoardCalendar(env);
  await jane.goto(`${SITE}/admin/#board`, { waitUntil: 'networkidle0' });
  await jane.reload({ waitUntil: 'networkidle0' });
  ok(all.find((m) => m.id === meetingId)?.invite?.replies?.['alex-rivera'] === 'accepted', 'the reply to Board’s invite comes back onto its meeting');
  await shot(jane, '08-meetings');
  // Its day, time and place are typed in Board, invite or not; the call is the invite's Google Meet
  await jane.goto(`${SITE}/admin/#board/meeting/${meetingId}`, { waitUntil: 'networkidle0' });
  await jane.reload({ waitUntil: 'networkidle0' });
  await clickText(jane, 'button', /^Change when and where$/);
  ok(await waitText(jane, /A new day, time or place goes on the invite a couple of minutes after you stop typing, and Google emails the guests once/), 'When and where says a change goes onto the invite, with one email from Google');
  ok(await jane.evaluate(() => !!document.querySelector('#bd-date') && !!document.querySelector('#bd-start') && !!document.querySelector('#bd-loc') && !document.querySelector('#bd-video') && /Google Meet/.test(document.querySelector('#bm-where .bm-fixed')?.textContent || '')), 'the day, times and place are all typed here; the call is Google Meet, never a link to type');
  await shot(jane, '09-when-and-where');

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
  // This year's major gifts, read from a pretend Zeffy as the heartbeat reads it (made-up givers): one in kind, one for a
  // company, one named for Maya (the board reads "Makeovers"), and one under $1,000 that stays off the page
  const zeffyPay = (id, daysAgo, dollars, o = {}) => ({ id, created: Math.floor((Date.now() - daysAgo * 864e5) / 1000), amount: dollars * 100, currency: 'usd', status: 'succeeded', type: 'online', refund_status: 'none', refunds: [], description: 'Evening of Sunshine', buyer: { first_name: 'Dana', last_name: 'Example', email: 'dana@example.com', is_corporate: false }, buyer_questions: [], items: [], recurring: null, ...o });
  const zeffyYear = [
    zeffyPay('pay_t0001', 1, 25000, { buyer: { first_name: 'Lee', last_name: 'Sample', is_corporate: true, company_name: 'Sample Family Foundation' } }),
    zeffyPay('pay_t0002', 2, 5000, { description: 'Help build Maya’s room' }),
    zeffyPay('pay_t0003', 4, 999),
    ...Array.from({ length: 6 }, (_, i) => zeffyPay(`pay_t01${i}0`, 10 + i * 7, 1000 + i * 500, { type: i === 2 ? 'manual' : 'online', payment_method: i === 2 ? { type: 'in_kind' } : null })),
  ];
  await maybeReadGifts({ DB, ZEFFY_API_KEY: 'zk-test' }, { fetchImpl: async () => Response.json({ object: 'list', data: zeffyYear, has_more: false, next_cursor: null }) });
  for (const width of [1440, 390]) {
    console.log(`A board member at ${width}px`);
    // Their last visit three days ago: the two gifts since are new
    await DB.prepare('INSERT OR REPLACE INTO board_seen (slug, at) VALUES (?, ?)').bind('alex-rivera', new Date(Date.now() - 3 * 864e5).toISOString()).run();
    const alex = await tab(MEMBER, width);
    await alex.goto(`${SITE}/admin/`, { waitUntil: 'networkidle0' });
    await alex.waitForFunction(() => location.pathname === '/admin/board/', { timeout: 8000 }).catch(() => {});
    ok(new URL(alex.url()).pathname === '/admin/board/', 'opening /admin/ takes a board member to their page');
    ok(await waitText(alex, /Good (morning|afternoon|evening), Alex/), 'Home greets them by name');
    const home = await text(alex);
    ok(/Next meeting/.test(home) && /See the agenda and\s1\sfile/.test(home), 'Home: the next meeting, and its packet');
    ok(/Example Hall/.test(home) && await alex.$('.bp-next a[href^="https://www.google.com/maps/search/"]') !== null, 'Home: its place, the address opening in Maps');
    ok(await alex.$('.bp-next a[href="https://meet.google.com/abc-defg-hij"]') !== null && /Google Meet/.test(home), 'Home: the Google Meet link, in the meeting’s one line');
    // Their reply to the calendar invite is their answer, the only one: said, with nothing to press here
    ok(/You’re coming/.test(home) && /You said yes on the calendar invite\./.test(home) && !(await alex.$('.bp-next .bp-choice')), 'Home: their reply to the invite is their answer, with no buttons here');
    ok(width === 1440 ? /Send the venue contract/.test(home) : !/Send the venue contract/.test(home), width === 1440 ? 'Home: their own action item' : 'Home: the action item they ticked off is gone');
    const figs = await alex.evaluate(() => Object.fromEntries([...document.querySelectorAll('.bp-fig')].map((f) => [f.querySelector('.bp-fig__label').textContent, f.querySelector('.bp-fig__value').textContent])));
    // No budget sheet and no QuickBooks here: the reveals stand in for the year's revenue, and nothing for its
    // expenses (the kids served are Impact's, just under the figures in the same panel)
    // The makeovers under way are the board's cards, awaiting funding too: the figure and the board below agree
    const cards = await alex.$$eval('#makeovers .bk-card', (l) => l.length);
    ok(Object.keys(figs).length === 3 && figs['Makeovers under way'] === String(cards) && cards > 0 && figs['Cash in the bank'] === '$375K' && 'Reveals ahead' in figs && !/Recently|The money|Children served/.test(home), `Home: three figures without a budget (Mercury's cash, the reveals, the makeovers as many as the board's ${cards} cards), nothing repeated below (${JSON.stringify(figs)})`);
    ok(await alex.evaluate(() => !!document.querySelector('.bp-sum .bp-figs') && !!document.querySelector('.bp-sum #impact')), 'Home: the figures and Impact are one panel, SOARD at a glance');
    ok(await alex.$$eval('.bp-next .bp-agpeek li', (l) => l.length) > 0, 'Home: the next meeting’s agenda headings, right there');
    const cols = await alex.$$eval('#makeovers .bk-col', (c) => c.map((e) => e.textContent));
    ok(/^Awaiting funding1[\s\S]*1\sfamily/.test(cols[0]) && /^Design2[\s\S]*Leo[\s\S]*\+1\smore family/.test(cols[1]) && /^Build1[\s\S]*Maya/.test(cols.at(-1)) && !/Not Published Yet|Someone Else|Coming up/.test(home), `Home: the makeovers as a kanban, Awaiting funding first, then Design to Build; published kids by name only (${JSON.stringify(cols)})`);
    const kids = await alex.$$eval('#makeovers .bk-card:not(.is-quiet)', (c) => c.map((e) => ({ text: e.querySelector('.bk-card__body').textContent, img: !!e.querySelector('.bk-card__photo img, .bk-card__initials') })));
    ok(kids.length === 2 && kids.every((k) => k.img) && kids.some((k) => /^Maya\s*Reveal \w{3} \d+ · 10\sAM$/.test(k.text)) && kids.some((k) => /^Leo\s*Reveal mid December$/.test(k.text)), `Home: each kid’s card leads with their photo and carries their reveal, a set day or the part of the month (${JSON.stringify(kids)})`);
    ok(await alex.evaluate(() => /kids served/.test(document.querySelector('#impact')?.textContent || '') && document.querySelector('#impact').getBoundingClientRect().top < document.querySelector('.bp-next').getBoundingClientRect().top), 'Home: Impact near the top, under the figures');
    ok(await alex.evaluate(() => { const so = [...document.querySelectorAll('#impact .bp-impact__stats > div')].find((d) => /so far$/.test(d.querySelector('dt')?.textContent || '')); return !so || /^\d+\skids? · \d+\srooms?/.test(so.querySelector('dd').textContent); }), 'Home: this year so far gives its kids and its rooms');
    const gifts = await alex.evaluate(() => { const c = document.querySelector('.bp-gifts'); return c && { sum: c.querySelector('.bp-gifts__sum')?.textContent, rows: [...c.querySelectorAll('.bp-gift')].map((r) => r.textContent), fresh: c.querySelectorAll('.bp-gift.is-new').length, all: c.querySelector('a[href="#/financials/gifts"]')?.textContent, beforeMakeovers: c.getBoundingClientRect().top < document.querySelector('#makeovers').getBoundingClientRect().top, inside: c.scrollWidth <= c.clientWidth }; });
    ok(gifts?.rows.length === 6 && /^\$25,000Sample Family FoundationLee Sample · Evening of SunshineNew/.test(gifts.rows[0]) && /^\$5,000Dana ExampleMakeoversNew/.test(gifts.rows[1]) && gifts.fresh === 2, `Home: the year’s newest six major gifts, a company with who gave for it, a gift for a kid as Makeovers, the two since their last visit new (${JSON.stringify(gifts?.rows.slice(0, 2))})`);
    ok(/^\$43,500 from 8 gifts of \$1,000 or more in \d{4}$/.test((gifts?.sum || '').replace(/ /g, ' ')) && !gifts.rows.some((r) => /\$999|example\.com|Maya/.test(r)) && gifts.rows.some((r) => /in kind/.test(r)), `Home: the year’s total; nothing under $1,000, no email, no kid’s name (${gifts?.sum})`);
    ok(gifts?.beforeMakeovers && gifts.inside && /^All 8 this year/.test(gifts.all || ''), 'Home: Major gifts sits above the makeovers, fits its card, and opens the whole year');
    if (width === 1440) {
      // Each year's bar says its numbers under the pointer, inside the panel even at the ends
      const tips = [];
      for (const pick of ['first-of-type', 'last-of-type']) {
        await alex.hover(`#impact .bp-spark__bars > button:${pick}`);
        tips.push(await alex.waitForFunction(() => { const t = document.querySelector('#impact .bp-ytip'); const s = document.querySelector('.bp-sum').getBoundingClientRect(); const r = t?.getBoundingClientRect(); return t && r.left >= s.left && r.right <= s.right ? t.textContent : null; }, { timeout: 2000 }).then((h) => h.jsonValue(), () => ''));
      }
      ok(tips.every((t) => /^\d{4}( so far)?\d+\skids? · \d+\srooms? · \d+\smakeovers?$/.test(t)) && tips[0] !== tips[1], `Home: hovering a year’s bar says its kids, rooms and makeovers (${JSON.stringify(tips)})`);
      await alex.mouse.move(2, 2);
    }
    await alex.evaluate(() => document.querySelector('#impact .bp-impact__more').click());
    ok(await alex.waitForFunction(() => { const bars = [...document.querySelectorAll('#impact .bp-years__hit')]; return bars.length >= 1 && bars.every((b) => /^\d{4}( so far)?: \d+\skids?, \d+\srooms?, \d+\smakeovers?$/.test(b.getAttribute('aria-label') || '')) && /\d{4}/.test(document.querySelector('.bp-yearpanel__head')?.textContent || ''); }, { timeout: 3000 }).then(() => true, () => false), 'Home: Explore by year opens a bar a year, each saying its numbers, and the year’s makeovers');
    // A year's bar on Home opens that year below; the bigger bars say their numbers too
    const firstYear = await alex.$eval('#impact .bp-spark__bars > button', (b) => b.getAttribute('aria-label').slice(0, 4));
    await alex.click('#impact .bp-spark__bars > button');
    ok(await alex.waitForFunction((y) => document.querySelector('.bp-yearpanel__head strong')?.textContent === y, { timeout: 2000 }, firstYear).then(() => true, () => false), `Home: tapping ${firstYear}’s bar opens ${firstYear}`);
    if (width === 1440) {
      await alex.hover('#impact .bp-years__bars li:last-child .bp-years__hit');
      ok(await alex.waitForFunction(() => /^\d{4}( so far)?\d+\skids? · \d+\srooms? · \d+\smakeovers?$/.test(document.querySelector('.bp-years .bp-ytip')?.textContent || ''), { timeout: 2000 }).then(() => true, () => false), 'Home: Explore by year’s bars say their numbers under the pointer too');
      await alex.mouse.move(2, 2);
    }
    ok(await overflow(alex) <= 0, 'Home: nothing past the right edge');
    if (width === 390) {
      const bar = await alex.evaluate(() => { const n = getComputedStyle(document.querySelector('.bp-nav')); return { pos: n.position, bottom: n.bottom, tabs: document.querySelectorAll('.bp-nav a').length }; });
      ok(bar.pos === 'fixed' && bar.bottom === '0px' && bar.tabs === 5, 'on a phone: the five pages are a bar along the bottom');
      // The bar is always on top: at every depth of the page a tap on a tab is the tab's, never what's scrolled under it
      // (QA, Oct 31 2026: the header's own layer had put the page over it, so Meetings answered the RSVP)
      const under = await alex.evaluate(async () => {
        const wrong = [];
        for (let y = 0; y < document.documentElement.scrollHeight; y += 120) {
          scrollTo(0, y);
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          for (const a of document.querySelectorAll('.bp-nav a')) { const b = a.getBoundingClientRect(); const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); if (!a.contains(hit)) wrong.push(`${y}:${a.textContent.trim()}:${hit?.className || hit?.tagName}`); }
        }
        scrollTo(0, 0);
        return wrong;
      });
      ok(!under.length, `on a phone: a tap on a tab is always the tab's (${under.slice(0, 3).join(', ')})`);
      // The header steps away going down and comes back going up, the search with it
      const head = await alex.evaluate(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const seen = () => Math.round(document.querySelector('.bp-top').getBoundingClientRect().bottom);
        scrollTo(0, 0); await frame();
        for (let y = 100; y <= 700; y += 100) { scrollTo(0, y); await frame(); }
        await new Promise((r) => setTimeout(r, 400));
        const down = seen();
        for (let y = 680; y >= 560; y -= 20) { scrollTo(0, y); await frame(); }
        await new Promise((r) => setTimeout(r, 400));
        const up = seen();
        const find = document.querySelector('.bp-find').getBoundingClientRect();
        scrollTo(0, 0); await frame();
        return { down, up, find: Math.round(find.top) };
      });
      ok(head.down <= 0 && head.up > 40 && head.find >= 0, `on a phone: the header steps away going down the page and comes back going up, the search in reach (${JSON.stringify(head)})`);
    }
    await shot(alex, `10-home-${width}`);
    if (width === 1440) {
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
      // A file found by what it says: its words read once (Workers AI's converter, faked for the statement only), the
      // page they're on beside them, and Enter opens the PDF at them, its find box on the words
      env.AI.toMarkdown = async (doc) => ({ name: doc.name, format: 'markdown', data: /balance.?sheet/i.test(doc.name) ? '# s.pdf\n## Metadata\n- PDFFormatVersion=1.7\n## Contents\n### Page 1\nStatement of Financial Position\n### Page 2\nUnrestricted net assets grew with the spring appeal' : '' });
      while (await readBoardWords(env, { limit: 20, budgetMs: 60000 })) { /* each file once */ }
      delete env.AI.toMarkdown;
      await alex.goto(`${SITE}/admin/board/`, { waitUntil: 'domcontentloaded' });
      await alex.waitForSelector('.bp-find', { timeout: 8000 });
      await alex.click('.bp-find');
      await alex.waitForSelector('dialog.bp-finder[open] input', { timeout: 4000 });
      await alex.keyboard.type('spring apeal');
      ok(await alex.waitForFunction(() => /Showing results for spring appeal[\s\S]*Files[\s\S]*Balance sheet financials[\s\S]*Page 2[\s\S]*spring appeal/i.test(document.querySelector('.bp-finder__list')?.textContent || ''), { timeout: 8000 }).then(() => true, () => false), 'search finds a file by what it says (a word misspelt read as the one there), with the page it’s on');
      await alex.keyboard.press('Enter');
      ok(await alex.waitForFunction(() => /^spring appeal$/i.test(document.querySelector('.fv-find-input')?.value || ''), { timeout: 10000 }).then(() => true, () => false), 'Enter opens the PDF at those words, its find box on them');
      await alex.keyboard.press('Escape');
      await alex.keyboard.press('Escape');
      await sleep(400);
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
    ok(await alex.evaluate(() => /^8:00\u00a0AM · \d+\u00a0min$/.test(document.querySelector('.bp-agsec__time')?.textContent.trim() || '')), 'the meeting: each part’s time, the run of show (the units never on a line of their own)');
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

    if (width === 1440) {
      // Meetings: the next meeting is Home's card; a past meeting's row says who was there and its files in words, and
      // only what's out of the ordinary is a chip (never "Minutes approved")
      await alex.goto(`${SITE}/admin/board/#/meetings`, { waitUntil: 'networkidle0' });
      await alex.waitForSelector('.bp-mrow', { timeout: 6000 }).catch(() => {});
      const list = await alex.evaluate(() => ({ next: !!document.querySelector('.bp-gap > .bp-nextup .bp-rsvp'), rows: [...document.querySelectorAll('.bp-archive .bp-mrow')].map((r) => ({ chips: [...r.querySelectorAll('.bp-chip')].map((c) => c.textContent), side: r.querySelector('.bp-mrow__side')?.textContent || '', meta: r.querySelector('.bp-mrow__meta')?.textContent || '' })) }));
      ok(list.next && list.rows.every((r) => !r.chips.some((c) => /Minutes approved/.test(c)) && /^(\d+ of \d+ there( · )?)?(\d+ files?)?$/.test(r.side) && /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/.test(r.meta)), `Meetings: Home’s next-meeting card; rows with the weekday, who was there and the files in words, no routine chips (${JSON.stringify(list.rows.slice(0, 2))})`);
      // A meeting: its agenda items are rows under their part (no card each), and Google Meet once in the facts before the day
      await alex.goto(`${SITE}/admin/board/#/meetings/${meetingId}`, { waitUntil: 'networkidle0' });
      await alex.waitForSelector('.bp-agitem', { timeout: 6000 }).catch(() => {});
      const ag = await alex.evaluate(() => { const it = document.querySelector('.bp-agitem'); const cs = it && getComputedStyle(it); return { flat: !!cs && cs.boxShadow === 'none' && cs.backgroundColor === 'rgba(0, 0, 0, 0)', meets: document.querySelectorAll('.bp-aghero a[href^="https://meet.google.com/"]').length, glance: !document.querySelector('ul.bp-glance') }; });
      ok(ag.flat && ag.meets === 1 && ag.glance, `the meeting: agenda items as rows, Google Meet once, no count strip (${JSON.stringify(ag)})`);
      const note = await alex.evaluate(() => { const n = document.querySelector('.bp-aghero__note'); return n && { text: n.textContent, under: n.getBoundingClientRect().top >= document.querySelector('.bp-aghero__facts').getBoundingClientRect().bottom }; });
      ok(note?.text === 'Park in the back lot. The side door is open.' && note.under, `the meeting shows the notes for the invite under where and when (${JSON.stringify(note)})`);
      // The invite's short link (/board/<id>, public/_redirects) arrives as ?meeting=<id>: the meeting, at its usual address
      await alex.goto(`${SITE}/admin/board/?meeting=${meetingId}`, { waitUntil: 'networkidle0' });
      await alex.waitForSelector('.bp-aghero__title', { timeout: 6000 }).catch(() => {});
      const short = await alex.evaluate(() => ({ at: location.search + location.hash, title: document.querySelector('.bp-aghero__title')?.textContent || '' }));
      ok(short.at === `#/meetings/${meetingId}` && !!short.title, `the invite’s link opens the meeting (${JSON.stringify(short)})`);
      // A paper's short link in an email (/board/<paper id>, or /board/documents) keeps its place the same way
      const paperId = await alex.evaluate(async () => ((await (await fetch('/api/board-portal')).json()).docs || []).find((d) => d.sign && !d.hidden)?.id || '');
      ok(!!paperId, 'a paper to sign, for its short link');
      await alex.goto(`${SITE}/admin/board/?meeting=${paperId}`, { waitUntil: 'networkidle0' });
      await alex.waitForSelector('.bp-docpage', { timeout: 6000 }).catch(() => {});
      ok(await alex.evaluate((id) => location.search === '' && location.hash === `#/documents/${id}` && !!document.querySelector('.bp-docpage'), paperId), 'a paper’s link in an email opens the paper');
      await alex.goto(`${SITE}/admin/board/?meeting=documents`, { waitUntil: 'networkidle0' });
      ok(await alex.evaluate(() => location.search === '' && location.hash === '#/documents'), 'the link to every paper opens Documents');
      // People: a directory, a row a person, email and copy as two small buttons named for them
      await alex.goto(`${SITE}/admin/board/#/people`, { waitUntil: 'networkidle0' });
      await alex.waitForSelector('.bp-dir .bp-person', { timeout: 6000 }).catch(() => {});
      const dir = await alex.evaluate(() => ({ rows: document.querySelectorAll('.bp-dir .bp-person').length, mail: !!document.querySelector('.bp-person a.bp-iconbtn[aria-label^="Email "][href^="mailto:"]'), copy: !!document.querySelector('.bp-person button.bp-iconbtn[aria-label$="email address"]'), words: /\bCopy\b/.test(document.querySelector('.bp-dir')?.innerText || '') }));
      ok(dir.rows >= 2 && dir.mail && dir.copy && !dir.words, `People: a directory with email and copy as icon buttons (${JSON.stringify(dir)})`);
      // Documents: SOARD's papers in one panel, the shelves side by side, each paper a row that opens it
      await alex.goto(`${SITE}/admin/board/#/documents`, { waitUntil: 'networkidle0' });
      await alex.waitForSelector('.bp-papers', { timeout: 6000 }).catch(() => {});
      const papers = await alex.evaluate(() => ({ cols: [...document.querySelectorAll('.bp-papers__col')].map((c) => c.querySelector('.bp-papers__h')?.textContent), rows: [...document.querySelectorAll('.bp-papers .bp-file a.bp-file__main')].map((a) => a.textContent), old: !!document.querySelector('.bp-shelf, .bp-docc') }));
      ok(papers.cols.some((c) => /^Governing documents1$/.test(c)) && papers.rows.some((r) => /Signed Amended Bylaws\s*PDF · \d/.test(r)) && !papers.old, `Documents: SOARD’s papers in one panel, each a row that opens it (${JSON.stringify(papers)})`);
      // Financials: cash over time says a month's balance under the pointer
      await alex.goto(`${SITE}/admin/board/#/financials`, { waitUntil: 'networkidle0' });
      if (await alex.$('.bp-cashchart li')) {
        await alex.hover('.bp-cashchart li:last-child');
        ok(await alex.waitForFunction(() => /^[A-Z][a-z]{2} \d{1,2}, so far\$[\d,]+/.test(document.querySelector('.bp-cashchart .bp-ytip')?.textContent || ''), { timeout: 2000 }).then(() => true, () => false), 'Financials: a month’s bar says its balance');
        await alex.mouse.move(2, 2);
      }
    }
    // Home's "All 8 this year" opens Financials at the major gifts: every one, under the year's total (the page settles a little
    // after QuickBooks' year beside last year is read, so this waits for it)
    await alex.goto(`${SITE}/admin/board/#/financials/gifts`, { waitUntil: 'networkidle0' });
    ok(await alex.waitForFunction(() => { const g = document.getElementById('gifts'); if (!g) return false; const r = g.getBoundingClientRect(); return g.querySelectorAll('.bp-gift').length === 8 && /^\$43,500 from 8\sgifts in\s\d{4}$/.test(g.querySelector('.bp-gifts__total')?.textContent || '') && r.top >= 0 && r.top < innerHeight / 2; }, { timeout: 12000 }).then(() => true, () => false), 'Financials: #/financials/gifts opens at the major gifts, all 8 under the year’s total');
    for (const [p, re] of [
      // The cash, then the year beside the cash over time, then the statements, then the tax returns and audits
      ['financials', /Cash in the bank[\s\S]*\$375,000[\s\S]*Straight from Mercury, read today at[\s\S]*Money in and out[\s\S]*Money in\s+\$900,000\s+\$800,000[\s\S]*Money out\s+\$850,000[\s\S]*Makeovers[\s\S]*Net\s+\$50,000\s+−\$20,000[\s\S]*Live from Mercury’s record\. The official books are in Mercury Books\.[\s\S]*Cash over time[\s\S]*The lowest point: \$210,000[\s\S]*The least we keep in the bank: \$150,000[\s\S]*The latest statements[\s\S]*Balance sheet financials[\s\S]*Tax returns and audits[\s\S]*2025/],
      ['people', /Board of Directors[\s\S]*Alex Rivera[\s\S]*The team[\s\S]*Jane Doe/],
      // (one way to sign: every paper's on its own page, a PDF too)
      ['documents', width === 1440 ? /Board Member Expectations[\s\S]*Read and sign[\s\S]*Conflict of interest policy[\s\S]*Read and sign[\s\S]*Every meeting’s files[\s\S]*Balance sheet financials/ : /Board Member Expectations[\s\S]*You added your signed copy[\s\S]*Conflict of interest policy[\s\S]*Signed\s*by Alex Rivera/],
    ]) {
      await alex.goto(`${SITE}/admin/board/#/${p}`, { waitUntil: 'networkidle0' });
      ok(await waitText(alex, re), `${p} shows what it should`);
      ok(await overflow(alex) <= 0, `${p}: nothing past the right edge`);
      await shot(alex, `12-${p}-${width}`);
    }
    if (width === 1440) {
      ok(await alex.evaluate(() => !document.querySelector('.bp-signlist .bp-sign')), 'Documents has no form to sign: Read and sign opens each paper');
      // The policy (a PDF): its own page, the file to read and the signing under it
      await alex.evaluate(() => [...document.querySelectorAll('.bp-signlist li')].find((li) => /Conflict of interest/i.test(li.innerText))?.querySelector('a.bp-btn')?.click());
      ok(await alex.waitForSelector('.bp-docpage .bp-sign input', { timeout: 6000 }).then(() => true, () => false) && /^#\/documents\/d_/.test(await alex.evaluate(() => location.hash)), 'Read and sign on a PDF opens its own page');
      await clickText(alex, 'button', /^I’ve read it and agree$/);
      ok(await waitText(alex, /Type your full name, first and last, the way you sign it/), 'signing with no name says what to do');
      ok(await alex.$eval('.bp-sign input', (i) => i.placeholder) === 'Your full name', 'the name box is empty until they type (their name in grey read as filled in)');
      await alex.type('.bp-sign input', 'Mickey Mouse');
      await clickText(alex, 'button', /^I’ve read it and agree$/);
      ok(await waitText(alex, /Sign with your own name, as the board has it: Alex Rivera/) && !(await waitText(alex, /Signed\s*by Mickey/, 600)), 'someone else’s name isn’t a signature');
      await alex.$eval('.bp-sign input', (i) => { i.select(); });
      await alex.keyboard.press('Backspace');
      await alex.type('.bp-sign input', 'alex rivera');
      await clickText(alex, 'button', /^I’ve read it and agree$/);
      ok(await waitText(alex, /Signed\s*by Alex Rivera/), 'they sign the policy with their typed name (kept the way People spells it)');
      // The focus moves a frame after "Signed by…" shows
      ok(await alex.waitForFunction(() => document.activeElement?.classList.contains('bp-signed'), { timeout: 2000 }).then(() => true, () => false), 'the focus goes to “Signed by…”, not the page');
      // The expectations, written in Board: read on their own page, signed at the end (here with the copy signed on paper)
      // (only the # changes: the list draws a moment after the jump, so its link is waited for)
      await alex.goto(`${SITE}/admin/board/#/documents`, { waitUntil: 'networkidle0' });
      await alex.waitForFunction(() => [...document.querySelectorAll('.bp-signlist a')].some((a) => /^Read and sign$/.test(a.textContent.trim())), { timeout: 6000 }).catch(() => {});
      await clickText(alex, 'a', /^Read and sign$/);
      ok(await alex.waitForFunction(() => /^#\/documents\/d_/.test(location.hash), { timeout: 4000 }).then(() => true, () => false)
        && await alex.waitForFunction(() => document.querySelector('.bp-docpage .bp-eyebrow')?.textContent === 'Every board member signs it each year', { timeout: 4000 }).then(() => true, () => false)
        && await waitText(alex, /Board Member Expectations[\s\S]*Each member of the board agrees[\s\S]*Attendance[\s\S]*Attend at least three of four board meetings[\s\S]*Giving and asking[\s\S]*Sign it for \d{4}[\s\S]*0 of 3 board members have signed/), 'the expectations on their own page: the words, then signing at the end');
      ok(await alex.waitForFunction(() => document.querySelectorAll('.bp-docpage__words h2').length === 2 && !/Signature: _/.test(document.body.innerText), { timeout: 4000 }).then(() => true, () => false), 'its headings as the page’s; no blanks to sign on screen');
      ok(await alex.evaluate(() => document.querySelector('.bp-docpage__words ol')?.start === 1), 'its numbered list counts from 1');
      ok(await overflow(alex) <= 0, 'the expectations’ page: nothing past the right edge');
      await shot(alex, '12-expectations-1440');
      // Printed: the words and the lines to sign on paper, never the form or the menu
      await alex.emulateMediaType('print');
      ok(await alex.evaluate(() => { const seen = (sel) => { const el = document.querySelector(sel); return !!el && getComputedStyle(el).display !== 'none'; }; return seen('.bp-docpage__paper') && !seen('.bp-docpage__sign .bp-sign') && !seen('.bp-docpage__head .bp-btns') && !seen('.bp-nav'); }), 'printed, it has the lines to sign on paper and nothing to click');
      await alex.emulateMediaType('screen');
      ok(await waitText(alex, /Signed it on paper already\?\s*Add your signed copy/), 'the other way to sign: the copy signed on paper');
      const copyInput = await alex.$('.bp-sign input[type="file"]');
      await copyInput.uploadFile(pdf);
      ok(await waitText(alex, /Signed for \d{4}[\s\S]*You added your signed copy/), 'the copy signed on paper is their signature');
      ok(await alex.waitForFunction(() => document.activeElement?.classList.contains('bp-signed'), { timeout: 2000 }).then(() => true, () => false), 'the focus goes to “Signed…” after the copy too');
      await alex.$eval('.bp-signed a', (a) => a.click());
      ok(await alex.waitForFunction(() => document.body.classList.contains('fv-open'), { timeout: 4000 }).then(() => true, () => false), 'their copy opens for them, in the viewer');
      await alex.keyboard.press('Escape');
      // The wrong file sent: they replace it themselves
      const copyOf = () => alex.evaluate(() => fetch('/api/board-portal', { cache: 'no-store' }).then((r) => r.json()).then((d) => d.docs.find((x) => x.signedByMe?.how === 'copy')?.signedByMe.copy.id || ''));
      const firstCopy = await copyOf();
      await (await alex.$('.bp-signed input[type="file"]')).uploadFile(pdf);
      ok(await alex.waitForFunction((was) => fetch('/api/board-portal', { cache: 'no-store' }).then((r) => r.json()).then((d) => { const id = d.docs.find((x) => x.signedByMe?.how === 'copy')?.signedByMe.copy.id; return !!id && id !== was; }), { timeout: 6000, polling: 500 }, firstCopy).then(() => true, () => false)
        && await waitText(alex, /You added your signed copy[\s\S]*Replace it/), 'a copy they added, replaced by another');
      await alex.goto(`${SITE}/admin/board/#/documents`, { waitUntil: 'networkidle0' });
      ok(await alex.evaluate(() => !document.querySelector('.bp-sign')) && await waitText(alex, /You’ve signed them all for \d{4}\. Thank you\./), 'both signed, nothing left to sign');
      await alex.goto(`${SITE}/admin/board/#/reveals`, { waitUntil: 'networkidle0' });
      ok(await alex.evaluate(() => location.hash) === '#/' && await alex.waitForSelector('#makeovers .bk-col', { timeout: 8000 }).then(() => true, () => false), 'the old Reveals link opens Home, where reveals are now');
      await alex.goto(`${SITE}/admin/board/#/meetings/${pastId}`, { waitUntil: 'networkidle0' });
      ok(!(await waitText(alex, /Reserves grew/, 2000)), 'a meeting not shared stays off the board page');
    } else {
      await alex.goto(`${SITE}/admin/board/#/`, { waitUntil: 'networkidle0' });
      await clickText(alex, '.bp-nav a', /^Meetings$/);
      ok(await waitText(alex, /Every agenda, with the notes/), 'the tab bar opens Meetings');
    }
    await alex.close();
  }

  // ─── A presenter writes their report on the board page (portal.js ReportPage, ../board-report.js) ───
  console.log('A presenter’s report');
  const finOf = async () => (await meetingNow(jane, meetingId)).sections.flatMap((x) => x.items).find((it) => it.title === 'Financial');
  const finId = (await finOf()).id;
  const samSaved = (page) => page.waitForFunction(() => /^Saved/.test(document.querySelector('.rp-foot__status')?.textContent.trim() || ''), { timeout: 8000 }).then(() => true, () => false);
  for (const width of [1440, 390]) {
    const sam = await tab(OTHER, width);
    if (width === 1440) {
      await sam.goto(`${SITE}/admin/board/`, { waitUntil: 'networkidle0' });
      ok(await waitText(sam, /Write your report: Financial/), 'Home asks the presenter for their report');
      await clickText(sam, '.bp-todo', /^Write your report: Financial/);
      ok(await sam.waitForSelector('.bp-rp [contenteditable="true"]', { timeout: 6000 }).then(() => true, () => false), 'it opens on a page of its own, the editor there');
      ok(await sam.evaluate(() => !!document.activeElement?.closest('.rp-edit')), 'ready to type at once, before the page has finished arriving');
      // Markdown as it's typed: **bold** as it closes, "> " a callout
      await sam.keyboard.type('Cash is **up** 12% on last year');
      await sam.keyboard.press('Enter');
      await sam.keyboard.type('> The board needs to approve the audit firm');
      ok(await samSaved(sam), 'it saves by itself');
      const fin = await finOf();
      ok(fin.report === 'Cash is **up** 12% on last year\n\n> The board needs to approve the audit firm' && fin.reportBy === 'Sam Ortiz', `kept as Markdown, by Sam (${JSON.stringify(fin.report)}, ${fin.reportBy})`);
      const shown = await sam.evaluate(() => ({ text: document.querySelector('.rp-edit')?.innerText.replace(/\s+/g, ' ').trim(), bold: document.querySelector('.rp-edit strong')?.textContent }));
      ok(shown.text === 'Cash is up 12% on last year The board needs to approve the audit firm' && shown.bold === 'up', `what the editor shows is what's saved (${JSON.stringify(shown)})`);
      // Jane changes it in Board meanwhile: Sam's next save never writes over hers; he sees it and chooses
      await jane.evaluate(async (b) => { await fetch('/api/board-portal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); }, { action: 'report', meetingId, itemId: finId, text: `${fin.report}\n\nJane’s line`, base: fin.reportAt });
      await sam.keyboard.type(' this quarter');
      ok(await waitText(sam, /Jane Doe changed this report/), 'someone else’s newer save stops his, and says whose');
      await shot(sam, 'report-clash');
      await clickText(sam, '.bp-rp__clash button', /^Keep mine$/);
      ok(await samSaved(sam), 'Keep mine saves his');
      const kept = await finOf();
      ok(/audit firm this quarter$/.test(kept.report) && !/Jane’s line/.test(kept.report), `his words, chosen over hers (${JSON.stringify(kept.report)})`);
      await shot(sam, 'report-write');
      // Away to another tab mid-sentence and back: saved as he left, and his next words aren't taken for someone else's
      await sam.keyboard.type(' and next');
      await sam.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
      ok(await samSaved(sam) && /this quarter and next$/.test((await finOf()).report), 'leaving for another tab saves what’s typed');
      await sam.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
      await sam.keyboard.type(' year');
      ok(await samSaved(sam) && !(await sam.$('.bp-rp__clash')) && /this quarter and next year$/.test((await finOf()).report), 'back again, his next words save with no clash with his own');
      // A document with his report: attached from here, listed, then taken off again (his own, so gone for good)
      const filesBefore = (await meetingNow(jane, meetingId)).files.length;
      await (await sam.$('.bp-rp__attach input[type="file"]')).uploadFile(pdf);
      ok(await sam.waitForFunction(() => document.querySelectorAll('.bp-rp__files li').length === 2, { timeout: 8000 }).then(() => true, () => false), 'Attach a file puts a document with it, listed under the report');
      const withDoc = await finOf();
      ok(withDoc.docs.length === 2 && !(await sam.$('.bp-rp__attach.is-busy')), `on the item, after the one already there (${withDoc.docs.length} documents)`);
      const offs = await sam.evaluate(() => [...document.querySelectorAll('.bp-rp__files li')].map((li) => !!li.querySelector('.bp-rp__off')));
      ok(offs.join() === 'false,true', `he can take off only the one he put there (${offs.join()})`);
      await shot(sam, 'report-docs');
      await clickText(sam, '.bp-rp__files .bp-rp__off', /^Take it off$/);
      ok(await waitText(sam, /Take it off for good\?/), 'taking it off asks first, in place');
      await clickText(sam, '.bp-rp__files .bp-rp__off.is-yes', /^Take it off$/);
      ok(await sam.waitForFunction(() => document.querySelectorAll('.bp-rp__files li').length === 1, { timeout: 6000 }).then(() => true, () => false), 'and it’s off');
      const afterOff = await meetingNow(jane, meetingId);
      ok(afterOff.sections.flatMap((x) => x.items).find((it) => it.id === finId).docs.length === 1 && afterOff.files.length === filesBefore, `gone from the meeting for good, the other one still there (${afterOff.files.length} files, ${filesBefore} before)`);
      // Offline: Done stays, the words with it; back online, they save by themselves
      await sam.evaluate(() => document.querySelector('.bp-rp .rp-edit')?.focus());
      await sam.setOfflineMode(true);
      await sam.keyboard.type(' and offline');
      ok(await sam.waitForFunction(() => /Not saved/.test(document.querySelector('.rp-foot__status')?.textContent || ''), { timeout: 8000 }).then(() => true, () => false), 'offline: it says it isn’t saved');
      await clickText(sam, '.bp-rp__foot a', /^Done$/);
      await sleep(800);
      ok(/\/report\//.test(await sam.evaluate(() => location.hash)) && /and offline/.test(await sam.$eval('.bp-rp .rp-edit', (e) => e.innerText)), 'Done stays on the page with the words, never leaving them behind');
      await sam.setOfflineMode(false);
      await sam.evaluate(() => dispatchEvent(new Event('online')));
      ok(await samSaved(sam) && /and offline$/.test((await finOf()).report), 'back online, they save by themselves');
      // Under the editor, how it shows in the meeting; then one suggestion at a time that does what it says
      ok(await waitText(sam, /Your report fits on one slide\./), `under the editor: how it shows in the meeting (${await sam.evaluate(() => document.querySelector('.rp-coach__fit')?.textContent)})`);
      await toEnd(sam);
      await sam.keyboard.press('Enter');
      await sam.keyboard.press('Enter');
      await sam.keyboard.type('We met twice this quarter and read every statement. The audit firm sent its letter on time. Cash is up and spending is under the budget.');
      ok(await samSaved(sam), 'a long paragraph saves');
      ok(await waitText(sam, /This paragraph is long for a screen\. Make it points\?/), 'a long paragraph: the coach offers to make it points');
      await shot(sam, 'report-coach');
      await clickText(sam, '.rp-coach__btn', /^Make it points$/);
      ok(await sam.waitForFunction(() => document.querySelectorAll('.bp-rp .rp-edit ul > li').length === 3, { timeout: 4000 }).then(() => true, () => false), 'Make it points: one point a sentence, in the editor');
      ok(await samSaved(sam) && /\n\n- We met twice this quarter and read every statement\.\n- The audit firm sent its letter on time\.\n- Cash is up and spending is under the budget\.$/.test((await finOf()).report), `and saved that way, every word kept (${JSON.stringify((await finOf()).report)})`);
      ok(!(await text(sam)).includes('Make it points?'), 'done, it isn’t offered again');
      // "New slide here": a break where the caret is, kept as ---; Undo takes it back
      await sam.evaluate(() => { const ed = document.querySelector('.bp-rp .rp-edit'); ed.focus(); const r = document.createRange(); r.selectNodeContents(ed.querySelector(':scope > p')); r.collapse(false); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); });
      await sleep(150);
      await sam.click('.rp-tool[aria-label="New slide here"]');
      ok(await sam.waitForFunction(() => !!document.querySelector('.bp-rp .rp-edit hr'), { timeout: 3000 }).then(() => true, () => false), 'New slide here puts a break in the editor');
      ok(await samSaved(sam) && /^Cash is \*\*up\*\* 12% on last year\n\n---\n\n> /.test((await finOf()).report), `kept as a line of --- after the first paragraph (${JSON.stringify((await finOf()).report.slice(0, 60))})`);
      await sam.click('.rp-tool[aria-label="Undo"]');
      ok(await samSaved(sam) && !/---/.test((await finOf()).report), 'Undo takes it back');
      // In a callout, the new slide goes after the whole callout (a break inside one would start none)
      await sam.evaluate(() => { const ed = document.querySelector('.bp-rp .rp-edit'); ed.focus(); const r = document.createRange(); r.selectNodeContents(ed.querySelector('blockquote p') || ed.querySelector('blockquote')); r.collapse(false); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); });
      await sleep(150);
      await sam.click('.rp-tool[aria-label="New slide here"]');
      ok(await samSaved(sam) && /\n> [^\n]*\n\n---\n\n+- We met twice/.test((await finOf()).report) && reportSlides((await finOf()).report).length === 2, `in a callout: after the whole callout, a new slide on the screen (${JSON.stringify((await finOf()).report.slice(0, 160))})`);
      await sam.click('.rp-tool[aria-label="Undo"]');
      ok(await samSaved(sam) && !/---/.test((await finOf()).report), 'and Undo takes that back too');
      await clickText(sam, '.bp-rp__foot a', /^Done$/);
      // His own report says when; the item already names him, so not "by Sam" again
      ok(await sam.waitForFunction((id) => { const by = document.querySelector(`#i-${id} .bp-report__by`)?.textContent.trim() || ''; return /^Report\s*\w{3} \d+/.test(by) && !/\bby\b/.test(by) && /Sam Ortiz/.test(document.querySelector(`#i-${id} .bp-pres`)?.textContent || ''); }, { timeout: 8000 }, finId).then(() => true, () => false), 'Done: back on the meeting, the report under its item, with its day (Sam is named on the item)');
      ok(await sam.evaluate((id) => !!document.querySelector(`#i-${id} .bp-report strong`) && !!document.querySelector(`#i-${id} .bp-report .rp-callout`) && !document.querySelector(`#i-${id} .bp-report-ask`), finId), 'as it reads: bold, the callout');
      ok(!(await text(sam)).includes('Write your report: Financial'), 'and Home stops asking');
      await shot(sam, 'report-on-meeting');
    } else {
      // A phone: the page fits, its tools in reach
      await sam.goto(`${SITE}/admin/board/#/meetings/${meetingId}/report/${finId}`, { waitUntil: 'networkidle0' });
      ok(await sam.waitForSelector('.bp-rp [contenteditable="true"]', { timeout: 6000 }).then(() => true, () => false), 'a phone opens the report to write');
      ok(await overflow(sam) <= 0, `nothing past a phone’s edge (${await overflow(sam)}px)`);
      ok(await sam.evaluate(() => [...document.querySelectorAll('.rp-tool')].filter((b) => b.offsetParent).every((b) => b.getBoundingClientRect().height >= 40) && document.querySelector('.rp-bar').getBoundingClientRect().height < 60), 'the tools are a finger’s size, in one row');
      await shot(sam, 'report-phone');
    }
    await sam.close();
  }
  // Alex presents nothing: he reads Sam's, and the server refuses him writing it
  const alexR = await tab(MEMBER);
  await alexR.goto(`${SITE}/admin/board/#/meetings/${meetingId}/report/${finId}`, { waitUntil: 'networkidle0' });
  ok(await waitText(alexR, /Only Sam can write this one/) && !(await alexR.$('.bp-rp [contenteditable="true"]')), 'someone who doesn’t present it reads it, with no editor');
  const refused = await alexR.evaluate(async (b) => (await fetch('/api/board-portal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).status, { action: 'report', meetingId, itemId: finId, text: 'Not mine', base: '' });
  ok(refused === 403, `and the server refuses him (${refused})`);
  await alexR.close();

  // ─── The founder sees what the board did, and sees the board page as they do ───
  console.log('Back to the founder');
  await jane.goto(`${SITE}/admin/#board/meeting/${meetingId}`, { waitUntil: 'networkidle0' });
  await jane.reload({ waitUntil: 'networkidle0' });
  ok(await waitText(jane, /Coming\s+1\s+Alex Rivera/), 'the founder sees Alex’s answer, his reply to the calendar invite');
  ok((await meetingNow(jane, meetingId)).actions.some((a) => a.text === 'Send the venue contract' && a.done), 'and that Alex ticked off the action item');
  await jane.goto(`${SITE}/admin/#board/documents`, { waitUntil: 'networkidle0' });
  ok(await waitText(jane, /Conflict of interest policy[\s\S]*Still to sign: Sam Ortiz, Kim Park[\s\S]*1 of 3 signed/), 'and who has still to sign each paper');
  // Who's signed, and how: typed, or the copy Alex added (which the founder opens); Kim's paper copy added for her, then taken off
  await jane.evaluate(() => [...document.querySelectorAll('.bd-row')].find((r) => /Conflict of interest policy/.test(r.textContent)).querySelector('button[aria-expanded]').click());
  ok(await waitText(jane, /Alex Rivera\s*Typed “Alex Rivera”, [A-Z][a-z]{2} \d+[\s\S]*Sam Ortiz\s*Not signed yet/), 'who’s signed, and how: Alex typed his name, as he typed it');
  const kimInput = await jane.$('.bd-signers input[type="file"]');
  await jane.evaluate(() => [...document.querySelectorAll('.bd-signer')].find((r) => /Kim Park/.test(r.textContent)).querySelector('button').click());
  await kimInput.uploadFile(pdf);
  ok(await waitText(jane, /Kim Park\s*Signed copy added here/) && await waitText(jane, /2 of 3 signed/), 'a paper copy Kim handed in, added for her');
  await jane.evaluate(() => [...document.querySelectorAll('.bd-signer')].find((r) => /Kim Park/.test(r.textContent)).querySelector('button').click());
  ok(await waitText(jane, /Kim Park\s*Not signed yet/) && await waitText(jane, /1 of 3 signed/), 'taken off again: Kim is asked to sign');
  ok(await waitText(jane, /Board Member Expectations[\s\S]*Still to sign: Sam Ortiz, Kim Park/), 'Alex signed the expectations too');
  await jane.evaluate(() => [...document.querySelectorAll('.bd-row')].find((r) => /Board Member Expectations/.test(r.querySelector('.bd-row__title')?.textContent || '')).querySelector('button[aria-expanded]').click());
  ok(await waitText(jane, /Alex Rivera\s*Added their signed copy, [A-Z][a-z]{2} \d+[\s\S]*See it/), 'with the copy he added, for the founder to open');
  // New words the board agrees to: who signed signs again, and sees why
  await editRow('Board Member Expectations');
  await jane.waitForSelector('.rp-edit');
  await toEnd(jane);
  await jane.keyboard.press('Enter');
  await jane.keyboard.type('Come to the gala each spring.');
  ok(/Come to the gala each spring/.test(await editorText(jane)), 'the words changed in the editor');
  await clickText(jane, 'button', /^Save$/);
  ok(await waitText(jane, /Saved\. The board signs the new version for \d{4}: each member sees it on Home and on the paper, and in the next documents email\./) && await waitText(jane, /Board Member Expectations[\s\S]*No one has signed the new version for \d{4} yet \(1 member signed the earlier one\)[\s\S]*0 of 3 signed/), 'asked (and answered: sign again), the new words start at nobody signed, saying Alex signed the earlier ones');
  const exp = (await listDocs(DB)).find((d) => d.title === 'Board Member Expectations');
  ok(exp.version === 2 && exp.signFrom === 2 && exp.earlier.includes('alex-rivera') && /Come to the gala each spring/.test(exp.body), `the second wording, kept, Alex’s signature on an earlier one (v${exp.version}, from ${exp.signFrom})`);
  const alexAgain = await tab(MEMBER, 1440);
  await alexAgain.goto(`${SITE}/admin/board/#/documents/${exp.id}`, { waitUntil: 'networkidle0' });
  ok(await waitText(alexAgain, /It changed since you signed: read it, then sign again\.[\s\S]*Come to the gala each spring[\s\S]*Sign it for \d{4}/), 'Alex is told at the top it changed, reads the new words and signs again at the end');
  await alexAgain.goto(`${SITE}/admin/board/#/`, { waitUntil: 'networkidle0' });
  ok(await waitText(alexAgain, /Read and sign: Board Member Expectations\s*It changed since you signed: read it, then sign again/), 'Home says so too');
  await alexAgain.close();
  // The earlier wording: read again, and back in the editor (left unsaved)
  await editRow('Board Member Expectations');
  const button = (label) => jane.waitForFunction((t) => [...document.querySelectorAll('.bd-words button')].some((b) => b.textContent.trim() === t), { timeout: 5000 }, label).then(() => true, () => false);
  await button('Earlier wordings (1)');
  await clickText(jane, '.bd-words button', /^Earlier wordings \(1\)$/);
  await button('Read it');
  await clickText(jane, '.bd-wordings button', /^Read it$/);
  ok(await waitText(jane, /Wording 1 · [A-Z][a-z]{2} \d+, \d{4}, \d{1,2}:\d{2} [AP]M · Jane · From Board Expectations · 1 signature on it this year, before the board was asked to sign again[\s\S]*Attend at least three of four board meetings/), 'the earlier wording: when to the minute, by whom, from which file, who signed it, to read');
  await clickText(jane, 'button', /^Use these words$/);
  ok(await jane.waitForFunction(() => !/Come to the gala/.test(document.querySelector('.rp-edit')?.innerText || '') && /Attend at least three/.test(document.querySelector('.rp-edit')?.innerText || ''), { timeout: 3000 }).then(() => true, () => false), 'and its words back in the editor');
  const asked = [];
  await answerAsks(jane, { onAsk: (t) => asked.push(t) });
  await clickText(jane, 'button', /^Cancel$/);
  ok(await jane.waitForFunction(() => !document.querySelector('.rp-edit'), { timeout: 3000 }).then(() => true, () => false) && asked.some((t) => /^Leave without saving\?/.test(t)), 'Cancel with words changed asks first (here: leave)');

  // A member reading wording 2 when wording 3 is saved can't sign words they never saw: told, and the page takes them
  const words = async (add, { save = true } = {}) => {
    await editRow('Board Member Expectations');
    await jane.waitForSelector('.rp-edit');
    await toEnd(jane);
    await jane.keyboard.press('Enter');
    await jane.keyboard.type(add);
    if (save) await clickText(jane, 'button', /^Save$/);
  };
  const reader = await tab(MEMBER, 390);
  await reader.goto(`${SITE}/admin/board/#/documents/${exp.id}`, { waitUntil: 'networkidle0' });
  await reader.waitForSelector('.bp-docpage .bp-sign input');
  await words('Sponsor one family a year.');
  ok(await jane.waitForFunction(() => !document.querySelector('.rp-edit'), { timeout: 5000 }).then(() => true, () => false) && (await listDocs(DB)).find((d) => d.id === exp.id).version === 3, 'saved straight away: nobody had signed wording 2 to ask about');
  await reader.type('.bp-docpage .bp-sign input', 'Alex Rivera');
  await clickText(reader, 'button', /^I’ve read it and agree$/);
  ok(await waitText(reader, /It changed while you had it open\. Read it again, then sign\./) && await waitText(reader, /Sponsor one family a year/) && !(await listDocs(DB)).find((d) => d.id === exp.id).signed['alex-rivera'], 'signing words that changed meanwhile: refused, said, and the new words are on the page');
  // (the name box emptied with the refusal: read again, then typed again)
  ok(await reader.$eval('.bp-docpage .bp-sign input:not([type="file"])', (i) => i.value === ''), 'the name box is emptied, to read it again first');
  await reader.type('.bp-docpage .bp-sign input:not([type="file"])', 'Alex Rivera');
  await clickText(reader, 'button', /^I’ve read it and agree$/);
  ok(await waitText(reader, /Signed for \d{4}/) && (await listDocs(DB)).find((d) => d.id === exp.id).signed['alex-rivera']?.version === 3, 'read, then signed: wording 3');
  await reader.close();
  // New words over Alex's signature: the question names him; Escape goes back to the words, nothing saved
  asked.length = 0;
  await answerAsks(jane, { accept: null, onAsk: (t) => asked.push(t) });
  await words('Bring a guest to one reveal.');
  ok(await jane.waitForFunction(() => /Ask Alex to sign again\?/.test(document.querySelector('.ask h2')?.textContent || '') && /Alex Rivera signed the earlier version/.test(document.querySelector('.ask__text')?.textContent || ''), { timeout: 5000 }).then(() => true, () => false), 'the question names who signed');
  await jane.keyboard.press('Escape');
  ok(await jane.waitForFunction(() => !document.querySelector('.ask') && /Bring a guest to one reveal/.test(document.querySelector('.rp-edit')?.innerText || ''), { timeout: 3000 }).then(() => true, () => false) && (await listDocs(DB)).find((d) => d.id === exp.id).version === 3, 'Escape: back to the words, nothing saved (not “keep their signatures”)');
  await answerAsks(jane, { accept: false, onAsk: (t) => asked.push(t) });
  await clickText(jane, 'button', /^Save$/);
  ok(await jane.waitForFunction(() => !document.querySelector('.rp-edit'), { timeout: 5000 }).then(() => true, () => false) && (await listDocs(DB)).find((d) => d.id === exp.id).signed['alex-rivera'], 'kept their signatures, chosen: a small change');
  // Two tabs on the same words: the second save is stopped and offered theirs or its own
  const janeB = await tab(FOUNDER, 1440);
  await janeB.goto(`${SITE}/admin/#board/documents`, { waitUntil: 'networkidle0' });
  await janeB.reload({ waitUntil: 'networkidle0' });
  await janeB.waitForFunction(() => [...document.querySelectorAll('.bd-row')].some((r) => /Board Member Expectations/.test(r.textContent)), { timeout: 8000 });
  await janeB.evaluate(() => [...document.querySelectorAll('.bd-row')].find((r) => /Board Member Expectations/.test(r.textContent)).querySelectorAll('button').forEach((b) => { if (b.textContent.trim() === 'Edit') b.click(); }));
  await janeB.waitForSelector('.rp-edit');
  await answerAsks(jane, { accept: false });
  await words('TAB A LINE');
  await jane.waitForFunction(() => !document.querySelector('.rp-edit'), { timeout: 5000 }).catch(() => {});
  const bAsked = [];
  await answerAsks(janeB, { accept: false, onAsk: (t) => bAsked.push(t) });
  await toEnd(janeB);
  await janeB.keyboard.press('Enter');
  await janeB.keyboard.type('TAB B LINE');
  await clickText(janeB, 'button', /^Save$/);
  ok(await janeB.waitForFunction(() => /TAB A LINE/.test(document.querySelector('.rp-edit')?.innerText || '') && !/TAB B LINE/.test(document.querySelector('.rp-edit')?.innerText || ''), { timeout: 5000 }).then(() => true, () => false)
    && bAsked.some((t) => /^You changed these words in another tab/.test(t)) && /TAB A LINE/.test((await listDocs(DB)).find((d) => d.id === exp.id).body) && !/TAB B LINE/.test((await listDocs(DB)).find((d) => d.id === exp.id).body), 'the second tab is stopped, told the words changed in another tab, and loads them (nothing overwritten)');
  await janeB.close();
  // Words changed and the tab closed or reloaded: the browser asks first
  await words('A line not saved yet.', { save: false });
  ok(await jane.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; }), 'closing the tab with words changed asks first');
  await answerAsks(jane);
  await clickText(jane, 'button', /^Cancel$/);
  await jane.waitForFunction(() => !document.querySelector('.rp-edit'), { timeout: 3000 }).catch(() => {});
  // A new file on a paper someone signed (the conflict of interest policy, a PDF Alex signed): asked first, naming him
  const coiAsked = [];
  await answerAsks(jane, { accept: false, onAsk: (t) => coiAsked.push(t) });
  await editRow('Conflict of interest policy');
  await jane.waitForSelector('#bd-doc-file');
  const coi2 = join(OUT, 'Conflict of Interest 2027.pdf');
  writeFileSync(coi2, await expectationsPdf());
  await (await jane.$('#bd-doc-file')).uploadFile(coi2);
  await clickText(jane, 'button', /^Save$/);
  await jane.waitForFunction(() => !document.querySelector('.rp-edit'), { timeout: 8000 }).catch(() => {});
  const coiDoc = (await listDocs(DB)).find((d) => /conflict of interest/i.test(d.title));
  ok(coiAsked.some((t) => /^Ask Alex to sign again\?.*Alex Rivera signed the earlier version for \d{4}\. With Conflict of Interest 2027 it’s a new version/.test(t)) && coiDoc.file.name === 'Conflict of Interest 2027.pdf' && coiDoc.signed['alex-rivera'] && coiDoc.version === 1,
    `a new file on a signed paper asks first, naming who signed (kept here: still signed, the new file a version of its own) (${JSON.stringify(coiAsked)})`);
  await answerAsks(jane);
  // Sam about to sign the policy's PDF on its page when its words are written in Board: told it didn't go, there
  const samDocs = await tab(OTHER, 1440);
  await samDocs.goto(`${SITE}/admin/board/#/documents/${coiDoc.id}`, { waitUntil: 'networkidle0' });
  const samInput = `.bp-docpage .bp-sign input:not([type="file"])`;
  await samDocs.waitForSelector(samInput);
  await samDocs.type(samInput, 'Sam Ortiz');
  await editRow('Conflict of interest policy');
  await jane.waitForSelector('.bd-words__start button');
  await clickText(jane, '.bd-words__start button', /^Start from the PDF’s words$/);
  await jane.waitForFunction(() => (document.querySelector('.rp-edit')?.innerText || '').length > 40, { timeout: 8000 }).catch(() => {});
  await clickText(jane, 'button', /^Save$/);
  await jane.waitForFunction(() => !document.querySelector('.rp-edit'), { timeout: 8000 }).catch(() => {});
  await samDocs.evaluate(() => [...document.querySelectorAll('.bp-docpage button')].find((b) => /I’ve read it and agree/.test(b.textContent))?.click());
  ok(await waitText(samDocs, /It changed while you had it open\. Read it again, then sign\./) && !(await listDocs(DB)).find((d) => d.id === coiDoc.id).signed['sam-ortiz'],
    'a signature that didn’t go (its PDF written in Board meanwhile) says so on its page, with its words to read');
  await samDocs.close();
  // A member who signed prints the paper with their signature on it, not blank lines
  const signedPrint = await tab(MEMBER, 1280);
  await signedPrint.goto(`${SITE}/admin/board/#/documents/${exp.id}`, { waitUntil: 'networkidle0' });
  await signedPrint.waitForSelector('.bp-docpage');
  await signedPrint.emulateMediaType('print');
  ok(/Signed for \d{4} by Alex Rivera, [A-Z][a-z]{2} \d+, \d{4}, typed on the board page/.test(await signedPrint.evaluate(() => document.querySelector('.bp-docpage__paper')?.innerText || '')) && await signedPrint.evaluate(() => !document.querySelector('.bp-docpage__lines')),
    'printed by a member who signed: their signature and how, not lines to sign');
  await signedPrint.close();
  // Their People headshot on their account button, as a board member's is (the picture served here, not by Cloudflare;
  // the CSP set aside, since headshots are same-origin on sunshineonaranneyday.com but not on localhost)
  const servePhoto = (req) => (/\/cdn-cgi\/imagedelivery\//.test(req.url()) ? req.respond({ status: 200, contentType: 'image/png', body: PNG }) : req.continue());
  await jane.setBypassCSP(true);
  await jane.setRequestInterception(true);
  jane.on('request', servePhoto);
  await jane.goto(`${SITE}/admin/board/`, { waitUntil: 'networkidle0' });
  ok(await jane.waitForFunction(() => { const i = document.querySelector('.bp-me__btn img.bp-avatar'); return !!i && /\/team\/jane-doe\//.test(i.src) && i.complete && i.naturalWidth > 0; }, { timeout: 8000 }).then(() => true, () => false), 'the founder’s account button shows their headshot from People');
  jane.off('request', servePhoto);
  await jane.setRequestInterception(false);
  await jane.setBypassCSP(false);
  ok(await jane.waitForSelector('#makeovers .bk-col', { timeout: 8000 }).then(() => true, () => false) && /From JobTread/.test(await text(jane)) && !/the way board members do/.test(await text(jane)), 'the founder sees the board page as the board does, with no banner saying so');
  ok(await jane.evaluate(() => !document.querySelector('.bp-choice') && !document.querySelector('.bp-sign')) && !/Read and sign/.test(await text(jane)), 'with nothing to answer or sign for anyone (no “Read and sign” on Home)');
  await jane.goto(`${SITE}/admin/board/#/documents`, { waitUntil: 'networkidle0' });
  ok(await waitText(jane, /What the board signs\s*Each board member signs these once a year\.[\s\S]*Board Member Expectations[\s\S]*board members ha(?:s|ve) signed/) && !/You’ve signed/.test(await text(jane)), 'the founders see the papers the board signs, with how many have, and no “you’ve signed”');
  await jane.goto(`${SITE}/admin/board/`, { waitUntil: 'networkidle0' });
  await jane.waitForSelector('.bp-me__btn');
  await jane.click('.bp-me__btn');
  ok(await jane.evaluate(() => [...document.querySelectorAll('.bp-menu a')].some((a) => a.getAttribute('href') === '/admin/#board' && /Back to the Board area/.test(a.textContent))), 'the account menu has the way back to the Board area');

  // ─── Presenting the meeting (board/screen.js ?present): the window moves itself, a document page by page ───
  console.log('Presenting the meeting on the screen');
  await jane.goto(`${SITE}/admin/#board/meeting/${meetingId}`, { waitUntil: 'networkidle0' });
  await jane.reload({ waitUntil: 'networkidle0' });
  // Present opens the presentation in its own window; nothing is run from Board
  const presented = new Promise((res) => browser.once('targetcreated', res));
  await clickText(jane, '.bm-top__bar button', /^(Present|Preview the presentation)$/);
  const presTarget = await Promise.race([presented, sleep(5000).then(() => null)]);
  ok(!!presTarget && /\/admin\/board\/\?present#\/meetings\/[^/]+\/screen$/.test(presTarget.url()), `Present opens the presentation in its own window (${presTarget?.url().replace(SITE, '')})`);
  await (await presTarget?.page())?.close();
  const scr = await tab(FOUNDER, 1280);
  await scr.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await scr.goto(`${SITE}/admin/board/?present#/meetings/${meetingId}/screen`, { waitUntil: 'networkidle0' });
  ok(await scr.waitForSelector('.bs-cover', { timeout: 8000 }).then(() => true, () => false), 'the presentation opens on the cover');
  ok(await scr.evaluate(() => !document.querySelector('.bp-top') && /Committee reports/.test(document.querySelector('.bs-outline')?.textContent || '') && /^1 of \d+$/.test(document.querySelector('.bs-step__n')?.textContent || '')), 'full window, no board page header; the agenda’s parts on the cover; 1 of the slides');
  ok(await scr.evaluate(() => !document.querySelector('.bs-timer')), 'no part timer before the meeting’s day');
  await shot(scr, '20-screen-cover');
  const screenFoot = () => scr.evaluate(() => document.querySelector('.bs-foot__what')?.textContent || '');
  let hops = 0;
  // Nothing moves from stop to stop: the screen's stage and its rail (whatever the words in them), and who has the floor
  // (said along the top on every slide it's anyone's, an item's or a document's, never drawn in the slide again)
  // and a slide's big title that fits its lines is drawn whole, its last line's g, y and p never cut by the clamp
  // (screen.js useFit data-whole; Peter: "the g and y are cut off!")
  const spots = { stage: new Set(), rail: new Set(), floor: new Set(), floorOn: 0, inSlide: [], titles: 0, cut: [], small: [] };
  let roll = null;
  const note = async () => {
    const at = await scr.evaluate(() => { const f = document.querySelector('.bs-top > .bs-floor')?.getBoundingClientRect(); return { stage: JSON.stringify(document.querySelector('.bs-stage')?.getBoundingClientRect()), rail: document.querySelector('.bs-rail__parts li:last-child')?.getBoundingClientRect().right, faces: document.querySelectorAll('.bs-faces__one').length, title: document.querySelector('.bs-item__title')?.textContent || '', count: document.querySelector('.bs-roll')?.textContent || '', floor: f ? `${Math.round(f.left)},${Math.round(f.top)}` : '', kind: [...document.querySelector('.bs').classList].find((c) => c.startsWith('bs--')) || '', inSlide: document.querySelectorAll('.bs-stage .bs-who, .bs-stage .bs-item__aside .bs-face, .bs-stage .bs-item__lead .bs-face, .bs-stage .bs-chapter__by').length, titles: document.querySelectorAll('.bs-stage .bs-fit').length, cut: [...document.querySelectorAll('.bs-stage .bs-fit')].filter((t) => getComputedStyle(t).overflow !== 'visible').map((t) => t.textContent.trim().slice(0, 40)), small: [...document.querySelectorAll('.bs-stage .bs-fit')].filter((t) => { const f = Number(t.style.getPropertyValue('--tfit') || 1); if (f >= 1) return false; t.style.setProperty('--tfit', String(Math.min(1, f + 0.05))); const fits = t.scrollHeight <= parseFloat(getComputedStyle(t).lineHeight) * 3.5; t.style.setProperty('--tfit', String(f)); return fits; }).map((t) => t.textContent.trim().slice(0, 40)) }; });
    spots.stage.add(at.stage); spots.rail.add(at.rail);
    if (at.floor) { spots.floor.add(at.floor); spots.floorOn += 1; }
    if (at.inSlide) spots.inSlide.push(`${at.kind} ${at.title}`);
    spots.titles += at.titles; spots.cut.push(...at.cut); spots.small.push(...at.small);
    if (at.title === 'Roll call') roll = at;
  };
  // An item with a report shows it, fitted to the screen (screen.js ReportFit): Governance's, and Sam's under the money
  const reportStops = new Map();
  const noteReport = async () => {
    const r = await scr.evaluate(() => { const b = document.querySelector('.bs-report__body'); return b ? { title: document.querySelector('.bs-item__title')?.textContent, text: b.innerText.replace(/\s+/g, ' ').trim().slice(0, 60), fits: b.scrollHeight <= b.clientHeight + 1 && b.scrollWidth <= b.clientWidth + 1 } : null; });
    if (r && !reportStops.has(r.title)) { reportStops.set(r.title, r); await shot(scr, `21-screen-report-${r.title.toLowerCase()}`); }
  };
  while (hops < 25 && !/Balance sheet financials/.test(await screenFoot())) { await note(); await noteReport(); await scr.keyboard.press('ArrowRight'); await sleep(350); hops += 1; }
  await note();
  const govShown = reportStops.get('Governance');
  const finShown = reportStops.get('Financial');
  ok(/^Highlights Insurance renewal/.test(govShown?.text || '') && govShown.fits && /^Cash is up 12%/.test(finShown?.text || '') && finShown.fits, `the screen shows an item’s report, all of it fitting (${JSON.stringify([...reportStops.values()])})`);
  ok(spots.stage.size === 1 && spots.rail.size === 1, `the screen’s stage and rail keep their size and place on every slide (${spots.stage.size} stages, ${spots.rail.size} rails)`);
  ok(spots.titles >= 5 && !spots.cut.length, `every slide's title is drawn whole, a g's or a y's tail never cut by its clamp (${spots.titles} titles${spots.cut.length ? `; cut: ${spots.cut.join(' | ')}` : ''})`);
  ok(!spots.small.length, `and no title is set smaller than its lines need (a g's tail isn't a line more)${spots.small.length ? ` (${spots.small.join(' | ')})` : ''}`);
  ok(spots.floorOn >= 3 && spots.floor.size === 1 && !spots.inSlide.length, `who has the floor sits in one place along the top on every slide it shows on, and no slide draws its presenters again (${spots.floorOn} slides, spots ${[...spots.floor].join(' | ')}${spots.inSlide.length ? `; in the slide on ${spots.inSlide.join(', ')}` : ''})`);
  ok(roll && roll.faces === 3 && /3\s*on the board/.test(roll.count), `the roll call shows the board’s faces, everyone on the meeting’s list (${JSON.stringify(roll)})`);
  ok(await scr.waitForFunction(() => /Financial.*Balance sheet financials.*Pages 1–2 of 2/.test(document.querySelector('.bs-foot__what')?.textContent || ''), { timeout: 8000 }).then(() => true, () => false), '→ steps the screen through the items to the Financial item’s statement, its two pages on one stop');
  ok(await scr.waitForFunction(() => {
    const sheets = [...document.querySelectorAll('.bs-page__sheet .bs-book.is-open > .bs-sheet')].map((e) => e.getBoundingClientRect());
    return sheets.length === 2 && [...document.querySelectorAll('.bs-page__sheet canvas')].every((c) => c.width > 0) && Math.abs(sheets[0].height - sheets[1].height) < 2 && Math.abs(sheets[0].right - sheets[1].left) < 2 && sheets[0].height > innerHeight * 0.6;
  }, { timeout: 8000 }).then(() => true, () => false), 'the pages drawn whole, side by side as an open book, the same size, as tall as the stage allows');
  ok(await scr.evaluate(() => /Sam Ortiz has the floor/.test(document.querySelector('.bs-floor')?.innerText || '')), 'with who presents it, along the top');
  await shot(scr, '21-screen-document');
  await scr.keyboard.press('PageDown');
  ok(await scr.waitForFunction(() => !/Pages 1–2 of 2/.test(document.querySelector('.bs-foot__what')?.textContent || ''), { timeout: 3000 }).then(() => true, () => false), 'a clicker’s Page Down: on past the statement (both its pages were up)');
  await scr.keyboard.press('PageUp');
  ok(await scr.waitForFunction(() => /Pages 1–2 of 2/.test(document.querySelector('.bs-foot__what')?.textContent || ''), { timeout: 3000 }).then(() => true, () => false), 'Page Up: back to its two pages');
  await scr.keyboard.press('ArrowLeft');
  // The money fills its own slide, so the treasurer's report is a slide of its own after it (./board-shared.js deckOf)
  const back = await scr.waitForSelector('.bs.bs--report', { timeout: 3000 }).then(() => scr.evaluate(() => ({ title: document.querySelector('.bs-item__title')?.textContent || '', who: document.querySelector('.bs-top > .bs-floor')?.innerText || '', report: !!document.querySelector('.bs-stage .bs-report'), foot: document.querySelector('.bs-foot__what')?.textContent || '' })), () => null);
  ok(back && /Financial/.test(back.title) && /Sam Ortiz/.test(back.who) && back.report && /Financial\s*·\s*Report/.test(back.foot), `← the treasurer’s report, a slide of its own after the money (${JSON.stringify(back)})`);
  await scr.keyboard.press('ArrowLeft');
  ok(await scr.waitForSelector('.bs--item .bs-item', { timeout: 3000 }).then(() => true, () => false) && await scr.evaluate(() => /Financial/.test(document.querySelector('.bs-item__title')?.textContent || '') && /Sam Ortiz has the floor/.test(document.querySelector('.bs-top > .bs-floor')?.innerText || '') && !document.querySelector('.bs-stage .bs-report')), '← back to the item, who presents it along the top (its report on the next slide, not here too)');
  ok(await scr.waitForFunction(() => [...document.querySelectorAll('.bs-shelf > li')].some((li) => /Balance sheet financials/.test(li.textContent) && !!li.querySelector('.bs-shelf__cover > *')), { timeout: 6000 }).then(() => true, () => false), 'its documents coming up, each by its first page');
  await shot(scr, '22-screen-item');
  // The makeovers item on the screen: the stages as one track toward the reveal, every family's card in view
  while (hops < 60 && !(await scr.$('.bs-pipe'))) { await scr.keyboard.press('ArrowRight'); await sleep(200); hops += 1; }
  ok(await scr.waitForSelector('.bs-pipe .bs-pipe__card', { timeout: 4000 }).then(() => true, () => false) && await scr.evaluate(() => {
    const cards = [...document.querySelectorAll('.bs-pipe__card')].map((c) => c.getBoundingClientRect());
    const stages = [...document.querySelectorAll('.bs-pipe__track > li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim());
    // (each photo a real height, one height in a row: a card that's a size container drops out of the shared rows)
    const photos = [...document.querySelectorAll('.bs-pipe__card:not(.is-quiet) .bs-pipe__photo')].map((p) => p.getBoundingClientRect());
    const level = photos.every((p) => p.height > innerHeight * 0.08 && photos.every((q) => Math.abs(q.top - p.top) > 2 || Math.abs(q.height - p.height) < 2));
    return cards.length && level && cards.every((r) => r.bottom <= innerHeight && r.right <= innerWidth) && /Maya/.test(document.querySelector('.bs-pipe').textContent) && stages[0].startsWith('1') && /Build/.test(stages.at(-2)) && stages.at(-1) === 'Reveal';
  }), 'the makeovers item: the stages with their counts toward the reveal (the line’s end, past the last stage), every card in view, its photos level');
  await shot(scr, '22b-screen-makeovers');
  // B blanks the room's screen; a key brings it back. A reload comes back to the same slide
  await scr.keyboard.press('b');
  ok(await scr.waitForSelector('.bs-blank', { timeout: 2000 }).then(() => true, () => false), 'B blanks the screen');
  await scr.keyboard.press('b');
  ok(!(await scr.$('.bs-blank')), 'and B again brings it back');
  const slideNow = () => scr.evaluate(() => `${document.querySelector('.bs')?.className.match(/bs--(\w+)/)?.[1]}|${document.querySelector('.bs-item__title, .bs-foot__what')?.textContent || ''}`);
  const was = await slideNow();
  await scr.reload({ waitUntil: 'networkidle0' });
  await scr.waitForSelector('.bs-steps', { timeout: 8000 }).catch(() => {});
  await sleep(800);
  ok(await slideNow() === was, `a reload keeps the slide (${was} → ${await slideNow()})`);
  await scr.keyboard.press('End');
  ok(await scr.waitForSelector('.bs-end', { timeout: 5000 }).then(() => true, () => false), 'End: the close');
  await shot(scr, '25-screen-end');
  ok(!(await meetingNow(jane, meetingId)).live.startedAt, 'presenting never puts anything on the meeting: nothing started, nothing saved');
  await scr.close();
  // A long part, one person presenting all of it (the Nov 5 automation update had 11): its card names them once and
  // fits above the rail on a 720p screen; a part with different presenters keeps them on each row
  {
    const long = await saveMeeting(DB, cleanMeeting({ date: day(9), start: '08:00', end: '10:00', shared: false, sections: [
      { title: 'Committee reports', items: [{ title: 'Governance', presenter: 'Alex Rivera', who: ['alex-rivera'] }, { title: 'Financial', presenter: 'Sam Ortiz', who: ['sam-ortiz'] }] },
      { title: 'Automation and technology update', minutes: 25, items: Array.from({ length: 11 }, (_, i) => ({ title: `Something that runs itself, number ${i + 1}`, presenter: 'Jane', who: ['jane-doe'] })) },
    ] }), { by: FOUNDER });
    const card = await tab(FOUNDER, 1280);
    await card.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
    const cardOf = async (si) => {
      await card.goto(`${SITE}/admin/board/?present&at=${encodeURIComponent(`section:${long.sections[si].id}`)}#/meetings/${long.id}/screen`, { waitUntil: 'networkidle0' });
      await card.waitForSelector('.bs-chapter', { timeout: 8000 }).catch(() => {});
      await sleep(500);
      return card.evaluate(() => { const st = document.querySelector('.bs-stage').getBoundingClientRect(); const c = document.querySelector('.bs-chapter'); const r = c.getBoundingClientRect(); const labs = [...c.querySelectorAll('.bs-chapter__t')].map((t) => Math.round(t.getBoundingClientRect().left)); return { rows: c.querySelectorAll('.bs-chapter__items li').length, inside: r.top >= st.top - 1 && r.bottom <= st.bottom + 1, by: document.querySelector('.bs-top > .bs-floor')?.innerText || '', perRow: c.querySelectorAll('.bs-chapter__who').length, lined: new Set(labs).size === (c.querySelector('.bs-chapter__items.is-cols') ? 2 : 1) }; });
    };
    const one = await cardOf(1);
    ok(one.rows === 11 && one.inside && /Jane Doe/.test(one.by) && one.perRow === 0 && one.lined, `a part of 11 items by one presenter: named once, along the top as the floor's, its titles in line (two columns past seven), all of it above the rail (${JSON.stringify(one)})`);
    await shot(card, '25b-screen-long-part');
    const mixed = await cardOf(0);
    ok(mixed.rows === 2 && mixed.inside && !mixed.by && mixed.perRow === 2, `a part with different presenters keeps each one on its row (${JSON.stringify(mixed)})`);
    await card.close();
    await DB.prepare('DELETE FROM board_meetings WHERE id = ?').bind(long.id).run();
  }
  // A short report that is only its points (the Nov 5 automation update's): a card per point filling the slide, each
  // figure in yellow, a hyphenated word whole, the words large, "1 of 3" by the part's name; a report with a heading is
  // drawn whole as before. The board page names the one presenter on the part, once, and their own report by its date
  {
    const pts = await saveMeeting(DB, cleanMeeting({ date: day(10), start: '08:00', end: '10:00', shared: false, sections: [
      { title: 'Automation and technology update', minutes: 25, items: [
        { title: 'Applications run themselves', presenter: 'Jane', who: ['jane-doe'], report: '- Families apply on our website, in English or Spanish\n- Approving one creates the job and its kid page\n- 22 families are waiting for 2027 applications to open' },
        { title: 'Job costs and trade partners', presenter: 'Jane', who: ['jane-doe'], report: '- Every open makeover has a live cost sheet\n- Subs sign up online with their W-9, insurance and bank details\n- Bills wait until a sub’s paperwork is current\n- The insurance audit is a ready report' },
        { title: 'The board page', presenter: 'Jane', who: ['jane-doe'], report: '### Highlights\n\nEvery meeting since 2013, with its minutes and packets.' },
      ] },
    ] }), { by: FOUNDER });
    const its = pts.sections[0].items;
    const slide = await tab(FOUNDER, 1280);
    const look = async (it, w, h) => {
      await slide.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
      await slide.goto(`${SITE}/admin/board/?present&at=${encodeURIComponent(it.id)}#/meetings/${pts.id}/screen`, { waitUntil: 'networkidle0' });
      await slide.waitForSelector('.bs-item', { timeout: 8000 }).catch(() => {});
      await sleep(900);
      return slide.evaluate(() => {
        const st = document.querySelector('.bs-stage').getBoundingClientRect();
        const cards = [...document.querySelectorAll('.bs-pt')].map((c) => c.getBoundingClientRect());
        const t = document.querySelector('.bs-pt__t');
        return { cards: cards.length, inside: cards.every((r) => r.top >= st.top - 1 && r.bottom <= st.bottom + 1 && r.right <= st.right + 1),
          px: t ? parseFloat(getComputedStyle(t).fontSize) : 0, figs: [...document.querySelectorAll('.bs-pt__fig')].map((x) => x.textContent),
          whole: [...document.querySelectorAll('.bs-pt__w')].map((x) => x.textContent), of: document.querySelector('.bs-eyebrow__of')?.textContent || '',
          cut: !!document.querySelector('.bs-report__more'), drawnWhole: !!document.querySelector('.bs-report__body') };
      });
    };
    for (const [w, h] of [[1280, 720], [1920, 1080]]) {
      const a = await look(its[0], w, h);
      ok(a.cards === 3 && a.inside && a.px >= h * 0.03 && a.figs.join() === '22,2027' && a.of === '1 of 3' && !a.drawnWhole, `${w}×${h}: a report of three points is three cards, in view, the words large and its figures picked out (${JSON.stringify(a)})`);
      const b = await look(its[1], w, h);
      ok(b.cards === 4 && b.inside && b.whole.includes('W-9') && b.of === '2 of 3', `${w}×${h}: four points two by two, “W-9” never split over a line (${JSON.stringify(b)})`);
      if (w === 1920) await shot(slide, '25c-screen-points');
    }
    const c = await look(its[2], 1280, 720);
    ok(c.cards === 0 && c.drawnWhole && !c.cut && c.of === '3 of 3', `a report with a heading is drawn whole, as before (${JSON.stringify(c)})`);
    await slide.close();
    const page = await tab(FOUNDER, 1440);
    await page.goto(`${SITE}/admin/board/#/meetings/${pts.id}`, { waitUntil: 'networkidle0' });
    await waitText(page, /Applications run themselves/);
    const bp = await page.evaluate(() => {
      const sec = [...document.querySelectorAll('.bp-agsec')].find((x) => /Automation and technology update/.test(x.textContent));
      return { onPart: sec?.querySelectorAll('.bp-agsec__head .bp-pres li').length, onItems: sec?.querySelectorAll('.bp-agitem .bp-pres li').length, by: [...(sec?.querySelectorAll('.bp-report__by') || [])].map((x) => x.textContent.replace(/\s+/g, ' ').trim()) };
    });
    ok(bp.onPart === 1 && bp.onItems === 0 && bp.by.length === 3 && bp.by.every((x) => /^Report\s*\w{3} \d+/.test(x) && !/\bby\b/.test(x)), `the board page names the part’s one presenter once, and their own reports by date only (${JSON.stringify(bp)})`);
    // Invited but not shared yet (the live Nov 5 meeting, Nov 2 2026): the board has its when and where only, and the
    // founder's look at it (Board's Board page preview, "See it as the board will") is still the agenda, never the stub
    await patchMeeting(DB, pts.id, (cur) => ({ ...cur, invite: { eventId: 'evt-pts', organizer: 'holly@soardcharity.com', sentAt: new Date().toISOString(), replies: {} } }), { by: FOUNDER });
    await page.goto(`${SITE}/admin/board/?preview#/meetings/${pts.id}`, { waitUntil: 'networkidle0' });
    const pvLook = await page.waitForSelector('.bp-agitem', { timeout: 8000 }).then(() => page.evaluate(() => ({ items: document.querySelectorAll('.bp-agitem').length, stub: /isn’t posted yet/.test(document.body.textContent) })), () => page.evaluate(() => ({ items: 0, stub: /isn’t posted yet/.test(document.body.textContent) })));
    ok(pvLook.items === 3 && !pvLook.stub, `invited, not shared: Board’s preview of the board page is its agenda, not “The agenda isn’t posted yet” (${JSON.stringify(pvLook)})`);
    await page.close();
    const member = await tab(MEMBER, 1440);
    await member.goto(`${SITE}/admin/board/#/meetings/${pts.id}`, { waitUntil: 'networkidle0' });
    ok(await waitText(member, /isn’t posted yet/) && await member.evaluate(() => !document.querySelector('.bp-agitem') && !/Applications run themselves/.test(document.body.textContent)), 'and a board member has its when and where only, no agenda');
    // Held, on its first item: the board page's "Now discussing" says who has the floor once, and the report they wrote
    // by its label only, never "by" them again under it
    await patchMeeting(DB, pts.id, (cur) => ({ ...cur, shared: true, live: { ...(cur.live || {}), startedAt: new Date().toISOString(), endedAt: '', itemId: its[0].id, screen: 'item' } }), { by: FOUNDER });
    await member.reload({ waitUntil: 'networkidle0' });
    const nowCard = await member.waitForSelector('.bp-now .bp-now__report', { timeout: 10000 }).then(() => member.evaluate(() => ({ title: document.querySelector('.bp-now__title')?.textContent || '', floor: document.querySelector('.bp-now')?.textContent.includes('Jane Doe') || false, by: document.querySelector('.bp-now__report .bp-report__by')?.textContent.replace(/\s+/g, ' ').trim() || '' })), async () => { await shot(member, '25d-now-card-missing'); return { debug: await member.evaluate(() => (document.querySelector('main') || document.body).innerText.slice(0, 400)) }; });
    ok(nowCard && /Applications run themselves/.test(nowCard.title) && nowCard.floor && nowCard.by === 'Report', `held: “Now discussing” names who has the floor, and their own report says “Report”, not “by” them again (${JSON.stringify(nowCard)})`);
    await member.close();
    await DB.prepare('DELETE FROM board_meetings WHERE id = ?').bind(pts.id).run();
  }
  // Many presenting one item, the meeting's clock running and "Not on the board page yet" beside it (the top bar at its
  // fullest): the floor says one by name, two by first names, three and more the first and how many more ("Alex & 4
  // more", every name in its title), in the longest wording that fits (screen.js fitFloor), never cut, no word broken
  // over two lines, clear of the logo and the clock. A phone gives it a row of its own, there on every slide, so the
  // stage keeps its place; and the cover's faces fit a phone
  {
    const many = await saveMeeting(DB, cleanMeeting({ date: day(0), start: '08:00', end: '09:00', shared: false, sections: [
      { title: 'Committee reports', minutes: 20, items: [
        { title: 'Three committees', who: ['jane-doe', 'pat-lee', 'alex-rivera'], report: '- Governance met twice\n- Finance closed the year' },
        { title: 'Every committee at once', presenter: 'Alex Rivera, Sam Ortiz, Kim Park, Tom Reedington & Nia Fordham', report: '- One thing\n- Another thing' },
        { title: 'Two long names', presenter: 'Christopher Montgomery & Alexandra Whitfield', report: '- One thing\n- Another thing' },
        // (and a title past three lines on a phone: read whole there, its stage scrolls; never cut short with …)
        { title: 'Personal Best/Business Best/Sunshine Bragging Rights (What have you done since the last meeting)', who: ['jane-doe'], report: '- One thing\n- Another thing' },
        // (and one far past three lines even at its smallest, a title card's: a TV cuts it at a word with …, its whole
        // words its name)
        { title: 'The reveal calendar for spring, the trade partner agreements, the store lease and its renewal terms, the gala sponsorship levels, the golf classic, the volunteer kickoff and anything else we bring up', who: ['jane-doe'] },
      ] },
    ] }), { by: FOUNDER });
    const look = await tab(FOUNDER, 1280);
    const want = [/^Jane & 2 more( have the floor)?$/, /^Alex & 4 more( have the floor)?$/, /^Christopher & Alexandra( have the floor)?$/, /^Jane Doe( has the floor)?$/, /^Jane Doe( has the floor)?$/];
    const all = [/Alex Rivera/, /Nia Fordham/, /Alexandra Whitfield/, /Jane Doe/, /Jane Doe/];
    const seen = [];
    for (const [w, h] of [[1920, 1080], [1280, 720], [1024, 768], [768, 1024], [600, 960], [390, 844], [360, 740], [320, 568]]) {
      await look.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: w < 600, hasTouch: w < 600 });
      await look.goto(`${SITE}/admin/board/?present&at=cover#/meetings/${many.id}/screen`, { waitUntil: 'networkidle0' });
      await look.waitForSelector('.bs-cover__faces', { timeout: 8000 }).catch(() => {});
      await sleep(300);
      const cover = await look.evaluate(() => { const st = document.querySelector('.bs-stage')?.getBoundingClientRect(); const fc = document.querySelector('.bs-cover__faces'); return { top: Math.round(st?.top ?? -1), fits: !!fc && fc.scrollWidth <= fc.clientWidth + 1 && fc.getBoundingClientRect().right <= st.right + 1 }; });
      if (!cover.fits) seen.push(`${w}×${h} the cover's faces run off the screen`);
      for (const [k, it] of many.sections[0].items.entries()) {
        await look.goto(`${SITE}/admin/board/?present&at=${encodeURIComponent(it.id)}#/meetings/${many.id}/screen`, { waitUntil: 'networkidle0' });
        await look.waitForSelector('.bs-top > .bs-floor', { timeout: 8000 }).catch(() => {});
        await sleep(300);
        const f = await look.evaluate(() => {
          const c = document.querySelector('.bs-top > .bs-floor');
          if (!c) return null;
          const t = c.querySelector(':scope > span:last-child');
          const over = () => t.scrollWidth > t.clientWidth + 1 || c.scrollWidth > c.clientWidth + 1;
          const split = [];
          const walk = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
          for (let n; (n = walk.nextNode());) for (const m of n.data.matchAll(/\S+/g)) { const r = document.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length); if (new Set([...r.getClientRects()].filter((x) => x.width).map((x) => Math.round(x.top))).size > 1) split.push(m[0]); }
          const box = c.getBoundingClientRect();
          const clear = ['.bs-brand', '.bs-top__right'].every((s) => { const o = document.querySelector(s).getBoundingClientRect(); return box.right <= o.left + 1 || box.left >= o.right - 1 || box.bottom <= o.top + 1 || box.top >= o.bottom - 1; });
          const fit = Number(c.dataset.fit || 0);
          const cut = over();
          // The wording before this one didn't fit: it never steps down further than it has to
          let needed = true;
          if (fit > 0) { c.dataset.fit = String(fit - 1); needed = over(); c.dataset.fit = String(fit); }
          const h1 = document.querySelector('.bs-stage .bs-fit');
          return { words: t.innerText.replace(/\s+/g, ' ').trim(), all: t.title, fit, cut, needed, split, clear, clock: !!document.querySelector('.bs-top .bs-timer'), stage: Math.round(document.querySelector('.bs-stage').getBoundingClientRect().top), titleWhole: !h1 || getComputedStyle(h1).overflow === 'visible', titleCut: h1 ? { dots: h1.textContent.endsWith('…'), named: h1.getAttribute('aria-label') || '', lines: Math.round(h1.scrollHeight / parseFloat(getComputedStyle(h1).lineHeight)) } : null };
        });
        // the long one: a TV's (its stage doesn't scroll) three lines ending … and named whole; a phone's every word
        const longOk = k < 4 || (w > 900 ? f?.titleCut?.dots && f.titleCut.lines <= 3 && f.titleCut.named === it.title : f?.titleCut && !f.titleCut.dots && !f.titleCut.named);
        if (!(f && f.clock && want[k].test(f.words) && all[k].test(f.all) && !f.cut && f.needed && !f.split.length && f.clear && f.stage === cover.top && f.titleWhole && longOk)) seen.push(`${w}×${h} ${it.title}: ${JSON.stringify({ ...f, coverTop: cover.top })}`);
      }
    }
    ok(!seen.length, `many presenting, the clock running: the top bar says “Jane & 2 more”, “Alex & 4 more”, “Christopher & Alexandra”, never cut or broken mid-word, clear of the clock, the stage in its place, a long title whole (on a TV, past three lines, cut at a word with …), on eight screens${seen.length ? ` (${seen.join('; ')})` : ''}`);
    await look.close();
    await DB.prepare('DELETE FROM board_meetings WHERE id = ?').bind(many.id).run();
  }

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
  const paperReports = await alexPrint.evaluate(() => [...document.querySelectorAll('.bpp-report')].map((r) => r.innerText.replace(/\s+/g, ' ').trim()));
  ok(paperReports.length === 2 && /^Report by Jane Doe\s*Highlights\s*Insurance renewal is on track\s*Broker sends/.test(paperReports[0]) && /^Report by Sam Ortiz\s*Cash is up 12%/.test(paperReports[1]), `the reports on paper, under their items (${JSON.stringify(paperReports)})`);
  await alexPrint.pdf({ path: join(OUT, '26-print-it-all.pdf'), format: 'letter', printBackground: true });
  await alexPrint.evaluate(() => dispatchEvent(new Event('afterprint')));
  ok(await alexPrint.waitForFunction(() => !document.querySelector('.bpp') && !document.querySelector('.bp-printing'), { timeout: 5000 }).then(() => true, () => false), 'afterwards it’s all taken away again');
  await alexPrint.close();

  // The meeting on a phone: one page, the line saying where it stands first, then the agenda (the slides themselves
  // are a button away at the top); a held meeting opens on its minutes
  const phone = await tab(FOUNDER, 390);
  const heldPhone = await saveMeeting(DB, cleanMeeting({ date: day(-2), start: '08:00', end: '10:00', shared: true, sections: [{ title: 'Call to order', items: [{ title: 'Roll call' }] }] }), { by: FOUNDER });
  for (const [s, id] of [['ahead', meetingId], ['held', heldPhone.id]]) {
    // (each opened as a person comes to it, from the top: the meeting before was scrolled about in this tab, and a
    // reload would bring that scroll back)
    await phone.evaluate(() => scrollTo(0, 0));
    await phone.goto(`${SITE}/admin/#board/meeting/${id}`, { waitUntil: 'networkidle0' });
    await phone.reload({ waitUntil: 'networkidle0' });
    await waitText(phone, /All meetings/);
    ok(await overflow(phone) <= 0, `a ${s} meeting’s page fits a phone`);
    const firsts = await phone.evaluate(() => [...document.querySelectorAll('.bm-path, .bm-work, .bm-row, .bm-files')].filter((x) => x.offsetHeight).sort((p, q) => p.getBoundingClientRect().top - q.getBoundingClientRect().top).slice(0, 2).map((x) => x.id || x.className.split(' ')[0]));
    ok(s === 'ahead' ? firsts.join() === 'bm-path,bm-work' : firsts[0] === 'bm-path' && /bm-row/.test(firsts[1] || ''), `a phone: the ${s} meeting opens on what's to do first (${firsts.join(' then ')})`);
    ok(await phone.evaluate(() => !document.querySelector('.agx-stage') || getComputedStyle(document.querySelector('.agx-stage')).display === 'none'), `a phone: the presentation panel steps aside (${s})`);
    if (s === 'held') {
      ok(await phone.evaluate(() => document.querySelector('.bm-present')?.textContent.trim()) === 'See the presentation', 'a meeting held: its slides to see again, never "Present"');
      ok(await phone.evaluate(() => { const c = document.querySelector('.bm-minutes'); return !!c && getComputedStyle(c).display !== 'flex' && c.scrollWidth <= c.clientWidth + 1; }), 'a phone: the minutes as the board will read them, top to bottom (never the screen tile’s row)');
    }
    if (s === 'ahead') {
      ok(/Kim Park has no email on file/.test(await phone.evaluate(() => document.querySelector('.bm-ready .bm-note')?.textContent || '')), 'Getting ready names the board member with no email, who gets no invite or email');
      // A phone: Who presents and the packet's Goes with, each over everything and in view
      for (const sel of ['.agx-item .bd-who .bd-pop__btn', '.bf-file .bd-goes .bd-pop__btn']) {
        await phone.evaluate((x) => { const b = document.querySelector(x); b?.scrollIntoView({ block: 'center' }); }, sel);
        await sleep(300);
        await phone.evaluate((x) => document.querySelector(x)?.click(), sel);
        await phone.waitForSelector('.bd-pop__panel', { timeout: 3000 }).catch(() => {});
        await sleep(200);
        const top = await onTop(phone);
        ok(top === true, `a phone: ${sel.includes('who') ? 'Who presents' : 'the packet’s Goes with'} over everything, in view (${top})`);
        ok(await phone.evaluate(() => document.activeElement?.tagName !== 'INPUT'), 'a phone: its search box waits for a tap, so the keyboard doesn’t cover the list');
        await shot(phone, sel.includes('who') ? 'who-presents-390' : 'packet-goes-with-390');
        await phone.keyboard.press('Escape');
        await sleep(200);
      }
    } else {
      ok(await phone.evaluate(() => { const c = document.querySelector('.bm-minutes'); return !!c && getComputedStyle(c).display !== 'flex' && c.scrollWidth <= c.clientWidth + 1; }), 'a phone: the minutes as the board will read them, top to bottom (never the screen tile’s row)');
    }
    await shot(phone, `13-meeting-${s}-390`);
  }
  await phone.goto(`${SITE}/admin/#board/members`, { waitUntil: 'networkidle0' });
  await waitText(phone, /The board/);
  ok(await overflow(phone) <= 0, 'Members fits a phone');
  await shot(phone, '14-members-390');

  // ─── Where the revenue came from, once QuickBooks is connected: its year so far as the hourly read keeps it
  // (_quickbooks.js sourcesOf: the income accounts by category), and last year's same days from the daily read ───
  console.log('Revenue by category');
  const yr = Number(day(0).slice(0, 4));
  const cat = (key, name, amount, accounts) => ({ key, name, amount, accounts });
  // $220K of the spending is the in-kind gifts used (_quickbooks.js nonCashOf), which SOARD's budget leaves out of expenses
  const ytdBooks = { year: String(yr), from: `${yr}-01-01`, through: day(0), revenue: 1876045, spent: 1200000, net: 676045, basis: 'Accrual', nonCash: 220000, sources: [
    cat('donations', 'Donations', 700000, ['Individual/Corporate Revenue']), cat('store', 'Store sales', 415000, ['Store Income', 'Store Discounts']), cat('gala', 'Gala', 400000, ['Gala Income']),
    cat('inkind', 'In kind', 220000, ['In-Kind Contribution']), cat('grants', 'Grants', 90000, ['Grant Revenue']), cat('account:golf classic', 'Golf Classic', 30000, ['Golf Classic Income']),
    cat('account:rent', 'Rent', 16000, ['Rent Income']), cat('account:interest', 'Interest', 5000, ['Interest Income']), cat('account:makeover', 'Makeover', 45, ['Makeover Revenue']),
  ], store: { sales: 415000, cost: 250000, profit: 165000, salesAccounts: ['Store Income', 'Store Discounts'], costAccounts: ['Store COGS'] } };
  const lastBooks = { year: String(yr - 1), through: `${yr - 1}${day(0).slice(4)}`, revenue: 1500000, expenses: 1100000, net: 400000, nonCash: 70000, full: { revenue: 2000000, expenses: 1500000, net: 500000, nonCash: 100000 },
    sources: [cat('donations', 'Donations', 400000), cat('store', 'Store sales', 830000), cat('gala', 'Gala', 200000), cat('inkind', 'In kind', 70000)],
    store: { sales: 830000, cost: 380000, profit: 450000, salesAccounts: ['Store Income'], costAccounts: ['Store COGS'] } };
  await DB.exec('CREATE TABLE IF NOT EXISTS books_link (id TEXT PRIMARY KEY, realm_id TEXT NOT NULL, company TEXT, fiscal_start INTEGER, access_token TEXT, access_expires TEXT, refresh_token TEXT NOT NULL, refresh_expires TEXT, ytd TEXT, read_at TEXT, tried_at TEXT, error TEXT, error_at TEXT, error_detail TEXT, told TEXT, linked_at TEXT, linked_by TEXT)');
  await DB.exec('CREATE TABLE IF NOT EXISTS books_daily (id TEXT PRIMARY KEY, data TEXT, day TEXT, read_at TEXT, tried_at TEXT, error TEXT)');
  const readAt = new Date().toISOString();
  await DB.prepare('INSERT OR REPLACE INTO books_link (id, realm_id, company, refresh_token, ytd, read_at, tried_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind('qbo', '9130350000000001', 'Example Charity', 'refresh-test', JSON.stringify(ytdBooks), readAt, readAt).run();
  // Month by month (_quickbooks.js plByMonth): this year through this month, last year all twelve, adding up near the year's own
  const thisMonth = Number(day(0).slice(5, 7));
  const monthly = {
    year: String(yr), lastYear: String(yr - 1),
    months: Array.from({ length: thisMonth }, (_, i) => ({ month: `${yr}-${String(i + 1).padStart(2, '0')}`, revenue: Math.round(1876045 / thisMonth), spent: Math.round(1200000 / thisMonth), nonCash: Math.round(220000 / thisMonth) })),
    last: Array.from({ length: 12 }, (_, i) => ({ month: `${yr - 1}-${String(i + 1).padStart(2, '0')}`, revenue: [90, 110, 150, 140, 160, 170, 150, 160, 180, 190, 240, 260][i] * 1000, spent: 125000, nonCash: 8000 })),
  };
  // The statements as of the books' close (_quickbooks.js statementRows): a line or two of each
  const statements = { asOf: day(-30), closed: false, priorAsOf: `${yr - 1}${day(-30).slice(4)}`,
    position: [{ k: 'head', label: 'Assets', d: 0 }, { k: 'total', label: 'Total Bank Accounts', d: 1, a: 608532, p: 655431 }, { k: 'total', label: 'TOTAL ASSETS', d: 0, a: 870767, p: 794994 }],
    activity: [{ k: 'head', label: 'Income', d: 0 }, { k: 'total', label: 'Total Income', d: 0, a: 1884217, p: 1909703 }, { k: 'sum', label: 'Net Income', d: 0, a: 189248, p: 176000 }] };
  // QuickBooks' budget against the actuals to the statements' day (_quickbooks.js budgetOf): the board's budget
  const budget = { name: 'Budget_FY26_P&L', from: `${yr}-01-01`, to: `${yr}-12-31`, asOf: day(-30), step: 1, monthly: true, months: 10, of: 12, totals: { revenue: 2000000, spending: 1500000, nonCash: 200000, nonCashIncome: 200000 },
    rows: [{ k: 'head', label: 'Income', d: 0 }, { k: 'acct', label: 'Individual/Corporate Revenue', d: 1, a: 700000, b: 500000, y: 600000 }, { k: 'total', label: 'Total Income', d: 0, a: 1884217, b: 1666667, y: 2000000 }, { k: 'sum', label: 'Net Income', d: 0, a: 189248, b: 150000, y: 180000 }] };
  await DB.prepare('INSERT OR REPLACE INTO books_daily (id, data, day, read_at, tried_at) VALUES (?, ?, ?, ?, ?)').bind('qbo', JSON.stringify({ shape: 3, day: day(0), lastYear: lastBooks, trailing: null, months: [], statements, functions: null, monthly, budget }), day(0), readAt, readAt).run();
  for (const width of [1440, 390]) {
    const money = await tab(MEMBER, width);
    await money.goto(`${SITE}/admin/board/#/`, { waitUntil: 'networkidle0' });
    ok(await money.waitForSelector('.bp-sum .bp-sum__mix', { timeout: 6000 }).then(() => true, () => false), `Home at ${width}: where the revenue came from, in the at-a-glance panel`);
    const key = await money.$$eval('.bp-sum__mix .bp-mix__key li', (l) => l.map((x) => x.textContent));
    // Five categories by name; Golf Classic at 1.6% folds in with rent, interest and the rest
    ok(JSON.stringify(key) === JSON.stringify(['Donations$700K37%', 'Store sales$415K22%', 'Gala$400K21%', 'In kind$220K12%', 'Grants$90K5%', 'Everything else$51K3%']), `Home at ${width}: donations, store sales, gala, in kind and grants, each with its amount and share; the small ones as Everything else (${JSON.stringify(key)})`);
    ok(await overflow(money) <= 0, `Home at ${width}: the categories fit`);
    // The year against QuickBooks' budget (the board's): revenue against the year's, expenses against its spending less the in kind
    const against = await money.evaluate(() => [...document.querySelectorAll('.bp-fig')].map((f) => f.textContent.replace(/\s+/g, ' ')).filter((t) => /revenue|expenses/i.test(t)).join(' | '));
    ok(/\$1.66M\s*92% of the \$1.8M budget/.test(against) && /75% of the \$1.3M budget/.test(against) && /Not counting \$220K in kind/.test(against.replace(/\u00a0/g, ' ')), `Home at ${width}: revenue and expenses against QuickBooks’ budget (${against})`);
    // The store (_quickbooks.js storeOf: the accounts named for it): its sales, cost of goods and the profit between,
    // each against last year by now; the profit says it's before the staff and rent the books keep with SOARD's
    const store = await money.$$eval('.bp-sum__store .bp-store li', (l) => l.map((x) => [...x.children].map((c) => c.textContent).join(' | ')));
    ok(JSON.stringify(store) === JSON.stringify([`Sales | $415K | ▼ 50% on ${yr - 1} by now`, `Cost of goods | $250K | ▼ 34% on ${yr - 1} by now`, `Profit before staff and rent | $165K | ▼ $285K on ${yr - 1} by now | 40% of sales (54% in ${yr - 1})`]), `Home at ${width}: the store's sales, cost of goods and profit, each against last year by now (${JSON.stringify(store)})`);
    await shot(money, `27a-store-home-${width}`);
    const spent = await money.evaluate(() => [...document.querySelectorAll('.bp-fig')].find((f) => /expenses/i.test(f.querySelector('.bp-fig__label')?.textContent || ''))?.textContent || '');
    ok(/\$980K/.test(spent) && /Not counting \$220K in kind$/.test(spent.replace(/\u00a0/g, ' ')), `Home at ${width}: the expenses as the budget counts them, without the in kind, saying so (${spent})`);
    if (width === 1440) {
      await money.hover('.bp-mix__seg:nth-child(2)');
      ok(await money.waitForFunction(() => /^Store sales\$415,000 · 22%\d{4}, same days: \$830,000 · ▼ 50%$/.test(document.querySelector('.bp-mix__tip')?.textContent || ''), { timeout: 2000 }).then(() => true, () => false), 'Home: over a part, its exact amount beside last year’s same days');
      await money.goto(`${SITE}/admin/board/#/financials`, { waitUntil: 'networkidle0' });
      ok(await money.waitForSelector('.bp-mixtable', { timeout: 6000 }).then(() => true, () => false), 'Financials: the categories as a table');
      const storeRows = await money.$$eval('.bp-storetable tbody tr', (r) => r.map((x) => x.textContent));
      ok(JSON.stringify(storeRows) === JSON.stringify(['SalesStore Income, Store Discounts$415,000$830,000▼ 50%', 'Cost of goodsStore COGS$250,000$380,000▼ 34%', 'Profit before staff and rent$165,000$450,000▼ $285K', 'Profit as a share of sales40%54%▼ 14 pts']) && /staff, rent and utilities are in SOARD’s shared costs/.test(await money.$eval('#store', (x) => x.textContent)), `Financials: the store beside last year, each line with its accounts, and why the profit is before staff and rent (${JSON.stringify(storeRows)})`);
      // The statements one at a time: the year's activities first, the financial position a tap away
      const firstStmt = await money.evaluate(() => [...document.querySelectorAll('#st-h ~ * .bp-stmt__title, .bp-latest .bp-stmt__title')].map((t) => t.textContent));
      await clickText(money, '.bp-stmts button', /^Financial position$/);
      ok(firstStmt.length === 1 && /^Statement of activities/.test(firstStmt[0]) && await money.waitForFunction(() => { const t = [...document.querySelectorAll('.bp-latest .bp-stmt__title')].map((x) => x.textContent); return t.length === 1 && t[0] === 'Statement of financial position' && /TOTAL ASSETS/.test(document.querySelector('.bp-latest .bp-stmt').textContent); }, { timeout: 2000 }).then(() => true, () => false), `Financials: one statement at a time, activities first, the position a tap away (${JSON.stringify(firstStmt)})`);
      await clickText(money, '.bp-stmts button', /^Budget$/);
      ok(await money.waitForFunction(() => { const t = document.querySelector('.bp-latest .bp-stmt__title')?.textContent || ''; const st = document.querySelector('.bp-latest .bp-stmt'); return /^Budget against actual, January 1 to /.test(t) && /ActualBudgetOver \(under\)/.test(st?.querySelector('thead')?.textContent || '') && /Total Income\$1,884,217\$1,666,667\+13%/.test(st?.textContent || '') && /Budget_FY26_P&L, through .*: 10 of its 12 months/.test(document.querySelector('.bp-latest .bp-stmts__when')?.textContent || ''); }, { timeout: 2000 }).then(() => true, () => false), 'Financials: QuickBooks’ budget against the actuals, a tap from the statements, saying which budget and through when');
      ok(/The budget: QuickBooks’ Budget_FY26_P&L\./.test(await money.$eval('#budget', (x) => x.textContent).catch(() => '')), 'Financials: the year against its budget names QuickBooks’ budget');
      await shot(money, '27b-budget-financials');
      const year = await money.evaluate(() => [...document.getElementById('by-h').closest('.bp-card').querySelectorAll('tbody tr')].map((r) => r.textContent));
      // Read down it adds up: revenue less the cash spent and the in kind used is the net
      ok(year[0] === 'Revenue$1,876,045$1,500,000▲ 25%' && year[1] === 'Cash expenses$980,000$1,030,000▼ 5%' && year[2] === 'In kind expenses (not cash)$220,000$70,000▲ 214%' && year[3] === 'Net$676,045$400,000▲ $276,045' && 1876045 - 980000 - 220000 === 676045, `Financials: the year so far splits the in kind from the cash expenses, and adds up to QuickBooks’ net (${JSON.stringify(year)})`);
      // % | $: the changes as percentages (the first time) or in dollars, one pick for the statements and the year so far
      await money.evaluate(() => [...document.querySelectorAll('.bp-chgas button')].find((x) => x.textContent.includes('$'))?.click());
      const inDollars = await money.waitForFunction(() => {
        const rows = [...document.getElementById('by-h').closest('.bp-card').querySelectorAll('tbody tr')].map((r) => r.textContent);
        return rows[0] === 'Revenue$1,876,045$1,500,000▲ $376,045' && rows[1] === 'Cash expenses$980,000$1,030,000▼ $50,000' && /Total Income\$1,884,217\$1,666,667\+\$217,550/.test(document.querySelector('.bp-latest .bp-stmt')?.textContent || '');
      }, { timeout: 3000 }).then(() => true, () => false);
      ok(inDollars && await money.evaluate(() => [...document.querySelectorAll('.bp-chgas')].every((g) => g.querySelector('[aria-pressed="true"]')?.textContent.includes('$'))), 'Financials: $ says the changes in dollars, in the statements and the year so far at once');
      await money.evaluate(() => [...document.querySelectorAll('.bp-chgas button')].find((x) => x.textContent.includes('%'))?.click());
      ok(await money.waitForFunction(() => /Total Income\$1,884,217\$1,666,667\+13%/.test(document.querySelector('.bp-latest .bp-stmt')?.textContent || ''), { timeout: 3000 }).then(() => true, () => false), 'and % back to percentages');
      {
        // and either way nothing on the page moves: the statements' columns and the year's table hold their places (each
        // look once the page's own entrances, a card's rise or a bar's growth, have ended)
        const settled = (pg) => pg.evaluate(() => Promise.race([Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, 3000))]));
        const places = async () => { await settled(money); return money.evaluate(() => [...document.querySelectorAll('main *')].filter((e) => !e.closest('.by-both > span') && !e.closest('svg') && !e.closest('.bp-chgas')).map((e) => { const r = e.getBoundingClientRect(); return `${e.tagName}.${e.className}@${[r.left, r.top + scrollY, r.width, r.height].map(Math.round)}`; })); };
        const a = await places();
        await money.evaluate(() => [...document.querySelectorAll('.bp-chgas button')].find((x) => x.textContent.includes('$'))?.click());
        await sleep(400);
        const b = await places();
        await money.evaluate(() => [...document.querySelectorAll('.bp-chgas button')].find((x) => x.textContent.includes('%'))?.click());
        await sleep(300);
        const off = a.length !== b.length ? [`${a.length} boxes, then ${b.length}`] : a.filter((x, i) => x !== b[i]);
        ok(!off.length, `Financials: % | $ changes the figures in place, nothing on the page moves${off.length ? ` (${off.slice(0, 3).join(' | ')})` : ''}`);
      }
      const rows = await money.$$eval('.bp-mixtable tbody tr', (r) => r.map((x) => x.textContent));
      ok(rows.length === 6 && rows[1] === 'Store salesStore Income, Store Discounts$415,00022%$830,000▼ 50%' && /^Everything elseGolf Classic, Rent, Interest, Makeover\$51,0453%\$0/.test(rows[5]) && rows[4] === 'GrantsGrant Revenue$90,0005%$0–', `Financials: each category with its accounts, beside last year’s same days (${JSON.stringify(rows)})`);
      await money.goto(`${SITE}/admin/board/#/meetings/${meetingId}`, { waitUntil: 'networkidle0' });
      ok(await money.waitForSelector('.bp-agitem .bp-agmix', { timeout: 6000 }).then(() => true, () => false), 'the meeting: its money item says where the revenue came from');
      ok(/^Sales\$415K/.test(await money.$eval('.bp-agitem .bp-agstore .bp-store li', (x) => x.textContent).catch(() => '')), 'the meeting: its money item has the store');
      await shot(money, '27-revenue-by-category-meeting');
      // The money item, from QuickBooks: revenue and expenses against last year month by month, the statements open, and
      // a statement QuickBooks draws only a quiet link (never its pages again)
      const yc = await money.evaluate(() => ({ charts: document.querySelectorAll('.bp-agitem .by-chart svg').length, files: document.querySelector('.bp-asfiles')?.textContent || '', tiles: [...document.querySelectorAll('.bp-agitem .bp-doctile__title')].map((x) => x.textContent), stmts: !!document.querySelector('.bp-agstmts .bp-stmt__table') }));
      ok(yc.charts === 2 && yc.stmts, `the money item: revenue and expenses against last year, month by month, and the statements, open (${JSON.stringify(yc)})`);
      // One axis for both (the bigger reads bigger), each drawn at the size it's shown, and the month it's in ends at
      // its day (two days into a month isn't a flat month)
      const axes = await money.evaluate(() => [...document.querySelectorAll('.bp-agitem .by-chart svg')].map((svg) => ({ ticks: [...svg.querySelectorAll('g text.by-axis')].map((t) => t.textContent).join('|'), w: Math.round(svg.getBoundingClientRect().width), vw: Math.round(svg.viewBox.baseVal.width), now: Number(svg.querySelector('circle.by-dot--now')?.getAttribute('cx')), label: Number(svg.querySelector('text.by-axis.is-now')?.getAttribute('x')), fs: getComputedStyle(svg.querySelector('text.by-axis')).fontSize })));
      ok(axes.length === 2 && axes[0].ticks === axes[1].ticks && axes.every((a) => Math.abs(a.w - a.vw) <= 2 && a.fs === '12px'), `revenue and expenses on one axis, drawn at their own size (${JSON.stringify(axes)})`);
      if (Number(day(0).slice(8, 10)) <= 20) ok(axes.every((a) => a.now < a.label - 10), `this year's line ends at its day in the month (${JSON.stringify(axes.map((a) => [a.now, a.label]))})`);
      ok(/Also as a file: Balance sheet financials/.test(yc.files) && !yc.tiles.some((x) => /Balance sheet/.test(x)), 'a statement QuickBooks draws isn’t a document tile again: a quiet link');
      await money.evaluate(() => document.querySelector('.bp-agitem .by-chart').scrollIntoView({ block: 'center' }));
      await money.hover('.bp-agitem .by-chart svg');
      ok(await money.waitForFunction(() => /\d{4} \$[\d,]+/.test(document.querySelector('.by-tip')?.textContent || ''), { timeout: 2000 }).then(() => true, () => false), 'over the chart: a month, this year beside last');
      await money.mouse.move(5, 5);
      await money.evaluate(() => document.querySelector('.bp-agitem .by-chart svg').focus());
      await money.keyboard.press('ArrowLeft');
      ok(await money.evaluate(() => /through|January|February|March|April|May|June|July|August|September|October|November|December/.test(document.querySelector('.by-tip')?.textContent || '')), 'and from the keyboard: ← → along the months');
      // Expenses as the figures have them (in kind and depreciation left out), and the month it's in read one way: this
      // year so far beside last year's same days, then last year's whole month (the point on its line)
      await money.evaluate(() => document.querySelectorAll('.bp-agitem .by-chart svg')[1].focus());
      const exp = await money.evaluate(() => ({ cap: document.querySelectorAll('.bp-agitem .by-cap')[1]?.textContent || '', tip: document.querySelector('.by-tip')?.innerText || '' }));
      const soFar = Number((exp.tip.match(new RegExp(`${yr} \\$([\\d,]+)`)) || [])[1]?.replace(/,/g, ''));
      ok(/in kind and depreciation left out/.test(exp.cap) && Math.abs(soFar - (1200000 - 220000)) < 50, `Expenses: the year so far without in kind, as the figures (${JSON.stringify(exp)})`);
      ok(new RegExp(`${yr - 1} by [A-Z][a-z]+ \\d+ \\$1,030,000`).test(exp.tip) && new RegExp(`${yr - 1}, all of [A-Z][a-z]+: \\$`).test(exp.tip), `the month it's in: last year's same days, then its whole month (${JSON.stringify(exp.tip)})`);
      // On a phone, a month's note stays inside the chart (July, in the middle, used to run off its left edge)
      if (thisMonth > 7) {
        const phone = await tab(MEMBER, 390);
        await phone.goto(`${SITE}/admin/board/#/meetings/${meetingId}`, { waitUntil: 'networkidle0' });
        await phone.waitForSelector('.bp-agitem .by-chart svg', { timeout: 6000 }).catch(() => null);
        await phone.evaluate(() => document.querySelector('.bp-agitem .by-chart svg')?.focus());
        for (let i = 0; i < thisMonth - 7; i++) await phone.keyboard.press('ArrowLeft');
        const fit = await phone.evaluate(() => { const ch = document.querySelector('.bp-agitem .by-chart'); if (!ch) return null; const c = ch.getBoundingClientRect(); const t = document.querySelector('.by-tip')?.getBoundingClientRect(); return t ? { month: document.querySelector('.by-tip strong')?.textContent, left: Math.round(t.left - c.left), right: Math.round(c.right - t.right) } : null; });
        ok(!!fit && fit.month === 'July' && fit.left >= 0 && fit.right >= 0, `on a phone, July's note stays inside the chart (${JSON.stringify(fit)})`);
        await phone.close();
      }
      await shot(money, '27b-money-against-last-year');
      // On paper too: Print it all's money has the bar and every category beside last year. The meeting's numbers
      // locked on its day, before QuickBooks; locked again (Board → the meeting → Lock today's numbers), they carry it
      await takeSnapshot(env, meetingId, { by: 'Jane Doe' });
      await money.reload({ waitUntil: 'networkidle0' });
      await money.waitForSelector('.bp-agitem .bp-agmix', { timeout: 6000 }).catch(() => {});
      await money.evaluate(() => { window.print = () => { window.__printing = true; }; });
      await clickText(money, 'button', /Print it all/);
      ok(await money.waitForFunction(() => window.__printing, { timeout: 15000 }).then(() => true, () => false), 'Print it all, with QuickBooks connected');
      const paper = await money.evaluate(() => ({ segs: document.querySelectorAll('.bpp-mix__bar span').length, rows: [...document.querySelectorAll('.bpp-mix tbody tr')].map((r) => r.textContent) }));
      ok(paper.segs === 6 && paper.rows.length === 6 && paper.rows[1] === 'Store sales$415,00022%$830,000▼ 50%', `Print it all: where the revenue came from, beside last year (${JSON.stringify(paper.rows.slice(0, 2))})`);
      const storePaper = await money.evaluate(() => [...document.querySelectorAll('.bpp-store tbody tr')].map((r) => r.textContent));
      ok(await money.evaluate(() => [...document.querySelectorAll('.bpp-stmt caption')].some((c) => /^Budget against actual, January 1 to .*Budget_FY26_P&L/.test(c.textContent))), 'Print it all: QuickBooks’ budget against the actuals after the statements');
      ok(JSON.stringify(storePaper) === JSON.stringify(['Sales$415,000$830,000▼ 50%', 'Cost of goods$250,000$380,000▼ 34%', 'Profit before staff and rent$165,000$450,000▼ $285K', 'Profit as a share of sales40%54%▼ 14 pts']), `Print it all: the store beside last year (${JSON.stringify(storePaper)})`);
      await money.evaluate(() => dispatchEvent(new Event('afterprint')));
      // On the screen: QuickBooks' slides after the money, each a slide of its own in the list beside the agenda
      await jane.goto(`${SITE}/admin/#board/meeting/${meetingId}`, { waitUntil: 'networkidle0' });
      await jane.reload({ waitUntil: 'networkidle0' });
      const qb = await jane.waitForFrame((fr) => /\?preview#\/meetings\/[^/]+\/screen$/.test(fr.url()), { timeout: 8000 });
      ok(await jane.waitForFunction(() => [...document.querySelectorAll('.agx-slide')].map((b) => b.textContent).join('|').includes('The year against last year'), { timeout: 15000 }).then(() => true, () => false), 'the slides beside the agenda list QuickBooks’ slides under the money, and the reveals under the makeovers');
      ok((await jane.$$eval('.agx-slide', (b) => b.map((x) => x.textContent))).some((t) => /Upcoming reveals/.test(t)), 'each show after an item’s first, its own slide');
      const slide = async (re) => { await clickText(jane, '.agx-slide', re); };
      await slide(/The year against last year/);
      ok(await qb.waitForFunction(() => /against/.test(document.querySelector('.by-slide__title')?.textContent || '') && document.querySelectorAll('.by-slide .by-chart svg').length === 2, { timeout: 15000 }).then(() => true, () => false), 'the screen: the year against last year, month by month');
      await shot(jane, '28-screen-books-year');
      // The store's slide, after the money, in the list beside the agenda (main's e234f2da, on the one meeting page)
      await slide(/The store/);
      ok(await qb.waitForFunction((want) => /^The store, \d{4} against \d{4}$/.test(document.querySelector('.by-slide__title')?.textContent || '') && [...document.querySelectorAll('.by-slide .bs-figs li')].map((l) => [...l.children].map((c) => c.textContent.trim()).join(' ')).join('|') === want, { timeout: 15000 }, `Sales $415K ${yr - 1} by now: $830K · ▼ 50%|Cost of goods $250K ${yr - 1} by now: $380K · ▼ 34%|Profit before staff and rent $165K ${yr - 1} by now: $450K · ▼ $285K 40% of sales (54% in ${yr - 1})`).then(() => true, () => false), 'the screen: the store after the year, its sales, cost of goods and profit against last year');
      await shot(jane, '28a-screen-books-store');
      await slide(/Statement of activities/);
      ok(await qb.waitForFunction(() => /^Statement of activities/.test(document.querySelector('.by-slide__title')?.textContent || '') && /Net Income/.test(document.querySelector('.by-stmt')?.textContent || ''), { timeout: 15000 }).then(() => true, () => false), 'then the statement of activities beside a year before');
      await slide(/Statement of financial position/);
      ok(await qb.waitForFunction(() => /^Statement of financial position/.test(document.querySelector('.by-slide__title')?.textContent || '') && /▲|▼/.test(document.querySelector('.by-stmt')?.textContent || ''), { timeout: 15000 }).then(() => true, () => false), 'then the financial position, with the change');
      await shot(jane, '28b-screen-books-position');
      // The budget's slide (main's caa7c70c), from the list beside the agenda
      await slide(/Budget against actual/);
      ok(await qb.waitForFunction(() => /^Budget against actual/.test(document.querySelector('.by-slide__title')?.textContent || '') && /January 1 to /.test(document.querySelector('.by-slide .bs-eyebrow')?.textContent || '') && /Total Income/.test(document.querySelector('.by-stmt')?.textContent || '') && /Over \(under\)/.test(document.querySelector('.by-stmt thead')?.textContent || ''), { timeout: 15000 }).then(() => true, () => false), 'the screen: QuickBooks’ budget against the actuals, a slide of its own');
      await shot(jane, '28c-screen-books-budget');
      await slide(/Upcoming reveals/);
      ok(await qb.waitForFunction(() => document.querySelector('.bs-item__title')?.textContent === 'Upcoming reveals', { timeout: 15000 }).then(() => true, () => false), 'an item’s second show, a slide of its own');
      await shot(jane, '28c-screen-second-show');
      // Presenting: C (or the % | $ beside the count) says the money's changes in dollars, then as percentages again;
      // the board page open in another window follows the pick
      {
        const fin = (await meetingNow(jane, meetingId)).sections.flatMap((x) => x.items).find((it) => it.live === 'cash' || (it.also || []).includes('cash'));
        const pres = await tab(FOUNDER, 1280);
        await pres.setViewport({ width: 1280, height: 720 });
        await pres.goto(`${SITE}/admin/board/?present&at=${encodeURIComponent(`${fin.id}:books:act`)}#/meetings/${meetingId}/screen`, { waitUntil: 'networkidle0' });
        const chg = () => pres.$$eval('.by-stmt .by-stmt__chg', (l) => l.map((x) => x.textContent.trim()).filter((t) => t && t !== '–'));
        ok(await pres.waitForFunction(() => /^Statement of activities/.test(document.querySelector('.by-slide__title')?.textContent || ''), { timeout: 10000 }).then(() => true, () => false) && (await chg()).length > 0 && (await chg()).every((t) => /%|Even/.test(t)), `presenting the statement: its changes as percentages (${(await chg()).join(' | ')})`);
        await pres.mouse.move(640, 300);
        await pres.mouse.move(650, 310);
        ok(await pres.$eval('.bs-chg', (g) => g.querySelector('[aria-pressed="true"]')?.textContent.trim().startsWith('%')).catch(() => false), 'the % | $ beside the count, % picked');
        await pres.keyboard.press('c');
        ok(await pres.waitForFunction(() => { const t = [...document.querySelectorAll('.by-stmt .by-stmt__chg')].map((x) => x.textContent.trim()).filter((x) => x && x !== '–'); return t.length > 0 && t.every((x) => /\$|Even/.test(x)); }, { timeout: 3000 }).then(() => true, () => false), `C: in dollars (${(await chg()).join(' | ')})`);
        await money.goto(`${SITE}/admin/board/#/financials`, { waitUntil: 'networkidle0' });
        await pres.keyboard.press('c');
        await pres.keyboard.press('c');
        ok(await money.waitForFunction(() => document.querySelector('.bp-chgas [aria-pressed="true"]')?.textContent.includes('$') && /\+\$|▲ \$|▼ \$/.test(document.querySelector('.bp-latest .bp-stmt')?.textContent || ''), { timeout: 4000 }).then(() => true, () => false), 'the board page in another window follows the pick, as it’s made');
        await shot(pres, '28d-presenting-dollars');
        await pres.keyboard.press('%');
        ok(await pres.waitForFunction(() => [...document.querySelectorAll('.by-stmt .by-stmt__chg')].some((x) => /%/.test(x.textContent)), { timeout: 3000 }).then(() => true, () => false), '% back to percentages');
        // % | $ moves nothing on any money slide (money.js Both: each change holds the room of its longer way; Peter: "the
        // numbers move position!"): every box on the slide, settled, in the same place and size both ways
        {
          const settled = (pg) => pg.evaluate(() => Promise.race([Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, 3000))]));
          const places = async () => { await settled(pres); return pres.evaluate(() => [...document.querySelectorAll('.bs-stage *')].filter((e) => !e.closest('.by-both > span') && !e.closest('svg')).map((e) => { const r = e.getBoundingClientRect(); return `${e.tagName}.${e.className}@${[r.left, r.top, r.width, r.height].map(Math.round)}`; })); };
          const moved = [];
          for (const k of ['year', 'store', 'act', 'budget', 'pos']) {
            await pres.goto(`${SITE}/admin/board/?present&at=${encodeURIComponent(`${fin.id}:books:${k}`)}#/meetings/${meetingId}/screen`, { waitUntil: 'networkidle0' });
            await pres.waitForSelector('.by-slide', { timeout: 10000 }).catch(() => {});
            await sleep(900);
            const a = await places();
            await pres.keyboard.press('c');
            await sleep(700);
            const b = await places();
            const both = await pres.evaluate(() => document.querySelectorAll('.bs-stage .by-both[data-alt]').length);
            await pres.keyboard.press('c');
            await sleep(300);
            const off = a.length !== b.length ? [`${a.length} boxes, then ${b.length}`] : a.filter((x, i) => x !== b[i]);
            if (off.length || !both) moved.push(`${k}: ${both} changes both ways${off.length ? `, moved ${off.slice(0, 3).join(' | ')}` : ''}`);
          }
          ok(!moved.length, `% | $ on the year, the store, the statements and the budget: the figures change in place, nothing on the slide moves${moved.length ? ` (${moved.join('; ')})` : ''}`);
        }
        // The year against last year on a 720p screen
        await pres.goto(`${SITE}/admin/board/?present&at=${encodeURIComponent(`${fin.id}:books:year`)}#/meetings/${meetingId}/screen`, { waitUntil: 'networkidle0' });
        await pres.waitForSelector('.by-slide .by-chart svg', { timeout: 10000 }).catch(() => {});
        await sleep(400);
        const room = await pres.evaluate(() => { const svgs = [...document.querySelectorAll('.by-slide .by-chart svg')]; return { fs: svgs.map((x) => parseFloat(getComputedStyle(x.querySelector('text.by-axis')).fontSize)), inside: svgs.every((x) => x.getBoundingClientRect().bottom <= innerHeight) }; });
        ok(room.fs.length === 2 && room.fs.every((f) => f >= 14) && room.inside, `presenting the year: words a room reads (${room.fs.join(', ')}px), the charts on the screen`);
        await shot(pres, '28e-presenting-year');
        // A long statement (QuickBooks' real ones run to twenty lines and more) goes on as many slides as it takes, each
        // at the size a room reads: no line left off, never set smaller, the bottom line on the last
        const daily = await DB.prepare("SELECT data FROM books_daily WHERE id = 'qbo'").first();
        const long = JSON.parse(daily.data);
        long.statements.activity = [{ k: 'head', label: 'Income', d: 0 }, ...Array.from({ length: 22 }, (_, i) => ({ k: 'total', label: `Total Group ${i + 1}`, d: 1, a: 10000 * (i + 1), p: 9000 * (i + 1) })), { k: 'total', label: 'Total Income', d: 0, a: 1884217, p: 1909703 }, { k: 'sum', label: 'Net Income', d: 0, a: 189248, p: 176000 }];
        await DB.prepare("UPDATE books_daily SET data = ? WHERE id = 'qbo'").bind(JSON.stringify(long)).run();
        await pres.goto(`${SITE}/admin/board/?present&at=${encodeURIComponent(`${fin.id}:books:act`)}#/meetings/${meetingId}/screen`, { waitUntil: 'networkidle0' });
        await pres.reload({ waitUntil: 'networkidle0' });
        const whole = () => pres.waitForFunction(() => {
          const box = document.querySelector('.by-fit');
          const rows = [...document.querySelectorAll('.by-fit tbody tr')];
          return box && rows.length && box.scrollHeight <= box.clientHeight + 1 && rows.every((r) => !r.hidden) && !document.querySelector('.by-fit__more') && parseFloat(getComputedStyle(document.querySelector('.by-stmt.is-big')).fontSize) >= 20;
        }, { timeout: 8000 }).then(() => true, () => false);
        const seen = [];
        let fitted = await whole();
        for (let i = 0; fitted && i < 6; i++) {
          seen.push(...await pres.$$eval('.by-fit tbody tr th', (l) => l.map((x) => x.textContent.trim())));
          if (seen.includes('Net Income')) break;
          await pres.keyboard.press('ArrowRight');
          fitted = await pres.waitForFunction(() => /Statement of activities, continued/.test(document.querySelector('.bs-foot__what')?.textContent || ''), { timeout: 4000 }).then(() => true, () => false) && await whole();
        }
        const groups = seen.filter((t) => /^Total Group \d+$/.test(t)).length;
        ok(fitted && groups === 22 && seen.includes('Total Income') && seen.at(-1) === 'Net Income', `a long statement goes on over as many slides as it takes, every line at 20px or more, the bottom line last (${groups} of 22 groups)`);
        await shot(pres, '28f-presenting-long-statement');
        await DB.prepare("UPDATE books_daily SET data = ? WHERE id = 'qbo'").bind(daily.data).run();
        await pres.close();
      }
    }
    if (width === 390) {
      // On a phone a count, an amount or a time never ends a line without its word ("$243K" / "in kind"); a year
      // before a word, a day of the month, the tables and what's typed in (a file's name, the meeting's place, a
      // presenter's report) are left to wrap as they will, and a line that never wraps can't break
      for (const page of ['#/', '#/meetings', `#/meetings/${meetingId}`, '#/financials', '#/documents', '#/people']) {
        await money.goto(`${SITE}/admin/board/${page}`, { waitUntil: 'networkidle0' });
        await money.evaluate(() => document.querySelectorAll('.bp-main details').forEach((x) => { x.open = true; }));
        await new Promise((r) => setTimeout(r, 300));
        const loose = await money.evaluate(() => {
          const out = [];
          const walk = document.createTreeWalker(document.querySelector('.bp-main'), NodeFilter.SHOW_TEXT);
          for (let n; (n = walk.nextNode());) {
            if (n.parentElement.closest('table, svg, [hidden], .bp-file__title, .bp-doctile__title, a[href*="google.com/maps"], .rp') || /nowrap|pre/.test(getComputedStyle(n.parentElement).whiteSpace)) continue;
            for (const m of n.nodeValue.matchAll(/(?<![\p{L}\d.,:])(\$?\d(?:[\d,.:]*\d)?[KMB%]?) (\p{L}+)/gu)) {
              if (/^(19|20)\d{2}$/.test(m[1]) || /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? $/.test(n.nodeValue.slice(0, m.index))) continue;
              out.push(`${m[0]} (.${n.parentElement.closest('[class]').className.split(' ')[0]})`);
            }
          }
          return out;
        });
        ok(!loose.length, `${page} at 390: every count, amount and time kept with its word${loose.length ? ` (${loose.slice(0, 5).join(' | ')})` : ''}`);
      }
    }
    await money.close();
  }
  await DB.exec("DELETE FROM books_link; DELETE FROM books_daily");

  // ─── The minutes template, typed into and dropped in after the meeting ───
  console.log('The minutes template, back in');
  /** The Word template typed into: an "x" before everyone but `away`, "video" for `video`, a note under the first item; saved compressed, as Word saves */
  const typeTemplate = async (bytes, { away = '', video = '', note = '' }) => {
    const names = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml', 'word/numbering.xml', 'docProps/core.xml'];
    const parts = await unzip(new Uint8Array(bytes), names);
    const dec = (b) => new TextDecoder().decode(b);
    const run = (x) => `<w:r><w:t xml:space="preserve">${x}</w:t></w:r>`;
    let doc = dec(parts['word/document.xml']);
    for (const r of [...doc.matchAll(/<w:tr>(?:(?!<\/w:tr>)[\s\S])*?<\/w:tr>/g)].map((x) => x[0]).slice(1)) {
      const name = r.match(/<w:t xml:space="preserve">([^<]+)<\/w:t>/)?.[1] || '';
      if (name === away) continue;
      let k = 0;
      doc = doc.replace(r, r.replace(/(<w:pStyle w:val="Cell"\/>(?:<w:jc w:val="center"\/>)?<\/w:pPr>)(<\/w:p>)/g, (all, a, b) => { const v = ['x', name === video ? 'video' : ''][k++]; return v ? `${a}${run(v)}${b}` : all; }));
    }
    if (note) doc = doc.replace(/(<w:p><w:pPr><w:pStyle w:val="Note"\/>(?:(?!<\/w:p>)[\s\S])*?<\/w:pPr>)(<\/w:p>)/, `$1${run(note)}$2`);
    return zip(Object.fromEntries(names.map((n) => [n, n === 'word/document.xml' ? doc : dec(parts[n])])));
  };
  if (template) {
    // A meeting held yesterday with this agenda: after it, the drop comes first, its own template beside it, typed
    // into and dropped back in (a meeting still ahead has nothing to drop minutes into)
    const src = await meetingNow(jane, meetingId);
    const heldM = await saveMeeting(DB, cleanMeeting({ date: day(-1), start: src.start, end: src.end, location: src.location, shared: true, attendance: src.attendance, sections: src.sections.map((s) => ({ ...s, items: s.items.map((it) => ({ ...it, docs: [], report: '' })) })), agendaFrom: { kind: 'typed', name: '', at: new Date().toISOString() } }), { by: FOUNDER });
    const before = await meetingNow(jane, heldM.id);
    const boardNames = before.attendance.filter((p) => p.kind === 'board').map((p) => p.name);
    const away = boardNames.at(-1);
    const back = await tab(FOUNDER);
    await back.goto(`${SITE}/admin/#board/meeting/${heldM.id}`, { waitUntil: 'networkidle0' });
    ok(await waitText(back, /Drop the minutes here/) && await back.evaluate(() => [...document.querySelectorAll('.bm-row__side .card h3')].some((h) => h.textContent === 'Minutes template')), 'held, until the minutes are in: the drop first, the template beside it');
    const heldTemplate = await back.evaluate(async () => {
      const make = URL.createObjectURL;
      const click = HTMLAnchorElement.prototype.click;
      let blob = null;
      URL.createObjectURL = (b) => { blob = b; return make.call(URL, b); };
      HTMLAnchorElement.prototype.click = function () {};
      try { [...document.querySelectorAll('.bm-row__side .card button')].find((b) => b.textContent.trim() === 'Word file').click(); } finally { URL.createObjectURL = make; HTMLAnchorElement.prototype.click = click; }
      return blob ? { bytes: [...new Uint8Array(await blob.arrayBuffer())] } : null;
    });
    const typed = join(OUT, template.name.replace(/\(\d{4}-\d{2}-\d{2}\)/, `(${day(-1)})`));
    writeFileSync(typed, await typeTemplate(heldTemplate.bytes, { away, video: boardNames[1], note: 'Called to order at 8:03 AM.' }));
    await (await back.$('.bm-minutes-drop input[type="file"]')).uploadFile(typed);
    ok(await waitText(back, /Read from the minutes: [^\n]*board members there/), 'the typed template drops straight in');
    const after = await meetingNow(back, heldM.id);
    const board = after.attendance.filter((p) => p.kind === 'board');
    ok(board.find((p) => p.name === away)?.status === 'absent' && board.filter((p) => p.name !== away).every((p) => p.status === 'present' || p.status === 'remote') && after.attendance.some((p) => p.name === boardNames[1] && p.status === 'remote'), 'who was there, from the x’s and the “video”');
    ok(after.sections[0].items[0].notes === '- Called to order at 8:03 AM.', 'the note is on the first item');
    ok(JSON.stringify(after.sections.map((s) => [s.id, s.items.map((it) => it.id)])) === JSON.stringify(before.sections.map((s) => [s.id, s.items.map((it) => it.id)])), 'the agenda as it was: no Motions or Action items part added, no item dropped');
    ok(!(await back.evaluate(() => [...document.querySelectorAll('.bm-row__side .card h3')].some((h) => h.textContent === 'Minutes template'))), 'once the minutes are in, the template steps aside');
    await back.close();
  }

  // ─── The board's secretary, on the board page: the template, and the typed minutes sent back ───
  console.log('The secretary, on the board page');
  const SECRETARY = 'kim.board@example.com';
  await DB.prepare('UPDATE team SET data = ? WHERE slug = ?').bind(JSON.stringify({ ...PEOPLE['kim-park'], title: 'Board Secretary' }), 'kim-park').run();
  await DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind('kim-park', SECRETARY).run();
  await jane.goto(`${SITE}/admin/#board/meeting/${meetingId}`, { waitUntil: 'networkidle0' });
  await jane.reload({ waitUntil: 'networkidle0' });
  ok(await waitText(jane, /Kim Park \(Board Secretary\) has it on the board page too/), 'the founders’ minutes template says the secretary has it on the board page');
  const sec = await tab(SECRETARY);
  await sec.goto(`${SITE}/admin/board/#/meetings/${meetingId}`, { waitUntil: 'networkidle0' });
  const card = (page) => page.evaluate(() => { const c = document.querySelector('.bp-minutes'); return c ? { text: c.innerText, send: !!c.querySelector('input[type="file"]'), buttons: [...c.querySelectorAll('button')].map((b) => b.textContent.trim()) } : null; });
  const ahead = await card(sec);
  ok(/You take the minutes/.test(ahead?.text || '') && JSON.stringify(ahead.buttons) === '["Word file","Print the form"]' && !ahead.send, `the secretary’s meeting page: the Word file and the form to print, nothing to send before the day (${JSON.stringify(ahead)})`);
  await shot(sec, '27-secretary-minutes');
  await sec.evaluate(() => { window.__printing = false; window.print = () => { window.__printing = true; }; });
  await clickText(sec, '.bp-minutes button', /Print the form/);
  ok(await sec.waitForFunction(() => window.__printing && /Who was there/.test(document.querySelector('.mt-print')?.textContent || ''), { timeout: 5000 }).then(() => true, () => false), 'Print the form opens the print window with the minutes form');
  await sec.pdf({ path: join(OUT, '27b-secretary-form.pdf'), format: 'letter', printBackground: true });
  await sec.evaluate(() => dispatchEvent(new Event('afterprint')));
  ok(await sec.waitForFunction(() => !document.querySelector('.mt-print'), { timeout: 5000 }).then(() => true, () => false), 'and the form is taken away after');
  ok(!(await sec.evaluate(() => /PRIVATE/.test(document.body.innerText))), 'the board page never shows a private note');
  // Another board member doesn't see it
  const chair = await tab(MEMBER);
  await chair.goto(`${SITE}/admin/board/#/meetings/${meetingId}`, { waitUntil: 'networkidle0' });
  ok(await waitText(chair, /Board meeting/) && !(await chair.$('.bp-minutes')), 'other board members don’t see it');
  await chair.close();
  // The meeting day: a meeting today, its typed minutes sent from the board page
  const today = await saveMeeting(DB, cleanMeeting({
    date: day(0), start: '08:00', end: '10:00', title: 'Secretary’s meeting', shared: true, agendaFrom: { kind: 'typed', name: '', at: new Date().toISOString() },
    attendance: ['alex-rivera', 'sam-ortiz', 'kim-park'].map((slug) => ({ slug, name: PEOPLE[slug].name, kind: 'board' })),
    sections: [{ title: 'Call to order', items: [{ title: 'Roll call' }] }, { title: 'Committee reports', items: [{ title: 'Financial', live: 'cash', staffNote: 'PRIVATE: ask counsel' }] }],
  }), { by: FOUNDER });
  // A founder on the board page: the same card, saying whose it is
  await jane.goto(`${SITE}/admin/board/#/meetings/${today.id}`, { waitUntil: 'networkidle0' });
  await jane.reload({ waitUntil: 'networkidle0' });
  const founderCard = await card(jane);
  ok(/^The minutes\n/.test(founderCard?.text || '') && /Kim Park takes them as Board Secretary, with this same card/.test(founderCard?.text || '') && founderCard.send && JSON.stringify(founderCard.buttons) === '["Word file","Print the form"]', `a founder’s board page has it too, naming the secretary (${JSON.stringify(founderCard)})`);
  await jane.goto(`${SITE}/admin/#board`, { waitUntil: 'networkidle0' });
  await sec.goto(`${SITE}/admin/board/#/meetings/${today.id}`, { waitUntil: 'networkidle0' });
  await sec.reload({ waitUntil: 'networkidle0' });
  ok((await card(sec))?.send && /Send the minutes/.test((await card(sec))?.text || ''), 'on the day: Send the minutes');
  const secWord = await sec.evaluate(async () => {
    const make = URL.createObjectURL;
    const click = HTMLAnchorElement.prototype.click;
    let blob = null;
    let name = '';
    URL.createObjectURL = (b) => { blob = b; return make.call(URL, b); };
    HTMLAnchorElement.prototype.click = function () { name = this.download; };
    try {
      [...document.querySelectorAll('.bp-minutes button')].find((b) => b.textContent.trim() === 'Word file').click();
      for (let i = 0; i < 40 && !blob; i++) await new Promise((r) => setTimeout(r, 50));
    } finally { URL.createObjectURL = make; HTMLAnchorElement.prototype.click = click; }
    return blob ? { name, bytes: [...new Uint8Array(await blob.arrayBuffer())] } : null;
  });
  ok(/^Secretary’s meeting minutes \(\d{4}-\d{2}-\d{2}\)\.docx$/.test(secWord?.name || ''), `the secretary’s Word file: “${secWord?.name}”`);
  if (secWord) {
    const typedBySec = join(OUT, secWord.name);
    writeFileSync(typedBySec, await typeTemplate(secWord.bytes, { away: 'Sam Ortiz', note: 'Called to order at 8:01 AM.' }));
    // The wrong file picked (another meeting's typed template): it says so, keeps nothing, and can still send it
    if (template) {
      const wrong = join(OUT, `wrong-${template.name}`);
      writeFileSync(wrong, await typeTemplate(template.bytes, { note: 'From the other meeting.' }));
      await (await sec.$('.bp-minutes input[type="file"]')).uploadFile(wrong);
      ok(await waitText(sec, /These look like the minutes of [^\n]*not this meeting’s/) && await sec.evaluate(() => /Send it anyway/.test(document.querySelector('.bp-toast')?.textContent || '')), 'another meeting’s minutes: the board page says so, with Send it anyway');
      ok((await getMeeting(DB, today.id)).files.length === 0, 'and nothing was kept');
    }
    await (await sec.$('.bp-minutes input[type="file"]')).uploadFile(typedBySec);
    ok(await waitText(sec, /Board has the minutes: 2 of 3 board members there, notes under 1 item/), 'sent: the board page says what Board read');
    const held = await getMeeting(DB, today.id);
    ok(held.sections[0].items[0].notes === '- Called to order at 8:01 AM.' && held.attendance.map((p) => `${p.slug}:${p.status}`).join() === 'alex-rivera:present,sam-ortiz:absent,kim-park:present' && held.files.some((f) => f.kind === 'minutes' && f.name === secWord.name), 'the meeting has the secretary’s minutes: the note, the roll, the file');
    ok(/Board has them as of /.test((await card(sec))?.text || '') && /Send a newer copy/.test((await card(sec))?.text || ''), 'and the card says Board has them, with a way to send a newer copy');
    ok(/Called to order at 8:01 AM/.test(await text(sec)) && !/PRIVATE/.test(await text(sec)), 'the note shows on the board page; the private note never does');
    await shot(sec, '27c-secretary-sent');
  }
  await sec.close();

  // A meeting the chair started and ended before its day (moved up, held early) is past: Board's Home goes on to the
  // one after it and lists it with the past meetings, and its own page says Held
  {
    await jane.goto(`${SITE}/admin/#board`, { waitUntil: 'networkidle0' });
    await jane.reload({ waitUntil: 'networkidle0' });
    // Where Home links a meeting: the next one's card, Also coming up, or Past meetings
    const placeOf = (id) => jane.evaluate((id) => {
      const find = (links) => [...links].find((a) => a.getAttribute('href').includes(encodeURIComponent(id)))?.getAttribute('href') || '';
      const card = (h) => [...document.querySelectorAll('.card')].find((c) => h.test(c.querySelector('.sec-head h3')?.textContent || ''));
      return { next: find(document.querySelectorAll('.bh-next__title a')), ahead: find(card(/^Also coming up/)?.querySelectorAll('.bd-row__title') || []), past: find(card(/^Past meetings/)?.querySelectorAll('.bd-row__title') || []) };
    }, id);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const ahead = (await jane.evaluate(async () => (await (await fetch('/api/board-admin')).json()).meetings)).filter((m) => m.date > today && !m.practice).sort((a, b) => a.date.localeCompare(b.date));
    // A meeting the chair ran above that's dated ahead is held early already: with the past ones
    const ranEarly = ahead.filter((m) => m.live?.endedAt);
    const placed = await Promise.all(ranEarly.map((m) => placeOf(m.id)));
    if (ranEarly.length) ok(placed.every((x) => !x.next && !x.ahead && x.past), `the meeting held early above is past (${JSON.stringify(placed)})`);
    // (one the board page has, so it's seen there too)
    const early = ahead.find((m) => !m.live?.endedAt && m.shared) || ahead.find((m) => !m.live?.endedAt);
    const before = early ? await placeOf(early.id) : {};
    ok(!!early && !before.past && !!(before.next || before.ahead), `before: the meeting ahead is coming up, not past (${JSON.stringify(before)})`);
    if (early) {
      const was = (await getMeeting(DB, early.id)).live;
      const t = Date.now();
      await patchMeeting(DB, early.id, (x) => ({ ...x, live: { ...x.live, startedAt: new Date(t - 3600e3).toISOString(), endedAt: new Date(t - 60e3).toISOString() } }));
      await jane.reload({ waitUntil: 'networkidle0' });
      const home = await placeOf(early.id);
      ok(!home.next && !home.ahead && !!home.past, `held early: not the next meeting, listed with the past ones (${JSON.stringify(home)})`);
      await shot(jane, '28-held-early');
      await jane.goto(`${SITE}/admin/#board/meeting/${encodeURIComponent(early.id)}`, { waitUntil: 'networkidle0' });
      await jane.reload({ waitUntil: 'networkidle0' });
      ok(await jane.waitForFunction(() => document.querySelector('.bm-when')?.textContent.trim() === 'Held', { timeout: 6000 }).then(() => true, () => false), `and its own page says Held, not its date ahead (${await jane.$eval('.bm-when', (e) => e.textContent).catch(() => '')})`);
      // And on the board page: with the past meetings, never Home's next meeting or "Will you be there?"
      if (early.shared) {
        const member = await tab(MEMBER, 1440);
        await member.goto(`${SITE}/admin/board/#/`, { waitUntil: 'networkidle0' });
        const onHome = await member.evaluate((id) => !!document.querySelector(`.bp-nextup a[href="#/meetings/${id}"]`), early.id);
        await member.goto(`${SITE}/admin/board/#/meetings`, { waitUntil: 'networkidle0' });
        await member.reload({ waitUntil: 'networkidle0' });
        const listed = await member.evaluate((id) => ({ past: !!document.querySelector(`.bp-archive #mr-${CSS.escape(id)}`), ahead: !![...document.querySelectorAll('#up-h ~ .bp-mlist a')].find((a) => a.getAttribute('href') === `#/meetings/${id}`) }), early.id);
        ok(!onHome && listed.past && !listed.ahead, `the board page: a meeting held early is with the past ones, not next (${JSON.stringify({ onHome, ...listed })})`);
        await member.close();
      }
      await patchMeeting(DB, early.id, (x) => ({ ...x, live: was }));
    }
  }

  ok(driveCalls === 0, 'Board never reads Google Drive');
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
