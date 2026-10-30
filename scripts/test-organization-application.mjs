/**
 * test-organization-application.mjs — an organization applies for a community project, in a real browser
 * ======================================================================================================
 * Drives /apply/community-project/ against the real Pages Functions (wrangler pages dev with local
 * D1 + R2), at phone size (390px), then checks it on a computer (1280px):
 *   - the hero and closed card speak to an organization (no child, no family, no "notify me"),
 *     English only (no language switch)
 *   - the overview of the steps, then the application on its own screen (Start); each step a
 *     screen at a time
 *   - page 1 checks, a draft starts on Continue, kept apart from a family's draft in this browser
 *   - the address placed on the service-area map (the real Census, through the server), the
 *     county filled in
 *   - the organization's questions, a follow-up ("Something else"), the second contact tucked
 *     behind a button until wanted, the spaces (choose up to two), photos of the space
 *   - review, submit, the thank-you linking to the community projects
 *   - local D1: the application is an organization's, named for it, its contact's email
 *   - the Apply page's organizations band and the Community page's link lead here
 *   - nothing wider than the screen; no console errors
 * Screenshots land in test-results/organization-application/.
 *
 *   SITE=http://127.0.0.1:8795 PAGES_DIR=<dir with the local wrangler.toml> node scripts/test-organization-application.mjs
 *
 * After a deploy, the same run on the live site is the self-test: a "TEST …" organization (its
 * JobTread account archives itself), at SOARD's office address, every email to ORG_EMAIL:
 *   SITE=https://sunshineonaranneyday.com ORG_EMAIL=<a plus-address of yours> OFFICE=1 node scripts/test-organization-application.mjs
 *
 * Local server: the same as scripts/test-application-form.mjs (a scratch dir with dist/,
 * functions/, a wrangler.toml without the AI, Browser and LIVE_HUB bindings, and site_config
 * "settings" in local D1). The organization form is open unless application.orgOpen is false.
 */
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/organization-application/');
mkdirSync(OUT, { recursive: true });
const SITE = (process.env.SITE || 'http://127.0.0.1:8795').replace(/\/$/, '');
const PAGES_DIR = process.env.PAGES_DIR;
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCAL = !/sunshineonaranneyday\.com/.test(SITE);

const PHOTO = join(OUT, 'photo.jpg');
writeFileSync(PHOTO, await sharp({ create: { width: 2400, height: 1800, channels: 3, background: { r: 120, g: 170, b: 210 } } }).jpeg({ quality: 85 }).toBuffer());
// The address lookup is answered here (the real one asks Photon, slow from a laptop); the map check asks the real Census
const SUGGESTION = process.env.OFFICE
  ? { line1: '250 Hembree Park Drive', city: 'Roswell', state: 'GA', zip: '30076', county: 'Fulton', label: '250 Hembree Park Drive, Roswell, GA 30076' }
  : { line1: '3167 Main St', city: 'Duluth', state: 'GA', zip: '30096', county: 'Gwinnett', label: '3167 Main St, Duluth, GA 30096' };
const CONTACT_EMAIL = process.env.ORG_EMAIL || 'jordan+org@example.com';
const reEsc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 'shell': screenshots keep working while the Mac's display sleeps
const browser = await puppeteer.launch({ headless: 'shell', args: ['--disable-gpu', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] });
const consoleErrors = [];
async function newTab({ phone = true } = {}) {
  const page = await browser.newPage();
  if (phone) await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  else await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() !== 'error' || /favicon|cloudflareinsights|Failed to load resource/.test(t)) return;
    if (LOCAL && /violates the following Content Security Policy/.test(t) && /sunshineonaranneyday\.com\/cdn-cgi\/imagedelivery/.test(t)) return;
    if (LOCAL && /\/api\/live-ws/.test(t)) return;
    consoleErrors.push(t);
  });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url().startsWith(`${SITE}/api/apply?address=`)) {
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, results: [SUGGESTION] }) });
    }
    req.continue();
  });
  return page;
}

let page = await newTab();
const shot = async (name, p = page) => { await p.screenshot({ path: join(OUT, `${name}.png`) }); };
const visible = (sel, p = page) => p.$eval(sel, (el) => !!el && !el.closest('[hidden]') && el.getClientRects().length > 0).catch(() => false);
const stepTitle = (p = page) => p.$eval('[data-step-title]', (el) => el.textContent.trim());
const next = async (p = page) => { await p.$eval('[data-next]', (e) => e.scrollIntoView({ block: 'center', behavior: 'instant' })); await p.click('[data-next]'); await sleep(450); };
const partText = (p = page) => p.$eval('[data-part-text]', (el) => el.textContent.trim());
/** A step shows its questions a screen at a time: Continue until the one with this question shows */
const reach = async (sel, p = page) => {
  for (let i = 0; i < 8; i++) {
    const where = await p.evaluate((s) => { const el = document.querySelector(s); return !el ? 'none' : el.closest('[data-off]') ? 'later' : 'here'; }, sel);
    if (where !== 'later') return;
    const was = `${await stepTitle(p)}|${await partText(p)}`;
    await next(p);
    if (`${await stepTitle(p)}|${await partText(p)}` === was) throw new Error(`Continue was held up on the way to ${sel}`);
  }
};
const onTo = async (title, p = page) => { for (let i = 0; i < 8 && (await stepTitle(p)) !== title; i++) await next(p); };
const pick = async (field, value, p = page) => {
  await reach(`[data-field="${field}"]`, p);
  await p.evaluate((f, v) => {
    const input = [...document.querySelectorAll(`[data-field="${f}"] input`)].find((i) => i.value === v);
    input.click();
  }, field, value);
};
const center = async (sel, p) => { await reach(sel, p); await p.$eval(sel, (e) => e.scrollIntoView({ block: 'center', behavior: 'instant' })); };
const type = async (sel, text, p = page) => { await center(sel, p); await p.click(sel, { clickCount: 3 }); await p.type(sel, text); };
const noSideScroll = async (label, p = page) => {
  const wide = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(wide <= 1, `${label}: nothing wider than the screen (${wide}px over)`);
};
const d1 = (sql) => (PAGES_DIR ? JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'soard-db', '--local', '--json', '--command', sql], { cwd: PAGES_DIR, encoding: 'utf8' }))[0]?.results || [] : []);

try {
  console.log('Open');
  await page.goto(`${SITE}/apply/community-project/`, { waitUntil: 'networkidle0' });
  ok(/Tell us about your organization/.test(await page.$eval('.hero-headline', (e) => e.textContent)), 'the hero speaks to an organization');
  ok(/For Schools, Clinics & Nonprofits/.test(await page.$eval('.hero-eyebrow', (e) => e.textContent)), 'and names who it is for');
  ok(/children reached/.test(await page.$eval('.hero-stat-label', (e) => e.textContent)), 'the stat is children reached through partnerships');
  ok(!(await visible('[data-lang-switch], .af-lang:not(.af-notify-lang)')), 'English only: no language switch');
  ok(!(await page.$('[data-notify]')), 'no family "notify me" form on the page');
  ok(await page.$eval('[data-application]', (e) => e.dataset.kind) === 'organization', 'the form knows it is an organization’s');
  const heroText = await page.$eval('.hero', (e) => e.innerText);
  ok(!/your child|your family/i.test(heroText), 'nothing about a child or a family in the hero');
  ok(await page.$eval('.hero-ctas a[data-af-t="heroFaq"]', (a) => a.getAttribute('href') === '/community/#projects' && /See our community projects/.test(a.textContent)).catch(() => false), 'its second button shows the community projects, not the makeover FAQ');
  // The season as the live settings have it, everywhere the page names it (not the year it was built with)
  const season = await page.$eval('[data-application]', (e) => e.dataset.year);
  const named = await page.evaluate(() => [document.title, ...['og:title', 'twitter:title', 'og:image:alt', 'twitter:image:alt'].map((k) => document.querySelector(`meta[property="${k}"], meta[name="${k}"]`)?.content || ''), document.querySelector('.hero-eyebrow').textContent]);
  ok(named.every((t) => t.includes(season) && !(t.match(/\b20\d\d\b/g) || []).some((y) => y !== season)), `the title, link previews and eyebrow all say ${season} (${named[0]})`);
  const ld = await page.$$eval('script[type="application/ld+json"]', (els) => els.map((e) => e.textContent).join(''));
  ok(ld.includes(`"${season} Community Project Application`) && ld.includes('"Community project application"'), 'and so does the search data, with the page named as a community project application');
  await shot('01-open-phone');
  await noSideScroll('open');

  console.log('Before You Begin');
  ok(await visible('[data-hub]') && /Your Organization/.test(await page.$eval('[data-hub-list]', (e) => e.textContent)), "the overview lists the organization's steps");
  await page.click('[data-hero-cta]');
  await sleep(400);
  ok(await page.evaluate(() => document.documentElement.classList.contains('af-focus')), 'Start: the application has the screen to itself');
  ok(await stepTitle() === 'Before You Begin', 'page 1');
  ok(/^2\d{3} Community Project Application$/.test(await page.$eval('[data-top] .af-top-title', (e) => e.textContent)), 'the bar across the top names the community project application');
  await pick('ackParameters', 'Yes, I understand.');
  await pick('ackSeason', 'Yes, I have read and understand the above statement.');
  await next();
  ok(await stepTitle() === 'Location', 'a draft starts and Location follows');
  const stored = await page.evaluate(() => ({ org: localStorage.getItem('soard-application-draft-organization'), family: localStorage.getItem('soard-application-draft') }));
  ok(!!JSON.parse(stored.org || '{}').token && !stored.family, 'its draft is kept apart from a family’s in this browser');

  console.log('Location');
  ok(/Address of the space/.test(await page.$eval('[data-field="address"] .af-label, [data-field="address"] legend', (e) => e.textContent)), 'the address of the space, not a home');
  ok(/Suite, building or room/.test(await page.$eval('#af-address-line2', (e) => e.closest('label').textContent).catch(() => '')), 'its second line asks for a suite, building or room (not an apartment)');
  await page.focus('#af-address-line1');
  await page.type('#af-address-line1', SUGGESTION.line1.slice(0, 9));
  await page.waitForSelector('#af-address-suggest:not([hidden]) [role="option"]', { timeout: 4000 }).catch(() => {});
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => ['inside', 'near', 'far', 'unknown', 'error'].includes(document.querySelector('[data-area]')?.dataset.area), { timeout: 20000 }).catch(() => {});
  const area = await page.$eval('[data-area]', (e) => e.dataset.area).catch(() => '');
  ok(area === 'inside', `the address is placed on the map: ${area}`);
  ok(await page.$eval('#af-county', (e) => e.value) === SUGGESTION.county, 'and the county is filled in');
  const legend = await page.$eval('[data-area-map]', (e) => e.textContent).catch(() => '');
  ok(/The address you entered/.test(legend) && !/The home you entered/.test(legend), 'the map speaks of an address, not a home');
  await shot('02-location-phone');
  await onTo('Your Organization');

  console.log('Your Organization');
  ok(await stepTitle() === 'Your Organization', 'Your Organization');
  await type('#af-orgName', 'TEST Sunnyside Academy');
  await pick('orgType', 'Something else');
  ok(await visible('#af-orgTypeOther'), '"Something else" asks what kind');
  await type('#af-orgTypeOther', 'A therapeutic preschool');
  await pick('orgStatus', 'Yes, a 501(c)(3) nonprofit');
  await type('#af-website', 'https://example.org');
  await type('#af-mission', 'We teach children with autism, ages 3 to 12.');
  await type('#af-childrenServed', '120');
  await type('#af-agesServed', '3 to 12');
  await type('#af-needsServed', 'Most have autism; some have Down syndrome.');
  await pick('previouslyApplied', 'No');
  await shot('03-organization-phone');
  await noSideScroll('organization');
  await onTo('Contact');

  console.log('Contact');
  ok(await stepTitle() === 'Contact', 'Contact');
  await type('#af-contactName-first', 'Jordan');
  await type('#af-contactName-last', 'Lee');
  ok(await page.$eval('#af-contactName-first', (e) => e.autocomplete) === 'given-name', 'the contact’s own name autofills');
  await type('#af-contactTitle', 'Executive Director');
  await type('#af-contactEmail', CONTACT_EMAIL);
  ok(await page.$eval('#af-contactEmail', (e) => e.autocomplete) === 'email', 'and the email');
  await type('#af-contactPhone', '(404) 555-0123');
  await reach('[data-more="contact2"]');
  ok(await visible('[data-more="contact2"] [data-more-open]') && !(await visible('#af-contact2Name-first')), 'the second contact waits behind a button');
  ok(/Add another contact at your organization/.test(await page.$eval('[data-more="contact2"] [data-more-open]', (e) => e.textContent)), 'that says what it adds');
  await page.click('[data-more="contact2"] [data-more-open]');
  await sleep(200);
  ok(await visible('#af-contact2Name-first'), 'the button opens the second contact');
  await type('#af-contact2Name-first', 'Sam');
  await type('#af-contact2Name-last', 'Park');
  await pick('building', 'We lease it');
  ok(await visible('[data-field="ownerApproval"]'), 'leasing asks whether the owner would approve');
  await pick('ownerApproval', 'Yes');
  await pick('approver', 'Yes, I can approve it');
  await shot('04-contact-phone');
  await onTo('The Space');

  console.log('The Space');
  ok(await stepTitle() === 'The Space', 'The Space');
  await pick('spaceTypes', 'Sensory room');
  await pick('spaceTypes', 'Classroom or learning space');
  const left = await page.$$eval('[data-field="spaceTypes"] input', (els) => els.filter((i) => i.disabled).length);
  ok(left > 0, 'choose up to two: the rest wait');
  await type('#af-spaceToday', 'An empty classroom with harsh lights and worn carpet.');
  await type('#af-spaceDream', 'A calm place to regulate, so students can get back to learning.');
  await type('#af-childrenUsing', '40');
  for (const f of ['photoSpace1', 'photoSpace2']) {
    await reach(`#af-${f}`);
    await (await page.$(`#af-${f}`)).uploadFile(PHOTO);
    await page.waitForFunction((id) => document.querySelector(`[data-field="${id}"] .af-upload`)?.dataset.state === 'done', { timeout: 30000 }, f).catch(() => {});
    ok(await page.$eval(`[data-field="${f}"] .af-upload`, (e) => e.dataset.state) === 'done', `${f} uploads`);
  }
  await shot('05-space-phone');
  await noSideScroll('space');
  await onTo('Certification');

  console.log('Review and submit');
  ok(await stepTitle() === 'Certification', 'Certification');
  await type('#af-signature', 'Jordan Lee');
  await next();
  ok(await stepTitle() === 'Review and submit', 'review page');
  await page.click('[data-review-all]');
  await sleep(150);
  const review = await page.$eval('[data-review]', (e) => e.innerText);
  ok(/TEST Sunnyside Academy/.test(review) && /Executive Director/.test(review) && /Sensory room/.test(review), 'review lists the answers');
  ok(/Everything is here/.test(await page.$eval('[data-review-summary]', (e) => e.textContent)), '"Everything is here"');
  await next();
  await page.waitForSelector('[data-done]:not([hidden])', { timeout: 20000 }).catch(async (e) => {
    const why = await page.evaluate(() => ({ note: document.querySelector('[data-nav-note]')?.textContent, notice: document.querySelector('[data-notice]:not([hidden])')?.textContent, title: document.querySelector('[data-step-title]')?.textContent, busy: document.querySelector('[data-next]')?.getAttribute('aria-busy') }));
    throw new Error(`no thank-you after Submit (${JSON.stringify(why)})`);
  });
  ok(new RegExp(reEsc(CONTACT_EMAIL)).test(await page.$eval('[data-done-email]', (e) => e.textContent)), 'the thank-you names the email that gets the copy');
  ok(await page.$eval('[data-done] a[href="/community/"]', (a) => /community projects/i.test(a.textContent)).catch(() => false), 'and links to the community projects');
  const done = await page.$eval('[data-done]', (e) => e.innerText);
  ok(/A visit to see the space/.test(done) && !/your child|your home/i.test(done), 'what happens next, for an organization');
  await shot('06-done-phone');

  if (PAGES_DIR) {
    const [row] = d1("SELECT kind, child_name, parent_name, parent_email, is_test FROM applications ORDER BY submitted_at DESC LIMIT 1");
    ok(row?.kind === 'organization' && row.child_name === 'TEST Sunnyside Academy' && row.parent_email === CONTACT_EMAIL, `the application is the organization’s (${JSON.stringify(row)})`);
    ok(row?.is_test === 1, 'a TEST name makes it a rehearsal');
  }

  console.log('Computer');
  const desk = await newTab({ phone: false });
  await desk.evaluate(() => localStorage.clear()).catch(() => {});
  await desk.goto(`${SITE}/apply/community-project/`, { waitUntil: 'networkidle0' });
  await desk.evaluate(() => localStorage.removeItem('soard-application-draft-organization'));
  await desk.reload({ waitUntil: 'networkidle0' });
  await desk.click('[data-hero-cta]');
  await sleep(400);
  ok(await visible('.af-rail', desk) || await visible('[data-rail-list]', desk), 'the steps sit beside the form');
  const rail = await desk.$$eval('[data-rail-list] li', (els) => els.map((e) => e.textContent.trim())).catch(() => []);
  ok(rail.some((t) => /Your Organization/.test(t)) && rail.some((t) => /The Space/.test(t)), `and name the organization’s pages (${rail.length})`);
  await shot('07-open-desktop', desk);
  await noSideScroll('desktop', desk);

  console.log('The ways in');
  await desk.goto(`${SITE}/apply/`, { waitUntil: 'networkidle0' });
  ok(await desk.$eval('#organizations a[href="/apply/community-project/"]', (a) => /Apply for Your Organization/.test(a.textContent)).catch(() => false), 'the Apply page has a way in for organizations');
  await desk.$eval('#organizations', (e) => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await sleep(400);
  await shot('08-apply-band-desktop', desk);
  await desk.goto(`${SITE}/community/`, { waitUntil: 'networkidle0' });
  ok(await desk.$eval('.hero-ctas a[href="/apply/community-project/"]', (a) => /Apply for Your Organization/.test(a.textContent) && a.getBoundingClientRect().top < innerHeight).catch(() => false), 'the Community page hero has the apply button, above the fold');
  ok(await desk.$eval('#apply a[href="/apply/community-project/"]', (a) => /Apply for Your Organization/.test(a.textContent)).catch(() => false), 'and its own apply section under the projects');
  ok(await desk.$$eval('#apply .apply-steps li', (els) => els.length).catch(() => 0) === 3, 'which says what happens, in three steps');
  ok(await desk.$eval('.np-cta a', (a) => a.getAttribute('href') === '/apply/community-project/' && /Apply for a community project/.test(a.textContent)).catch(() => false), 'and the partners list links to the application, not an email');
  await page.goto(`${SITE}/apply/`, { waitUntil: 'networkidle0' });
  await page.$eval('#organizations', (e) => e.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await sleep(400);
  await shot('09-apply-band-phone');
  await noSideScroll('Apply page on a phone');
  await page.goto(`${SITE}/community/`, { waitUntil: 'networkidle0' });
  ok(await page.$eval('.hero-ctas a[href="/apply/community-project/"]', (a) => a.getBoundingClientRect().height > 0).catch(() => false), 'the Community page hero shows the apply button on a phone');
  await page.$eval('#apply', (e) => e.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await sleep(400);
  await shot('10-community-apply-phone');
  await noSideScroll('Community page on a phone');

  ok(!consoleErrors.length, `no console errors (${consoleErrors.join(' | ').slice(0, 400)})`);
} catch (e) {
  failures.push(`crashed: ${e.stack || e}`);
  console.error(e);
} finally {
  await browser.close();
}
console.log(failures.length ? `\n${failures.length} failed:\n- ${failures.join('\n- ')}` : '\nAll checks passed.');
process.exit(failures.length ? 1 : 0);
