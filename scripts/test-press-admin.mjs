/**
 * test-press-admin.mjs — drive Admin → Press in a real browser
 * ===========================================================================
 * Serves public/ (and dist/ behind it) from its own local server, and answers
 * the admin's API calls with the REAL handlers running here in Node on an
 * in-memory D1 seeded with the real stories, outlets, kids and partners
 * (src/content): list/read/save/delete-content, content-history,
 * reorder-content and press-admin. The outside world press-admin reads
 * (story pages, Cloudflare Images, Workers AI) is made up.
 *
 * Covers, at 1440px and 390px, light and dark:
 *   - Stories: featured order (keyboard move, saved), filters, search, "/"
 *   - the editor: edit + ⌘S, a save made meanwhile merged, outlet picker
 *     (pick one, add one), kids, draft switch, delete + Undo
 *   - Add a story from its link
 *   - Found coverage: Add, Skip, Undo a change, search settings
 *   - Outlets: the strip, merging two records into one, the outlet dialog
 *     (other spellings saved), Partners has no Media logos tab, ⌘K finds Outlets
 *   - phone: nothing wider than the screen, 16px fields, 44px targets
 * Screenshots in test-results/press-admin/. Exits non-zero on failure.
 * AXE=<path to axe.min.js> adds an accessibility pass (WCAG 2.1 AA and best
 * practice) on each screen and dialog; axe-core isn't a dependency of the site.
 *
 *   node scripts/test-press-admin.mjs
 */
import puppeteer from 'puppeteer';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import { EXTRACTORS } from '../functions/api/_collections.js';
import * as listApi from '../functions/api/list-content.js';
import * as readApi from '../functions/api/read-content.js';
import * as saveApi from '../functions/api/save-content.js';
import * as deleteApi from '../functions/api/delete-content.js';
import * as historyApi from '../functions/api/content-history.js';
import * as reorderApi from '../functions/api/reorder-content.js';
import * as pressApi from '../functions/api/press-admin.js';
import { ensurePressTables, STATE_KEY } from '../functions/api/_press.js';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/press-admin/');
mkdirSync(OUT, { recursive: true });
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function section(name, fn) {
  console.log(name);
  try { await fn(); } catch (e) { failures.push(`${name}: crashed: ${e.message}`); console.error(`  ✗ crashed: ${e.stack || e.message}`); }
}

// ── A static server: public/ first (the admin as edited), dist/ behind it ──
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const server = http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  for (const base of ['public', 'dist']) {
    let f = join(ROOT, base, p);
    try { if ((await stat(f)).isDirectory()) f = join(f, 'index.html'); const b = await readFile(f); res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' }); return res.end(b); } catch { /* next */ }
  }
  res.writeHead(404); res.end('not found');
}).listen(0, '127.0.0.1');
await new Promise((r) => server.on('listening', r));
const SITE = `http://127.0.0.1:${server.address().port}`;

// ── The server side, for real, on an in-memory D1 with the real content ──
const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
const readDir = (d) => readdirSync(join(ROOT, 'src/content', d)).filter((f) => f.endsWith('.json')).map((f) => ({ slug: f.replace(/\.json$/, ''), ...JSON.parse(readFileSync(join(ROOT, 'src/content', d, f), 'utf8')) }));
const seed = async (table, list) => {
  for (const r of list) {
    const data = { ...r };
    if (table !== 'kids' && table !== 'partners' && table !== 'medialogos') delete data.slug;
    const [cols, vals] = EXTRACTORS[table](data);
    const all = ['"slug"', '"data"', '"updated_at"', ...cols];
    await DB.prepare(`INSERT OR REPLACE INTO ${table} (${all.join(', ')}) VALUES (${all.map(() => '?').join(', ')})`).bind(r.slug, JSON.stringify(data), '2026-10-01T00:00:00Z', ...vals).run();
  }
};
const PRESS = readDir('press');
await seed('press', PRESS);
await seed('medialogos', [...readDir('medialogos'),
  // Two records that are one outlet (Outlets offers to merge them)
  { slug: 'roswell-patch', name: 'Roswell Patch', logo: '', order: 0, strip: false, kind: 'print', domains: ['patch.com'] },
  { slug: 'patch-roswell', name: 'Roswell Patch.com', logo: '', order: 0, strip: false },
]);
await seed('kids', readDir('kids'));
await seed('partners', readDir('partners'));
await ensurePressTables(DB);
const now = new Date().toISOString();
const hoursAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();
await DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind(STATE_KEY, JSON.stringify({
  scans: { google: { at: hoursAgo(1), found: 21, added: 2 }, bing: { at: hoursAgo(2), found: 5, added: 1 }, youtube: { at: hoursAgo(5), found: 3, added: 0 } },
  sweep: {}, tidy: { phase: 'stories', startedAt: hoursAgo(3), counts: { outletsCreated: 56, storiesLinked: 40, duplicatesRemoved: 8, pictures: 31 } },
}), now).run();
const mention = (id, o) => DB.prepare(`INSERT INTO press_mentions (id, key, provider, query, url, link, title, source, published, state, stage, reason, story, data, found_at) VALUES (?, ?, ?, 'q', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .bind(id, o.url, o.provider || 'google', o.url, o.url, o.title, o.source, o.published || null, o.state, o.stage || 'judge', o.reason || null, o.story || null, JSON.stringify(o.data || {}), o.found || now).run();
await mention('g:review1', { url: 'https://www.ajc.com/life/ten-charities-to-know/abc', title: 'Ten Atlanta charities to know this fall', source: 'The Atlanta Journal-Constitution', published: '2026-10-12', state: 'review', reason: 'SOARD only comes up in passing', data: { judge: { summary: 'A list of local charities, including Sunshine on a Ranney Day.' } } });
await mention('b:review2', { provider: 'bing', url: 'https://www.msn.com/en-us/news/soard/ar-1', title: 'Sunshine on a Ranney Day builds a sensory room', source: 'MSN', state: 'review', reason: 'A copy on MSN: the original outlet’s own link is better' });
await mention('g:dupe', { url: 'https://www.wsbtv.com/x', title: 'Old story', source: 'WSB-TV', state: 'duplicate', reason: 'Already on the publicity page', story: PRESS[0].slug });
await mention('y:listing', { provider: 'youtube', url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Gala auction highlights', source: 'An auctioneer', state: 'unrelated', reason: 'A video from An auctioneer, not a news outlet' });
const logged = PRESS.find((s) => s.slug === 'fox5-hawks-kalen-2016') || PRESS[1];
await DB.prepare('INSERT INTO press_log (at, kind, slug, label, before, after) VALUES (?, ?, ?, ?, ?, ?)').bind(hoursAgo(2), 'story', logged.slug, `${logged.title}: picture`, JSON.stringify({ image: null }), JSON.stringify({ image: 'press/test-picture' })).run();
await DB.prepare('UPDATE press SET data = ? WHERE slug = ?').bind(JSON.stringify({ ...JSON.parse((await DB.prepare('SELECT data FROM press WHERE slug = ?').bind(logged.slug).first()).data), image: 'press/test-picture' }), logged.slug).run();

// The made-up outside world press-admin reads
const realFetch = globalThis.fetch;
const STORY_URL = 'https://www.fox5atlanta.com/news/soard-builds-a-dream-room-for-maya';
const outside = {
  [STORY_URL]: `<html><head><title>SOARD builds a dream room for Maya</title><meta property="og:title" content="SOARD builds a dream room for Maya"><meta property="og:site_name" content="FOX 5 Atlanta"><meta property="article:published_time" content="2026-10-14T10:00:00Z"><meta property="og:image" content="https://images.foxtv.com/maya.jpg"><meta name="description" content="A Roswell nonprofit gave Maya a new room."></head><body><p>Sunshine on a Ranney Day built Maya a new accessible bedroom in Roswell this week, the nonprofit said.</p><p>SOARD founder Holly Ranney led the reveal.</p></body></html>`,
  'https://www.ajc.com/life/ten-charities-to-know/abc': `<html><head><title>Ten Atlanta charities to know this fall</title><meta property="og:site_name" content="The Atlanta Journal-Constitution"><meta property="article:published_time" content="2026-10-12"><meta property="og:image" content="https://www.ajc.com/charities.jpg"></head><body><p>Ten groups doing good work around Atlanta, among them Sunshine on a Ranney Day in Roswell.</p></body></html>`,
};
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (outside[url]) return Object.defineProperty(new Response(outside[url], { headers: { 'content-type': 'text/html' } }), 'url', { value: url });
  if (/^https:\/\/(images\.foxtv\.com|www\.ajc\.com)\/.*\.jpg$/.test(url)) return new Response(new Uint8Array(20000), { headers: { 'content-type': 'image/jpeg' } });
  if (/api\.cloudflare\.com\/client\/v4\/accounts\/.*\/images\/v1$/.test(url)) return Response.json({ success: true, result: { id: init.body?.get?.('id') || 'press/uploaded' } });
  if (/archive\.org|web\.archive\.org|news\.google\.com|bing\.com|youtube\.com|slack\.com/.test(url)) return new Response('', { status: 404 });
  return realFetch(input, init);
};
const env = {
  DB, CF_ACCOUNT_ID: 'acct', CF_IMAGES_TOKEN: 'tok',
  AI: { run: async () => ({ response: JSON.stringify({ about: 'about', summary: 'Sunshine on a Ranney Day built Maya an accessible bedroom in Roswell.', category: 'local-tv', kids: [], partners: [] }) }) },
};
const calls = [];
const imgCache = new Map();
async function answer(req, user = 'staff@example.com') {
  const url = new URL(req.url());
  const p = url.pathname;
  const json = (o, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(o) });
  if (p.startsWith('/cdn-cgi/imagedelivery/')) {
    if (!imgCache.has(p)) {
      try { const r = await realFetch(`https://imagedelivery.net/${p.slice('/cdn-cgi/imagedelivery/'.length)}`); imgCache.set(p, { status: r.status, type: r.headers.get('content-type') || 'image/png', body: Buffer.from(await r.arrayBuffer()) }); }
      catch { imgCache.set(p, { status: 404, type: 'text/plain', body: Buffer.from('') }); }
    }
    const c = imgCache.get(p);
    return req.respond({ status: c.status, contentType: c.type, body: c.body, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
  if (!p.startsWith('/api/')) return false;
  calls.push(`${req.method()} ${p}${url.search}`);
  const real = async (mod, method) => {
    const request = new Request(`https://admin.test${p}${url.search}`, { method: req.method(), body: req.method() === 'POST' ? req.postData() : undefined, headers: { 'content-type': 'application/json' } });
    const res = await mod[method]({ env, request, data: { userEmail: user }, waitUntil: () => {} });
    return req.respond({ status: res.status, contentType: 'application/json', body: Buffer.from(await res.arrayBuffer()) });
  };
  const method = req.method() === 'POST' ? 'onRequestPost' : 'onRequestGet';
  if (p === '/api/list-content') return real(listApi, 'onRequestGet');
  if (p === '/api/read-content') return real(readApi, 'onRequestGet');
  if (p === '/api/save-content') return real(saveApi, 'onRequestPost');
  if (p === '/api/delete-content') return real(deleteApi, 'onRequestPost');
  if (p === '/api/content-history') return real(historyApi, 'onRequestGet');
  if (p === '/api/reorder-content') return real(reorderApi, 'onRequestPost');
  if (p === '/api/press-admin') return real(pressApi, method);
  if (p === '/api/fetch-og-image') return json({ success: true, imageId: 'press/pulled' });
  if (p === '/api/list-images') return json({ success: true, images: [], continuation_token: '' });
  if (p.startsWith('/api/pending-changes')) return json({ success: true, changes: [], publish: { live: null, active: null, failed: null } });
  if (p.startsWith('/api/live-ws')) return req.abort();
  return json({ success: true, ok: true, items: [], list: [], entries: [] });
}

const browser = await puppeteer.launch({ headless: true, args: ['--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
async function open(width, height, hash) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: width < 500, hasTouch: width < 500 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const errors = [];
  const dialogs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|Content Security Policy|live-ws/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    if (req.isInterceptResolutionHandled()) return;
    try { if (new URL(req.url()).origin === SITE || /\/cdn-cgi\//.test(req.url())) { if ((await answer(req)) !== false) return; } req.continue(); }
    catch (e) { errors.push(`mock: ${e.message}`); req.continue().catch(() => {}); }
  });
  await page.goto(`${SITE}/admin/index.html${hash}`, { waitUntil: 'networkidle2' });
  return { page, errors, dialogs };
}
const text = (page, sel) => page.$eval(sel, (e) => e.innerText).catch(() => '');
const clickText = (page, sel, re) => page.evaluate((s, src, flags) => {
  const r = new RegExp(src, flags);
  const el = [...document.querySelectorAll(s)].find((x) => x.offsetParent !== null && r.test(x.textContent.trim()));
  if (el) { el.click(); return true; }
  return false;
}, sel, re.source, re.flags);
const waitText = (page, sel, re, timeout = 8000) => page.waitForFunction((s, src, flags) => [...document.querySelectorAll(s)].some((x) => new RegExp(src, flags).test(x.textContent)), { timeout }, sel, re.source, re.flags).then(() => true).catch(() => false);
const storyIn = async (slug) => { const r = await DB.prepare('SELECT data FROM press WHERE slug = ?').bind(slug).first(); return r ? JSON.parse(r.data) : null; };
async function shot(page, name, maxH = 3600) {
  const vp = page.viewport();
  const h = Math.min(maxH, await page.evaluate(() => document.documentElement.scrollHeight));
  await page.setViewport({ ...vp, height: Math.max(vp.height, h) });
  await sleep(300);
  await page.screenshot({ path: join(OUT, name) });
  await page.setViewport(vp);
}
const DARK = `:root[data-theme="dark"]{color-scheme:dark;--color-bg:#141518;--color-bg-card:#1C1D21;--color-bg-secondary:#222327;--color-bg-hover:#2A2B30;--color-text:#ECECEF;--color-text-secondary:#B9BAC1;--color-text-muted:#9C9DA5;--color-border:#303137;--color-border-strong:#45464D;--color-primary-bg:rgba(255,213,0,.10);--color-primary-ink:#FFD500;--color-danger:#F07A7A;--color-success:#4CC27E;--color-warning:#E8B44A;--shadow-xs:none;--shadow-sm:none}:root[data-theme="dark"] body{background:var(--color-bg);color:var(--color-text)}`;
const setTheme = (page, dark) => page.evaluate((css, on) => {
  let s = document.getElementById('test-dark');
  if (!s) { s = document.createElement('style'); s.id = 'test-dark'; s.textContent = css; document.head.append(s); }
  document.documentElement.dataset.theme = on ? 'dark' : 'light';
}, DARK, dark);
const axeRules = { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } };
async function axeCheck(page, label) {
  if (!process.env.AXE) return;
  if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ path: process.env.AXE });
  await sleep(350);
  const v = await page.evaluate(async (opts) => {
    const r = await window.axe.run(document.querySelector('.modal-overlay') || document.querySelector('.main'), opts);
    return r.violations.map((x) => `${x.id} (${x.impact}): ${x.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`);
  }, axeRules);
  ok(!v.length, `accessibility, ${label}${v.length ? `: ${v.join('; ')}` : ''}`);
}
const overflow = (page) => page.evaluate(() => {
  const main = document.querySelector('.main') || document.body;
  const right = main.getBoundingClientRect().right + 1;
  return [...document.querySelectorAll('.pr-root *')].filter((e) => e.offsetParent !== null && e.getBoundingClientRect().right > right && !e.closest('.pr-combo__list, .pr-strip__row')).slice(0, 5).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]}`);
});

let main;
try {
  main = await open(1440, 1000, '#press');
  const { page, errors } = main;

  await section('Stories', async () => {
    await page.waitForSelector('.pr-root .pr-rows', { timeout: 20000 });
    ok(/Press/.test(await text(page, '.pr-head h2')), 'opens Press from #press');
    ok(await page.$$eval('.pr-root .hub-tab', (t) => t.map((x) => x.textContent).join('|')).then((s) => /Stories/.test(s) && /Found coverage/.test(s) && /Outlets/.test(s)), 'three tabs');
    const rows = await page.$$eval('.pr-row', (r) => r.length);
    ok(rows === PRESS.length, `every story listed (${rows} of ${PRESS.length})`);
    ok(/Tidying the list/.test(await text(page, '.pr-status__foot')), 'the monitor line says the tidy is running');
    // Where things stand: what needs a person, who the stories are about, pictures
    const status = await text(page, '.pr-status');
    ok(/Needs you/i.test(status) && /2 found articles to check/.test(status), `the panel says what needs a person (${status.split('\n').slice(0, 3).join(' / ')})`);
    const aboutKids = PRESS.filter((x) => (x.kids || []).length).length;
    ok(new RegExp(`${aboutKids} stories`).test(status) && await page.$$eval('.pr-status .pr-faces .pr-face', (f) => f.length) >= 5, `the panel shows the ${aboutKids} stories about kids, with their faces`);
    ok(/Pictures/i.test(status) && new RegExp(`of ${PRESS.length}\\b`).test(status), 'the panel counts pictures');
    ok(await page.$$eval('.pr-row .pr-who--kid', (k) => k.length) >= aboutKids, 'each story about a kid names the kid in its row');
    const kidThumb = await page.evaluate(() => [...document.querySelectorAll('.pr-row')].some((r) => r.querySelector('.pr-who--kid') && /\/kids\//.test(r.querySelector('.pr-thumb img')?.src || '')));
    ok(kidThumb, 'a story with no picture of its own shows the kid’s room');
    await clickText(page, '.pr-status .pr-stat--btn', /About a kid/);
    await sleep(300);
    ok(await page.$$eval('.pr-row', (r) => r.length) === aboutKids && /About a kid/.test(await text(page, '.pr-pill[aria-pressed="true"]')), 'the panel opens the stories about kids');
    await clickText(page, '.pr-pill', /^All/);
    await sleep(200);
    await page.waitForFunction(() => [...document.querySelectorAll('.nav-item')].some((n) => /Press/.test(n.textContent) && n.querySelector('.nav-count')?.textContent === '2'), { timeout: 8000 }).catch(() => {});
    ok(await page.evaluate(() => [...document.querySelectorAll('.nav-item')].find((n) => /Press/.test(n.textContent))?.querySelector('.nav-count')?.textContent === '2'), 'the sidebar shows 2 found articles need a look');
    ok(await page.$$eval('.pr-feat__item', (r) => r.length) === PRESS.filter((s) => s.featured).length, 'featured stories in their own list');
    ok(await page.$$eval('.pr-thumb img', (i) => i.length) > 0, 'thumbnails show');
    await shot(page, 'desk-1-stories.png');
    await axeCheck(page, 'Stories');
    // "/" focuses search; search narrows
    await page.keyboard.press('/');
    ok(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Search stories'), '"/" focuses search');
    await page.keyboard.type('WSB');
    await sleep(200);
    const wsb = await page.$$eval('.pr-row', (r) => r.length);
    ok(wsb > 0 && wsb < rows, `search narrows (${wsb})`);
    await page.click('input[aria-label="Search stories"]', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    ok(await clickText(page, '.pr-pill', /^Needs attention/), 'Needs attention filter');
    await sleep(200);
    const att = await page.$$eval('.pr-row', (r) => r.length);
    ok(att > 0 && att < rows, `needs attention narrows (${att})`);
    ok(await page.$$eval('.pr-row .pr-chip--warn', (c) => c.length) >= att, 'each one says what it needs');
    await clickText(page, '.pr-pill', /^All/);
  });

  await section('Dashboard', async () => {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('soard-navigate', { detail: 'dashboard' })));
    const shown = await waitText(page, '.main', /2 articles the press monitor found need a look/, 10000);
    ok(shown, 'the Dashboard lists the found articles that need a look');
    await page.evaluate(() => { history.replaceState(null, '', '#press'); window.dispatchEvent(new CustomEvent('soard-navigate', { detail: 'press-hub' })); });
    await page.waitForSelector('.pr-rows', { timeout: 10000 });
  });

  await section('Featured order (keyboard)', async () => {
    const before = await page.$$eval('.pr-feat__item', (r) => r.map((x) => x.dataset.slug));
    const btn = await page.$('.pr-feat__item:first-child .pr-feat__move[data-dir="1"]');
    await btn.click();
    await page.waitForFunction((first) => document.querySelector('.pr-feat__item:nth-child(2)')?.dataset.slug === first, { timeout: 8000 }, before[0]).catch(() => {});
    await sleep(400);
    const a = await storyIn(before[0]);
    const b = await storyIn(before[1]);
    ok(a.order === 1 && b.order === 0, `saved: ${before[1]} first, ${before[0]} second`);
    ok(calls.some((c) => c === 'POST /api/reorder-content'), 'one reorder request');
  });

  await section('The editor', async () => {
    const slug = 'fcnews-2020';
    await page.evaluate((s) => { location.hash = `#press/${s}`; }, slug);
    await page.waitForSelector('.pr-editor #pr-title', { timeout: 10000 });
    ok(/Mohawk/i.test(await page.$eval('#pr-title', (e) => e.value)), 'opens the story by its link');
    const kidPics = await page.$$eval('.pr-kidpic', (b) => b.length);
    ok(kidPics >= 1 && /Photos from .+’s page/.test(await text(page, '.pr-kidpics')), `photos from the kid’s page are offered (${kidPics})`);
    await page.click('#pr-title', { clickCount: 3 });
    await page.keyboard.type('Mohawk partners with Sunshine on a Ranney Day');
    ok(await waitText(page, '.pr-bar__state', /Unsaved/, 4000), 'shows unsaved changes');
    await page.keyboard.down('Meta'); await page.keyboard.press('s'); await page.keyboard.up('Meta');
    await waitText(page, '.pr-bar__state', /^Saved$/);
    ok((await storyIn(slug)).title === 'Mohawk partners with Sunshine on a Ranney Day', '⌘S saves');
    const v = await DB.prepare("SELECT COUNT(*) AS n FROM content_versions WHERE collection = 'press' AND slug = ?").bind(slug).first('n');
    ok(v >= 2, 'History keeps the version before and after');
    // Someone else saves the summary; I change the date: both kept
    const cur = await storyIn(slug);
    const theirs = { ...cur, excerpt: 'Changed by someone else.' };
    await DB.prepare('UPDATE press SET data = ? WHERE slug = ?').bind(JSON.stringify(theirs), slug).run();
    await page.click('#pr-date');
    await page.evaluate(() => { const i = document.querySelector('#pr-date'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '2020-09-29'); i.dispatchEvent(new Event('input', { bubbles: true })); });
    await clickText(page, '.pr-bar .btn-primary', /^Save$/);
    await waitText(page, '.pr-bar__state', /^Saved$/);
    const merged = await storyIn(slug);
    ok(merged.excerpt === 'Changed by someone else.' && merged.date === '2020-09-29', 'a save made meanwhile is merged, nothing lost');
    // Outlet picker: pick by typing
    await page.click('.pr-combo input', { clickCount: 3 });
    await page.keyboard.type('Fox 5');
    await page.waitForSelector('.pr-combo__opt', { timeout: 5000 });
    ok(/Fox 5 Atlanta/.test(await text(page, '.pr-combo__list')), 'the outlet list filters as you type');
    await page.keyboard.press('Enter');
    ok((await page.$eval('.pr-combo input', (e) => e.value)) === 'Fox 5 Atlanta', 'Enter picks it');
    // Add a new outlet from the picker
    await page.click('.pr-combo input', { clickCount: 3 });
    await page.keyboard.type('Brand New Gazette');
    await waitText(page, '.pr-combo__opt', /Add “Brand New Gazette”/);
    await clickText(page, '.pr-combo__opt', /Add “Brand New Gazette”/);
    await page.waitForFunction(() => document.querySelector('.pr-combo input')?.value === 'Brand New Gazette', { timeout: 8000 }).catch(() => {});
    const gazette = await DB.prepare("SELECT data FROM medialogos WHERE slug = 'brand-new-gazette'").first();
    ok(!!gazette && JSON.parse(gazette.data).slug === 'brand-new-gazette' && JSON.parse(gazette.data).strip === false, 'a new outlet is added (no logo, out of the strip)');
    await page.waitForFunction(() => !/isn’t linked/.test(document.querySelector('.pr-combo')?.textContent || ''), { timeout: 8000 }).catch(() => {});
    ok(!/isn’t linked/.test(await text(page, '.pr-combo')), 'and the story is linked to it');
    // Kids
    await page.type('#pr-pp-1, .pr-people input', 'Ally');
    await page.waitForSelector('.pr-people .pr-combo__opt', { timeout: 5000 }).catch(() => {});
    await page.keyboard.press('Enter');
    ok(await page.$$eval('.pr-people__chip', (c) => c.length) >= 1, 'a kid is linked');
    // Draft switch
    await clickText(page, '.pr-switch', /On the publicity page/);
    await page.keyboard.down('Meta'); await page.keyboard.press('s'); await page.keyboard.up('Meta');
    await waitText(page, '.pr-bar__state', /^Saved$/);
    const saved = await storyIn(slug);
    ok(saved.publishStatus === 'draft' && saved.outletLogo === 'brand-new-gazette' && saved.outlet === 'Brand New Gazette' && (saved.kids || []).includes('ally'), 'outlet, kid and draft saved together');
    await shot(page, 'desk-2-editor.png');
    await axeCheck(page, 'the editor');
    // Delete, then Undo
    await clickText(page, '.pr-delete', /Delete story/);
    await page.waitForSelector('.kd-dialog .btn-danger', { timeout: 5000 });
    await page.click('.kd-dialog .btn-danger');
    await page.waitForSelector('.pr-rows', { timeout: 8000 });
    ok(!(await storyIn(slug)), 'Delete removes it');
    ok(await page.evaluate(() => { const t = [...document.querySelectorAll('.toast')].find((x) => /Deleted/.test(x.textContent)); const b = t && [...t.querySelectorAll('button')].find((x) => /Undo/.test(x.textContent)); b?.click(); return !!b; }), 'Undo is offered');
    await sleep(800);
    ok(!!(await storyIn(slug)), 'Undo brings it back');
  });

  await section('Merging a copy from the editor', async () => {
    const keep = 'ajc-2022';
    const drop = 'the-atlanta-journal-constitution-2022-12-06';
    if (await storyIn(keep) && await storyIn(drop)) {
      await page.evaluate((s) => { location.hash = `#press/${s}`; }, keep);
      await page.waitForSelector('.pr-dupes .btn', { timeout: 10000 });
      ok(/Possible duplicate/.test(await text(page, '.pr-needs')), 'the editor says it looks like a copy');
      await clickText(page, '.pr-dupes .btn', /Merge into this story/);
      await waitText(page, '.toast', /Merged/, 10000);
      ok(!(await storyIn(drop)) && !!(await storyIn(keep)), 'the copy is merged in and removed');
      await page.evaluate(() => { const t = [...document.querySelectorAll('.toast')].find((x) => /Merged/.test(x.textContent)); [...(t?.querySelectorAll('button') || [])].find((b) => /Undo/.test(b.textContent))?.click(); });
      await sleep(1200);
      ok(!!(await storyIn(drop)), 'Undo brings the copy back');
      await page.evaluate(() => { location.hash = '#press'; });
      await page.waitForSelector('.pr-rows', { timeout: 8000 });
    }
  });

  await section('Add a story from its link', async () => {
    await clickText(page, '.pr-head .btn-primary', /Add a story/);
    await page.waitForSelector('#pr-add-url', { timeout: 5000 });
    await page.type('#pr-add-url', STORY_URL);
    await clickText(page, '.kd-dialog .btn-primary', /Read the page/);
    await waitText(page, '.pr-filled__title', /SOARD builds a dream room for Maya/, 10000);
    ok(/FOX 5|Fox 5/.test(await text(page, '.pr-filled__outlet')), 'the outlet is matched');
    ok(/accessible bedroom/.test(await text(page, '.pr-filled__sum')), 'the summary is written');
    await shot(page, 'desk-3-add.png', 1000);
    await axeCheck(page, 'Add a story');
    await clickText(page, '.kd-dialog .btn-primary', /Add story/);
    await sleep(1200);
    const added = (await DB.prepare("SELECT data FROM press WHERE data LIKE '%dream room for Maya%'").first());
    ok(!!added && JSON.parse(added.data).outletLogo === 'fox5' && /^press\//.test(JSON.parse(added.data).image), 'saved with its outlet and picture');
  });

  await section('Found coverage', async () => {
    await clickText(page, '.pr-root .hub-tab', /Found coverage/);
    await page.waitForSelector('.pr-found', { timeout: 8000 });
    ok((await page.$$eval('#pr-review ~ * .pr-mention, .pr-list:has(#pr-review) .pr-mention', (m) => m.length)) === 2, 'two articles need a look');
    ok(/Google News/.test(await text(page, '.pr-sources')) && /Checked/.test(await text(page, '.pr-sources')), 'each source says when it last looked');
    ok(/Tidying/.test(await text(page, '.pr-tidy')), 'the tidy is described while it runs');
    await shot(page, 'desk-4-found.png');
    await axeCheck(page, 'Found coverage');
    await clickText(page, '.pr-mention .btn-primary', /Add to the page/);
    await waitText(page, '.toast', /Added to the publicity page/, 10000);
    const filed = await DB.prepare("SELECT state, story, decided_by FROM press_mentions WHERE id = 'g:review1'").first();
    ok(filed.state === 'filed' && filed.decided_by === 'staff@example.com' && !!(await storyIn(filed.story)), 'Add files it as a story, with who decided');
    await clickText(page, '.pr-mention .btn-ghost', /^Skip$/);
    await sleep(800);
    ok((await DB.prepare("SELECT state FROM press_mentions WHERE id = 'b:review2'").first()).state === 'dismissed', 'Skip keeps it out');
    // Undo the logged picture change
    const before = await storyIn(logged.slug);
    ok(before.image === 'press/test-picture', 'the logged change is in place');
    await page.evaluate(() => { const li = [...document.querySelectorAll('.pr-log__item')].find((x) => /: picture/.test(x.textContent)); li?.querySelector('button.btn')?.click(); });
    await sleep(1000);
    ok(!(await storyIn(logged.slug)).image, 'Undo puts the field back');
    ok(await page.$('.pr-log__item.is-undone') !== null, 'and the change shows as undone');
    // Search settings
    await page.type('input[aria-label="Add a search"]', '"Sunny and Ranney" store');
    await page.keyboard.press('Enter');
    await clickText(page, '.pr-set__save .btn-primary', /Save/);
    await sleep(800);
    const set = JSON.parse((await DB.prepare("SELECT data FROM site_config WHERE key = 'press-monitor'").first())?.data || '{}');
    ok((set.queries || []).includes('"Sunny and Ranney" store') && set.updatedBy === 'staff@example.com', 'a new search is saved');
    await page.waitForFunction(() => ![...document.querySelectorAll('.nav-item')].find((n) => /Press/.test(n.textContent))?.querySelector('.nav-count'), { timeout: 8000 }).catch(() => {});
    ok(await page.evaluate(() => !([...document.querySelectorAll('.nav-item')].find((n) => /Press/.test(n.textContent))?.querySelector('.nav-count'))), 'with both handled, the sidebar badge goes away');
  });

  await section('Outlets', async () => {
    await clickText(page, '.pr-root .hub-tab', /Outlets/);
    await page.waitForSelector('.pr-outlets', { timeout: 8000 });
    ok(await page.$$eval('.pr-strip__logo img', (i) => i.length) >= 5, 'the strip shows its logos');
    ok(/Roswell Patch/.test(await text(page, '.pr-pairs')), 'two records for one outlet are offered to merge');
    await shot(page, 'desk-5-outlets.png');
    await axeCheck(page, 'Outlets');
    await page.evaluate(() => [...document.querySelectorAll('.pr-pair')].find((p) => /Roswell Patch/.test(p.textContent))?.querySelector('.btn-primary')?.click());
    await sleep(1200);
    const left = await DB.prepare("SELECT slug FROM medialogos WHERE slug IN ('roswell-patch', 'patch-roswell')").all();
    ok(left.results.length === 1, 'merged into one');
    // Edit an outlet: other spellings
    await page.evaluate(() => [...document.querySelectorAll('.pr-outlet')].find((b) => /^WSB-TV/.test(b.querySelector('.pr-outlet__name')?.textContent))?.click());
    await page.waitForSelector('#ml-aliases', { timeout: 8000 });
    await axeCheck(page, 'the outlet dialog');
    await page.type('#ml-aliases', 'WSB Channel 2');
    await page.keyboard.press('Enter');
    await clickText(page, '.kd-dialog .btn-primary', /^Save$/);
    await sleep(1200);
    const wsb = JSON.parse((await DB.prepare("SELECT data FROM medialogos WHERE slug = 'wsb-tv'").first()).data);
    ok((wsb.aliases || []).includes('WSB Channel 2'), 'the outlet’s other spellings are saved');
    // A new outlet without a logo stays out of the strip
    await clickText(page, '.pr-head .btn-primary', /Add an outlet/);
    await page.waitForSelector('#ml-name', { timeout: 5000 });
    ok(await page.$eval('.ml-strip-toggle input', (i) => i.disabled), 'the strip switch waits for a logo');
    await page.type('#ml-name', 'WABE');
    await page.select('#ml-kind', 'entertainment');
    await page.type('#ml-domains', 'https://www.wabe.org/news');
    await page.keyboard.press('Enter');
    await clickText(page, '.kd-dialog .btn-primary', /Add outlet/);
    await sleep(1200);
    const wabe = JSON.parse((await DB.prepare("SELECT data FROM medialogos WHERE slug = 'wabe'").first())?.data || '{}');
    ok(wabe.name === 'WABE' && wabe.slug === 'wabe' && wabe.kind === 'entertainment' && (wabe.domains || []).includes('wabe.org') && wabe.strip !== true, 'a new outlet is added with its kind and website, out of the strip');
    // Deleting an outlet whose stories move to another
    const ajcStories = (await DB.prepare("SELECT slug FROM press WHERE json_extract(data, '$.outletLogo') = 'ajc'").all()).results.map((r) => r.slug);
    await page.evaluate(() => [...document.querySelectorAll('.pr-outlet')].find((b) => /^Atlanta Journal-Constitution$/.test(b.querySelector('.pr-outlet__name')?.textContent))?.click());
    await page.waitForSelector('#ml-name', { timeout: 8000 });
    ok(/Press stories using it/.test(await text(page, '.kd-dialog')), 'the dialog lists the stories from this outlet');
    await clickText(page, '.kd-dialog__foot .btn', /^Delete$/);
    await page.waitForSelector('.pt-move', { timeout: 5000 });
    await page.select('.pt-move__select', '11alive');
    await clickText(page, '.kd-dialog__foot .btn', /Delete outlet/);
    await page.waitForFunction(() => !document.querySelector('.pt-move'), { timeout: 8000 }).catch(() => {});
    await sleep(600);
    const moved = await Promise.all(ajcStories.map(storyIn));
    ok(ajcStories.length > 0 && !(await DB.prepare("SELECT slug FROM medialogos WHERE slug = 'ajc'").first()) && moved.every((x) => x?.outletLogo === '11alive'), `AJC deleted; its ${ajcStories.length} stories moved to 11Alive`);
  });

  await section('Partners and the command palette', async () => {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('soard-navigate', { detail: 'partners-hub' })));
    await page.waitForSelector('.hub-tabs', { timeout: 8000 });
    await sleep(400);
    ok(!/Media logos/.test(await text(page, '.hub-tabs')), 'Partners has no Media logos tab');
    await page.keyboard.down('Meta'); await page.keyboard.press('k'); await page.keyboard.up('Meta');
    await sleep(300);
    await page.keyboard.type('Outlets');
    await sleep(300);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.pr-outlets', { timeout: 8000 }).catch(() => {});
    ok(await page.$('.pr-outlets') !== null, '⌘K → Outlets opens Press → Outlets');
    // A kid's editor lists the stories linked to them, each opening in Press
    const kalenStory = PRESS.find((x) => x.slug === 'fox5-hawks-kalen-2016');
    if (kalenStory) {
      const cur = await storyIn(kalenStory.slug);
      await DB.prepare('UPDATE press SET data = ? WHERE slug = ?').bind(JSON.stringify({ ...cur, kids: ['kalen'] }), kalenStory.slug).run();
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('soard-navigate', { detail: 'dashboard' })));
      await sleep(300);
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('soard-navigate', { detail: 'kids-hub' })));
      await page.keyboard.down('Meta'); await page.keyboard.press('k'); await page.keyboard.up('Meta');
      await sleep(300);
      await page.keyboard.type('Kalen');
      await sleep(300);
      await page.keyboard.press('Enter');
      await page.waitForSelector('.kd-card--site', { timeout: 10000 }).catch(() => {});
      // The admin's lists came from before the link: reload them the way a save would
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('soard-content-changed')));
      const facts = await text(page, '.kd-card--site');
      ok(/In the news/.test(facts), 'the kid editor has an In the news line');
      await page.evaluate(() => [...document.querySelectorAll('.press-links a')][0]?.click());
      await page.waitForSelector('.pr-editor #pr-title', { timeout: 8000 }).catch(() => {});
      ok(await page.$('.pr-editor #pr-title') !== null || /None linked yet/.test(facts), 'a linked story opens in Press');
    }
  });

  await section('Dark', async () => {
    await page.evaluate(() => { location.hash = '#press'; });
    await page.waitForSelector('.pr-rows', { timeout: 10000 });
    await setTheme(page, true);
    await sleep(500);
    await shot(page, 'desk-6-stories-dark.png', 1600);
    await axeCheck(page, 'Stories, dark');
    await clickText(page, '.pr-root .hub-tab', /Found coverage/);
    await sleep(500);
    await shot(page, 'desk-7-found-dark.png', 1800);
    await axeCheck(page, 'Found coverage, dark');
    await setTheme(page, false);
  });
  ok(errors.length === 0, `no console errors on desktop${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);

  // ── Phone ──
  const phone = await open(390, 844, '#press');
  await section('Phone', async () => {
    const p = phone.page;
    await p.waitForSelector('.pr-rows', { timeout: 20000 });
    ok((await overflow(p)).length === 0, `Stories: nothing wider than the screen ${JSON.stringify(await overflow(p))}`);
    await shot(p, 'phone-1-stories.png');
    await axeCheck(p, 'phone Stories');
    const small = await p.$$eval('.pr-root input.form-input', (i) => i.filter((x) => x.offsetParent && parseFloat(getComputedStyle(x).fontSize) < 16).length);
    ok(small === 0, 'fields are 16px (no zoom on focus)');
    const tiny = await p.$$eval('.pr-root .pr-pill, .pr-root .pr-icon-btn, .pr-root .btn', (b) => b.filter((x) => x.offsetParent && x.getBoundingClientRect().height < 43.5).map((x) => x.textContent.trim().slice(0, 20)));
    ok(tiny.length === 0, `targets are 44px ${JSON.stringify(tiny.slice(0, 4))}`);
    await p.evaluate(() => { location.hash = '#press/ajc-2022'; });
    await p.waitForSelector('#pr-title', { timeout: 8000 });
    ok((await overflow(p)).length === 0, `Editor: nothing wider than the screen ${JSON.stringify(await overflow(p))}`);
    ok(await p.$('.pr-side--stacked') !== null, 'the side panel stacks under the form');
    await shot(p, 'phone-2-editor.png');
    await axeCheck(p, 'phone editor');
    await p.evaluate(() => { location.hash = '#press/found'; });
    await p.waitForSelector('.pr-sources', { timeout: 8000 });
    ok((await overflow(p)).length === 0, `Found: nothing wider than the screen ${JSON.stringify(await overflow(p))}`);
    await shot(p, 'phone-3-found.png');
    await p.evaluate(() => { location.hash = '#press/outlets'; });
    await p.waitForSelector('.pr-outlets', { timeout: 8000 });
    ok((await overflow(p)).length === 0, `Outlets: nothing wider than the screen ${JSON.stringify(await overflow(p))}`);
    await shot(p, 'phone-4-outlets.png');
    ok(phone.errors.length === 0, `no console errors on the phone${phone.errors.length ? `: ${phone.errors.slice(0, 3).join(' | ')}` : ''}`);
  });
} catch (e) {
  failures.push(`crashed: ${e.message}`);
  console.error(e);
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} failed:\n - ${failures.join('\n - ')}` : '\nAll checks passed.');
process.exit(failures.length ? 1 : 0);
