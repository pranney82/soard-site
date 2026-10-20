/**
 * test-application-form.mjs — fill in the makeover application in a real browser
 * ===============================================================================
 * Drives /apply/form/ against the real Pages Functions (wrangler pages dev with
 * local D1 + R2), at phone size (390px) with desktop screenshots too:
 *   - page 1 checks (both boxes), then a draft starts on Next
 *   - the "outside the area" stop screen with the map, and going back
 *   - follow-up questions appearing (boundary, conviction, sensory)
 *   - every question type: name, date, address, select, radio, checkbox (max 2
 *     disables the rest), textarea, signature
 *   - photos resized in the browser and stored (R2), with previews
 *   - the video upload UI; Stream itself is faked (no credentials locally):
 *     tus requests are answered here and the draft's video is marked uploaded
 *     in local D1, so the server's own checks still run on submit
 *   - reload resumes on the same page with every answer back
 *   - Save and finish later dialog (on top of the header)
 *   - review page with Edit links, submit, thank-you screen
 *   - nothing wider than the screen; 44px tap targets; no console errors
 *
 *   SITE=http://127.0.0.1:8791 PAGES_DIR=<dir with the local wrangler.toml> node scripts/test-application-form.mjs
 *
 * Local server (once): a scratch dir with symlinks to dist/ and functions/, a
 * wrangler.toml without the AI and LIVE_HUB bindings, and site_config
 * "settings" = {"application":{"open":true,"year":"2027"}} in local D1.
 */
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/application-form/');
mkdirSync(OUT, { recursive: true });
const SITE = (process.env.SITE || 'http://127.0.0.1:8791').replace(/\/$/, '');
const PAGES_DIR = process.env.PAGES_DIR;
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Test files: a big landscape photo (exercises the resize) and a small "video"
const PHOTO = join(OUT, 'photo.jpg');
writeFileSync(PHOTO, await sharp({ create: { width: 4032, height: 3024, channels: 3, background: { r: 255, g: 218, b: 36 } } }).jpeg({ quality: 90 }).toBuffer());
const VIDEO = join(OUT, 'clip.mp4');
writeFileSync(VIDEO, Buffer.alloc(300 * 1024, 7));

const browser = await puppeteer.launch({
  headless: true,
  args: ['--disable-gpu', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
// Instant scrolling, so a tap never lands mid-scroll (people wait; scripts don't)
await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
const consoleErrors = [];
// Locally, 'self' isn't sunshineonaranneyday.com, so every page's absolute image URLs trip the CSP; not a real error
const LOCAL = !/sunshineonaranneyday\.com/.test(SITE);
page.on('console', (m) => {
  const t = m.text();
  if (m.type() !== 'error' || /favicon|cloudflareinsights|Failed to load resource/.test(t)) return;
  if (LOCAL && /violates the following Content Security Policy/.test(t) && /sunshineonaranneyday\.com\/cdn-cgi\/imagedelivery/.test(t)) return;
  if (LOCAL && /\/api\/live-ws/.test(t)) return; // the sitewide live indicator; no live hub in a local server
  consoleErrors.push(t);
});
page.on('pageerror', (e) => consoleErrors.push(e.message));

// Fake Stream: answer the tus upload and the two video calls; everything else is real
await page.setRequestInterception(true);
let videoBytes = 0;
page.on('request', async (req) => {
  const url = req.url();
  if (url.startsWith('https://upload.videodelivery.net/')) {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Expose-Headers': 'Upload-Offset, Upload-Length, Tus-Resumable, Location, stream-media-id' };
    if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: cors });
    if (req.method() === 'HEAD') return req.respond({ status: 200, headers: { ...cors, 'Upload-Offset': '0', 'Upload-Length': String(videoBytes), 'Tus-Resumable': '1.0.0' } });
    if (req.method() === 'PATCH') return req.respond({ status: 204, headers: { ...cors, 'Upload-Offset': String(videoBytes), 'Tus-Resumable': '1.0.0' } });
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
        execFileSync('wrangler', ['d1', 'execute', 'soard-db', '--local', '--command',
          `UPDATE application_drafts SET files = json_set(files, '$.video', json('{"uid":"fakevid","uploaded":true,"size":${videoBytes},"name":"clip.mp4"}')) WHERE id = '${body.token}'`], { cwd: PAGES_DIR, stdio: 'ignore' });
      }
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, uploaded: true }) });
    }
  }
  req.continue();
});

const shot = async (name) => {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
};
const visible = (sel) => page.$eval(sel, (el) => !!el && !el.closest('[hidden]') && el.getClientRects().length > 0).catch(() => false);
const stepTitle = () => page.$eval('[data-step-title]', (el) => el.textContent.trim());
const next = async () => { await page.click('[data-next]'); await sleep(450); };
const pick = (field, value) => page.evaluate((f, v) => {
  const input = [...document.querySelectorAll(`[data-field="${f}"] input`)].find((i) => i.value === v);
  input.click();
}, field, value);
const type = async (sel, text) => { await page.click(sel, { clickCount: 3 }); await page.type(sel, text); };
const setDate = (field, v) => page.$eval(`#af-${field}`, (el, val) => { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
const selectOpt = (field, v) => page.select(`#af-${field}`, v);
const noSideScroll = async (label) => {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(wide <= 1, `${label}: nothing wider than the screen (${wide}px over)`);
};

try {
  console.log('Open');
  await page.goto(`${SITE}/apply/form/`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });
  ok(await visible('[data-form]'), 'the form shows (applications are open in local D1)');
  ok(!(await visible('[data-closed]')), 'the closed card is hidden');
  ok((await stepTitle()) === 'Before You Begin', 'starts on Before You Begin');
  const YEAR = await page.$eval('[data-application]', (el) => el.dataset.year);
  const AREA = 'Makeover Service Area Notice';
  await shot('01-hero-phone');
  await page.$eval('#application', (el) => el.scrollIntoView());
  await shot('02-welcome-phone');
  await noSideScroll('welcome');

  console.log('Page 1 checks');
  await next();
  const ackErrors = await page.$$eval('[data-field^="ack"] .af-error', (els) => els.map((e) => e.textContent));
  ok(ackErrors.length === 2 && ackErrors.every((t) => /check the box/.test(t)), 'both acknowledgments are required');
  ok(await page.evaluate(() => document.activeElement?.closest('[data-field]')?.dataset.field === 'ackParameters'), 'focus moves to the first problem');
  await page.click('[data-field="ackParameters"] .af-choice');
  await page.click('[data-field="ackSeason"] .af-choice');
  await next();
  ok((await stepTitle()) === AREA, 'on to the service area');
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem('soard-application-draft') || '{}').token);
  ok(/^[0-9a-f]{32}$/.test(token || ''), 'a draft started and its token is kept on this device');

  console.log('Stop screen');
  await pick('boundary', 'No, it is not within the boundary nor is it close.');
  await next();
  ok(await visible('[data-stop]'), 'outside the area: the stop screen shows');
  ok(await visible('[data-stop-map] img'), 'with the service area map');
  await shot('03-stop-outside');
  await page.click('[data-stop-back]');
  ok(await visible('[data-form]') && (await stepTitle()) === AREA, '"I need to change my answer" goes back');
  await pick('boundary', 'No, but it is close to the boundary.');
  ok(await visible('#af-boundaryWhere'), 'close to the boundary asks where');
  await type('#af-boundaryWhere', 'Just south of Sandy Springs');
  await next();

  console.log('Basic Information');
  ok((await stepTitle()) === 'Basic Information', 'Basic Information');
  await type('#af-childName-first', 'Avery');
  await type('#af-childName-last', 'Test');
  await setDate('birthdate', '2017-04-02');
  await pick('gender', 'Female');
  await type('#af-diagnosis', 'Cerebral palsy');
  await type('#af-address-line1', '1 Test Way');
  await type('#af-address-city', 'Marietta');
  await type('#af-address-zip', '3006');
  await selectOpt('county', 'Cobb');
  await pick('resides50', 'Yes');
  await pick('previouslyApplied', 'No');
  await type('#af-referredBy', 'Our therapist');
  await next();
  ok(/5-digit ZIP/.test(await page.$eval('[data-field="address"] .af-error', (e) => e.textContent)), 'a short ZIP is caught');
  await type('#af-address-zip', '30067');
  await next();
  await shot('04-parents-phone');

  console.log('Parents, and resume after a reload');
  ok((await stepTitle()) === "Parents' Information", "Parents' Information");
  await type('#af-parentName-first', 'Jordan');
  await type('#af-parentName-last', 'Test');
  await type('#af-parentEmail', 'jordan@example');
  await type('#af-parentPhone', '404555012');
  await type('#af-parentRelation', 'Mother');
  await pick('ownership', 'Yes, at least one person living in the home is the owner.');
  await next();
  const pErr = await page.$$eval('[data-field^="parent"] .af-error', (els) => els.map((e) => e.textContent).filter(Boolean));
  ok(pErr.some((t) => /valid email/.test(t)) && pErr.some((t) => /10-digit/.test(t)), 'email and phone formats are checked');
  await type('#af-parentEmail', 'jordan+apply@example.com');
  await type('#af-parentPhone', '(404) 555-0123');
  await pick('ownership', 'No, the property is rented.');
  await next();
  ok(await visible('[data-stop]') && /must own their home/.test(await page.$eval('[data-stop]', (e) => e.textContent)), 'renters get the "must own the home" screen');
  await page.click('[data-stop-back]');
  await pick('ownership', 'Yes, at least one person living in the home is the owner.');
  await next();
  ok((await stepTitle()) === 'Diagnosis', 'Diagnosis');
  await sleep(800);
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(500);
  ok((await stepTitle()) === 'Diagnosis', 'a reload resumes on the same page');
  ok(/Welcome back/.test(await page.$eval('[data-notice]', (e) => e.textContent)), 'with a welcome-back note');
  const restored = await page.evaluate(() => [document.querySelector('#af-childName-first').value, document.querySelector('#af-parentEmail').value, document.querySelector('#af-county').value]);
  ok(restored[0] === 'Avery' && restored[1] === 'jordan+apply@example.com' && restored[2] === 'Cobb', 'answers come back');

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
  await type('#af-otherChildren', 'No');
  await next();
  ok((await stepTitle()) === "Child's Info", 'photos are required before moving on');
  for (const f of ['photoChild', 'photoFamily']) {
    const input = await page.$(`#af-${f}`);
    await input.uploadFile(PHOTO);
    await page.waitForFunction((id) => document.querySelector(`[data-field="${id}"] .af-upload`)?.dataset.state === 'done', { timeout: 20000 }, f);
  }
  ok(await page.$eval('[data-field="photoChild"] .af-upload-preview', (e) => /url\(/.test(e.style.backgroundImage)), 'photo preview shows');
  await next();

  console.log('Home and Space');
  ok((await stepTitle()) === 'Home and Space', 'Home and Space');
  ok(/zero-entry shower/.test(await page.$eval('[data-field="makeoverTypes"]', (e) => e.textContent)), 'makeover choices carry their descriptions');
  await pick('makeoverTypes', 'Accessible Bathroom');
  await pick('makeoverTypes', 'Dream Bedroom');
  const disabled = await page.$$eval('[data-field="makeoverTypes"] input', (els) => els.filter((e) => e.disabled).map((e) => e.value));
  ok(disabled.length === 2 && disabled.includes('Ramp'), 'two picked: the other two are disabled');
  await shot('05-makeover-phone');
  await type('#af-makeoverWhy', 'The bathroom, so she can bathe safely.');
  await type('#af-positiveImpact', 'It would change our days.');
  for (const f of ['photoSpace1', 'photoSpace2']) {
    const input = await page.$(`#af-${f}`);
    await input.uploadFile(PHOTO);
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
  await next();
  ok(/upload your video/.test(await page.$eval('[data-field="video"] .af-error', (e) => e.textContent)), 'the video is required');
  const vinput = await page.$('#af-video');
  await vinput.uploadFile(VIDEO);
  await page.waitForFunction(() => document.querySelector('[data-field="video"] .af-upload')?.dataset.state === 'done', { timeout: 30000 });
  ok(/Video uploaded/.test(await page.$eval('[data-field="video"] .af-upload-status', (e) => e.textContent)), 'the video uploads with progress and a done state');
  await shot('06-video-phone');
  await next();

  console.log('Save and finish later');
  ok((await stepTitle()) === 'Certification', 'Certification');
  await page.click('[data-save-later]');
  await sleep(300);
  ok(await page.$eval('[data-later-dialog]', (d) => d.open), 'the dialog opens');
  ok(await page.$eval('#af-later-email', (e) => e.value) === 'jordan+apply@example.com', 'with the parent email filled in');
  const topEl = await page.evaluate(() => { const r = document.querySelector('[data-later-dialog] h2').getBoundingClientRect(); return document.elementFromPoint(r.left + 10, r.top + 5)?.closest('dialog') != null; });
  ok(topEl, 'the dialog sits on top of the header (nothing covers its heading)');
  await page.click('[data-later-form] button[type=submit]');
  await sleep(800);
  ok((await page.$eval('[data-later-status]', (e) => e.textContent)).length > 0, 'sending reports back (no email service locally)');
  await shot('07-save-later-phone');
  await page.keyboard.press('Escape');

  console.log('Finish, review, submit');
  await type('#af-signature', 'Jordan Test');
  await next();
  ok((await stepTitle()) === 'Review and submit', 'review page');
  const reviewText = await page.$eval('[data-review]', (e) => e.innerText);
  ok(/Avery Test/.test(reviewText) && /\(404\) 555-0123/.test(reviewText) && /Video uploaded/.test(reviewText), 'review lists the answers');
  await shot('08-review-phone');
  await page.evaluate(() => [...document.querySelectorAll('[data-review] .af-btn--link')].find((b) => /Diagnosis/.test(b.getAttribute('aria-label'))).click());
  await sleep(300);
  ok((await stepTitle()) === 'Diagnosis', 'Edit jumps to that page');
  for (let i = 0; i < 5; i++) await next();
  ok((await stepTitle()) === 'Review and submit', 'and Next walks back to review');
  await next();
  await page.waitForSelector('[data-done]:not([hidden])', { timeout: 15000 });
  ok(/jordan\+apply@example.com/.test(await page.$eval('[data-done-email]', (e) => e.textContent)), 'thank-you names the email that gets the copy');
  ok(await page.evaluate(() => localStorage.getItem('soard-application-draft') === null), 'the draft is forgotten on this device');
  await shot('09-done-phone');

  console.log('Tap targets');
  await page.goto(`${SITE}/apply/form/`, { waitUntil: 'networkidle0' });
  const small = await page.$$eval('[data-application] button:not([hidden]), [data-application] .af-choice', (els) => els
    .filter((e) => e.getClientRects().length && !e.closest('[hidden]'))
    .map((e) => [e.textContent.trim().slice(0, 30), Math.round(e.getBoundingClientRect().height)])
    .filter(([, h]) => h < 44));
  ok(small.length === 0, `buttons and choices are at least 44px tall${small.length ? ` (${JSON.stringify(small)})` : ''}`);

  console.log('Desktop');
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${SITE}/apply/form/`, { waitUntil: 'networkidle0' });
  await shot('10-hero-desktop');
  await page.$eval('#application', (el) => el.scrollIntoView());
  await sleep(200);
  await shot('11-form-desktop');
} catch (e) {
  failures.push(`crashed: ${e.message}`);
  console.error(e);
  await shot('crash').catch(() => {});
}

ok(consoleErrors.length === 0, `no console errors${consoleErrors.length ? `: ${consoleErrors.slice(0, 3).join(' | ')}` : ''}`);
await browser.close();
console.log(failures.length ? `\n${failures.length} failed` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
