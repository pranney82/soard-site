/**
 * test-application-form.mjs — fill in the makeover application in a real browser
 * ===============================================================================
 * Drives /apply/form/ against the real Pages Functions (wrangler pages dev with
 * local D1 + R2), at phone size (390px), then on a computer (1280px):
 *   - the overview on the page (every step and its minutes, Start in sight), then
 *     the application on its own screen: the site's header, footer and hero step
 *     aside, a bar across the top (save state, language, Save and exit), a segment
 *     per step, and each step a screen at a time (the questions that fit; Continue
 *     shows the next part); the tab's title says the step
 *   - English / Español switch: everything redraws, answers and screen kept;
 *     the browser's language picks Spanish first; a resumed draft's language wins
 *   - page 1 checks (both boxes), then a draft starts on Continue
 *   - the service area: the map drawn from the live outline, the address
 *     placed on it as it's typed (the real Census, through the server), what
 *     the check found and the county it fills in; a home far out meets the
 *     "outside" stop screen (Settings set to stop them) with its pin on the
 *     map, and "Change the address" goes back to the street
 *   - follow-up questions appearing (conviction, sensory)
 *   - a problem shows when a question is left (only once touched), goes as soon
 *     as it's fixed, never in red; Next scrolls to and focuses the first one
 *   - address suggestions: listbox, arrows, Enter, Escape, fills city/state/ZIP
 *     and the county question (the lookup is stubbed: Photon is slow from a laptop)
 *   - every question type: name, date, address, select, radio, checkbox (max 2
 *     disables the rest), textarea, signature
 *   - photos resized in the browser and stored (R2): by the file picker and by
 *     drag and drop, with the progress ring filling on a slow connection
 *   - the video upload; Stream itself is faked (no credentials locally): tus
 *     requests are answered here and the draft's video is marked uploaded in
 *     local D1, so the server's own checks still run on submit
 *   - reload resumes on the same page with every answer back
 *   - "All steps": checks, "You are here", later steps locked, jumping
 *   - review: the missing count, Answer it, Back to review, Submit held until
 *     complete; submit; the thank-you
 *   - reminder opt-out links; page rules skipping pages (in the live preview);
 *     the admin editor's ?preview=live messages
 *   - directional motion runs (a view transition, back the other way), and doesn't
 *     under reduced motion; the browser's Back goes a screen back, and from the
 *     first screen out to the overview, without the page reloading
 *   - Save and exit: back to the overview, with what's done and Continue
 *   - the camera recorder on a computer (when the Permissions-Policy allows it)
 *   - nothing wider than the screen at 360px; 44px tap targets; no console errors
 *   - screenshots: phone and desktop, light and dark, English and Spanish
 *
 *   SITE=http://127.0.0.1:8794 PAGES_DIR=<dir with the local wrangler.toml> node scripts/test-application-form.mjs
 *
 * Local server (once): a scratch dir with symlinks to dist/ and functions/, a
 * wrangler.toml without the AI and LIVE_HUB bindings, and site_config
 * "settings" = {"application":{"open":true,"year":"2027"}} in local D1. The
 * test sets the service area to stop families far out (application_form_rules)
 * and puts it back at the end.
 */
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SERVICE_AREA } from '../functions/api/_application-form.js';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/application-form/');
mkdirSync(OUT, { recursive: true });
const SITE = (process.env.SITE || 'http://127.0.0.1:8791').replace(/\/$/, '');
const PAGES_DIR = process.env.PAGES_DIR;
const failures = [];
const notes = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Test files: a big landscape photo (exercises the resize) and a small "video"
const PHOTO = join(OUT, 'photo.jpg');
writeFileSync(PHOTO, await sharp({ create: { width: 4032, height: 3024, channels: 3, background: { r: 255, g: 218, b: 36 } } }).jpeg({ quality: 90 }).toBuffer());
const NOISY = join(OUT, 'photo-big.jpg'); // noise compresses badly: a big upload, so the ring can be seen filling
writeFileSync(NOISY, await sharp(Buffer.from(Array.from({ length: 1600 * 1200 * 3 }, () => Math.floor(Math.random() * 256))), { raw: { width: 1600, height: 1200, channels: 3 } }).jpeg({ quality: 95 }).toBuffer());
const VIDEO = join(OUT, 'clip.mp4');
writeFileSync(VIDEO, Buffer.alloc(300 * 1024, 7));

// Address lookups are answered here (the real one asks Photon, which is slow from a laptop)
// Real addresses (the service-area check asks the real Census through the local server)
const SUGGESTIONS = [
  { line1: '3167 Main St', city: 'Duluth', state: 'GA', zip: '30096', county: 'Gwinnett', label: '3167 Main St, Duluth, GA 30096' },
  { line1: '3167 Mount Vernon Rd', city: 'Marietta', state: 'GA', zip: '30067', county: 'Cobb', label: '3167 Mount Vernon Rd, Marietta, GA 30067' },
];
let addressAsks = 0;

const browser = await puppeteer.launch({
  headless: true,
  args: ['--disable-gpu', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const consoleErrors = [];
// Locally, 'self' isn't sunshineonaranneyday.com, so every page's absolute image URLs trip the CSP; not a real error
const LOCAL = !/sunshineonaranneyday\.com/.test(SITE);
let videoBytes = 0;

/** A tab with the console watched and Stream + the address lookup faked */
async function newTab({ context = browser, phone = true, reduced = true, bypassCsp = false } = {}) {
  const page = await context.newPage();
  if (phone) await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  else await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  // Instant scrolling, so a tap never lands mid-scroll (people wait; scripts don't)
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }]);
  if (bypassCsp) await page.setBypassCSP(true); // screenshots: let the real photos load from the live site
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() !== 'error' || /favicon|cloudflareinsights|Failed to load resource/.test(t)) return;
    if (LOCAL && /violates the following Content Security Policy/.test(t) && /sunshineonaranneyday\.com\/cdn-cgi\/imagedelivery/.test(t)) return;
    if (LOCAL && /\/api\/live-ws/.test(t)) return; // the sitewide live indicator; no live hub in a local server
    consoleErrors.push(t);
  });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const url = req.url();
    if (url.startsWith('https://upload.videodelivery.net/')) {
      const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Expose-Headers': 'Upload-Offset, Upload-Length, Tus-Resumable, Location, stream-media-id' };
      if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: cors });
      if (req.method() === 'HEAD') return req.respond({ status: 200, headers: { ...cors, 'Upload-Offset': '0', 'Upload-Length': String(videoBytes), 'Tus-Resumable': '1.0.0' } });
      if (req.method() === 'PATCH') return req.respond({ status: 204, headers: { ...cors, 'Upload-Offset': String(videoBytes), 'Tus-Resumable': '1.0.0' } });
    }
    if (url.startsWith(`${SITE}/api/apply?address=`)) {
      addressAsks++;
      const q = decodeURIComponent(url.split('address=')[1] || '').toLowerCase();
      const results = SUGGESTIONS.filter((s) => s.line1.toLowerCase().startsWith(q.slice(0, 8)));
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, results }) });
    }
    if (url.startsWith(`${SITE}/api/apply`) && req.method() === 'POST' && (req.headers()['content-type'] || '').includes('json')) {
      const body = JSON.parse(req.postData() || '{}');
      if (body.action === 'video-url') {
        videoBytes = body.size;
        return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, uploadUrl: 'https://upload.videodelivery.net/tus/fake-upload' }) });
      }
      if (body.action === 'video-done') {
        // Record it the way the real endpoint would, so submit's server-side checks pass
        if (PAGES_DIR) {
          execFileSync('npx', ['wrangler', 'd1', 'execute', 'soard-db', '--local', '--command',
            `UPDATE application_drafts SET files = json_set(files, '$.video', json('{"uid":"fakevid","uploaded":true,"size":${videoBytes},"name":"clip.mp4"}')) WHERE id = '${body.token}'`], { cwd: PAGES_DIR, stdio: 'ignore' });
        }
        return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, uploaded: true }) });
      }
    }
    req.continue();
  });
  return page;
}

let page = await newTab();
const shot = async (name, p = page) => { await p.screenshot({ path: join(OUT, `${name}.png`) }); };
const visible = (sel, p = page) => p.$eval(sel, (el) => !!el && !el.closest('[hidden]') && el.getClientRects().length > 0).catch(() => false);
const stepTitle = (p = page) => p.$eval('[data-step-title]', (el) => el.textContent.trim());
const stepText = (p = page) => p.$eval('[data-step-text]', (el) => el.textContent.trim());
const next = async (p = page) => { await p.click('[data-next]'); await sleep(450); };
const partText = (p = page) => p.$eval('[data-part-text]', (el) => el.textContent.trim());
/**
 * A step shows its questions a screen at a time: Continue until the screen with this one
 * is showing (as a family would; it stops if Continue is held up by a problem)
 */
const reach = async (sel, p = page) => {
  for (let i = 0; i < 8; i++) {
    const where = await p.evaluate((s) => { const el = document.querySelector(s); return !el ? 'none' : el.closest('[data-off]') ? 'later' : 'here'; }, sel);
    if (where !== 'later') return;
    const was = `${await stepTitle(p)}|${await partText(p)}`;
    await next(p);
    if (`${await stepTitle(p)}|${await partText(p)}` === was) throw new Error(`Continue was held up on the way to ${sel}`);
  }
};
/** Continue until the step with this name is on screen */
const onTo = async (title, p = page) => {
  for (let i = 0; i < 8 && (await stepTitle(p)) !== title; i++) await next(p);
};
/** Start (or carry on): the hero's button puts the application on its own screen */
const begin = async (p = page) => { await p.click('[data-hero-cta]'); await sleep(400); };
const pick = async (field, value, p = page) => {
  await reach(`[data-field="${field}"]`, p);
  await p.evaluate((f, v) => {
    const input = [...document.querySelectorAll(`[data-field="${f}"] input`)].find((i) => i.value === v);
    input.click();
  }, field, value);
};
/** Click after centering it: a button can sit in the viewport but under the sticky bars */
const tap = async (sel, p = page) => { await reach(sel, p); await p.$eval(sel, (e) => e.scrollIntoView({ block: 'center', behavior: 'instant' })); await p.click(sel); };
// Centered first, like tap(): a box near the top can sit under the sticky bar, and the click would miss it
const center = async (sel, p) => { await reach(sel, p); await p.$eval(sel, (e) => e.scrollIntoView({ block: 'center', behavior: 'instant' })); };
const type = async (sel, text, p = page) => { await center(sel, p); await p.click(sel, { clickCount: 3 }); await p.type(sel, text); };
const clear = async (sel, p = page) => { await center(sel, p); await p.click(sel, { clickCount: 3 }); await p.keyboard.press('Backspace'); };
const setDate = async (field, v, p = page) => { await reach(`#af-${field}`, p); await p.$eval(`#af-${field}`, (el, val) => { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }, v); };
const selectOpt = async (field, v, p = page) => { await reach(`#af-${field}`, p); await p.select(`#af-${field}`, v); };
const errorText = (field, p = page) => p.$eval(`[data-field="${field}"] .af-error`, (e) => e.textContent.trim());
const noSideScroll = async (label, p = page) => {
  const wide = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(wide <= 1, `${label}: nothing wider than the screen (${wide}px over)`);
};
const draftToken = (p = page) => p.evaluate(() => JSON.parse(localStorage.getItem('soard-application-draft') || '{}').token);
const d1 = (sql) => (PAGES_DIR ? execFileSync('npx', ['wrangler', 'd1', 'execute', 'soard-db', '--local', '--json', '--command', sql], { cwd: PAGES_DIR, encoding: 'utf8' }) : null);
/** Open "All steps" and read it: [{ name, state, disabled, now }] */
const openSteps = async (p = page) => {
  await p.$eval('[data-steps]', (d) => { d.open = true; });
  await sleep(150);
  return p.$$eval('[data-steps-list] .af-step', (els) => els.map((b) => ({ name: b.querySelector('.af-step-name').textContent, state: b.dataset.state, disabled: b.disabled, now: b.getAttribute('aria-current') === 'step', label: b.textContent })));
};
/** A JPEG made in the page and dropped on an upload box, the way a mouse drag does it */
const dropPhoto = (field, p = page) => p.evaluate(async (f) => {
  const c = document.createElement('canvas');
  c.width = 1200; c.height = 900;
  const g = c.getContext('2d');
  g.fillStyle = '#4a7'; g.fillRect(0, 0, 1200, 900); g.fillStyle = '#FFDA24'; g.fillRect(200, 150, 800, 600);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'dropped.jpg', { type: 'image/jpeg' }));
  const zone = document.querySelector(`[data-field="${f}"] [data-drop]`);
  zone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
  zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  const veil = zone.dataset.drag === '1';
  zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return { veil, after: zone.dataset.drag || '' };
}, field);
/** Not red: an error's ink and background stay in the yellow/brown family */
const notRed = (rgb) => {
  const [r, g, b] = (rgb.match(/\d+/g) || []).map(Number);
  return !(r > 140 && g < 110 && b < 110) && !(r > 200 && g < 160 && b < 160 && r - g > 70);
};

// Settings → Service area: families far out are stopped (the default tells them and lets them apply)
const RULES_TABLE = 'CREATE TABLE IF NOT EXISTS application_form_rules (id INTEGER PRIMARY KEY CHECK (id = 1), rules TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT)';
const stopRules = JSON.stringify({ serviceArea: { ...DEFAULT_SERVICE_AREA, beyond: 'stop' } });
d1(`${RULES_TABLE}; INSERT INTO application_form_rules (id, rules, updated_at, updated_by) VALUES (1, '${stopRules}', '${new Date().toISOString()}', 'test') ON CONFLICT(id) DO UPDATE SET rules = excluded.rules`);
// The server keeps the live form for 15 seconds (_application-forms.js LIVE_TTL_MS): let any copy from before this expire
if (PAGES_DIR) await sleep(16000);

try {
  console.log('Open');
  await page.goto(`${SITE}/apply/form/`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });
  ok(await visible('[data-hub]'), 'the overview of the application shows (applications are open in local D1)');
  ok(!(await visible('[data-closed]')), 'the closed card is hidden');
  ok(await page.$eval('[data-hero-cta]', (a) => a.getAttribute('href')) === '#application', "the hero's button follows the live open switch");
  const hub = await page.evaluate(() => {
    document.querySelector('#application').scrollIntoView();
    const go = document.querySelector('[data-hub-go]').getBoundingClientRect();
    return {
      rows: [...document.querySelectorAll('[data-hub-list] .af-hub-row')].map((b) => ({ name: b.querySelector('strong').textContent, meta: b.querySelector('.af-hub-meta').textContent, disabled: b.disabled })),
      goInView: go.top >= 0 && go.bottom <= innerHeight,
      title: document.querySelector('[data-hub-title]').textContent,
    };
  });
  ok(hub.rows.length === 10 && hub.rows[0].name === 'Before You Begin' && hub.rows.slice(0, 9).every((r) => /\d+ min/.test(r.meta)), `it lists all ten steps with their minutes (${hub.rows.map((r) => r.meta).join(', ')})`);
  ok(!hub.rows[0].disabled && hub.rows.slice(1).every((r) => r.disabled), 'only the first is open before starting');
  ok(hub.goInView && /everything we'll ask/.test(hub.title), 'and "Start the application" is in sight without scrolling past the list');
  // The season as the live settings have it, wherever the page names it (not the year it was built with)
  const season = await page.$eval('[data-application]', (e) => e.dataset.year);
  const named = await page.evaluate(() => [document.title, ...['og:title', 'twitter:title'].map((k) => document.querySelector(`meta[property="${k}"], meta[name="${k}"]`)?.content || '')]);
  ok(named.every((t) => t.startsWith(`${season} Makeover Application`)), `the title and link previews say ${season} (${named[0]})`);
  await shot('00-overview-phone');
  await begin();
  const focus = await page.evaluate(() => ({
    on: document.documentElement.classList.contains('af-focus'),
    header: !!document.querySelector('#site-header')?.getClientRects().length,
    footer: !!document.querySelector('.site-footer')?.getClientRects().length,
    hero: !!document.querySelector('.hero')?.getClientRects().length,
    top: document.querySelector('[data-top]').getBoundingClientRect().top,
    segs: document.querySelectorAll('[data-segs] .af-seg').length,
    tab: document.title,
  }));
  ok(focus.on && !focus.header && !focus.footer && !focus.hero, "Start: the application has the screen to itself (the site's header, footer and hero step aside)");
  ok(focus.top === 0 && focus.segs === 10, `a bar across the top with a segment per step (${focus.segs})`);
  ok(/^Step 1 of 10: Before You Begin · /.test(focus.tab), `the tab says the step (${focus.tab})`);
  ok((await stepTitle()) === 'Before You Begin', 'starts on Before You Begin');
  ok(/^Part 1 of \d$/.test(await partText()), `a long step comes a screen at a time (${await partText()})`);
  ok(await visible('[data-lang-switch]'), 'the English / Español switch shows');
  const AREA = 'Service Area';
  await page.$eval('#application', (el) => el.scrollIntoView());
  await noSideScroll('welcome');

  console.log('Language');
  await tap('[data-lang-switch] [data-lang="es"]');
  await sleep(250);
  ok((await stepTitle()) === 'Antes de comenzar', 'Español: the page title is Spanish');
  ok(/Continuar/.test(await page.$eval('[data-next]', (e) => e.textContent)) && /Paso 1 de/.test(await stepText()), 'and the buttons and step count');
  ok(/su hijo o hija/.test(await page.$eval('.hero-headline', (e) => e.textContent)), 'and the hero above the form');
  ok(await page.$eval('#application', (e) => e.getAttribute('lang')) === 'es', 'the form is marked lang="es"');
  ok(await page.$eval('[data-lang-switch] [data-lang="es"]', (e) => e.getAttribute('aria-pressed')) === 'true', 'the switch shows Español pressed');
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('soard-application-lang'))) === 'es', 'the choice is remembered');
  await tap('[data-field="ackParameters"] .af-choice');
  const esPart = await partText();
  await tap('[data-lang-switch] [data-lang="en"]');
  await sleep(250);
  ok((await stepTitle()) === 'Before You Begin', 'back to English');
  ok(await page.$eval('[data-field="ackParameters"] input', (i) => i.checked), 'a ticked box stays ticked through both switches');
  ok(/\d/.test(esPart) && (await partText()).replace(/\D/g, '') === esPart.replace(/\D/g, ''), `and the screen stays the same one (${esPart} → ${await partText()})`);
  await tap('[data-field="ackParameters"] .af-choice');

  console.log('Page 1 checks');
  await next();
  const ackErrors = await page.$$eval('[data-field^="ack"] .af-error', (els) => els.map((e) => e.textContent).filter(Boolean));
  ok(ackErrors.length >= 1 && ackErrors.every((t) => /check the box/.test(t)), `the acknowledgments are required (${ackErrors.length} on this screen)`);
  ok(await page.evaluate(() => document.activeElement?.closest('[data-field]')?.dataset.field === 'ackParameters'), 'focus moves to the first problem');
  const errLook = await page.$eval('[data-field="ackParameters"] .af-error', (e) => { const s = getComputedStyle(e); return { color: s.color, bg: s.backgroundColor }; });
  const border = await page.$eval('[data-field="ackParameters"] .af-choice', (e) => getComputedStyle(e).borderColor);
  ok(notRed(errLook.color) && notRed(errLook.bg) && notRed(border), `problems are never red (ink ${errLook.color}, background ${errLook.bg}, border ${border})`);
  ok(await page.$eval('[data-field="ackParameters"] input', (i) => i.getAttribute('aria-invalid')) === 'true', 'the box is marked aria-invalid');
  await shot('02-errors-phone');
  await tap('[data-field="ackParameters"] .af-choice');
  ok(await errorText('ackParameters') === '', 'ticking it clears its note straight away');
  await tap('[data-field="ackSeason"] .af-choice');
  await next();
  ok((await stepTitle()) === AREA, 'on to the service area');
  const token = await draftToken();
  ok(/^[0-9a-f]{32}$/.test(token || ''), 'a draft started and its token is kept on this device');

  console.log('Service area: the address, then the map with what the check found');
  const areaState = () => page.$eval('[data-area]', (e) => e.dataset.area);
  const waitArea = (st) => page.waitForFunction((x) => document.querySelector('[data-area]')?.dataset.area === x, { timeout: 15000 }, st).catch(() => {});
  const askShown = () => page.$eval('[data-area-ask]', (e) => !e.hidden);
  ok(await visible('#af-address-line1') && await page.$eval('[data-field="boundary"]', (e) => !!e.closest('[data-off]')), 'a phone has the address on this screen, the map waiting for the next');
  ok(/Enter the address above/.test(await page.$eval('[data-area-result]', (e) => e.textContent)), 'the check says what to do until there is an address');
  ok(!(await askShown()), 'the question itself stays out of the way');
  await page.focus('#af-address-line1');
  await page.type('#af-address-line1', '3167 Main');
  await page.waitForSelector('#af-address-suggest:not([hidden]) [role="option"]', { timeout: 4000 }).catch(() => {});
  ok(await visible('#af-address-suggest'), 'suggestions open under Street address');
  ok(await page.$eval('#af-address-line1', (e) => e.getAttribute('aria-expanded')) === 'true', 'the combobox says it is expanded');
  ok(addressAsks >= 1 && addressAsks <= 3, `asked after a pause, not on every key (${addressAsks} lookups for 9 keys)`);
  const listOnTop = await page.evaluate(() => getComputedStyle(document.querySelector('#af-address-suggest')).zIndex);
  ok(Number(listOnTop) >= 1100, `the list sits above the bar across the top (z-index ${listOnTop})`);
  await shot('04-address-suggest-phone');
  await page.keyboard.press('ArrowDown');
  ok(await page.$eval('#af-address-line1', (e) => e.getAttribute('aria-activedescendant')) === 'af-address-suggest-0', 'ArrowDown highlights the first');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await sleep(100);
  const filled = await page.evaluate(() => ['line1', 'city', 'state', 'zip'].map((k) => document.querySelector(`#af-address-${k}`).value));
  ok(filled.join('|') === '3167 Main St|Duluth|GA|30096', `Enter fills the address (${filled.join(', ')})`);
  ok(await page.$eval('#af-county', (e) => e.value) === 'Gwinnett', 'and the county question');
  ok(/Gwinnett County/.test(await page.$eval('[data-field="address"] .af-county-note', (e) => (e.hidden ? '' : e.textContent))), 'with a note saying so');
  ok(await stepTitle() === AREA && !(await visible('#af-address-suggest')), 'Enter picked; it did not submit the page');
  await waitArea('inside');
  ok(await areaState() === 'inside', 'the address is placed on the map: inside');
  const card = await page.$eval('[data-area-result]', (e) => e.textContent.replace(/\s+/g, ' '));
  ok(/Inside our service area/.test(card) && /We found 3167 Main St, Duluth, GA 30096, in Gwinnett County/.test(card), `what it found, in plain words (${card.slice(0, 120)})`);
  ok(await page.$('[data-field="boundary"] .af-map-pin') != null, 'a pin on the home, ready on the map');
  ok(await page.$eval('[data-area-result]', (e) => e.getAttribute('aria-live')) === 'polite', 'the result is read out to screen readers');
  await clear('#af-address-line1');
  await page.type('#af-address-line1', '3167 Main');
  await page.waitForSelector('#af-address-suggest:not([hidden])', { timeout: 4000 }).catch(() => {});
  await page.keyboard.press('Escape');
  ok(!(await visible('#af-address-suggest')), 'Escape closes the list');

  console.log('Service area: far out, with Settings stopping them');
  await clear('#af-address-line1');
  await page.type('#af-address-line1', '700 Poplar St');
  await page.keyboard.press('Escape');
  await clear('#af-address-city');
  await page.type('#af-address-city', 'Macon');
  await clear('#af-address-zip');
  await page.type('#af-address-zip', '31201');
  await waitArea('far');
  ok(await areaState() === 'far', 'Macon is placed far outside');
  ok(/Outside our service area/.test(await page.$eval('[data-area-result]', (e) => e.textContent)) && /only for homes inside/.test(await page.$eval('[data-area-result]', (e) => e.textContent)), 'it says so, in the stop screen’s words');
  ok(await page.$('[data-field="boundary"] .af-map-away') != null, 'the map points to a home off its edge, with the distance');
  await next();
  ok(await visible('[data-stop]'), 'Continue on the address: the stop screen (the address decides it, the map screen is skipped)');
  ok(await visible('[data-stop-map] .af-map-frame'), 'with the map and where the home is');
  ok(/Change the address/.test(await page.$eval('[data-stop-back]', (e) => e.textContent)), 'and a way back to the address');
  await shot('05-stop-outside');
  await page.click('[data-stop-back]');
  await sleep(250);
  ok(await visible('[data-form]') && (await stepTitle()) === AREA, '"Change the address" goes back');
  ok(await page.evaluate(() => document.activeElement?.id === 'af-address-line1'), 'with the cursor in the street');

  console.log('Service area: an address the Census can’t find');
  await clear('#af-address-line1');
  await page.type('#af-address-line1', '1 Nowhere Lane');
  await page.keyboard.press('Escape');
  await clear('#af-address-city');
  await page.type('#af-address-city', 'Faketown');
  await clear('#af-address-zip');
  await page.type('#af-address-zip', '30999');
  await waitArea('unknown');
  ok(await askShown(), 'not found: now the family is asked');
  ok(/couldn't find this address/.test(await page.$eval('[data-area-result]', (e) => e.textContent)), 'and told why');
  await next();
  ok(await visible('[data-area-ask]') && await stepTitle() === AREA, 'Continue: the map screen, with the question');
  await next();
  ok(/enter the home address so we can check it, or choose an answer/.test(await errorText('boundary')), 'Continue without an answer says what to do');
  await page.click('[data-back]');
  await sleep(450);
  ok(await visible('#af-address-line1'), 'Back: the address again');

  // Back to a home inside
  await clear('#af-address-line1');
  await page.type('#af-address-line1', '3167 Main');
  await page.waitForSelector('#af-address-suggest:not([hidden]) [role="option"]', { timeout: 4000 }).catch(() => {});
  await page.click('#af-address-suggest-0');
  await sleep(100);
  ok(await page.$eval('#af-address-line1', (e) => e.value) === '3167 Main St', 'a tap on a suggestion picks it too');
  await waitArea('inside');
  ok(!(await askShown()), 'placed again, the question goes away');
  await type('#af-address-zip', '3009');
  await next();
  ok(/5-digit ZIP/.test(await errorText('address')), 'a short ZIP is caught');
  const firstProblem = await page.evaluate(() => {
    const el = document.querySelector('[data-field="address"]');
    const bar = document.querySelector('[data-top]');
    return { top: el.getBoundingClientRect().top, header: bar ? bar.getBoundingClientRect().bottom : 0, focused: !!el.contains(document.activeElement) };
  });
  ok(firstProblem.focused && firstProblem.top >= firstProblem.header - 2, `Continue scrolls to the problem below the bar and focuses it (${Math.round(firstProblem.top)}px vs bar ${Math.round(firstProblem.header)}px)`);
  await type('#af-address-zip', '30096');
  await waitArea('inside');
  await noSideScroll('service area');
  await next();
  ok(await visible('[data-field="boundary"] .af-map-frame') && await visible('[data-field="boundary"] .af-map-pin'), 'Continue: the map, with a pin on the home');
  ok(await page.$$eval('[data-field="boundary"] .af-map-town', (els) => els.length) >= 8, 'with towns families know');
  const areaCard = await page.$eval('[data-area-result]', (e) => e.textContent.replace(/\s+/g, ' ').trim());
  ok(await visible('[data-area-result]') && /Inside our service area/.test(areaCard), `and the good news over it (${areaCard.slice(0, 80)})`);
  ok(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight) <= 1, 'the map screen fits without scrolling');
  await shot('03-area-inside-phone');
  await selectOpt('county', 'Cobb');
  ok(await page.$eval('[data-field="address"] .af-county-note', (e) => e.hidden), 'changing the county takes the note away');
  await pick('resides50', 'Yes');
  await next();

  console.log('Basic Information: checks when a question is left');
  ok((await stepTitle()) === 'Basic Information', 'Basic Information');
  await type('#af-childName-first', 'Avery');
  await type('#af-childName-last', 'Test');
  await setDate('birthdate', '2017-04-02');
  await pick('gender', 'Female');
  await reach('#af-diagnosis');
  await page.focus('#af-diagnosis');
  await page.evaluate(() => document.activeElement?.blur());
  ok(await errorText('diagnosis') === '', 'leaving an untouched question says nothing');
  await type('#af-diagnosis', 'x');
  await clear('#af-diagnosis');
  ok(await errorText('diagnosis') === '', 'no note while typing');
  await page.keyboard.press('Tab');
  await sleep(100);
  ok(/answer this question/.test(await errorText('diagnosis')), 'leaving it empty shows the note');
  await page.focus('#af-diagnosis');
  await page.type('#af-diagnosis', 'Cerebral palsy');
  ok(await errorText('diagnosis') === '', 'and it goes as soon as it is answered');
  await pick('previouslyApplied', 'No');
  await type('#af-referredBy', 'Our therapist');

  console.log('All steps');
  let steps = await openSteps();
  ok(steps.length === 10, `ten steps listed (${steps.length})`);
  ok(steps[0].state === 'done' && steps[1].state === 'done', 'pages done are checked');
  ok(steps[2].now && /You are here/.test(steps[2].label), '"You are here" on this one');
  ok(steps.slice(3).every((s) => s.disabled), 'pages not reached yet are locked');
  await page.$eval('[data-steps]', (el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await shot('05-steps-phone');
  await tap('[data-steps-list] [data-goto="welcome"]');
  await sleep(300);
  ok((await stepTitle()) === 'Before You Begin', 'a step already done can be jumped to');
  steps = await openSteps();
  await tap('[data-steps-list] [data-goto="basic"]');
  await sleep(300);
  ok((await stepTitle()) === 'Basic Information', 'and back to where we were');
  await onTo("Parents' Information");
  await shot('06-parents-phone');

  console.log('Parents, and resume after a reload');
  ok((await stepTitle()) === "Parents' Information", "Parents' Information");
  await type('#af-parentName-first', 'Jordan');
  await type('#af-parentName-last', 'Test');
  await type('#af-parentEmail', 'jordan@example');
  await type('#af-parentPhone', '404555012');
  await next();
  const pErr = await page.$$eval('[data-field^="parent"] .af-error', (els) => els.map((e) => e.textContent).filter(Boolean));
  ok(pErr.some((t) => /valid email/.test(t)) && pErr.some((t) => /10-digit/.test(t)), 'email and phone formats are checked');
  // Small helps while typing: the phone number takes its shape, a likely email typo gets a one-tap fix
  await clear('#af-parentPhone');
  await page.type('#af-parentPhone', '4045550123');
  ok(await page.$eval('#af-parentPhone', (e) => e.value) === '(404) 555-0123', 'a phone number reads as (404) 555-0123 as it is typed');
  await type('#af-parentEmail', 'jordan+apply@gmial.com');
  await page.keyboard.press('Tab');
  await sleep(150);
  ok(await visible('[data-field="parentEmail"] [data-mailfix-use]') && /Did you mean/.test(await page.$eval('[data-field="parentEmail"] [data-mailfix]', (e) => e.textContent)), '"gmial.com" gets "Did you mean …@gmail.com?"');
  await tap('[data-field="parentEmail"] [data-mailfix-use]');
  ok(await page.$eval('#af-parentEmail', (e) => e.value) === 'jordan+apply@gmail.com' && !(await visible('[data-field="parentEmail"] [data-mailfix]')), 'a tap on it fixes the address, and the note goes');
  await type('#af-parentEmail', 'jordan+apply@example.com');
  await type('#af-parentPhone', '(404) 555-0123');
  await type('#af-parentRelation', 'Mother');
  // A second parent waits behind a button until wanted
  await reach('[data-more="parent2"]');
  ok(!(await visible('#af-parent2Email')) && await visible('[data-more="parent2"] [data-more-open]'), 'the second parent is tucked behind "Add another parent or guardian"');
  await tap('[data-more="parent2"] [data-more-open]');
  await sleep(150);
  ok(await visible('#af-parent2Email') && await page.evaluate(() => document.activeElement?.id === 'af-parent2Name-first'), 'the button opens it, with the cursor in the first name');
  await page.type('#af-parent2Name-first', 'Sam');
  await tap('[data-more="parent2"] [data-more-close]');
  ok(!(await visible('#af-parent2Email')) && await page.$eval('#af-parent2Name-first', (e) => e.value) === '', 'Remove clears it and tucks it away again');
  // Scrolled down, the bar across the top stays (and Continue at the bottom)
  await reach('[data-field="ownership"]');
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await sleep(150);
  const bars = await page.evaluate(() => ({ top: document.querySelector('[data-top]').getBoundingClientRect().top, next: document.querySelector('[data-next]').getBoundingClientRect().bottom, h: innerHeight }));
  ok(bars.top === 0 && bars.next <= bars.h, `scrolled down, the bar stays at the top and Continue at the bottom (${bars.top}, ${Math.round(bars.next)}/${bars.h})`);
  await pick('ownership', 'No, the property is rented.');
  await next();
  ok(await visible('[data-stop]') && /must own their home/.test(await page.$eval('[data-stop]', (e) => e.textContent)), 'renters get the "must own the home" screen');
  await page.click('[data-stop-back]');
  await pick('ownership', 'Yes, at least one person living in the home is the owner.');
  await next();
  ok((await stepTitle()) === 'Diagnosis', 'Diagnosis');
  // Spanish is saved with the draft: a reload comes back in Spanish even without this device's choice
  await tap('[data-lang-switch] [data-lang="es"]');
  await sleep(1200);
  await page.evaluate(() => localStorage.removeItem('soard-application-lang'));
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(500);
  ok((await stepTitle()) === 'Diagnóstico', "a reload resumes on the same page, in the draft's language");
  ok(/Bienvenido de nuevo/.test(await page.$eval('[data-notice]', (e) => e.textContent)), 'with a welcome-back note');
  await tap('[data-lang-switch] [data-lang="en"]');
  await sleep(300);
  const restored = await page.evaluate(() => [document.querySelector('#af-childName-first').value, document.querySelector('#af-parentEmail').value, document.querySelector('#af-county').value]);
  ok(restored[0] === 'Avery' && restored[1] === 'jordan+apply@example.com' && restored[2] === 'Cobb', 'answers come back');
  steps = await openSteps();
  ok(steps.slice(0, 5).every((s) => !s.disabled), 'how far they got comes back too');
  await page.$eval('[data-steps]', (d) => { d.open = false; });

  console.log('Diagnosis');
  await type('#af-diagnosisImpact', 'Bathing takes two adults.');
  await pick('verbal', 'Yes');
  await pick('ambulatory', 'No');
  await pick('sensory', 'Yes');
  ok(await visible('#af-sensoryDetail'), 'sensory "yes" asks for more');
  await type('#af-sensoryDetail', 'Loud sounds are hard.');
  await pick('destructive', 'No');
  ok(!(await visible('#af-destructiveDetail')), 'and a "no" does not');
  await selectOpt('language', 'Spanish');
  await type('#af-equipment', 'Wheelchair and a walker');
  await next();

  console.log("Child's Info and photos");
  ok((await stepTitle()) === "Child's Info", "Child's Info");
  await type('#af-interests', 'Dinosaurs 🦖 and music');
  await reach('[data-field="photoChild"]');
  await next();
  ok((await stepTitle()) === "Child's Info" && /add a photo/.test(await errorText('photoChild')), 'photos are required before moving on');
  ok(await page.evaluate(() => document.querySelector('[data-field="photoChild"]').parentElement.matches('.af-pair--photos') && document.querySelector('[data-field="photoFamily"]').parentElement.matches('.af-pair--photos')), 'the two photos sit side by side');
  // A slow connection, so the ring can be seen filling
  const cdp = await page.createCDPSession();
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 50, downloadThroughput: 4e6, uploadThroughput: 120 * 1024 });
  await (await page.$('#af-photoChild')).uploadFile(NOISY);
  const ring = await page.waitForFunction(() => {
    const box = document.querySelector('[data-field="photoChild"] .af-upload');
    const fill = box.querySelector('.af-ring-fill');
    const off = parseFloat(fill.style.strokeDashoffset || '113.1');
    return box.dataset.state === 'busy' && off > 1 && off < 110 ? { off, status: box.querySelector('.af-upload-status').textContent } : false;
  }, { timeout: 20000, polling: 50 }).then((h) => h.jsonValue()).catch(() => null);
  ok(!!ring, `the progress ring fills while it uploads${ring ? ` (${ring.status})` : ''}`);
  const warns = await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
  ok(warns, 'leaving mid-upload asks first');
  await page.waitForFunction(() => document.querySelector('[data-field="photoChild"] .af-upload')?.dataset.state === 'done', { timeout: 60000 });
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  ok(await page.$eval('[data-field="photoChild"] .af-upload-preview', (e) => e.hasAttribute('data-thumb') && /url\(/.test(e.style.backgroundImage)), 'a thumbnail shows when it is done');
  const dropped = await dropPhoto('photoFamily');
  ok(dropped.veil && !dropped.after, 'dragging a photo over the box shows the drop veil (and it goes on drop)');
  await page.waitForFunction(() => document.querySelector('[data-field="photoFamily"] .af-upload')?.dataset.state === 'done', { timeout: 20000 });
  ok(/dropped/.test(await page.$eval('[data-field="photoFamily"] .af-upload-status', (e) => e.textContent)), 'a dropped photo uploads like a chosen one');
  await shot('07-photos-phone');
  await type('#af-otherChildren', 'No');
  await next();

  console.log('Home and Space');
  ok((await stepTitle()) === 'Home and Space', 'Home and Space');
  ok(/zero-entry shower/.test(await page.$eval('[data-field="makeoverTypes"]', (e) => e.textContent)), 'makeover choices carry their descriptions');
  await pick('makeoverTypes', 'Accessible Bathroom');
  await pick('makeoverTypes', 'Dream Bedroom');
  const disabled = await page.$$eval('[data-field="makeoverTypes"] input', (els) => els.filter((e) => e.disabled).map((e) => e.value));
  ok(disabled.length === 2 && disabled.includes('Ramp'), 'two picked: the other two are disabled');
  ok(await page.$eval('[data-field="makeoverTypes"] input:checked + .af-choice-box .af-check-draw path', (p) => getComputedStyle(p).strokeDashoffset) === '0px'
    || await page.$eval('[data-field="makeoverTypes"] input:checked + .af-choice-box .af-check-draw path', (p) => parseFloat(getComputedStyle(p).strokeDashoffset) === 0), 'a picked choice draws its check');
  await shot('08-makeover-phone');
  await type('#af-makeoverWhy', 'The bathroom, so she can bathe safely.');
  await type('#af-positiveImpact', 'It would change our days.');
  for (const f of ['photoSpace1', 'photoSpace2']) {
    await reach(`#af-${f}`);
    await (await page.$(`#af-${f}`)).uploadFile(PHOTO);
    await page.waitForFunction((id) => document.querySelector(`[data-field="${id}"] .af-upload`)?.dataset.state === 'done', { timeout: 20000 }, f);
  }
  await noSideScroll('photos');
  await type('#af-residingDuration', 'Forever');
  await pick('permits', "I'm not sure");
  await pick('conviction', 'Yes');
  ok(await visible('#af-convictionDetail'), 'a "yes" offers room to explain');
  await type('#af-convictionDetail', 'A minor matter from 2009, resolved.');
  await next();

  console.log('Video');
  ok((await stepTitle()) === 'Video', 'Video');
  await reach('[data-field="video"]');
  ok(!(await visible('[data-field="video"] [data-act="record"]')), 'phones use their own picker (no record button)');
  await next();
  ok(/upload your video/.test(await errorText('video')), 'the video is required');
  await (await page.$('#af-video')).uploadFile(VIDEO);
  await page.waitForFunction(() => document.querySelector('[data-field="video"] .af-upload')?.dataset.state === 'done', { timeout: 30000 });
  ok(/Video uploaded/.test(await page.$eval('[data-field="video"] .af-upload-status', (e) => e.textContent)), 'the video uploads with progress and a done state');
  ok(await errorText('video') === '', 'and its note goes');
  await shot('09-video-phone');
  await next();

  console.log('Save and finish later');
  ok((await stepTitle()) === 'Certification', 'Certification');
  ok(!(await visible('.af-save-row [data-save-later]')), 'no row of its own under the questions (they get that room)');
  const navLater = await page.evaluate(() => {
    const later = document.querySelector('.af-nav-later').getBoundingClientRect();
    const back = document.querySelector('[data-back]');
    const b = back.getBoundingClientRect();
    return { inBar: !!document.querySelector('.af-nav-later').closest('[data-nav]') && later.height >= 44, back: Math.round(b.width), name: back.textContent.trim() };
  });
  ok(navLater.inBar, 'it sits in the bar with Back and Continue, at the bottom of every screen');
  ok(navLater.back <= 52 && navLater.name === 'Back', `Back is its arrow there, still named "Back" (${navLater.back}px)`);
  await tap('.af-nav-later');
  await sleep(300);
  ok(await page.$eval('[data-later-dialog]', (d) => d.open), 'the dialog opens');
  ok(await page.$eval('#af-later-email', (e) => e.value) === 'jordan+apply@example.com', 'with the parent email filled in');
  const topEl = await page.evaluate(() => { const r = document.querySelector('[data-later-dialog] h2').getBoundingClientRect(); return document.elementFromPoint(r.left + 10, r.top + 5)?.closest('dialog') != null; });
  ok(topEl, 'the dialog sits on top of the header (nothing covers its heading)');
  await page.click('[data-later-form] button[type=submit]');
  await sleep(800);
  ok((await page.$eval('[data-later-status]', (e) => e.textContent)).length > 0, 'sending reports back (no email service locally)');
  await shot('10-save-later-phone');
  await page.keyboard.press('Escape');

  console.log('Review');
  await type('#af-signature', 'Jordan Test');
  await next();
  ok((await stepTitle()) === 'Review and submit', 'review page');
  const rows = await page.$$eval('[data-review] .af-review-section', (els) => els.map((e) => ({ open: e.hasAttribute('data-open'), sum: e.querySelector('.af-review-sum').textContent })));
  ok(rows.length >= 8 && rows.every((r) => !r.open), `each step is one row, closed (${rows.length})`);
  ok(rows.some((r) => /Avery Test/.test(r.sum)) && rows.some((r) => /Video uploaded/.test(r.sum)), `with its answers in a line (${rows.map((r) => r.sum).slice(2, 4).join(' | ')})`);
  await tap('[data-review-all]');
  ok(await page.$$eval('[data-review] .af-review-section', (els) => els.every((e) => e.hasAttribute('data-open'))), '"Show all answers" opens every step');
  const reviewText = await page.$eval('[data-review]', (e) => e.innerText);
  ok(/Avery Test/.test(reviewText) && /\(404\) 555-0123/.test(reviewText) && /Video uploaded/.test(reviewText) && /April 2, 2017/.test(reviewText), 'review lists the answers');
  ok(/Everything is here/.test(await page.$eval('[data-review-summary]', (e) => e.textContent)), '"Everything is here"');
  ok(!(await page.$eval('[data-next]', (b) => b.disabled)), 'Submit is ready');
  ok(await page.$$eval('[data-review] .af-review-change', (els) => els.length) >= 20, 'every answer has a Change beside it');
  await shot('11-review-phone');
  // The same review on a computer-sized screen (touch kept, so the page doesn't reload)
  await page.setViewport({ width: 1280, height: 1000, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await sleep(300);
  await page.$eval('[data-form]', (el) => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await page.evaluate(() => window.scrollBy(0, -110));
  await shot('11-review-desktop');
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.evaluate(() => [...document.querySelectorAll('[data-review] .af-review-edit')].find((b) => /Diagnosis/.test(b.getAttribute('aria-label'))).click());
  await sleep(400);
  ok((await stepTitle()) === 'Diagnosis', 'Edit jumps to that page');
  ok(await page.evaluate(() => document.activeElement?.id) === 'af-diagnosisImpact', 'and puts the cursor in its first question');
  ok(/Back to review/.test(await page.$eval('[data-next]', (e) => e.textContent)), 'Next now says "Back to review"');
  await clear('#af-diagnosisImpact');
  await page.$eval('[data-steps]', (d) => { d.open = true; });
  await sleep(100);
  await tap('[data-steps-list] [data-goto="review"]');
  await sleep(400);
  ok((await stepTitle()) === 'Review and submit', 'All steps jumps straight to review');
  ok(/1 required answer still needs you/.test(await page.$eval('[data-review-summary]', (e) => e.textContent)), '"1 required answer still needs you"');
  ok(/Not answered yet/.test(await page.$eval('[data-review]', (e) => e.innerText)), 'the missing one says "Not answered yet"');
  ok(await page.$eval('[data-next]', (b) => b.disabled), 'Submit waits');
  ok(/every required answer/.test(await page.$eval('[data-nav-note]', (e) => (e.hidden ? '' : e.textContent))), 'with the reason beside it');
  await shot('12-review-missing-phone');
  await tap('.af-review-missing [data-edit]');
  await sleep(400);
  ok((await stepTitle()) === 'Diagnosis' && await page.evaluate(() => document.activeElement?.id) === 'af-diagnosisImpact', '"Answer it" goes to the question');
  await page.type('#af-diagnosisImpact', 'Bathing takes two adults.');
  await next();
  ok((await stepTitle()) === 'Review and submit', '"Back to review" goes straight back');
  ok(/Everything is here/.test(await page.$eval('[data-review-summary]', (e) => e.textContent)) && !(await page.$eval('[data-next]', (b) => b.disabled)), 'and Submit is ready again');

  console.log('Submit');
  await next();
  await page.waitForSelector('[data-done]:not([hidden])', { timeout: 15000 });
  ok(/jordan\+apply@example.com/.test(await page.$eval('[data-done-email]', (e) => e.textContent)), 'thank-you names the email that gets the copy');
  ok(await page.$eval('[data-done] a[href="/kids/"]', (a) => /Meet some of the kids/.test(a.textContent)), 'and links to the kids');
  ok(await page.$eval('[data-done]', (e) => e.classList.contains('is-in')) && await visible('.af-sun'), 'the sun mark shows');
  ok(await page.evaluate(() => document.activeElement?.matches('[data-done-title]')), 'focus moves to the thank-you');
  ok(await page.evaluate(() => localStorage.getItem('soard-application-draft') === null), 'the draft is forgotten on this device');
  await shot('13-done-phone');
  await page.setViewport({ width: 1280, height: 900, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await sleep(300);
  await page.$eval('[data-done]', (el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await shot('13-done-desktop');
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  console.log('Reminder opt-out link');
  const started = await page.evaluate(async () => (await (await fetch('/api/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start', year: document.querySelector('[data-application]').dataset.year }) })).json()).token);
  await page.goto(`${SITE}/apply/form/?resume=${started}&reminders=off`, { waitUntil: 'networkidle0' });
  await sleep(400);
  ok(/won't get any more reminder emails/.test(await page.$eval('[data-notice]', (e) => e.textContent)), 'the link resumes and says reminders are off');
  ok(!/resume=/.test(await page.url()), 'the token leaves the address bar');
  if (PAGES_DIR) ok(/"reminders_off":\s*1/.test(d1(`SELECT reminders_off FROM application_drafts WHERE id = '${started}'`)), 'and the draft stops its reminders');
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(400);
  ok(/Welcome back/.test(await page.$eval('[data-notice]', (e) => e.textContent)), 'the reminders note shows once');

  console.log('Tap targets and narrow screens');
  await page.evaluate(() => localStorage.clear());
  await page.setViewport({ width: 360, height: 780, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.goto(`${SITE}/apply/form/`, { waitUntil: 'networkidle0' });
  const tooSmall = () => page.$$eval('[data-application] button:not([hidden]), [data-application] .af-choice, [data-application] summary', (els) => els
    .filter((e) => e.getClientRects().length && !e.closest('[hidden]') && !e.closest('dialog:not([open])'))
    .map((e) => [e.textContent.trim().slice(0, 30), Math.round(e.getBoundingClientRect().height)])
    .filter(([, h]) => h < 44));
  let small = await tooSmall();
  ok(small.length === 0, `the overview's buttons are at least 44px tall${small.length ? ` (${JSON.stringify(small)})` : ''}`);
  await noSideScroll('360px, the overview');
  await begin();
  await page.$eval('[data-steps]', (d) => { d.open = true; });
  await sleep(150);
  small = await tooSmall();
  ok(small.length === 0, `buttons and choices are at least 44px tall${small.length ? ` (${JSON.stringify(small)})` : ''}`);
  await page.$eval('[data-steps]', (d) => { d.open = false; });
  await noSideScroll('360px, welcome');
  await tap('[data-lang-switch] [data-lang="es"]');
  await sleep(200);
  await noSideScroll('360px, welcome in Spanish');
  await tap('[data-lang-switch] [data-lang="en"]');
  await page.close();

  console.log('Spanish from the browser language');
  const esCtx = await browser.createBrowserContext();
  const es = await newTab({ context: esCtx });
  await es.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'language', { get: () => 'es-MX' });
    Object.defineProperty(navigator, 'languages', { get: () => ['es-MX', 'es'] });
  });
  await es.goto(`${SITE}/apply/form/`, { waitUntil: 'networkidle0' });
  ok(/Esto es todo lo que le preguntaremos/.test(await es.$eval('[data-hub-title]', (e) => e.textContent)), 'a Spanish browser starts in Spanish (the overview too)');
  await begin(es);
  ok((await stepTitle(es)) === 'Antes de comenzar', 'and the application');
  await reach('[data-field="ackParameters"]', es);
  await es.click('[data-next]');
  await sleep(300);
  ok(/Marque la casilla/.test(await errorText('ackParameters', es)), 'its notes are Spanish too');
  await esCtx.close();

  console.log('Motion');
  const mCtx = await browser.createBrowserContext();
  for (const reduced of [false, true]) {
    const m = await newTab({ context: mCtx, reduced, phone: false });
    await m.goto(`${SITE}/apply/form/`, { waitUntil: 'networkidle0' });
    await m.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await m.reload({ waitUntil: 'networkidle0' });
    await begin(m);
    // Watch <html>: af-vt while a screen change runs, af-vt-back going back
    await m.evaluate(() => {
      window.__vt = [];
      new MutationObserver(() => { const c = document.documentElement.classList; if (c.contains('af-vt')) window.__vt.push(c.contains('af-vt-back') ? 'back' : 'next'); })
        .observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    });
    const part = await partText(m);
    await m.click('[data-next]');
    await sleep(600);
    const after = await partText(m);
    const runs = await m.evaluate(() => window.__vt.splice(0));
    if (!reduced) ok(runs.includes('next') && after !== part, `Continue: the next screen slides in (a view transition, ${part} → ${after})`);
    else ok(runs.length === 0 && after !== part, 'reduced motion: the next screen, with no slide');
    ok(await m.evaluate(() => !document.documentElement.classList.contains('af-vt')), 'and nothing is left mid-transition');
    await m.click('[data-back]');
    await sleep(600);
    const backRuns = await m.evaluate(() => window.__vt.splice(0));
    if (!reduced) {
      ok(backRuns.includes('back') && (await partText(m)) === part, 'Back slides the other way');
      ok(await m.evaluate(() => document.activeElement?.matches('[data-step-title]')), 'focus lands on the step heading after the slide');
      const press = await m.$eval('.af-choice', (e) => getComputedStyle(e).transitionProperty);
      ok(/transform/.test(press), 'choices have a press');
      // The browser's Back: a screen back on the same page, then out to the overview (no reload)
      await m.evaluate(() => { window.__same = true; document.addEventListener('astro:before-preparation', () => { window.__same = false; }); });
      await m.click('[data-next]');
      await sleep(600);
      await m.mouse.click(5, 400);
      await m.goBack({ waitUntil: 'networkidle0', timeout: 3000 }).catch(() => {});
      await sleep(600);
      ok((await partText(m)) === part && await m.evaluate(() => window.__same === true && document.documentElement.classList.contains('af-focus')), "the browser's Back goes a screen back, on the same page");
      await m.mouse.click(5, 400);
      await m.goBack({ waitUntil: 'networkidle0', timeout: 3000 }).catch(() => {});
      await sleep(600);
      ok(await m.evaluate(() => window.__same === true && !document.documentElement.classList.contains('af-focus') && !!document.querySelector('[data-hub]').offsetParent), 'and from the first screen, out to the overview');
    } else {
      ok(backRuns.length === 0 && (await partText(m)) === part, 'reduced motion: Back does not slide either');
      const press = await m.evaluate(() => { const e = document.querySelector('.af-choice'); return getComputedStyle(e).transitionDuration; });
      ok(press.split(',').every((d) => parseFloat(d) < 0.001), `reduced motion: choices change instantly (${press})`);
    }
    await m.close();
  }
  await mCtx.close();

  console.log('Save and exit');
  const xCtx = await browser.createBrowserContext();
  const x = await newTab({ context: xCtx });
  await x.goto(`${SITE}/apply/form/`, { waitUntil: 'networkidle0' });
  await x.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await x.reload({ waitUntil: 'networkidle0' });
  await begin(x);
  await tap('[data-field="ackParameters"] .af-choice', x);
  await tap('[data-field="ackSeason"] .af-choice', x);
  await x.click('[data-next]');
  await sleep(700);
  ok((await stepTitle(x)) === AREA, 'on to the second step');
  await x.evaluate(() => { window.__same = true; document.addEventListener('astro:before-preparation', () => { window.__same = false; }); });
  await x.click('[data-exit]');
  await sleep(500);
  ok(await x.evaluate(() => window.__same === true), 'Save and exit keeps the page (the site router does not load it again)');
  const out = await x.evaluate(() => ({
    focus: document.documentElement.classList.contains('af-focus'),
    header: !!document.querySelector('#site-header')?.getClientRects().length,
    title: document.querySelector('[data-hub-title]').textContent,
    lead: document.querySelector('[data-hub-lead]').textContent,
    go: document.querySelector('[data-hub-go]').textContent.trim(),
    first: document.querySelector('[data-hub-list] .af-hub-row')?.dataset.state,
    now: document.querySelector('[data-hub-list] .af-hub-row[data-state="now"] strong')?.textContent,
    notice: document.querySelector('[data-notice]:not([hidden])')?.textContent || '',
    cta: document.querySelector('[data-hero-cta]').textContent,
    tab: document.title,
  }));
  ok(!out.focus && out.header, 'Save and exit: back to the page, the site header with it');
  ok(/saved/i.test(out.title) && /1 of 9 steps done/.test(out.lead) && /Continue where you left off/.test(out.go), `the overview says what's done and offers to carry on ("${out.lead}")`);
  ok(out.first === 'done' && out.now === AREA, 'the first step is checked and the one they were on is marked');
  ok(/Saved/.test(out.notice) && /Continue my application/.test(out.cta) && !/^Step /.test(out.tab), `with a "Saved" note, and the hero button says Continue (${JSON.stringify({ notice: out.notice, cta: out.cta, tab: out.tab })})`);
  await shot('15-overview-saved-phone', x);
  await x.click('[data-hub-go]');
  await sleep(500);
  ok((await stepTitle(x)) === AREA && await x.evaluate(() => document.documentElement.classList.contains('af-focus')), 'Continue where you left off goes straight back in');
  await xCtx.close();

  console.log('Live preview for the form editor (page rules too)');
  const pv = await newTab({ phone: false });
  await pv.goto(`${SITE}/apply/`, { waitUntil: 'networkidle0' });
  const DEF = {
    schema: 2, title: 'Test form {year}',
    pages: [
      { id: 'one', title: 'First page', fields: [{ id: 'who', type: 'radio', required: true, label: 'Is there a ramp?', options: ['Yes', 'No'] }] },
      { id: 'two', title: 'Ramp page', showIf: { field: 'who', in: ['Yes'] }, fields: [{ id: 'rampNote', type: 'text', label: 'Tell us about the ramp' }] },
      { id: 'three', title: 'Last page', fields: [{ id: 'age', type: 'number', label: 'How old is the home?', rules: { min: 1, integer: true } }, { id: 'later', type: 'text', label: 'Anything else?' }] },
    ],
    stops: {},
    i18n: { es: { strings: { 'page:one': 'Primera página', 'field:who:label': '¿Hay una rampa?', 'field:who:option:Yes': 'Sí' } } },
  };
  await pv.evaluate((site) => new Promise((resolve) => {
    window.__msgs = [];
    window.addEventListener('message', (e) => { window.__msgs.push(e.data); if (e.data?.type === 'afe-preview-ready') resolve(); });
    const f = document.createElement('iframe');
    f.id = 'pv';
    f.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:99999;background:#fff;border:0';
    f.src = `${site}/apply/form/?preview=live`;
    document.body.append(f);
    setTimeout(resolve, 15000);
  }), SITE);
  ok(await pv.evaluate(() => window.__msgs.some((m) => m?.type === 'afe-preview-ready')), 'the preview tells the editor it is ready');
  const frame = pv.frames().find((f) => /preview=live/.test(f.url()));
  const post = (data) => pv.evaluate((d, site) => document.getElementById('pv').contentWindow.postMessage(d, site), data, SITE);
  ok(/Live preview/.test(await frame.$eval('[data-notice]', (e) => e.textContent)), 'the preview notice shows');
  ok(await frame.evaluate(() => document.documentElement.classList.contains('af-focus')), 'it shows the application on its own screen, as families see it');
  await tap('[data-field="ackParameters"] .af-choice', frame);
  await post({ type: 'afe-preview', definition: DEF });
  await sleep(300);
  ok((await stepTitle(frame)) === 'First page', 'a posted definition redraws the form');
  ok(/Step 1 of 3/.test(await stepText(frame)), 'a page shown only for some answers is left out of the count');
  await pick('who', 'No', frame);
  await frame.click('[data-next]');
  await sleep(350);
  ok((await stepTitle(frame)) === 'Last page' && /Step 2 of 3/.test(await stepText(frame)), 'Next skips the hidden page');
  await type('#af-age', '2.5', frame);
  await frame.click('#af-later');
  await sleep(100);
  ok(/whole number/.test(await errorText('age', frame)), 'answer rules (a whole number) are checked');
  await frame.click('[data-back]');
  await sleep(350);
  await pick('who', 'Yes', frame);
  ok(/Step 1 of 4/.test(await stepText(frame)), 'answering "Yes" adds the page');
  await frame.click('[data-next]');
  await sleep(350);
  ok((await stepTitle(frame)) === 'Ramp page', 'and Next goes to it');
  await type('#af-rampNote', 'Kept through edits', frame);
  await post({ type: 'afe-preview', definition: DEF, focus: 'later' });
  await sleep(500);
  ok((await stepTitle(frame)) === 'Last page' && await frame.$eval('[data-field="later"]', (e) => !e.closest('[data-off]')), 'focus on a question goes to its page, and the screen it is on');
  ok(await frame.$eval('[data-field="later"]', (e) => e.classList.contains('af-flash')), 'and outlines it for a moment');
  ok(await frame.$eval('#af-rampNote', (e) => e.value) === 'Kept through edits', 'answers typed so far survive a redraw');
  await post({ type: 'afe-preview', definition: DEF, lang: 'es', focus: 'one' });
  await sleep(300);
  ok((await stepTitle(frame)) === 'Primera página' && /¿Hay una rampa\?/.test(await frame.$eval('[data-field="who"]', (e) => e.textContent)), 'a language in the message shows that translation');
  ok(await frame.$eval('[data-field="who"] input[value="Yes"]', (i) => i.checked), 'still with the answer picked');
  await pick('who', 'No', frame);
  await frame.click('[data-next]');
  await sleep(350);
  await type('#af-age', '40', frame);
  await frame.click('[data-next]');
  await sleep(350);
  await frame.click('[data-next]');
  await sleep(300);
  ok(/vista previa/i.test(await frame.$eval('[data-nav-note]', (e) => e.textContent)), 'Submit in a preview sends nothing');
  await pv.close();

  console.log('Desktop');
  const dCtx = await browser.createBrowserContext();
  const desk = await newTab({ context: dCtx, phone: false });
  await desk.goto(`${SITE}/apply/form/`, { waitUntil: 'networkidle0' });
  await desk.evaluate(() => localStorage.clear());
  await desk.reload({ waitUntil: 'networkidle0' });
  ok(await desk.$eval('[data-field="ackParameters"] .af-choice', (e) => getComputedStyle(e).minHeight) !== '', 'desktop loads');
  await begin(desk);
  // A computer: each screen fits between the bar across the top and Continue (the reading screens aside)
  const fits = [];
  for (let i = 0; i < 3; i++) {
    fits.push(await desk.evaluate(() => ({ part: document.querySelector('[data-part-text]').textContent, over: document.documentElement.scrollHeight - innerHeight, reading: !document.querySelector('[data-page]:not([hidden]) > :not([data-off]) :is(input, select, textarea)') })));
    if (i < 2) { await desk.click('[data-next]'); await sleep(500); }
  }
  ok(fits.filter((f) => !f.reading).every((f) => f.over <= 0), `screens with questions fit with no scrolling (${fits.map((f) => `${f.part}: ${f.over}px`).join(', ')})`);
  await desk.click('[data-field="ackParameters"] .af-choice');
  await desk.click('[data-field="ackSeason"] .af-choice');
  await desk.click('[data-next]');
  await sleep(400);
  const deskToken = await draftToken(desk);
  // Straight to the video page: the draft's furthest page lets the steps list jump there
  await desk.evaluate((tk) => localStorage.setItem('soard-application-draft', JSON.stringify({ token: tk, year: '2027', furthest: 'video' })), deskToken);
  await desk.evaluate(async (tk) => { await fetch('/api/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'save', token: tk, answers: { ackParameters: "Yes, I have read and understand SOARD's makeover parameters.", ackSeason: 'Yes, I have read and understand the above statement.' }, page: 'video' }) }); }, deskToken);
  await desk.reload({ waitUntil: 'networkidle0' });
  await sleep(400);
  ok((await stepTitle(desk)) === 'Video', 'resumes on the video page');
  // A computer: every step beside the card (in place of "All steps"), time left, saving, and help
  const rail = await desk.evaluate(() => ({
    shown: !!document.querySelector('[data-rail]').offsetParent,
    dropdown: !!document.querySelector('[data-steps]').offsetParent,
    now: document.querySelector('[data-rail-list] [aria-current="step"]')?.textContent || '',
    open: [...document.querySelectorAll('[data-rail-list] .af-step')].filter((b) => !b.disabled).length,
    left: document.querySelector('[data-time-left]').textContent,
    sub: document.querySelector('[data-rail-list] [data-goto="welcome"] .af-step-sub')?.textContent || '',
  }));
  ok(rail.shown && !rail.dropdown, 'on a computer the steps sit beside the step (no "All steps")');
  ok(rail.sub === 'Agreed', `a done step shows its answers in a line ("${rail.sub}")`);
  ok(/Video/.test(rail.now) && rail.open >= 8, `the rail marks this step and opens the ones reached (${rail.open})`);
  ok(/minutes? left/.test(rail.left), `and says about how long is left ("${rail.left}")`);
  await reach('[data-field="video"]', desk);
  ok(await visible('[data-field="video"] .af-drag-hint', desk), 'computers are told they can drag a file in');
  const canRecord = await visible('[data-field="video"] [data-act="record"]', desk);
  if (!canRecord) {
    notes.push('Recorder not offered: this server\'s Permissions-Policy turns the camera off for /apply/form/ (public/_headers).');
    console.log('  - recorder skipped: camera blocked by Permissions-Policy');
  } else {
    await desk.click('[data-field="video"] [data-act="record"]');
    await desk.waitForFunction(() => !document.querySelector('[data-field="video"] [data-act="rec-toggle"]').disabled, { timeout: 8000 });
    ok(await desk.$eval('.af-recorder-view', (v) => v.readyState >= 2 || !!v.srcObject), 'the camera preview shows');
    const layout = await desk.evaluate(() => {
      const v = document.querySelector('.af-recorder-view').getBoundingClientRect();
      const bar = document.querySelector('.af-recorder-bar').getBoundingClientRect();
      return { videoBottom: v.bottom, barTop: bar.top };
    });
    ok(layout.barTop >= layout.videoBottom, 'every control sits under the picture, none on it');
    await desk.click('[data-act="rec-toggle"]');
    await sleep(1600);
    ok(/Recording 0:0[1-9]/.test(await desk.$eval('.af-recorder-time', (e) => e.textContent)), 'a timer runs while recording');
    await shot('14-recorder-desktop', desk);
    await desk.click('[data-act="rec-toggle"]');
    await desk.waitForFunction(() => document.querySelector('[data-field="video"] .af-upload')?.dataset.state === 'done', { timeout: 30000 });
    ok(/recording-/.test(await desk.$eval('[data-field="video"] .af-upload-status', (e) => e.textContent)), '"Stop and use this video" uploads the recording');
    await desk.evaluate(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('No', 'NotAllowedError')); });
    await desk.click('[data-field="video"] [data-act="record"]');
    await sleep(300);
    ok(/couldn't use your camera/.test(await desk.$eval('[data-field="video"] .af-upload-status', (e) => e.textContent)), 'a blocked camera says so');
  }
  await desk.click('[data-rail-list] [data-goto="welcome"]');
  await sleep(400);
  ok((await stepTitle(desk)) === 'Before You Begin', 'a step in the rail goes straight to it');
  // A staff test run's link (?test=1) without the admin sign-in: only a bar saying to sign in.
  // (Signed in, the whole run is covered by tests/application-test-run.test.mjs on the server side.)
  await desk.goto(`${SITE}/apply/form/?test=1`, { waitUntil: 'networkidle0' });
  await sleep(400);
  ok(await visible('[data-testbar]', desk) && /for SOARD staff/.test(await desk.$eval('[data-testbar-text]', (e) => e.textContent)), 'a test-run link without the admin sign-in says test runs are for staff');
  ok(await visible('[data-test-signin]', desk) && !(await visible('[data-form]', desk)) && !(await visible('[data-test-fill]', desk)), 'with the way to sign in, and no form or sample answers');
  await dCtx.close();

  console.log('Screenshots: phone and desktop, light and dark, English and Spanish');
  for (const phone of [true, false]) {
    for (const dark of [false, true]) {
      for (const l of ['en', 'es']) {
        const ctx = await browser.createBrowserContext();
        const s = await newTab({ context: ctx, phone, reduced: true, bypassCsp: true });
        await s.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
        await s.evaluateOnNewDocument((lang) => { try { localStorage.setItem('soard-application-lang', JSON.stringify(lang)); } catch {} }, l);
        await s.goto(`${SITE}/apply/form/`, { waitUntil: 'networkidle0' });
        const tag = `${phone ? 'phone' : 'desktop'}-${dark ? 'dark' : 'light'}-${l}`;
        await s.setViewport({ ...(phone ? { width: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { width: 1280, deviceScaleFactor: 1 }), height: 1500 });
        await shot(`20-hero-${tag}`, s);
        await s.$eval('#application', (el) => el.scrollIntoView());
        await sleep(200);
        await shot(`21-overview-${tag}`, s);
        await s.setViewport({ ...(phone ? { width: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { width: 1280, deviceScaleFactor: 1 }), height: phone ? 844 : 860 });
        await begin(s);
        await shot(`21-welcome-${tag}`, s);
        await tap('[data-field="ackParameters"] .af-choice', s);
        await tap('[data-field="ackSeason"] .af-choice', s);
        await s.click('[data-next]');
        await sleep(400);
        await s.focus('#af-address-line1');
        await s.type('#af-address-line1', '3167 Main');
        const listed = await s.waitForSelector('#af-address-suggest:not([hidden])', { timeout: 8000 }).then(() => true).catch(() => false);
        if (listed) { await s.keyboard.press('ArrowDown'); await s.keyboard.press('Enter'); }
        else { await s.keyboard.press('Escape'); await type('#af-address-line1', '3167 Main St', s); await type('#af-address-city', 'Duluth', s); await type('#af-address-zip', '30096', s); }
        await s.waitForFunction(() => document.querySelector('[data-area]')?.dataset.area === 'inside', { timeout: 15000 }).catch(() => {});
        await sleep(700);
        await s.evaluate(() => window.scrollTo(0, 0));
        await sleep(150);
        await shot(`22-area-${tag}`, s);
        await tap('[data-field="resides50"] .af-choice', s);
        await s.click('[data-next]');
        await sleep(400);
        await s.click('[data-next]');
        await sleep(300);
        await shot(`23-basic-errors-${tag}`, s);
        await s.$eval('[data-steps]', (d) => { d.open = true; });
        await s.evaluate(() => window.scrollTo(0, 0));
        await sleep(200);
        await shot(`24-steps-${tag}`, s);
        await ctx.close();
      }
    }
  }
} catch (e) {
  failures.push(`crashed: ${e.message}`);
  console.error(e);
  await shot('crash').catch(() => {});
}

ok(consoleErrors.length === 0, `no console errors${consoleErrors.length ? `: ${consoleErrors.slice(0, 3).join(' | ')}` : ''}`);
d1('DELETE FROM application_form_rules');
await browser.close();
for (const n of notes) console.log(`  note: ${n}`);
console.log(failures.length ? `\n${failures.length} failed` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
