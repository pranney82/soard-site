/**
 * test-application-waitlist.mjs — "tell me when applications open" in a real browser
 * ===============================================================================
 * Drives the Apply page and the application form against the real Pages
 * Functions (wrangler pages dev with local D1), at phone size and on a computer:
 *   - /apply/ follows the live switch with no rebuild: closed shows the
 *     sign-up box, open shows the Apply buttons (and an outside form link)
 *   - signing up: English and Spanish (preselected for a Spanish browser),
 *     the "on the list" and "already on the list" answers, saved in local D1
 *     with the language and the page it came from
 *   - signing up while open says so and shows the link
 *   - the closed form page: its own sign-up box, the hero button pointing at
 *     it, English / Español redrawing the box, a Spanish signup
 *   - /apply/form/?lang=es starts in Spanish
 *   - nothing wider than the screen at 360px; 44px tap targets; no console errors
 *   - screenshots: phone and desktop, light and dark
 *
 *   SITE=http://127.0.0.1:8813 PAGES_DIR=<dir with the local wrangler.toml> node scripts/test-application-waitlist.mjs
 *
 * Local server: a scratch dir with symlinks to a built dist/, functions/ and
 * node_modules, a wrangler.toml with only DB and FILES, scripts/schema.sql
 * loaded into local D1. Kit gets a fake key, so every signup also shows the
 * site keeping the family when Kit says no.
 */
import puppeteer from 'puppeteer';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/application-waitlist/');
mkdirSync(OUT, { recursive: true });
const SITE = (process.env.SITE || 'http://127.0.0.1:8813').replace(/\/$/, '');
const PAGES_DIR = process.env.PAGES_DIR;
if (!PAGES_DIR) { console.error('Set PAGES_DIR to the folder with the local wrangler.toml'); process.exit(2); }
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCAL = !/sunshineonaranneyday\.com/.test(SITE);

function d1(sql) {
  const out = execFileSync('npx', ['--prefix', ROOT, 'wrangler', 'd1', 'execute', 'soard-db', '--local', '--json', '--command', sql], { cwd: PAGES_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out)[0]?.results || [];
}
function setApp(app) {
  d1(`INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES ('settings', '${JSON.stringify({ application: app }).replace(/'/g, "''")}', datetime('now'))`);
}
const signup = (email) => d1(`SELECT * FROM waitlist_signups WHERE email = '${email}'`)[0] || null;

const browser = await puppeteer.launch({
  headless: true,
  args: ['--disable-gpu', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
const consoleErrors = [];

async function newTab({ phone = true, lang = 'en-US', dark = false } = {}) {
  const page = await browser.newPage();
  if (phone) await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  else await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]);
  await page.evaluateOnNewDocument((l) => {
    Object.defineProperty(navigator, 'language', { get: () => l });
    Object.defineProperty(navigator, 'languages', { get: () => [l] });
  }, lang);
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() !== 'error' || /favicon|cloudflareinsights|Failed to load resource/.test(t)) return;
    if (LOCAL && /violates the following Content Security Policy/.test(t)) return; // absolute live-site image URLs
    if (LOCAL && /\/api\/live-ws|live-status/.test(t)) return; // no live hub locally
    consoleErrors.push(`${page.url()}: ${t}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`${page.url()}: ${e.message}`));
  return page;
}
const visible = (p, sel) => p.$eval(sel, (el) => !el.closest('[hidden]') && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none').catch(() => false);
const text = (p, sel) => p.$eval(sel, (el) => el.textContent.trim()).catch(() => '');
const noSideScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
async function smallTargets(p, scope) {
  return p.evaluate((s) => [...document.querySelectorAll(`${s} button, ${s} input:not([type=hidden]):not([tabindex="-1"]), ${s} a`)]
    .filter(el => el.getClientRects().length && !el.closest('[hidden]') && !el.closest('[aria-hidden="true"]'))
    .map(el => { const target = el.closest('label') || el; const r = target.getBoundingClientRect(); return { t: (el.textContent || el.getAttribute('aria-label') || el.name || '').trim().slice(0, 30), h: r.height, w: r.width }; })
    .filter(r => r.h < 36 || r.w < 36), scope);
}
const stamp = Date.now().toString(36);

// ─── /apply/ closed ─────────────────────────────────────────────────
console.log('\n/apply/ while closed');
setApp({ open: false, year: '2027', closedMessage: 'Applications for 2027 open in January.' });
let page = await newTab();
await page.goto(`${SITE}/apply/`, { waitUntil: 'networkidle0' });
ok(await visible(page, '#notify-form'), 'the sign-up box shows');
ok(!(await visible(page, '.status-inner a[data-when-open]')), 'no Apply Now button');
ok(await page.evaluate(() => [...document.querySelectorAll('[data-when-open], [data-when-closed], #notify-open-link')].filter(el => el.hidden).every(el => getComputedStyle(el).display === 'none')), 'everything marked hidden is really off the screen');
ok((await text(page, '[data-app-text="closedHeadline"]')) === 'Applications for 2027 open in January.' && await visible(page, '[data-app-text="closedHeadline"]'), 'the staff-written closed message, straight from the setting');
ok(await page.$eval('[name="lang"][value="en"]', (el) => el.checked), 'English is preselected for an English browser');
ok(await page.$eval('#notify-open-link', (el) => getComputedStyle(el).display === 'none'), 'the "Start your application" link stays hidden while closed');
ok(await noSideScroll(page), 'nothing wider than the phone');
const small = await smallTargets(page, '#notify-form');
ok(small.length === 0, `tap targets in the sign-up box are big enough${small.length ? `: ${JSON.stringify(small)}` : ''}`);
await page.screenshot({ path: join(OUT, 'apply-closed-phone.png'), clip: await page.$eval('.status-banner', (el) => { const r = el.getBoundingClientRect(); return { x: 0, y: r.top + window.scrollY, width: window.innerWidth, height: r.height }; }) });

const en = `wl-en-${stamp}@example.com`;
await page.type('#notify-email', en);
await page.click('#notify-btn');
await page.waitForFunction(() => document.querySelector('#notify-btn').textContent === 'Done', { timeout: 15000 }).catch(() => {});
ok((await text(page, '#notify-note')).startsWith("You're on the list."), 'the family hears they are on the list');
let row = signup(en);
ok(row && row.lang === 'en' && row.page === 'apply', 'saved on the site with its language and page');
ok(row && !row.kit_id && /Kit/.test(row.kit_error || '') && row.next_try_at, 'Kit said no (fake key): kept, and queued to retry');
await page.type('#notify-email', en);
ok(await page.$eval('#notify-btn', (b) => !b.disabled), 'typing a new address starts over');
await page.click('#notify-btn');
await page.waitForFunction(() => document.querySelector('#notify-btn').textContent === 'Done', { timeout: 15000 }).catch(() => {});
ok((await text(page, '#notify-note')).startsWith("You're already on the list."), 'a second signup says they are already on it');
await page.close();

// Spanish browser
page = await newTab({ lang: 'es-MX' });
await page.goto(`${SITE}/apply/`, { waitUntil: 'networkidle0' });
ok(await page.$eval('[name="lang"][value="es"]', (el) => el.checked), 'Español is preselected for a Spanish browser');
const es = `wl-es-${stamp}@example.com`;
await page.type('#notify-email', es);
await page.click('#notify-btn');
await page.waitForFunction(() => document.querySelector('#notify-btn').textContent === 'Done', { timeout: 15000 }).catch(() => {});
ok((await text(page, '#notify-note')).startsWith('Ya está en la lista.'), 'the answer is in Spanish');
ok(signup(es)?.lang === 'es', 'saved as Spanish');
await page.close();

// Desktop, light and dark
for (const dark of [false, true]) {
  page = await newTab({ phone: false, dark });
  await page.goto(`${SITE}/apply/`, { waitUntil: 'networkidle0' });
  await page.$eval('.status-banner', (el) => el.scrollIntoView({ block: 'center' }));
  await sleep(200);
  await page.screenshot({ path: join(OUT, `apply-closed-desktop${dark ? '-dark' : ''}.png`) });
  await page.close();
}

// ─── /apply/form/ closed ────────────────────────────────────────────
console.log('\n/apply/form/ while closed');
page = await newTab();
await page.goto(`${SITE}/apply/form/`, { waitUntil: 'networkidle0' });
ok(await visible(page, '[data-closed] [data-notify]'), 'the closed card has its own sign-up box');
ok(await page.$eval('[data-hero-cta]', (a) => a.getAttribute('href')) === '#application', 'the hero button goes to it, not off the page');
ok(await noSideScroll(page), 'nothing wider than the phone');
const smallForm = await smallTargets(page, '[data-closed]');
ok(smallForm.length === 0, `tap targets in the closed card are big enough${smallForm.length ? `: ${JSON.stringify(smallForm)}` : ''}`);
await page.click('[data-closed-lang] [data-lang="es"]');
await sleep(300);
ok((await text(page, '[data-notify-btn]')) === 'Avísenme', 'Español redraws the box');
ok((await text(page, '[data-closed] [data-af-t="closedLead"]')).startsWith('Déjenos su correo'), 'and the words above it');
ok(await page.$eval('[data-notify-lang]', (el) => el.value) === 'es', 'the signup will be Spanish');
const formEs = `wl-form-es-${stamp}@example.com`;
await page.type('#af-notify-email', 'not-an-email');
await page.click('[data-notify-btn]');
await sleep(200);
ok((await text(page, '[data-notify-note]')) === 'Escriba un correo electrónico válido.', 'a bad address is caught before sending, in Spanish');
await page.$eval('#af-notify-email', (el) => { el.value = ''; });
await page.type('#af-notify-email', formEs);
await page.click('[data-notify-btn]');
await page.waitForFunction(() => document.querySelector('[data-notify-btn]').textContent === 'Listo', { timeout: 15000 }).catch(() => {});
ok((await text(page, '[data-notify-note]')).startsWith('Ya está en la lista.'), 'a Spanish signup from the form page');
row = signup(formEs);
ok(row?.lang === 'es' && row?.page === 'apply-form', 'saved as Spanish, from the form page');
await page.$eval('[data-closed]', (el) => el.scrollIntoView({ block: 'center' }));
await sleep(200);
await page.screenshot({ path: join(OUT, 'form-closed-phone-es.png') });
await page.close();

page = await newTab();
await page.goto(`${SITE}/apply/form/?lang=es`, { waitUntil: 'networkidle0' });
ok((await text(page, '[data-af-t="heroEyebrow"]')).startsWith('Para familias'), '?lang=es (the Spanish email\'s link) starts in Spanish');
await page.close();

// ─── Open ───────────────────────────────────────────────────────────
console.log('\nWhile open');
setApp({ open: true, year: '2027' });
page = await newTab();
await page.goto(`${SITE}/apply/`, { waitUntil: 'networkidle0' });
ok(await visible(page, '.status-inner a[data-when-open]'), 'the Apply Now button shows without a rebuild');
ok(!(await visible(page, '#notify-form')), 'the sign-up box is gone');
ok((await text(page, '[data-app-text="openHeadline"]')) === 'The 2027 application is now open!' && await visible(page, '[data-app-text="openHeadline"]'), 'the open headline with the season');
ok(await page.$eval('.hero-ctas a[data-when-open]', (a) => a.getAttribute('href')) === '/apply/form/', 'the hero Apply Now goes to the form');
await page.screenshot({ path: join(OUT, 'apply-open-phone.png') });
await page.close();

// A page loaded while closed, submitted after opening
setApp({ open: false, year: '2027' });
page = await newTab();
await page.goto(`${SITE}/apply/`, { waitUntil: 'networkidle0' });
setApp({ open: true, year: '2027' });
await page.type('#notify-email', `wl-late-${stamp}@example.com`);
await page.click('#notify-btn');
await page.waitForFunction(() => document.querySelector('#notify-btn').textContent === 'Done', { timeout: 15000 }).catch(() => {});
ok((await text(page, '#notify-note')).startsWith('Good news: applications are open right now.'), 'signing up after it opened says so');
ok(await visible(page, '#notify-open-link'), 'and shows the link');
await page.close();

setApp({ open: false, year: '2027' });
ok(consoleErrors.length === 0, `no console errors${consoleErrors.length ? `:\n    ${consoleErrors.join('\n    ')}` : ''}`);
await browser.close();
console.log(failures.length ? `\n${failures.length} failed` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
