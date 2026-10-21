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
family({ name: 'Mateo García', status: 'Applied', parent: 'Lucía García', lat: 34.07, lng: -84.29, city: 'Alpharetta', county: 'Fulton', days: 25, lang: 'Spanish' });
family({ name: 'Harper Lee', status: 'Applied', parent: 'Dana Lee', lat: 33.749, lng: -84.388, city: 'Atlanta', county: 'Fulton', days: 2, types: ['Ramp'] });
family({ name: 'Noah Pence', status: 'In Review', parent: 'Erin Pence', lat: 34.24, lng: -84.49, city: 'Canton', county: 'Cherokee', days: 40, types: ['Therapy Room'] });
family({ name: 'Isla Example', status: 'In Review', parent: 'Kate Example', lat: 34.2367, lng: -84.4908, city: 'Canton', county: 'Cherokee', days: 60 });
family({ name: 'Colin Lindsay', status: 'Approved', parent: 'Meg Lindsay', lat: 33.99, lng: -84.45, city: 'Marietta', county: 'Cobb', days: 120, types: ['Bathroom'] });
family({ name: 'Elizabeth Francis', status: 'Approved', parent: 'Michele Francis', lat: 34.0987, lng: -84.4823, city: 'Woodstock', county: 'Cherokee', days: 200 });
family({ name: 'Everett Burke', status: 'Denied', parent: 'Sam Burke', lat: 33.94, lng: -84.51, city: 'Marietta', county: 'Cobb', days: 90 });
family({ name: 'Logan Logan', status: 'Denied', parent: 'Pat Logan', lat: 32.56, lng: -83.89, city: 'Fort Valley', county: 'Peach', days: 300, year: '2026' });
family({ name: 'Kendall Thomas', status: 'Approved', parent: 'Ash Thomas', lat: 34.06, lng: -84.67, city: 'Acworth', county: 'Cobb', days: 400, year: '2026' });
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

// ── A static server for public/, plus the harness page ──
const adminHtml = readFileSync(join(ROOT, 'public/admin/index.html'), 'utf8');
const adminStyles = [...adminHtml.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
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
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/admin/__applicants.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(harness); }
  const file = join(ROOT, 'public', path);
  if (file.startsWith(join(ROOT, 'public')) && existsSync(file) && statSync(file).isFile()) {
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    return res.end(readFileSync(file));
  }
  res.writeHead(404); res.end('not found');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${server.address().port}`;

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');
async function answer(req) {
  const url = new URL(req.url());
  if (url.host === 'cdn.fake') return req.respond({ status: 200, contentType: 'image/png', body: PNG });
  if (url.pathname === '/api/applicants-admin' || url.pathname === '/api/applications-admin') {
    clearFormCache();
    const request = new Request(`https://admin.test${url.pathname}${url.search}`, { method: req.method(), body: req.method() === 'POST' ? req.postData() : undefined, headers: { 'content-type': 'application/json' } });
    const ctx = { env, request, data: { userEmail: 'linzi@soardcharity.com' }, waitUntil: () => {} };
    const mod = url.pathname === '/api/applicants-admin' ? api : formsApi;
    const res = req.method() === 'POST' ? await mod.onRequestPost(ctx) : await mod.onRequestGet(ctx);
    return req.respond({ status: res.status, contentType: 'application/json', body: Buffer.from(await res.arrayBuffer()) });
  }
  return false;
}

const browser = await puppeteer.launch({ headless: true, args: ['--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
const consoleErrors = [];
async function open(width, height) {
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
  await page.goto(`${SITE}/admin/__applicants.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.apl-board, .apl-table, .apl-map, .apl-feed', { timeout: 20000 });
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
ok(await page.$eval('.apl-tag.is-out', el => getComputedStyle(el).backgroundColor) === 'rgb(255, 246, 224)', 'and flagged in amber, like every other warning (red is for destructive buttons)');
ok(await page.$$eval('.apl-tag.is-es', els => els.length >= 1 && els.every(e => e.textContent === 'Spanish')), 'a Spanish-speaking family is tagged "Spanish" (the same word Submissions uses)');
ok(await text(page, '.apl > .page-header h2') === 'Applicants', 'the tab has the admin’s page header');
const [vb, fbx] = await Promise.all([page.$eval('.apl-views', el => el.getBoundingClientRect().top), page.$eval('.apl-filters', el => el.getBoundingClientRect().top)]);
ok(Math.abs(vb - fbx) < 6, 'views, search and filters share one toolbar row');
ok(!(await page.$('button[title^="For cleaning up statuses"]')), 'the cleanup switch isn’t a button on its own row');
ok(!(await page.$$eval('.apl-head-actions button', els => els.some(b => /Sync now|Check JobTread now/.test(b.textContent)))) && /In sync with JobTread · checked/.test(await text(page, '.apl-sync')), 'all well: no sync button, just when JobTread was last checked');
ok(await page.$$eval('.apl-stage.is-long', els => els.length >= 1), 'families waiting long in a stage stand out');
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
ok(/jordan@example\.com/.test(await text(page, '.apl-sheet .apl-check')), 'the sheet names who gets it');
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

// Open Avery
await page.click('.apl-card[data-id="acct00000001"]');
await page.waitForSelector('.apl-drawer .apl-thread .apl-msg', { timeout: 8000 });
await sleep(450);
ok(/The In Review email to Jordan Stone goes out at/.test(await text(page, '.apl-thread-banner')), 'the family’s page says what’s about to be emailed');
await shot(page, 'desktop-family-pending');
await page.click('.apl-thread-banner .btn-primary'); // Send now
await page.waitForFunction(() => !document.querySelector('.apl-thread-banner'), { timeout: 8000 }).catch(() => null);
ok(acct('Avery Stone').comments.filter(c => c.name === 'Application In Review').length === 1, 'Send now posts the In Review message once');
ok(acct('Avery Stone').comments.find(c => c.name === 'Application In Review')?.grantKey === 'qc-grant', 'posted as the Qualification Committee');
ok(await page.$$eval('.apl-msg.is-text', els => els.length) === 2, 'texts show as text bubbles');
ok(await page.$$eval('.apl-msg.is-email', els => els.length) === 1, 'the family’s email reply shows');
ok(await page.$$eval('.apl-msg.is-internal', els => els.some(e => /Medical Condition/.test(e.textContent))), 'the medical note shows as staff only, not as an email');
await page.waitForFunction(() => [...document.querySelectorAll('.apl-event')].some(e => /Emailed the family: In Review/.test(e.textContent)), { timeout: 8000 }).catch(() => null);
ok(await page.$$eval('.apl-event', els => els.some(e => /Moved from Applied/.test(e.textContent))), 'the status change shows in the conversation');
ok(await page.$$eval('.apl-event', els => els.some(e => /Emailed the family: In Review/.test(e.textContent))), 'and so does the email going out');
ok(/Linzi/.test(await page.$$eval('.apl-event', els => els.map(e => e.textContent).join(' '))), 'with who did it');
await shot(page, 'desktop-family');
// Email the family
await page.type('.apl-composer textarea', 'Hi Jordan, could we visit on Tuesday at 3?');
await page.click('.apl-composer .btn-primary');
await page.waitForFunction(() => !document.querySelector('.apl-composer textarea').value, { timeout: 8000 }).catch(() => null);
const emailed = acct('Avery Stone').comments.find(c => /visit on Tuesday/.test(c.message));
ok(emailed?.assignees?.[0]?.emailAddress === 'jordan@example.com', 'Email family: a JobTread comment assigned to the parent (JobTread emails it)');
// No texting from the site (families text SOARD's Quo number): just email and notes
ok(await page.$$eval('.apl-modes button', els => els.map(e => e.textContent.trim()).join('|')) === 'Email family|Internal note', 'the composer offers email and an internal note, no texting');
// Note (⌘+Enter sends)
await page.click('.apl-modes button:nth-child(2)');
await page.type('.apl-composer textarea', 'Mom prefers texts after 3pm.');
await page.keyboard.down('Meta'); await page.keyboard.press('Enter'); await page.keyboard.up('Meta');
await page.waitForFunction(() => !document.querySelector('.apl-composer textarea').value, { timeout: 8000 });
ok(acct('Avery Stone').comments.some(c => /^Mom prefers texts/.test(c.message) && c.internal), 'Internal note posted, staff only');
await page.waitForFunction(() => [...document.querySelectorAll('.apl-msg.is-note')].some(e => /Mom prefers texts/.test(e.textContent)), { timeout: 8000 }).catch(() => null);
ok(await page.$$eval('.apl-msg.is-note', els => els.some(e => /Mom prefers texts/.test(e.textContent) && !/from the website_/.test(e.textContent))), 'the note shows in the thread (signature tucked away)');
// Edit details in place
const typesBtn = await page.$$('.apl-type-picks button');
await typesBtn[3].click(); // Ramp
await page.waitForFunction(() => [...document.querySelectorAll('.apl-type-picks button')].find(b => /Ramp/.test(b.textContent))?.getAttribute('aria-pressed') === 'true', { timeout: 8000 }).catch(() => null);
ok(JSON.stringify(acct('Avery Stone').fields[F.types]) === JSON.stringify(['Bedroom', 'Bathroom', 'Ramp']), 'Makeover type edited in place, saved to JobTread as a list');
const dxBtn = await page.$('.apl-kv button.apl-edit');
await dxBtn.click();
const input = await page.$('.apl-kv input.form-input, .apl-kv textarea.form-input');
await input.click({ clickCount: 3 });
await page.keyboard.type('2016-05-20');
await page.keyboard.press('Enter');
await sleep(600);
ok(acct('Avery Stone').fields[F.birthday] === '2016-05-20' || /2016/.test(JSON.stringify(acct('Avery Stone').fields)), 'a text/date detail edits in place');
await shot(page, 'desktop-family-after');
// Keyboard: next family, then close
await page.keyboard.press('j');
await sleep(500);
ok(!/Avery Stone/.test(await text(page, '.apl-dtitle h2')), 'J moves to the next family');
await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.querySelector('.apl-drawer'), { timeout: 4000 }).catch(() => null);
ok(!(await page.$('.apl-drawer')), 'Esc closes the family');

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
await page.click('.apl-views button:nth-child(2)');
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
await shot(page, 'desktop-list-filtered');
await page.evaluate(() => [...document.querySelectorAll('.apl-active button')].find(b => /Outside the boundary/.test(b.textContent))?.click());
await sleep(200);
ok(!(await page.$$eval('.apl-active button', els => els.some(e => /Outside the boundary/.test(e.textContent)))), 'a filter chip clears its filter');
await shot(page, 'desktop-list');

// Map
await page.click('.apl-views button:nth-child(3)');
await page.waitForSelector('.leaflet-container', { timeout: 15000 });
await sleep(1500);
ok(await page.$$eval('.apl-pin', els => els.length) >= 9, 'every family with a home has a pin');
ok(await page.$$eval('path.leaflet-interactive, svg path', els => els.some(e => (e.getAttribute('stroke') || '').toLowerCase() === '#d92d20')), 'the service-area boundary is drawn in red');
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
const before = JSON.stringify((await getLiveForm(DB, { fresh: true })).definition.serviceArea.polygon);
await page.click('.apl-map-note .btn-primary'); // Save boundary
await page.waitForFunction(() => !document.querySelector('.apl-map-note'), { timeout: 8000 }).catch(() => null);
clearFormCache();
const after = (await getLiveForm(DB, { fresh: true })).definition.serviceArea.polygon;
ok(after?.length >= 3 && JSON.stringify(after) !== before, 'Save boundary puts the new boundary in use straight away');
ok(!(await getDraftForm(DB)), 'with no form draft and no Put live');
ok(await page.evaluate(() => window.__toasts.some(t => /new boundary is in use/.test(t.msg))), 'and says so');

// Activity
await page.click('.apl-views button:nth-child(4)');
await page.waitForSelector('.apl-feed-row', { timeout: 8000 });
ok(await page.$$eval('.apl-feed-row', els => els.length) >= 5, 'Activity lists what happened across families');
await shot(page, 'desktop-activity');
// JobTread trouble: coming back to the tab catches up; a failure shows, with one way to act
w.failNext.set('organization', 1);
await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await page.waitForFunction(() => /Check JobTread now/.test(document.querySelector('.apl-head-actions')?.innerText || ''), { timeout: 8000 }).catch(() => null);
ok(/JobTread didn't answer/.test(await text(page, '.apl-sync')) && !!(await page.$('.apl-sync .apl-dot.is-stale')), 'a failed check says so in the header, in amber');
ok(await clickText(page, '.apl-head-actions button', /Check JobTread now/), 'with Check JobTread now');
await page.waitForFunction(() => !/Check JobTread now/.test(document.querySelector('.apl-head-actions')?.innerText || ''), { timeout: 8000 }).catch(() => null);
ok(/In sync with JobTread/.test(await text(page, '.apl-sync')), 'once JobTread answers, the problem clears');

// Pause family emails: the sheet, a held move, then choosing family by family
await page.click('.apl-views button:nth-child(1)');
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
await page.close();

console.log('Phone 390');
const phone = await open(390, 844);
await phone.evaluate(() => localStorage.setItem('apl-view', 'board'));
await phone.reload({ waitUntil: 'domcontentloaded' });
await phone.waitForSelector('.apl-board');
await sleep(400);
ok(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'phone: the page itself never scrolls sideways (the board scrolls inside)');
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
await shot(phone, 'phone-family');
await phone.click('.apl-dtabs button:nth-child(2)');
await sleep(200);
ok(await phone.evaluate(() => !!document.querySelector('.apl-side')?.offsetParent && !document.querySelector('.apl-convo')?.offsetParent), 'phone: Details shows the details instead');
await shot(phone, 'phone-family-details');
await phone.keyboard.press('Escape');
await phone.click('.apl-views button:nth-child(3)');
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

ok(consoleErrors.length === 0, `no console errors${consoleErrors.length ? `: ${consoleErrors.slice(0, 3).join(' | ')}` : ''}`);
await browser.close();
server.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nAll applicants admin checks passed');
process.exit(failures.length ? 1 : 0);
