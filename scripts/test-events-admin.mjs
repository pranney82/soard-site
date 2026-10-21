/**
 * test-events-admin.mjs — drive the admin's "After the event" in a real browser
 * ===========================================================================
 * Serves public/ (and a build's dist/ behind it) from its own server and
 * answers /api/read-content and /api/save-content with the REAL handlers on an
 * in-memory D1 seeded from src/content (events, the gala and golf docs), so
 * saves are the real thing. Uploads are caught in the page (their size and
 * name recorded); photos come from Cloudflare.
 *
 *   - Events: a gala that's over reads "past", not "upcoming"
 *   - the gala opens on "After the gala" once it's over: the page's state,
 *     its addresses, the photo and sponsor counts
 *   - a folder of photos goes up three at a time, a 25 MB-class camera file is
 *     made smaller to fit the 10 MB limit, they join the Gallery named
 *     gallery/gala/<time>-<file> and save themselves
 *   - the credit, the thank-you note and the numbers save onto the event
 *   - the Sponsors tab says this year's list is the thank-you's
 *   - golf: Event Details edits the tournament's date and registration link,
 *     After the tournament works the same way
 *   - with next year's gala added, this year's opens in the Event editor with
 *     its After the event and Sponsors cards
 *   - a phone: nothing wider than the screen
 * Screenshots in test-results/events-admin/. Exits non-zero on failure.
 *
 *   DIST=<a build's dist> node scripts/test-events-admin.mjs
 */
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import http from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import * as readContentApi from '../functions/api/read-content.js';
import * as saveContentApi from '../functions/api/save-content.js';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/events-admin/');
mkdirSync(OUT, { recursive: true });
const DIST = process.env.DIST || join(ROOT, 'dist');
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function section(name, fn) {
  console.log(name);
  try { await fn(); } catch (e) { failures.push(`${name}: crashed: ${e.message}`); console.error(`  ✗ crashed: ${e.stack || e.message}`); }
}

// ── Static: public/ first (the admin as edited), the build behind it ──
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const server = http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  for (const base of [join(ROOT, 'public'), DIST]) {
    let f = join(base, p);
    try { if ((await stat(f)).isDirectory()) f = join(f, 'index.html'); const b = await readFile(f); res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' }); return res.end(b); } catch { /* next */ }
  }
  res.writeHead(404); res.end('not found');
}).listen(0, '127.0.0.1');
await new Promise((r) => server.on('listening', r));
const SITE = `http://127.0.0.1:${server.address().port}`;

// ── The server side, for real, on an in-memory D1 ──
const readDir = (d) => readdirSync(join(ROOT, 'src/content', d)).filter((f) => f.endsWith('.json'))
  .map((f) => ({ name: f, path: `src/content/${d}/${f}`, sha: f, content: JSON.parse(readFileSync(join(ROOT, 'src/content', d, f), 'utf8')) }));
const EVENTS = readDir('events');
const PARTNERS = readDir('partners');
const gala27 = { title: '2027 Evening of Sunshine', slug: '2027-evening-of-sunshine', date: '2027-08-21', location: 'You42 Studios', description: 'Next year.', status: 'upcoming', category: 'fundraiser', photos: [] };
async function world({ nextYear = false } = {}) {
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  const events = nextYear ? [...EVENTS.map((e) => e.content), gala27] : EVENTS.map((e) => e.content);
  for (const e of events) await DB.prepare('INSERT INTO events (slug, title, date, status, data) VALUES (?, ?, ?, ?, ?)').bind(e.slug, e.title, e.date, e.status, JSON.stringify(e)).run();
  for (const k of ['gala', 'golf']) await DB.prepare('INSERT INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind(k, readFileSync(join(ROOT, `src/content/site/${k}.json`), 'utf8'), new Date().toISOString()).run();
  return { DB, events };
}
const docOf = async (DB, k) => JSON.parse((await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(k).first()).data);
const eventOf = async (DB, slug) => JSON.parse((await DB.prepare('SELECT data FROM events WHERE slug = ?').bind(slug).first()).data);

const imgCache = new Map();
function answerer(w) {
  const env = { DB: w.DB };
  return async (req) => {
    const url = new URL(req.url());
    const p = url.pathname;
    const json = (o, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(o) });
    if (p.startsWith('/cdn-cgi/imagedelivery/')) {
      if (!imgCache.has(p)) {
        try { const r = await fetch(`https://imagedelivery.net/${p.slice('/cdn-cgi/imagedelivery/'.length)}`); imgCache.set(p, { status: r.status, type: r.headers.get('content-type') || 'image/png', body: Buffer.from(await r.arrayBuffer()) }); }
        catch { imgCache.set(p, { status: 404, type: 'text/plain', body: Buffer.from('') }); }
      }
      const c = imgCache.get(p);
      return req.respond({ status: c.status, contentType: c.type, body: c.body });
    }
    if (!p.startsWith('/api/')) return false;
    const real = async (mod, method) => {
      const request = new Request(`https://admin.test${p}${url.search}`, { method: req.method(), body: req.method() === 'POST' ? req.postData() : undefined, headers: { 'content-type': 'application/json' } });
      const res = await mod[method]({ env, request, data: { userEmail: 'peter@soardcharity.com' }, waitUntil: () => {} });
      return req.respond({ status: res.status, contentType: 'application/json', body: Buffer.from(await res.arrayBuffer()) });
    };
    if (p === '/api/read-content') return real(readContentApi, 'onRequestGet');
    if (p === '/api/save-content') return real(saveContentApi, 'onRequestPost');
    if (p === '/api/list-content') {
      const dir = url.searchParams.get('dir');
      const items = dir === 'src/content/events'
        ? (await w.DB.prepare('SELECT slug, data FROM events').all()).results.map((r) => ({ name: `${r.slug}.json`, path: `src/content/events/${r.slug}.json`, sha: r.slug, content: JSON.parse(r.data) }))
        : dir === 'src/content/partners' ? PARTNERS : [];
      return json({ success: true, items, count: items.length, total: items.length, pages: 1 });
    }
    if (p === '/api/list-images') return json({ success: true, images: [], continuation_token: '' });
    if (p.startsWith('/api/pending-changes')) return json({ success: true, changes: [], publish: { live: null, active: null, failed: null } });
    if (p.startsWith('/api/live-ws')) return req.abort();
    return json({ success: true, ok: true, items: [], list: [], entries: [] });
  };
}

const browser = await puppeteer.launch({ headless: true, args: ['--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
async function open(w, width = 1440, height = 1000) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: width < 500, hasTouch: width < 500 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|Content Security Policy|live-ws/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  // Uploads: answered in the page, so the test sees what the browser sent
  await page.evaluateOnNewDocument(() => {
    window.__uploads = [];
    const real = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (String(input?.url || input).includes('/api/upload-image') && init?.body instanceof FormData) {
        const f = init.body.get('file');
        const id = init.body.get('id');
        window.__uploads.push({ id, size: f.size, type: f.type, name: f.name, at: Date.now() });
        await new Promise((r) => setTimeout(r, 120));
        return new Response(JSON.stringify({ success: true, imageId: id, imageUrl: '' }), { headers: { 'content-type': 'application/json' } });
      }
      return real(input, init);
    };
  });
  const answer = answerer(w);
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    if (req.isInterceptResolutionHandled()) return;
    try { if (new URL(req.url()).origin === SITE || /\/cdn-cgi\//.test(req.url())) { if ((await answer(req)) !== false) return; } req.continue(); }
    catch (e) { errors.push(`mock: ${e.message}`); req.continue().catch(() => {}); }
  });
  await page.goto(`${SITE}/admin/index.html`, { waitUntil: 'networkidle2' });
  return { page, errors };
}
const text = (page, sel) => page.$eval(sel, (e) => e.innerText).catch(() => '');
const clickText = (page, sel, re) => page.evaluate((s, src, flags) => {
  const r = new RegExp(src, flags);
  const el = [...document.querySelectorAll(s)].find((x) => x.offsetParent !== null && r.test(x.textContent.trim()));
  if (el) { el.click(); return true; }
  return false;
}, sel, re.source, re.flags);
async function toEvents(page) {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('soard-navigate', { detail: 'events' })));
  await page.waitForFunction(() => [...document.querySelectorAll('tr.u-clickable')].length > 0, { timeout: 15000 });
}
async function openEvent(page, title) {
  await toEvents(page);
  await clickText(page, 'tr.u-clickable', new RegExp(title));
  await sleep(800);
}
const typeInto = async (page, handle, value) => { await handle.click({ clickCount: 3 }); await page.keyboard.press('Backspace'); await handle.type(value); };
async function shot(page, name) {
  const vp = page.viewport();
  const h = Math.min(4000, await page.evaluate(() => document.documentElement.scrollHeight));
  await page.setViewport({ ...vp, height: Math.max(vp.height, h) });
  await sleep(250);
  await page.screenshot({ path: join(OUT, name) });
  await page.setViewport(vp);
}

// Photos to upload: two ordinary ones, and one camera file over the 10 MB limit
const files = [];
for (const [i, c] of [[1, { r: 230, g: 160, b: 60 }], [2, { r: 40, g: 90, b: 120 }]]) {
  const f = join(OUT, `IMG_70${i}0.jpg`);
  await writeFile(f, await sharp({ create: { width: 1800, height: 1200, channels: 3, background: c } }).jpeg({ quality: 85 }).toBuffer());
  files.push(f);
}
const big = join(OUT, 'DSC_9999.jpg');
await writeFile(big, await sharp({ create: { width: 6000, height: 4000, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 70 } } }).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer());
const bigSize = (await stat(big)).size;
files.push(big);

try {
  const w = await world();
  const { page, errors } = await open(w);

  await section('Events list', async () => {
    await toEvents(page);
    const badge = await page.evaluate(() => [...document.querySelectorAll('tr.u-clickable')].find((r) => /Evening of Sunshine/.test(r.textContent))?.querySelector('.badge:not(.badge-accent)')?.textContent.trim());
    ok(badge === 'past', `the gala that’s over reads “past” (${badge})`);
  });

  await section('Gala: After the gala', async () => {
    await openEvent(page, 'Evening of Sunshine');
    await page.waitForSelector('.er', { timeout: 15000 });
    const active = await text(page, '.hub-tab.active');
    ok(/After the gala/.test(active), `it opens on After the gala once it’s over (${active})`);
    const status = await text(page, '.er-status');
    ok(/is over, so its page is the thank-you/.test(status) && /\/events\/gala\//.test(status) && /\/events\/gala\/2026\//.test(status), 'it says the page is the thank-you, with both addresses');
    const counts = await page.$$eval('.er-count__n', (n) => n.map((x) => x.textContent.trim()));
    ok(counts[0] === '86' && counts[1] === '17', `86 photos and 17 sponsors on the page (${counts.join(', ')})`);
    await shot(page, 'gala-after.png');

    const before = (await docOf(w.DB, 'gala')).galleryPhotos.length;
    const input = await page.$('.er-drop input[type=file]');
    await input.uploadFile(...files);
    await page.waitForFunction(() => window.__uploads.length >= 3, { timeout: 30000 });
    await page.waitForFunction(() => /Gala settings saved|photos added/.test(document.body.innerText), { timeout: 20000 }).catch(() => {});
    await sleep(1500);
    const ups = await page.evaluate(() => window.__uploads);
    ok(ups.length === 3 && ups.every((u) => /^gallery\/gala\/\d{13}-/.test(u.id)), `3 uploads named gallery/gala/<time>-<file> (${ups.map((u) => u.id).join(', ')})`);
    const bigUp = ups.find((u) => /dsc-9999/.test(u.id));
    ok(bigSize > 10 * 1024 * 1024 && bigUp && bigUp.size <= 9.5 * 1024 * 1024, `the ${(bigSize / 1048576).toFixed(1)} MB camera file went up at ${(bigUp?.size / 1048576).toFixed(1)} MB`);
    const starts = ups.map((u) => u.at).sort();
    ok(starts[2] - starts[0] < 2000, 'they go up together, not one after another');
    const after = await docOf(w.DB, 'gala');
    ok(after.galleryPhotos.length === before + 3, `they joined the Gallery and saved by themselves (${before} → ${after.galleryPhotos.length})`);
    const counts2 = await page.$$eval('.er-count__n', (n) => n.map((x) => x.textContent.trim()));
    ok(counts2[0] === '89', `the page now shows 89 (${counts2[0]})`);

    const [name, site] = await page.$$('.er-row input');
    await typeInto(page, name, 'Jane Doe Photography');
    await typeInto(page, site, 'https://janedoe.example');
    await typeInto(page, await page.$('.er textarea'), 'What a night. Thank you!');
    await clickText(page, '.er button', /Add a number/);
    await sleep(150);
    const [v, l] = await page.$$('.er-hl input');
    await typeInto(page, v, '350');
    await typeInto(page, l, 'Guests');
    await clickText(page, '.editor-save-footer button', /^Save$/);
    await sleep(1500);
    const ev = await eventOf(w.DB, '2026-evening-of-sunshine');
    ok(ev.photographer === 'Jane Doe Photography' && ev.photographerUrl === 'https://janedoe.example', 'the credit saved onto the event');
    ok(ev.recapNote === 'What a night. Thank you!' && ev.highlights?.[0]?.value === '350' && ev.highlights?.[0]?.label === 'Guests', 'the note and the number saved');

    await clickText(page, '.hub-tab', /^Sponsors$/);
    await sleep(300);
    ok(/these are the sponsors its thank-you page shows/.test(await page.evaluate(() => document.body.innerText)), 'the Sponsors tab says the list is the thank-you’s');
  });

  await section('Golf: Event Details and After the tournament', async () => {
    await openEvent(page, 'Sunshine on a Ranney Fairway');
    await page.waitForSelector('.er', { timeout: 15000 });
    ok(/After the tournament/.test(await text(page, '.hub-tab.active')), 'it opens on After the tournament');
    const counts = await page.$$eval('.er-count__n', (n) => n.map((x) => x.textContent.trim()));
    ok(counts[0] === '73', `73 photos on the page (${counts[0]})`);
    await clickText(page, '.hub-tab', /^Event Details$/);
    await sleep(300);
    const date = await page.$eval('.er-row input[type=date]', (i) => i.value).catch(() => '');
    ok(date === '2026-05-18', `the tournament’s date is there to edit (${date})`);
    const link = await page.$('.er-row input[type=url]');
    await typeInto(page, link, 'https://www.zeffy.com/en-US/ticketing/golf-2027');
    await clickText(page, '.editor-save-footer button, button', /^Save$/);
    await sleep(1500);
    const ev = await eventOf(w.DB, 'sunshine-on-a-ranney-fairway');
    ok(ev.ticketUrl === 'https://www.zeffy.com/en-US/ticketing/golf-2027', 'the registration link saved onto the event');
    const golf = await docOf(w.DB, 'golf');
    ok(golf.galleryPhotos.length === 74 && golf.sponsors.length > 5, 'the golf page’s own settings are untouched');
    await shot(page, 'golf-after.png');
  });
  ok(!errors.length, `no errors on the page${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
  await page.close();

  await section('Next year’s gala added: this year opens in the Event editor', async () => {
    const w2 = await world({ nextYear: true });
    const o = await open(w2);
    await openEvent(o.page, '^2026 Evening of Sunshine');
    await o.page.waitForSelector('.er', { timeout: 15000 });
    const body = await o.page.evaluate(() => document.body.innerText);
    ok(/Edit Event/.test(body), 'the 2026 gala opens in the Event editor');
    ok(/\/events\/gala\/2026\//.test(await text(o.page, '.er-status')), 'it points at its year page');
    ok(/Sponsors \(\d+\)/.test(body) && await o.page.$('.er-sp') != null, 'its own sponsor list is there');
    await shot(o.page, 'older-gala-event-editor.png');
    await openEvent(o.page, '^2027 Evening of Sunshine');
    await sleep(500);
    ok(/Evening of Sunshine Gala/.test(await o.page.evaluate(() => document.body.innerText)) && /Event Details/.test(await text(o.page, '.hub-tab.active')), '2027 opens in the Gala editor, on Event Details before it happens');
    ok(!o.errors.length, `no errors${o.errors.length ? `: ${o.errors.slice(0, 3).join(' | ')}` : ''}`);
    await o.page.close();
  });

  await section('Phone', async () => {
    const o = await open(await world(), 390, 844);
    await openEvent(o.page, 'Evening of Sunshine');
    await o.page.waitForSelector('.er', { timeout: 15000 });
    const wide = await o.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(wide <= 0, `nothing wider than the phone (${wide}px over)`);
    await shot(o.page, 'gala-after-phone.png');
    await o.page.close();
  });
} catch (err) {
  failures.push(err.message);
  console.error(err);
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} failed:\n  ${failures.join('\n  ')}` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
