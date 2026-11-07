/**
 * test-board-family-map.mjs — The families on a map, and what they sent, on the board page, in a real browser
 * ==================================================================================================
 * The real handlers behind the real sign-in middleware on an in-memory D1, JobTread's API and its file
 * CDN faked with made-up families (the repo is public). Map tiles are a plain gray square unless
 * REAL_TILES=1, so nothing here needs the internet. PHOTOS=<folder of .jpg> puts real-looking pictures
 * in the fake CDN, for looking at the screenshots. Checks, at laptop and phone sizes:
 *   - Home's Makeovers card, from application to reveal: every step and how many are at it, the application's
 *     window over its two, a column for each step someone's at (the families applying and revealed in rows, those
 *     being built on their page's photo with their reveal), a closed application, and the same families on the
 *     map: the key, who's on it, the season switch; a row lights its pin
 *   - a pin or a row opens the family in the list's place; video, photos and the application open in the
 *     viewer; Back and Esc come back to the row
 *   - the wheel goes on down the page; ⌘ or Ctrl and the wheel zooms
 *   - Families → Map; a family's page with what they sent, with less than everything, with nothing
 *   - nothing past the screen's edge, axe, no console errors, the admin's real CSP
 * Screenshots land in test-results/board-family-map/. Exits non-zero on any failure.
 *
 *   node scripts/test-board-family-map.mjs
 */
import puppeteer from 'puppeteer';
import http from 'node:http';
import { mkdirSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, extname } from 'node:path';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import { answerAsks } from './lib/ask.mjs';
import { onRequest as middleware, _resetKeyCacheForTests } from '../functions/api/_middleware.js';
import * as boardPortal from '../functions/api/board-portal.js';
import * as boardFile from '../functions/api/board-file.js';
import { ensureSchema } from '../functions/api/_board.js';
import { ensureApplicantSchema } from '../functions/api/_applicants.js';
import { saveScorecard } from '../functions/api/_applicant-scores.js';
import { DEFAULT_SERVICE_AREA } from '../functions/api/_application-form.js';
import { criteriaOf, rubricOfSeason } from '../public/admin/scoring-shared.js';
import { FIELD_JOB_STATUS } from '../functions/api/_reveals.js';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = process.env.OUT_DIR || join(ROOT, 'test-results/board-family-map/');
mkdirSync(OUT, { recursive: true });
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const YEAR = Number(day(0).slice(0, 4)) + 1;

const MEMBER = 'kim.board@example.com';
const PEOPLE = {
  'jane-doe': { name: 'Jane Doe', group: 'team', title: 'Co-Founder/President', order: 1 },
  'kim-park': { name: 'Kim Park', group: 'board', title: 'Board Member', organization: 'Park Media', order: 1 },
};
const FILE = (id, name, type, extra = {}) => ({ id, name, type, size: extra.size ?? 2400000, createdAt: extra.at || `${day(-3)}T14:00:00Z`, url: `https://cdn.jobtread.com/${id}`, thumb: extra.thumb === false ? null : `https://cdn.jobtread.com/${id}?size=600`, job: extra.job || null });
const FILES = {
  // Everything: the application, the video, four photos, and staff's notes beside them, which never show
  acctIris01: [
    FILE('fNotes1', 'Linzi_Iris_Onsite_Notes.pdf', 'application/pdf'), FILE('fNotes2', 'Iris_ZoomNotes.pdf', 'application/pdf'),
    FILE('fSvg001', 'Iris Drawing.svg', 'image/svg+xml'), FILE('fHtml01', 'Iris Page.html', 'text/html', { thumb: false }),
    FILE('fSpace2', 'Iris Example Space 2.jpg', 'image/jpeg'), FILE('fSpace1', 'Iris Example Space 1.jpg', 'image/jpeg'),
    FILE('fFamily', 'Iris Example Family.jpg', 'image/jpeg'), FILE('fChild1', 'Iris Example.jpg', 'image/jpeg'),
    FILE('fVideo1', 'Iris Example_Application.webm', 'video/webm', { size: 48000000 }), FILE('fPdf001', 'Iris Example_Application.pdf', 'application/pdf', { size: 310000 }),
  ],
  // No video: an older family's application and photos
  acctJay001: [FILE('fJaySp1', 'Jay Example Space 1.jpg', 'image/jpeg'), FILE('fJayKid', 'Jay Example.jpg', 'image/jpeg'), FILE('fJayPdf', 'Jay Example_Application.pdf', 'application/pdf')],
  // A video and no PDF, and files whose names prove nothing, which stay with staff
  acctMia001: [FILE('fMiaVid', 'Mia Example_Application.webm', 'video/webm', { size: 900000 }), FILE('fMiaKid', 'Mia Example.jpg', 'image/jpeg'), FILE('fMiaFam', 'Mia Example Family.jpg', 'image/jpeg', { thumb: false }),
    FILE('fMiaCam', 'IMG_4471.webm', 'video/webm'), FILE('fMiaId', 'Mia Drivers License.jpg', 'image/jpeg'), FILE('fMiaLet', 'Doctor Letter.jpg', 'image/jpeg'), FILE('fMiaAid', 'Mia_Medicaid_Application.pdf', 'application/pdf')],
};
const F = (name, status, season, lat, lng, more = {}) => ({ name, status, season, lat, lng, area: 'inside', miles: 0, city: 'Roswell', county: 'Fulton', types: ['Therapy Room'], fields: { diagnosis: 'An example diagnosis', birthday: '2017-05-01', mobile: 'No', verbal: 'Yes', language: 'English' }, ...more });
const FAMILIES = {
  acctIris01: F('Iris Example', 'Approved', YEAR, 34.02, -84.36, { types: ['Therapy Room', 'Bathroom'], photo: 'https://cdn.jobtread.com/fChild1?size=256' }),
  acctJay001: F('Jay Example', 'In Review', YEAR, 33.93, -84.51, { city: 'Marietta', county: 'Cobb', types: ['Bathroom'], photo: 'https://cdn.jobtread.com/fJayKid?size=256' }),
  acctMia001: F('Mia Example', 'Applied', YEAR, 34.07, -84.17, { city: 'Johns Creek', types: ['Bedroom'] }),
  acctNora01: F('Nora Example', 'Applied', YEAR, 34.25, -83.9, { area: 'outside', miles: 12.4, city: 'Gainesville', county: 'Hall', types: ['Bedroom'] }),
  acctOmar01: F('Omar Example', 'Denied', YEAR, 33.45, -82.03, { area: 'outside', miles: 96.7, city: 'Augusta', county: 'Richmond', types: ['Ramp'], fields: { denialReason: 'Outside the service area (an example)' } }),
  acctNoSt01: F('Noah Example', null, YEAR, 33.79, -84.2, { city: 'Decatur', county: 'DeKalb', types: ['Bedroom'] }),
  acctFarm01: F('Oak Academy Example', 'Approved', YEAR, 33.88, -84.31, { city: 'Brookhaven', county: 'DeKalb', types: [], fields: {} }),
  acctForm01: F('Rosa Example', 'Applied', YEAR, 33.97, -84.08, { city: 'Lawrenceville', county: 'Gwinnett', types: ['Bedroom'] }),
  acctTest01: F('TEST Applicant', 'Applied', YEAR, 34, -84.3),
  acctRun001: F('Sample Child', 'Applied', YEAR, 34.01, -84.31),
  acctNoPt01: F('Pat Example', 'Applied', YEAR, null, null, { city: '', county: '' }),
  // Last season's, being built and revealed: each family's job in JobTread (JOBS below), their kid page (KIDS)
  acctMax001: F('Max Example', 'Approved', YEAR - 1, 34.05, -84.3, { jobId: 'jMax', city: 'Alpharetta', types: ['Bedroom', 'Bathroom'] }),
  acctLeo001: F('Leo Example', 'Approved', YEAR - 1, 33.95, -84.55, { jobId: 'jLeo', city: 'Marietta', county: 'Cobb', types: ['Bathroom'] }),
  acctAva001: F('Ava Example', 'Approved', YEAR - 1, 34.11, -84.0, { jobId: 'jAva', city: 'Suwanee', county: 'Gwinnett', types: ['Bedroom'], photo: 'https://cdn.jobtread.com/fAvaKid?size=256' }),
  acctZoe001: F('Zoe Example', 'Approved', YEAR - 1, 33.88, -84.47, { jobId: 'jZoe', city: 'Smyrna', county: 'Cobb', types: ['Therapy Room'] }),
  acctSam001: F('Sam Example', 'Approved', YEAR - 1, 34.0, -84.15, { jobId: 'jSamOld', city: 'Duluth', county: 'Gwinnett', types: ['Bedroom'] }),
  acctTia001: F('Tia Example', 'Approved', YEAR - 1, 33.9, -84.25, { jobId: 'jTia', city: 'Dunwoody', county: 'DeKalb', types: ['Bathroom'] }),
  ...Object.fromEntries(['Ana', 'Ben', 'Cal', 'Dee', 'Eli', 'Fay', 'Gus', 'Hope', 'Ivy', 'Jude', 'Kit', 'Lou'].map((n, i) => [`acctOld${String(i).padStart(2, '0')}`, F(`${n} Example`, ['Approved', 'Denied', 'Denied'][i % 3], YEAR - 1 - (i % 2), 33.75 + (i % 5) * 0.09, -84.55 + (i % 7) * 0.08, { city: 'Atlanta', types: ['Bedroom', 'Bathroom'] })])),
};

const certsKey = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', certsKey.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
async function tokenFor(email) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ iss: 'https://soard.cloudflareaccess.com', aud: ['aud-tag'], email, iat: now, nbf: now, exp: now + 3600 }));
  return `${h}.${p}.${b64u(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', certsKey.privateKey, new TextEncoder().encode(`${h}.${p}`))))}`;
}

const DB = await createD1();
for (const sql of [
  'CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)',
  'CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)',
  'CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)',
  'CREATE TABLE kids (slug TEXT PRIMARY KEY, name TEXT, year INTEGER, data TEXT)',
  'CREATE TABLE community (slug TEXT PRIMARY KEY, name TEXT, data TEXT)',
  'CREATE TABLE events (slug TEXT PRIMARY KEY, data TEXT)',
  'CREATE TABLE partners (slug TEXT PRIMARY KEY, data TEXT)',
  'CREATE TABLE audit_log (id INTEGER PRIMARY KEY, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)',
  'CREATE TABLE applications (id TEXT PRIMARY KEY, jt_account_id TEXT, lang TEXT, jt_state TEXT, files TEXT, is_test INTEGER DEFAULT 0, submitted_at TEXT, kind TEXT, deleted_at TEXT)',
]) await DB.exec(sql);
for (const [slug, d] of Object.entries(PEOPLE)) await DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.group, JSON.stringify(d)).run();
await DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind('kim-park', MEMBER).run();
await ensureSchema(DB);
await ensureApplicantSchema(DB);
for (const [id, f] of Object.entries(FAMILIES)) {
  await DB.prepare(`INSERT INTO applicants (account_id, name, status, year, types, fields, address, city, county, lat, lng, area, area_miles, contact_name, contact_email, contact_phone, contacts, photo_url, created_at, synced_at, job_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, f.name, f.status, String(f.season), JSON.stringify(f.types), JSON.stringify(f.fields), '12 Elm St, Roswell, GA 30075', f.city, f.county, f.lat, f.lng, f.lat == null ? 'unknown' : f.area, f.miles, 'Parent Example', 'parent@example.com', '4045550100', '[]', f.photo || null, `${day(-9)}T14:00:00Z`, new Date().toISOString(), f.jobId || null).run();
}
// Their kid pages (a published page names them and gives their card its photo), and Ruby's, from before the
// applications: her family isn't an applicant, so her makeover is on the board by her page alone
const KIDS = { max: ['Max', 'jMax'], leo: ['Leo', 'jLeo'], zoe: ['Zoe', 'jZoe'], sam: ['Sam', 'jSamOld'], tia: ['Tia', 'jTia'], ruby: ['Ruby', 'jRuby'] };
for (const [slug, [name, job]] of Object.entries(KIDS)) {
  await DB.prepare('INSERT INTO kids (slug, name, year, data) VALUES (?, ?, ?, ?)').bind(slug, name, YEAR - 1, JSON.stringify({ name, year: YEAR - 1, jobtreadJobId: job, heroImage: `https://imagedelivery.net/abc123/kids/${slug}/photo-1/public` })).run();
}
const JOB = (id, name, status) => ({ id, name, customFieldValues: { nodes: [{ value: status, customField: { id: FIELD_JOB_STATUS } }] } });
// Open jobs only (Sam's is closed: his makeover is done)
const JOBS = [JOB('jMax', `Max Example (${YEAR - 1})`, 'Build'), JOB('jLeo', `Leo Example (${YEAR - 1})`, 'Design'), JOB('jAva', `Ava Example (${YEAR - 1})`, 'Awaiting Funding'),
  JOB('jZoe', `Zoe Example (${YEAR - 1})`, 'Mobilization'), JOB('jTia', `Tia Example (${YEAR - 1})`, 'Closed Done'), JOB('jRuby', `Ruby Example (${YEAR - 1})`, 'Build')];
// The application, open until a day ahead; Max's reveal set, Zoe's in a part of a month
await DB.prepare('INSERT INTO site_config (key, data) VALUES (?, ?)').bind('settings', JSON.stringify({ application: { open: true, year: String(YEAR), closesAt: `${day(60)}T23:59:00-05:00` } })).run();
await DB.prepare('INSERT INTO site_config (key, data) VALUES (?, ?)').bind('reveals', JSON.stringify({ reveals: [], upcoming: [
  { slug: 'max', name: 'Max', confirmed: true, date: day(12), time: '16:00' },
  { slug: 'zoe', name: 'Zoe', confirmed: false, window: { part: 'mid', month: day(40).slice(0, 7), label: `mid ${new Date(`${day(40)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })}` } },
] })).run();
await DB.prepare('INSERT INTO applications (id, jt_account_id, lang, jt_state, files, is_test, submitted_at, kind) VALUES (?, ?, ?, ?, ?, 0, ?, ?)').bind('app-form-1', 'acctForm01', 'en', JSON.stringify({ pdf: { key: 'r2/rosa.pdf' } }), JSON.stringify({ photoChild: { key: 'r2/rosa.jpg', thumbKey: 'r2/rosa-t.jpg', type: 'image/jpeg', size: 90000 }, video: { uploaded: true } }), `${day(0)}T13:00:00Z`, 'family').run();
await DB.prepare('INSERT INTO applications (id, jt_account_id, lang, jt_state, files, is_test, submitted_at, kind) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').bind('app-test-1', 'acctRun001', 'en', '{}', '{}', `${day(0)}T13:00:00Z`, 'family').run();
const card = (n) => Object.fromEntries(criteriaOf(rubricOfSeason(String(YEAR))).filter((c) => !c.after).map((c) => [c.key, n]));
await saveScorecard(DB, 'acctIris01', { evaluator: 'lin.smith@soardcharity.com', name: 'Lin Smith', scores: card(4) });
await saveScorecard(DB, 'acctJay001', { evaluator: 'lin.smith@soardcharity.com', name: 'Lin Smith', scores: card(3) });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const pics = process.env.PHOTOS ? readdirSync(process.env.PHOTOS).filter((f) => /\.jpe?g$/i.test(f)).sort().map((f) => readFileSync(join(process.env.PHOTOS, f))) : [];
const picFor = (id) => (pics.length ? pics[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % pics.length] : PNG);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 24 Tf 72 700 Td (The application) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
let VIDEO = Buffer.alloc(0);
let jobtreadDown = false;
const cdnCalls = [];
const env = {
  DB, CF_ACCESS_TEAM_DOMAIN: 'soard', CF_ACCESS_AUD: 'aud-tag', RESEND_API_KEY: 're_test', JOBTREAD_GRANT_KEY: 'jt-test',
  FILES: { get: async (key) => (key.endsWith('.pdf') ? { body: PDF, httpMetadata: { contentType: 'application/pdf' } } : { body: picFor(key), httpMetadata: { contentType: 'image/jpeg' } }) },
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === 'https://soard.cloudflareaccess.com/cdn-cgi/access/certs') return Response.json({ keys: [jwk] });
  if (url === 'https://api.jobtread.com/pave') {
    if (jobtreadDown) return new Response('down', { status: 503 });
    const q = JSON.parse(init.body || '{}').query || {};
    if (q.account) return Response.json({ account: { files: { nodes: FILES[q.account.$.id] || [] } } });
    return Response.json({ organization: { jobs: { nodes: JOBS, nextPage: null } } });
  }
  if (url.startsWith('https://cdn.jobtread.com/')) {
    const u = new URL(url);
    const id = u.pathname.slice(1);
    cdnCalls.push(url);
    const all = Object.values(FILES).flat().find((f) => f.id === id);
    const thumb = u.searchParams.has('size');
    const body = thumb ? picFor(id) : /pdf/.test(all?.type || '') ? PDF : /video/.test(all?.type || '') ? VIDEO : picFor(id);
    const type = thumb ? 'image/jpeg' : all?.type || 'image/jpeg';
    const range = new Headers(init.headers || {}).get('range');
    const m = range?.match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const from = Number(m[1]);
      const to = Math.min(m[2] ? Number(m[2]) : body.length - 1, body.length - 1);
      return new Response(body.subarray(from, to + 1), { status: 206, headers: { 'content-type': type, 'content-range': `bytes ${from}-${to}/${body.length}`, 'accept-ranges': 'bytes', 'content-length': String(to - from + 1) } });
    }
    return new Response(body, { headers: { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': String(body.length) } });
  }
  if (/googleapis\.com/.test(url)) return Response.json({ items: [], messages: [], members: [], files: [] });
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url)) throw new Error(`test-board-family-map: unexpected outside call ${url}`);
  return realFetch(input, init);
};
_resetKeyCacheForTests();

const ROUTES = { '/api/board-portal': boardPortal, '/api/board-file': boardFile };
const csp = (() => {
  const lines = readFileSync(join(ROOT, 'public/_headers'), 'utf8').split('\n');
  const at = lines.findIndex((l) => l.trim() === '/admin/*');
  return lines.slice(at + 1).find((l) => /^\s+Content-Security-Policy:/.test(l)).split('Content-Security-Policy:')[1].trim();
})();
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.mjs': 'text/javascript' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const who = req.headers['x-test-user'] || '';
    if (url.pathname === '/cdn-cgi/access/get-identity') { res.writeHead(who ? 200 : 401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(who ? { email: who, name: '' } : {})); return; }
    if (url.pathname.startsWith('/cdn-cgi/imagedelivery/')) { res.writeHead(200, { 'Content-Type': pics.length ? 'image/jpeg' : 'image/png' }); res.end(pics.length ? picFor(url.pathname.split('/')[4] || url.pathname) : PNG); return; }
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !['host', 'connection', 'content-length'].includes(k)) headers.set(k, v);
      if (who) headers.set('CF-Access-JWT-Assertion', await tokenFor(who));
      const request = new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks), duplex: 'half' });
      const ctx = { request, env, data: {}, waitUntil: () => {} };
      ctx.next = async () => {
        const fn = ROUTES[url.pathname]?.[`onRequest${req.method[0]}${req.method.slice(1).toLowerCase()}`];
        return fn ? fn(ctx) : Response.json({ success: true, ok: true, items: [], pages: 1, files: [], entries: [] });
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
// SERVE=<port>: the page stays up on made-up families, to look at or to hand a tester (send x-test-user: kim.board@example.com)
await new Promise((r) => server.listen(Number(process.env.SERVE) || 0, '127.0.0.1', r));
const SITE = `http://localhost:${server.address().port}`;
const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-gpu', '--disable-gpu-vsync', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'] });
const consoleErrors = [];
const GRAY = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mPw8PAAAAMkAVHY5VgwAAAAAElFTkSuQmCC', 'base64');
async function tab(email, width = 1440, height = 900) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: width < 600, hasTouch: width < 600 });
  await page.setExtraHTTPHeaders({ 'x-test-user': email });
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|x-test-user/.test(m.text())) consoleErrors.push(`${email} ${width}: ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`${email} ${width}: ${e.message}`));
  if (!process.env.REAL_TILES) {
    await page.setRequestInterception(true);
    page.on('request', (r) => (/tile\.openstreetmap\.org/.test(r.url()) ? r.respond({ status: 200, contentType: 'image/png', body: GRAY, headers: { 'Access-Control-Allow-Origin': '*' } }) : r.continue()));
  }
  await answerAsks(page);
  return page;
}
const textOf = (page, sel) => page.$eval(sel, (e) => e.innerText.replace(/ /g, ' ')).catch(() => '');
const overflow = (page) => page.evaluate(() => {
  const w = document.documentElement.clientWidth;
  let worst = document.scrollingElement.scrollWidth - w;
  const held = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) if (/auto|scroll|hidden|clip/.test(getComputedStyle(p).overflowX)) return true; return false; };
  for (const e of document.querySelectorAll('main *')) { const r = e.getBoundingClientRect(); if (r.width && r.right - w > worst && getComputedStyle(e).position !== 'fixed' && !held(e)) worst = r.right - w; }
  return Math.round(worst);
});
const shot = async (page, name, sel = null) => {
  if (sel) { const el = await page.$(sel); if (!el) return; await el.evaluate((e) => e.scrollIntoView({ block: 'center' })); await sleep(350); await el.screenshot({ path: join(OUT, `${name}.png`) }); } else { await page.screenshot({ path: join(OUT, `${name}.png`) }); }
};
async function axe(page, sel, label) {
  await sleep(300);
  await page.evaluate(AXE);
  // (axe's experimental label rule: the shared video card says "3 seconds" aloud for the "0:03" it shows, on purpose)
  const r = await page.evaluate(async (s) => (await window.axe.run(document.querySelector(s), { resultTypes: ['violations'], rules: { 'label-content-name-mismatch': { enabled: false } } })).violations.map((v) => `${v.id} (${v.nodes.length}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 2).join(' | ')})`), sel);
  ok(r.length === 0, `axe: no violations on ${label}${r.length ? `: ${r.join(', ')}` : ''}`);
}
const pinsNow = (page) => page.$$eval('.fm-map .apl-pin', (p) => p.map((e) => getComputedStyle(e).getPropertyValue('--c').trim()));
const openHome = async (page) => {
  await page.goto(`${SITE}/admin/board/#/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#makeovers .lc-track', { timeout: 10000 });
  await page.$eval('#makeovers', (e) => e.scrollIntoView({ block: 'start' }));
  await sleep(500);
};
// Home's card on a season's map (`season`: its button's words)
const openHomeMap = async (page, season = String(YEAR)) => {
  await openHome(page);
  await page.evaluate((y) => [...document.querySelectorAll('#makeovers .lc-seasons button')].find((b) => b.textContent === y).click(), season);
  await page.evaluate(() => [...document.querySelectorAll('#makeovers .lc-views button')].find((b) => b.textContent === 'Map').click());
  await page.waitForSelector('.fm-map .apl-pin', { timeout: 10000 });
  await sleep(600);
};
const closeViewer = async (page) => { await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.fv-root, .fv'), { timeout: 3000 }).catch(() => {}); await sleep(150); };

try {
  // A real little video: the browser records one, and JobTread's fake CDN serves it
  {
    const p = await tab(MEMBER, 800, 600);
    await p.goto(`${SITE}/admin/board/`, { waitUntil: 'domcontentloaded' });
    const b64 = await p.evaluate(() => new Promise((done) => {
      const c = document.createElement('canvas'); c.width = 320; c.height = 180;
      const x = c.getContext('2d');
      const rec = new MediaRecorder(c.captureStream(15), { mimeType: 'video/webm' });
      const parts = [];
      rec.ondataavailable = (e) => parts.push(e.data);
      rec.onstop = async () => { const buf = new Uint8Array(await new Blob(parts).arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode(...buf.subarray(i, i + 8192)); done(btoa(s)); };
      rec.start();
      let n = 0;
      const t = setInterval(() => { x.fillStyle = `hsl(${(n += 12) % 360} 60% 60%)`; x.fillRect(0, 0, 320, 180); if (n > 200) { clearInterval(t); rec.stop(); } }, 60);
    }));
    VIDEO = Buffer.from(b64, 'base64');
    ok(VIDEO.length > 1000, `a little video to play (${VIDEO.length} bytes)`);
    await p.close();
  }
  if (process.env.SERVE) { console.log(`Serving ${SITE}/admin/board/`); await new Promise(() => {}); }

  console.log('Home, a board member, 1440px: the makeovers from application to reveal');
  const kim = await tab(MEMBER);
  await openHome(kim);
  await kim.waitForSelector('#makeovers #lc-col-applying .lc-row', { timeout: 8000 });
  await sleep(400);
  const homeSections = await kim.$$eval('.bp-home > *', (els) => els.map((e) => (e.querySelector('[id]') || e).id || e.className));
  ok((await kim.$('#costs')) === null, 'what makeovers cost has moved off Home');
  ok((await kim.$('#applications')) === null && homeSections.filter((x) => x === 'makeovers').length === 1, `one Makeovers card, the applications and the builds together (${homeSections.join(', ')})`);
  const steps = await kim.$$eval('#makeovers .lc-step', (l) => l.map((e) => `${e.querySelector('b').textContent} ${e.querySelector('span').textContent}`));
  ok(steps.join(' | ') === '4 Applied | 1 In review | 4 Approved | 1 Awaiting funding | 1 Design | 0 Approval | 1 Mobilization | 2 Build | 2 Revealed', `every step and how many are at it (${steps.join(' | ')})`);
  ok(/^Open until /.test(await textOf(kim, '#makeovers .lc-phase.is-applying small')), 'the application’s window over its two steps');
  ok(/5 families applying for \d{4} · 9 makeovers being built · 2 revealed/.test(await textOf(kim, '#makeovers .lc-sum')), `now in a line (${await textOf(kim, '#makeovers .lc-sum')})`);
  const cols = await kim.$$eval('#makeovers .lc-col .bk-col__head > span:first-child', (l) => l.map((e) => e.textContent));
  ok(cols.join(',') === 'Applying,Approved,Awaiting funding,Design,Mobilization,Build,Revealed', `a column for each step someone’s at, in the way’s order (${cols.join(', ')})`);
  ok(await kim.$eval('#makeovers .lc-board', (b) => b.scrollWidth <= b.clientWidth + 1), 'all seven fit a laptop, Revealed in view');
  ok(/In review/.test(await textOf(kim, '#lc-col-applying')) && /Applied/.test(await textOf(kim, '#lc-col-applying')), 'the application’s two in one column, each row saying which');
  const build = await textOf(kim, '#lc-col-build');
  ok(/Max/.test(build) && /Reveal .+ 4 PM/.test(build), `those being built on their page’s photo, with their reveal (${build.replace(/\s+/g, ' ')})`);
  ok(/Ruby/.test(build) && (await kim.$eval('#lc-col-build a[href="/kids/ruby/"]', (a) => a.target)) === '_blank', 'a makeover from before the applications is there too, opening its kid page');
  ok(/Sam Example/.test(await textOf(kim, '#lc-col-revealed')) && /Tia Example/.test(await textOf(kim, '#lc-col-revealed')), 'revealed: a closed job, and a job JobTread calls done');
  ok(/Ava Example/.test(await textOf(kim, '#lc-col-funding')), 'awaiting funding, by the family’s name until their page is up');
  ok(!(await textOf(kim, '#makeovers')).includes('TEST Applicant') && !(await textOf(kim, '#makeovers')).includes('Sample Child'), 'never a TEST family, nor a website test run with an ordinary name');
  await shot(kim, 'home-makeovers-1440', '#makeovers');
  await axe(kim, '#makeovers', 'the Makeovers card');
  // A step on the track brings its column round
  await kim.evaluate(() => [...document.querySelectorAll('#makeovers .lc-step__go')].find((b) => /Revealed/.test(b.textContent)).click());
  await sleep(300);
  ok(await kim.$eval('#lc-col-revealed', (c) => c.classList.contains('is-picked') && c.contains(document.activeElement)), 'a step on the track takes you to its column');
  // A card opens the family, on their way
  await kim.click('#lc-col-build a[href="#/families/acctMax001"]');
  await kim.waitForSelector('.lc-journey', { timeout: 8000 });
  await sleep(400);
  ok(/Build/.test(await textOf(kim, '.lc-journey [aria-current="step"]')), 'a card opens the family, where they are lit on their way');
  ok(await kim.$$eval('.lc-journey .lc-j.is-done', (l) => l.length) === 7, 'the steps behind them ticked');
  ok(/Revealed\s*\w{3} \d+, \d{4}/.test(await textOf(kim, '.lc-journey .lc-j:last-child')), 'and the day of their reveal');
  await shot(kim, 'family-journey-1440', '.lc-journey');
  // The application closes: its two steps say so, and the families still being decided stay
  await DB.prepare("UPDATE site_config SET data = ? WHERE key = 'settings'").bind(JSON.stringify({ application: { open: false, year: String(YEAR), opensAt: `${day(120)}T09:00:00-05:00` } })).run();
  await openHome(kim);
  await kim.waitForSelector('#makeovers #lc-col-applying .lc-row', { timeout: 8000 });
  ok(/^Opens /.test(await textOf(kim, '#makeovers .lc-phase.is-applying small')), 'closed, the application says when it opens next');
  ok(/5 families applying/.test(await textOf(kim, '#makeovers .lc-sum')), 'and those still being decided stay on');
  await kim.evaluate((y) => [...document.querySelectorAll('#makeovers .lc-seasons button')].find((b) => b.textContent === y).click(), String(YEAR - 1));
  await sleep(400);
  ok(!(await kim.$('#lc-col-applying')) && !(await kim.$('#lc-col-applied')) && !(await kim.$('#makeovers .lc-phase.is-applying small')), 'a season with nobody applying has no application column, and no window');
  await DB.prepare("UPDATE site_config SET data = ? WHERE key = 'settings'").bind(JSON.stringify({ application: { open: true, year: String(YEAR), closesAt: `${day(60)}T23:59:00-05:00` } })).run();

  console.log('Home, the map');
  await openHomeMap(kim);
  const sum = await textOf(kim, '#makeovers .lc-sum');
  ok(/5 families applying · 2 makeovers being built · 1 not chosen/.test(sum), `the season in a line (${sum})`);
  ok(!(await textOf(kim, '#makeovers')).includes('TEST Applicant'), 'a TEST family is never on the map');
  ok(!(await textOf(kim, '#makeovers')).includes('Sample Child'), 'nor a website test run with an ordinary name');
  const pins = await pinsNow(kim);
  await shot(kim, 'home-map-1440', '#makeovers');
  ok(pins.length > 4, `a pin for each family with a home (${pins.length})`);
  const legend = await textOf(kim, '#makeovers .apl-legend');
  ok(/Applied\s*3/.test(legend) && /In review\s*1/.test(legend) && /Building\s*2/.test(legend) && /Not chosen\s*1/.test(legend) && /No status\s*1/.test(legend) && !/Revealed/.test(legend) && /Service area · 2 outside/.test(legend), `the key: each step’s color, how many, the area (${legend.replace(/\s+/g, ' ')})`);
  ok(/1 family has no home in JobTread yet/.test(legend), 'and who isn’t on the map');
  // The map opens on the area, with the family 97 miles out a tap away, and the key off the area
  const inFrame = () => kim.evaluate(() => {
    const k = document.querySelector('.fm-stage .apl-legend').getBoundingClientRect();
    const a = document.querySelector('.fm-map path.leaflet-interactive, .fm-map svg path').getBoundingClientRect();
    const b = [...document.querySelectorAll('.fm-map svg path')].map((p) => p.getBoundingClientRect());
    const m = document.querySelector('.fm-map').getBoundingClientRect();
    return { clear: b.every((r) => r.left >= k.right - 2 || r.top >= k.bottom), wide: Math.max(...b.map((r) => r.width)), map: m.width, a: a.width };
  });
  const f1 = await inFrame();
  ok(f1.clear, 'the service area sits clear of the key');
  ok(f1.wide > f1.map * 0.35, `the area fills the map (${Math.round(f1.wide)}px of ${Math.round(f1.map)}px)`);
  ok(/Show 1 farther out/.test(await textOf(kim, '.fm-far')), 'the family 97 miles out is a tap away');
  await kim.click('.fm-far');
  await sleep(700);
  ok(/Back to the service area/.test(await textOf(kim, '.fm-far')), 'and the map comes back the same way');
  await kim.click('.fm-far');
  await sleep(700);
  ok(Math.abs((await inFrame()).wide - f1.wide) < 2, 'to the same picture');
  await shot(kim, 'home-map-1440', '#makeovers');

  // A row lights its pin, a pin its row
  await kim.hover('.fm-row[data-id="acctIris01"]');
  await sleep(120);
  ok((await kim.$$('.fm-map .apl-pin.is-focus')).length === 1, 'hovering a row lights its pin');
  await kim.mouse.move(5, 5);
  await sleep(120);
  ok((await kim.$$('.fm-map .apl-pin.is-focus')).length === 0, 'and only while it’s there');
  const pin = await kim.$('.fm-map .leaflet-marker-icon');
  await pin.hover();
  await sleep(250);
  ok(await kim.$('.fm-row.is-hot'), 'hovering a pin lights its row');
  ok(await kim.$('.leaflet-tooltip.fm-tip'), 'and says who it is');
  await kim.mouse.move(5, 5);

  // A row opens the family, in the list's place
  await kim.click('.fm-row[data-id="acctIris01"]');
  await kim.waitForSelector('.fm-card .fv-tile', { timeout: 5000 });
  await sleep(450);
  ok((await kim.$('.fm-list')) === null, 'the family takes the list’s place');
  ok(await kim.evaluate(() => document.activeElement?.classList.contains('fm-card__name')), 'the keyboard goes with them');
  ok((await kim.$$('.fm-map .apl-pin.is-focus')).length === 1, 'their pin stays lit');
  const cardText = await textOf(kim, '.fm-card');
  ok(/Iris Example/.test(cardText) && /Approved/.test(cardText) && /Therapy Room, Bathroom/.test(cardText) && /Roswell, Fulton County/.test(cardText) && /Inside/.test(cardText), `what they asked for and where (${cardText.replace(/\s+/g, ' ').slice(0, 120)})`);
  ok(/Read the application/.test(cardText), 'the application a tap away');
  ok(!/Notes|Drawing|Page\.html/i.test(cardText), 'never staff’s notes');
  const links = await kim.$$eval('.fm-card a', (a) => a.map((e) => e.getAttribute('href') || ''));
  ok(!links.some((h) => /cdn\.jobtread|fNotes|fSvg|fHtml/.test(h)), 'no JobTread link and nothing but the application, video and photos');
  ok(!(await kim.content()).includes('cdn.jobtread.com'), 'JobTread’s address is nowhere on the page');
  ok((await kim.$$('.fm-card .bm-photo')).length === 4, 'the four photos');
  ok((await kim.$$eval('.fm-card .bm-cap', (c) => c.map((e) => e.textContent))).join() === 'Child,Family,Space 1,Space 2', 'labeled, in the form’s order');
  await shot(kim, 'home-family-1440', '#makeovers');
  await axe(kim, '#makeovers', 'the map with a family open');

  // The video, in the viewer
  await kim.click('.fm-card .fv-tile');
  await kim.waitForSelector('video.fv-video', { timeout: 5000 });
  const vsrc = await kim.$eval('video.fv-video', (v) => v.getAttribute('src'));
  ok(/^\/api\/board-file\?family=acctIris01&file=fVideo1$/.test(vsrc), `the video comes through the board’s own route (${vsrc})`);
  await kim.waitForFunction(() => document.querySelector('video.fv-video')?.readyState >= 1, { timeout: 8000 }).catch(() => {});
  ok(await kim.$eval('video.fv-video', (v) => v.readyState >= 1 && !v.error), 'and it plays');
  await shot(kim, 'viewer-video-1440');
  await closeViewer(kim);
  ok(await kim.$('.fm-card'), 'closing it comes back to the family');
  // A photo
  await kim.click('.fm-card .bm-photos li:nth-child(2) .bm-photo');
  await kim.waitForSelector('.fv-img, img.fv-photo, .fv-stage img', { timeout: 5000 });
  await closeViewer(kim);
  // The application
  await kim.click('.fm-card__read');
  await kim.waitForSelector('canvas', { timeout: 10000 });
  await sleep(600);
  await shot(kim, 'viewer-pdf-1440');
  await closeViewer(kim);
  // Back: the row they came from, with the keyboard
  await kim.keyboard.press('Tab');
  await kim.focus('.fm-back');
  await kim.keyboard.press('Enter');
  await kim.waitForSelector('.fm-list', { timeout: 3000 });
  await sleep(100);
  ok(await kim.evaluate(() => document.activeElement?.dataset?.id === 'acctIris01'), 'back to the row they came from');
  // Esc from a family
  await kim.click('.fm-row[data-id="acctJay001"]');
  await kim.waitForSelector('.fm-card', { timeout: 3000 });
  await sleep(300);
  await kim.keyboard.press('Escape');
  await kim.waitForSelector('.fm-list', { timeout: 3000 });
  ok(true, 'Esc closes a family too');

  // The key switches a status off, on the map and in the list
  const before = (await pinsNow(kim)).length;
  await kim.evaluate(() => [...document.querySelectorAll('.apl-legend button')].find((b) => /Not chosen/.test(b.textContent)).click());
  await sleep(200);
  ok((await pinsNow(kim)).length === before - 1, 'the key takes a step off the map');
  ok(!/Omar Example/.test(await textOf(kim, '.fm-side')), 'and out of the list');
  ok(!(await kim.$('.fm-far')), 'and the button for the far family goes with them');
  await kim.evaluate(() => [...document.querySelectorAll('.apl-legend button')].find((b) => /Not chosen/.test(b.textContent)).click());
  await sleep(200);

  // The wheel goes on down the page; with ⌘/Ctrl it zooms
  const zoomNow = () => kim.$eval('.fm-map .leaflet-tile-container img', (i) => Number(i.src.match(/\/(\d+)\/\d+\/\d+\.png/)?.[1]));
  // (room below to go down to: Home ends on this card)
  await kim.evaluate(() => window.scrollBy(0, -300));
  await sleep(300);
  const box = await (await kim.$('.fm-map')).boundingBox();
  await kim.mouse.move(box.x + box.width / 2, Math.max(box.y + 40, Math.min(box.y + box.height / 2, 860)));
  const y0 = await kim.evaluate(() => scrollY);
  const z0 = await zoomNow();
  await kim.mouse.wheel({ deltaY: 200 });
  await sleep(450);
  ok((await kim.evaluate(() => scrollY)) > y0, 'the wheel goes on down the page');
  ok((await zoomNow()) === z0, 'and leaves the map alone');
  const box2 = await (await kim.$('.fm-map')).boundingBox();
  await kim.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await kim.keyboard.down('Control');
  await kim.mouse.wheel({ deltaY: -120 });
  await kim.keyboard.up('Control');
  await sleep(900);
  ok((await zoomNow()) === z0 + 1, `Ctrl and the wheel zoom (${z0} → ${await zoomNow()})`);

  // Another season
  await kim.evaluate((y) => [...document.querySelectorAll('#makeovers .lc-seasons button')].find((b) => b.textContent === y).click(), String(YEAR - 1));
  await sleep(500);
  ok(/Ana Example|Cal Example|Max Example/.test(await textOf(kim, '.fm-side')), 'the season switch changes who’s on it');
  ok((await pinsNow(kim)).length === 12, `and the pins (${(await pinsNow(kim)).length})`);
  ok(/Revealed\s*2/.test(await textOf(kim, '#makeovers .apl-legend')), 'last season’s reveals in their own color');
  await kim.evaluate(() => [...document.querySelectorAll('#makeovers .lc-seasons button')].find((b) => /Every season/.test(b.textContent)).click());
  await sleep(400);
  ok((await pinsNow(kim)).length === 26, `every season (${(await pinsNow(kim)).length})`);
  ok((await overflow(kim)) <= 0, 'nothing past the screen’s edge');
  await axe(kim, '#makeovers', 'the map');
  await kim.close();

  console.log('Financials and Home');
  const fin = await tab(MEMBER);
  await fin.goto(`${SITE}/admin/board/#/financials`, { waitUntil: 'domcontentloaded' });
  await fin.waitForSelector('.bp-h1', { timeout: 8000 });
  await fin.close();

  console.log('Makeovers, the page');
  const list = await tab(MEMBER);
  await list.goto(`${SITE}/admin/board/#/families`, { waitUntil: 'domcontentloaded' });
  await list.waitForSelector('.bf .lc-board .lc-row', { timeout: 8000 });
  await sleep(400);
  ok(/^Makeovers$/.test(await textOf(list, '.bp-h1')) && (await list.title()).startsWith('Makeovers'), 'the page is Makeovers');
  ok((await list.$$eval('.bf .lc-board .bk-card, .bf .lc-board .lc-row', (l) => l.length)) === 16, 'its board holds everyone now, nobody cut short');
  await shot(list, 'makeovers-board-1440');
  await axe(list, 'main', 'Makeovers → Board');
  await list.evaluate(() => [...document.querySelectorAll('.bf .lc-seasons button')].find((b) => /Every season/.test(b.textContent)).click());
  await sleep(300);
  ok(/not chosen or with no status aren’t on the board/.test(await textOf(list, '.bf')), 'every season: those not chosen or with no status are in the list, and it says so');
  await list.evaluate(() => [...document.querySelectorAll('.bf-view a')].find((a) => a.textContent === 'List').click());
  await list.waitForSelector('.bf-row', { timeout: 8000 });
  await list.evaluate(() => [...document.querySelectorAll('.bf .lc-seasons button')].find((b) => /Every season/.test(b.textContent)).click());
  await sleep(300);
  ok(/No status/.test(await textOf(list, '.bf-chips')) && /No status/.test(await textOf(list, '.bf-list')), 'a family with no status says so, never “Applied”');
  ok(/Not chosen/.test(await textOf(list, '.bf-chips')), 'and one not chosen says that');
  await axe(list, 'main', 'Makeovers → List');
  await list.evaluate(() => [...document.querySelectorAll('.bf-view a')].find((a) => a.textContent === 'Map').click());
  await list.waitForSelector('.fm-map .apl-pin', { timeout: 8000 });
  await sleep(600);
  ok(!!(await list.$('.fm--tall')), 'Map: the same map, taller');
  await shot(list, 'makeovers-map-1440');
  await axe(list, 'main', 'Makeovers → Map');
  // One family, with everything
  await list.goto(`${SITE}/admin/board/#/families/acctIris01`, { waitUntil: 'domcontentloaded' });
  await list.waitForSelector('.fv-tile', { timeout: 8000 });
  await sleep(500);
  const fam = await textOf(list, 'main');
  ok(/What they sent/.test(fam) && /The application/.test(fam) && /At a glance/.test(fam) && /The score/.test(fam), 'a family’s page: what they sent, then the facts and the score');
  ok(/Approved/.test(await textOf(list, '.lc-journey [aria-current="step"]')) && /Applied\s*\w{3} \d+, \d{4}/.test(await textOf(list, '.lc-journey .lc-j:first-child')), 'their way: approved, applied on its day');
  ok(!/Notes|parent@example|4045550100|12 Elm/.test(fam), 'no staff notes, and the page itself shows no contact details');
  ok(/in confidence/.test(fam), 'with a word about keeping it private');
  await shot(list, 'family-full-1440');
  await axe(list, 'main', 'a family’s page');
  await list.evaluate(() => { document.querySelector('.fv-tile').scrollIntoView({ block: 'center' }); });
  ok(await list.$('a[href="#/families/map/acctIris01"]'), 'Show on the map');
  await list.click('a[href="#/families/map/acctIris01"]');
  await list.waitForSelector('.fm-card .fm-card__name', { timeout: 8000 });
  await sleep(600);
  ok(/Iris Example/.test(await textOf(list, '.fm-card__name')), 'Show on the map opens them on it');
  // No video
  await list.goto(`${SITE}/admin/board/#/families/acctJay001`, { waitUntil: 'domcontentloaded' });
  await list.waitForSelector('.bm-paper', { timeout: 8000 });
  await sleep(400);
  ok(/No video on file/.test(await textOf(list, '.bm')), 'no video says so');
  await shot(list, 'family-novideo-1440');
  // A video and no PDF, and a photo JobTread made no thumbnail of
  const miaAsked = [];
  const onMia = (r) => miaAsked.push(r.url());
  list.on('request', onMia);
  await list.goto(`${SITE}/admin/board/#/families/acctMia001`, { waitUntil: 'domcontentloaded' });
  await list.waitForSelector('.fv-tile', { timeout: 8000 });
  await sleep(600);
  list.off('request', onMia);
  ok(!!(await list.$('.bm-photo .bm-mark')) && !miaAsked.some((u) => /file=fMiaFam(?!.*size=)/.test(u)), 'a photo with no thumbnail shows a picture mark; the photo itself waits to be opened');
  ok(/No application on file/.test(await textOf(list, '.bm')), 'no application says so');
  ok(!(await list.content()).match(/fMiaCam|fMiaId|fMiaLet|fMiaAid/), 'a license, a doctor’s letter, a Medicaid application and a camera’s video stay with staff');
  await shot(list, 'family-nopdf-1440');
  // Nothing at all
  await list.goto(`${SITE}/admin/board/#/families/acctNora01`, { waitUntil: 'domcontentloaded' });
  await list.waitForSelector('.bm', { timeout: 8000 });
  await sleep(200);
  ok(/no video, photos or application on file/.test(await textOf(list, '.bm')), 'nothing on file says so');
  // From the website, not in JobTread yet
  await list.goto(`${SITE}/admin/board/#/families/acctForm01`, { waitUntil: 'domcontentloaded' });
  await list.waitForSelector('.bm-paper', { timeout: 8000 });
  await sleep(300);
  ok(/still being processed/.test(await textOf(list, '.bm')) && (await list.$$('.bm-photo')).length === 1, 'a website family before JobTread has it: the site’s copy, and the video on its way');
  // JobTread down: what was read stays; a family never read says so
  jobtreadDown = true;
  await list.goto(`${SITE}/admin/board/#/families/acctIris01`, { waitUntil: 'domcontentloaded' });
  await list.waitForSelector('.bm', { timeout: 8000 });
  await sleep(300);
  ok(!!(await list.$('.fv-tile')), 'JobTread down: what was read a moment ago still shows');
  await DB.prepare("DELETE FROM board_state WHERE key = 'family-files:acctMia001'").run();
  await list.goto(`${SITE}/admin/board/#/families/acctMia001`, { waitUntil: 'domcontentloaded' });
  await list.waitForSelector('.bm', { timeout: 8000 });
  await sleep(300);
  ok(/can’t be reached right now/.test(await textOf(list, '.bm')), 'and a family never read says it can’t be reached');
  jobtreadDown = false;
  await list.close();

  console.log('Who can reach a file');
  const ask = async (who, path) => {
    const p = await tab(who, 800, 600);
    await p.goto(`${SITE}/admin/board/`, { waitUntil: 'domcontentloaded' });
    const st = await p.evaluate(async (u) => (await fetch(u)).status, path);
    await p.close();
    return st;
  };
  ok((await ask(MEMBER, '/api/board-file?family=acctIris01&file=fPdf001')) === 200, 'a board member opens the application');
  ok((await ask(MEMBER, '/api/board-file?family=acctIris01&file=fNotes1')) === 404, 'never staff’s notes, even with the address');
  ok((await ask(MEMBER, '/api/board-file?family=acctIris01&file=fSvg001')) === 404, 'nor a file a browser could run');
  ok((await ask(MEMBER, '/api/board-file?family=acctMia001&file=fMiaId')) === 404, 'nor a driver’s license sitting on the account');
  ok((await ask(MEMBER, '/api/board-file?family=acctTest01&file=fPdf001')) === 404, 'nor anything of a TEST family');
  ok((await ask(MEMBER, '/api/board-file?family=acctRun001&face=1')) === 404, 'nor a website test run');
  const stranger = await ask('someone@example.com', '/api/board-file?family=acctIris01&file=fPdf001');
  ok(stranger >= 400, `someone not on the board gets nothing (${stranger})`);

  console.log('A phone, 390px');
  const phone = await tab(MEMBER, 390, 844);
  await openHome(phone);
  await sleep(300);
  ok((await overflow(phone)) <= 0, 'nothing past the phone’s edge');
  const phases = await phone.$$eval('#makeovers .lc-phase__n', (l) => l.map((e) => e.textContent));
  ok(phases.join(',') === '5,9,2', `a phone’s track: how many on each stretch of the way (${phases.join(',')})`);
  ok(await phone.$eval('#makeovers .lc-steps', (e) => getComputedStyle(e).display === 'none'), 'each step counted in its column instead');
  await shot(phone, 'home-makeovers-390', '#makeovers');
  await axe(phone, '#makeovers', 'the Makeovers card on a phone');
  await openHomeMap(phone);
  ok((await overflow(phone)) <= 0, 'the map, nothing past the edge');
  await shot(phone, 'home-map-390', '#makeovers');
  const seen = () => phone.$$eval('.fm-list > li', (l) => l.filter((e) => getComputedStyle(e).display !== 'none').length);
  ok((await seen()) === 6, 'the first six, so Home stays short');
  ok(/Show all 9/.test(await textOf(phone, '.fm-all')), 'and the rest a tap away');
  await phone.tap('.fm-all');
  await sleep(150);
  ok((await seen()) === 9, 'all nine');
  await phone.evaluate(() => document.querySelector('.fm-map').scrollIntoView({ block: 'center' }));
  await sleep(300);
  await (await phone.$('.fm-map .leaflet-marker-icon')).tap();
  await phone.waitForSelector('.fm-card', { timeout: 5000 });
  await sleep(900);
  await shot(phone, 'home-family-390', '.fm-side');
  ok((await overflow(phone)) <= 0, 'a family open, nothing past the edge');
  await axe(phone, '#makeovers', 'the map on a phone');
  await phone.goto(`${SITE}/admin/board/#/families/acctIris01`, { waitUntil: 'domcontentloaded' });
  await phone.waitForSelector('.fv-tile', { timeout: 8000 });
  await sleep(500);
  ok((await overflow(phone)) <= 0, 'a family’s page fits a phone');
  await phone.screenshot({ path: join(OUT, 'family-full-390.png'), fullPage: true });
  await axe(phone, 'main', 'a family’s page on a phone');
  await phone.close();

  console.log('Every width');
  for (const w of [320, 360, 390, 430, 600, 640, 768, 820, 899, 900, 1024, 1100, 1180, 1280, 1440, 1920]) {
    const p = await tab(MEMBER, w, w < 600 ? 800 : 860);
    await openHome(p);
    await p.waitForSelector('#makeovers #lc-col-applying .lc-row', { timeout: 8000 });
    const o = await overflow(p);
    const first = await p.$eval('#makeovers .lc-board', (b) => { const c = b.querySelector('.lc-col').getBoundingClientRect(); const r = b.getBoundingClientRect(); return c.left >= r.left - 1 && c.width > 120; });
    await openHomeMap(p);
    const o2 = await overflow(p);
    const m = await p.$eval('.fm-map', (e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
    ok(o <= 0 && o2 <= 0 && first && m[0] > 240 && m[1] > 240, `${w}px: the board fits from its start, the map ${m[0]}×${m[1]}`);
    await p.close();
  }
} catch (err) {
  failures.push(err.stack || err.message);
  console.error(err);
} finally {
  await browser.close();
  server.close();
}
if (consoleErrors.length) { failures.push(...consoleErrors); console.log(consoleErrors.join('\n')); }
console.log(failures.length ? `\n${failures.length} failed:\n${failures.join('\n')}` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
