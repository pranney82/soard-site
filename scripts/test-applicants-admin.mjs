/**
 * test-applicants-admin.mjs — drive Admin → Applications → Applicants in a browser
 * ===============================================================================
 * Serves public/ from a tiny local server (no build needed) and loads the
 * Applicants module on a harness page that carries the admin's own styles.
 * Every /api/applicants-admin call is answered by the REAL handler
 * (functions/api/applicants-admin.js) running here in Node, against an
 * in-memory D1 and the in-memory JobTread of tests/lib/fake-applicant-world.mjs,
 * so the mirror, history, status sheet, messages and boundary are the real thing.
 *
 * Checks, at 1440px and 390px:
 *   - Board: four columns with counts, cards with flags, drag a card to another
 *     column → the sheet previews the family's email → confirm → JobTread's
 *     Status changed and the QC message posted, once
 *   - the sheet's "don't email" choice, Denied with a reason
 *   - The header (title, sync, ⋯ menu) and one toolbar row: views, search,
 *     season and a Filters panel whose filters show as chips you can clear
 *   - List: sorting, search with "/", year and area filters, the status counts
 *   - Map: pins and the red boundary, legend toggles, "Show on map" from a
 *     family, editing the boundary is used for everyone as soon as it's saved
 *   - Staying in step with JobTread: no standing Sync button; when JobTread
 *     fails, the header says so in amber with "Check JobTread now"
 *   - Pause family emails (⋯ menu → a sheet that explains it): a move
 *     made meanwhile is held, "Turn family emails back on", then each held email
 *     is sent or not, family by family
 *   - A family: the conversation (emails, logged texts, notes, events), sending
 *     an email and a note (no texting from the site), editing details in place, archive
 *   - Activity: everything across families
 *   - phone: nothing wider than the screen; the drawer fills it, with
 *     Conversation and Details as tabs and the composer pinned inside the screen
 *   - iPad landscape (1024): all four board columns fit
 *   - In the real admin shell (the 240px sidebar), at phone, iPad and every
 *     laptop width: no view ever scrolls sideways; the board shows four
 *     columns while they fit, else one status at a time under a switcher
 *   - Avatars: the child's photo from the application (JobTread's file), the
 *     kid page's Main photo once it has one, initials when a photo won't load
 *   - Scores: a family's score and tier on its card, the List's Score column and
 *     filter, the Scores view (the snapshot, the ranking with each criterion and
 *     what to talk about, the season's makeovers and who's not funded yet, How
 *     scoring works), and the Score tab: your own scorecard first (mouse, then
 *     1 to 5 on the keyboard), saved as you go, then Everyone side by side
 * Screenshots in test-results/applicants-admin/. Exits non-zero on failure.
 *
 *   node scripts/test-applicants-admin.mjs
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import { fakeApplicantWorld, ORG } from '../tests/lib/fake-applicant-world.mjs';
import * as api from '../functions/api/applicants-admin.js';
import * as formsApi from '../functions/api/applications-admin.js';
import { FIELDS } from '../functions/api/_applicants.js';
import { clearFormCache, getDraftForm, getLiveForm } from '../functions/api/_application-forms.js';
import { axeScan, axeText } from './lib/axe.mjs';
import { saveScorecard, familyScores, capacities } from '../functions/api/_applicant-scores.js';
import { ensureCompanyCamSchema } from '../functions/api/_companycam-sync.js';
import { CRITERION_KEYS } from '../public/admin/scoring-shared.js';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/applicants-admin/');
mkdirSync(OUT, { recursive: true });
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── JobTread (fake) with a season's worth of families ──
const w = fakeApplicantWorld();
globalThis.fetch = w.fetchImpl; // the handlers call JobTread with the global fetch
const F = Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, f.id]));
const EMAIL = '22NJw43QvHeJ';
const PHONE = '22NJw43UauSc';
const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
let n = 0;
function family({ name, status, year = '2027', types = ['Bedroom'], parent, lat, lng, city, county, dx = 'Cerebral palsy', birthday = '2016-04-12', lang = 'English', days = 10, phone = '+17705550100', comments = [] }) {
  const id = `acct${String(++n).padStart(8, '0')}`;
  const a = {
    id, name, type: 'customer', org: ORG, createdAt: day(days),
    fields: { [F.status]: status, [F.year]: year, [F.types]: types, [F.diagnosis]: dx, [F.birthday]: birthday, [F.language]: lang, [F.gender]: 'Female', [F.referredBy]: 'Children’s Healthcare of Atlanta', [F.verbal]: 'Yes', [F.mobile]: 'No' },
    contacts: [{ id: `${id}-c1`, name: parent, title: 'Mom', fields: { [EMAIL]: `${parent.split(' ')[0].toLowerCase()}@example.com`, [PHONE]: phone } }],
    primaryContactId: `${id}-c1`,
    locations: lat ? [{ id: `${id}-l1`, address: `${100 + n} Maple Dr, ${city}, GA 30062, USA`, city, county: `${county} County`, latitude: lat, longitude: lng }] : [],
    files: [{ id: `${id}-f1`, name: `${name}_Application.pdf`, type: 'application/pdf', size: 482113 }, { id: `${id}-f2`, name: `${name}.jpg`, type: 'image/jpeg', size: 220000 }],
    comments: [{ id: `${id}-comms`, name: 'Comms Thread', message: 'To send a text message…', pinned: true, by: 'JobTread', createdAt: day(days) }, ...comments.map((c, i) => ({ id: `${id}-m${i}`, createdAt: day(c.days), ...c }))],
    jobs: status === 'Approved' ? [{ id: `${id}-job`, name: `${name} (${year})` }] : [],
  };
  w.world.accounts[id] = a;
  w.world.events.push({ id: `ev-${id}-st`, createdAt: day(Math.max(1, days - 3)), type: 'accountUpdated', createdByGrantId: 'app', createdByGrantName: 'JobTread App', createdByUser: { name: 'Linzi Ranney' }, data: { next: { custom: { Status: status } }, previous: { custom: { Status: 'Applied' } } }, account: { id, type: 'customer' } });
  return a;
}
const QC = (msg, days, name = 'Application Status') => ({ name, message: msg, by: 'Qualification Committee', days });
const TEXT_IN = (who, msg, days) => ({ name: null, message: `Company Number: +17709902434\n\nNew incoming _message_\nContact: ${who}\nPhone: +14049317960\n\nMessage: ${msg}`, by: 'Peter Ranney', days, parentCommentId: 'x' });
const TEXT_OUT = (who, msg, days) => ({ name: null, message: `Company Number: +17709902434\n\nNew outgoing _message_\nContact: ${who}\nPhone: +14049317960\n\nMessage: ${msg}`, by: 'Peter Ranney', days, parentCommentId: 'x' });

const avery = family({ name: 'Avery Stone', status: 'Applied', parent: 'Jordan Stone', lat: 33.9767, lng: -84.5369, city: 'Marietta', county: 'Cobb', days: 4, types: ['Bedroom', 'Bathroom'],
  comments: [QC('Jordan Stone\n\nThe application for *Avery Stone* is under review.\n\nOur team carefully evaluates each submission to determine how we can best serve the families who apply. If your application is selected to move forward, we will contact you to schedule an on-site visit as the next step to complete your application for review.\n\nIf we are unable to proceed with a makeover at this time, we will also notify you of our decision.', 4),
    { name: "Child's Medical Condition", message: '*Diagnosis*: Cerebral palsy\n\n*Summary:* Cerebral palsy affects movement and muscle control.', by: 'Qualification Committee', days: 4 },
    { name: 'RE: Application Status', message: 'Thank you so much! We are so excited.', by: 'Jordan Stone', fromEmail: true, days: 3 },
    TEXT_OUT('Jordan Stone', 'Hi Jordan! This is Linzi from SOARD. Do you have a minute to talk this week?', 2),
    TEXT_IN('Jordan Stone', 'Yes! Thursday after 3 works great.', 2)] });
// A second parent on the account: every family email goes to both
avery.contacts.push({ id: `${avery.id}-c2`, name: 'Sam Stone', title: 'Dad', fields: { [EMAIL]: 'sam@example.com' } });
// Jordan's email reply sits in the thread of the message it answers, as JobTread files it
avery.comments.find(c => c.name === 'RE: Application Status').parentCommentId = `${avery.id}-m0`;
// That first message went to Jordan only (Sam was added later)
avery.comments.find(c => c.id === `${avery.id}-m0`).assignees = [{ name: 'Jordan Stone', emailAddress: 'jordan@example.com', accountType: 'customer' }];
family({ name: 'Mateo García', status: 'Applied', parent: 'Lucía García', lat: 34.07, lng: -84.29, city: 'Alpharetta', county: 'Fulton', days: 25, lang: 'Spanish' });
family({ name: 'Harper Lee', status: 'Applied', parent: 'Dana Lee', lat: 33.749, lng: -84.388, city: 'Atlanta', county: 'Fulton', days: 2, types: ['Ramp'] });
family({ name: 'Noah Pence', status: 'In Review', parent: 'Erin Pence', lat: 34.24, lng: -84.49, city: 'Canton', county: 'Cherokee', days: 40, types: ['Therapy Room'] });
family({ name: 'Isla Example', status: 'In Review', parent: 'Kate Example', lat: 34.2367, lng: -84.4908, city: 'Canton', county: 'Cherokee', days: 60 });
family({ name: 'Owen Lindgren', status: 'Approved', parent: 'Meg Lindgren', lat: 33.99, lng: -84.45, city: 'Marietta', county: 'Cobb', days: 120, types: ['Bathroom'] });
family({ name: 'Eliza Franklin', status: 'Approved', parent: 'Mia Franklin', lat: 34.0987, lng: -84.4823, city: 'Woodstock', county: 'Cherokee', days: 200 });
family({ name: 'Evan Burkett', status: 'Denied', parent: 'Sam Burkett', lat: 33.94, lng: -84.51, city: 'Marietta', county: 'Cobb', days: 90 });
family({ name: 'Logan Logan', status: 'Denied', parent: 'Pat Logan', lat: 32.56, lng: -83.89, city: 'Fort Valley', county: 'Peach', days: 300, year: '2026' });
family({ name: 'Kenna Thomason', status: 'Approved', parent: 'Ash Thomason', lat: 34.06, lng: -84.67, city: 'Acworth', county: 'Cobb', days: 400, year: '2026' });
// A test account staff made in JobTread: off the board unless asked for
family({ name: 'TEST Sample Family', status: 'Applied', parent: 'Pat Sample', lat: 32.9, lng: -84.9, city: 'Manchester', county: 'Meriwether', days: 1 });
// Not applicants
w.world.accounts.office = { id: 'office00001', name: 'Sunshine Office', type: 'customer', org: ORG, createdAt: day(900), fields: {}, contacts: [], locations: [], files: [], comments: [], jobs: [] };

// ── D1 ──
const DB = await createD1();
await DB.exec(`CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)`);
await DB.prepare("INSERT INTO site_config (key, data) VALUES ('settings', ?)").bind(JSON.stringify({ application: { open: true, year: '2027' } })).run();
await DB.exec(`CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)`);
const env = { ...w.env, DB, JOBTREAD_QC_GRANT_KEY: 'qc-grant' };
// Owen's kid page has its family photos: they're his avatar, not the application's
const owen = Object.values(w.world.accounts).find(a => a.name === 'Owen Lindgren');
await DB.exec('CREATE TABLE kids (slug TEXT PRIMARY KEY, name TEXT NOT NULL, year INTEGER, data TEXT NOT NULL)');
await DB.prepare('INSERT INTO kids (slug, name, year, data) VALUES (?, ?, ?, ?)').bind('owen', 'Owen', 2027, JSON.stringify({
  slug: 'owen', name: 'Owen', year: 2027, jobtreadJobId: `${owen.id}-job`, heroImage: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/owen/photo-03/public',
  photos: [{ url: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/owen/photo-03/public', focus: { x: 0.5, y: 0.3 } }],
})).run();
// Harper's photo won't load
const harper = Object.values(w.world.accounts).find(a => a.name === 'Harper Lee');

// ── A static server for public/, plus the harness page ──
const adminHtml = readFileSync(join(ROOT, 'public/admin/index.html'), 'utf8');
// The admin's own stylesheet only: later <style> blocks belong to pages the admin opens in their own window (the printable roster)
const adminStyles = [...adminHtml.slice(0, adminHtml.indexOf('<script')).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
const harness = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Applicants harness</title><link rel="preconnect" href="https://fonts.googleapis.com"><style>${adminStyles}</style>
<style>body{margin:0;background:var(--color-bg);font-family:Inter,system-ui,sans-serif;color:var(--color-text)} .harness{padding:24px;max-width:1500px;margin:0 auto} @media (max-width:640px){.harness{padding:12px}}</style></head>
<body><main class="harness"><h1 style="margin:0 0 16px;font-size:1.5rem">Applications</h1><div id="root"></div></main>
<div id="toasts" class="toast-container" style="position:fixed;bottom:16px;right:16px;z-index:1000;display:grid;gap:6px;pointer-events:none"></div>
<script type="module">
import { h, render } from './vendor.js';
import { ApplicantsArea } from './applicants.js';
window.__toasts = [];
const addToast = (msg, kind) => { window.__toasts.push({ msg, kind }); const t = document.createElement('div'); t.textContent = msg; t.dataset.kind = kind; t.className = 'toast'; t.style.cssText = 'background:#1A1B1F;color:#fff;padding:10px 14px;border-radius:10px;font-size:14px'; document.getElementById('toasts').appendChild(t); setTimeout(() => t.remove(), 2500); };
render(h(ApplicantsArea, { addToast }), document.getElementById('root'));
</script></body></html>`;
// The real admin shell around the same module: the 240px sidebar and .main's padding
const shell = harness.replace('<main class="harness"><h1 style="margin:0 0 16px;font-size:1.5rem">Applications</h1><div id="root"></div></main>',
  '<div class="app"><aside class="sidebar"></aside><div class="main"><div id="root"></div></div></div>');
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/admin/__applicants.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(harness); }
  if (path === '/admin/__shell.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(shell); }
  const file = join(ROOT, 'public', path);
  if (file.startsWith(join(ROOT, 'public')) && existsSync(file) && statSync(file).isFile()) {
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    return res.end(readFileSync(file));
  }
  res.writeHead(404); res.end('not found');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${server.address().port}`;

let slowFields = 0, failFields = false, fieldSaves = 0;
const slowQueue = []; // per-save delays, first save first
let slowReads = 0; // a family's reload taking its time
const listDelays = []; // a list answer read now and delivered late, first request first
let failPreview = false; // the status sheet's "what would be sent" can't be read
let slowMessages = 0, dropMessages = false, messagesPosted = 0; // a family message taking its time, or the network dropping it
let slowMoves = 0; // a status move taking its time
let slowDrafts = 0; // a ready-made correction taking its time to arrive
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');
async function answer(req) {
  const url = new URL(req.url());
  if (url.host === 'cdn.fake' && url.pathname.startsWith(`/${harper.id}-`)) return req.respond({ status: 404, body: 'gone' });
  if (url.host === 'cdn.fake' || url.pathname.startsWith('/cdn-cgi/imagedelivery/')) return req.respond({ status: 200, contentType: 'image/png', body: PNG });
  if (url.pathname === '/api/applicants-admin' || url.pathname === '/api/applications-admin') {
    // A detail's save can be made slow (JobTread taking its time) or fail outright
    if (req.method() === 'POST' && /^\{"fields"/.test(req.postData() || '')) {
      fieldSaves++;
      const wait = slowQueue.length ? slowQueue.shift() : slowFields;
      if (wait) await sleep(wait);
      if (failFields) return req.respond({ status: 502, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'JobTread didn’t answer' }) });
    }
    if (req.method() === 'POST' && /^\{"(status|pause)"/.test(req.postData() || '') && slowMoves) await sleep(slowMoves);
    if (req.method() === 'GET' && url.searchParams.get('correction') && slowDrafts) await sleep(slowDrafts);
    if (req.method() === 'POST' && /^\{"(message|correction)"/.test(req.postData() || '')) {
      if (dropMessages) return req.abort('failed');
      messagesPosted++;
      if (slowMessages) await sleep(slowMessages);
    }
    if (req.method() === 'GET' && url.searchParams.get('preview') && failPreview) return req.respond({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'JobTread didn’t answer' }) });
    clearFormCache();
    const request = new Request(`https://admin.test${url.pathname}${url.search}`, { method: req.method(), body: req.method() === 'POST' ? req.postData() : undefined, headers: { 'content-type': 'application/json' } });
    const ctx = { env, request, data: { userEmail: 'linzi@soardcharity.com' }, waitUntil: () => {} };
    const mod = url.pathname === '/api/applicants-admin' ? api : formsApi;
    if (req.method() === 'GET' && slowReads && url.searchParams.get('id')) await sleep(slowReads);
    const res = req.method() === 'POST' ? await mod.onRequestPost(ctx) : await mod.onRequestGet(ctx);
    const answerBody = Buffer.from(await res.arrayBuffer());
    if (req.method() === 'GET' && url.searchParams.get('list') && listDelays.length) await sleep(listDelays.shift());
    return req.respond({ status: res.status, contentType: 'application/json', body: answerBody });
  }
  return false;
}

const browser = await puppeteer.launch({ headless: 'shell', args: ['--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
const consoleErrors = [];
async function open(width, height, harnessPage = '__applicants.html') {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 2, isMobile: width < 500, hasTouch: width < 500 });
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    try {
      if (await answer(req) === false) req.continue();
    } catch (e) {
      console.error('handler error', e);
      req.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: e.message }) });
    }
  });
  page.on('console', (m) => { if (m.type() === 'error' && !/tile|cartocdn|favicon|Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  await page.goto(`${SITE}/admin/${harnessPage}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.apl-board, .apl-table, .apl-map, .apl-feed, .apl-scores', { timeout: 20000 });
  return page;
}
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`) });
const text = (page, sel) => page.$eval(sel, el => el.textContent.trim()).catch(() => '');
const acct = (name) => Object.values(w.world.accounts).find(a => a.name === name);
/** Click the first element matching sel whose text matches re; false when there's none */
const clickText = (page, sel, re) => page.evaluate((s2, src) => { const el = [...document.querySelectorAll(s2)].find((x) => new RegExp(src).test(x.textContent)); if (el) { el.click(); return true; } return false; }, sel, re.source);

console.log('Desktop 1440');
const page = await open(1440, 1000);
await page.evaluate(() => localStorage.removeItem('apl-view'));
await sleep(400);
// Board
ok(await page.$$eval('.apl-col', els => els.length) === 4, 'board has four status columns');
const colCounts = await page.$$eval('.apl-col', els => els.map(e => [e.querySelector('h3').textContent, e.querySelector('.apl-count').textContent]));
ok(JSON.stringify(colCounts) === JSON.stringify([['Applied', '3'], ['In Review', '2'], ['Approved', '2'], ['Denied', '1']]), `2027 season counts per column ${JSON.stringify(colCounts)}`);
ok(!(await page.$$eval('.apl-card-name', els => els.map(e => e.textContent))).includes('Sunshine Office'), 'accounts that aren’t applicants stay off the board');
ok(!(await page.$$eval('.apl-card-name', els => els.map(e => e.textContent))).includes('TEST Sample Family'), 'test families stay off the board unless asked for');
ok(await page.$$eval('.apl-tag.is-out', els => els.some(e => /mi outside/.test(e.textContent))), 'a home outside the boundary is flagged with miles');
ok(await page.$eval('.apl-tag.is-out', (el) => { const ref = document.createElement('span'); ref.style.background = 'var(--tone-warn-bg)'; document.body.append(ref); const want = getComputedStyle(ref).backgroundColor; ref.remove(); return getComputedStyle(el).backgroundColor === want; }), 'and flagged in the admin’s one warning amber (red is for destructive buttons)');
ok(await page.$$eval('.apl-tag.is-es', els => els.length >= 1 && els.every(e => e.textContent === 'Spanish')), 'a Spanish-speaking family is tagged "Spanish" (the same word Submissions uses)');
ok(await text(page, '.apl > .page-header h2') === 'Applicants', 'the tab has the admin’s page header');
const [vb, fbx] = await Promise.all([page.$eval('.apl-views', el => el.getBoundingClientRect().top), page.$eval('.apl-filters', el => el.getBoundingClientRect().top)]);
ok(Math.abs(vb - fbx) < 6, 'views, search and filters share one toolbar row');
ok(!(await page.$('button[title^="For cleaning up statuses"]')), 'the cleanup switch isn’t a button on its own row');
ok(!(await page.$$eval('.apl-head-actions button', els => els.some(b => /Sync now|Check JobTread now/.test(b.textContent)))) && /In sync with JobTread · checked/.test(await text(page, '.apl-sync')), 'all well: no sync button, just when JobTread was last checked');
ok(await page.$$eval('.apl-stage.is-long', els => els.length >= 1), 'families waiting long in a stage stand out');
// Avatars: the child's photo from the application, the kid page's once it has photos, initials when a photo won't load
const avatar = (id) => page.$eval(`.apl-card[data-id="${id}"] .apl-avatar`, el => ({ src: el.querySelector('img')?.getAttribute('src') || null, shown: !!el.querySelector('img') && el.querySelector('img').style.display !== 'none' && el.querySelector('img').naturalWidth > 0, title: el.title, initials: el.textContent.trim() }));
await page.waitForFunction(() => [...document.querySelectorAll('.apl-card .apl-avatar img')].every(i => i.complete), { timeout: 5000 }).catch(() => null);
const av = await avatar(acct('Avery Stone').id);
ok(av.src === `https://cdn.fake/${acct('Avery Stone').id}-f2?size=256` && av.shown && av.title === 'Photo from their application', `a card shows the child's photo from the application (JobTread's "Avery Stone.jpg"): ${av.src}`);
const cv = await avatar(owen.id);
ok(/^https:\/\/sunshineonaranneyday\.com\/cdn-cgi\/imagedelivery\/ROYFuPmfN2vPS6mt5sCkZQ\/kids\/owen\/photo-03\/w=128,h=128,fit=cover,gravity=0\.5x0\.3,q=80$/.test(cv.src || '') && cv.title === 'Photo from their kid page', `once the kid page has photos, its Main photo replaces the application's: ${cv.src}`);
const hv = await avatar(harper.id);
ok(!hv.shown && hv.initials === 'HL', `a photo that won't load leaves the initials showing (${JSON.stringify(hv)})`);
await shot(page, 'desktop-board');

// Drag Avery from Applied to In Review → the sheet
const card = await page.$('.apl-card[data-id="acct00000001"]');
const target = await page.$('.apl-cards[data-status="In Review"]');
const cb = await card.boundingBox();
const tb = await target.boundingBox();
await page.mouse.move(cb.x + cb.width / 2, cb.y + 20);
await page.mouse.down();
for (let i = 1; i <= 12; i++) { await page.mouse.move(cb.x + cb.width / 2 + ((tb.x + 60 - cb.x - cb.width / 2) * i) / 12, cb.y + 20 + ((tb.y + 40 - cb.y - 20) * i) / 12); await sleep(16); }
await page.mouse.up();
await page.waitForSelector('.apl-sheet', { timeout: 5000 }).catch(() => null);
ok(!!(await page.$('.apl-sheet')), 'dragging a card to another column opens the status sheet');
await page.waitForSelector('.apl-preview-body', { timeout: 5000 }).catch(() => null);
ok(/Congratulations, the application for/.test(await text(page, '.apl-preview-body')), 'the sheet previews the exact In Review email');
ok(/jordan@example\.com/.test(await text(page, '.apl-sheet .apl-check')) && /sam@example\.com/.test(await text(page, '.apl-sheet .apl-check')), 'the sheet names everyone who gets it (both parents)');
ok(/Goes out at/.test(await text(page, '.apl-sheet')), 'the sheet says when it goes (after the status settles)');
ok(acct('Avery Stone').fields[F.status] === 'Applied', 'nothing changes in JobTread before confirming');
ok(await page.$eval('.apl-card[data-id="acct00000001"]', el => el.closest('.apl-cards').dataset.status) === 'Applied', 'the card stays put until confirmed');
await shot(page, 'desktop-status-sheet');
await page.click('.apl-sheet-foot .btn-primary');
await page.waitForFunction(() => !document.querySelector('.apl-sheet'), { timeout: 8000 });
await sleep(300);
ok(acct('Avery Stone').fields[F.status] === 'In Review', 'JobTread Status is now In Review');
ok(acct('Avery Stone').comments.filter(c => c.name === 'Application In Review').length === 0, 'the family email waits for the status to settle');
await page.waitForFunction(() => /Emails /.test(document.querySelector('.apl-card[data-id="acct00000001"] .apl-mail')?.textContent || ''), { timeout: 8000 }).catch(() => null);
ok(/Emails /.test(await text(page, '.apl-card[data-id="acct00000001"] .apl-mail')), 'the card shows when the family is emailed');
await page.waitForFunction(() => document.querySelector('.apl-card[data-id="acct00000001"]')?.closest('.apl-cards')?.dataset.status === 'In Review', { timeout: 8000 }).catch(() => null);
ok(await page.$eval('.apl-card[data-id="acct00000001"]', el => el.closest('.apl-cards').dataset.status).catch(() => '') === 'In Review', 'the card moved to In Review');

// JobTread's own record of the move just made on the site (it used the site's key): the conversation shows the move once
await DB.prepare('INSERT INTO applicant_activity (id, account_id, at, kind, by_name, source, title, body, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .bind('jt-event-echo', 'acct00000001', new Date().toISOString(), 'status', 'Peter Ranney', 'website', 'Status: In Review', 'Was Applied', JSON.stringify({ from: 'Applied', to: 'In Review' })).run();
// A details change made on the site, and JobTread's record of the same change: shown once
for (const [id, by, body] of [['site:fields-1', 'Linzi', 'Makeover type: Bedroom, Ramp'], ['jt-fields-echo', 'Linzi Ranney', 'Makeover type: Ramp, Bedroom']]) {
  await DB.prepare('INSERT INTO applicant_activity (id, account_id, at, kind, by_name, source, title, body, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, 'acct00000001', '2026-10-02T15:00:00.000Z', 'fields', by, 'website', 'Makeover type changed', body, JSON.stringify({ changes: [{ field: 'types', to: ['Bedroom', 'Ramp'] }] })).run();
}

// A long history line, like "No website profile" on an organization's page
await DB.prepare('INSERT INTO applicant_activity (id, account_id, at, kind, by_name, source, title, body, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .bind('site-long-1', 'acct00000001', '2026-10-01T15:00:00.000Z', 'job', 'Website (automatic)', 'website', 'No website profile', 'This account has no birthday or diagnosis, so it looks like an organization. Add a Community project in the admin if it should have a page.', null).run();

// Open Avery
await page.click('.apl-card[data-id="acct00000001"]');
await page.waitForSelector('.apl-drawer .apl-thread .apl-msg', { timeout: 8000 });
await sleep(450);
ok(/The In Review email to Jordan Stone and Sam Stone goes out at/.test(await text(page, '.apl-thread-banner')), 'the family’s page says what’s about to be emailed, and to whom');
await shot(page, 'desktop-family-pending');
await page.click('.apl-thread-banner .btn-primary'); // Send now
await page.waitForFunction(() => !document.querySelector('.apl-thread-banner'), { timeout: 8000 }).catch(() => null);
ok(acct('Avery Stone').comments.filter(c => c.name === 'Application In Review').length === 1, 'Send now posts the In Review message once');
ok(acct('Avery Stone').comments.find(c => c.name === 'Application In Review')?.assignees?.length === 2, 'the In Review message goes to both parents');
await page.waitForFunction(() => [...document.querySelectorAll('.apl-msg-meta')].some(e => /Emailed to Jordan Stone and Sam Stone/.test(e.textContent)), { timeout: 8000 }).catch(() => null);
ok(await page.$$eval('.apl-msg-meta', els => els.some(e => /Emailed to Jordan Stone and Sam Stone/.test(e.textContent))), 'the conversation says who it was emailed to (from JobTread’s own record)');
ok(await page.$$eval('.apl-thread > *', els => { const t = els.map(e => e.textContent); const move = t.findIndex(x => /Moved from Applied/.test(x) && /website/.test(x)); const sent = t.findIndex(x => /Emailed the family: In Review/.test(x)); return move >= 0 && sent > move; }), 'the history reads in order: the move, then the email');
ok(acct('Avery Stone').comments.find(c => c.name === 'Application In Review')?.grantKey === 'qc-grant', 'posted as the Qualification Committee');
ok(await page.$$eval('.apl-msg.is-text', els => els.length) === 2, 'texts show as text bubbles');
ok(await page.$$eval('.apl-msg.is-email', els => els.length) === 1, 'the family’s email reply shows');
ok(await page.$$eval('.apl-msg.is-internal', els => els.some(e => /Medical Condition/.test(e.textContent))), 'the medical note shows as staff only, not as an email');
await page.waitForFunction(() => [...document.querySelectorAll('.apl-event')].some(e => /Emailed the family: In Review/.test(e.textContent)), { timeout: 8000 }).catch(() => null);
ok(await page.$$eval('.apl-event', els => els.some(e => /Moved from Applied/.test(e.textContent))), 'the status change shows in the conversation');
ok(await page.$$eval('.apl-event', els => els.filter(e => /Moved from Applied/.test(e.textContent) && /website/.test(e.textContent)).length) === 1, 'a move made on the site shows once, not again as JobTread’s record of it');
ok(await page.$$eval('.apl-event', els => els.filter(e => /Makeover type changed/.test(e.textContent) && /Bedroom, Ramp|Ramp, Bedroom/.test(e.textContent)).length) === 1, 'a details change made on the site shows once too');
ok(await page.$$eval('.apl-event', els => els.some(e => /Emailed the family: In Review/.test(e.textContent))), 'and so does the email going out');
ok(/Linzi/.test(await page.$$eval('.apl-event', els => els.map(e => e.textContent).join(' '))), 'with who did it');
const longLine = await page.evaluate(() => {
  const ev = [...document.querySelectorAll('.apl-event')].find(e => /No website profile/.test(e.textContent));
  if (!ev) return null;
  const t = ev.closest('.apl-thread').getBoundingClientRect();
  const icon = ev.firstElementChild.getBoundingClientRect();
  const words = ev.lastElementChild.getBoundingClientRect();
  return { inside: [...ev.querySelectorAll('*')].every(n => { const r = n.getBoundingClientRect(); return r.left >= t.left - 1 && r.right <= t.right + 1; }), besideIcon: icon.top + icon.height / 2 > words.top && icon.top + icon.height / 2 < words.bottom };
});
ok(longLine?.inside && longLine?.besideIcon, `a long history line wraps inside the conversation, beside its icon (${JSON.stringify(longLine)})`);
await shot(page, 'desktop-family');
// Email the family
ok(/Jordan Stone/.test(await text(page, '.apl-to')) && /Sam Stone/.test(await text(page, '.apl-to')), 'the composer shows it goes to both parents');
await page.type('.apl-composer textarea', 'Hi Jordan, could we visit on Tuesday at 3?');
await page.click('.apl-composer .btn-primary');
await page.waitForFunction(() => !document.querySelector('.apl-composer textarea').value, { timeout: 8000 }).catch(() => null);
const emailed = acct('Avery Stone').comments.find(c => /visit on Tuesday/.test(c.message));
ok(emailed?.assignees?.map(x => x.emailAddress).join() === 'jordan@example.com,sam@example.com', `Email family: one JobTread comment assigned to both parents, so JobTread emails each (${emailed?.assignees?.map(x => x.emailAddress)})`);
// The box only messages the family, through JobTread: no internal note (Peter, Oct 23 2026), no texting (families text SOARD's Quo number)
ok(!(await page.$('.apl-modes')) && !/Internal note|Text/.test(await text(page, '.apl-composer')) && /Message the family/.test(await text(page, '.apl-composer')), 'the box only messages the family');
ok((await page.evaluate(async (b) => (await fetch('/api/applicants-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json(), { note: { id: 'acct00000001', message: 'x' } })).success !== true && !acct('Avery Stone').comments.some(c => c.message === 'x'), 'and the admin API has no internal note to post');
// ⌘+Enter sends
await page.type('.apl-composer textarea', 'Thank you! See you Tuesday.');
await page.keyboard.down('Meta'); await page.keyboard.press('Enter'); await page.keyboard.up('Meta');
await page.waitForFunction(() => !document.querySelector('.apl-composer textarea').value, { timeout: 8000 });
ok(acct('Avery Stone').comments.find(c => /See you Tuesday/.test(c.message))?.assignees?.length === 2, '⌘+Enter sends it to the family the same way');
// Reply in a conversation: the answer goes in that JobTread thread, so the family gets it in the same conversation
ok(await page.$$eval('.apl-msg.is-email .apl-msg-actions button', els => els.some(e => e.textContent.trim() === 'Reply')), 'the family’s reply has a Reply button');
await page.$$eval('.apl-msg.is-email .apl-msg-actions button', els => els.find(e => e.textContent.trim() === 'Reply')?.click());
await page.waitForSelector('.apl-thread-to', { timeout: 5000 }).catch(() => null);
ok(/Replying in Application Status/.test(await text(page, '.apl-thread-to')) && !(await page.$('.apl-subject')), 'Reply: the box says which conversation it goes in, with no new subject');
ok(/Jordan Stone/.test(await text(page, '.apl-to')) && !/Sam Stone/.test(await text(page, '.apl-to')), 'To shows who’s on that conversation (a reply reaches them)');
ok(/Sam Stone isn’t on this conversation/.test(await text(page, '.apl-thread-note')), 'and says who isn’t, with New message to reach everyone');
await page.type('.apl-composer textarea', 'Thank you, Jordan! See you Thursday.');
await page.click('.apl-composer .btn-primary');
await page.waitForFunction(() => !document.querySelector('.apl-composer textarea').value, { timeout: 8000 }).catch(() => null);
const threaded = acct('Avery Stone').comments.find(c => /See you Thursday/.test(c.message));
ok(threaded?.parentCommentId === `${avery.id}-m0` && !threaded?.name, `the reply goes in the family’s JobTread thread, with no new subject (${JSON.stringify({ parent: threaded?.parentCommentId, name: threaded?.name })})`);
await page.waitForFunction(() => [...document.querySelectorAll('.apl-msg')].some(e => /See you Thursday/.test(e.textContent)), { timeout: 8000 }).catch(() => null);
ok(await page.$$eval('.apl-msg', els => els.some(e => /See you Thursday/.test(e.textContent) && /In “Application Status”/.test(e.textContent))), 'and shows in the conversation as part of that thread');
await shot(page, 'desktop-family-reply');
await page.$$eval('.apl-thread-to button', els => els[0]?.click());
ok(!!(await page.$('.apl-subject')) && !(await page.$('.apl-thread-to')), '“New message” switches back to a new message with a subject');
// Edit details in place
const typesBtn = await page.$$('.apl-type-picks button');
await typesBtn[3].click(); // Ramp
await page.waitForFunction(() => [...document.querySelectorAll('.apl-type-picks button')].find(b => /Ramp/.test(b.textContent))?.getAttribute('aria-pressed') === 'true', { timeout: 8000 }).catch(() => null);
ok(JSON.stringify(acct('Avery Stone').fields[F.types]) === JSON.stringify(['Bedroom', 'Bathroom', 'Ramp']), 'Makeover type edited in place, saved to JobTread as a list');
// The picks: the admin's toggle pills, each kind's icon beside its word (not touching it) and centered on it
const pillGeo = await page.$$eval('.apl-type-picks button', els => els.map(b => {
  const ic = b.querySelector('svg').getBoundingClientRect();
  const r = document.createRange(); r.selectNodeContents(b); const t = [...r.getClientRects()].filter(x => x.width > 0).pop();
  const words = [...b.childNodes].find(n => n.nodeType === 3); const wr = document.createRange(); wr.selectNodeContents(words); const w = wr.getBoundingClientRect();
  return { name: b.textContent.trim(), gap: w.left - ic.right, iconMid: ic.top + ic.height / 2, wordMid: w.top + w.height / 2, iconW: ic.width, pill: b.classList.contains('pill') };
}));
ok(pillGeo.length === 4 && pillGeo.every(g => g.pill), 'the Makeover type picks are the admin’s shared toggle pills');
ok(pillGeo.length === 4 && pillGeo.every(g => g.gap >= 4 && g.gap <= 9), `each Makeover type's icon stands apart from its word (${pillGeo.map(g => `${g.name} ${g.gap.toFixed(1)}px`).join(', ')})`);
ok(pillGeo.every(g => Math.abs(g.iconMid - g.wordMid) <= 1.5 && g.iconW >= 13), `and sits centered on the word at the pills' 14px (${pillGeo.map(g => `${g.name} ${(g.iconMid - g.wordMid).toFixed(1)}px`).join(', ')})`);
// Each label on its value's first line; every value's first letter on one line down the card
const kv = await page.$$eval('.apl-side .apl-kv dt', dts => dts.map(dt => {
  const dd = dt.nextElementSibling;
  const line = (el) => { const r = document.createRange(); r.selectNodeContents(el); return [...r.getClientRects()].find(x => x.width > 0); };
  const l = line(dt);
  const sel = dd.querySelector('select'), pill = dd.querySelector('.apl-type-picks button'), btn = dd.querySelector('.apl-edit');
  let mid, left;
  if (pill) { const p = pill.getBoundingClientRect(); mid = p.top + p.height / 2; left = p.left; }
  else if (sel) { const p = sel.getBoundingClientRect(), cs = getComputedStyle(sel); mid = p.top + p.height / 2; left = p.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft); }
  else if (btn) { const t = line(btn); mid = t.top + t.height / 2; left = t.left; }
  return { label: dt.textContent.trim(), off: (l.top + l.height / 2) - mid, left };
}));
ok(kv.length >= 8 && kv.every(r => Math.abs(r.off) <= 3), `each detail's label sits on its value's first line (${kv.filter(r => Math.abs(r.off) > 3).map(r => `${r.label} ${r.off.toFixed(1)}px`).join(', ') || 'all within 3px'})`);
ok(Math.max(...kv.map(r => r.left)) - Math.min(...kv.map(r => r.left)) < 0.5, `every value starts at the same spot, picks, choices and typed text alike (${[...new Set(kv.map(r => r.left.toFixed(1)))].join(' / ')})`);
// A pick shows the moment it's clicked, before JobTread answers; picking and unpicking quickly leaves it unpicked in JobTread too
const pressedOf = (name) => page.$$eval('.apl-type-picks button', (els, n) => els.find(b => b.textContent.trim() === n)?.getAttribute('aria-pressed'), name);
const pickPill = (name) => page.$$eval('.apl-type-picks button', (els, n) => els.find(b => b.textContent.trim() === n).click(), name);
slowFields = 700; fieldSaves = 0;
await pickPill('Therapy Room');
await sleep(120);
ok(await pressedOf('Therapy Room') === 'true', 'a Makeover type shows picked at once, while JobTread is still saving it');
await pickPill('Therapy Room');
await sleep(120);
ok(await pressedOf('Therapy Room') === 'false', 'and unpicking it straight away shows at once too');
await page.waitForFunction(() => !document.querySelector('.apl-type-picks.is-saving'), { timeout: 8000 }).catch(() => null);
await sleep(300);
ok(fieldSaves === 2 && JSON.stringify(acct('Avery Stone').fields[F.types]) === JSON.stringify(['Bedroom', 'Bathroom', 'Ramp']) && await pressedOf('Therapy Room') === 'false', `quick pick and unpick: both saved in turn, JobTread ends without it (${fieldSaves} saves, ${JSON.stringify(acct('Avery Stone').fields[F.types])})`);
slowFields = 0; failFields = true;
await pickPill('Ramp');
await page.waitForFunction(() => !document.querySelector('.apl-type-picks.is-saving'), { timeout: 8000 }).catch(() => null);
await sleep(300);
ok(await pressedOf('Ramp') === 'true' && await page.evaluate(() => window.__toasts.some(t => /JobTread didn’t answer/.test(t.msg))), 'a pick JobTread doesn’t save goes back, and says why');
failFields = false;
// Moving on to the next family while a pick is still saving: the drawer stays on the next family
slowFields = 900;
await pickPill('Therapy Room');
await page.click('.apl-icon-btn[aria-label^="Next family"]');
await sleep(150);
const nextName = await text(page, '.apl-dtitle h2');
await sleep(1800);
const stayedOn = await text(page, '.apl-dtitle h2');
ok(nextName !== 'Avery Stone' && stayedOn === nextName && acct('Avery Stone').fields[F.types].includes('Therapy Room'), `a pick still saving when you move on is saved to its family, and the drawer stays on the next one (${nextName} → ${stayedOn})`);
slowFields = 0;
await page.click('.apl-icon-btn[aria-label^="Previous family"]');
await page.waitForFunction(() => document.querySelector('.apl-dtitle h2')?.textContent.trim() === 'Avery Stone' && document.querySelector('.apl-type-picks'), { timeout: 8000 }).catch(() => null);
await pickPill('Therapy Room');
await page.waitForFunction(() => !document.querySelector('.apl-type-picks.is-saving'), { timeout: 8000 }).catch(() => null);
await sleep(300);
ok(JSON.stringify(acct('Avery Stone').fields[F.types]) === JSON.stringify(['Bedroom', 'Bathroom', 'Ramp']), 'back on Avery, unpicked again');
// Left mid-save and opened again: the family shows the pick still saving, and a new pick waits for it (the older save can't land last)
const idle = () => page.waitForFunction(() => !document.querySelector('.apl-type-picks.is-saving'), { timeout: 10000 }).catch(() => null);
const onFamily = (name) => page.waitForFunction((n) => document.querySelector('.apl-dtitle h2')?.textContent.trim() === n && document.querySelector('.apl-type-picks'), { timeout: 8000 }, name).catch(() => null);
await page.click('.apl-icon-btn[aria-label^="Next family"]');
const second = await page.evaluate(() => new Promise(r => setTimeout(() => r(document.querySelector('.apl-dtitle h2')?.textContent.trim()), 900)));
await onFamily(second);
const secondTypes = [...acct(second).fields[F.types]];
const extra = ['Bedroom', 'Bathroom', 'Therapy Room', 'Ramp'].find(t => !secondTypes.includes(t));
fieldSaves = 0; slowQueue.push(2500, 100);
await pickPill(extra);
await page.click('.apl-icon-btn[aria-label^="Previous family"]');
await onFamily('Avery Stone');
await page.click('.apl-icon-btn[aria-label^="Next family"]');
await onFamily(second);
await sleep(300);
const mid = { picked: await pressedOf(extra), saving: !!(await page.$('.apl-type-picks.is-saving')) };
ok(mid.picked === 'true' && mid.saving, `opened again mid-save, ${second} shows ${extra} picked and still saving (${JSON.stringify(mid)})`);
await pickPill(secondTypes[0]);
await idle(); await sleep(600);
const want = [...secondTypes.slice(1), extra];
ok(fieldSaves === 2 && JSON.stringify(acct(second).fields[F.types]) === JSON.stringify(want) && await pressedOf(secondTypes[0]) === 'false' && await pressedOf(extra) === 'true', `the newer pick waits for the older save, so JobTread ends with both (${JSON.stringify(acct(second).fields[F.types])}, want ${JSON.stringify(want)})`);
await pickPill(extra); await idle();
await pickPill(secondTypes[0]); await idle(); await sleep(300);
ok(JSON.stringify(acct(second).fields[F.types].slice().sort()) === JSON.stringify(secondTypes.slice().sort()), `${second} put back as it was`);
await page.click('.apl-icon-btn[aria-label^="Previous family"]');
await onFamily('Avery Stone');
// Makeover year changed past the season filter: the family leaves the list, Previous and Next still work
const yearSel = '.apl-kv select[aria-label="Makeover year"]';
const navOn = () => page.$$eval('.apl-icon-btn[aria-label$="family (K)"], .apl-icon-btn[aria-label$="family (J)"]', els => els.map(e => !e.disabled));
const navBefore = await navOn();
await page.select(yearSel, '2026');
await page.waitForFunction(() => !document.querySelector('.apl-kv select[aria-label="Makeover year"].is-saving'), { timeout: 8000 }).catch(() => null);
await sleep(600);
const navAfter = await navOn();
ok(acct('Avery Stone').fields[F.year] === '2026' && navAfter.some(Boolean) && JSON.stringify(navAfter) === JSON.stringify(navBefore), `a family moved to another year keeps Previous and Next (${JSON.stringify(navBefore)} → ${JSON.stringify(navAfter)})`);
await page.select(yearSel, '2027');
await page.waitForFunction(() => !document.querySelector('.apl-kv select[aria-label="Makeover year"].is-saving'), { timeout: 8000 }).catch(() => null);
await sleep(600);
ok(acct('Avery Stone').fields[F.year] === '2027', 'and moved back');
const dxBtn = await page.$('.apl-kv button.apl-edit');
const textLeft = (el) => el.evaluate(e => { const cs = getComputedStyle(e); return e.getBoundingClientRect().left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft); });
const shownAt = await textLeft(dxBtn);
await dxBtn.click();
const input = await page.$('.apl-kv input.form-input, .apl-kv textarea.form-input');
ok(Math.abs(await textLeft(input) - shownAt) <= 1, `opening a detail to type in keeps its text where it was (moved ${(await textLeft(input) - shownAt).toFixed(1)}px)`);
await page.keyboard.type('05202016');
await page.keyboard.press('Enter');
await sleep(600);
ok(acct('Avery Stone').fields[F.birthday] === '2016-05-20', `a date detail edits in place (${acct('Avery Stone').fields[F.birthday]})`);
const editBtn = (label) => page.$(`.apl-kv button.apl-edit[aria-label="Edit ${label}"]`);
const kvInput = '.apl-kv input.form-input, .apl-kv textarea.form-input';
const refWas = acct('Avery Stone').fields[F.referredBy];
// Escape puts back what was there: nothing saved
fieldSaves = 0;
await (await editBtn('Referred by')).click();
await page.waitForSelector(kvInput);
await page.keyboard.type(' WRONG');
await page.keyboard.press('Escape');
await sleep(700);
ok(fieldSaves === 0 && acct('Avery Stone').fields[F.referredBy] === refWas && (await text(page, '.apl-kv button.apl-edit[aria-label="Edit Referred by"]')) === refWas && !!(await page.$('.apl-drawer')), `Escape cancels a typed detail: nothing saved, the drawer stays (${fieldSaves} saves)`);
// Enter saves once
await (await editBtn('Referred by')).click();
await page.waitForSelector(kvInput);
await page.$eval(kvInput, el => el.select());
await page.keyboard.type('Dr. Patel');
await page.keyboard.press('Enter');
await sleep(800);
ok(fieldSaves === 1 && acct('Avery Stone').fields[F.referredBy] === 'Dr. Patel', `Enter saves a typed detail once (${fieldSaves} saves)`);
// Spaces only are nothing: the detail is cleared and says Add
fieldSaves = 0;
await (await editBtn('Referred by')).click();
await page.waitForSelector(kvInput);
await page.$eval(kvInput, el => el.select());
await page.keyboard.type('   ');
await page.keyboard.press('Enter');
await sleep(800);
ok(fieldSaves === 1 && !acct('Avery Stone').fields[F.referredBy] && (await text(page, '.apl-kv button.apl-edit[aria-label="Edit Referred by"]')) === 'Add', `spaces alone clear a detail, which then says Add (${JSON.stringify(acct('Avery Stone').fields[F.referredBy])})`);
await (await editBtn('Referred by')).click();
await page.waitForSelector(kvInput);
await page.keyboard.type(refWas);
await page.keyboard.press('Enter');
await sleep(800);
// A birthday left half-typed keeps the one it had
const bdWas = acct('Avery Stone').fields[F.birthday];
fieldSaves = 0;
await (await editBtn('Birthday')).click();
await page.waitForSelector('.apl-kv input[type="date"]');
await page.keyboard.press('Backspace');
await page.click('.apl-panel h3');
await sleep(800);
ok(fieldSaves === 0 && acct('Avery Stone').fields[F.birthday] === bdWas && /\(\d+\)$/.test(await text(page, '.apl-kv button.apl-edit[aria-label="Edit Birthday"]')), `a birthday left half-typed keeps the one it had (${fieldSaves} saves, ${acct('Avery Stone').fields[F.birthday]})`);
// A year cut short is a real date to the browser (0020), and a future birthday can't be right: the old one stays, and it says why
for (const [what, keysTyped] of [['a year cut short', '061220'], ['a future date', '06122030']]) {
  fieldSaves = 0;
  await page.evaluate(() => { window.__toasts.length = 0; });
  await (await editBtn('Birthday')).click();
  await page.waitForSelector('.apl-kv input[type="date"]');
  await page.keyboard.type(keysTyped);
  await page.click('.apl-panel h3');
  await sleep(600);
  ok(fieldSaves === 0 && acct('Avery Stone').fields[F.birthday] === bdWas && await page.evaluate(() => window.__toasts.some(t => /Birthday not changed/.test(t.msg))), `${what} keeps the birthday it had, and says so (${fieldSaves} saves, ${acct('Avery Stone').fields[F.birthday]})`);
}
// Opening a typed detail doesn't move the card
const rowTops = () => page.$$eval('.apl-side .apl-kv dt', els => els.map(e => Math.round(e.getBoundingClientRect().top)));
const topsShut = await rowTops();
await (await editBtn('Birthday')).click();
await page.waitForSelector('.apl-kv input[type="date"]');
const topsOpen = await rowTops();
await page.keyboard.press('Escape');
await sleep(150);
ok(JSON.stringify(topsShut) === JSON.stringify(topsOpen), `opening a typed detail leaves the rows where they are (${topsOpen.map((t, i) => t - topsShut[i]).join(',')})`);
// Enter and Escape hand the focus back to the detail
const focused = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName);
for (const key of ['Enter', 'Escape']) {
  await page.focus('.apl-kv button.apl-edit[aria-label="Edit Referred by"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector(kvInput);
  await page.keyboard.press(key);
  await sleep(200);
  ok(await focused() === 'Edit Referred by', `${key} in a typed detail puts the focus back on it (${await focused()})`);
}
// A save that fails keeps what was typed, in its box, to try again; the message says whose and what
const dxWas = acct('Avery Stone').fields[F.diagnosis];
failFields = true;
await page.evaluate(() => { window.__toasts.length = 0; });
await (await editBtn('Diagnosis')).click();
await page.waitForSelector('.apl-kv textarea');
await page.$eval('.apl-kv textarea', el => el.select());
await page.keyboard.type('A long paragraph worth keeping');
await page.click('.apl-panel h3');
await page.waitForFunction(() => document.querySelector('.apl-kv textarea'), { timeout: 8000 }).catch(() => null);
await sleep(300);
ok(await page.$eval('.apl-kv textarea', el => el.value).catch(() => '') === 'A long paragraph worth keeping' && await page.evaluate(() => window.__toasts.some(t => /^Avery Stone: Diagnosis not saved\. JobTread didn’t answer/.test(t.msg))), `a failed save keeps the typed text in its box and names the family and detail (${JSON.stringify(await page.evaluate(() => window.__toasts.map(t => t.msg)))})`);
failFields = false;
await page.click('.apl-panel h3');
await sleep(700);
ok(acct('Avery Stone').fields[F.diagnosis] === 'A long paragraph worth keeping', 'leaving the box tries again, and it saves');
await (await editBtn('Diagnosis')).click();
await page.waitForSelector('.apl-kv textarea');
await page.$eval('.apl-kv textarea', el => el.select());
await page.keyboard.type(dxWas);
await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
await sleep(700);
// Failing after you've moved on: the message says whose it was, and the text waits in that family's box
slowFields = 700; failFields = true;
await page.evaluate(() => { window.__toasts.length = 0; });
await (await editBtn('Referred by')).click();
await page.waitForSelector(kvInput);
await page.$eval(kvInput, el => el.select());
await page.keyboard.type('Typed before moving on');
await page.keyboard.press('Enter');
await page.click('.apl-icon-btn[aria-label^="Next family"]');
await sleep(1300);
ok(await text(page, '.apl-dtitle h2') !== 'Avery Stone' && await page.evaluate(() => window.__toasts.some(t => /^Avery Stone: Referred by not saved/.test(t.msg))), `a save failing after you moved on names its family (${JSON.stringify(await page.evaluate(() => window.__toasts.map(t => t.msg)))})`);
slowFields = 0; failFields = false;
await page.click('.apl-icon-btn[aria-label^="Previous family"]');
await page.waitForFunction(() => document.querySelector('.apl-dtitle h2')?.textContent.trim() === 'Avery Stone' && document.querySelector('.apl-kv input.form-input'), { timeout: 8000 }).catch(() => null);
ok(await page.$eval('.apl-kv input.form-input', el => el.value).catch(() => '') === 'Typed before moving on', 'and coming back, the text is waiting in its box');
await page.$eval('.apl-kv input.form-input', el => el.focus());
await page.keyboard.press('Escape');
await sleep(300);
ok(acct('Avery Stone').fields[F.referredBy] === refWas && (await text(page, '.apl-kv button.apl-edit[aria-label="Edit Referred by"]')) === refWas, 'Escape lets it go');
// J and K keep the focus inside the drawer
await page.focus('.apl-type-picks button');
await page.keyboard.press('j');
await sleep(700);
const heldFocus = await page.evaluate(() => { const el = document.activeElement; return { inDrawer: !!el?.closest('.apl-drawer'), ring: getComputedStyle(document.querySelector('.apl-drawer')).boxShadow }; });
ok(heldFocus.inDrawer && !/0px 0px 0px 4px/.test(heldFocus.ring), `J keeps the focus in the drawer, with no ring round it (${JSON.stringify(heldFocus)})`);
await page.keyboard.press('k');
await page.waitForFunction(() => document.querySelector('.apl-dtitle h2')?.textContent.trim() === 'Avery Stone' && document.querySelector('.apl-type-picks'), { timeout: 8000 }).catch(() => null);
// A finished save counts at once, however slow the reload behind it
const typedBox = '.apl-kv input.form-input[aria-label="Referred by"]';
slowReads = 1500; fieldSaves = 0;
await (await editBtn('Referred by')).click();
await page.waitForSelector(typedBox);
await page.$eval(typedBox, el => el.select());
await page.keyboard.type('Dr. Patel');
await page.keyboard.press('Enter');
await sleep(400);
await (await editBtn('Referred by')).click();
await page.waitForSelector(typedBox);
ok(await page.$eval(typedBox, el => el.value) === 'Dr. Patel', 'opened again before the reload lands, the box shows what was just saved');
await page.click('.apl-panel h3');
await sleep(500);
ok(fieldSaves === 1 && acct('Avery Stone').fields[F.referredBy] === 'Dr. Patel', `and leaving it untouched saves nothing, so the old value can't come back (${fieldSaves} saves, ${acct('Avery Stone').fields[F.referredBy]})`);
fieldSaves = 0;
await pickPill('Ramp'); await sleep(250);
await pickPill('Ramp'); await sleep(400);
ok(fieldSaves === 2 && JSON.stringify(acct('Avery Stone').fields[F.types]) === JSON.stringify(['Bedroom', 'Bathroom', 'Ramp']), `unpicking and picking again before the reload lands saves both (${fieldSaves} saves, ${JSON.stringify(acct('Avery Stone').fields[F.types])})`);
await sleep(1800);
ok(await pressedOf('Ramp') === 'true', 'and the reload leaves it picked');
slowReads = 0;
await (await editBtn('Referred by')).click();
await page.waitForSelector(typedBox);
await page.$eval(typedBox, el => el.select());
await page.keyboard.type(refWas);
await page.keyboard.press('Enter');
await sleep(700);
// Closing the drawer mid-save and opening the family again
const closeDrawer = '.apl-dhead button[aria-label^="Close"]';
const openAvery = async () => { await page.click('.apl-card[data-id="acct00000001"]'); await page.waitForSelector('.apl-type-picks', { timeout: 8000 }); };
fieldSaves = 0; slowQueue.push(1800);
await pickPill('Ramp');
await page.click(closeDrawer);
await sleep(350);
await openAvery();
await sleep(250);
ok(await pressedOf('Ramp') === 'false' && !!(await page.$('.apl-type-picks.is-saving')), 'closed and reopened mid-save, the family shows the pick still saving');
await pickPill('Ramp');
await idle(); await sleep(500);
ok(fieldSaves === 2 && JSON.stringify(acct('Avery Stone').fields[F.types]) === JSON.stringify(['Bedroom', 'Bathroom', 'Ramp']) && await pressedOf('Ramp') === 'true', `and a pick made then is saved after it (${fieldSaves} saves, ${JSON.stringify(acct('Avery Stone').fields[F.types])})`);
slowQueue.push(1200);
await pickPill('Ramp');
await page.click(closeDrawer);
await sleep(300);
await openAvery();
await page.waitForFunction(() => !document.querySelector('.apl-type-picks.is-saving') && (document.querySelector('.apl-thread')?.textContent || '').includes('Makeover type: Bedroom, Bathroom'), { timeout: 5000 }).catch(() => null);
ok((await text(page, '.apl-thread')).includes('Makeover type: Bedroom, Bathroom'), 'with nothing more done, the history catches up as soon as the save lands, not at the next refresh');
await pickPill('Ramp'); await idle(); await sleep(400);
// A save failing while you've gone back in to type more leaves the newer text alone
slowFields = 900; failFields = true;
await (await editBtn('Referred by')).click();
await page.waitForSelector(typedBox);
await page.$eval(typedBox, el => el.select());
await page.keyboard.type('First');
await page.keyboard.press('Enter');
await sleep(150);
await (await editBtn('Referred by')).click();
await page.waitForSelector(typedBox);
await page.keyboard.type(' and more');
await sleep(1200);
ok(/First and more$/.test(await page.$eval(typedBox, el => el.value)), `a failed save leaves text typed since alone (${await page.$eval(typedBox, el => el.value)})`);
slowFields = 0; failFields = false;
await page.keyboard.press('Escape');
await sleep(250);
// What a box can hold: it stops there and says so, and JobTread, the box and the history agree
await page.evaluate(() => { window.__toasts.length = 0; });
await (await editBtn('Referred by')).click();
await page.waitForSelector(typedBox);
await page.$eval(typedBox, el => el.select());
await page.keyboard.sendCharacter('x'.repeat(450));
await sleep(200);
ok((await page.$eval(typedBox, el => el.value.length)) === 300 && await page.evaluate(() => window.__toasts.some(t => /Referred by holds 300 characters/.test(t.msg))), `a box stops at what JobTread keeps, and says so (${await page.$eval(typedBox, el => el.value.length)} characters)`);
await page.keyboard.press('Escape');
await sleep(250);
// The click that closes an open box lands on what's under it
await (await editBtn('Diagnosis')).click();
await page.waitForSelector('.apl-kv textarea');
ok(await page.$eval('.apl-kv textarea', el => getComputedStyle(el).resize) === 'vertical', 'the Diagnosis box drags taller, never past the card');
const belowBox = await page.$eval('.apl-kv button.apl-edit[aria-label="Edit Referred by"]', el => { const r = el.getBoundingClientRect(); return { x: r.x + 40, y: r.y + r.height / 2 }; });
await page.mouse.click(belowBox.x, belowBox.y, { delay: 60 });
await sleep(350);
ok(!!(await page.$(typedBox)) && !(await page.$('.apl-kv textarea')), 'clicking a detail below an open Diagnosis box opens it the first time');
await page.keyboard.press('Escape');
await sleep(250);
// Opening a detail and leaving it unchanged writes nothing, whatever spaces JobTread holds
fieldSaves = 0;
acct('Avery Stone').fields[F.referredBy] = `${refWas}  `;
await page.click('.apl-icon-btn[aria-label^="Next family"]');
await sleep(500);
await page.click('.apl-icon-btn[aria-label^="Previous family"]');
await page.waitForSelector('.apl-kv button.apl-edit[aria-label="Edit Referred by"]', { timeout: 8000 });
await page.waitForFunction(() => document.querySelector('.apl-dtitle h2')?.textContent.trim() === 'Avery Stone', { timeout: 8000 }).catch(() => null);
await sleep(300);
await (await editBtn('Referred by')).click();
await page.waitForSelector(typedBox);
await page.click('.apl-panel h3');
await sleep(500);
ok(fieldSaves === 0, `opening a detail and leaving it unchanged saves nothing (${fieldSaves} saves)`);
acct('Avery Stone').fields[F.referredBy] = refWas;
// Ctrl+K and Ctrl+J aren't K and J
const heldOn = await text(page, '.apl-dtitle h2');
await page.$eval('.apl-drawer', el => el.focus());
for (const key of ['k', 'j']) { await page.keyboard.down('Control'); await page.keyboard.press(key); await page.keyboard.up('Control'); await sleep(250); }
ok(await text(page, '.apl-dtitle h2') === heldOn, 'Ctrl+K and Ctrl+J leave the family alone');
// Tab stays in the drawer
const stops = () => page.$eval('.apl-drawer', el => [...el.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(x => x.offsetParent).length);
ok(await stops() > 5, 'the drawer has controls to Tab through');
const inDrawer = () => page.evaluate(() => !!document.activeElement?.closest('.apl-drawer'));
await page.$eval('.apl-drawer', el => { const all = [...el.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(x => x.offsetParent); all[all.length - 1].focus(); });
await page.keyboard.press('Tab');
const wrapped = await inDrawer();
await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
ok(wrapped && await inDrawer(), 'Tab and Shift+Tab stay in the drawer at both ends');
// The green "saved" flash plays once
await (await editBtn('Referred by')).click();
await page.waitForSelector(typedBox);
await page.$eval(typedBox, el => el.select());
await page.keyboard.type('Flash check');
await page.keyboard.press('Enter');
await sleep(1700);
ok(!(await page.$('.apl-kv .apl-edit.is-saved')), 'the saved flash plays once and goes');
await (await editBtn('Referred by')).click();
await page.waitForSelector(typedBox);
await page.$eval(typedBox, el => el.select());
await page.keyboard.type(refWas);
await page.keyboard.press('Enter');
await sleep(1600);
// A slower, older list can't undo a newer one
listDelays.push(1500, 0);
await pickPill('Ramp'); await idle(); await sleep(200);
await pickPill('Ramp'); await idle();
await sleep(2200);
ok(await page.$eval('.apl-card[data-id="acct00000001"]', el => /Ramp/.test(el.textContent)), 'an older list landing late doesn’t undo a newer one');
// J and K belong to the drawer on a focused choice too: K never picks Korean
fieldSaves = 0;
await page.focus('.apl-kv select[aria-label="Primary language"]');
await page.keyboard.press('k');
await sleep(600);
ok(fieldSaves === 0 && acct('Avery Stone').fields[F.language] !== 'Korean', `K on a focused choice doesn't pick from it (${fieldSaves} saves, ${acct('Avery Stone').fields[F.language]})`);
const fromChoice = await text(page, '.apl-dtitle h2');
if (fromChoice !== 'Avery Stone') { await page.keyboard.press('j'); await sleep(600); }
await page.waitForFunction(() => document.querySelector('.apl-dtitle h2')?.textContent.trim() === 'Avery Stone' && document.querySelector('.apl-type-picks'), { timeout: 8000 }).catch(() => null);
await sleep(200);
// A saved detail leaves the conversation where you're reading it
await page.$eval('.apl-thread', el => { el.scrollTop = 0; });
await sleep(150);
await pickPill('Ramp'); await idle(); await sleep(500);
ok((await page.$eval('.apl-thread', el => el.scrollTop)) < 20, `saving a detail leaves the conversation where you were reading (${await page.$eval('.apl-thread', el => el.scrollTop)})`);
await pickPill('Ramp'); await idle(); await sleep(400);
// A message started and not sent waits for you
await page.click('.apl-composer textarea');
await page.keyboard.type('A draft for Jordan');
await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.querySelector('.apl-drawer'), { timeout: 5000 }).catch(() => null);
await openAvery();
await page.waitForSelector('.apl-composer textarea', { timeout: 8000 });
ok(await page.$eval('.apl-composer textarea', el => el.value) === 'A draft for Jordan', 'a message started and not sent is there when the family is opened again');
await page.click('.apl-icon-btn[aria-label^="Next family"]');
await sleep(500);
const draftOther = await page.$eval('.apl-composer textarea', el => el.value).catch(() => null);
await page.click('.apl-icon-btn[aria-label^="Previous family"]');
await onFamily('Avery Stone');
await page.waitForSelector('.apl-composer textarea', { timeout: 8000 });
ok(!draftOther && await page.$eval('.apl-composer textarea', el => el.value) === 'A draft for Jordan', 'it stays with its own family, moving between families');
await page.click('.apl-composer textarea');
await page.$eval('.apl-composer textarea', el => el.select());
await page.keyboard.press('Backspace');
await sleep(150);
// A date JobTread holds in another form shows as it is, and opening it changes nothing
const bdKept = acct('Avery Stone').fields[F.birthday];
fieldSaves = 0;
acct('Avery Stone').fields[F.birthday] = '4/12/2016';
await page.click('.apl-icon-btn[aria-label^="Next family"]');
await sleep(500);
await page.click('.apl-icon-btn[aria-label^="Previous family"]');
await onFamily('Avery Stone');
await page.waitForSelector('.apl-kv button.apl-edit[aria-label="Edit Birthday"]', { timeout: 8000 });
await sleep(300);
ok((await text(page, '.apl-kv button.apl-edit[aria-label="Edit Birthday"]')) === '4/12/2016', 'a date in another form shows as it is, not “Invalid Date”');
await (await editBtn('Birthday')).click();
await page.waitForSelector('.apl-kv input[type="date"]');
await page.click('.apl-panel h3');
await sleep(500);
ok(fieldSaves === 0 && acct('Avery Stone').fields[F.birthday] === '4/12/2016', `and opening and leaving it doesn't erase it (${fieldSaves} saves, ${acct('Avery Stone').fields[F.birthday]})`);
acct('Avery Stone').fields[F.birthday] = bdKept;
await page.click('.apl-icon-btn[aria-label^="Next family"]');
await sleep(500);
await page.click('.apl-icon-btn[aria-label^="Previous family"]');
await onFamily('Avery Stone');
await sleep(300);
// A choice shows the new value while JobTread saves it
slowFields = 1200;
await page.select('.apl-kv select[aria-label="Gender"]', 'Male');
await sleep(250);
ok(await page.$eval('.apl-kv select[aria-label="Gender"]', el => el.value) === 'Male', 'a choice shows its new value while it saves');
ok(await page.$eval('.apl-kv select[aria-label="Gender"]', el => Number(getComputedStyle(el).opacity) < 1), 'and shows that it’s saving');
await page.waitForFunction(() => !document.querySelector('.apl-kv select[aria-label="Gender"].is-saving'), { timeout: 8000 }).catch(() => null);
slowFields = 0;
await sleep(500);
ok(acct('Avery Stone').fields[F.gender] === 'Male' && await page.$eval('.apl-kv select[aria-label="Gender"]', el => el.value) === 'Male', 'and keeps it once saved');
await page.select('.apl-kv select[aria-label="Gender"]', 'Female');
await page.waitForFunction(() => !document.querySelector('.apl-kv select[aria-label="Gender"].is-saving'), { timeout: 8000 }).catch(() => null);
await sleep(500);
// A choice reached with Tab shows the focus ring
await page.focus('.apl-kv button.apl-edit[aria-label="Edit Birthday"]');
await page.keyboard.press('Tab');
await sleep(400); // the ring fades in
const ring = await page.evaluate(() => { const el = document.activeElement; return { tag: el.tagName, shadow: getComputedStyle(el).boxShadow }; });
ok(ring.tag === 'SELECT' && /4px/.test(ring.shadow), `a choice reached with Tab shows the focus ring (${ring.tag} ${ring.shadow})`);
// An open Diagnosis box keeps its label on the first line
await (await editBtn('Diagnosis')).click();
await page.waitForSelector('.apl-kv textarea');
const dxAlign = await page.$eval('.apl-kv textarea', ta => {
  const dt = ta.closest('dd').previousElementSibling; const r = document.createRange(); r.selectNodeContents(dt);
  const l = [...r.getClientRects()][0]; const cs = getComputedStyle(ta); const t = ta.getBoundingClientRect();
  const firstLine = t.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop);
  return (l.top + l.height / 2) - (firstLine + (parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4) / 2);
});
await page.keyboard.press('Escape');
ok(Math.abs(dxAlign) <= 3, `an open Diagnosis box keeps its label on its first line (${dxAlign.toFixed(1)}px)`);
await shot(page, 'desktop-family-after');
// The home on a small map in the Home card, inside the area: centered on the pin, the area drawn
await page.waitForSelector('.apl-homemap .apl-pin', { timeout: 15000 }).catch(() => null);
const hm = await page.evaluate(() => {
  const plain = (r) => r && { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; // DOMRects come back empty
  const box = plain(document.querySelector('.apl-homemap')?.getBoundingClientRect());
  const pin = plain(document.querySelector('.apl-homemap .apl-pin')?.getBoundingClientRect());
  const paths = [...document.querySelectorAll('.apl-homemap .leaflet-overlay-pane path')].map(e => ({ stroke: (e.getAttribute('stroke') || '').toLowerCase(), fill: (e.getAttribute('fill') || '').toLowerCase(), dash: e.getAttribute('stroke-dasharray') || '' }));
  const dir = document.querySelector('.apl-home-links a')?.href || '';
  return { box, pin, paths, dir, label: !!document.querySelector('.apl-homemap .apl-gap') };
});
ok(hm.box?.width > 200 && hm.box?.height > 150, `the Home card shows the home on a map (${Math.round(hm.box?.width || 0)}×${Math.round(hm.box?.height || 0)})`);
// Whole zoom levels only: tiles drawn at exactly 256px, so no white seams between them
await page.waitForFunction(() => document.querySelectorAll('.apl-homemap img.leaflet-tile').length > 0, { timeout: 8000 }).catch(() => null);
const tileW = await page.$$eval('.apl-homemap img.leaflet-tile', els => [...new Set(els.map(e => Math.round(e.getBoundingClientRect().width * 100) / 100))]);
ok(tileW.length === 1 && tileW[0] === 256, `map tiles aren't scaled, so no seams show between them (${tileW.join(', ')}px)`);
ok(hm.pin && Math.abs(hm.pin.x + hm.pin.width / 2 - (hm.box.x + hm.box.width / 2)) < 6 && Math.abs(hm.pin.y + hm.pin.height / 2 - (hm.box.y + hm.box.height / 2)) < 6, 'the home sits in the middle of it');
ok(hm.paths.some(p => p.stroke === '#373a36' && p.fill === 'none') && !hm.paths.some(p => p.fill === '#ffda24'), 'the area is a line only, so no yellow washes over the streets');
ok(!hm.paths.some(p => p.dash === '2 6') && !hm.label, 'and no gap line or miles for a home inside it');
ok(/^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=101%20Maple%20Dr/.test(hm.dir), `Directions opens Google Maps to the home (${hm.dir.slice(0, 80)})`);
await page.$eval('.apl-homemap', el => el.scrollIntoView({ block: 'center' }));
await sleep(800);
await page.$eval('.apl-homemap', el => el.scrollIntoView({ block: 'center' }));
await page.screenshot({ path: join(OUT, 'desktop-family-homemap.png'), clip: await page.$eval('.apl-side', el => { const r = el.getBoundingClientRect(); return { x: r.x, y: Math.max(0, r.y), width: r.width, height: Math.min(r.height, 900) }; }) });
// Keyboard: next family, then close
await page.keyboard.press('j');
await sleep(500);
ok(!/Avery Stone/.test(await text(page, '.apl-dtitle h2')), 'J moves to the next family');
await page.waitForFunction(() => /Avery/.test(document.querySelector('.apl-homemap')?.getAttribute('aria-label') || '') === false, { timeout: 4000 }).catch(() => null);
await sleep(400);
const nx = await page.evaluate(() => {
  const plain = (r) => r && { x: r.x, y: r.y, width: r.width, height: r.height }; // DOMRects come back empty
  const box = plain(document.querySelector('.apl-homemap')?.getBoundingClientRect());
  const pin = plain(document.querySelector('.apl-homemap .apl-pin')?.getBoundingClientRect());
  return { box, pin, label: document.querySelector('.apl-homemap')?.getAttribute('aria-label') || '' };
});
ok(!/101 Maple/.test(nx.label) && nx.pin && nx.box && Math.abs(nx.pin.x + nx.pin.width / 2 - (nx.box.x + nx.box.width / 2)) < 6 && Math.abs(nx.pin.y + nx.pin.height / 2 - (nx.box.y + nx.box.height / 2)) < 6, `and the small map moves to that family's home (${nx.label})`);
await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.querySelector('.apl-drawer'), { timeout: 4000 }).catch(() => null);
ok(!(await page.$('.apl-drawer')), 'Esc closes the family');
// A family no one can be emailed at: the box says who needs an email address in JobTread, and offers nothing to send
const evan = acct('Evan Burkett');
evan.contacts[0].fields[EMAIL] = '';
await page.click(`.apl-card[data-id="${evan.id}"]`);
await page.waitForFunction(() => /No one on this family has an email address/.test(document.querySelector('.apl-composer')?.textContent || ''), { timeout: 8000 }).catch(() => null);
ok(/No one on this family has an email address in JobTread.*Sam Burkett/.test(await text(page, '.apl-composer')) && !(await page.$('.apl-composer textarea')), 'a family no one can be emailed at: the box names who needs an email in JobTread, and offers nothing to send');
await shot(page, 'desktop-family-no-email');
await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.querySelector('.apl-drawer'), { timeout: 4000 }).catch(() => null);

// Status sheet from the drawer: Denied with a reason, without email
await page.click('.apl-card[data-id="acct00000003"]');
await page.waitForSelector('.apl-status-select select');
await page.select('.apl-status-select select', 'Denied');
await page.waitForSelector('.apl-sheet .apl-check input', { timeout: 8000 });
await page.click('.apl-sheet .apl-check input');
await page.type('.apl-sheet textarea', 'Outside the service area');
ok(/Move to Denied/.test(await text(page, '.apl-sheet-foot .btn-primary')), 'unticking the email changes the button to a plain move');
await page.click('.apl-sheet-foot .btn-primary');
await page.waitForFunction(() => !document.querySelector('.apl-sheet'), { timeout: 8000 });
await sleep(300);
ok(acct('Harper Lee').fields[F.status] === 'Denied' && acct('Harper Lee').fields[F.denialReason] === 'Outside the service area', 'Denied with the reason saved in JobTread');
ok(!acct('Harper Lee').comments.some(c => c.name === 'Application Decision'), 'and no decision email went out');
await page.keyboard.press('Escape');
await sleep(300);

// List
await page.click('.apl-views [data-view="list"]');
await page.waitForSelector('.apl-table');
await page.keyboard.press('/');
ok(await page.evaluate(() => document.activeElement?.type === 'search'), '"/" jumps to search');
await page.keyboard.type('canton');
await sleep(200);
ok(await page.$$eval('.apl-table tbody tr', els => els.length) === 2, 'search finds families by city');
await page.click('.apl-search input', { clickCount: 3 });
await page.keyboard.press('Backspace');
await page.select('select.apl-season', '');
ok(await page.$$eval('.apl-active button', els => els.some(e => /All years/.test(e.textContent))), 'a season other than this one shows as a chip');
// The status counts filter the list
await page.evaluate(() => [...document.querySelectorAll('.apl-strip button')].find(b => /In Review/.test(b.textContent))?.click());
await sleep(150);
ok(await page.$$eval('.apl-table tbody tr .apl-pill', els => els.length > 0 && els.every(e => e.textContent === 'In Review')), 'the In Review count shows just those families');
await page.click('.apl-strip button.is-all');
await sleep(150);
// Filters panel: the area filter, then its chip clears it
await page.click('.apl-fbtn');
await page.waitForSelector('.apl-popover');
await page.select('.apl-popover select[aria-label="Service area"]', 'outside');
await sleep(200);
const outside = await page.$$eval('.apl-table tbody tr strong', els => els.map(e => e.textContent));
ok(outside.includes('Logan Logan') && outside.includes('Harper Lee'), `area filter lists homes outside the boundary (${outside.join(', ')})`);
ok(/1/.test(await text(page, '.apl-fbtn b')), 'the Filters button counts the filters in use');
await page.click('#apl-tests');
await sleep(200);
ok(await page.$$eval('.apl-table tbody tr strong', els => els.some(e => /TEST Sample Family/.test(e.textContent))) && /Including test families/.test(await text(page, '.apl-active')), 'Include test families brings them back, as a chip');
await page.click('#apl-tests');
await sleep(150);
await page.keyboard.press('Escape');
await sleep(150);
ok(!(await page.$('.apl-popover')), 'Esc closes the Filters panel');
// A home outside the area: its small map frames the home and the nearest edge, with the gap drawn
await page.evaluate(() => [...document.querySelectorAll('.apl-table tbody tr')].find(r => /Logan Logan/.test(r.textContent))?.click());
await page.waitForSelector('.apl-homemap .apl-pin', { timeout: 15000 }).catch(() => null);
await sleep(400);
const far = await page.evaluate(() => {
  const plain = (r) => r && { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; // DOMRects come back empty
  const box = plain(document.querySelector('.apl-homemap')?.getBoundingClientRect());
  const pin = plain(document.querySelector('.apl-homemap .apl-pin')?.getBoundingClientRect());
  const gap = plain([...document.querySelectorAll('.apl-homemap .leaflet-overlay-pane path')].find(e => e.getAttribute('stroke-dasharray') === '2 6')?.getBoundingClientRect());
  const label = document.querySelector('.apl-homemap .apl-gap');
  const fill = [...document.querySelectorAll('.apl-homemap .leaflet-overlay-pane path')].some(e => (e.getAttribute('fill') || '').toLowerCase() === '#ffda24');
  return { box, pin, gap, fill, label: label?.textContent || '', labelBox: plain(label?.getBoundingClientRect()), tag: document.querySelector('.apl-side .apl-tag.is-out')?.textContent || '' };
});
ok(!!far.gap && far.gap.width + far.gap.height > 60, 'a home outside the area: the small map draws the gap to the area');
ok(!!far.label && far.tag.startsWith(far.label.replace(' mi', ' miles')), `the gap is labeled with the same miles as the tag (${far.label})`);
ok(far.labelBox && far.labelBox.x >= far.box.x && far.labelBox.right <= far.box.right && far.labelBox.y >= far.box.y && far.labelBox.bottom <= far.box.bottom, 'and the label sits inside the map');
ok(far.fill, 'the area is filled yellow, so its shape reads from outside');
ok(far.pin && far.box && far.pin.x >= far.box.x && far.pin.right <= far.box.right && far.pin.y >= far.box.y && far.pin.bottom <= far.box.bottom, 'and keeps the home in view');
await page.$eval('.apl-homemap', el => el.scrollIntoView({ block: 'center' }));
await sleep(800);
await page.screenshot({ path: join(OUT, 'desktop-family-homemap-outside.png'), clip: await page.$eval('.apl-side', el => { const r = el.getBoundingClientRect(); return { x: r.x, y: Math.max(0, r.y), width: r.width, height: Math.min(r.height, 900) }; }) });
await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.querySelector('.apl-drawer'), { timeout: 4000 }).catch(() => null);
await shot(page, 'desktop-list-filtered');
await page.evaluate(() => [...document.querySelectorAll('.apl-active button')].find(b => /Outside the boundary/.test(b.textContent))?.click());
await sleep(200);
ok(!(await page.$$eval('.apl-active button', els => els.some(e => /Outside the boundary/.test(e.textContent)))), 'a filter chip clears its filter');
await shot(page, 'desktop-list');

// Map
await page.click('.apl-views [data-view="map"]');
await page.waitForSelector('.leaflet-container', { timeout: 15000 });
await sleep(1500);
ok(await page.$$eval('.apl-pin', els => els.length) >= 9, 'every family with a home has a pin');
const paths = await page.$$eval('.leaflet-overlay-pane path', els => els.map(e => ({ stroke: (e.getAttribute('stroke') || '').toLowerCase(), fill: (e.getAttribute('fill') || '').toLowerCase(), dash: e.getAttribute('stroke-dasharray') || '' })));
ok(paths.some(p => p.stroke === '#373a36' && p.fill === '#ffda24' && !p.dash), 'the service area is drawn as families see it: yellow, a charcoal line');
ok(paths.some(p => p.stroke === '#373a36' && p.dash === '5 6' && p.fill !== '#ffda24'), 'with the close ring dashed around it');
ok(/Close: within 15 miles/.test(await text(page, '.apl-legend')), 'the legend says what the ring is');
await page.click('.apl-legend button:nth-child(4)'); // hide Denied
await sleep(200);
ok(await page.$$eval('.apl-legend button[aria-pressed="false"]', els => els.length) === 1, 'legend toggles a status off');
await shot(page, 'desktop-map');
await page.click('.apl-legend button:nth-child(4)');
// Edit the boundary: drag a corner
await page.click('.apl-map-tools .btn');
await page.waitForSelector('.apl-handle');
const h0 = await page.$('.apl-handle:not(.is-mid)');
const hb = await h0.boundingBox();
await page.mouse.move(hb.x + 7, hb.y + 7);
await page.mouse.down();
await page.mouse.move(hb.x + 60, hb.y + 40, { steps: 8 });
await page.mouse.up();
await sleep(300);
await shot(page, 'desktop-map-edit');
ok(/right away/.test(await text(page, '.apl-map-note')), 'editing says the boundary is used for everyone once saved');
ok(/famil(y|ies) (moves?|change)|No family changes sides/.test(await text(page, '.apl-map-note')), `while reshaping, it says who changes sides (${(await text(page, '.apl-map-note b')) || 'nothing said'})`);
const before = JSON.stringify((await getLiveForm(DB, { fresh: true })).definition.serviceArea.polygon);
await page.click('.apl-map-note .btn-primary'); // Save boundary
await page.waitForFunction(() => !document.querySelector('.apl-map-note'), { timeout: 8000 }).catch(() => null);
clearFormCache();
const after = (await getLiveForm(DB, { fresh: true })).definition.serviceArea.polygon;
ok(after?.length >= 3 && JSON.stringify(after) !== before, 'Save boundary puts the new boundary in use straight away');
ok(!(await getDraftForm(DB)), 'with no form draft and no Put live');
ok(await page.evaluate(() => window.__toasts.some(t => /new boundary is in use/.test(t.msg))), 'and says so');
// Accessibility: each view and the family drawer, WCAG 2.1 AA
for (const name of ['board', 'list', 'scores', 'map', 'activity']) {
  await page.click(`.apl-views [data-view="${name}"]`);
  await sleep(name === 'map' ? 1200 : 500);
  const v = await axeScan(page, '.apl');
  ok(!v.length, `axe: the ${name} has no WCAG 2.1 AA problems${v.length ? ` (${axeText(v)})` : ''}`);
}

// Activity
await page.click('.apl-views [data-view="activity"]');
await page.waitForSelector('.apl-feed-row', { timeout: 8000 });
ok(await page.$$eval('.apl-feed-row', els => els.length) >= 5, 'Activity lists what happened across families');
await shot(page, 'desktop-activity');
// JobTread trouble: coming back to the tab catches up; a failure shows, with one way to act
w.failNext.set('organization', 1);
await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await page.waitForFunction(() => /Check JobTread now/.test(document.querySelector('.apl-head-actions')?.innerText || ''), { timeout: 8000 }).catch(() => null);
ok(/JobTread didn't answer/.test(await text(page, '.apl-sync')) && !!(await page.$('.apl-sync .apl-dot.is-stale')), 'a failed check says so in the header, in amber');
ok(await clickText(page, '.apl-head-actions button', /Check JobTread now/), 'with Check JobTread now');
// A family-reply alert's Reply link opens the family already answering in that thread
{
  const linked = await open(1440, 1000, `__applicants.html#applications/applicants/${avery.id}/reply/${avery.id}-m2`);
  await linked.waitForSelector('.apl-drawer .apl-thread-to', { timeout: 15000 }).catch(() => null);
  ok(/Replying in Application Status/.test(await text(linked, '.apl-thread-to')), 'the alert’s Reply link opens the family answering in that conversation');
  await linked.close();
}
// A family replied and is waiting on us: Applicants says so, their card says so, and a "thanks" can be marked No reply needed
{
  const mateo = acct('Mateo García');
  await DB.prepare("INSERT OR IGNORE INTO applicant_sync (key, value, updated_at) VALUES ('replies_since', ?, ?)").bind(new Date(Date.now() - 3600e3).toISOString(), new Date().toISOString()).run();
  await DB.prepare('INSERT INTO applicant_activity (id, account_id, at, kind, by_name, source, title, body, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('evt-mateo-reply', mateo.id, new Date().toISOString(), 'reply', 'Lucía García', 'family', null, '¡Gracias! Nos vemos el jueves.', JSON.stringify({ commentId: 'mateo-r1', parentCommentId: null })).run();
  const wp = await open(1440, 1000);
  await wp.click('.apl-views [data-view="board"]'); // the board (the page remembers the last view)
  await wp.waitForSelector('.apl-waiting', { timeout: 10000 }).catch(() => null);
  await wp.waitForSelector('.apl-card', { timeout: 10000 }).catch(() => null);
  ok(/A family replied and is waiting for an answer/.test(await text(wp, '.apl-waiting')) && /Mateo García/.test(await text(wp, '.apl-waiting')), 'Applicants says a family replied and is waiting, and who');
  ok(await wp.$eval(`.apl-card[data-id="${mateo.id}"]`, (el) => el.classList.contains('is-waiting') && /Lucía replied/.test(el.textContent) && el.parentElement.querySelector('.apl-card') === el).catch(() => false), 'their card says so, first in its column');
  await shot(wp, 'desktop-waiting');
  await clickText(wp, '.apl-waiting-who button', /Mateo García/);
  await wp.waitForSelector('.apl-reply-banner', { timeout: 8000 }).catch(() => null);
  ok(/Lucía García replied/.test(await text(wp, '.apl-reply-banner')) && /waiting for an answer/.test(await text(wp, '.apl-reply-banner')), 'the family’s page says they’re waiting on an answer');
  await shot(wp, 'desktop-waiting-family');
  await clickText(wp, '.apl-reply-banner button', /No reply needed/);
  await wp.waitForFunction(() => !document.querySelector('.apl-reply-banner'), { timeout: 8000 }).catch(() => null);
  ok(!(await wp.$('.apl-reply-banner')), 'No reply needed: the banner goes');
  ok(!!(await DB.prepare("SELECT 1 AS y FROM applicant_activity WHERE account_id = ? AND kind = 'handled'").bind(mateo.id).first('y')), 'and the history notes who marked it');
  await wp.keyboard.press('Escape');
  await wp.waitForFunction((id) => !document.querySelector(`.apl-card[data-id="${id}"]`)?.classList.contains('is-waiting') && !document.querySelector('.apl-waiting'), { timeout: 8000 }, mateo.id).catch(() => null);
  ok(!(await wp.$('.apl-waiting')) && !(await wp.$eval(`.apl-card[data-id="${mateo.id}"]`, (el) => el.classList.contains('is-waiting')).catch(() => true)), 'and the board stops showing them as waiting');
  await wp.close();
}
await page.waitForFunction(() => !/Check JobTread now/.test(document.querySelector('.apl-head-actions')?.innerText || ''), { timeout: 8000 }).catch(() => null);
ok(/In sync with JobTread/.test(await text(page, '.apl-sync')), 'once JobTread answers, the problem clears');

// Pause family emails: the sheet, a held move, then choosing family by family
await page.click('.apl-views [data-view="board"]');
await page.waitForSelector('.apl-board');
await page.click('.apl-more-btn');
await page.waitForSelector('.apl-menu [role="menuitem"]');
await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem', { timeout: 2000 }).catch(() => null);
ok(await page.evaluate(() => document.activeElement?.getAttribute('role') === 'menuitem'), 'the ⋯ menu puts the keyboard on its first item');
ok(/Changing a lot of statuses at once\?/.test(await text(page, '.apl-menu')), 'the menu names the job: Pause family emails');
await shot(page, 'desktop-more-menu');
await page.evaluate(() => [...document.querySelectorAll('.apl-menu [role="menuitem"]')].find(b => /Pause family emails/.test(b.textContent))?.click());
await page.waitForSelector('.apl-sheet', { timeout: 4000 });
ok(/Pause family emails\?/.test(await text(page, '.apl-sheet')) && /choose which ones still go/.test(await text(page, '.apl-sheet')), 'a sheet says what happens, in order (no browser prompt)');
await sleep(400); // let the sheet finish fading in
await shot(page, 'desktop-cleanup-sheet');
await clickText(page, '.apl-sheet button', /Pause family emails/);
await page.waitForFunction(() => /Family emails are paused/.test(document.body.textContent), { timeout: 8000 }).catch(() => null);
ok(/Family emails are paused until/.test(await text(page, '.apl-banner')), 'the banner says emails are paused, and until when');
await page.click('.apl-card[data-id="acct00000004"]'); // Noah Pence, In Review
await page.waitForSelector('.apl-status-select select');
await page.select('.apl-status-select select', 'Approved');
await page.waitForSelector('.apl-sheet .apl-preview-body', { timeout: 8000 }).catch(() => null);
ok(/Family emails are paused/.test(await text(page, '.apl-sheet')) && !(await clickText(page, '.apl-sheet button', /email now/)), 'moving a family meanwhile says the email holds (no "email now")');
await clickText(page, '.apl-sheet-foot .btn-primary', /Move to Approved/);
await page.waitForFunction(() => !document.querySelector('.apl-sheet'), { timeout: 8000 }).catch(() => null);
ok(acct('Noah Pence').fields[F.status] === 'Approved' && !acct('Noah Pence').comments.some(c => c.name === 'Application Decision'), 'JobTread moved; the family isn’t emailed yet');
ok(await page.evaluate(() => window.__toasts.some(t => /Family emails are paused, so the email is held/.test(t.msg)) && !window.__toasts.some(t => /Noah Pence is now Approved\. .* is emailed at/.test(t.msg))), 'and the toast says the email holds, not when it goes');
await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.querySelector('.apl-drawer'), { timeout: 4000 }).catch(() => null);
await page.waitForFunction(() => /1 email is held so far/.test(document.querySelector('.apl-banner')?.innerText || ''), { timeout: 8000 }).catch(() => null);
ok(/1 email is held so far/.test(await text(page, '.apl-banner')), 'the banner counts what’s held');
await shot(page, 'desktop-cleaning');
await clickText(page, '.apl-banner button', /Turn family emails back on/);
await page.waitForSelector('.apl-held-list li', { timeout: 8000 }).catch(() => null);
ok(/Noah Pence/.test(await text(page, '.apl-held-list')) && /Approved email/.test(await text(page, '.apl-held-list')), 'done: each held email is listed, family by family');
await shot(page, 'desktop-held');
await clickText(page, '.apl-held-list li button', /^Send$/);
await page.waitForFunction(() => !document.querySelector('.apl-held-list'), { timeout: 8000 }).catch(() => null);
ok(acct('Noah Pence').comments.filter(c => c.name === 'Application Decision').length === 1, 'Send emails that family, once');
ok(!(await page.$('.apl-banner')), 'and the banner goes');
ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'desktop: nothing wider than the window');
await page.click('.apl-views [data-view="board"]');
await sleep(400);
await page.click('.apl-card');
await page.waitForSelector('.apl-drawer .apl-thread', { timeout: 8000 }).catch(() => null);
await sleep(500);
const dv = await axeScan(page, '.apl-drawer');
ok(!dv.length, `axe: the family drawer has no WCAG 2.1 AA problems${dv.length ? ` (${axeText(dv)})` : ''}`);
await page.keyboard.press('Escape');
await page.close();

console.log('Phone 390');
const phone = await open(390, 844);
await phone.evaluate(() => localStorage.setItem('apl-view', 'board'));
await phone.reload({ waitUntil: 'domcontentloaded' });
await phone.waitForSelector('.apl-board');
await sleep(400);
ok(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'phone: the page itself never scrolls sideways');
// One status at a time under a switcher with the counts, never a sideways-scrolling board
const tabs = await phone.$$eval('.apl-board-tabs button', els => els.filter(e => e.offsetParent).map(e => ({ label: e.querySelector('span').textContent.trim(), n: Number(e.querySelector('b').textContent), on: e.getAttribute('aria-pressed') === 'true', cards: document.querySelectorAll(`.apl-col[data-status="${e.querySelector('span').textContent.trim()}"] .apl-card`).length })));
ok(tabs.map(t => t.label).join() === 'Applied,In Review,Approved,Denied' && tabs.every(t => t.n === t.cards) && tabs[0].on && tabs.filter(t => t.on).length === 1, `phone: a status switcher with each status's count, Applied first (${JSON.stringify(tabs)})`);
ok(await phone.evaluate(() => { const b = document.querySelector('.apl-board'); return b.scrollWidth <= b.clientWidth + 1 && [...document.querySelectorAll('.apl-col')].filter(c => c.offsetParent).map(c => c.dataset.status).join() === 'Applied'; }), 'phone: just the Applied column shows, the full width of the screen');
await phone.click('.apl-board-tabs button:nth-child(2)');
await sleep(150);
ok(await phone.evaluate(() => [...document.querySelectorAll('.apl-col')].filter(c => c.offsetParent).map(c => c.dataset.status).join() === 'In Review' && document.querySelectorAll('.apl-col.is-shown .apl-card').length === 2), 'phone: tapping In Review shows its two families');
await shot(phone, 'phone-board-in-review');
await phone.click('.apl-board-tabs button:nth-child(1)');
await sleep(150);
await shot(phone, 'phone-board');
await phone.click('.apl-card');
await phone.waitForSelector('.apl-drawer .apl-thread', { timeout: 8000 });
await sleep(400);
const dw = await phone.$eval('.apl-drawer', el => el.getBoundingClientRect().width);
ok(Math.abs(dw - 390) < 2, 'phone: the family fills the screen');
const small = await phone.evaluate(() => [...document.querySelectorAll('.apl-drawer button, .apl-drawer select, .apl-drawer a.btn')].filter(b => b.offsetParent && b.getBoundingClientRect().height < 32).map(b => `${b.className || b.tagName}:${b.textContent.trim().slice(0, 20)}:${Math.round(b.getBoundingClientRect().height)}`));
ok(small.length === 0, `phone: controls are tappable${small.length ? ` (${small.slice(0, 4).join(', ')})` : ''}`);
// Conversation and Details are tabs; the conversation gets the room and the composer stays on screen
const pane = await phone.evaluate(() => {
  const r = (s) => document.querySelector(s)?.getBoundingClientRect();
  const comp = r('.apl-composer');
  return { tabs: !!document.querySelector('.apl-dtabs')?.offsetParent, thread: r('.apl-thread')?.height || 0, compRight: comp?.right || 0, compBottom: comp?.bottom || 0, side: !!document.querySelector('.apl-side')?.offsetParent };
});
ok(pane.tabs && !pane.side, 'phone: the family opens on Conversation, with a Details tab');
ok(pane.thread > 250, `phone: the conversation has room to read (${Math.round(pane.thread)}px)`);
ok(pane.compRight <= 391 && pane.compBottom <= 845, 'phone: the composer fits on the screen');
ok(!!(await phone.$('.apl-email-sum')) && !(await phone.$eval('.apl-email-row', el => !!el.offsetParent).catch(() => false)), 'phone: To and Subject fold into one line');
await phone.click('.apl-email-sum');
ok(await phone.$eval('.apl-email-row', el => !!el.offsetParent).catch(() => false), 'and open when tapped');
ok(/^Subject/.test(await phone.$eval('.apl-subject', el => el.textContent.trim()).catch(() => '')) && !!(await phone.$('.apl-subject input[aria-label="Subject"]')), 'the box beside who it goes to says it’s the subject');
await shot(phone, 'phone-family');
await phone.click('.apl-dtabs [data-tab="details"]');
await sleep(200);
ok(await phone.evaluate(() => !!document.querySelector('.apl-side')?.offsetParent && !document.querySelector('.apl-convo')?.offsetParent), 'phone: Details shows the details instead');
// The home map was hidden behind Conversation when it was made: shown, it's framed on the home
await phone.$eval('.apl-homemap', el => el.scrollIntoView({ block: 'center' })).catch(() => null);
await sleep(600);
const pm = await phone.evaluate(() => {
  const plain = (r) => r && { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; // DOMRects come back empty
  const box = plain(document.querySelector('.apl-homemap')?.getBoundingClientRect());
  const pin = plain(document.querySelector('.apl-homemap .apl-pin')?.getBoundingClientRect());
  return { box, pin };
});
ok(pm.box?.width > 300 && pm.pin && Math.abs(pm.pin.x + pm.pin.width / 2 - (pm.box.x + pm.box.width / 2)) < 6 && Math.abs(pm.pin.y + pm.pin.height / 2 - (pm.box.y + pm.box.height / 2)) < 6, 'phone: on Details, the home map is full width and centered on the home');
const zoomH = await phone.$$eval('.apl-homemap .leaflet-control-zoom a', els => els.map(e => Math.round(e.getBoundingClientRect().height)));
ok(zoomH.length === 2 && zoomH.every(h => h >= 40), `phone: the map's zoom buttons are big enough to tap (${zoomH.join(', ')}px)`);
const linkH = await phone.$$eval('.apl-home-links > *', els => els.map(e => `${e.textContent.trim()} ${Math.round(e.getBoundingClientRect().height)}`));
ok(linkH.length === 2 && linkH.every(t => +t.split(' ').pop() >= 44), `phone: Directions and Show on map are big enough to tap (${linkH.join(', ')}px)`);
await shot(phone, 'phone-family-details');
await phone.keyboard.press('Escape');
await phone.click('.apl-views [data-view="map"]');
await phone.waitForSelector('.leaflet-container', { timeout: 15000 });
await sleep(1200);
await shot(phone, 'phone-map');
await phone.close();

console.log('iPad landscape 1024');
const pad = await open(1024, 768);
await pad.evaluate(() => localStorage.setItem('apl-view', 'board'));
await pad.reload({ waitUntil: 'domcontentloaded' });
await pad.waitForSelector('.apl-board');
await sleep(300);
ok(await pad.$eval('.apl-board', el => el.scrollWidth <= el.clientWidth + 1), 'iPad landscape: all four columns fit, nothing hides off the side');
await shot(pad, 'ipad-board');
await pad.close();

// The family drawer's home map at every width between phone and laptop: inside the Details column, on the home
console.log('Home map, every width');
for (const width of [768, 820, 1025, 1100, 1180, 1280]) {
  const pg = await open(width, 900);
  await pg.evaluate(() => localStorage.setItem('apl-view', 'list'));
  await pg.reload({ waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('.apl-table tbody tr');
  await pg.click('.apl-table tbody tr');
  await pg.waitForSelector('.apl-drawer .apl-thread', { timeout: 8000 }).catch(() => null);
  await pg.evaluate(() => { const t = [...document.querySelectorAll('.apl-dtabs button')].find(x => x.offsetParent && /Details/.test(x.textContent)); t?.click(); });
  await pg.waitForSelector('.apl-homemap .apl-pin', { timeout: 15000 }).catch(() => null);
  await pg.$eval('.apl-homemap', el => el.scrollIntoView({ block: 'center' })).catch(() => null);
  await sleep(500);
  const r = await pg.evaluate(() => {
    const plain = (x) => x && { x: x.x, y: x.y, width: x.width, height: x.height, right: x.right, bottom: x.bottom }; // DOMRects come back empty
    const box = plain(document.querySelector('.apl-homemap')?.getBoundingClientRect());
    const pin = plain(document.querySelector('.apl-homemap .apl-pin')?.getBoundingClientRect());
    const panel = plain(document.querySelector('.apl-homemap')?.closest('.apl-panel')?.getBoundingClientRect());
    return { box, pin, panel, gap: !!document.querySelector('.apl-homemap .apl-gap'), wide: document.documentElement.scrollWidth > window.innerWidth + 1 };
  });
  // A home inside the area sits in the middle; one outside shares the frame with the gap, so it only has to be in view
  const onHome = r.pin && r.box && (r.gap
    ? r.pin.x >= r.box.x && r.pin.right <= r.box.right && r.pin.y >= r.box.y && r.pin.bottom <= r.box.bottom
    : Math.abs(r.pin.x + r.pin.width / 2 - (r.box.x + r.box.width / 2)) < 6 && Math.abs(r.pin.y + r.pin.height / 2 - (r.box.y + r.box.height / 2)) < 6);
  // Fills its card (the card's padding either side), never past it
  const fits = r.box?.width >= 200 && r.panel && r.box.x >= r.panel.x && r.box.right <= r.panel.right && r.panel.right - r.box.right < 40;
  ok(fits && onHome && !r.wide, `${width}px: the home map fits its card and sits on the home (${Math.round(r.box?.width || 0)}px wide${r.gap ? ', a home outside' : ''}${!fits ? ', past its card' : ''}${!onHome ? ', off the home' : ''}${r.wide ? ', page scrolls sideways' : ''})`);
  await pg.close();
}

// Scores: SOARD's rubric in the family's Score tab, and the Scores view (ranked, the tiers, the season's makeovers)
console.log('Scores');
{
  const all = (n) => Object.fromEntries(CRITERION_KEYS.map(k => [k, n]));
  const owenA = acct('Owen Lindgren');
  const eliza = acct('Eliza Franklin');
  const noah = acct('Noah Pence');
  const isla = acct('Isla Example');
  // Clareece and Christian are scoring 2027. Both scored Owen, far apart on family readiness, and Eliza;
  // Clareece scored Isla (her home visit photos are in CompanyCam); Christian is partway through Noah (approved earlier)
  await ensureCompanyCamSchema(DB);
  await DB.prepare("INSERT INTO companycam_files (cc_id, kind, project_id, account_id, origin, state, created_at, updated_at) VALUES ('photo:91', 'photo', 'p91', ?, 'companycam', 'copied', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')").bind(isla.id).run();
  await saveScorecard(DB, owenA.id, { evaluator: 'clareece@soardcharity.com', scores: { ...all(5), readiness: 1 } }); // 46
  await saveScorecard(DB, owenA.id, { evaluator: 'christian@soardcharity.com', scores: { ...all(4), readiness: 5 } }); // 41
  await saveScorecard(DB, eliza.id, { evaluator: 'clareece@soardcharity.com', scores: all(3) }); // 30
  await saveScorecard(DB, eliza.id, { evaluator: 'christian@soardcharity.com', scores: all(3) }); // 30
  await saveScorecard(DB, isla.id, { evaluator: 'clareece@soardcharity.com', scores: all(4) }); // 40, waiting on Christian
  await saveScorecard(DB, noah.id, { evaluator: 'christian@soardcharity.com', scores: { mobility: 4, safety: 4 } });
  // Owen's kid page is waiting on funding
  await DB.prepare("UPDATE kids SET data = json_set(data, '$.status', 'needs-funding') WHERE slug = 'owen'").run();
  const sp = await open(1440, 1000);
  await sp.evaluate(() => localStorage.removeItem('apl-view'));
  await sp.reload({ waitUntil: 'domcontentloaded' });
  await sp.waitForSelector('.apl-card', { timeout: 20000 });
  await sleep(300);
  // Board: the family's score and tier on the card (the average of 46 and 41)
  const tagOf = (id) => sp.$eval(`.apl-card[data-id="${id}"] .apl-score-tag`, el => ({ n: el.querySelector('b')?.textContent || null, text: el.textContent, cls: el.className })).catch(() => null);
  const owenTag = await tagOf(owenA.id);
  ok(owenTag?.n === '43.5' && /High Priority/.test(owenTag.text) && /tag--success/.test(owenTag.cls), `a scored family's card shows its score, the average of the totals, and tier (${JSON.stringify(owenTag)})`);
  ok(/Strong Candidate/.test((await tagOf(eliza.id))?.text || '') && /tag--info/.test((await tagOf(eliza.id))?.cls || ''), 'Strong Candidate is the info blue');
  const islaTag = await tagOf(isla.id);
  ok(islaTag && islaTag.n === null && /^1 of 2 scored$/.test(islaTag.text.trim()) && /is-held/.test(islaTag.cls) && !/tag--/.test(islaTag.cls), `a family only some of the season's scorers have scored shows how many, not a score (${JSON.stringify(islaTag)})`);
  ok(!(await tagOf(noah.id)), 'a scorecard partway done doesn’t give a family a score');
  ok(await sp.$eval('.apl-card[data-id] .apl-score-tag', el => !/danger/.test(el.className) && getComputedStyle(el).backgroundColor !== 'rgb(255, 0, 0)'), 'no tier is red');
  // List: a Score column, highest first
  await sp.click('.apl-views [data-view="list"]');
  await sp.waitForSelector('.apl-table', { timeout: 5000 });
  await clickText(sp, '.apl-table th button', /^Score/);
  await sleep(200);
  ok((await sp.$$eval('.apl-table tbody tr strong', els => els.map(e => e.textContent))).slice(0, 3).join() === 'Owen Lindgren,Eliza Franklin,Isla Example', 'List: sorting by Score puts the highest first, then families still being scored');
  // Filters: a tier, and "Not ranked yet"
  await sp.click('.apl-fbtn');
  await sp.select('select[aria-label="Score"]', 'high');
  await sleep(200);
  ok((await sp.$$eval('.apl-table tbody tr strong', els => els.map(e => e.textContent))).join() === 'Owen Lindgren', 'the Score filter shows one tier');
  ok(await sp.$$eval('.apl-active button', els => els.some(b => /High Priority/.test(b.textContent))), 'and shows as a chip');
  await sp.select('select[aria-label="Score"]', 'none');
  await sleep(200);
  const none = await sp.$$eval('.apl-table tbody tr strong', els => els.map(e => e.textContent));
  ok(!none.includes('Owen Lindgren') && !none.includes('Eliza Franklin') && none.includes('Noah Pence') && none.includes('Isla Example'), `"Not ranked yet" leaves out the ranked families (${none.join(', ')})`);
  await sp.select('select[aria-label="Score"]', '');
  await sp.keyboard.press('Escape');
  await sleep(150);

  // The Scores view
  await sp.click('.apl-views [data-view="scores"]');
  await sp.waitForSelector('.apl-scores', { timeout: 5000 });
  const tiles = await sp.$$eval('.apl-score-tile', els => els.map(e => [e.querySelector('span').textContent.trim(), e.querySelector('b').textContent.trim()]));
  ok(JSON.stringify(tiles) === JSON.stringify([['Ranked', '2'], ['High Priority', '1'], ['Strong Candidate', '1'], ['Lower Priority', '0'], ['Do Not Proceed', '0'], ['Average score', '36.8']]), `the snapshot: ranked, each tier, the average (${JSON.stringify(tiles)})`);
  ok((await sp.$$eval('.apl-rank tbody tr strong', els => els.map(e => e.textContent))).join() === 'Owen Lindgren,Eliza Franklin', 'families ranked by score, only those everyone scoring 2027 has scored');
  ok(/Clareece and Christian are scoring 2027\. A family is ranked once both have scored them/.test(await text(sp, '.apl-scores-head')), 'it says who is scoring the season');
  ok((await sp.$$eval('.apl-rank thead .apl-rank-crit-row span', els => els.map(e => e.textContent))).at(-1) === 'Finances', 'the 2027 rubric’s criteria head the columns, Financial need last');
  const owenRow = await sp.$eval('.apl-rank tbody tr', tr => ({ cells: [...tr.querySelectorAll('.apl-rank-crits .apl-heat')].map(c => c.textContent), talk: [...tr.querySelectorAll('.apl-heat.is-talk')].length, tag: tr.querySelector('.apl-talk-tag')?.textContent || '', by: tr.querySelectorAll('.apl-rank-by .avatar').length }));
  ok(owenRow.cells.join('|') === '4.5|4.5|4.5|4.5|4.5|4.5|4.5|4.5|3|4.5' && owenRow.talk === 1 && /Talk about 1/.test(owenRow.tag) && owenRow.by === 2, `each criterion's average, family readiness marked to talk about, who scored (${JSON.stringify(owenRow)})`);
  const waitList = await sp.$$eval('.apl-unscored li', els => els.map(e => e.textContent));
  ok(/Not ranked yet/.test(await text(sp, '.apl-unscored h3')) && /Isla Example/.test(waitList[0] || '') && /1 of 2 scored · waiting on Christian/.test(waitList[0] || ''), `Not ranked yet: a family partway first, with who they wait on (${waitList[0]})`);
  ok(waitList.some(t => /Noah Pence/.test(t) && /Christian started/.test(t)) && waitList.some(t => /Avery Stone/.test(t)) && !waitList.some(t => /Evan Burkett/.test(t)), 'then who started, and no one already turned down');
  // How many makeovers the season can take
  ok(/How many makeovers can SOARD do in 2027/.test(await text(sp, '.apl-cap')), 'the season’s makeovers start unset, with a question');
  await clickText(sp, '.apl-cap button', /Set how many/);
  await sp.waitForSelector('.apl-cap-form input', { timeout: 3000 });
  await sp.type('.apl-cap-form input', '3');
  await sp.click('.apl-cap-form .btn-primary');
  await sp.waitForSelector('.apl-slot', { timeout: 5000 });
  const slots = await sp.$$eval('.apl-slot', els => els.map(e => e.className.replace('apl-slot ', '')));
  ok(slots.join() === 'is-high,is-strong,is-open', `3 makeovers, filled in rank order by tier (${slots.join()})`);
  ok(/1 High Priority family fills 1 of the 3 makeovers, leaving 2 for the next in line \(1 Strong Candidate ranked\)/.test(await text(sp, '.apl-cap-text')), 'and says how the ranking fills the season');
  ok((await capacities(DB))['2027']?.count === 3, 'the number is saved for the 2027 season');
  const capStats = await sp.$$eval('.apl-cap-stats div', els => els.map(e => e.textContent.trim()));
  ok(/^1\s*High Priority not yet funded/.test(capStats[2] || ''), `High Priority not yet funded comes from the kid page (${capStats.join(' | ')})`);
  await shot(sp, 'desktop-scores');
  // How scoring works: the spreadsheet's first two tabs
  await clickText(sp, '.apl-scores-head button', /How scoring works/);
  await sp.waitForSelector('.apl-how', { timeout: 3000 });
  await sleep(400); // its opening animation (axe reads contrast mid-fade otherwise)
  ok(await sp.$$eval('.apl-how-tiers > div', els => els.length) === 4 && await sp.$$eval('.apl-how-crit', els => els.length) === 10, 'How scoring works: the four tiers and what every score means');
  ok(/Financial need/.test(await text(sp, '.apl-how')) && !/Mission & story/.test(await text(sp, '.apl-how')) && /Family readiness is scored after the home visit/.test(await text(sp, '.apl-how')), 'the 2027 rubric: Financial need, and readiness after the home visit');
  const hv = await axeScan(sp, '.apl-how');
  ok(!hv.length, `axe: How scoring works has no WCAG 2.1 AA problems${hv.length ? ` (${axeText(hv)})` : ''}`);
  await sp.keyboard.press('Escape');
  await sleep(200);
  ok(!(await sp.$('.apl-how')), 'Escape closes it');
  const sv = await axeScan(sp, '.apl');
  ok(!sv.length, `axe: the Scores view with families scored has no WCAG 2.1 AA problems${sv.length ? ` (${axeText(sv)})` : ''}`);

  // A family from the ranking opens on their Score tab, your own scorecard first
  await sp.click('.apl-rank tbody tr');
  await sp.waitForSelector('.apl-score .apl-crits', { timeout: 10000 });
  ok(await sp.$eval('.apl-dtabs [data-tab="score"]', el => el.getAttribute('aria-selected') === 'true' && /43\.5/.test(el.textContent)), 'opened from Scores, the drawer is on Score, with the family’s score on the tab');
  ok(await sp.$eval('.apl-dtabs', el => getComputedStyle(el).display !== 'none') && !(await sp.$eval('.apl-dtabs [data-tab="details"]', el => !!el.offsetParent)), 'on a laptop the tabs are Conversation and Score (Details sits beside them)');
  ok(/Clareece and Christian have scored Owen Lindgren\. Score on your own first/.test(await text(sp, '.apl-score .apl-callout')), 'it says who has scored, without their numbers');
  ok(!(await sp.$('.apl-score-table')), 'and doesn’t show their scores until asked');
  ok(await sp.$eval('.apl-crit.is-open', el => el.dataset.crit === 'mobility' && el.querySelectorAll('.apl-level').length === 5), 'the first criterion is open, with its five levels');
  ok(/Non-ambulatory or fully dependent/.test(await text(sp, '.apl-crit.is-open .apl-level:last-child')), 'in the rubric’s own words');
  // Score with the mouse once, then the keys: each pick saves and opens the next
  await sp.click('.apl-crit.is-open .apl-level:nth-child(5)');
  await sp.waitForFunction(() => document.querySelector('.apl-crit.is-open')?.dataset.crit === 'safety', { timeout: 3000 }).catch(() => null);
  ok(await sp.$eval('.apl-crit.is-open', el => el.dataset.crit === 'safety'), 'picking a score moves on to the next criterion');
  await sleep(400);
  await shot(sp, 'desktop-family-scorecard');
  for (const k of '55555552') { await sp.keyboard.press(k); await sleep(60); }
  await sleep(150);
  ok(await sp.$eval('.apl-crit.is-open', el => el.dataset.crit === 'financial').catch(() => false) && await sp.$eval('[data-crit="readiness"] .apl-crit-v', el => el.textContent.trim() === 'Scored 22'), 'pressing 1 to 5 scores the open criterion and moves on');
  await sp.keyboard.press('5');
  await sp.waitForFunction(() => /Saved/.test(document.querySelector('.apl-score-saved')?.textContent || ''), { timeout: 5000 }).catch(() => null);
  await sleep(400);
  const mine = (await familyScores(DB, owenA.id)).cards.find(c => c.evaluator === 'linzi@soardcharity.com');
  ok(mine?.complete && mine.total === 47 && mine.scores.financial === 5 && mine.scores.readiness === 2 && mine.rubric === 2, `the scorecard saved as it went, as Linzi's own, on the 2027 rubric (${mine?.total})`);
  ok(await sp.evaluate(() => window.__toasts.some(t => /Your score for Owen Lindgren: 47 of 50, High Priority/.test(t.msg))), 'finishing it says your score');
  ok(/47/.test(await text(sp, '.apl-score-big')) && /High Priority/.test(await text(sp, '.apl-score-what')), 'and the card shows your total and tier');
  // Notes save on their own too
  await sp.type('.apl-score-notes textarea', 'Ramp is the urgent part');
  await sleep(1300);
  ok((await familyScores(DB, owenA.id)).cards.find(c => c.evaluator === 'linzi@soardcharity.com')?.notes === 'Ramp is the urgent part', 'notes save as you type');
  const mv = await axeScan(sp, '.apl-drawer');
  ok(!mv.length, `axe: your scorecard has no WCAG 2.1 AA problems${mv.length ? ` (${axeText(mv)})` : ''}`);
  // Everyone: each scorecard beside the family's score
  await clickText(sp, '.apl-score-seg button', /Everyone/);
  await sp.waitForSelector('.apl-score-table', { timeout: 3000 });
  const tbl = await sp.$eval('.apl-score-table', t => ({ heads: [...t.querySelectorAll('thead th')].map(th => (th.querySelector('.apl-score-th > span:last-child') || th).textContent.trim()), foot: [...t.querySelectorAll('tfoot td')].map(td => td.textContent.trim()), talk: [...t.querySelectorAll('tr.is-talk th .is-long')].map(th => th.textContent.trim()) }));
  ok(tbl.heads.join('|') === 'Criterion|Clareece|Christian|You|Family' && tbl.foot.join('|') === '46|41|47|44.7', `Everyone: each person's scores and total beside the family's (${JSON.stringify(tbl)})`);
  ok(/The average of the 3 totals, 46, 41 and 47\./.test(await text(sp, '.apl-score-how')), 'and says how the family’s score is worked out');
  ok(tbl.talk.join() === 'Family readiness', 'the criterion they disagree on stands out');
  ok(/Worth talking about: Family readiness \(1 to 5\)/.test(await text(sp, '.apl-talk')), 'with the spread');
  ok(/You[\s\S]*Ramp is the urgent part/.test(await text(sp, '.apl-score-notes-list')), 'and everyone’s notes');
  const ev = await axeScan(sp, '.apl-drawer');
  ok(!ev.length, `axe: Everyone has no WCAG 2.1 AA problems${ev.length ? ` (${axeText(ev)})` : ''}`);
  await shot(sp, 'desktop-family-score');
  // The status sheet shows the score when it's a decision
  await sp.select('.apl-status-select select', 'Denied');
  await sp.waitForSelector('.apl-sheet', { timeout: 5000 });
  ok(/44\.7[\s\S]*High Priority[\s\S]*44\.7 of 50, the average of 3 scorecards/.test(await text(sp, '.apl-sheet-score')), 'deciding on a family, the status sheet shows their score');
  await clickText(sp, '.apl-sheet-foot button', /Cancel/);
  await sleep(200);
  // Back on the ranking, the new score is already there
  await sp.keyboard.press('Escape');
  await sp.waitForFunction(() => !document.querySelector('.apl-drawer'), { timeout: 4000 }).catch(() => null);
  ok(await sp.$eval('.apl-rank tbody tr .apl-rank-by .apl-card-sub', el => el.textContent.trim() === '3'), 'closing it, the ranking already counts the new scorecard');
  // Linzi is scoring 2027 now too, so Eliza waits for her
  await sp.waitForFunction(() => [...document.querySelectorAll('.apl-unscored li')].some(li => /Eliza Franklin/.test(li.textContent)), { timeout: 5000 }).catch(() => null);
  ok((await sp.$$eval('.apl-rank tbody tr strong', els => els.map(e => e.textContent))).join() === 'Owen Lindgren' && /Eliza Franklin[\s\S]*2 of 3 scored · waiting on Linzi/.test(await text(sp, '.apl-unscored')), 'a new scorer for the season: the families they haven’t scored leave the ranking until they have');
  // Family readiness waits for the home visit (Mateo has applied, and has no visit photos yet)
  const mateo = acct('Mateo García');
  await clickText(sp, '.apl-unscored li button', /Mateo García/);
  await sp.waitForSelector('.apl-score .apl-crits', { timeout: 10000 });
  ok(await sp.$eval('[data-crit="readiness"]', el => el.classList.contains('is-later') && /After the home visit/.test(el.textContent)), 'before the home visit, Family readiness says it waits for it');
  for (const k of '444444444') { await sp.keyboard.press(k); await sleep(60); }
  await sp.waitForFunction(() => /Saved/.test(document.querySelector('.apl-score-saved')?.textContent || ''), { timeout: 5000 }).catch(() => null);
  await sleep(300);
  ok(/9 of 10 scored/.test(await text(sp, '.apl-score-what')) && /Family readiness is scored after the home visit\. Your scorecard counts once it has a score/.test(await text(sp, '.apl-score-what')), 'the keys skip it: 9 of 10, and it says why the card isn’t done');
  await clickText(sp, '[data-crit="readiness"] .apl-crit-head', /Family readiness/);
  await sleep(150);
  ok(/It opens once photos from the visit are in CompanyCam/.test(await text(sp, '[data-crit="readiness"]')) && !(await sp.$('[data-crit="readiness"] .apl-level')), 'opened, it says when it opens, with no scores to pick');
  await sp.keyboard.press('3');
  await sleep(400);
  const mateoCard = (await familyScores(DB, mateo.id)).cards.find(c => c.evaluator === 'linzi@soardcharity.com');
  ok(mateoCard?.done === 9 && mateoCard.scores.readiness == null, `nothing scores it, keys included (${mateoCard?.done})`);
  const early = await sp.evaluate(async (id) => (await fetch('/api/applicants-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ score: { id, scores: { readiness: 3 } } }) })).json(), mateo.id);
  ok(early.success !== true && /after the home visit/.test(early.error || ''), `and the server refuses it too (${early.error})`);
  const lv = await axeScan(sp, '.apl-drawer');
  ok(!lv.length, `axe: a scorecard waiting on the home visit has no WCAG 2.1 AA problems${lv.length ? ` (${axeText(lv)})` : ''}`);
  await sp.close();

  // Phone: Conversation, Score and Details as tabs; the scorecard fits
  const ps = await open(390, 844);
  await ps.click('.apl-views [data-view="scores"]');
  await ps.waitForSelector('.apl-rank tbody tr', { timeout: 5000 });
  await ps.click('.apl-rank tbody tr');
  await ps.waitForSelector('.apl-score', { timeout: 10000 });
  await sleep(300);
  const pm = await ps.evaluate(() => ({
    tabs: [...document.querySelectorAll('.apl-dtabs button')].filter(b => b.offsetParent).map(b => b.dataset.tab),
    wide: document.documentElement.scrollWidth > innerWidth,
    past: [...document.querySelectorAll('.apl-drawer *')].filter(el => el.getBoundingClientRect().width && el.getBoundingClientRect().right > innerWidth + 1 && !el.closest('.apl-score-table-wrap')).slice(0, 3).map(el => `${el.tagName}.${el.className}`),
    tableScrolls: (() => { const t = document.querySelector('.apl-score-table-wrap'); return t ? t.scrollWidth > t.clientWidth + 1 : null; })(),
    side: !!document.querySelector('.apl-side')?.offsetParent,
  }));
  ok(pm.tabs.join() === 'convo,score,details' && !pm.side, `phone: Conversation, Score and Details are tabs, one at a time (${pm.tabs.join()})`);
  ok(!pm.wide && !pm.past.length, `phone: the Score tab fits the screen${pm.past.length ? ` (${pm.past.join(', ')})` : ''}`);
  ok(pm.tableScrolls === false, 'phone: everyone’s scores fit side by side, no sideways scroll');
  await shot(ps, 'phone-family-score');
  await clickText(ps, '.apl-score-seg button', /Your scorecard/);
  await sleep(300);
  const pc = await ps.evaluate(() => [...document.querySelectorAll('.apl-drawer *')].filter(el => el.getBoundingClientRect().width && el.getBoundingClientRect().right > innerWidth + 1).length);
  ok(pc === 0, 'phone: your scorecard fits too');
  await shot(ps, 'phone-family-scorecard');
  await ps.close();
}

// In the real admin shell (the sidebar takes 240px): no view ever scrolls sideways, at any width
console.log('Every view, every width, in the admin shell');
for (const width of [390, 768, 820, 1025, 1100, 1180, 1280, 1440]) {
  const p = await open(width, 900, '__shell.html');
  for (const view of ['board', 'list', 'scores', 'map', 'activity']) {
    await p.click(`.apl-views button[data-view="${view}"]`);
    await sleep(view === 'map' ? 700 : 250);
    const m = await p.evaluate(() => {
      const main = document.querySelector('.main');
      const right = main.getBoundingClientRect().right - parseFloat(getComputedStyle(main).paddingRight) + 1;
      const own = (el) => !el.closest('.leaflet-container');
      return {
        page: document.documentElement.scrollWidth > innerWidth,
        scrolls: [...document.querySelectorAll('.apl *')].filter(el => own(el) && el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX)).map(el => el.className),
        past: [...document.querySelectorAll('.apl *')].filter(el => own(el) && el.getBoundingClientRect().width && el.getBoundingClientRect().right > right && getComputedStyle(el).position !== 'fixed').slice(0, 3).map(el => `${el.tagName}.${el.className}`),
        cols: [...document.querySelectorAll('.apl-col')].filter(c => c.offsetParent).length,
        boardW: document.querySelector('.apl-board-wrap')?.getBoundingClientRect().width || 0,
      };
    });
    ok(!m.page && !m.scrolls.length && !m.past.length, `${width}px ${view}: fits, nothing scrolls sideways${m.scrolls.length || m.past.length ? ` (${[...m.scrolls, ...m.past].join(', ')})` : ''}`);
    // The board's own rule: four columns from 700px of board, else one status at a time
    if (view === 'board') ok(m.cols === (m.boardW >= 700 ? 4 : 1), `${width}px board (${Math.round(m.boardW)}px): ${m.cols === 4 ? 'all four columns side by side' : 'one status at a time'}`);
    if (view === 'board' || view === 'list') await shot(p, `shell-${view}-${width}`);
  }
  await p.close();
}

// Last, so no count above moves: one applicant becomes an organization's account (a school made by
// hand in JobTread: no birthday, no diagnosis, an organization's name)
console.log('An organization');
{
  const a = acct('Noah Pence');
  a.name = 'Sunnyside Academy';
  for (const k of ['diagnosis', 'birthday', 'gender', 'language', 'verbal', 'mobile']) delete a.fields[F[k]];
  const row = await DB.prepare('SELECT fields FROM applicants WHERE account_id = ?').bind(a.id).first();
  const fields = JSON.parse(row.fields || '{}');
  for (const k of ['diagnosis', 'birthday', 'gender', 'language', 'verbal', 'mobile']) delete fields[k];
  await DB.prepare('UPDATE applicants SET name = ?, fields = ? WHERE account_id = ?').bind('Sunnyside Academy', JSON.stringify(fields), a.id).run();
  const p = await open(1440, 1000);
  // The board (earlier steps leave another view remembered)
  await p.evaluate(() => localStorage.removeItem('apl-view'));
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.apl-card', { timeout: 20000 }).catch(() => {});
  await sleep(400);
  const sub = await p.evaluate(() => [...document.querySelectorAll('.apl-card')].find((c) => /Sunnyside Academy/.test(c.textContent))?.querySelector('.apl-card-sub')?.textContent || '');
  ok(/^Community project/.test(sub), `its card says Community project, not an age (${sub})`);
  await clickText(p, '.apl-card', /Sunnyside Academy/);
  await p.waitForSelector('.apl-drawer .apl-dtitle h2', { timeout: 8000 }).catch(() => {});
  ok(/A community project application/.test(await text(p, '.apl-dtitle p')), 'the drawer says what it is');
  const labels = await p.$$eval('.apl-side .apl-kv dt', (els) => els.map((e) => e.textContent.trim())).catch(() => []);
  ok(labels.length > 0 && !labels.some((l) => /Birthday|Diagnosis|Gender|Verbal|walks/i.test(l)), `its details have nothing of a child’s (${labels.join(', ')})`);
  ok(labels.includes('Project year') && labels.includes('Type of space') && !labels.some((l) => /Makeover/.test(l)), 'its project year and type of space, not a makeover’s');
  ok(await p.evaluate(() => [...document.querySelectorAll('.apl-side .apl-panel h3')].some((h) => h.textContent.trim() === 'Contacts')), 'its people are Contacts, not Family');
  ok(/^Address/.test(await p.evaluate(() => [...document.querySelectorAll('.apl-side .apl-panel h3')].map((h) => h.textContent.trim()).find((t) => /^(Home|Address)/.test(t)) || '')), 'where it is: its Address, not a Home');
  ok(/Message the organization/.test(await text(p, '.apl-composer-head b')), 'and the message box writes to the organization');
  ok(!(await p.$('.apl-dtabs [data-tab="score"]')), 'a community project has no Score tab (the rubric is for makeovers)');
  // Its history names its own details: "Type of space changed", never "Makeover type"
  await p.$$eval('.apl-type-picks button', (els) => els.find((b) => b.getAttribute('aria-pressed') !== 'true')?.click());
  await p.waitForFunction(() => /Type of space changed/.test(document.querySelector('.apl-thread')?.textContent || ''), { timeout: 8000 }).catch(() => null);
  const orgThread = await text(p, '.apl-thread');
  ok(/Type of space changed/.test(orgThread) && !/Makeover (type|year)/.test(orgThread), 'its history says “Type of space changed”, not “Makeover type”');
  // Every type unpicked: the history says blank, not a label with nothing after it
  for (let i = 0; i < 4; i++) {
    const had = await p.$$eval('.apl-type-picks button', (els) => { const b = els.find((x) => x.getAttribute('aria-pressed') === 'true'); b?.click(); return !!b; });
    if (!had) break;
    await p.waitForFunction(() => !document.querySelector('.apl-type-picks.is-saving'), { timeout: 8000 }).catch(() => null);
    await sleep(250);
  }
  await p.waitForFunction(() => /Type of space: blank/.test(document.querySelector('.apl-thread')?.textContent || ''), { timeout: 8000 }).catch(() => null);
  ok(/Type of space: blank/.test(await text(p, '.apl-thread')), 'every type unpicked: its history says “Type of space: blank”');
  await shot(p, 'organization-drawer');
  // A family with no status whose year is cleared has left Applicants: the drawer closes on it and says so
  const gone = acct('Harper Lee');
  delete gone.fields[F.status];
  await DB.prepare('UPDATE applicants SET status = NULL WHERE account_id = ?').bind(gone.id).run();
  const lp = await open(1440, 1000);
  await lp.goto(`${SITE}/admin/__applicants.html#applications/applicants/${gone.id}`, { waitUntil: 'domcontentloaded' });
  await lp.waitForSelector('.apl-kv select[aria-label="Makeover year"]', { timeout: 8000 }).catch(() => null);
  await sleep(400);
  await lp.select('.apl-kv select[aria-label="Makeover year"]', '');
  await lp.waitForFunction(() => !document.querySelector('.apl-drawer'), { timeout: 8000 }).catch(() => null);
  ok(!(await lp.$('.apl-drawer')) && await lp.evaluate(() => window.__toasts.some(t => /Harper Lee has no status or year now/.test(t.msg))), 'a family left with no status or year: the drawer closes and says where they went');
  await lp.close();
  // On a touch screen too: a tap on a detail below an open box lands
  const tp = await open(768, 1000, '__shell.html');
  await tp.evaluate(() => localStorage.removeItem('apl-view'));
  await tp.setViewport({ width: 768, height: 1000, deviceScaleFactor: 1, hasTouch: true });
  await tp.reload({ waitUntil: 'domcontentloaded' });
  await tp.waitForSelector('.apl-card', { timeout: 20000 }).catch(() => {});
  await sleep(400);
  await clickText(tp, '.apl-card', /Avery Stone/);
  await tp.waitForSelector('.apl-kv', { timeout: 8000 }).catch(() => {});
  await sleep(500);
  const dTab = await tp.$('.apl-dtabs [data-tab="details"]');
  if (dTab && await dTab.evaluate((e) => !!e.offsetParent)) { await dTab.click(); await sleep(300); }
  await tp.$eval('.apl-kv button.apl-edit[aria-label="Edit Diagnosis"]', (b) => b.click());
  await tp.waitForSelector('.apl-kv textarea');
  await sleep(150);
  const tapAt = await tp.$eval('.apl-kv button.apl-edit[aria-label="Edit Referred by"]', (el) => { el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + 40, y: r.y + r.height / 2 }; });
  await sleep(200);
  await tp.touchscreen.tap(tapAt.x, tapAt.y);
  await sleep(450);
  ok(!!(await tp.$('.apl-kv input.form-input[aria-label="Referred by"]')) && !(await tp.$('.apl-kv textarea')), 'on a touch screen, tapping a detail below an open box opens it the first time');
  const tSize = await tp.evaluate(() => ({ edit: getComputedStyle(document.querySelector('.apl-kv .apl-edit')).fontSize, choice: getComputedStyle(document.querySelector('.apl-kv select')).fontSize, arrow: document.querySelector('.apl-icon-btn').getBoundingClientRect().height, status: document.querySelector('.apl-status-select select').getBoundingClientRect().height }));
  ok(tSize.edit === tSize.choice && tSize.arrow >= 44 && tSize.status >= 44, `touch screens: typed values and choices read the same size, arrows and status are 44px (${JSON.stringify(tSize)})`);
  await tp.close();
  // Previous and Next follow the order on screen: the board's columns, the list as sorted
  const op = await open(1440, 1000);
  await op.evaluate(() => localStorage.removeItem('apl-view'));
  await op.reload({ waitUntil: 'domcontentloaded' });
  await op.waitForSelector('.apl-card', { timeout: 20000 }).catch(() => {});
  await sleep(400);
  const firstCol = await op.$$eval('.apl-col', (cols) => [...cols].map((c) => [...c.querySelectorAll('.apl-card-name')].map((e) => e.textContent.trim())).find((names) => names.length >= 2));
  await clickText(op, '.apl-card', new RegExp(firstCol[0]));
  await op.waitForSelector('.apl-drawer .apl-dtitle h2', { timeout: 8000 });
  await sleep(500);
  await op.click('.apl-icon-btn[aria-label^="Next family"]');
  await sleep(600);
  ok(await text(op, '.apl-dtitle h2') === firstCol[1], `on the board, Next is the card below (${firstCol[0]} → ${await text(op, '.apl-dtitle h2')}, want ${firstCol[1]})`);
  await op.keyboard.press('Escape');
  await sleep(300);
  await op.evaluate(() => localStorage.setItem('apl-view', 'list'));
  await op.reload({ waitUntil: 'domcontentloaded' });
  await op.waitForSelector('.apl-table tbody tr', { timeout: 20000 }).catch(() => {});
  await sleep(300);
  await op.$$eval('.apl-table thead th button', (bs) => { const b = bs.find((x) => /Name/.test(x.textContent)); b.click(); });
  await sleep(200);
  await op.$$eval('.apl-table thead th button', (bs) => { const b = bs.find((x) => /Name/.test(x.textContent)); b.click(); });
  await sleep(250);
  const rowNames = await op.$$eval('.apl-table tbody tr', (rs) => rs.map((r) => r.querySelector('td')?.textContent.trim().split(/\s{2,}|\n/)[0]));
  await op.$eval('.apl-table tbody tr', (r) => r.click());
  await op.waitForSelector('.apl-drawer .apl-dtitle h2', { timeout: 8000 });
  await sleep(500);
  const listFirst = await text(op, '.apl-dtitle h2');
  await op.click('.apl-icon-btn[aria-label^="Next family"]');
  await sleep(600);
  const listNext = await text(op, '.apl-dtitle h2');
  const rowsText = await op.$$eval('.apl-table tbody tr', (rs) => rs.map((r) => r.textContent));
  const at1 = rowsText.findIndex((t) => t.includes(listFirst));
  ok(at1 === 0 && rowsText[1].includes(listNext), `in the list, Next is the row below as sorted (${listFirst} → ${listNext}, ${JSON.stringify(rowNames.slice(0, 3))})`);
  // A status move confirmed in its sheet shows in the drawer at once; J and K wait behind it
  await op.keyboard.press('Escape');
  await sleep(300);
  await op.evaluate(() => localStorage.removeItem('apl-view'));
  await op.reload({ waitUntil: 'domcontentloaded' });
  await op.waitForSelector('.apl-card', { timeout: 20000 }).catch(() => {});
  await sleep(400);
  await clickText(op, '.apl-card', /Mateo García/);
  await op.waitForSelector('.apl-status-select select', { timeout: 8000 });
  await sleep(500);
  const mateoWas = await op.$eval('.apl-status-select select', (el) => el.value);
  const mateoTo = mateoWas === 'In Review' ? 'Applied' : 'In Review';
  await op.select('.apl-status-select select', mateoTo);
  await op.waitForSelector('.apl-sheet', { timeout: 8000 });
  await sleep(300);
  const behindSheet = await text(op, '.apl-dtitle h2');
  await op.keyboard.press('j');
  await sleep(300);
  ok(await text(op, '.apl-dtitle h2') === behindSheet, 'J and K don’t move the drawer behind a confirmation');
  await op.click('.apl-sheet-foot .btn-primary');
  await op.waitForFunction(() => !document.querySelector('.apl-sheet'), { timeout: 8000 }).catch(() => null);
  await sleep(500);
  ok(await op.$eval('.apl-status-select select', (el) => el.value) === mateoTo, `a status move shows in the open drawer at once (${await op.$eval('.apl-status-select select', (el) => el.value)})`);
  await op.close();
  await p.close();
}

// The rest of the drawer, as a fresh tester went at it
const openFamily = async (pg, name) => {
  await pg.goto(`${SITE}/admin/__applicants.html#applications/applicants/${acct(name).id}`, { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction((n) => document.querySelector('.apl-drawer h2')?.textContent === n && document.querySelector('.apl-convo'), { timeout: 10000 }, name);
  await sleep(300);
};
const shutDrawer = async (pg) => {
  await pg.keyboard.press('Escape');
  await pg.waitForFunction(() => !document.querySelector('.apl-drawer'), { timeout: 8000 }).catch(() => null);
  await sleep(150);
};
const toldOf = (pg, re) => pg.evaluate((src) => window.__toasts.filter(t => new RegExp(src).test(t.msg)).length, re.source);

// What the family gets is seen before anything moves: a preview that fails can't approve them with no email
{
  const sp = await open(1440, 1000);
  await openFamily(sp, 'Isla Example');
  await sp.focus('.apl-status-select select');
  failPreview = true;
  const stood = await sp.$eval('.apl-status-select select', el => el.value);
  await sp.select('.apl-status-select select', stood === 'Approved' ? 'Denied' : 'Approved');
  await sp.waitForSelector('.apl-sheet .apl-callout.is-warn', { timeout: 8000 }).catch(() => null);
  await shot(sp, 'status-preview-failed');
  ok(await sp.$eval('.apl-sheet-foot .btn-primary', el => el.disabled).catch(() => false), 'a preview that fails holds the move, so no family loses their email');
  failPreview = false;
  ok(await clickText(sp, '.apl-sheet .apl-more', /Try again/), 'and it can be tried again');
  await sp.waitForFunction(() => { const b = document.querySelector('.apl-sheet-foot .btn-primary'); return b && !b.disabled; }, { timeout: 8000 }).catch(() => null);
  ok(!(await sp.$eval('.apl-sheet-foot .btn-primary', el => el.disabled).catch(() => true)), 'and once it reads, the move is open again');
  await sleep(200);
  // The sheet keeps the keyboard
  const inside = [];
  for (let i = 0; i < 14; i++) { await sp.keyboard.press('Tab'); inside.push(await sp.evaluate(() => !!document.activeElement?.closest('.apl-sheet'))); }
  ok(inside.every(Boolean), `Tab stays in the status sheet (${inside.filter(Boolean).length} of ${inside.length})`);
  await sp.keyboard.press('Escape');
  await sleep(250);
  ok(!(await sp.$('.apl-sheet')) && await sp.evaluate(() => document.activeElement?.matches('.apl-status-select select')), 'Esc puts the focus back on the status it came from');
  await sp.close();
}

// A message keeps where it was going, whatever happens around it
{
  const cp = await open(1440, 1000);
  await openFamily(cp, 'Avery Stone');
  await clickText(cp, '.apl-thread .apl-more', /Reply/);
  await sleep(200);
  const title = await text(cp, '.apl-thread-to b');
  await cp.click('.apl-composer textarea');
  await cp.keyboard.type('An answer to the older conversation');
  await shutDrawer(cp);
  await openFamily(cp, 'Avery Stone');
  ok(await cp.$eval('.apl-composer textarea', el => el.value) === 'An answer to the older conversation' && !!title && await text(cp, '.apl-thread-to b') === title, `a reply left and come back to is still that reply (${title})`);
  await clickText(cp, '.apl-thread-to .apl-more', /New message/);
  await sleep(150);
  await cp.$eval('.apl-subject input', el => el.select());
  await cp.keyboard.type('About the visit');
  await shutDrawer(cp);
  await openFamily(cp, 'Avery Stone');
  ok(!!(await cp.$('.apl-subject input')) && await cp.$eval('.apl-subject input', el => el.value).catch(() => '') === 'About the visit', 'a new message left and come back to is still new, with its subject');
  // A family's reply coming in doesn't turn it into an answer
  const stone = acct('Avery Stone');
  stone.comments.push({ id: `${stone.id}-late`, name: 'RE: Application Status', message: 'One more thing from us', by: 'Jordan Stone', fromEmail: true, createdAt: new Date().toISOString(), parentCommentId: `${stone.id}-m0` });
  await cp.click('.apl-kv button[aria-label="Edit Referred by"]');
  await cp.waitForSelector('.apl-kv input.form-input', { timeout: 8000 });
  await cp.$eval('.apl-kv input.form-input', el => el.select());
  await cp.keyboard.type('Their neighbor');
  await cp.keyboard.press('Enter');
  await cp.waitForFunction(() => /One more thing from us/.test(document.querySelector('.apl-thread')?.textContent || ''), { timeout: 8000 }).catch(() => null);
  ok(/One more thing from us/.test(await text(cp, '.apl-thread')) && !!(await cp.$('.apl-subject input')) && !(await cp.$('.apl-thread-to')), 'a reply arriving leaves the new message as it was');
  await shutDrawer(cp);
  await openFamily(cp, 'Avery Stone');
  ok(!!(await cp.$('.apl-subject input')) && !(await cp.$('.apl-thread-to')) && await cp.$eval('.apl-subject input', el => el.value).catch(() => '') === 'About the visit', 'and left and come back to with the family waiting, it is still new');
  await cp.close();

  // Sent, left and come back to before it's in: there's nothing to send twice
  const dp = await open(1440, 1000);
  await openFamily(dp, 'Avery Stone');
  const sentBefore = messagesPosted;
  slowMessages = 1800;
  await dp.click('.apl-composer textarea');
  await dp.keyboard.type('Only once, please');
  await clickText(dp, '.apl-composer-foot .btn-primary', /Send/);
  await sleep(120);
  await shutDrawer(dp);
  await openFamily(dp, 'Avery Stone');
  ok(await dp.$eval('.apl-composer-foot .btn-primary', el => el.disabled && /Sending/.test(el.textContent)).catch(() => false), 'a message still on its way shows as sending when you come back');
  await dp.click('.apl-composer-foot .btn-primary').catch(() => null);
  await dp.waitForFunction(() => !document.querySelector('.apl-composer textarea')?.value, { timeout: 8000 }).catch(() => null);
  await sleep(300);
  slowMessages = 0;
  ok(messagesPosted === sentBefore + 1 && await dp.$eval('.apl-composer textarea', el => el.value) === '', `and it goes once (${messagesPosted - sentBefore})`);
  // The network dropping it brings Send back, with the words still there
  dropMessages = true;
  await dp.click('.apl-composer textarea');
  await dp.keyboard.type('Try me again');
  await clickText(dp, '.apl-composer-foot .btn-primary', /Send/);
  await sleep(500);
  dropMessages = false;
  ok(await dp.$eval('.apl-composer-foot .btn-primary', el => !el.disabled).catch(() => false) && await dp.$eval('.apl-composer textarea', el => el.value) === 'Try me again' && await toldOf(dp, /Avery Stone: not sent/) === 1, 'a dropped connection says so and leaves the message to send again');
  await dp.close();

  // A correction keeps its edits like any other message
  const isla = acct('Isla Example');
  isla.fields[F.status] = 'In Review';
  await DB.prepare('UPDATE applicants SET status = ? WHERE account_id = ?').bind('In Review', isla.id).run();
  const when = new Date().toISOString();
  await DB.prepare('INSERT OR REPLACE INTO applicant_notify (account_id, name, told, told_at, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(isla.id, isla.name, 'Approved', when, 'In Review', when).run();
  const fp = await open(1440, 1000);
  await openFamily(fp, 'Isla Example');
  ok(await clickText(fp, '.apl-thread-banner button', /orrection/), 'a family told the wrong thing can be sent a correction');
  await fp.waitForFunction(() => document.querySelector('.apl-composer textarea')?.value, { timeout: 8000 }).catch(() => null);
  await fp.click('.apl-composer textarea');
  await fp.keyboard.type(' My edit.');
  await shutDrawer(fp);
  await openFamily(fp, 'Isla Example');
  ok(/My edit\./.test(await fp.$eval('.apl-composer textarea', el => el.value)) && /Writing a correction/.test(await text(fp, '.apl-composer')), 'a correction left and come back to keeps its edits, and is still a correction');
  await fp.close();
}

// Previous and Next follow the screen, from the first press, and hold still while you work
{
  const bp = await open(1440, 1000);
  await bp.click('.apl-views [data-view="board"]');
  await bp.waitForSelector('.apl-card', { timeout: 10000 });
  const cards = await bp.$$eval('.apl-card', els => els.map(e => e.dataset.id));
  const wrong = [];
  for (const id of cards.slice(0, 5)) {
    const i = cards.indexOf(id);
    if (!cards[i + 1]) continue;
    await bp.goto(`${SITE}/admin/__applicants.html#applications/applicants/${id}`, { waitUntil: 'domcontentloaded' });
    await bp.reload({ waitUntil: 'domcontentloaded' });
    await bp.waitForSelector('.apl-drawer .apl-convo', { timeout: 10000 }).catch(() => null);
    await sleep(400);
    await bp.click('.apl-drawer button[aria-label="Next family (J)"]').catch(() => null);
    await sleep(350);
    const at = await bp.evaluate(() => location.hash.split('/').pop());
    if (at !== cards[i + 1]) wrong.push(`${id}→${at}, not ${cards[i + 1]}`);
  }
  ok(!wrong.length, `the first Next after a link is the next card on the board (${wrong.join('; ')})`);
  await bp.close();

  const lp = await open(1440, 1000);
  await lp.click('.apl-views [data-view="list"]');
  await lp.waitForSelector('.apl-table tbody tr', { timeout: 10000 });
  await sleep(300);
  const rows = await lp.$$eval('.apl-table tbody tr strong', els => els.map(e => e.textContent));
  const third = rows[2];
  await lp.click('.apl-table tbody tr:nth-child(3) td');
  await lp.waitForSelector('.apl-kv button[aria-label="Edit Referred by"]', { timeout: 8000 });
  await sleep(300);
  await lp.click('.apl-kv button[aria-label="Edit Referred by"]');
  await lp.waitForSelector('.apl-kv input.form-input', { timeout: 8000 });
  await lp.$eval('.apl-kv input.form-input', el => el.select());
  await lp.keyboard.type('A row that moves');
  await lp.keyboard.press('Enter');
  await sleep(900);
  await lp.click('.apl-drawer button[aria-label="Next family (J)"]');
  await lp.waitForFunction((n) => { const t = document.querySelector('.apl-drawer h2')?.textContent; return t && t !== n; }, { timeout: 8000 }, third).catch(() => null);
  ok(await text(lp, '.apl-drawer h2') === rows[3], `after a save moves a row, Next is still the one below it (${third} → ${await text(lp, '.apl-drawer h2')}, wanted ${rows[3]})`);
  await lp.close();

  // Coming to a family with the conversation behind another tab: it opens on the latest, not the oldest
  const vp = await open(1440, 560);
  await openFamily(vp, 'Avery Stone');
  await vp.click('.apl-drawer button[aria-label="Next family (J)"]');
  await vp.waitForFunction(() => document.querySelector('.apl-drawer h2')?.textContent !== 'Avery Stone' && document.querySelector('.apl-convo'), { timeout: 8000 }).catch(() => null);
  await sleep(300);
  await vp.click('.apl-dtabs [data-tab="score"]').catch(() => null);
  await sleep(200);
  await vp.click('.apl-drawer button[aria-label="Previous family (K)"]');
  await vp.waitForFunction(() => document.querySelector('.apl-drawer h2')?.textContent === 'Avery Stone' && document.querySelector('.apl-convo'), { timeout: 8000 }).catch(() => null);
  await sleep(300);
  await vp.click('.apl-dtabs [data-tab="convo"]').catch(() => null);
  await sleep(300);
  const end = await vp.$eval('.apl-thread', el => ({ left: el.scrollHeight - el.scrollTop - el.clientHeight, tall: el.scrollHeight > el.clientHeight }));
  ok(end.tall && end.left < 5, `the conversation opens on its latest line behind a tab too (${JSON.stringify(end)})`);
  await vp.close();
}

// Sizes and sheets on a phone and an iPad
{
  const phone2 = await open(390, 844);
  const applied = Object.values(w.world.accounts).find(a => a.fields[F.status] === 'Applied' && (a.contacts || []).length && a.name !== 'Harper Lee');
  await openFamily(phone2, applied.name);
  await phone2.select('.apl-status-select select', 'In Review');
  await phone2.waitForSelector('.apl-sheet-foot .btn-primary:not([disabled])', { timeout: 8000 }).catch(() => null);
  await sleep(200);
  const cut = await phone2.$$eval('.apl-sheet .apl-card-sub', els => els.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent.slice(0, 50)));
  ok(!cut.length && /Goes out at/.test(await text(phone2, '.apl-sheet')), `the status sheet's sentences show whole on a phone (${JSON.stringify(cut)})`);
  await phone2.keyboard.press('Escape');
  await sleep(200);
  const tabs = await phone2.$$eval('.apl-dtabs button', els => els.filter(e => e.offsetParent).map(e => e.getBoundingClientRect().height));
  await phone2.click('.apl-dtabs [data-tab="details"]');
  await sleep(200);
  const links = await phone2.$$eval('.apl-contact a', els => els.map(e => e.getBoundingClientRect().height));
  ok(tabs.length && tabs.every(t => t >= 44) && links.length && links.every(t => t >= 44), `tabs and contact links are full tap size (${tabs.join()}; ${links.join()})`);
  // A family link that goes nowhere still has a way out, with no header to hold a Close
  await phone2.goto(`${SITE}/admin/__applicants.html#applications/applicants/nosuchfamily`, { waitUntil: 'domcontentloaded' });
  await phone2.waitForFunction(() => document.querySelector('.apl-drawer')?.textContent.includes('Try again') || document.querySelector('.apl-drawer')?.textContent.includes('any more'), { timeout: 8000 }).catch(() => null);
  ok(await clickText(phone2, '.apl-drawer .apl-more', /^Close$/) && await phone2.waitForFunction(() => !document.querySelector('.apl-drawer'), { timeout: 4000 }).then(() => true, () => false), 'a dead family link can be closed on a phone');
  await phone2.close();

  const ip = await open(768, 1000, '__shell.html');
  await ip.setViewport({ width: 768, height: 1000, deviceScaleFactor: 1, hasTouch: true });
  await ip.reload({ waitUntil: 'domcontentloaded' });
  await ip.waitForSelector('.apl-card, .apl-table', { timeout: 20000 }).catch(() => null);
  await ip.evaluate((id) => { location.hash = `#applications/applicants/${id}`; }, acct('Avery Stone').id);
  await ip.waitForSelector('.apl-dtabs [data-tab="details"]', { timeout: 8000 }).catch(() => null);
  await sleep(300);
  await ip.click('.apl-dtabs [data-tab="details"]');
  await sleep(200);
  await ip.setViewport({ width: 1024, height: 768, deviceScaleFactor: 1, hasTouch: true });
  await sleep(400);
  ok(await ip.evaluate(() => { const t = document.querySelector('.apl-dtabs [aria-selected="true"]'); return !!t && t.offsetParent !== null; }), 'an iPad turned on its side while on Details still shows which tab is open');
  await ip.close();
}

// Details: the limit speaks only when something was cut, typing since a failure stays, and a late answer closes nobody else
{
  const mp = await open(1440, 1000);
  await openFamily(mp, 'Eliza Franklin');
  await mp.click('.apl-kv button[aria-label="Edit Referred by"]');
  await mp.waitForSelector('.apl-kv input.form-input', { timeout: 8000 });
  await mp.$eval('.apl-kv input.form-input', el => el.select());
  await mp.keyboard.sendCharacter('x'.repeat(300));
  await sleep(150);
  ok(await toldOf(mp, /holds 300 characters/) === 0, 'exactly as many characters as fit: no warning');
  await mp.keyboard.type('y');
  await sleep(150);
  ok(await toldOf(mp, /holds 300 characters/) === 1 && (await mp.$eval('.apl-kv input.form-input', el => el.value)).length === 300, 'one past the limit: the warning, once');
  await mp.keyboard.press('Escape');
  await sleep(200);
  await mp.close();

  const tp = await open(1440, 1000);
  await openFamily(tp, 'Eliza Franklin');
  failFields = true;
  slowQueue.length = 0;
  slowQueue.push(9000); // long enough to go away, come back and type on a busy machine
  await tp.click('.apl-kv button[aria-label="Edit Referred by"]');
  await tp.waitForSelector('.apl-kv input.form-input', { timeout: 8000 });
  await tp.$eval('.apl-kv input.form-input', el => el.select());
  await tp.keyboard.type('First try');
  await tp.keyboard.press('Enter');
  await sleep(100);
  // Whichever neighbour there is: this family can be last in the order
  const lastInOrder = await tp.$eval('.apl-drawer button[aria-label="Next family (J)"]', b => b.disabled);
  await tp.keyboard.press(lastInOrder ? 'k' : 'j');
  await tp.waitForFunction(() => document.querySelector('.apl-drawer h2')?.textContent !== 'Eliza Franklin' && document.querySelector('.apl-kv'), { timeout: 8000 }).catch(() => null);
  await sleep(200);
  await tp.keyboard.press(lastInOrder ? 'j' : 'k');
  await tp.waitForFunction(() => document.querySelector('.apl-drawer h2')?.textContent === 'Eliza Franklin' && document.querySelector('.apl-kv button[aria-label="Edit Referred by"]'), { timeout: 8000 }).catch(() => null);
  await sleep(200);
  await tp.click('.apl-kv button[aria-label="Edit Referred by"]');
  await tp.waitForSelector('.apl-kv input.form-input', { timeout: 8000 });
  await tp.$eval('.apl-kv input.form-input', el => el.select());
  await tp.keyboard.type('Second try');
  ok(await toldOf(tp, /Referred by not saved/) === 0, 'the box is being typed in while the first save is still going');
  await tp.waitForFunction(() => window.__toasts.some(t => /Referred by not saved/.test(t.msg)), { timeout: 15000 }).catch(() => null);
  ok(await toldOf(tp, /Referred by not saved/) === 1, 'and that save fails');
  await sleep(350);
  failFields = false;
  ok(await tp.$eval('.apl-kv input.form-input', el => el.value).catch(() => '') === 'Second try', 'what you typed after an earlier save stays when that save fails');
  await tp.keyboard.press('Escape');
  await sleep(150);
  await tp.close();

  const zp = await open(1440, 1000);
  await openFamily(zp, 'Owen Lindgren');
  const gone = acct('Owen Lindgren');
  delete gone.fields[F.status];
  await DB.prepare('UPDATE applicants SET status = NULL WHERE account_id = ?').bind(gone.id).run();
  slowQueue.push(1300);
  await zp.select('.apl-kv select[aria-label="Makeover year"]', '');
  await sleep(100);
  await shutDrawer(zp);
  await openFamily(zp, 'Kenna Thomason');
  await zp.waitForFunction(() => window.__toasts.some(t => /Owen Lindgren has no status or year now/.test(t.msg)), { timeout: 8000 }).catch(() => null);
  await sleep(500);
  ok(await text(zp, '.apl-drawer h2') === 'Kenna Thomason', 'a family leaving after the drawer closed leaves the family open now alone');
  await zp.close();

  // Show on map finds a family whatever the filters say
  const np = await open(1440, 1000);
  await openFamily(np, 'Avery Stone');
  const yearNow = await np.$eval('.apl-kv select[aria-label="Makeover year"]', el => el.value);
  const moveTo = yearNow === '2026' ? '2025' : '2026';
  await np.select('.apl-kv select[aria-label="Makeover year"]', moveTo);
  await sleep(700);
  await clickText(np, '.apl-side .apl-more', /Show on map/);
  await np.waitForSelector('.apl-homemap .apl-pin', { timeout: 15000 }).catch(() => null);
  await np.waitForFunction(() => /Avery Stone/.test(document.querySelector('.leaflet-popup-content')?.textContent || ''), { timeout: 6000 }).catch(() => null);
  ok(/Avery Stone/.test(await text(np, '.leaflet-popup-content')), 'Show on map finds a family the season filter would have hidden');
  await np.evaluate((id, year) => fetch('/api/applicants-admin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fields: { id, changes: { year } } }) }), acct('Avery Stone').id, yearNow);
  await np.close();
}

// Round two of the same: a correction and a draft, a move under way, and sizes changing
{
  const rp = await open(1440, 800);
  await openFamily(rp, 'Isla Example');
  await rp.click('.apl-composer textarea');
  await rp.keyboard.type('Words of my own');
  await clickText(rp, '.apl-thread-banner button', /orrection/);
  await rp.waitForFunction(() => /Writing a correction/.test(document.querySelector('.apl-composer')?.textContent || ''), { timeout: 8000 }).catch(() => null);
  await sleep(300);
  const under = await rp.$eval('.apl-thread', el => el.scrollHeight - el.scrollTop - el.clientHeight);
  ok(under < 5, `starting a correction keeps the latest line in view (${under}px under)`);
  await rp.keyboard.type(' Hand edit.');
  await clickText(rp, '.apl-thread-banner button', /orrection/);
  await sleep(500);
  ok(/Hand edit\./.test(await rp.$eval('.apl-composer textarea', el => el.value)), 'pressing Write a correction again leaves your edits alone');
  await clickText(rp, '.apl-composer .apl-callout .apl-more', /^Cancel$/);
  await sleep(250);
  ok(await rp.$eval('.apl-composer textarea', el => el.value) === 'Words of my own', 'cancelling a correction brings back what you were writing');
  await rp.close();

  const vp = await open(1440, 1000);
  await openFamily(vp, 'Kenna Thomason');
  await vp.select('.apl-status-select select', 'Denied');
  await vp.waitForSelector('.apl-sheet-foot .btn-primary:not([disabled])', { timeout: 8000 }).catch(() => null);
  slowMoves = 1500;
  await vp.click('.apl-sheet-foot .btn-primary');
  await sleep(150);
  const offWhileMoving = await vp.$eval('.apl-sheet-foot .btn-ghost', el => el.disabled).catch(() => false);
  await vp.keyboard.press('Escape');
  await sleep(150);
  ok(offWhileMoving && !!(await vp.$('.apl-sheet')), 'a move under way can’t look cancelled: Cancel is off and Esc waits for it');
  await vp.waitForFunction(() => !document.querySelector('.apl-sheet'), { timeout: 8000 }).catch(() => null);
  slowMoves = 0;
  await vp.close();

  const ip = await open(768, 1000, '__shell.html');
  await ip.setViewport({ width: 768, height: 1000, deviceScaleFactor: 1, hasTouch: true });
  await ip.reload({ waitUntil: 'domcontentloaded' });
  await ip.waitForSelector('.apl-card, .apl-table', { timeout: 20000 }).catch(() => null);
  await ip.evaluate((id) => { location.hash = `#applications/applicants/${id}`; }, acct('Avery Stone').id);
  await ip.waitForSelector('.apl-thread', { timeout: 8000 }).catch(() => null);
  await sleep(500);
  // Reply and its neighbours keep their look and take a full-size tap
  const tap = await ip.evaluate(async () => {
    const el = [...document.querySelectorAll('.apl-msg-actions .apl-more')].at(-1);
    el.scrollIntoView({ block: 'center' });
    await new Promise(res => setTimeout(res, 100));
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    return [-20, 20].every(d => document.elementFromPoint(x, y + d)?.closest('.apl-more') === el);
  }).catch(() => false);
  ok(tap, 'a small link in the conversation takes a 44px tap on touch');
  await ip.$eval('.apl-thread', el => { el.scrollTop = el.scrollHeight; });
  await sleep(150);
  await ip.setViewport({ width: 1024, height: 768, deviceScaleFactor: 1, hasTouch: true });
  await sleep(500);
  const turned = await ip.$eval('.apl-thread', el => ({ left: el.scrollHeight - el.scrollTop - el.clientHeight, tall: el.scrollHeight > el.clientHeight }));
  ok(turned.tall && turned.left < 5, `turning an iPad stays on the latest line (${JSON.stringify(turned)})`);
  await ip.close();

  // A phone on its side: too short for it all at once, and nothing out of reach
  const sidePhone = await open(1440, 1000);
  await sidePhone.setViewport({ width: 844, height: 390, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await sidePhone.reload({ waitUntil: 'domcontentloaded' });
  await sidePhone.waitForSelector('.apl-card, .apl-table', { timeout: 20000 }).catch(() => null);
  await sidePhone.evaluate((id) => { location.hash = `#applications/applicants/${id}`; }, acct('Avery Stone').id);
  await sidePhone.waitForSelector('.apl-composer-foot .btn-primary', { timeout: 8000 }).catch(() => null);
  await sleep(500);
  const sideways = await sidePhone.evaluate(() => {
    const pane = document.querySelector('.apl-convo');
    pane.scrollTop = pane.scrollHeight;
    const b = document.querySelector('.apl-composer-foot .btn-primary').getBoundingClientRect();
    return { thread: Math.round(document.querySelector('.apl-thread').getBoundingClientRect().height), sendShows: b.bottom <= innerHeight && b.top >= 0 };
  });
  ok(sideways.thread >= 190 && sideways.sendShows, `a phone on its side can read the conversation and reach Send (${JSON.stringify(sideways)})`);
  await sidePhone.close();

  // The map: fresh on its tab, and Show on map always answers
  const mp = await open(1440, 1000);
  const popup = () => text(mp, '.leaflet-popup-content');
  const showOnMap = async (name) => {
    await openFamily(mp, name);
    await clickText(mp, '.apl-side .apl-more', /Show on map/);
    await mp.waitForFunction((n) => (document.querySelector('.leaflet-popup-content')?.textContent || '').includes(n), { timeout: 8000 }, name).catch(() => null);
  };
  await showOnMap('Eliza Franklin');
  await mp.click('.apl-views [data-view="list"]');
  await sleep(200);
  await mp.click('.apl-views [data-view="map"]');
  await mp.waitForSelector('.apl-homemap .apl-pin', { timeout: 15000 }).catch(() => null);
  await sleep(600);
  ok(!(await mp.$('.leaflet-popup-content')), 'the Map tab opens on the whole area, not the last family shown');
  await clickText(mp, '.apl-legend button', /Approved/);
  await sleep(300);
  await showOnMap('Eliza Franklin');
  ok(/Eliza Franklin/.test(await popup()), 'Show on map switches their status back on');
  await mp.evaluate(() => document.querySelector('.leaflet-popup-close-button')?.click());
  await sleep(400);
  await showOnMap('Eliza Franklin');
  ok(/Eliza Franklin/.test(await popup()), 'Show on map answers for the same family twice');
  await mp.close();

  // The keyboard in the other sheets
  const hp = await open(1280, 900);
  await hp.click('.apl-views [data-view="scores"]');
  await sleep(400);
  await clickText(hp, 'button', /How scoring works/);
  await hp.waitForSelector('.apl-how', { timeout: 8000 }).catch(() => null);
  await sleep(200);
  const reached = [];
  for (let i = 0; i < 4; i++) { await hp.keyboard.press('Tab'); reached.push(await hp.evaluate(() => document.activeElement?.tagName)); }
  ok(reached.includes('SUMMARY'), `Tab reaches the criteria in How scoring works (${reached.join()})`);
  await hp.keyboard.press('Escape');
  await sleep(200);
  await hp.click('.apl-views [data-view="board"]');
  await hp.waitForSelector('.apl-more-btn', { timeout: 8000 }).catch(() => null);
  await hp.click('.apl-more-btn');
  await sleep(150);
  await clickText(hp, '.apl-menu button', /Pause family emails/);
  await hp.waitForSelector('.apl-sheet', { timeout: 8000 }).catch(() => null);
  await sleep(150);
  await hp.keyboard.press('Escape');
  await sleep(250);
  ok(await hp.evaluate(() => document.activeElement?.matches('.apl-more-btn')), 'closing Pause family emails puts the focus back on ⋯');
  await openFamily(hp, 'Eliza Franklin');
  failPreview = true;
  await hp.select('.apl-status-select select', 'Denied');
  await hp.waitForSelector('.apl-sheet .apl-callout.is-warn', { timeout: 8000 }).catch(() => null);
  failPreview = false;
  await hp.evaluate(() => [...document.querySelectorAll('.apl-sheet .apl-more')].find(b => /Try again/.test(b.textContent))?.focus());
  await hp.keyboard.press('Enter');
  await hp.waitForSelector('.apl-sheet-foot .btn-primary:not([disabled])', { timeout: 8000 }).catch(() => null);
  await sleep(200);
  ok(await hp.evaluate(() => document.activeElement?.matches('.apl-sheet-foot .btn-primary')), 'Try again by keyboard lands on Move once the preview is in');
  await hp.keyboard.press('Escape');
  await hp.close();

  // Where a message is going, the last few ways it could go stale
  const stone = acct('Avery Stone');
  stone.comments.push({ id: `${stone.id}-v0`, name: 'Visit day', message: 'Does Thursday work?', by: 'Qualification Committee', createdAt: new Date(Date.now() + 1000).toISOString(), assignees: [{ name: 'Jordan Stone', emailAddress: 'jordan@example.com', accountType: 'customer' }] });
  stone.comments.push({ id: `${stone.id}-v1`, name: 'RE: Visit day', message: 'Thursday is great', by: 'Jordan Stone', fromEmail: true, createdAt: new Date(Date.now() + 2000).toISOString(), parentCommentId: `${stone.id}-v0` });
  const yp = await open(1440, 1000);
  await openFamily(yp, 'Avery Stone');
  await clickText(yp, '.apl-thread-to .apl-more', /New message/);
  await sleep(150);
  await yp.$eval('.apl-subject input', el => el.select());
  await yp.keyboard.type('Only a subject');
  await shutDrawer(yp);
  await openFamily(yp, 'Avery Stone');
  ok(await yp.$eval('.apl-subject input', el => el.value).catch(() => '') === 'Only a subject', 'a subject typed with no message waits for you too');
  await yp.close();
  const zp = await open(1440, 1000);
  await openFamily(zp, 'Avery Stone');
  await clickText(zp, '.apl-thread-to .apl-more', /New message/);
  await sleep(150);
  await zp.click('.apl-composer textarea');
  await zp.keyboard.type('Changed my mind');
  await shutDrawer(zp);
  await openFamily(zp, 'Avery Stone');
  await zp.$eval('.apl-composer textarea', el => el.select());
  await zp.keyboard.press('Backspace');
  await sleep(200);
  ok(!!(await zp.$('.apl-subject input')) && !(await zp.$('.apl-thread-to')), 'a new message emptied after coming back stays new, so it still reaches everyone');
  await zp.close();
  const zq = await open(1440, 1000);
  await openFamily(zq, 'Avery Stone');
  await clickText(zq, '.apl-msg-actions .apl-more', /Reply/);
  await sleep(150);
  await zq.click('.apl-composer textarea');
  await zq.keyboard.type('In the older conversation');
  await shutDrawer(zq);
  await openFamily(zq, 'Avery Stone');
  const older = await text(zq, '.apl-thread-to b');
  await zq.$eval('.apl-composer textarea', el => el.select());
  await zq.keyboard.press('Backspace');
  await sleep(200);
  ok(older === 'Application Status' && await text(zq, '.apl-thread-to b') === 'Application Status', `a conversation you chose stays chosen when its draft is emptied after coming back (${older} → ${await text(zq, '.apl-thread-to b')})`);
  await zq.close();
  const lp = await open(1440, 1000);
  await lp.click('.apl-views [data-view="list"]');
  await lp.waitForSelector('.apl-table tbody tr', { timeout: 10000 });
  await lp.evaluate((id) => { location.hash = `#applications/applicants/${id}/reply/${id}-m0`; }, stone.id);
  await lp.waitForSelector('.apl-thread-to', { timeout: 8000 }).catch(() => null);
  await sleep(300);
  const linked = await text(lp, '.apl-thread-to b');
  await shutDrawer(lp);
  await lp.evaluate((id) => document.querySelector(`.apl-table tbody tr td`) && [...document.querySelectorAll('.apl-table tbody tr')].find(r => /Avery Stone/.test(r.textContent))?.click(), stone.id);
  await lp.waitForSelector('.apl-thread-to', { timeout: 8000 }).catch(() => null);
  await sleep(300);
  ok(linked === 'Application Status' && await text(lp, '.apl-thread-to b') === 'Visit day', `a reply link lasts its one visit (${linked} → ${await text(lp, '.apl-thread-to b')})`);
  await lp.close();

  // A send that failed leaves you where you were reading
  const fp = await open(1440, 620);
  await openFamily(fp, 'Avery Stone');
  await fp.$eval('.apl-thread', el => { el.scrollTop = 0; });
  await sleep(150);
  dropMessages = true;
  await fp.click('.apl-composer textarea');
  await fp.keyboard.type('This one fails');
  await clickText(fp, '.apl-composer-foot .btn-primary', /Send/);
  await sleep(400);
  dropMessages = false;
  stone.comments.push({ id: `${stone.id}-v2`, name: 'RE: Visit day', message: 'And Friday too', by: 'Jordan Stone', fromEmail: true, createdAt: new Date(Date.now() + 3000).toISOString(), parentCommentId: `${stone.id}-v0` });
  await fp.click('.apl-kv button[aria-label="Edit Referred by"]');
  await fp.waitForSelector('.apl-kv input.form-input', { timeout: 8000 });
  await fp.$eval('.apl-kv input.form-input', el => el.select());
  await fp.keyboard.type('Their aunt');
  await fp.keyboard.press('Enter');
  await fp.waitForFunction(() => /And Friday too/.test(document.querySelector('.apl-thread')?.textContent || ''), { timeout: 8000 }).catch(() => null);
  await sleep(300);
  ok(/And Friday too/.test(await text(fp, '.apl-thread')) && await fp.$eval('.apl-thread', el => el.scrollTop < 40), 'a send that failed leaves you where you were reading when a reply comes in');
  await fp.close();

  // A very long email address wraps instead of pushing things off a phone
  const lengthy = Object.values(w.world.accounts).find(a => a.fields[F.status] === 'Applied' && (a.contacts || []).length && a.name !== 'Harper Lee');
  lengthy.contacts[0].fields[EMAIL] = `${'long.name.'.repeat(9)}x@example.com`;
  const op = await open(390, 844);
  await op.evaluate((id) => fetch('/api/applicants-admin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fields: { id, changes: { referredBy: 'A friend' } } }) }), lengthy.id);
  await openFamily(op, lengthy.name);
  await op.select('.apl-status-select select', 'In Review');
  await op.waitForSelector('.apl-sheet-foot .btn-primary:not([disabled])', { timeout: 8000 }).catch(() => null);
  await sleep(250);
  const sheetFits = await op.$eval('.apl-sheet', (el) => {
    const edge = el.getBoundingClientRect().right;
    return el.scrollWidth <= el.clientWidth + 1 && [...el.querySelectorAll('.apl-sheet-foot button')].every(b => b.getBoundingClientRect().right <= edge + 1);
  });
  ok(sheetFits, 'the status sheet fits a phone with a very long email');
  await op.keyboard.press('Escape');
  await sleep(200);
  await op.click('.apl-dtabs [data-tab="details"]');
  await sleep(250);
  ok(await op.$$eval('.apl-contact a', els => els.length > 0 && els.every(a => a.getBoundingClientRect().right <= innerWidth)), 'Details fits a phone with a very long email');
  await op.close();
}

// Round three: what's under way holds still, small screens, and the words for a community project
{
  const gp = await open(1440, 1000);
  await openFamily(gp, 'Isla Example');
  slowMessages = 1500;
  await gp.click('.apl-composer textarea');
  await gp.keyboard.type('On its way');
  await clickText(gp, '.apl-composer-foot .btn-primary', /Send/);
  await sleep(150);
  ok(await gp.$$eval('.apl-thread-banner button', els => els.some(b => /orrection/.test(b.textContent)) && els.filter(b => /orrection/.test(b.textContent)).every(b => b.disabled)), 'Write a correction waits while a message is on its way');
  await gp.waitForFunction(() => !document.querySelector('.apl-composer textarea')?.value, { timeout: 8000 }).catch(() => null);
  await sleep(250);
  await clickText(gp, '.apl-thread-banner button', /orrection/);
  await gp.waitForFunction(() => /Writing a correction/.test(document.querySelector('.apl-composer')?.textContent || ''), { timeout: 8000 }).catch(() => null);
  await sleep(200);
  await clickText(gp, '.apl-composer-foot .btn-primary', /Send correction/);
  await sleep(150);
  ok(await gp.$$eval('.apl-composer .apl-callout .apl-more', els => els.some(b => /^Cancel$/.test(b.textContent)) && els.filter(b => /^Cancel$/.test(b.textContent)).every(b => b.disabled)), 'a correction on its way can’t look cancelled');
  await gp.waitForFunction(() => !/Writing a correction/.test(document.querySelector('.apl-composer')?.textContent || ''), { timeout: 8000 }).catch(() => null);
  slowMessages = 0;
  await gp.close();

  const hp = await open(1440, 1000);
  await openFamily(hp, 'Eliza Franklin');
  await clickText(hp, '.apl-thread-to .apl-more', /New message/);
  await sleep(150);
  await hp.$eval('.apl-subject input', el => el.select());
  await hp.keyboard.type('Just this once');
  await hp.click('.apl-composer textarea');
  await hp.keyboard.type('A one-off');
  await clickText(hp, '.apl-composer-foot .btn-primary', /Send/);
  await hp.waitForFunction(() => !document.querySelector('.apl-composer textarea')?.value, { timeout: 8000 }).catch(() => null);
  await sleep(250);
  ok(await hp.$eval('.apl-subject input', el => el.value).catch(() => 'Just this once') !== 'Just this once', 'a subject typed for one message goes with it');
  await hp.close();

  // A phone on its side
  const sideways = await open(1440, 1000);
  await sideways.setViewport({ width: 844, height: 390, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await sideways.reload({ waitUntil: 'domcontentloaded' });
  await sideways.waitForSelector('.apl-card, .apl-table', { timeout: 20000 }).catch(() => null);
  await sideways.evaluate((id) => { location.hash = `#applications/applicants/${id}`; }, acct('Avery Stone').id);
  await sideways.waitForSelector('.apl-composer-foot .btn-primary', { timeout: 8000 }).catch(() => null);
  await sleep(500);
  ok(await sideways.$eval('.apl-thread', el => getComputedStyle(el).overscrollBehaviorY === 'auto'), 'on a phone on its side, a swipe at the end of the conversation carries on to Send');
  await sideways.click('.apl-dtabs [data-tab="score"]');
  await sleep(300);
  ok(await sideways.$eval('.apl-dbody .apl-score', el => el.clientHeight >= 150 && el.scrollHeight > el.clientHeight && getComputedStyle(el).overscrollBehaviorY === 'auto').catch(() => false) && await sideways.$eval('.apl-drawer button[aria-label="Close (Esc)"]', el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), 'and the scorecard scrolls, with Close still on screen');
  await sideways.click('.apl-dtabs [data-tab="convo"]');
  await sleep(200);
  const moveTo = await sideways.$eval('.apl-status-select select', el => (el.value === 'In Review' ? 'Applied' : 'In Review'));
  await sideways.select('.apl-status-select select', moveTo);
  await sideways.waitForSelector('.apl-sheet-foot .btn-primary:not([disabled])', { timeout: 8000 }).catch(() => null);
  await sleep(300);
  ok(await sideways.$eval('.apl-sheet', el => el.scrollTop) === 0, 'the status sheet opens at its title on a short screen');
  await sideways.keyboard.press('Escape');
  await sleep(200);
  await sideways.close();

  // A small phone with a banner, and one family no one can email
  const when = new Date().toISOString();
  const evan = acct('Evan Burkett');
  const logan = acct('Logan Logan');
  await DB.prepare('INSERT OR REPLACE INTO applicant_notify (account_id, name, told, told_at, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(evan.id, evan.name, 'Approved', when, 'In Review', when).run();
  await DB.prepare('INSERT OR REPLACE INTO applicant_notify (account_id, name, told, told_at, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(logan.id, logan.name, 'Approved', when, 'In Review', when).run();
  for (const c of logan.contacts) delete c.fields[EMAIL];
  const sm = await open(375, 667);
  await sm.evaluate((id) => fetch('/api/applicants-admin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fields: { id, changes: { referredBy: 'A neighbor' } } }) }), logan.id);
  await openFamily(sm, 'Evan Burkett');
  await sm.waitForSelector('.apl-thread-banner', { timeout: 8000 }).catch(() => null);
  const small = await sm.$eval('.apl-thread', el => ({ wider: el.scrollWidth - el.clientWidth, banner: getComputedStyle(el.querySelector('.apl-thread-banner')).position }));
  ok(small.wider <= 0 && small.banner === 'static', `a small phone keeps the conversation with a banner showing (${JSON.stringify(small)})`);
  await openFamily(sm, 'Logan Logan');
  await sm.waitForSelector('.apl-thread-banner', { timeout: 8000 }).catch(() => null);
  ok(!(await sm.$('.apl-thread-banner button')) && /Add an email address in JobTread/.test(await text(sm, '.apl-thread-banner')), 'no email address: it says what to do, with no button that does nothing');
  await sm.close();

  // The conversation fits any screen: a readable thread, and Send always reachable, at sizes no rule names
  const short = [];
  for (const [width, height] of [[375, 600], [360, 640], [375, 667], [390, 664], [640, 360], [500, 620]]) {
    const q = await open(1440, 1000);
    await q.setViewport({ width, height, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await q.reload({ waitUntil: 'domcontentloaded' });
    await q.waitForSelector('.apl-card, .apl-table', { timeout: 20000 }).catch(() => null);
    await q.evaluate((id) => { location.hash = `#applications/applicants/${id}`; }, acct('Avery Stone').id);
    await q.waitForSelector('.apl-msg-actions .apl-more', { timeout: 8000 }).catch(() => null);
    await sleep(350);
    await clickText(q, '.apl-msg-actions .apl-more', /Reply/); // the tallest box there is: To, the note, the message
    await sleep(250);
    const fit = await q.evaluate(() => {
      const pane = document.querySelector('.apl-convo');
      pane.scrollTop = pane.scrollHeight;
      const b = document.querySelector('.apl-composer-foot .btn-primary').getBoundingClientRect();
      return { thread: Math.round(document.querySelector('.apl-thread').getBoundingClientRect().height), reach: b.bottom <= innerHeight && b.top >= 0 };
    });
    if (fit.thread < Math.min(240, height / 2) - 1 || !fit.reach) short.push(`${width}x${height} ${JSON.stringify(fit)}`);
    await q.close();
  }
  ok(!short.length, `every short screen keeps a readable thread and reaches Send (${short.join('; ')})`);

  // Words typed while a correction is on its way to the box aren't lost
  const eliza = acct('Eliza Franklin');
  await DB.prepare('INSERT OR REPLACE INTO applicant_notify (account_id, name, told, told_at, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(eliza.id, eliza.name, 'Approved', when, 'In Review', when).run();
  const wr = await open(1440, 1000);
  await openFamily(wr, 'Eliza Franklin');
  await wr.waitForSelector('.apl-thread-banner', { timeout: 8000 }).catch(() => null);
  slowDrafts = 900;
  await wr.click('.apl-composer textarea');
  await clickText(wr, '.apl-thread-banner button', /orrection/);
  await sleep(100);
  await wr.focus('.apl-composer textarea');
  await wr.keyboard.type('Typed in the meantime');
  await wr.waitForFunction(() => /Writing a correction/.test(document.querySelector('.apl-composer')?.textContent || ''), { timeout: 8000 }).catch(() => null);
  slowDrafts = 0;
  await sleep(200);
  await clickText(wr, '.apl-composer .apl-callout .apl-more', /^Cancel$/);
  await sleep(250);
  ok(await wr.$eval('.apl-composer textarea', el => el.value) === 'Typed in the meantime', 'words typed while a correction was being written come back on Cancel');
  await wr.close();

  // A Reply you chose stays chosen, before a word is written and through a correction
  const ch = await open(1280, 800);
  await openFamily(ch, 'Eliza Franklin');
  await ch.waitForSelector('.apl-thread-banner', { timeout: 8000 }).catch(() => null);
  await clickText(ch, '.apl-msg-actions .apl-more', /Reply/);
  await ch.waitForSelector('.apl-thread-to', { timeout: 8000 }).catch(() => null);
  await sleep(200);
  const chosen = await text(ch, '.apl-thread-to b');
  await shutDrawer(ch);
  await openFamily(ch, 'Eliza Franklin');
  await sleep(200);
  ok(!!chosen && await text(ch, '.apl-thread-to b') === chosen, `a Reply chosen with an empty box is still chosen after Esc and back (${chosen})`);
  await clickText(ch, '.apl-thread-banner button', /orrection/);
  await ch.waitForFunction(() => /Writing a correction/.test(document.querySelector('.apl-composer')?.textContent || ''), { timeout: 8000 }).catch(() => null);
  await sleep(200);
  await clickText(ch, '.apl-composer .apl-callout .apl-more', /^Cancel$/);
  await sleep(250);
  ok(await text(ch, '.apl-thread-to b') === chosen, 'and after a correction started and cancelled');
  await ch.close();

  // Small things on small and short screens
  const dt = await open(360, 640);
  await openFamily(dt, 'Avery Stone');
  await dt.click('.apl-dtabs [data-tab="details"]');
  await sleep(250);
  ok(await dt.$eval('.apl-side', el => el.scrollWidth <= el.clientWidth), 'Details fits a 360px phone, with nothing to swipe sideways');
  await dt.close();
  const sn = await open(1440, 1000);
  await sn.setViewport({ width: 667, height: 375, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await sn.reload({ waitUntil: 'domcontentloaded' });
  await sn.waitForSelector('.apl-card, .apl-table', { timeout: 20000 }).catch(() => null);
  await sn.evaluate((id) => { location.hash = `#applications/applicants/${id}`; }, acct('Avery Stone').id);
  await sn.waitForSelector('.apl-composer textarea', { timeout: 8000 }).catch(() => null);
  await sleep(400);
  await sn.focus('.apl-composer textarea');
  await sn.keyboard.type('Seen once sent');
  await sn.$eval('.apl-convo', el => { el.scrollTop = el.scrollHeight; });
  await clickText(sn, '.apl-composer-foot .btn-primary', /Send/);
  await sn.waitForFunction(() => !document.querySelector('.apl-composer textarea')?.value, { timeout: 8000 }).catch(() => null);
  await sleep(500);
  ok(await sn.$eval('.apl-convo', el => el.scrollTop === 0) && /Seen once sent/.test(await text(sn, '.apl-thread')), 'on a short screen, Send goes back up to what was sent');
  await sn.close();
  const ek = await open(1280, 600);
  await openFamily(ek, 'Avery Stone');
  await ek.focus('.apl-email-sum');
  await ek.keyboard.press('Enter');
  await sleep(200);
  ok(await ek.evaluate(() => !!document.activeElement?.closest('.apl-email-row')), 'Edit by keyboard lands in the To and Subject row');
  await ek.close();

  // On touch, a link inside a sentence leaves its lines even
  const it = await open(390, 844);
  await openFamily(it, 'Avery Stone');
  await sleep(200);
  await it.evaluate(() => [...document.querySelectorAll('.apl-msg-actions .apl-more')].find(b => /Reply/.test(b.textContent))?.click());
  await sleep(250);
  const inSentence = await it.$$eval('.apl-callout .apl-more', els => els.map(e => getComputedStyle(e).display));
  ok(inSentence.every(d => d === 'inline'), `links inside a sentence stay in line on touch (${inSentence.join()})`);
  await it.close();

  // The map keeps its popup through a refresh, and on a phone it's what you see
  const lp = await open(1440, 1000);
  await openFamily(lp, 'Eliza Franklin');
  await clickText(lp, '.apl-side .apl-more', /Show on map/);
  await lp.waitForSelector('.leaflet-popup-content', { timeout: 8000 }).catch(() => null);
  await lp.evaluate(() => window.dispatchEvent(new Event('soard-replies-changed')));
  await sleep(900);
  ok(/Eliza Franklin/.test(await text(lp, '.leaflet-popup-content')), 'an open popup stays through a refresh');
  // Moved away from it, the map stays where you put it
  const box = await (await lp.$('.apl-map')).boundingBox();
  await lp.mouse.move(box.x + box.width * .6, box.y + box.height * .7);
  await lp.mouse.down();
  await lp.mouse.move(box.x + box.width * .2, box.y + box.height * .2, { steps: 8 });
  await lp.mouse.up();
  const pane = () => lp.$eval('.leaflet-map-pane', el => el.style.transform);
  let panned = ''; // a drag's momentum runs on for a few seconds: this waits for the map to stop
  for (let i = 0; i < 40; i++) { const now = await pane(); if (now === panned) break; panned = now; await sleep(500); }
  await lp.evaluate(() => window.dispatchEvent(new Event('soard-replies-changed')));
  await sleep(900);
  ok(await pane() === panned, 'a refresh leaves the map where you moved it');
  // Zooming and leaving at once throws nothing (the last check on this page counts the console)
  await lp.click('.leaflet-control-zoom-in').catch(() => null);
  await lp.click('.apl-views [data-view="list"]');
  await sleep(500);
  await lp.close();
  const pm = await open(390, 844);
  await openFamily(pm, 'Eliza Franklin');
  await clickText(pm, '.apl-side .apl-more', /Show on map/);
  await pm.waitForSelector('.leaflet-popup-content', { timeout: 8000 }).catch(() => null);
  await sleep(300);
  ok(await pm.$eval('.apl-legend', el => getComputedStyle(el).display === 'none').catch(() => false), 'on a phone the legend makes way for the family’s name');
  await pm.close();
  const lm = await open(1440, 1000);
  await lm.setViewport({ width: 844, height: 390, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await lm.reload({ waitUntil: 'domcontentloaded' });
  await lm.waitForSelector('.apl-card, .apl-table', { timeout: 20000 }).catch(() => null);
  await lm.evaluate((id) => { location.hash = `#applications/applicants/${id}`; }, acct('Eliza Franklin').id);
  await lm.waitForSelector('.apl-side', { timeout: 8000 }).catch(() => null);
  await sleep(300);
  await clickText(lm, '.apl-side .apl-more', /Show on map/);
  await lm.waitForSelector('.leaflet-popup-content', { timeout: 8000 }).catch(() => null);
  await sleep(300);
  ok(await lm.$eval('.apl-map', el => { const r = el.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0 && r.height < innerHeight * .8; }).catch(() => false), 'on a phone on its side, Show on map brings the map on screen, with room to scroll past it');
  await lm.close();

  // A move or a pause under way keeps what was decided
  const mv = await open(1280, 900);
  const applied = Object.values(w.world.accounts).find(a => a.fields[F.status] === 'Applied' && (a.contacts || []).length && a.name !== 'Harper Lee');
  await openFamily(mv, applied.name);
  await mv.select('.apl-status-select select', 'In Review');
  await mv.waitForSelector('.apl-sheet-foot .btn-primary:not([disabled])', { timeout: 8000 }).catch(() => null);
  slowMoves = 1500;
  await mv.click('.apl-sheet-foot .btn-primary');
  await sleep(150);
  ok(await mv.$eval('.apl-check input', el => el.disabled).catch(() => false), 'the email can’t be unticked once the move is under way');
  await mv.waitForFunction(() => !document.querySelector('.apl-sheet'), { timeout: 8000 }).catch(() => null);
  await mv.select('.apl-status-select select', 'Denied');
  await mv.waitForSelector('.apl-sheet-foot .btn-primary:not([disabled])', { timeout: 8000 }).catch(() => null);
  await mv.click('.apl-sheet-foot .btn-primary');
  await sleep(150);
  ok(await mv.$eval('.apl-sheet textarea', el => el.readOnly).catch(() => false), 'the denial reason holds still once the move is under way');
  await mv.waitForFunction(() => !document.querySelector('.apl-sheet'), { timeout: 8000 }).catch(() => null);
  await shutDrawer(mv);
  await mv.click('.apl-more-btn');
  await sleep(150);
  await clickText(mv, '.apl-menu button', /Pause family emails/);
  await mv.waitForSelector('.apl-sheet', { timeout: 8000 }).catch(() => null);
  await sleep(150);
  await mv.click('.apl-sheet-foot .btn-primary');
  await sleep(150);
  const offPausing = await mv.$eval('.apl-sheet-foot .btn-ghost', el => el.disabled).catch(() => false);
  await mv.keyboard.press('Escape');
  await sleep(150);
  ok(offPausing && !!(await mv.$('.apl-sheet')), 'a pause under way can’t look cancelled');
  await mv.waitForFunction(() => !document.querySelector('.apl-sheet'), { timeout: 8000 }).catch(() => null);
  slowMoves = 0;
  await mv.evaluate(() => fetch('/api/applicants-admin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resume: true }) }));
  await mv.close();

  // A community project is not a family
  const sunny = acct('Sunnyside Academy');
  sunny.comments.push({ id: `${sunny.id}-r1`, name: 'RE: Hello', message: 'Thanks from all of us', by: 'Erin Pence', fromEmail: true, createdAt: new Date().toISOString() });
  const op = await open(1440, 1000);
  await openFamily(op, 'Sunnyside Academy');
  await sleep(200);
  const said = await text(op, '.apl-thread');
  ok(/Thanks from all of us/.test(said) && !/reply from the family/i.test(said), 'a community project’s reply isn’t called the family’s');
  await op.close();
}

// Every line of a change stays in the history, however many lines a note runs to
{
  const hp = await open(1440, 1000);
  const family = acct('Avery Stone');
  await hp.goto(`${SITE}/admin/__applicants.html#applications/applicants/${family.id}`, { waitUntil: 'domcontentloaded' });
  await hp.waitForSelector('.apl-kv button[aria-label="Edit Diagnosis"]', { timeout: 8000 });
  await sleep(400);
  await hp.click('.apl-kv button[aria-label="Edit Diagnosis"]');
  await hp.waitForSelector('.apl-kv textarea', { timeout: 8000 });
  await hp.$eval('.apl-kv textarea', el => el.select());
  await hp.keyboard.press('Backspace');
  await hp.keyboard.type('First line\nSecond line\nThird line\nFourth line\nFifth line');
  await hp.$eval('.apl-kv textarea', el => el.blur());
  await hp.waitForFunction(() => /Fifth line/.test(document.querySelector('.apl-thread')?.textContent || ''), { timeout: 8000 }).catch(() => null);
  const thread = await text(hp, '.apl-thread');
  ok(/Second line/.test(thread) && /Fourth line/.test(thread) && /Fifth line/.test(thread) && /Fifth line/.test(family.fields[F.diagnosis]), 'a detail of five lines shows all five in the history');
  await hp.close();
}

// A family leaving after you've moved on: the drawer stays with the family you're reading, and says who left
{
  const mp = await open(1440, 1000);
  await mp.evaluate(() => localStorage.setItem('apl-view', 'list'));
  await mp.reload({ waitUntil: 'domcontentloaded' });
  await mp.waitForSelector('.apl-table tbody tr', { timeout: 20000 });
  await sleep(300);
  await mp.evaluate(() => [...document.querySelectorAll('.apl-table tbody tr')].slice(0, -1).find(r => !/Sunnyside/.test(r.textContent)).click());
  await mp.waitForSelector('.apl-kv select[aria-label="Makeover year"]', { timeout: 8000 });
  await sleep(400);
  const leaver = await text(mp, '.apl-drawer h2');
  const gone = acct(leaver);
  delete gone.fields[F.status];
  await DB.prepare('UPDATE applicants SET status = NULL WHERE account_id = ?').bind(gone.id).run();
  slowQueue.push(1200);
  await mp.select('.apl-kv select[aria-label="Makeover year"]', '');
  await sleep(100);
  await mp.click('.apl-drawer button[aria-label="Next family (J)"]');
  await mp.waitForFunction((n) => { const t = document.querySelector('.apl-drawer h2')?.textContent; return t && t !== n; }, { timeout: 8000 }, leaver).catch(() => null);
  const reading = await text(mp, '.apl-drawer h2');
  const told = (n) => window.__toasts.some(t => t.msg.startsWith(`${n} has no status or year now`));
  await mp.waitForFunction(told, { timeout: 8000 }, leaver).catch(() => null);
  await sleep(500);
  ok(reading && reading !== leaver && await text(mp, '.apl-drawer h2') === reading && await mp.evaluate(told, leaver), `a family leaving after you've moved on keeps the drawer on the next family (${leaver} → ${reading})`);
  await mp.close();
}

ok(consoleErrors.length === 0, `no console errors${consoleErrors.length ? `: ${consoleErrors.slice(0, 3).join(' | ')}` : ''}`);
await browser.close();
server.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nAll applicants admin checks passed');
process.exit(failures.length ? 1 : 0);
