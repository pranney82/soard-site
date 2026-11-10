/**
 * test-newsletter-drafts-admin.mjs — Event Recap and Monthly Impact in the admin, in a real browser
 * ===========================================================================
 * The recap email block in an event's "After the event" panel, and the
 * Monthly Impact draft box on its entry in Emails & invites
 * (functions/api/newsletter-drafts-admin.js). The admin is served as-is from
 * public/ and every /api/* call is answered here:
 *   - the 2026 gala: over, photos on the page, nothing drafted: Draft in Kit
 *     drafts it (a draft only) and the block turns to Open in Kit
 *   - the golf tournament: no photos yet, so no button and the reason why
 *   - Monthly Impact: October, not drafted; Draft October’s in Kit; then Kit
 *     drafts paused: no button
 * Checks the words, what each button sends, phone width, 44px targets on touch,
 * axe and console errors. Screenshots in test-results/newsletter-drafts/.
 *
 *   SITE=http://127.0.0.1:4473 node scripts/test-newsletter-drafts-admin.mjs   (SITE serves public/)
 */
import puppeteer from 'puppeteer';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { axeScan, axeText } from './lib/axe.mjs';
import { answerAsks } from './lib/ask.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/newsletter-drafts/');
mkdirSync(OUT, { recursive: true });
const SITE = (process.env.SITE || 'http://127.0.0.1:4473').replace(/\/$/, '');
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');
const KIT = (id) => `https://app.kit.com/campaigns/${id}`;

const EVENTS = Object.fromEntries(readdirSync(join(ROOT, 'src/content/events')).filter((f) => f.endsWith('.json'))
  .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(ROOT, 'src/content/events', f), 'utf8'))]));
const GALA = '2026-evening-of-sunshine';
const GOLF = 'sunshine-on-a-ranney-fairway';
const state = {
  [`recap:${GALA}`]: { state: 'skipped', block: null, title: 'Evening of Sunshine 2026', off: null, error: null },
  [`recap:${GOLF}`]: { state: 'skipped', block: 'Add the photographer’s photos first: the email is the photos', title: 'Sunshine on a Ranney Fairway 2026', off: null, error: null },
  'monthly:2026-10': { state: 'skipped', block: null, title: 'October 2026 Monthly Impact', off: null, error: null },
};
let paused = false;
const posts = [];
const calls = [];

async function answer(req) {
  const url = new URL(req.url());
  const p = url.pathname;
  if (url.origin !== SITE || !p.startsWith('/api/')) return false;
  const json = (o, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(o) });
  calls.push(`${req.method()} ${p}${url.search}`);
  if (p === '/api/list-content') {
    const dir = url.searchParams.get('dir');
    const src = dir === 'src/content/events' ? EVENTS : {};
    const items = Object.entries(src).map(([slug, c]) => ({ name: `${slug}.json`, path: `${dir}/${slug}.json`, sha: slug, content: { ...c, slug } }));
    return json({ success: true, items, count: items.length, total: items.length, pages: 1 });
  }
  if (p === '/api/read-content') {
    const m = (url.searchParams.get('path') || '').match(/^src\/content\/events\/(.+)\.json$/);
    return m && EVENTS[m[1]] ? json({ success: true, content: JSON.stringify({ ...EVENTS[m[1]], slug: m[1] }), sha: m[1] }) : json({ success: false, error: 'Not found' }, 404);
  }
  if (p === '/api/newsletter-drafts-admin' && req.method() === 'GET') {
    const key = url.searchParams.get('event') ? `recap:${url.searchParams.get('event')}` : 'monthly:2026-10';
    const st = state[key] || { state: 'none', block: 'Ready the morning after the event, once its photos are on the page', off: null, error: null };
    return json({ ok: true, key, ...(key.startsWith('monthly:') ? { month: '2026-10' } : {}), ...st, off: paused ? 'Kit drafts are off while reveal invites are paused (Reveals → Invites)' : st.off, ...(st.id ? { url: KIT(st.id) } : {}) });
  }
  if (p === '/api/newsletter-drafts-admin' && req.method() === 'POST') {
    const body = JSON.parse(req.postData() || '{}');
    posts.push(body);
    await sleep(300);
    const id = 9100 + posts.length;
    state[body.key] = { ...state[body.key], state: 'draft', id, at: new Date().toISOString(), block: null };
    return json({ ok: true, made: true, newsletter: 'drafted', id, url: KIT(id) });
  }
  if (p === '/api/messages-admin' && req.method() === 'GET' && url.searchParams.get('preview')) return json({ success: true, ok: true, channel: 'kit', subject: 'Preview', html: '<p>Preview</p>', to: 'The newsletter list', from: 'SOARD', send: 'email' });
  if (p.startsWith('/api/pending-changes')) return json({ success: true, changes: [], publish: { live: null, active: null, failed: null } });
  if (p === '/api/content-history') return json({ success: true, versions: [], deleted: [] });
  if (p.startsWith('/api/live-ws')) { req.abort(); return true; }
  return json({ success: true, ok: true });
}

const browser = await puppeteer.launch({ headless: 'shell', args: ['--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
const errors = [];
async function open(width, hash, { touch = false } = {}) {
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
    if (req.resourceType() === 'image' && /imagedelivery/.test(req.url())) return req.respond({ status: 200, contentType: 'image/png', body: PNG });
    req.continue();
  });
  await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch {} });
  await page.goto(`${SITE}/admin/index.html${hash}`, { waitUntil: 'networkidle2' });
  return page;
}
const text = (page, sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => '');
const clickText = (page, sel, t) => page.evaluate((sel, t) => {
  const b = [...document.querySelectorAll(sel)].find((x) => x.textContent.replace(/\s+/g, ' ').trim() === t);
  b?.click();
  return !!b;
}, sel, t);
const toasts = (page) => page.$$eval('.toast, [class*="toast"]', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean)).catch(() => []);

try {
  console.log('The gala: over, its photos on the page, nothing drafted');
  const page = await open(1440, `#events/${GALA}`);
  await page.waitForFunction(() => document.querySelector('.er-mail, [aria-labelledby="er-mail-h"] [role="alert"]'), { timeout: 20000 }).catch(() => {});
  const block = await text(page, '[aria-labelledby="er-mail-h"]');
  ok(/^The recap email “What a Night!” in Kit for the newsletter list: the photos, the numbers and the sponsors\. Drafts only\. Nothing goes out until someone sends it from Kit\./.test(block), `it says what the email is, and that it’s a draft only (${block.slice(0, 200)})`);
  ok(/Event Recap NOT DRAFTED Won’t draft itself for this gala: it was over before recap emails began, or long ago\. You can still draft it\. Draft in Kit$/i.test(block), `an event from before: why it won’t come by itself, and Draft in Kit (${block.slice(-160)})`);
  ok(calls.includes(`GET /api/newsletter-drafts-admin?event=${GALA}`), 'it read the gala’s email');
  ok(await clickText(page, '[aria-labelledby="er-mail-h"] button', 'Draft in Kit'), 'Draft in Kit');
  await page.waitForFunction(() => /Open in Kit/.test(document.querySelector('[aria-labelledby="er-mail-h"]')?.innerText || ''), { timeout: 8000 }).catch(() => {});
  ok(JSON.stringify(posts[0]) === JSON.stringify({ key: `recap:${GALA}` }), `it asks for the gala’s recap (${JSON.stringify(posts[0])})`);
  ok((await toasts(page)).some((t) => /The recap email is drafted in Kit\. Nothing is sent until someone sends it there/.test(t)), 'and says it’s a draft');
  const after = await text(page, '[aria-labelledby="er-mail-h"]');
  ok(/DRAFT Drafted .+\. Waiting for someone to review it and send it from Kit\. Until someone edits it there, new photos reach it by themselves\. Open in Kit/i.test(after), `then: the draft, and Open in Kit (${after.slice(-200)})`);
  const link = await page.$eval('[aria-labelledby="er-mail-h"] a', (a) => ({ href: a.href, target: a.target, rel: a.rel })).catch(() => null);
  ok(link?.href === KIT(9101) && link.target === '_blank' && /noopener/.test(link.rel), `Open in Kit opens the draft in a new tab (${JSON.stringify(link)})`);
  const axe = await axeScan(page, '[aria-labelledby="er-mail-h"]');
  ok(axe.length === 0, `axe finds nothing (${axeText(axe)})`);
  await page.$eval('[aria-labelledby="er-mail-h"]', (e) => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await page.screenshot({ path: join(OUT, '01-gala.png') });

  console.log('The golf tournament: no photos yet');
  await page.goto(`${SITE}/admin/index.html#events/${GOLF}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.querySelector('.er-mail'), { timeout: 20000 }).catch(() => {});
  const golf = await text(page, '[aria-labelledby="er-mail-h"]');
  ok(/“What a Day!”/.test(golf) && /Add the photographer’s photos first: the email is the photos\.$/.test(golf) && !(await page.$('[aria-labelledby="er-mail-h"] button')), `a day, not a night; the reason, and no button (${golf.slice(-120)})`);
  await page.close();

  console.log('Monthly Impact in Emails & invites');
  const msgs = await open(1440, '#messages');
  await msgs.waitForSelector('.am-canvas, .mm-root', { timeout: 20000 }).catch(() => {});
  await sleep(800);
  // Find it by search, as staff would
  const searched = await msgs.evaluate(() => {
    const box = document.querySelector('.mm-root input[type="search"], .mm-root input[placeholder*="earch" i]');
    if (!box) return false;
    box.focus();
    return true;
  });
  if (searched) { await msgs.keyboard.type('Monthly Impact'); await sleep(500); await msgs.keyboard.press('Enter'); await sleep(500); }
  let picked = await msgs.evaluate(() => /Monthly Impact \(Kit draft\)/.test(document.querySelector('.am-panel')?.innerText || ''));
  if (!picked) {
    picked = await msgs.evaluate(() => {
      const el = [...document.querySelectorAll('.am-canvas text, .am-canvas [role="button"], .am-results button, button, li')].find((x) => /^Monthly Impact \(Kit draft\)$/.test(x.textContent.trim()));
      el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return !!el;
    });
    await sleep(600);
  }
  await msgs.waitForFunction(() => document.querySelector('.mm-kit .mm-kit-acts, .mm-kit [role="alert"]'), { timeout: 8000 }).catch(() => {});
  const box = await text(msgs, '.mm-kit');
  ok(/^October’s email NOT DRAFTED Won’t draft itself: October was over before monthly emails began\. Drafts only: nothing goes out until someone sends it from Kit\. Draft October’s in Kit$/i.test(box), `the month just ended, why it won’t come by itself, and its button (${box})`);
  ok(await clickText(msgs, '.mm-kit button', 'Draft October’s in Kit'), 'Draft October’s in Kit');
  await msgs.waitForFunction(() => /Open in Kit/.test(document.querySelector('.mm-kit')?.innerText || ''), { timeout: 8000 }).catch(() => {});
  ok(JSON.stringify(posts.at(-1)) === JSON.stringify({ key: 'monthly:2026-10' }), `it asks for October’s (${JSON.stringify(posts.at(-1))})`);
  ok((await toasts(msgs)).some((t) => /October’s Monthly Impact is drafted in Kit/.test(t)), 'and says so');
  const axe2 = await axeScan(msgs, '.mm-kit');
  ok(axe2.length === 0, `axe finds nothing (${axeText(axe2)})`);
  await msgs.$eval('.mm-kit', (e) => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await msgs.screenshot({ path: join(OUT, '02-monthly.png') });
  await msgs.close();

  console.log('Paused, on a phone with touch');
  paused = true;
  state['monthly:2026-10'] = { state: 'skipped', block: null, off: null, error: null };
  const phone = await open(390, `#events/${GALA}`, { touch: true });
  await phone.waitForFunction(() => document.querySelector('.er-mail'), { timeout: 20000 }).catch(() => {});
  const pb = await text(phone, '.er-mail');
  ok(/Kit drafts are off while reveal invites are paused \(Reveals → Invites\)\./.test(pb) && !(await phone.$('.er-mail button')), `paused: says so, no Draft button (${pb})`);
  const small = await phone.$$eval('.er-mail a, .er-mail button', (els) => els.map((e) => ({ t: e.textContent.trim(), h: Math.round(e.getBoundingClientRect().height) })).filter((x) => x.h < 44));
  ok(small.length === 0, `44px targets on touch (${JSON.stringify(small)})`);
  const fit = await phone.evaluate(() => {
    const c = document.querySelector('.er-mail').getBoundingClientRect();
    return { inside: c.right <= document.documentElement.clientWidth + 0.5, page: document.documentElement.scrollWidth <= document.documentElement.clientWidth };
  });
  ok(fit.inside && fit.page, `fits a phone (${JSON.stringify(fit)})`);
  await phone.$eval('.er-mail', (e) => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await phone.screenshot({ path: join(OUT, '03-phone-paused.png') });
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
