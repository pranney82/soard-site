/**
 * test-write-email.mjs — Emails & invites → Write an email, in a real browser
 * ===========================================================================
 * The admin is served as-is from public/; /api/custom-emails-admin is answered
 * here from memory, with the real email builder (functions/api/_custom-email.js)
 * drawing the preview, so the page shows what Kit would get. Checks: the empty
 * state, a new email saved as you type (one email, not two), blocks added,
 * moved and removed, a picture uploaded, the live preview, what's missing before
 * Kit, Send it to me, Draft in Kit then Update the draft, a phone with touch,
 * axe and console errors. Screenshots in test-results/write-email/.
 *
 *   SITE=http://127.0.0.1:4473 node scripts/test-write-email.mjs   (SITE serves public/)
 */
import puppeteer from 'puppeteer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { axeScan, axeText } from './lib/axe.mjs';
import { answerAsks } from './lib/ask.mjs';
import { customEmail, cleanEmail, emailProblems } from '../functions/api/_custom-email.js';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/write-email/');
mkdirSync(OUT, { recursive: true });
const SITE = (process.env.SITE || 'http://127.0.0.1:4473').replace(/\/$/, '');
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Asks the page every quarter second (the page's own waiting never fired for this tab) */
async function until(page, fn, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await page.evaluate(fn).catch(() => false)) return true;
    await sleep(250);
  }
  throw new Error(`Waited ${timeout / 1000}s for ${String(fn).slice(0, 80)}`);
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');
const PNG_FILE = join(OUT, 'canva.png');
writeFileSync(PNG_FILE, PNG);

const store = new Map();
const posts = [];
const uploads = [];
let n = 0;
let draftedId = null;
async function answer(req) {
  const url = new URL(req.url());
  const p = url.pathname;
  if (url.origin !== SITE || !p.startsWith('/api/')) return false;
  const json = (o, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(o) });
  if (p === '/api/custom-emails-admin' && req.method() === 'GET') {
    const id = url.searchParams.get('id');
    if (id) {
      const e = store.get(id);
      return e ? json({ ok: true, email: e, status: draftedId === id ? { state: 'draft', id: '9901', url: 'https://app.kit.com/campaigns/9901' } : { state: 'writing' }, missing: emailProblems(e) }) : json({ ok: false, error: 'gone' }, 404);
    }
    return json({ ok: true, emails: [...store.values()].map((e) => ({ id: e.id, subject: e.subject, updatedAt: new Date().toISOString(), updatedBy: 'linzi@soardcharity.com', state: draftedId === e.id ? 'drafted' : 'writing' })) });
  }
  if (p === '/api/custom-emails-admin' && req.method() === 'POST') {
    const body = JSON.parse(req.postData() || '{}');
    posts.push(Object.keys(body)[0]);
    if (body.preview) { const m = customEmail(body.preview); return json({ ok: true, subject: m.subject, preview: m.preview, html: m.html, missing: emailProblems(body.preview) }); }
    if (body.save) {
      await sleep(150);
      const id = body.save.id || `em_${String(++n).padStart(16, '0')}`;
      const e = { id, ...cleanEmail(body.save) };
      store.set(id, e);
      return json({ ok: true, email: { ...e, updatedAt: new Date().toISOString() }, missing: emailProblems(e) });
    }
    if (body.sendMe) return json({ ok: true, to: 'linzi@soardcharity.com' });
    if (body.draft) {
      await sleep(300);
      const was = draftedId === body.draft;
      draftedId = body.draft;
      return json({ ok: true, result: was ? 'updated' : 'drafted', id: '9901', url: 'https://app.kit.com/campaigns/9901' });
    }
    if (body.remove) { store.delete(body.remove); return json({ ok: true }); }
    return json({ ok: false, error: 'Nothing to do' }, 400);
  }
  if (p === '/api/upload-image') {
    uploads.push(1);
    return json({ success: true, imageId: `emails/written/test/${Date.now()}-canva.png` });
  }
  if (p.startsWith('/api/live-ws')) { req.abort(); return true; }
  return json({ success: true, ok: true });
}

const browser = await puppeteer.launch({ headless: 'shell', args: ['--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
const errors = [];
async function open(width, { touch = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 1000, deviceScaleFactor: 1, hasTouch: touch, isMobile: touch });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|Content Security Policy|live-ws/.test(m.text())) errors.push(m.text().slice(0, 300)); });
  await answerAsks(page);
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    if (req.isInterceptResolutionHandled()) return;
    if ((await answer(req)) !== false) return;
    if (req.resourceType() === 'image' && /imagedelivery|ytimg/.test(req.url())) return req.respond({ status: 200, contentType: 'image/png', body: PNG });
    req.continue();
  });
  await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch {} });
  await page.goto(`${SITE}/admin/index.html#messages/write`, { waitUntil: 'networkidle2' });
  await until(page, () => !!document.querySelector('.we'), 20000);
  return page;
}
const clickText = (page, sel, t) => page.evaluate((sel, t) => {
  const b = [...document.querySelectorAll(sel)].find((x) => x.textContent.replace(/\s+/g, ' ').trim() === t);
  b?.click();
  return !!b;
}, sel, t);
const typeInto = async (page, label, text, scope = '.we-edit') => {
  const handle = await page.evaluateHandle((label, scope) => [...document.querySelectorAll(`${scope} label.form-group`)].find((l) => l.querySelector('.form-label')?.textContent.trim() === label)?.querySelector('input,textarea'), label, scope);
  const el = handle.asElement();
  if (!el) return false;
  await el.click();
  await el.type(text);
  return true;
};
// Words kept together with no-break spaces read as plain spaces here
const frameText = (page) => page.$eval('.we-preview iframe', (f) => (f.contentDocument?.body?.innerText || '').replace(/\u00A0/g, ' ')).catch(() => '');
const toasts = (page) => page.$$eval('.toast, [class*="toast"]', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean)).catch(() => []);

try {
  console.log('Write an email: start to Kit');
  const page = await open(1440);
  const tab = await page.$eval('.mm-tabs [aria-selected="true"]', (b) => b.textContent.trim());
  ok(tab === 'Write an email', `the tab opens from its own address (${tab})`);
  const empty = await page.$eval('.we', (e) => e.innerText.replace(/\s+/g, ' '));
  ok(/Write an email in SOARD’s layout\. You write the middle/.test(empty) && /nothing is sent until someone sends it there/.test(empty), 'the empty page says what it does, and that it only drafts');
  await clickText(page, '.we button', 'New email');
  await until(page, () => !!document.querySelector('.we-edit'), 5000);
  const blocks = await page.$$eval('.we-edit section', (s) => s.map((x) => x.getAttribute('aria-label')));
  ok(JSON.stringify(blocks) === '["Big top","Words"]', `a new email starts with a big top and words (${blocks})`);
  await until(page, () => !!document.querySelector('.we-preview iframe'), 8000);
  await until(page, () => /Thank you for being part/.test((document.querySelector('.we-preview iframe')?.contentDocument?.body?.innerText || '').replace(/\u00A0/g, ' ')), 8000).catch(() => {});
  ok(/Thank you for being part of the sunshine/.test(await frameText(page)), 'the preview shows the layout with the team’s sign-off from the start');
  const draftBtn = async () => page.evaluate(() => [...document.querySelectorAll('.we-bar button')].find((b) => /Draft in Kit|Update the draft/.test(b.textContent))?.disabled);
  ok(await draftBtn() === true, 'Draft in Kit waits for a subject and words');
  ok(/Before it can go to Kit, add a subject/.test(await page.$eval('.we-preview', (e) => e.innerText)), 'and says what’s missing');

  await typeInto(page, 'Subject', 'A Brighter Day Starts With You');
  await typeInto(page, 'Big headline', 'A Brighter Day Starts With *You*.');
  await typeInto(page, 'Words', 'Sometimes, a brighter day starts with a safe shower.');
  await sleep(1600);
  ok(store.size === 1, `typing saved one email, not one per pause (${store.size})`);
  ok([...store.values()][0]?.subject === 'A Brighter Day Starts With You', 'with what was typed');
  const listed = await page.$$eval('.we-item span', (s) => s.map((x) => x.textContent));
  ok(listed.includes('A Brighter Day Starts With You'), `and it’s in the list (${listed})`);
  await until(page, () => /a safe shower/.test((document.querySelector('.we-preview iframe')?.contentDocument?.body?.innerText || '').replace(/\u00A0/g, ' ')), 8000).catch(() => {});
  const prev = await frameText(page);
  ok(/A Brighter Day Starts With You\./.test(prev) && /a safe shower/.test(prev), 'the preview follows what’s typed');
  ok(await draftBtn() === false, 'now it can go to Kit');

  console.log('Blocks: add, picture, move, remove');
  await clickText(page, '.we-add button', '+ Picture');
  await sleep(200);
  const input = await page.$$('.we-edit section[aria-label="Picture"] input[type=file]');
  await input[0].uploadFile(PNG_FILE);
  await page.waitForFunction(() => /background-image/.test(document.querySelector('.we-edit section[aria-label="Picture"] .we-pic__img')?.getAttribute('style') || ''), { timeout: 8000 }).catch(() => {});
  ok(uploads.length === 1, 'the picture uploads to Cloudflare through the admin');
  await sleep(1200);
  ok(/emails\/written\/test\/.*canva\.png/.test(JSON.stringify([...store.values()][0])), 'and is saved with the email');
  const iframeImgs = await page.$eval('.we-preview iframe', (f) => [...f.contentDocument.images].map((i) => i.src).filter((s) => /canva/.test(s)));
  ok(iframeImgs.length === 1 && /fit=scale-down/.test(iframeImgs[0]), `the preview shows it whole (${iframeImgs[0]})`);
  await page.evaluate(() => document.querySelector('.we-edit section[aria-label="Picture"] [aria-label="Move Picture up"]').click());
  await sleep(300);
  let order = await page.$$eval('.we-edit section', (s) => s.map((x) => x.getAttribute('aria-label')));
  ok(JSON.stringify(order) === '["Big top","Picture","Words"]', `↑ moves it (${order})`);
  await clickText(page, '.we-add button', '+ Button');
  await typeInto(page, 'Button words', 'Go', '.we-edit section[aria-label="Button"]');
  await until(page, () => /a link for each button/.test(document.querySelector('.we-preview')?.innerText || ''), 5000).catch(() => {});
  ok(await draftBtn() === true && /a link for each button/.test(await page.$eval('.we-preview', (e) => e.innerText)), 'a button with no link holds the draft back, and says so');
  await page.evaluate(() => document.querySelector('.we-edit section[aria-label="Button"] [aria-label="Remove Button"]').click());
  await sleep(600);
  order = await page.$$eval('.we-edit section', (s) => s.map((x) => x.getAttribute('aria-label')));
  ok(!order.includes('Button') && await draftBtn() === false, '✕ removes it');

  console.log('Send it to me, Draft in Kit');
  await clickText(page, '.we-bar button', 'Send it to me');
  await page.waitForFunction(() => /Sent to/.test(document.body.innerText), { timeout: 5000 }).catch(() => {});
  ok((await toasts(page)).some((t) => /Sent to linzi@soardcharity\.com, with \[Preview\] in the subject/.test(t)), 'Send it to me says where it went');
  await clickText(page, '.we-bar button', 'Draft in Kit');
  await page.waitForFunction(() => /Update the draft in Kit/.test(document.querySelector('.we-bar')?.innerText || ''), { timeout: 8000 }).catch(() => {});
  ok((await toasts(page)).some((t) => /Drafted in Kit\. Nothing is sent until someone sends it there/.test(t)), 'Draft in Kit says it’s a draft only');
  const bar = await page.$eval('.we-bar', (e) => e.innerText.replace(/\s+/g, ' '));
  ok(/Draft in Kit/.test(bar) && /Open in Kit/.test(bar) && /Update the draft in Kit/.test(bar), `then: Open in Kit, and Update the draft (${bar})`);
  const kitLink = await page.$eval('.we-bar a', (a) => ({ href: a.href, target: a.target }));
  ok(kitLink.href === 'https://app.kit.com/campaigns/9901' && kitLink.target === '_blank', 'Open in Kit opens the draft');
  const before = posts.filter((x) => x === 'save').length;
  await clickText(page, '.we-bar button', 'Update the draft in Kit');
  await sleep(900);
  ok((await toasts(page)).some((t) => /The draft in Kit is updated/.test(t)), 'Update the draft says so');
  ok(posts.filter((x) => x === 'save').length >= before, 'saved before it drafts');

  const axe = await axeScan(page, '.we');
  ok(axe.length === 0, `axe finds nothing (${axeText(axe)})`);
  await page.screenshot({ path: join(OUT, '01-desktop.png') });
  await page.close();

  console.log('Phone, touch');
  const phone = await open(390, { touch: true });
  await until(phone, () => !!document.querySelector('.we-item'), 8000);
  await phone.evaluate(() => [...document.querySelectorAll('.we-item')].find((b) => b.querySelector('span')?.textContent.trim() === 'A Brighter Day Starts With You')?.click());
  await until(phone, () => !!document.querySelector('.we-edit'), 5000);
  await sleep(600);
  const fit = await phone.evaluate(() => ({ page: document.documentElement.scrollWidth <= document.documentElement.clientWidth, small: [...document.querySelectorAll('.we button, .we a.btn, .we-item')].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44).map((b) => b.textContent.trim()).slice(0, 5) }));
  ok(fit.page, 'nothing runs past the screen on a phone');
  ok(fit.small.length === 0, `44px targets on touch (${fit.small.join(', ')})`);
  await phone.screenshot({ path: join(OUT, '02-phone.png'), fullPage: true });
  await phone.close();
} catch (e) {
  failures.push(`crashed: ${e.message}`);
  console.error(e);
} finally {
  await browser.close();
}
ok(errors.length === 0, `no console errors (${errors.slice(0, 3).join(' | ')})`);
writeFileSync(join(OUT, 'result.json'), JSON.stringify({ failures }, null, 2));
console.log(failures.length ? `\n${failures.length} failed:\n- ${failures.join('\n- ')}` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
