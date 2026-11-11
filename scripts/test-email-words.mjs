/**
 * test-email-words.mjs — Edit words, in a real browser
 * ===========================================================================
 * Staff's own words in an email the site drafts by itself: the sheet that opens
 * from the gala's recap block and from Monthly Impact in Emails & invites
 * (public/admin/email-words.js). The admin is served as-is from public/ and
 * /api/email-words-admin is answered here by the real email builders, so the
 * preview is the email as it would be drafted:
 *   - the boxes: one per part the email has, each showing the site's own words
 *   - Start from the site's words, and Use the site's words
 *   - the email redrawing as you type, subject and preview line above it
 *   - leaving with words not saved asks first; Save says what happened in Kit
 *   - Put back the site's words; focus back on Edit words when it closes
 *   - a phone: a bottom sheet, nothing wider than the screen, 44px targets
 * Checks axe and console errors. Screenshots in test-results/email-words/.
 *
 *   SITE=http://127.0.0.1:4473 node scripts/test-email-words.mjs   (SITE serves public/)
 */
import puppeteer from 'puppeteer';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { axeScan, axeText } from './lib/axe.mjs';
import { answerAsks } from './lib/ask.mjs';
import { EMAIL_WORDS, WORD_PARTS, cleanWords, parseWordsKey } from '../functions/api/_email-words.js';
import { eventRecapEmail, monthlyImpactEmail } from '../functions/api/_newsletter-email.js';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/email-words/');
mkdirSync(OUT, { recursive: true });
const SITE = (process.env.SITE || 'http://127.0.0.1:4473').replace(/\/$/, '');
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');

const EVENTS = Object.fromEntries(readdirSync(join(ROOT, 'src/content/events')).filter((f) => f.endsWith('.json'))
  .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(ROOT, 'src/content/events', f), 'utf8'))]));
const GALA = '2026-evening-of-sunshine';
const gala = { ...EVENTS[GALA], slug: GALA, theme: 'Havana Nights', photos: Array.from({ length: 6 }, (_, i) => ({ id: `gallery/gala/${i}.jpg`, alt: '' })) };
const KID = { name: 'Isla', slug: 'isla', roomTypes: ['Therapy Room'], photos: [{ url: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/isla/a.jpg/public' }] };
const render = (key, words) => (key.startsWith('recap:')
  ? eventRecapEmail({ event: gala, events: [gala], words })
  : monthlyImpactEmail({ month: '2026-10', today: '2026-11-01', revealed: [{ kid: KID, date: '2026-10-18' }], words }));

const saved = {};
const calls = [];
const posts = [];
async function answer(req) {
  const url = new URL(req.url());
  const p = url.pathname;
  if (url.origin !== SITE || !p.startsWith('/api/')) return false;
  const json = (o, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(o) });
  calls.push(`${req.method()} ${p}${url.search}`);
  if (p === '/api/list-content') {
    const dir = url.searchParams.get('dir');
    const items = dir === 'src/content/events' ? Object.entries(EVENTS).map(([slug, c]) => ({ name: `${slug}.json`, path: `${dir}/${slug}.json`, sha: slug, content: { ...c, slug } })) : [];
    return json({ success: true, items, count: items.length, total: items.length, pages: 1 });
  }
  if (p === '/api/read-content') {
    const m = (url.searchParams.get('path') || '').match(/^src\/content\/events\/(.+)\.json$/);
    return m && EVENTS[m[1]] ? json({ success: true, content: JSON.stringify({ ...EVENTS[m[1]], slug: m[1] }), sha: m[1] }) : json({ success: false, error: 'Not found' }, 404);
  }
  if (p === '/api/newsletter-drafts-admin' && req.method() === 'GET') {
    const key = url.searchParams.get('event') ? `recap:${url.searchParams.get('event')}` : 'monthly:2026-10';
    return json({ ok: true, key, ...(key.startsWith('monthly:') ? { month: '2026-10' } : {}), state: 'draft', id: 9101, at: '2026-11-10T03:39:00Z', url: 'https://app.kit.com/campaigns/9101', block: null, off: null, error: null, title: 'x' });
  }
  if (p === '/api/email-words-admin' && req.method() === 'GET') {
    const key = url.searchParams.get('key');
    const parsed = parseWordsKey(key);
    const words = saved[key] || {};
    return json({ ok: true, key, kind: parsed.kind, what: EMAIL_WORDS[parsed.kind].what, parts: EMAIL_WORDS[parsed.kind].parts.map((k) => ({ key: k, ...WORD_PARTS[k] })),
      words, by: saved[key] ? 'linzi@soardcharity.com' : null, at: saved[key] ? '2026-11-11T15:00:00Z' : null, siteWords: render(key, {}).siteWords, email: (({ subject, preview, html }) => ({ subject, preview, html }))(render(key, words)), block: null, note: null });
  }
  if (p === '/api/email-words-admin' && req.method() === 'POST') {
    const body = JSON.parse(req.postData() || '{}');
    posts.push(body);
    const { kind } = parseWordsKey(body.key);
    const words = cleanWords(kind, body.words);
    const email = (({ subject, preview, html }) => ({ subject, preview, html }))(render(body.key, words));
    if (body.preview) return json({ ok: true, email });
    await sleep(250);
    saved[body.key] = words;
    const none = !Object.keys(words).length;
    return json({ ok: true, words, by: 'linzi@soardcharity.com', at: new Date().toISOString(), result: 'updated', message: none ? 'Saved. The draft in Kit has the site’s own words again.' : 'Saved. The draft in Kit has your words now.', email });
  }
  if (p.startsWith('/api/pending-changes')) return json({ success: true, changes: [], publish: { live: null, active: null, failed: null } });
  if (p === '/api/content-history') return json({ success: true, versions: [], deleted: [] });
  if (p.startsWith('/api/live-ws')) { req.abort(); return true; }
  return json({ success: true, ok: true });
}

const browser = await puppeteer.launch({ headless: 'shell', args: ['--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
const errors = [];
async function open(width, hash, { touch = false, height = 1000 } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1, hasTouch: touch, isMobile: touch });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|Content Security Policy|live-ws/.test(m.text())) errors.push(m.text().slice(0, 300)); });
  await answerAsks(page);
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    if (req.isInterceptResolutionHandled()) return;
    if ((await answer(req)) !== false) return;
    if (/imagedelivery/.test(req.url())) return req.respond({ status: 200, contentType: 'image/png', body: PNG });
    req.continue();
  });
  await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch {} });
  await page.goto(`${SITE}/admin/index.html${hash}`, { waitUntil: 'networkidle2' });
  return page;
}
// The admin's own waits don't fire on every view here: ask the page every 250ms instead
const until = async (page, fn, arg, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await page.evaluate(fn, arg).catch(() => false)) return true; await sleep(250); } return false; };
const sheet = '[role="dialog"][aria-labelledby="ew-title"]';
const press = (page, sel, t) => page.evaluate((sel, t) => { const b = [...document.querySelectorAll(sel)].find((x) => x.textContent.replace(/\s+/g, ' ').trim() === t); b?.click(); return !!b; }, sel, t);
const typeIn = async (page, id, text) => { await page.click(`#${id}`, { clickCount: 3 }); await page.keyboard.press('Backspace'); await page.type(`#${id}`, text); };

try {
  console.log('The gala’s recap: the boxes, the site’s own words, the email as it will go');
  const page = await open(1440, `#events/${GALA}`);
  await until(page, () => [...document.querySelectorAll('[aria-labelledby="er-mail-h"] button')].some((b) => b.textContent.trim() === 'Edit words'), null, 20000);
  ok(await press(page, '[aria-labelledby="er-mail-h"] button', 'Edit words'), 'Edit words beside Open in Kit');
  await until(page, (s) => document.querySelector(`${s} #ew-subject`), sheet);
  ok(calls.includes(`GET /api/email-words-admin?key=recap%3A${GALA}`), 'it reads the gala recap’s words');
  ok((await page.$eval('#ew-title', (e) => e.textContent.trim())) === 'Edit words: the recap email', 'its title');
  const boxes = await page.$$eval(`${sheet} .ew-part`, (els) => els.map((e) => ({ label: e.querySelector('.form-label')?.textContent.trim(), ph: (e.querySelector('input, textarea')?.placeholder || '').slice(0, 60), use: e.querySelector('.ew-use')?.textContent.trim() })));
  ok(JSON.stringify(boxes.map((b) => b.label)) === '["Subject","Preview line","Opening","Give band headline","Give band words","Closing line"]', `one box per part the recap has (${boxes.map((b) => b.label).join(', ')})`);
  ok(boxes[0].ph === 'What a Night! See the Photos from our Evening of Sunshine' && boxes[3].ph === 'Help us build the next *dream*.' && boxes[5].ph === 'Thank you for an unforgettable night.', `each shows the site’s own words (${JSON.stringify(boxes.map((b) => b.ph))})`);
  ok(boxes.every((b) => b.use === 'Start from the site’s words'), 'and offers to start from them');
  const doc0 = await page.$eval(`${sheet} iframe`, (f) => f.srcdoc);
  ok(/Havana Nights/.test(doc0) && /background:#faf3e0/.test(doc0), 'the preview is the gala’s own email, in its own look');
  const axe = await axeScan(page, sheet);
  ok(axe.length === 0, `axe finds nothing (${axeText(axe)})`);
  await page.screenshot({ path: join(OUT, '01-sheet.png') });

  console.log('Typing redraws it; starting from the site’s words');
  await typeIn(page, 'ew-subject', 'Thank you for a magical night');
  ok(await until(page, (s) => /Thank you for a magical night/.test(document.querySelector(`${s} .mm-env-subject`)?.textContent || ''), sheet, 6000), 'the subject above the email follows the box');
  const previews = posts.filter((x) => x.preview);
  ok(previews.length >= 1 && previews.at(-1).words.subject === 'Thank you for a magical night', `a redraw with the words, nothing saved (${previews.length})`);
  ok(!posts.some((x) => !x.preview), 'nothing saved yet');
  ok(await press(page, `${sheet} .ew-part:nth-of-type(6) .ew-use, ${sheet} .ew-use`, 'Start from the site’s words'), 'Start from the site’s words');
  const filled = await page.$eval('#ew-preview', (e) => e.value).catch(() => '');
  ok(/^The photos from Evening of Sunshine 2026/.test(filled), `the box takes the site’s words to change (${filled.slice(0, 60)})`);
  await typeIn(page, 'ew-closing', 'Gracias for a night to remember.');

  console.log('Leaving with words not saved asks first');
  await page.keyboard.press('Escape');
  await sleep(150);
  const ask = await page.$eval(`${sheet} .ew-foot__say`, (e) => e.textContent.trim()).catch(() => '');
  ok(ask === 'Your changes aren’t saved. Close anyway?' && !!(await page.$(sheet)), `Escape asks, and the sheet stays (${ask})`);
  ok(await press(page, `${sheet} .ew-foot button`, 'Keep editing'), 'Keep editing');

  console.log('Save, then Put back the site’s words');
  ok(await press(page, `${sheet} .ew-foot button`, 'Save'), 'Save');
  await until(page, (s) => /has your words now/.test(document.querySelector(`${s} .ew-foot__say`)?.textContent || ''), sheet, 6000);
  const save = posts.filter((x) => !x.preview).at(-1);
  ok(save && JSON.stringify(save.words) === JSON.stringify({ subject: 'Thank you for a magical night', preview: filled, closing: 'Gracias for a night to remember.' }), `it saves the words given, and only those (${JSON.stringify(save)})`);
  ok(save?.key === `recap:${GALA}`, 'under the gala recap’s key');
  const said = await page.$eval(`${sheet} .ew-foot__say`, (e) => e.textContent.trim());
  ok(said === 'Saved. The draft in Kit has your words now.', `it says what happened in Kit (${said})`);
  ok(await page.$eval(`${sheet} .ew-foot`, (e) => /Done/.test(e.innerText) && /Put back the site’s words/.test(e.innerText)), 'then Done, and Put back the site’s words');
  ok(await press(page, `${sheet} .ew-foot button`, 'Done'), 'Done');
  await sleep(200);
  ok(!(await page.$(sheet)), 'the sheet closes');
  ok(await page.evaluate(() => document.activeElement?.textContent.trim() === 'Edit words'), 'focus goes back to Edit words');
  ok(await press(page, '[aria-labelledby="er-mail-h"] button', 'Edit words'), 'open it again');
  await until(page, (s) => document.querySelector(`${s} #ew-subject`), sheet);
  ok((await page.$eval('#ew-subject', (e) => e.value)) === 'Thank you for a magical night', 'the saved words are in the boxes');
  ok(/Last changed by Linzi/.test(await page.$eval(sheet, (e) => e.innerText)), 'and who changed them');
  ok(await press(page, `${sheet} .ew-foot button`, 'Put back the site’s words'), 'Put back the site’s words');
  await until(page, (s) => /site’s own words again/.test(document.querySelector(`${s} .ew-foot__say`)?.textContent || ''), sheet, 6000);
  ok(JSON.stringify(posts.filter((x) => !x.preview).at(-1).words) === '{}' && (await page.$eval('#ew-subject', (e) => e.value)) === '', 'every box empty: the site’s own words again');
  await page.keyboard.press('Escape');
  await page.close();

  console.log('Monthly Impact in Emails & invites');
  const msgs = await open(1440, '#messages');
  await until(msgs, () => document.querySelector('.mm-root input[type="search"], .mm-root input[placeholder*="earch" i]'), null, 20000);
  await sleep(600);
  // Found by search, as staff would
  await msgs.click('.mm-root input[type="search"], .mm-root input[placeholder*="earch" i]');
  await msgs.keyboard.type('Monthly Impact');
  await sleep(500);
  await msgs.keyboard.press('Enter');
  await sleep(500);
  if (!(await msgs.evaluate(() => /Monthly Impact \(Kit draft\)/.test(document.querySelector('.am-panel')?.innerText || '')))) {
    await msgs.evaluate(() => [...document.querySelectorAll('.am-canvas text, .am-canvas [role="button"], .am-results button, button, li')].find((x) => /^Monthly Impact \(Kit draft\)$/.test(x.textContent.trim()))?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  }
  const found = await until(msgs, () => [...document.querySelectorAll('.mm-kit button')].some((b) => b.textContent.trim() === 'Edit words'), null, 15000);
  ok(found, 'Edit words on Monthly Impact');
  if (found) {
    await press(msgs, '.mm-kit button', 'Edit words');
    await until(msgs, (s) => document.querySelector(`${s} #ew-subject`), sheet);
    ok(calls.includes('GET /api/email-words-admin?key=monthly%3A2026-10'), 'it reads October’s words');
    ok((await msgs.$eval('#ew-title', (e) => e.textContent.trim())) === 'Edit words: October’s Monthly Impact', 'its title');
    await msgs.screenshot({ path: join(OUT, '02-monthly.png') });
  }
  await msgs.close();

  console.log('On a phone with touch');
  const phone = await open(390, `#events/${GALA}`, { touch: true, height: 844 });
  await until(phone, () => [...document.querySelectorAll('[aria-labelledby="er-mail-h"] button')].some((b) => b.textContent.trim() === 'Edit words'), null, 20000);
  await press(phone, '[aria-labelledby="er-mail-h"] button', 'Edit words');
  await until(phone, (s) => document.querySelector(`${s} #ew-subject`), sheet);
  const fit = await phone.evaluate((s) => ({ page: document.documentElement.scrollWidth <= window.innerWidth, sheet: [...document.querySelectorAll(`${s} *`)].filter((e) => !e.closest('iframe')).every((e) => e.getBoundingClientRect().right <= window.innerWidth + 1) }), sheet);
  ok(fit.page && fit.sheet, `nothing wider than the phone (${JSON.stringify(fit)})`);
  const small = await phone.$$eval(`${sheet} button, ${sheet} input`, (els) => els.filter((e) => e.getClientRects().length && e.getBoundingClientRect().height < 44).map((e) => `${e.tagName} ${e.textContent.trim() || e.id} ${Math.round(e.getBoundingClientRect().height)}`));
  ok(small.length === 0, `44px targets on touch (${small.join(', ')})`);
  const bottom = await phone.$eval(sheet, (e) => Math.round(window.innerHeight - e.getBoundingClientRect().bottom));
  ok(bottom <= 1, `a bottom sheet on a phone (${bottom}px from the bottom)`);
  await phone.screenshot({ path: join(OUT, '03-phone.png') });
  const axe2 = await axeScan(phone, sheet);
  ok(axe2.length === 0, `axe finds nothing on a phone (${axeText(axe2)})`);
  await phone.close();
} catch (e) {
  failures.push(`crashed: ${e.stack || e.message}`);
  console.log(e);
}
ok(errors.length === 0, `no console errors (${errors.slice(0, 3).join(' | ')})`);
await browser.close();
if (failures.length) { console.log(`\n${failures.length} failed:`); for (const f of failures) console.log(` - ${f}`); process.exit(1); }
console.log('\nAll passed');
