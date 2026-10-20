/**
 * test-applications-admin.mjs — drive Admin → Applications in a real browser
 * ===========================================================================
 * The admin page comes from a local server (SITE, e.g. wrangler pages dev on
 * dist/); every /api/applications-admin call is answered by the REAL handler
 * (functions/api/applications-admin.js) running here in Node against an
 * in-memory D1, so saves, problems, Put live and history are the real thing.
 * Checks, at 1440px and 390px:
 *   - Form: the draft bar, a locked JobTread question (reword yes, delete no,
 *     relabel a choice keeps its saved value), Put live, adding questions and a
 *     show-when rule, choices that follow their wording until live, moving and
 *     deleting, a page with JobTread questions can't be deleted
 *   - problems block Put live and jump to the question
 *   - Messages: placeholders, preview, a broken message is caught
 *   - the phone preview frame shows the draft
 *   - History: restore the built-in form
 *   - Applications tab, and Site Config's "Manage applications" link
 *   - phone: nothing wider than the screen
 * Screenshots in test-results/applications-admin/. Exits non-zero on failure.
 *
 *   SITE=http://127.0.0.1:8791 node scripts/test-applications-admin.mjs
 */
import puppeteer from 'puppeteer';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import * as adminApi from '../functions/api/applications-admin.js';
import { getDraftForm, getLiveForm, clearFormCache } from '../functions/api/_application-forms.js';
import { resolveForm } from '../functions/api/_application-form.js';
import { publicForm } from '../functions/api/apply.js';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/applications-admin/');
mkdirSync(OUT, { recursive: true });
const SITE = (process.env.SITE || 'http://127.0.0.1:8791').replace(/\/$/, '');
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The server side, for real, on an in-memory D1 ──
const DB = await createD1();
await DB.exec(`CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)`);
await DB.prepare("INSERT INTO site_config (key, data) VALUES ('settings', ?)").bind(JSON.stringify({ application: { open: false, year: '2027' } })).run();
await DB.exec(`CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)`);
const env = { DB };
const settings = JSON.parse(readFileSync(join(ROOT, 'src/content/site/settings.json'), 'utf8'));

async function answer(req) {
  const url = new URL(req.url());
  const json = (o, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(o) });
  if (url.pathname === '/api/applications-admin') {
    clearFormCache();
    const request = new Request(`https://admin.test${url.pathname}${url.search}`, { method: req.method(), body: req.method() === 'POST' ? req.postData() : undefined, headers: { 'content-type': 'application/json' } });
    const ctx = { env, request, data: { userEmail: 'peter@soardcharity.com' } };
    const res = req.method() === 'POST' ? await adminApi.onRequestPost(ctx) : await adminApi.onRequestGet(ctx);
    return req.respond({ status: res.status, contentType: res.headers.get('content-type') || 'application/json', body: Buffer.from(await res.arrayBuffer()) });
  }
  if (url.pathname === '/api/apply' && url.searchParams.has('config')) {
    // The preview frame: signed-in staff get the draft
    clearFormCache();
    const draft = url.searchParams.get('preview') === 'draft' ? await getDraftForm(DB) : null;
    const live = await getLiveForm(DB, { fresh: true });
    const form = draft ? resolveForm(draft.definition, { year: '2027', version: draft.version }) : resolveForm(live.definition, { year: '2027', version: live.version });
    return json({ ok: true, open: false, year: '2027', preview: !!draft, turnstileSiteKey: null, form: publicForm(form) });
  }
  if (url.pathname === '/api/read-content') return json({ success: true, content: JSON.stringify(settings), sha: 'x' });
  if (url.pathname === '/api/list-content') return json({ success: true, items: [], count: 0, total: 0, pages: 1 });
  if (url.pathname.startsWith('/api/pending-changes')) return json({ success: true, changes: [], publish: { live: null, active: null, failed: null } });
  if (url.pathname.startsWith('/api/live-ws')) return req.abort();
  if (url.pathname.startsWith('/api/')) return json({ success: true, ok: true });
  return false;
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');
const browser = await puppeteer.launch({ headless: true, args: ['--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });

async function open(width, height, hash) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: width < 500 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|Content Security Policy|live-ws/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    if (req.isInterceptResolutionHandled()) return;
    try {
      if (new URL(req.url()).origin === SITE && (await answer(req)) !== false) return;
      if (req.resourceType() === 'image' && /imagedelivery/.test(req.url())) return req.respond({ status: 200, contentType: 'image/png', body: PNG });
      req.continue();
    } catch (e) { errors.push(`mock: ${e.message}`); req.continue().catch(() => {}); }
  });
  await page.goto(`${SITE}/admin/index.html${hash}`, { waitUntil: 'networkidle2' });
  return { page, errors };
}

const text = (page, sel) => page.$eval(sel, (e) => e.innerText).catch(() => '');
const clickText = (page, sel, re) => page.evaluate((s, src) => {
  const r = new RegExp(src);
  const el = [...document.querySelectorAll(s)].find((x) => r.test(x.textContent));
  if (el) { el.click(); return true; }
  return false;
}, sel, re.source);
const waitSaved = async (page) => { await page.waitForFunction(() => /Draft saved/.test(document.querySelector('.afe-bar')?.innerText || ''), { timeout: 8000 }).catch(() => {}); };
// Select everything in the box (a triple click only selects one line of a textarea), then type over it
const typeInto = async (page, sel, value) => { await page.click(sel); await page.$eval(sel, (el) => el.select()); await page.keyboard.press('Backspace'); await page.type(sel, value); };

try {
  console.log('Form tab (desktop)');
  const { page, errors } = await open(1440, 1000, '#applications/form');
  await page.waitForSelector('.afe-bar', { timeout: 20000 });
  ok(/Families see the built-in form/.test(await text(page, '.afe-bar')), 'starts on the built-in form, nothing pending');
  ok((await page.$$('.afe-panel[aria-label^="Page"]')).length === 9, 'nine pages, as in Jotform');
  await page.screenshot({ path: join(OUT, '01-form-desktop.png') });

  console.log('A locked JobTread question');
  ok(await clickText(page, '.afe-row', /Child's Gender/), 'pick Child\'s Gender');
  await sleep(200);
  ok(/JobTread: Gender/.test(await text(page, '.afe-inspector')), 'it says what it feeds');
  ok(!(await clickText(page, '.afe-inspector button', /Delete this question/)), 'and it has no Delete');
  await typeInto(page, '.afe-inspector input[aria-label="Choice 2"]', 'Girl');
  await waitSaved(page);
  ok(/Saved as "Female"/.test(await text(page, '.afe-inspector')), 'a reworded choice keeps its saved value');
  ok(/changes that aren't live yet/.test(await text(page, '.afe-bar')), 'the change is a draft');
  ok(/Female/.test(JSON.stringify((await getDraftForm(DB)).definition)), 'stored with value Female, label Girl');

  console.log('Put live');
  ok(await clickText(page, '.afe-bar button', /^Put live$/), 'Put live');
  await page.waitForFunction(() => /Families see version/.test(document.querySelector('.afe-bar')?.innerText || ''), { timeout: 8000 }).catch(() => {});
  ok(/Families see version \d+/.test(await text(page, '.afe-bar')), 'families now see the new version');
  ok(/Girl/.test(JSON.stringify((await getLiveForm(DB, { fresh: true })).definition)), 'live in D1');

  console.log('New questions and a show-when rule');
  await page.select('#afe-add-2', 'radio');
  await sleep(200);
  await typeInto(page, '#afe-f-label', 'Do you have pets?');
  await typeInto(page, '.afe-inspector input[aria-label="Choice 1"]', 'Yes');
  await typeInto(page, '.afe-inspector input[aria-label="Choice 2"]', 'No');
  await waitSaved(page);
  let draft = (await getDraftForm(DB)).definition;
  const pets = draft.pages[2].fields.at(-1);
  ok(pets.label === 'Do you have pets?' && JSON.stringify(pets.options) === '["Yes","No"]', 'new choices follow their wording until live');
  await page.select('#afe-add-2', 'text');
  await sleep(200);
  await typeInto(page, '#afe-f-label', 'What kind of pets?');
  await page.select('.afe-inspector select[aria-label="Show only when this question is answered"]', pets.id);
  await sleep(150);
  await page.evaluate(() => [...document.querySelectorAll('.afe-inspector .afe-pick label')].find((l) => /Yes/.test(l.textContent))?.click());
  await waitSaved(page);
  draft = (await getDraftForm(DB)).definition;
  const kind = draft.pages[2].fields.at(-1);
  ok(JSON.stringify(kind.showIf) === JSON.stringify({ field: pets.id, in: ['Yes'] }), 'show "What kind of pets?" only when pets = Yes');
  await page.screenshot({ path: join(OUT, '02-new-question.png') });

  console.log('Renaming a choice a rule depends on keeps the rule');
  ok(await clickText(page, '.afe-row', /Do you have pets\?/), 'back to the pets question');
  await sleep(150);
  await typeInto(page, '.afe-inspector input[aria-label="Choice 1"]', 'Yes, we do');
  await waitSaved(page);
  draft = (await getDraftForm(DB)).definition;
  ok(JSON.stringify(draft.pages[2].fields.at(-1).showIf.in) === '["Yes, we do"]', 'the rule follows the renamed choice');

  console.log('Pages');
  ok(await clickText(page, '.afe-title', /Basic Information/), 'pick the Basic Information page');
  await sleep(150);
  ok(await page.$eval('.afe-inspector .afe-danger', (b) => b.disabled), 'a page with JobTread questions can\'t be deleted');

  console.log('Problems block Put live');
  ok(await clickText(page, '.afe-row', /Do you have pets\?/), 'pets again');
  await sleep(150);
  await page.evaluate(() => { const b = document.querySelector('.afe-inspector button[aria-label="Remove choice 1"]'); b?.click(); });
  await waitSaved(page);
  // the text question's rule now points at nothing
  ok(/needs at least one answer picked/.test(await text(page, '.afe-problems')), 'a rule with no answer left is listed as a problem');
  ok(await page.$eval('.afe-bar .btn-primary', (b) => b.disabled), 'and Put live is off');
  await page.screenshot({ path: join(OUT, '03-problems.png') });
  await page.evaluate(() => document.querySelector('.afe-problems button')?.click());
  await sleep(200);
  ok(/Show only when/.test(await text(page, '.afe-inspector')) && /What kind of pets/.test(await page.$eval('#afe-f-label', (e) => e.value)), 'the problem link opens that question');
  await page.select('.afe-inspector select[aria-label="Show only when this question is answered"]', '');
  await waitSaved(page);
  ok(!(await page.$('.afe-problems')), 'fixed: no problems');

  console.log('Preview');
  ok(await clickText(page, '.afe-bar button', /^Preview$/), 'open the phone preview');
  await page.waitForSelector('.afe-preview iframe', { timeout: 5000 });
  const frame = await (await page.$('.afe-preview iframe')).contentFrame();
  await frame.waitForSelector('[data-notice]:not([hidden])', { timeout: 15000 }).catch(() => {});
  ok(/Preview of your unpublished form changes/.test(await frame.$eval('[data-notice]', (e) => e.textContent).catch(() => '')), 'the frame shows the draft as families would see it');
  await page.screenshot({ path: join(OUT, '04-preview.png') });

  console.log('Messages');
  await clickText(page, '.hub-tab', /^Messages$/);
  await page.waitForSelector('#afe-m-approved');
  await typeInto(page, '#afe-m-approved', 'Great news, {parent}! We approved the application.');
  await waitSaved(page);
  ok(/should name the child/.test(await text(page, '.afe-problems')), 'a message without {child} is caught');
  await page.click('#afe-m-approved');
  await page.keyboard.press('End');
  await page.keyboard.type(' ');
  await page.evaluate(() => [...document.querySelectorAll('.afe-chips button')].filter((b) => b.textContent === '{child}')[2]?.click());
  await waitSaved(page);
  ok(!(await page.$('.afe-problems')), 'inserting {child} fixes it');
  await page.screenshot({ path: join(OUT, '05-messages.png') });

  console.log('History');
  ok(await clickText(page, '.afe-bar button', /^Put live$/), 'put the second round live');
  await sleep(800);
  await clickText(page, '.hub-tab', /^History$/);
  await sleep(300);
  const hist = await text(page, '.card');
  ok(/Version \d+ Live/.test(hist.replace(/\s+/g, ' ')) && /Earlier/.test(hist), 'versions listed with live and earlier');
  ok(await clickText(page, '.card button', /Restore as draft/), 'restore an earlier version');
  await sleep(800);
  ok(!!(await getDraftForm(DB)), 'it becomes the draft');

  console.log('Applications tab');
  await clickText(page, '.hub-tab', /^Applications$/);
  await page.waitForFunction(() => /No applications yet|Applications are/.test(document.body.innerText), { timeout: 8000 }).catch(() => {});
  ok(/Applications are closed for the 2027 season/.test(await text(page, '.card')), 'shows open/closed and the season');
  ok(errors.length === 0, `no console errors on desktop${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
  await page.close();

  console.log('Site Config link');
  const sc = await open(1280, 900, '');
  await sc.page.waitForSelector('.nav-item', { timeout: 20000 });
  await clickText(sc.page, '.nav-item', /Site Config/);
  await sleep(500);
  await clickText(sc.page, '.hub-tab', /^Settings$/);
  await sc.page.waitForFunction(() => /Manage applications/.test(document.body.innerText), { timeout: 10000 }).catch(() => {});
  ok(await clickText(sc.page, 'button', /Manage applications/), '"Manage applications" in Site Config');
  await sleep(600);
  ok(await sc.page.$('.afe-tabs') != null, 'opens the Applications area');
  await sc.page.close();

  console.log('Phone');
  const ph = await open(390, 844, '#applications/form');
  await ph.page.waitForSelector('.afe-bar', { timeout: 20000 });
  await clickText(ph.page, '.afe-row', /Child's Name/);
  await sleep(200);
  const wide = await ph.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(wide <= 1, `phone: nothing wider than the screen (${wide}px over)`);
  await ph.page.screenshot({ path: join(OUT, '06-phone.png') });
  ok(ph.errors.length === 0, `no console errors on the phone${ph.errors.length ? `: ${ph.errors.slice(0, 3).join(' | ')}` : ''}`);
  await ph.page.close();
} catch (e) {
  failures.push(`crashed: ${e.message}`);
  console.error(e);
}
await browser.close();
console.log(failures.length ? `\n${failures.length} failed` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
