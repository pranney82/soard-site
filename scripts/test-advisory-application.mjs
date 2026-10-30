/**
 * test-advisory-application.mjs — the Advisory Board application, in a browser
 * ===============================================================================
 * Admin → People → Applications (public/admin/advisory-applications.js), in
 * the real admin shell (the 240px sidebar) at 1440 and 390, on the REAL
 * handler (functions/api/advisory-applications-admin.js) over an in-memory D1:
 *   - the list: status counts that filter, search, the Jotform ones tagged and
 *     the one already on People → Advisory marked Joined
 *   - one application: contact links, answers by step, a Yes on conflicts
 *     flagged, status, a note, Add as an advisor (a hidden draft through the
 *     admin's api, their private email saved, Joined), delete
 *   - who hears about new applications, a link straight to one, the phone,
 *     and an axe scan
 * With DIST=<an astro build folder> (npx astro build --outDir <dir>, then
 * node scripts/csp-hash.mjs <dir>) it also drives /advisory-board/apply/ on the
 * REAL public handler: the overview, the application on its own screen a screen
 * at a time, follow-ups, saving on the device, the review and Edit, sending, and
 * the Advisory Board page's Apply buttons.
 *
 *   node scripts/test-advisory-application.mjs
 *   DIST=/tmp/soard-build node scripts/test-advisory-application.mjs
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import * as adminApi from '../functions/api/advisory-applications-admin.js';
import * as publicApi from '../functions/api/advisory-apply.js';
import { submitApplication, listAdvisoryApplications, getAdvisoryApplication } from '../functions/api/_advisory-applications.js';
import { axeScan, axeText } from './lib/axe.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/advisory-application/');
mkdirSync(OUT, { recursive: true });
const DIST = process.env.DIST ? `${process.env.DIST.replace(/\/$/, '')}/` : null;
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Emails and Slack are captured, never sent
const sent = { emails: [], slack: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.host === 'api.resend.com') { const b = JSON.parse(init.body); sent.emails.push(...b); return Response.json({ data: b.map((_, i) => ({ id: `e${i}` })) }); }
  if (url.host === 'hooks.slack.test') { sent.slack.push(JSON.parse(init.body)); return new Response('ok'); }
  return realFetch(input, init);
};

// ── D1: two site applications, two from Jotform (one already an advisor) ──
const DB = await createD1();
const env = { DB, RESEND_API_KEY: 'r', SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' };
const base = {
  email: 'jordan@example.org', phone: '(770) 555-0142', address: '12 Maple Dr\nMarietta, GA 30062', heardFrom: 'A friend on the board',
  why: 'I have watched what a room can do for a child, and I want to help build more of them.', connection: 'My nephew uses a wheelchair.',
  involved: 'No', strengths: 'Corporate partnerships and event planning.', fundraising: 'An employer match and a golf foursome.', introductions: 'Yes',
  networks: 'Maybe', conflict: 'No', hostEvent: 'Maybe', meetings: 'Yes', ambassador: 'Yes', refName: 'Sam Lee', refRelationship: 'Former manager',
  refEmail: 'sam@example.org', acknowledge: true,
};
const jordan = (await submitApplication(env, { ...base, fullName: 'Jordan Avery', preferredName: 'Jo', company: 'Peachtree Builders', jobTitle: 'Director of Partnerships', link: 'linkedin.com/in/jordan-avery', signature: 'Jordan Avery' }, { now: Date.now() - 3 * 86400000 })).app;
const morgan = (await submitApplication(env, { ...base, fullName: 'Morgan Ellis', email: 'morgan@example.org', company: 'Ellis Supply', jobTitle: 'Owner', conflict: 'Yes', conflictMore: 'We sell flooring to SOARD’s builders.', meetings: 'No', signature: 'Morgan Ellis' }, { now: Date.now() - 86400000 })).app;
await DB.exec('CREATE TABLE jotform_backfill (submission_id TEXT PRIMARY KEY, form_id TEXT, kind TEXT, name TEXT, submitted_at TEXT, answers TEXT)');
await DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, data TEXT)');
await DB.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)');
await DB.prepare('INSERT INTO team (slug, data) VALUES (?, ?)').bind('casey-reed', JSON.stringify({ name: 'Casey Reed', group: 'advisory', publishStatus: 'published' })).run();
// The board member who leads the Advisory Board committee (People → Board), with a private email
await DB.prepare('INSERT INTO team (slug, data) VALUES (?, ?)').bind('lee-lead', JSON.stringify({ name: 'Lee Lead', group: 'board', committees: ['Advisory Board'] })).run();
await DB.exec('CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)');
await DB.prepare("INSERT INTO reveal_board_emails VALUES ('lee-lead', 'lee@example.org', null)").run();
const jf = (first, last) => JSON.stringify({ createdAt: '2026-07-08 14:20:00', answers: {
  3: { type: 'control_fullname', text: 'Full Name', answer: { first, last } },
  5: { type: 'control_email', text: 'Email Address', answer: `${first.toLowerCase()}@example.org` },
  9: { type: 'control_textbox', text: 'Employer / Company', answer: 'Acme Co' },
  12: { type: 'control_textarea', text: 'Why are you interested in serving on the Sunshine on a Ranney Day Advisory Board?', answer: 'To give back.' },
} });
await DB.batch([
  DB.prepare("INSERT INTO jotform_backfill VALUES ('6261000000000000001', '261805783731058', 'advisory', 'Casey Reed', '2026-07-08 14:20:00', ?)").bind(jf('Casey', 'Reed')),
  DB.prepare("INSERT INTO jotform_backfill VALUES ('6261000000000000002', '261805783731058', 'advisory', 'Riley Stone', '2026-07-09 09:00:00', ?)").bind(jf('Riley', 'Stone')),
]);

// ── The admin shell around the module, with the admin's kit faked ──
const adminHtml = readFileSync(join(ROOT, 'public/admin/index.html'), 'utf8');
// The admin's own <style> blocks (a print template inside a script has one too: skip anything after the first <script)
const adminStyles = [...adminHtml.slice(0, adminHtml.indexOf('<script')).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
const harness = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Applications harness</title><style>${adminStyles}</style></head>
<body><div class="app"><aside class="sidebar"></aside><div class="main"><div class="hub-tabs"><button class="hub-tab">Advisory</button><button class="hub-tab active">Applications</button></div><div id="root"></div></div></div>
<div id="toasts" class="toast-container" style="position:fixed;bottom:16px;right:16px;z-index:1000;display:grid;gap:6px"></div>
<script type="module">
import { h, render } from './vendor.js';
import { AdvisoryApplications } from './advisory-applications.js';
window.__toasts = []; window.__saved = []; window.__opened = [];
const addToast = (msg, kind) => { window.__toasts.push({ msg, kind }); };
const team = [{ slug: 'casey-reed', name: 'Casey Reed', group: 'advisory', order: 0 }];
const kit = {
  team,
  api: { saveContent: async (path, content, message) => { window.__saved.push({ path, record: JSON.parse(content), message }); return { success: true }; } },
  toPersonRecord: (d) => ({ ...d }),
  onOpenPerson: (slug) => window.__opened.push(slug),
  onTeamChanged: () => {},
};
render(h(AdvisoryApplications, { addToast, kit }), document.getElementById('root'));
</script></body></html>`;
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon' };
const server = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/admin/__advisory.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(harness); }
  const rootDir = path.startsWith('/admin/') || !DIST ? join(ROOT, 'public') : DIST;
  if (path.endsWith('/')) path += 'index.html';
  const file = join(rootDir, path);
  if (file.startsWith(rootDir) && existsSync(file) && statSync(file).isFile()) {
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    return res.end(readFileSync(file));
  }
  res.writeHead(404); res.end('not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${server.address().port}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');
const revealEmails = [];

async function answer(req, ip) {
  const url = new URL(req.url());
  const run = async (mod) => {
    const request = new Request(`https://site.test${url.pathname}${url.search}`, { method: req.method(), body: req.method() === 'POST' ? req.postData() : undefined, headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip } });
    const waits = [];
    const ctx = { env, request, data: { userEmail: 'linzi@soardcharity.com' }, waitUntil: (p) => waits.push(p) };
    const res = req.method() === 'POST' ? await mod.onRequestPost(ctx) : await mod.onRequestGet(ctx);
    await Promise.all(waits);
    return req.respond({ status: res.status, contentType: 'application/json', body: Buffer.from(await res.arrayBuffer()) });
  };
  if (url.pathname === '/api/advisory-applications-admin') return run(adminApi);
  if (url.pathname === '/api/advisory-apply') return run(publicApi);
  if (url.pathname === '/api/reveal-invites-admin') { revealEmails.push(JSON.parse(req.postData()).boardEmail); return req.respond({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); }
  if (url.hostname !== '127.0.0.1') return req.respond({ status: 200, contentType: 'image/png', body: PNG });
  return false;
}

// 'shell': screenshots keep working while the Mac's display sleeps
const browser = await puppeteer.launch({ headless: 'shell', args: ['--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
const errors = [];
async function open(width, path, height = 900) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 2, isMobile: width < 500, hasTouch: width < 500 });
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    try { if (await answer(req, `198.51.100.${width % 250}`) === false) req.continue(); } catch (e) { console.error(e); req.respond({ status: 500, body: '{}' }); }
  });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|live-ws/.test(m.text())) errors.push(m.text()); });
  await page.goto(`${SITE}${path}`, { waitUntil: 'networkidle0' });
  return page;
}
const text = (page, sel) => page.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
const visible = (page, sel) => page.$eval(sel, (el) => !!el.offsetParent).catch(() => false);
const clickText = (page, sel, re) => page.evaluate((s, src) => { const el = [...document.querySelectorAll(s)].find((x) => new RegExp(src).test(x.textContent)); if (el) { el.click(); return true; } return false; }, sel, re.source);
const sideways = (page) => page.evaluate(() => {
  const main = document.querySelector('.main');
  const right = main ? main.getBoundingClientRect().right - parseFloat(getComputedStyle(main).paddingRight) + 1 : innerWidth;
  return document.documentElement.scrollWidth > innerWidth + 1
    || [...document.querySelectorAll('.ava *')].some((el) => el.getBoundingClientRect().width && el.getBoundingClientRect().right > right && !el.closest('.ava-drawer'));
});

console.log('Admin → People → Applications, 1440');
const page = await open(1440, '/admin/__advisory.html');
await page.waitForSelector('.ava-row', { timeout: 15000 });
ok((await page.$$('.ava-row')).length === 4, 'all four applications: two from the site, two from Jotform');
ok(await page.evaluate(() => window.__toasts.some((t) => /2 applications from the old form are here now/.test(t.msg))), 'the earlier applications came in, and it says so once');
const strip = await page.$$eval('.ava-strip button', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
ok(JSON.stringify(strip) === JSON.stringify(['All 4', 'New 3', 'In conversation 0', 'Joined 1', 'Not now 0']), `status counts ${JSON.stringify(strip)}`);
ok(/Casey Reed/.test(await page.$$eval('.ava-row', (els) => els.find((e) => /Joined/.test(e.textContent))?.textContent || '')), 'the Jotform applicant already on People → Advisory is Joined');
ok(await page.$$eval('.ava-tag', (els) => els.filter((e) => e.textContent === 'Earlier form').length) === 2, 'the ones sent before the website form are tagged');
ok(await page.$$eval('.ava-row.is-new', (els) => els.length) === 3, 'new ones stand out');
ok(/Jordan Avery \(Jo\)/.test(await text(page, '.ava-list')), 'a preferred name shows beside the full one');
await clickText(page, '.ava-strip button', /^Joined/); await sleep(150);
ok((await page.$$('.ava-row')).length === 1, 'a status filters the list');
await clickText(page, '.ava-strip button', /^All/);
await page.type('.ava-search input', 'ellis'); await sleep(150);
ok((await page.$$('.ava-row')).length === 1 && /Morgan Ellis/.test(await text(page, '.ava-list')), 'search finds by company');
await page.$eval('.ava-search input', (el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(150);
ok(!(await sideways(page)), 'nothing past the edge');
await page.screenshot({ path: join(OUT, 'admin-list-1440.png') });

// Morgan: a Yes on conflicts and a No on meetings are flagged
await clickText(page, '.ava-row', /Morgan Ellis/);
await page.waitForSelector('.ava-drawer .ava-qa', { timeout: 8000 });
ok(await page.$$eval('.ava-a.is-flag', (els) => els.map((e) => e.textContent)).then((t) => t.includes('Yes') && t.includes('No')), 'a Yes on conflicts and a No on four meetings stand out');
ok(await page.$eval('.ava-contact a[href^="mailto:"]', (el) => el.getAttribute('href')) === 'mailto:morgan@example.org', 'email is a link');
ok(await page.$eval('.ava-contact a[href^="tel:"]', (el) => el.getAttribute('href')) === 'tel:7705550142', 'and so is the phone');
await page.keyboard.press('Escape'); await sleep(250);
ok(!(await page.$('.ava-drawer')), 'Escape closes it');

// Jordan: status, a note, Add as an advisor
await clickText(page, '.ava-row', /Jordan Avery/);
await page.waitForSelector('.ava-drawer .ava-qa', { timeout: 8000 });
ok(/Peachtree Builders/.test(await text(page, '.ava-dhead')), 'the panel heads with their work');
ok((await page.$$eval('.ava-panel h3', (els) => els.map((e) => e.textContent))).join('|').startsWith('Where it stands|How to reach them|Your interest|Strengths'.replace('Strengths', 'What you’d bring')), 'contact first, then the answers by step');
await clickText(page, '.ava-status button', /In conversation/);
await page.waitForFunction(() => document.querySelector('.ava-status button[aria-pressed="true"]')?.textContent.includes('In conversation'), { timeout: 5000 }).catch(() => null);
ok((await getAdvisoryApplication(DB, jordan.id)).status === 'talking', 'status saved');
ok(/In conversation/.test(await page.$$eval('.ava-row', (els) => els.find((e) => /Jordan/.test(e.textContent))?.textContent || '')), 'and the list behind shows it');
await page.type('#ava-note', 'Called Monday. Coffee next week.');
await clickText(page, '.ava-note-form button', /Add note/);
await page.waitForFunction(() => /Coffee next week/.test(document.querySelector('.ava-notes')?.textContent || ''), { timeout: 5000 }).catch(() => null);
ok((await getAdvisoryApplication(DB, jordan.id)).notes[0]?.by === 'linzi@soardcharity.com', 'a note, with who wrote it');
await page.screenshot({ path: join(OUT, 'admin-drawer-1440.png') });
await clickText(page, '.ava-drawer button', /^Add as an advisor$/);
await page.waitForSelector('.ava-dialog', { timeout: 4000 });
ok(/hidden draft/.test(await text(page, '.ava-dialog')) && /jordan@example\.org/.test(await text(page, '.ava-dialog')), 'it says what Add does first');
await page.screenshot({ path: join(OUT, 'admin-add-1440.png') });
await clickText(page, '.ava-dialog button', /^Add them$/);
await page.waitForFunction(() => !document.querySelector('.ava-dialog'), { timeout: 6000 }).catch(() => null);
const saved = await page.evaluate(() => window.__saved);
ok(saved.length === 1 && saved[0].path === 'src/content/team/jordan-avery.json', 'a People record through the admin’s own save');
const rec = saved[0]?.record || {};
ok(rec.group === 'advisory' && rec.publishStatus === 'draft' && rec.title === 'Advisory Board Member' && rec.organization === 'Peachtree Builders' && rec.linkedin === 'https://www.linkedin.com/in/jordan-avery' && rec.order === 1,
  `a hidden advisor, with their company and LinkedIn (${JSON.stringify(rec)})`);
ok(revealEmails.some((e) => e.slug === 'jordan-avery' && e.email === 'jordan@example.org'), 'their email kept private for reveal invites');
ok((await getAdvisoryApplication(DB, jordan.id)).status === 'joined', 'and the application is Joined');
ok(await visible(page, '.ava-callout.is-good'), 'the panel says they’re on People → Advisory');
await clickText(page, '.ava-callout button', /Open their page/);
ok((await page.evaluate(() => window.__opened)).includes('jordan-avery'), 'with a way to their page');
await page.keyboard.press('Escape'); await sleep(200);

// Who hears about new applications
await clickText(page, '.ava-head button', /Who hears about them/);
await page.waitForSelector('#ava-staff');
ok(/On it now: Lee Lead\./.test(await text(page, '.ava-dialog')), 'the committee shows who’s on it now');
await page.screenshot({ path: join(OUT, 'admin-who-hears-1440.png') });
await page.$eval('#ava-staff', (el) => { el.value = 'peter@example.org\nnope'; el.dispatchEvent(new Event('input', { bubbles: true })); });
await clickText(page, '.ava-dialog button', /^Save$/); await sleep(300);
ok(/nope isn’t an email address/.test(await text(page, '.ava-dialog')), 'a bad address is named');
await page.$eval('#ava-staff', (el) => { el.value = 'peter@example.org\nlinzi@example.org'; el.dispatchEvent(new Event('input', { bubbles: true })); });
await clickText(page, '.ava-dialog button', /^Save$/);
await page.waitForFunction(() => !document.querySelector('.ava-dialog'), { timeout: 5000 }).catch(() => null);
ok(/peter@example\.org, linzi@example\.org and the Advisory Board committee \(Lee Lead\) hear about each one/.test(await text(page, '.ava-head')), `saved, and the header says who hears (${await text(page, '.ava-head p')})`);

// Delete Riley's (a person asked)
await clickText(page, '.ava-row', /Riley Stone/);
await page.waitForSelector('.ava-drawer .ava-foot');
await clickText(page, '.ava-foot button', /Delete application/);
await page.waitForSelector('.ava-dialog');
await clickText(page, '.ava-dialog button', /^Delete application$/);
await page.waitForFunction(() => !document.querySelector('.ava-drawer'), { timeout: 5000 }).catch(() => null);
ok(!(await listAdvisoryApplications(DB)).some((a) => a.name === 'Riley Stone') && (await page.$$('.ava-row')).length === 3, 'deleted from the site, and from the list');
const av = await axeScan(page, '.ava');
ok(!av.length, `axe: the list has no WCAG 2.1 AA problems${av.length ? ` (${axeText(av)})` : ''}`);
await page.close();

console.log('A link straight to one (the staff email’s), on a phone');
const phone = await open(390, `/admin/__advisory.html#advisory-applications/${morgan.id}`, 844);
await phone.waitForSelector('.ava-drawer .ava-qa', { timeout: 8000 });
ok(/Morgan Ellis/.test(await text(phone, '.ava-dhead h2')), 'the link opens that application');
ok(Math.abs((await phone.$eval('.ava-drawer', (el) => el.getBoundingClientRect().width)) - 390) < 2, 'it fills the phone');
const small = await phone.evaluate(() => [...document.querySelectorAll('.ava-drawer button')].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 38).map((b) => b.textContent.trim().slice(0, 20)));
ok(!small.length, `buttons are big enough to tap${small.length ? ` (${small.join(', ')})` : ''}`);
const dv = await axeScan(phone, '.ava-drawer');
ok(!dv.length, `axe: the panel has no WCAG 2.1 AA problems${dv.length ? ` (${axeText(dv)})` : ''}`);
await phone.screenshot({ path: join(OUT, 'admin-drawer-390.png') });
await phone.keyboard.press('Escape'); await sleep(250);
ok(!(await sideways(phone)), 'phone: nothing past the edge');
await phone.screenshot({ path: join(OUT, 'admin-list-390.png') });
await phone.close();

if (DIST) {
  for (const width of [1440, 390]) {
    console.log(`The Apply page, ${width}`);
    const p = await open(width, '/advisory-board/apply/');
    await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await p.reload({ waitUntil: 'networkidle0' });
    const next = async () => { await p.click('#adv-next'); await sleep(450); };
    /** A step comes a screen at a time: Continue until the one with this question shows (as people do) */
    const reach = async (sel) => {
      for (let i = 0; i < 8; i++) {
        const where = await p.evaluate((x) => { const el = document.querySelector(x); return !el ? 'none' : el.closest('[data-off]') ? 'later' : 'here'; }, sel);
        if (where !== 'later') return;
        const was = `${await text(p, '#adv-title')}|${await text(p, '#adv-part')}`;
        await next();
        if (`${await text(p, '#adv-title')}|${await text(p, '#adv-part')}` === was) throw new Error(`Continue was held up on the way to ${sel}`);
      }
    };
    const onTo = async (title) => { for (let i = 0; i < 8 && (await text(p, '#adv-title')) !== title; i++) await next(); };
    const type = async (id, v) => { await reach(`#adv-${id}`); await p.click(`#adv-${id}`, { clickCount: 3 }); await p.type(`#adv-${id}`, v); };
    const choose = async (name, v) => { await reach(`[data-field="${name}"]`); await p.evaluate((n, val) => document.querySelector(`input[name="${n}"][value="${val}"]`).click(), name, v); };
    ok(!(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), 'nothing scrolls sideways');
    const hub = await p.$$eval('.adv-hub-row', (els) => els.map((b) => ({ name: b.querySelector('strong').textContent, meta: b.querySelector('.adv-hub-meta').textContent, disabled: b.disabled })));
    ok(hub.map((r) => r.name).join() === 'About you,Your interest,What you’d bring,Commitment,Reference and signature,Review and send', `the overview: the five steps and the review (${hub.map((r) => r.name).join(', ')})`);
    ok(hub.slice(0, 5).every((r) => /^\d+ min$/.test(r.meta)) && !hub[0].disabled && hub.slice(1).every((r) => r.disabled), 'each with its minutes, only the first open before starting');
    const a0 = await axeScan(p, '#application');
    ok(!a0.length, `axe: the overview has no WCAG 2.1 AA problems${a0.length ? ` (${axeText(a0)})` : ''}`);
    await p.click('#adv-go');
    await sleep(400);
    const focus = await p.evaluate(() => ({ on: document.documentElement.classList.contains('adv-focus'), header: !!document.querySelector('#site-header')?.getClientRects().length, segs: document.querySelectorAll('.adv-seg').length, tab: document.title }));
    ok(focus.on && !focus.header && focus.segs === 6, 'Start: the application has the screen to itself, a segment per step');
    ok(/^Step 1 of 6: About you · /.test(focus.tab), `the tab says the step (${focus.tab})`);
    const a1 = await axeScan(p, '#application');
    ok(!a1.length, `axe: the first step has no WCAG 2.1 AA problems${a1.length ? ` (${axeText(a1)})` : ''}`);
    await next();
    const bad = await p.$$eval('.adv-page[data-step="0"] .adv-field.is-invalid', (els) => els.map((e) => e.dataset.field));
    ok(bad[0] === 'fullName' && bad.every((f) => ['fullName', 'email', 'phone'].includes(f)), `an empty screen marks what’s needed (${bad.join(', ')})`);
    const a2 = await axeScan(p, '#application');
    ok(!a2.length, `axe: with its problems showing too${a2.length ? ` (${axeText(a2)})` : ''}`);
    ok(await p.evaluate(() => document.activeElement?.id) === 'adv-fullName', 'focus on the first');
    await type('fullName', 'Taylor Brooks'); await type('email', `taylor${width}@example.org`); await type('phone', '404 555 0199');
    ok(await p.evaluate(() => document.querySelector('[data-field="email"]').parentElement.matches('.adv-pair')), 'email and phone share a row where there is room');
    await type('company', 'Brooks Law');
    await onTo('Your interest');
    ok(await p.evaluate(() => document.activeElement?.tagName) === 'H2', 'each step starts at its heading');
    await type('heardFrom', 'LinkedIn'); await type('why', 'To help.'); await type('connection', 'Neighbors.');
    ok(!(await visible(p, '[data-field="involvedHow"]')), 'a follow-up waits');
    await choose('involved', 'Yes'); await sleep(80);
    ok(await visible(p, '[data-field="involvedHow"]'), 'and shows after a Yes, on the same screen');
    await type('involvedHow', 'Golf tournament.');
    await sleep(500);
    await p.reload({ waitUntil: 'networkidle0' });
    await sleep(300);
    ok(await p.evaluate(() => document.documentElement.classList.contains('adv-focus')) && (await text(p, '#adv-title')) === 'Your interest' && await p.$eval('#adv-why', (el) => el.value) === 'To help.', 'a reload comes back to the same step, answers kept');
    await onTo('What you’d bring');
    await type('strengths', 'Law.'); await type('fundraising', 'A table at the gala.'); await choose('introductions', 'Yes'); await choose('networks', 'No'); await choose('conflict', 'No');
    await onTo('Commitment');
    await choose('hostEvent', 'Yes'); await choose('meetings', 'Yes'); await choose('ambassador', 'Yes');
    await onTo('Reference and signature');
    await type('refName', 'Pat Kim'); await type('refRelationship', 'Colleague'); await type('refEmail', 'pat@example.org');
    await reach('#adv-acknowledge'); await p.click('#adv-acknowledge'); await type('signature', 'Taylor Brooks');
    ok(/Review my answers/.test(await text(p, '#adv-next')), 'the last step goes to a review');
    await next();
    ok((await text(p, '#adv-title')) === 'Review and send' && /Send my application/.test(await text(p, '#adv-next')), 'the review sends');
    const rows = await p.$$eval('.adv-review-section', (els) => els.map((e) => ({ open: e.hasAttribute('data-open'), sum: e.querySelector('.adv-review-sum').textContent })));
    ok(rows.length === 5 && rows.every((r) => !r.open) && /Taylor Brooks/.test(rows[0].sum), `a row per step with its answers in a line (${rows[0]?.sum})`);
    const a4 = await axeScan(p, '#application');
    ok(!a4.length, `axe: the review has no problems${a4.length ? ` (${axeText(a4)})` : ''}`);
    await p.click('.adv-review-section[data-step="1"] .adv-linkbtn[data-edit]');
    await sleep(450);
    ok((await text(p, '#adv-title')) === 'Your interest' && /Back to review/.test(await text(p, '#adv-next')), 'Edit goes to the step, and Continue comes back to review');
    await next();
    ok((await text(p, '#adv-title')) === 'Review and send', 'back to review');
    await sleep(500);
    // A test fills it in seconds: say they took their time (the server drops anything faster than a person)
    await p.evaluate(() => { const k = 'soard-advisory-application'; const s = JSON.parse(localStorage.getItem(k)); s.startedAt = Date.now() - 900000; localStorage.setItem(k, JSON.stringify(s)); });
    await p.reload({ waitUntil: 'networkidle0' });
    await sleep(300);
    await p.click('#adv-next');
    await p.waitForSelector('#adv-done:not([hidden])', { timeout: 8000 }).catch(() => null);
    ok(/Thank you, Taylor\./.test(await text(p, '#adv-done h2')), 'sent: thanks by name');
    const a5 = await axeScan(p, '#application');
    ok(!a5.length, `axe: the thank-you has no problems${a5.length ? ` (${axeText(a5)})` : ''}`);
    ok(await p.evaluate(() => localStorage.getItem('soard-advisory-application')) === null, 'the device forgets the answers');
    ok((await listAdvisoryApplications(DB)).some((a) => a.email === `taylor${width}@example.org`), 'stored, for the admin');
    await p.screenshot({ path: join(OUT, `apply-done-${width}.png`) });
    await p.close();
  }
  const copies = sent.emails.filter((e) => e.subject === 'We have your Advisory Board application' && /Taylor/.test(e.html));
  const staff = sent.emails.filter((e) => e.subject === 'New Advisory Board application: Taylor Brooks');
  ok(copies.length === 2 && staff.length === 6 && staff.every((e) => /^(peter|linzi|lee)@example\.org$/.test(e.to[0])) && sent.slack.length === 2,
    `each one: the applicant’s copy, the staff email to the two saved above and the committee’s Lee Lead, and Slack (${copies.length}, ${staff.length}, ${sent.slack.length})`);
  const ab = await open(1440, '/advisory-board/');
  const links = await ab.$$eval('a', (els) => els.filter((a) => /Apply to Join/.test(a.textContent)).map((a) => [a.getAttribute('href'), a.target]));
  ok(links.length === 3 && links.every(([h, t]) => h === '/advisory-board/apply/' && !t), 'the Advisory Board page’s three Apply buttons go to the new page, same tab');
  await ab.close();
} else {
  console.log('(DIST not set: the Apply page checks are skipped)');
}

ok(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
await browser.close();
server.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nAll Advisory Board application checks passed');
process.exit(failures.length ? 1 : 0);
