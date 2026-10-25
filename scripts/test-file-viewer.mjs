/**
 * test-file-viewer.mjs — drive the admin's file viewer (public/admin/file-viewer.js) in a browser
 * ===============================================================================================
 * The Applicants module on the admin-shell harness (like test-applicants-admin.mjs), with the
 * admin's real Content-Security-Policy from public/_headers on every /admin/ response, the real
 * /api/applicants-admin and /api/applications-admin handlers on an in-memory D1, R2 and JobTread,
 * and real files: JPEG photos, a two-page PDF in Helvetica (pdf-lib, like our application PDF),
 * a WebM recorded in the browser, a Word file and one photo that's gone.
 *
 * Checks, at 1440px and on a 390px phone:
 *   - a photo, a PDF, a video, a message attachment and the application open over the drawer,
 *     never in a new tab; ⌘/Ctrl-click still opens a new tab
 *   - photos: keys, buttons, double-click zoom, drag to pan, fit; the strip and ← / →
 *   - PDFs: pdf.js draws both pages under the admin CSP (worker, fonts), selectable text,
 *     page count, zoom; its stylesheet leaves the admin's sidebar alone
 *   - videos play with nothing drawn on the picture
 *   - a Word file and a missing photo say so, with Download; Download saves under the file's name
 *   - Esc and Back close it, the drawer stays open, focus goes back to what opened it
 *   - the website form's photos, PDF and video; a Jotform-era family's "Read the application"
 *   - phone: full screen, arrows under the picture, a swipe steps, nothing wider than the screen
 *   - no axe violations, no console errors or CSP violations
 * Screenshots in test-results/file-viewer/. Exits non-zero on failure.
 *
 *   node scripts/test-file-viewer.mjs
 */
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, existsSync, statSync, rmSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import { fakeApplicantWorld, ORG } from '../tests/lib/fake-applicant-world.mjs';
import * as api from '../functions/api/applicants-admin.js';
import * as formsApi from '../functions/api/applications-admin.js';
import { FIELDS } from '../functions/api/_applicants.js';
import { ensureSchema } from '../functions/api/_applications.js';
import { clearFormCache } from '../functions/api/_application-forms.js';
import { axeScan, axeText } from './lib/axe.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/file-viewer/');
const DOWNLOADS = join(OUT, 'downloads');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(DOWNLOADS, { recursive: true });
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Files ──
const grid = (w, h, label, hue) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <rect width="100%" height="100%" fill="hsl(${hue},45%,62%)"/>
  ${Array.from({ length: 12 }, (_, i) => `<line x1="${(i * w) / 12}" y1="0" x2="${(i * w) / 12}" y2="${h}" stroke="#fff" stroke-width="4"/>`).join('')}
  <text x="50%" y="52%" font-size="${Math.round(h / 9)}" text-anchor="middle" font-family="Helvetica" fill="#1A1B1F">${label}</text></svg>`);
const jpeg = (w, h, label, hue) => sharp(grid(w, h, label, hue)).jpeg({ quality: 82 }).toBuffer();
const pdfDoc = await PDFDocument.create();
const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
for (const [i, line] of ['Avery Stone application', 'Page two: the bedroom'].entries()) {
  const pg = pdfDoc.addPage([612, 792]);
  pg.drawText(line, { x: 72, y: 700, size: 24, font: helv, color: rgb(0.1, 0.1, 0.12) });
  pg.drawText(`Page ${i + 1} of 2. Jordan Stone, 404-555-0100.`, { x: 72, y: 660, size: 12, font: helv });
}
const PDF = Buffer.from(await pdfDoc.save());
const BODIES = {
  child: { type: 'image/jpeg', body: await jpeg(2400, 1600, 'Avery', 210) },
  family: { type: 'image/jpeg', body: await jpeg(1600, 2000, 'Family', 30) },
  space: { type: 'image/jpeg', body: await jpeg(2000, 1500, 'Bedroom', 120) },
  pdf: { type: 'application/pdf', body: PDF },
  docx: { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', body: Buffer.from('PK not really a docx') },
};
const THUMB = await jpeg(600, 400, 'thumb', 0);

// ── JobTread (fake): Avery's account with everything, and a Jotform-era family ──
const w = fakeApplicantWorld();
globalThis.fetch = w.fetchImpl;
const F = Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, f.id]));
const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
const APP_ID = 'app-avery001-a1b2c3';
const avery = {
  id: 'acctavery001', name: 'Avery Stone', type: 'customer', org: ORG, createdAt: day(5),
  fields: { [F.status]: 'Applied', [F.year]: '2027', [F.types]: ['Bedroom'], [F.diagnosis]: 'Cerebral palsy', [F.birthday]: '2016-04-12', '22P4v2gNtdFR': `https://sunshineonaranneyday.com/admin/#applications/${APP_ID}` },
  contacts: [{ id: 'av-c1', name: 'Jordan Stone', title: 'Mom', fields: {} }], primaryContactId: 'av-c1',
  locations: [{ id: 'av-l1', address: '101 Maple Dr, Marietta, GA 30062, USA', city: 'Marietta', county: 'Cobb County', latitude: 33.97, longitude: -84.53 }],
  files: [
    { id: 'f-child', name: 'Avery Stone.jpg', type: 'image/jpeg', size: BODIES.child.body.length, createdAt: day(5) },
    { id: 'f-family', name: 'Avery Stone Family.jpg', type: 'image/jpeg', size: BODIES.family.body.length, createdAt: day(5) },
    { id: 'f-gone', name: 'Avery Stone Space 1.jpg', type: 'image/jpeg', size: 1000, createdAt: day(5) },
    { id: 'f-pdf', name: 'Avery Stone_Application.pdf', type: 'application/pdf', size: PDF.length, createdAt: day(5) },
    { id: 'f-video', name: 'Avery Stone_Application.mp4', type: 'video/mp4', size: 90000, createdAt: day(5) },
    { id: 'f-docx', name: 'Therapist letter.docx', type: BODIES.docx.type, size: 23000, createdAt: day(4) },
  ],
  comments: [
    { id: 'av-comms', name: 'Comms Thread', message: 'To send a text message…', pinned: true, by: 'JobTread', createdAt: day(5) },
    { id: 'av-m1', name: 'Application Status', message: 'Jordan Stone\n\nThe application for *Avery Stone* is under review.\n\nA copy of your application is attached to this message for your records.', by: 'Qualification Committee', createdAt: day(5), attachments: [{ id: 'f-pdf2', name: 'Avery Stone_Application.pdf', type: 'application/pdf', size: PDF.length }] },
  ],
  jobs: [],
};
const nora = {
  id: 'acctnora0001', name: 'Nora Kim', type: 'customer', org: ORG, createdAt: day(400),
  fields: { [F.status]: 'In Review', [F.year]: '2027', [F.types]: ['Bathroom'], [F.diagnosis]: 'Spina bifida', [F.birthday]: '2014-02-01', '22P4v2gNtdFR': 'https://www.jotform.com/submission/6123456789' },
  contacts: [], locations: [], comments: [], jobs: [],
  files: [{ id: 'n-pdf', name: 'Nora Kim_Application.pdf', type: 'application/pdf', size: PDF.length, createdAt: day(2) }, { id: 'n-photo', name: 'Nora Kim.jpg', type: 'image/jpeg', size: BODIES.space.body.length, createdAt: day(2) }],
};
w.world.accounts[avery.id] = avery;
w.world.accounts[nora.id] = nora;
const FILE_BODY = { 'f-child': 'child', 'f-family': 'family', 'f-pdf': 'pdf', 'f-pdf2': 'pdf', 'f-docx': 'docx', 'n-pdf': 'pdf', 'n-photo': 'space' };

// ── D1 and R2: Avery's website application (answers, four photos, the PDF) ──
const DB = await createD1();
await DB.exec(`CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)`);
await DB.prepare("INSERT INTO site_config (key, data) VALUES ('settings', ?)").bind(JSON.stringify({ application: { open: true, year: '2027' } })).run();
await DB.exec(`CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)`);
const env = { ...w.env, DB, JOBTREAD_QC_GRANT_KEY: 'qc-grant' };
await ensureSchema(DB);
const photoFiles = {};
for (const [id, src] of [['photoChild', 'child'], ['photoFamily', 'family'], ['photoSpace1', 'space'], ['photoSpace2', 'space']]) {
  await env.FILES.put(`apps/${id}`, BODIES[src].body, { httpMetadata: { contentType: 'image/jpeg' } });
  await env.FILES.put(`apps/${id}.thumb`, THUMB, { httpMetadata: { contentType: 'image/jpeg' } });
  photoFiles[id] = { key: `apps/${id}`, thumbKey: `apps/${id}.thumb`, type: 'image/jpeg', size: BODIES[src].body.length, name: `${id}.jpg` };
}
photoFiles.video = { uid: 'vid1', uploaded: true, duration: 31 };
await env.FILES.put('apps/app.pdf', PDF, { httpMetadata: { contentType: 'application/pdf' } });
const now = new Date().toISOString();
await DB.prepare(`INSERT INTO applications (id, year, child_name, parent_name, parent_email, makeover_types, answers, files, is_test, jt_account_id, jt_state, status, attempts, submitted_at, updated_at)
  VALUES (?, '2027', 'Avery Stone', 'Jordan Stone', 'jordan@example.com', '["Bedroom"]', ?, ?, 0, ?, ?, 'done', 1, ?, ?)`)
  .bind(APP_ID, JSON.stringify({ childName: { first: 'Avery', last: 'Stone' }, parentName: { first: 'Jordan', last: 'Stone' } }), JSON.stringify(photoFiles), avery.id, JSON.stringify({ pdf: { key: 'apps/app.pdf' } }), now, now).run();

// ── The admin's own CSP (JobTread's CDN is cdn.fake here) ──
const headersFile = readFileSync(join(ROOT, 'public/_headers'), 'utf8');
const adminCsp = (headersFile.split('/admin/*')[1].match(/^\s+Content-Security-Policy: (.+)$/m) || [])[1];
const CSP = adminCsp.replaceAll('https://cdn.jobtread.com', 'https://cdn.jobtread.com https://cdn.fake');

// ── A static server for public/, plus the harness page in the admin shell ──
const adminHtml = readFileSync(join(ROOT, 'public/admin/index.html'), 'utf8');
// The admin's stylesheet in <head> (the other <style> blocks in the file sit inside print templates)
const adminStyles = adminHtml.match(/<style[^>]*>([\s\S]*?)<\/style>/)[1];
const shell = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>File viewer harness</title><style>${adminStyles}</style>
<style>body{margin:0;background:var(--color-bg);font-family:Inter,system-ui,sans-serif;color:var(--color-text)}</style></head>
<body><div class="app"><aside class="sidebar"><nav>Sidebar</nav></aside><div class="main"><div id="root"></div></div></div>
<div id="toasts" class="toast-container"></div>
<script type="module">
import { h, render } from './vendor.js';
import { ApplicantsArea } from './applicants.js';
window.__csp = [];
document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
render(h(ApplicantsArea, { addToast: () => {} }), document.getElementById('root'));
</script></body></html>`;
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.ttf': 'font/ttf', '.pfb': 'application/octet-stream', '.json': 'application/json' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const csp = path.startsWith('/admin/') ? { 'content-security-policy': CSP } : {};
  if (path === '/admin/__viewer.html') { res.writeHead(200, { 'content-type': 'text/html', ...csp }); return res.end(shell); }
  const file = join(ROOT, 'public', path);
  if (file.startsWith(join(ROOT, 'public')) && existsSync(file) && statSync(file).isFile()) {
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', ...csp });
    return res.end(readFileSync(file));
  }
  res.writeHead(404); res.end('not found');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${server.address().port}`;

// Frames on Chrome's own clock, not the display's: with the Mac's display asleep, canvas recording and
// requestAnimationFrame otherwise stop and the run hangs
const browser = await puppeteer.launch({ headless: true, args: ['--disable-gpu', '--disable-gpu-vsync', '--disable-frame-rate-limit', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--autoplay-policy=no-user-gesture-required'] });

// A short WebM, recorded in the browser (no ffmpeg needed): the "video" JobTread serves
const rec = await browser.newPage();
const WEBM = Buffer.from(await rec.evaluate(async () => {
  const c = Object.assign(document.createElement('canvas'), { width: 320, height: 240 });
  const g = c.getContext('2d');
  const r = new MediaRecorder(c.captureStream(24), { mimeType: 'video/webm' });
  const parts = [];
  r.ondataavailable = (e) => parts.push(e.data);
  r.start();
  const t0 = performance.now();
  // A timer, not requestAnimationFrame: frames stop while the Mac's display sleeps
  await new Promise((done) => { const tick = () => { const t = performance.now() - t0; g.fillStyle = `hsl(${t / 5},60%,55%)`; g.fillRect(0, 0, 320, 240); if (t < 1500) setTimeout(tick, 40); else done(); }; tick(); });
  r.stop();
  await new Promise((d) => { r.onstop = d; });
  return [...new Uint8Array(await new Blob(parts).arrayBuffer())];
}));
await rec.close();
BODIES.video = { type: 'video/webm', body: WEBM };
FILE_BODY['f-video'] = 'video';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'content-disposition' };
async function answer(req) {
  const url = new URL(req.url());
  if (url.host === 'cdn.fake') {
    const id = url.pathname.slice(1);
    const kind = FILE_BODY[id];
    if (!kind) return req.respond({ status: 404, headers: CORS, body: 'gone' });
    if (url.searchParams.get('size')) return id === 'f-docx' ? req.respond({ status: 404, headers: CORS, body: '' }) : req.respond({ status: 200, contentType: 'image/jpeg', headers: CORS, body: THUMB });
    return req.respond({ status: 200, contentType: BODIES[kind].type, headers: { ...CORS, 'Content-Disposition': 'inline' }, body: BODIES[kind].body });
  }
  if (url.pathname === '/api/applicants-admin' || url.pathname === '/api/applications-admin') {
    clearFormCache();
    const request = new Request(`https://admin.test${url.pathname}${url.search}`, { method: req.method(), body: req.method() === 'POST' ? req.postData() : undefined, headers: { 'content-type': 'application/json' } });
    const ctx = { env, request, data: { userEmail: 'linzi@soardcharity.com' }, waitUntil: () => {} };
    const mod = url.pathname === '/api/applicants-admin' ? api : formsApi;
    const res = req.method() === 'POST' ? await mod.onRequestPost(ctx) : await mod.onRequestGet(ctx);
    const headers = Object.fromEntries([...res.headers].filter(([k]) => k !== 'content-length'));
    return req.respond({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
  }
  return false;
}

const consoleErrors = [];
let newTabs = 0;
browser.on('targetcreated', (t) => { if (t.type() === 'page') newTabs++; });
async function open(width, height, phone = false) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 2, isMobile: phone, hasTouch: phone });
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    try { if (await answer(req) === false) req.continue(); } catch (e) {
      console.error('handler error', e);
      req.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: e.message }) });
    }
  });
  page.on('console', (m) => { if (m.type() === 'error' && !/tile|favicon|Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  page.on('error', (e) => { consoleErrors.push(`page crashed: ${e.message}`); console.log('  ✗ the page crashed:', e.message); });
  page.on('close', () => { if (process.env.FV_DEBUG) console.log('DEBUG page closed', new Error().stack.split('\n').slice(2, 5).join(' | ')); });
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS });
  await page.goto(`${SITE}/admin/__viewer.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.apl-board, .apl-table', { timeout: 20000 });
  return page;
}
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`) });
const text = (page, sel) => page.$eval(sel, el => el.textContent.trim()).catch(() => '');
const viewerOpen = (page) => page.$('.fv[role="dialog"]').then(Boolean);
const title = (page) => text(page, '.fv-title strong');
const count = (page) => text(page, '.fv-bar .fv-count');
const clickText = (page, sel, re) => page.evaluate((s2, src) => { const el = [...document.querySelectorAll(s2)].find((x) => new RegExp(src).test(x.textContent)); if (el) { el.click(); return true; } return false; }, sel, re.source);
const imgTransform = (page) => page.$eval('.fv-img', el => el.style.transform || '').catch(() => '');
async function openFamily(page, id) {
  await page.evaluate((x) => { location.hash = `#applications/applicants/${x}`; }, id);
  await page.waitForSelector('.apl-drawer .apl-side', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('.apl-gallery a, .apl-doclist a'), { timeout: 10000 }).catch(() => null);
}
const closeViewer = async (page) => { await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.fv'), { timeout: 3000 }).catch(() => null); };

console.log('Desktop 1440');
const page = await open(1440, 900);
await openFamily(page, avery.id);
const sidebarBefore = await page.$eval('aside.sidebar', el => { const s = getComputedStyle(el); return [s.position, s.width, s.backgroundColor, s.display].join('|'); });

// Pointing at a PDF loads pdf.js ahead, so the first PDF opens at once
const pdfjsAsked = [];
page.on('request', (r) => { if (/vendor-pdf/.test(r.url())) pdfjsAsked.push(r.url()); });
const pdfRow = await page.$$eval('.apl-doclist a', els => els.findIndex(a => /\.pdf$/.test(a.textContent.replace(/\d+ KB$/, '').trim())));
await (await page.$$('.apl-doclist a'))[Math.max(0, pdfRow)].hover();
for (let t = 0; t < 20 && pdfjsAsked.length < 2; t++) await sleep(100);
ok(pdfjsAsked.some(u => /vendor-pdf\.js$/.test(u)) && pdfjsAsked.some(u => /vendor-pdf\.worker\.js$/.test(u)), `pointing at a PDF loads pdf.js and its worker before the click (${pdfjsAsked.length})`);
await page.mouse.move(5, 5);

// A photo opens over the drawer, not in a new tab
const tabsBefore = newTabs;
await page.click('.apl-gallery a');
await page.waitForSelector('.fv[role="dialog"]', { timeout: 4000 }).catch(() => null);
ok(await viewerOpen(page), 'a photo opens in the viewer');
ok(newTabs === tabsBefore, 'and no new tab opened');
ok(!!(await page.$('.apl-drawer')), 'the family’s drawer stays open underneath');
ok(await title(page) === 'Avery Stone.jpg', `the viewer names the file (${await title(page)})`);
ok(/Photo · \d+ KB/.test(await text(page, '.fv-title small')), `with its kind and size (${await text(page, '.fv-title small')})`);
ok(await count(page) === '1 of 6', `the family’s photos and files are one set (${await count(page)})`);
ok(await page.$$eval('.fv-thumb', els => els.length) === 6, 'the strip has a thumbnail for each');
ok(await page.evaluate(() => document.querySelector('.fv').contains(document.activeElement)), 'focus moved into the viewer');
ok(await page.$eval('.fv', el => el.getAttribute('aria-modal') === 'true' && /Avery Stone\.jpg/.test(el.getAttribute('aria-label'))), 'it’s a labeled modal dialog');
await page.waitForFunction(() => { const i = document.querySelector('.fv-img'); return i && i.complete && i.naturalWidth > 0 && !i.classList.contains('is-loading'); }, { timeout: 5000 }).catch(() => null);
const fit = await page.$eval('.fv-img', el => ({ w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height, nat: el.naturalWidth }));
const stage = await page.$eval('.fv-media', el => el.getBoundingClientRect().toJSON());
ok(fit.w <= stage.width + 1 && fit.h <= stage.height + 1 && fit.w < fit.nat, `the photo fits the screen (${Math.round(fit.w)}×${Math.round(fit.h)} in ${Math.round(stage.width)}×${Math.round(stage.height)})`);
const pct0 = await text(page, '.fv-pct');
ok(await page.$eval('.fv', el => getComputedStyle(el).backgroundColor === 'rgb(14, 15, 17)'), 'the viewer is opaque: nothing of the page shows through');
await shot(page, 'desktop-photo');

// Zoom: + and −, double-click where you point, drag, 0 to fit
await page.keyboard.press('+');
await sleep(250);
ok(/scale\((1\.5|1\.50)/.test(await imgTransform(page)) && (await text(page, '.fv-pct')) !== pct0, `+ zooms in (${await imgTransform(page)}, ${await text(page, '.fv-pct')})`);
await page.keyboard.press('0');
await sleep(250);
ok(await imgTransform(page) === '' && await text(page, '.fv-pct') === pct0, '0 fits it again');
const c = { x: stage.x + stage.width * 0.7, y: stage.y + stage.height * 0.4 };
await page.mouse.click(c.x, c.y, { clickCount: 1 });
await page.mouse.click(c.x, c.y, { clickCount: 2 });
await sleep(300);
const zoomed = await imgTransform(page);
ok(/scale\(/.test(zoomed) && !/translate\(0px, 0px\)/.test(zoomed), `double-click zooms in around the pointer (${zoomed})`);
ok(await page.$eval('.fv-imgbox', el => el.classList.contains('is-zoomed') && getComputedStyle(el).cursor === 'grab'), 'a zoomed photo can be grabbed');
await page.mouse.move(c.x, c.y);
await page.mouse.down();
await page.mouse.move(c.x - 160, c.y - 90, { steps: 6 });
await page.mouse.up();
ok(await imgTransform(page) !== zoomed, 'dragging moves around the zoomed photo');
await page.click('.fv-pct');
await sleep(250);
ok(await imgTransform(page) === '', 'the zoom button fits it again');

// ← / →, the strip, the ends
ok(await page.$eval('.fv-side .fv-nav', el => el.disabled), 'Previous is off on the first file');
await page.keyboard.press('ArrowRight');
await sleep(150);
ok(await title(page) === 'Avery Stone Family.jpg' && await count(page) === '2 of 6', '→ goes to the next file');
await page.keyboard.press('ArrowLeft');
await sleep(150);
ok(await title(page) === 'Avery Stone.jpg', '← goes back');

// The photo that's gone says so
await page.click('.fv-thumb:nth-child(3)');
await page.waitForSelector('.fv-card', { timeout: 4000 }).catch(() => null);
ok(/didn’t load/.test(await text(page, '.fv-card')) && !!(await page.$('.fv-card .fv-pill')), 'a photo that won’t load says so, with Download and a new tab');

// The PDF: pdf.js under the admin's CSP
await page.click('.fv-thumb:nth-child(4)');
await page.waitForFunction(() => document.querySelectorAll('.fv-pdf .page canvas').length >= 1 && [...document.querySelectorAll('.fv-pdf .textLayer span')].some(s => /Avery Stone application/.test(s.textContent)), { timeout: 15000 }).catch(() => null);
ok(await page.$$eval('.fv-pdf .page', els => els.length) === 2, 'the PDF’s two pages are there');
ok(await page.$$eval('.fv-pdf .textLayer span', els => els.some(s => /Avery Stone application/.test(s.textContent))), 'its text is real text (selectable), Helvetica from the standard fonts');
ok(/Page 1 of 2/.test(await text(page, '.fv-page')), `the page count shows (${await text(page, '.fv-page')})`);
const pagePx = await page.$eval('.fv-pdf .page canvas', el => { const d = el.getContext('2d').getImageData(0, 0, el.width, el.height).data; let ink = 0; for (let i = 0; i < d.length; i += 4 * 29) if (d[i] < 120) ink++; return ink; }).catch(() => 0);
ok(pagePx > 20, `the page is drawn, ink on the canvas (${pagePx})`);
const pdfPct = await text(page, '.fv-pct');
await page.click('.fv-tools button[aria-label^="Zoom in"]');
await sleep(400);
ok(await text(page, '.fv-pct') !== pdfPct, `zoom in grows the PDF (${pdfPct} → ${await text(page, '.fv-pct')})`);
await page.keyboard.press('0');
await sleep(300);
const sidebarAfter = await page.$eval('aside.sidebar', el => { const s = getComputedStyle(el); return [s.position, s.width, s.backgroundColor, s.display].join('|'); });
ok(sidebarAfter === sidebarBefore, `pdf.js’s stylesheet leaves the admin’s sidebar alone (${sidebarAfter})`);
ok(await page.$$eval('style', els => els.some(s => s.id === 'fv-pdfjs-style') && !els.some(s => /(^|[}\s,])\.sidebar\b|:root\s*\{/.test(s.id === 'fv-pdfjs-style' ? s.textContent : ''))), 'and its rules are only for pages (no .sidebar or :root)');
await shot(page, 'desktop-pdf');

// The video: plays, nothing drawn on the picture (not even the browser's control bar), the player's bar under it
await page.keyboard.press('ArrowRight');
await page.waitForFunction(() => { const v = document.querySelector('.fv-video'); return v && v.readyState >= 2 && !v.paused; }, { timeout: 8000 }).catch(() => null);
const vid = await page.evaluate(() => {
  const v = document.querySelector('.fv-video');
  if (!v) return null;
  const r = v.getBoundingClientRect();
  const bar = document.querySelector('.fv-vbar').getBoundingClientRect();
  const media = document.querySelector('.fv-media').getBoundingClientRect();
  const pts = [[0.5, 0.5], [0.04, 0.04], [0.96, 0.04], [0.04, 0.96], [0.96, 0.96], [0.5, 0.98]].map(([x, y]) => document.elementFromPoint(r.left + r.width * x, r.top + r.height * y));
  return { ready: v.readyState, playing: !v.paused, clear: pts.every(el => el === v), controls: v.controls, w: Math.round(r.width), h: Math.round(r.height), barUnder: bar.top >= r.bottom - 1, barW: Math.round(bar.width), fills: r.width >= media.width - 2 || r.height + bar.height + 8 >= media.height - 2, mh: [Math.round(media.width), Math.round(media.height), Math.round(bar.height)] };
});
ok(vid?.ready >= 2 && vid.playing, `the video loads and plays (${JSON.stringify(vid)})`);
ok(vid && !vid.controls && vid.clear, 'nothing sits on the picture: no browser control bar, no arrows or buttons');
ok(vid?.barUnder && vid.fills, 'the player’s bar is under the picture, and the picture is as big as fits');
await page.click('.fv-vbar button[aria-label^="Pause"]');
await sleep(150);
ok(await page.$eval('.fv-video', v => v.paused) && !!(await page.$('.fv-vbar button[aria-label^="Play"]')), 'Pause pauses, and the button turns to Play');
// Where the bar asks the video to go (a browser recording has no seek index, so Chrome itself won't land mid-file)
const seekT = await page.$eval('.fv-seek', el => {
  const v = document.querySelector('.fv-video');
  let asked = null;
  Object.defineProperty(v, 'currentTime', { configurable: true, get: () => asked ?? 0, set: (x) => { asked = x; } });
  el.value = String(Number(el.max) / 2);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  delete v.currentTime;
  return asked / v.duration;
});
ok(seekT > 0.35 && seekT < 0.65, `the position bar moves through the video (${seekT.toFixed(2)})`);
await page.keyboard.press('m');
await sleep(100);
ok(await page.$eval('.fv-video', v => v.muted) && !!(await page.$('.fv-vbar button[aria-label^="Turn the sound on"]')), 'M mutes');
await page.focus('.fv');
await page.keyboard.press('k');
await sleep(150);
ok(await page.$eval('.fv-video', v => !v.paused), 'K plays again');
await shot(page, 'desktop-video');

// The Word file: can't be shown, Download
await page.keyboard.press('ArrowRight');
await sleep(200);
ok(/can’t be shown here/.test(await text(page, '.fv-card')) && await page.$eval('.fv-side:last-child .fv-nav', el => el.disabled), 'a Word file says it can’t be shown, offers Download; Next is off on the last file');
await shot(page, 'desktop-other');

// Download saves under the file's own name (JobTread's files are on another site)
await page.click('.fv-thumb:nth-child(1)');
await sleep(200);
await page.click('.fv-actions button[aria-label="Download"]');
let saved = [];
for (let t = 0; t < 30 && !saved.includes('Avery Stone.jpg'); t++) { await sleep(150); saved = readdirSync(DOWNLOADS); }
ok(saved.includes('Avery Stone.jpg'), `Download saves “Avery Stone.jpg” (${saved.join(', ') || 'nothing'})`);
ok(await page.$eval('.fv-actions a', el => el.target === '_blank' && /cdn\.fake\/f-child$/.test(el.href)), 'Open in a new tab is there for printing');

// axe on the viewer
const ax = await axeScan(page, '.fv');
ok(ax.length === 0, `viewer: no axe violations${ax.length ? `: ${axeText(ax)}` : ''}`);

// Esc closes it; the drawer stays; focus back on the photo that opened it
await closeViewer(page);
ok(!(await viewerOpen(page)) && !!(await page.$('.apl-drawer')), 'Esc closes the viewer, not the family');
ok(await page.evaluate(() => document.activeElement === document.querySelector('.apl-gallery a')), 'focus returns to the photo that opened it');

// Back closes it too, and the address stays the family's
const hash = await page.evaluate(() => location.hash);
await page.click('.apl-doclist a');
await page.waitForSelector('.fv', { timeout: 3000 });
await page.waitForFunction(() => history.state?.fileViewer, { timeout: 3000 }).catch(() => null);
await page.evaluate(() => history.back());
await page.waitForFunction(() => !document.querySelector('.fv'), { timeout: 3000 }).catch(() => null);
ok(!(await viewerOpen(page)) && !!(await page.$('.apl-drawer')) && await page.evaluate(() => location.hash) === hash, 'Back closes the viewer; the family stays open at the same address');
// Open and close quickly: the history stays straight
await page.click('.apl-doclist a');
await page.waitForSelector('.fv', { timeout: 3000 });
await closeViewer(page);
await page.click('.apl-gallery a');
await page.waitForSelector('.fv', { timeout: 3000 });
await page.waitForFunction(() => history.state?.fileViewer, { timeout: 3000 }).catch(() => null);
await page.evaluate(() => history.back());
await page.waitForFunction(() => !document.querySelector('.fv'), { timeout: 3000 }).catch(() => null);
ok(!(await viewerOpen(page)) && !!(await page.$('.apl-drawer')), 'closing and reopening fast, Back still just closes the viewer');

// ⌘/Ctrl-click: a new tab, as before
const tabs2 = newTabs;
await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
await page.click('.apl-gallery a');
await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
for (let t = 0; t < 20 && newTabs === tabs2; t++) await sleep(150);
ok(!(await viewerOpen(page)), '⌘/Ctrl-click doesn’t open the viewer');
ok(newTabs > tabs2, `it opens a new tab, as a link does (${newTabs - tabs2})`);
if (process.env.FV_DEBUG) console.log('DEBUG pages', (await browser.pages()).map(p => p.url().slice(0, 60)), page.url().slice(0, 60));
for (const p of (await browser.pages()).filter(p => p !== page && /cdn\.fake/.test(p.url()))) await p.close();

// A message's attachment
ok(await page.$$eval('.apl-file-chip', els => els.some(e => e.tagName === 'A' && /Application\.pdf/.test(e.textContent))), 'a message’s attachment is a link');
await page.click('a.apl-file-chip');
await page.waitForSelector('.fv', { timeout: 3000 }).catch(() => null);
ok(await title(page) === 'Avery Stone_Application.pdf' && !(await page.$('.fv-bar .fv-count')), 'it opens in the viewer, on its own');
await page.waitForSelector('.fv-tools button', { timeout: 10000 }).catch(() => null);
ok(await page.$eval('.fv-tools', (el) => el.getBoundingClientRect().right > innerWidth - 40).catch(() => false), 'on its own (no strip), the zoom buttons stay at the right');
await page.waitForFunction(() => document.querySelectorAll('.fv-pdf .page canvas').length >= 1, { timeout: 10000 }).catch(() => null);
ok(await page.$$eval('.fv-pdf .page', els => els.length) === 2, 'the attached PDF draws');
await closeViewer(page);

// The website form's answers: photos, PDF, video
await clickText(page, '.apl-answers button', /Show the answers/);
await page.waitForSelector('.apl-answer-sec', { timeout: 6000 }).catch(() => null);
await page.evaluate(() => document.querySelectorAll('.apl-answer-sec').forEach(d => { d.open = true; }));
const answerPhoto = await page.$('.apl-answer-sec a img');
ok(!!answerPhoto, 'the answers show the family’s photos');
if (answerPhoto) {
  await answerPhoto.click();
  await page.waitForSelector('.fv', { timeout: 3000 }).catch(() => null);
  ok(await count(page) === '1 of 4' && /picture of the child/i.test(await title(page)), `a form photo opens with the other three (${await count(page)}: ${await title(page)})`);
  await page.waitForFunction(() => document.querySelector('.fv-img')?.naturalWidth > 1000, { timeout: 5000 }).catch(() => null);
  ok(await page.$eval('.fv-img', el => el.naturalWidth).catch(() => 0) === 2400, 'the full photo from the site’s storage');
  await page.click('.fv-actions button[aria-label="Download"]');
  for (let t = 0; t < 30 && !saved.some(n => /^Avery Stone - .*child\.jpg$/i.test(n)); t++) { await sleep(150); saved = readdirSync(DOWNLOADS); }
  ok(saved.some(n => /^Avery Stone - .*child\.jpg$/i.test(n)), `Download names it after the family and the question (${saved.join(', ')})`);
  await closeViewer(page);
}
ok(await clickText(page, '.apl-answers .apl-more', /Watch the video/), 'the answers’ video has Watch the video (JobTread’s copy)');
await page.waitForFunction(() => { const v = document.querySelector('.fv-video'); return v && !v.paused; }, { timeout: 6000 }).catch(() => null);
ok(await title(page) === 'Avery Stone_Application.mp4' && await page.$eval('.fv-video', v => !v.paused).catch(() => false), 'and plays it in the viewer');
await closeViewer(page);
ok(await clickText(page, '.apl-answers a', /^PDF$/), 'the answers’ PDF link');
await page.waitForFunction(() => document.querySelectorAll('.fv-pdf .page canvas').length >= 1, { timeout: 10000 }).catch(() => null);
ok(await title(page) === 'Avery Stone_Application.pdf' && await page.$$eval('.fv-pdf .page', els => els.length) === 2, 'opens the PDF from the site’s storage in the viewer');
await closeViewer(page);

// A Jotform-era family: the application is the PDF in JobTread
await page.keyboard.press('Escape'); // close Avery
await page.waitForFunction(() => !document.querySelector('.apl-drawer'), { timeout: 3000 }).catch(() => null);
await openFamily(page, nora.id);
ok(!(await page.$$eval('.apl-side a', els => els.some(a => /jotform/.test(a.href)))), 'no link out to Jotform when JobTread has the application PDF');
ok(await clickText(page, '.apl-side button', /Read the application/), 'Read the application');
await page.waitForFunction(() => document.querySelectorAll('.fv-pdf .page canvas').length >= 1, { timeout: 10000 }).catch(() => null);
ok(await title(page) === 'Nora Kim_Application.pdf' && await count(page) === '2 of 2', `opens the PDF in the viewer, with the family’s photo a step away (${await count(page)})`);
await closeViewer(page);
const csp = await page.evaluate(() => window.__csp);
ok(csp.length === 0, `no CSP violations${csp.length ? `: ${csp.slice(0, 4).join(' | ')}` : ''}`);
await page.close();

console.log('Phone 390');
const phone = await open(390, 844, true);
await openFamily(phone, avery.id);
await clickText(phone, '.apl-dtabs button', /Details/);
await sleep(200);
await phone.click('.apl-gallery a');
await phone.waitForSelector('.fv', { timeout: 3000 }).catch(() => null);
await phone.waitForFunction(() => document.querySelector('.fv-img')?.complete, { timeout: 5000 }).catch(() => null);
const pm = await phone.evaluate(() => {
  const vis = (s) => [...document.querySelectorAll(s)].filter(e => e.getClientRects().length && getComputedStyle(e).display !== 'none');
  const r = document.querySelector('.fv').getBoundingClientRect();
  return {
    full: r.width === innerWidth && r.height === innerHeight,
    sides: vis('.fv-side').length, pnav: vis('.fv-pnav').length, strip: vis('.fv-strip').length,
    wide: [...document.querySelectorAll('.fv *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).map(e => e.className).slice(0, 3),
    small: vis('.fv button, .fv a').filter(e => e.getBoundingClientRect().width < 44 || e.getBoundingClientRect().height < 44).map(e => e.getAttribute('aria-label') || e.className),
  };
});
ok(pm.full, 'the viewer fills the phone’s screen');
ok(pm.sides === 0 && pm.pnav === 1 && pm.strip === 0, `the arrows move under the picture; no strip (${JSON.stringify(pm)})`);
ok(!pm.wide.length, `nothing is wider than the screen${pm.wide.length ? `: ${pm.wide.join(', ')}` : ''}`);
ok(!pm.small.length, `every button is a 44px target${pm.small.length ? `: ${pm.small.join(', ')}` : ''}`);
await shot(phone, 'phone-photo');
// Swipe to the next photo
const box = await phone.$eval('.fv-imgbox', el => el.getBoundingClientRect().toJSON());
const tc = await phone.createCDPSession();
const y = box.y + box.height / 2;
await tc.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width - 40, y }] });
for (let s = 1; s <= 6; s++) { await tc.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.width - 40 - s * 45, y }] }); await sleep(16); }
await tc.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(300);
ok(await text(phone, '.fv-pnav .fv-count') === '2 of 6', `a swipe goes to the next file (${await text(phone, '.fv-pnav .fv-count')})`);
// The PDF fits the phone's width
await phone.evaluate(() => document.querySelectorAll('.fv-pnav .fv-nav')[1].click());
await phone.evaluate(() => document.querySelectorAll('.fv-pnav .fv-nav')[1].click());
await phone.waitForFunction(() => document.querySelectorAll('.fv-pdf .page canvas').length >= 1, { timeout: 10000 }).catch(() => null);
const pw = await phone.$eval('.fv-pdf .page', el => el.getBoundingClientRect().width).catch(() => 0);
const pwide = await phone.evaluate(() => [...document.querySelectorAll('.fv, .fv-bar, .fv-stage, .fv-media, .fv-foot, .fv-foot *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).map(e => e.className).slice(0, 3));
ok(!pwide.length, `with a PDF open too, nothing is wider than the screen${pwide.length ? `: ${pwide.join(', ')}` : ''}`);
ok(pw > 300 && pw <= 390, `the PDF fits the phone’s width (${Math.round(pw)}px)`);
ok(!(await phone.$('.fv-note')), `a photo stepped past says nothing about the PDF (${await text(phone, '.fv-note')})`);
await shot(phone, 'phone-pdf');
const axp = await axeScan(phone, '.fv');
ok(axp.length === 0, `phone viewer: no axe violations${axp.length ? `: ${axeText(axp)}` : ''}`);
await phone.close();

ok(consoleErrors.length === 0, `no console errors${consoleErrors.length ? `: ${consoleErrors.slice(0, 3).join(' | ')}` : ''}`);
await browser.close();
server.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nAll file viewer checks passed');
process.exit(failures.length ? 1 : 0);
