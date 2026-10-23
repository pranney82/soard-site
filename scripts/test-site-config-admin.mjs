/**
 * test-site-config-admin.mjs — drive Admin → Site Config in a real browser
 * ===========================================================================
 * Serves public/ (and dist/ behind it) from a local server it starts itself,
 * and answers every /api/read-content, /api/save-content and
 * /api/content-history call with the REAL handlers running here in Node on
 * an in-memory D1 seeded from src/content/site/*.json, so saves, the sha
 * check, audit rows and version history are the real thing. Kids, partners,
 * the image library and uploads are stand-ins; photos come from Cloudflare.
 *
 * Covers, at 1440px and 390px, light and dark:
 *   - the page list (#site/<page>), search, unsaved dots, old tab names
 *   - Homepage: words, ⌘I highlighting into <em>, the second button's arrow,
 *     the hero kid (keyboard) and its photo, the photo picker, the kid strip
 *     (add, Alt+↑ reorder, remove and Undo), the preview
 *   - Save: only changed fields are written over a fresh copy (someone's other
 *     edit and the Applications block stay), the conflict sheet (theirs/mine),
 *     problems that block saving, Discard, ⌘S, the unsaved-changes guard
 *   - History: compare an earlier save with now, put this page's fields back
 *   - FAQ: the About categories can't be removed, reorder by keyboard, a new
 *     question must be filled in, Donate's starred list
 *   - Financials: the shares recalculate, a document is added by upload
 *   - Our Story: Enter starts a new paragraph; Donate: the story kid
 *   - a document that fails to load can't be edited (nothing overwritten)
 *   - phone: the list then a page, back, nothing wider than the screen,
 *     16px inputs, 44px targets
 * Screenshots in test-results/site-config-admin/. Exits non-zero on failure.
 *
 *   node scripts/test-site-config-admin.mjs
 */
import puppeteer from 'puppeteer';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import * as readContentApi from '../functions/api/read-content.js';
import * as saveContentApi from '../functions/api/save-content.js';
import * as historyApi from '../functions/api/content-history.js';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/site-config-admin/');
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

// ── The server side, for real, on an in-memory D1 ──
const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
const SITE_DOCS = ['settings', 'faq', 'our-story', 'media', 'financial-snapshot', 'financials'];
const seedDocs = {};
for (const k of SITE_DOCS) {
  seedDocs[k] = JSON.parse(readFileSync(join(ROOT, `src/content/site/${k}.json`), 'utf8'));
  await DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind(k, JSON.stringify(seedDocs[k]), new Date().toISOString()).run();
}
// The Applications block as Applications → Settings writes it
const withApp = { ...seedDocs.settings, application: { ...(seedDocs.settings.application || {}), open: false, year: '2027', openChangedBy: 'peter@soardcharity.com' } };
await DB.prepare("UPDATE site_config SET data = ? WHERE key = 'settings'").bind(JSON.stringify(withApp)).run();
const env = { DB };
const stored = async (k) => JSON.parse((await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(k).first()).data);
const writeDoc = async (k, d) => DB.prepare('UPDATE site_config SET data = ? WHERE key = ?').bind(JSON.stringify(d), k).run();

const readDir = (d) => readdirSync(join(ROOT, 'src/content', d)).filter((f) => f.endsWith('.json')).map((f) => ({ name: f, path: `src/content/${d}/${f}`, sha: f, content: JSON.parse(readFileSync(join(ROOT, 'src/content', d, f), 'utf8')) }));
const KIDS = readDir('kids');
const PARTNERS = readDir('partners');
const LIBRARY = [...new Set(KIDS.flatMap((k) => [k.content.heroImage, ...(k.content.photos || []).map((p) => p.url)]).filter(Boolean).map((u) => String(u).match(/imagedelivery\.net\/[^/]+\/(.+)\/public$/)?.[1]).filter(Boolean))].slice(0, 200)
  .map((id, i) => ({ id, uploaded: new Date(Date.now() - i * 3600e3).toISOString() }));
const state = { failDoc: null, uploads: 0, files: 0, calls: [] };

const imgCache = new Map();
async function answer(req, user = 'peter@soardcharity.com') {
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
  state.calls.push(`${req.method()} ${p}${url.search}`);
  const real = async (mod, method) => {
    const request = new Request(`https://admin.test${p}${url.search}`, { method: req.method(), body: req.method() === 'POST' ? req.postData() : undefined, headers: { 'content-type': 'application/json' } });
    const res = await mod[method]({ env, request, data: { userEmail: user }, waitUntil: () => {} });
    return req.respond({ status: res.status, contentType: 'application/json', body: Buffer.from(await res.arrayBuffer()) });
  };
  if (p === '/api/read-content') {
    const path = url.searchParams.get('path') || '';
    if (state.failDoc && path.endsWith(`/${state.failDoc}.json`)) return json({ success: false, error: 'D1 is having a moment' }, 500);
    if (path.startsWith('src/content/site/')) return real(readContentApi, 'onRequestGet');
    return json({ success: false, error: 'Not found' }, 404);
  }
  if (p === '/api/save-content') return real(saveContentApi, 'onRequestPost');
  if (p === '/api/content-history') return real(historyApi, 'onRequestGet');
  if (p === '/api/list-content') {
    const dir = url.searchParams.get('dir');
    const items = dir === 'src/content/kids' ? KIDS : dir === 'src/content/partners' ? PARTNERS : dir === 'public/financials' ? [{ name: '2024-990.pdf' }] : [];
    return json({ success: true, items, count: items.length, total: items.length, pages: 1 });
  }
  if (p === '/api/list-images') return json({ success: true, images: LIBRARY, continuation_token: '' });
  if (p === '/api/upload-image') { state.uploads++; return json({ success: true, imageId: `kids/test-upload-${state.uploads}`, imageUrl: '' }); }
  if (p === '/api/upload-file') { state.files++; return json({ success: true, url: `${SITE}/files/financials/x.pdf` }); }
  if (p.startsWith('/api/pending-changes')) return json({ success: true, changes: [], publish: { live: null, active: null, failed: null } });
  if (p.startsWith('/api/kit-status')) return json({ ok: true, configured: true });
  // Upcoming reveals (JobTread): the Up Next strip's date line comes from here
  if (p === '/api/reveals') return json({ reveals: [], upcoming: [{ slug: 'colin', name: 'Colin', confirmed: false, window: { part: 'late', month: '2026-11', through: '2099-11-30', label: 'late November' }, image: null, kidUrl: '/kids/colin/', liveUrl: '/live/colin/', rooms: ['Bathroom'] }] });
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
/** The .sc-field whose label matches, inside `within` */
const fieldSel = async (page, label, within = '.sc-page') => page.evaluateHandle((w, src) => {
  const r = new RegExp(src);
  return [...document.querySelectorAll(`${w} .sc-field`)].find((f) => r.test(f.querySelector(':scope > .sc-label')?.textContent.trim() || '')) || null;
}, within, label.source);
async function typeField(page, label, value, within) {
  const f = await fieldSel(page, label, within);
  const input = await f.$('input, textarea');
  await input.click({ clickCount: 3 });
  await input.evaluate((el) => el.select?.());
  await page.keyboard.press('Backspace');
  if (value) await input.type(value);
}
const valueOf = async (page, label, within) => (await fieldSel(page, label, within)).evaluate((f) => f.querySelector('input, textarea')?.value ?? f.querySelector('.sc-rich-text')?.innerHTML ?? '');
const barState = (page) => text(page, '.sc-bar-state');
const saveNow = async (page) => {
  await clickText(page, '.sc-bar-actions button', /^Save$/);
  await page.waitForFunction(() => !/Saving/.test(document.querySelector('.sc-bar-state')?.textContent || '') && !document.querySelector('.sc-bar[data-state="saving"]'), { timeout: 10000 }).catch(() => {});
  await sleep(150);
};
const goPage = async (page, key) => { await page.evaluate((k) => { location.hash = `#site/${k}`; }, key); await page.waitForFunction((k) => document.querySelector('.sc-rail a.is-on')?.getAttribute('href') === `#site/${k}` && document.querySelector('.sc-page'), { timeout: 10000 }, key).catch(() => {}); await sleep(200); };
async function shot(page, name, maxH = 3200) {
  const vp = page.viewport();
  const h = Math.min(maxH, await page.evaluate(() => document.documentElement.scrollHeight));
  await page.setViewport({ ...vp, height: Math.max(vp.height, h) });
  await sleep(250);
  await page.screenshot({ path: join(OUT, name) });
  await page.setViewport(vp);
}
const DARK = `:root[data-theme="dark"]{color-scheme:dark;--color-bg:#141518;--color-bg-card:#1C1D21;--color-bg-secondary:#222327;--color-bg-hover:#2A2B30;--color-text:#ECECEF;--color-text-secondary:#B9BAC1;--color-text-muted:#9C9DA5;--color-border:#303137;--color-border-strong:#45464D;--color-primary-bg:rgba(255,213,0,.10);--color-primary-ink:#FFD500;--color-danger:#F07A7A;--color-success:#4CC27E;--color-warning:#E8B44A;--shadow-xs:none;--shadow-sm:none}:root[data-theme="dark"] body{background:var(--color-bg);color:var(--color-text)}`;
const setTheme = (page, dark) => page.evaluate((css, on) => {
  let s = document.getElementById('test-dark');
  if (!s) { s = document.createElement('style'); s.id = 'test-dark'; s.textContent = css; document.head.append(s); }
  document.documentElement.dataset.theme = on ? 'dark' : 'light';
}, DARK, dark);

let main;
try {
  main = await open(1440, 1000, '#site');
  const { page, errors, dialogs } = main;

  await section('The page list', async () => {
    await page.waitForSelector('.sc-rail', { timeout: 20000 });
    await page.waitForSelector('.sc-page', { timeout: 15000 });
    ok(/Homepage/.test(await text(page, '.sc-bar h2')), 'desktop opens on the Homepage');
    const titles = await page.$$eval('.sc-rail-title', (els) => els.map((e) => e.textContent.trim()));
    ok(titles.length === 19 && titles.includes('Apply') && titles.includes('Trust badges'), `every page is listed (${titles.length})`);
    await page.type('.sc-rail .sc-search input', 'phone');
    await sleep(100);
    ok(JSON.stringify(await page.$$eval('.sc-rail-title', (els) => els.map((e) => e.textContent.trim()))) === '["Organization & contact"]', 'searching “phone” finds Organization & contact');
    await page.$eval('.sc-rail .sc-search input', (el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
    ok(/Everything is saved/.test(await barState(page)), 'nothing unsaved to start');
    await shot(page, '01-homepage.png');
  });

  await section('Up Next strip: dated from JobTread', async () => {
    const pinned = seedDocs.settings.upNext?.kidSlug;
    const note = await text(page, '#sc-upnext .sc-note');
    if (!pinned || pinned === 'colin') ok(/Colin’s .*“Reveal late November”/.test(note), `the note shows the JobTread date (${note})`);
    else ok(/“Reveal coming soon”/.test(note), `a build with no reveal date says coming soon (${note})`);
    const ph = await page.$$eval('#sc-upnext input', (els) => els.map((e) => e.placeholder));
    ok(ph.includes(!pinned || pinned === 'colin' ? 'Reveal late November' : 'Reveal coming soon'), `the date line's placeholder is the automatic one (${JSON.stringify(ph)})`);
  });

  await section('Homepage words', async () => {
    await typeField(page, /^Small line above the headline$/, 'Atlanta nonprofit · Since 2012');
    ok(/Unsaved changes here/.test(await barState(page)), 'the bar says there are unsaved changes');
    ok(await page.$eval('.sc-rail a[href="#site/home"] .sc-dirty', () => true).catch(() => false), 'the Homepage gets an unsaved dot in the list');
    ok(/Atlanta nonprofit · Since 2012/i.test(await text(page, '.sc-hero-pv-eyebrow')), 'the preview follows the words');
    // Highlight a word in the second headline line with ⌘I / Ctrl+I
    const line2 = await (await fieldSel(page, /^Headline, second line$/)).$('.sc-rich-text');
    await line2.click();
    await page.evaluate((el) => {
      const t = el.firstChild;
      const i = t.textContent.indexOf('room');
      const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 4);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }, line2);
    await page.keyboard.down('Control'); await page.keyboard.press('i'); await page.keyboard.up('Control');
    await sleep(100);
    ok(/<em>room<\/em>/.test(await line2.evaluate((el) => el.innerHTML)) || /<i>room<\/i>/.test(await line2.evaluate((el) => el.innerHTML)), 'Ctrl+I highlights the word');
    ok(/<em>room<\/em>/.test(await page.$eval('.sc-hero-pv-h', (e) => e.innerHTML)), 'the preview shows it in the marker');
    const cta2 = await valueOf(page, /^Second button$/);
    if (/↓/.test(cta2)) {
      ok(/draws its own arrow/.test(await text(page, '.sc-page')), 'a typed arrow on the second button is called out');
      ok(await clickText(page, '.sc-page .sc-link', /^Remove it$/), 'Remove it');
      ok(!/↓/.test(await valueOf(page, /^Second button$/)), 'the arrow is gone');
    }
    await typeField(page, /^Goes to$/, 'donate');
    ok(/Start with \//.test(await text(page, '.sc-page')), 'a link without / is explained');
    ok(await page.$eval('.sc-bar-actions .btn-primary', (b) => b.disabled), 'and Save is blocked');
    ok(/Fix the first hero button’s link/.test(await barState(page)), 'the bar says what to fix');
    await typeField(page, /^Goes to$/, '/donate/');
    ok(!(await page.$eval('.sc-bar-actions .btn-primary', (b) => b.disabled)), 'fixed, Save is back');
  });

  await section('Hero kid and photo', async () => {
    const kidField = await fieldSel(page, /^Who’s in the hero photo$/);
    await (await kidField.$('.sc-kid-btn')).click();
    await page.waitForSelector('.sc-pop input', { timeout: 3000 });
    await page.keyboard.type('Dex');
    await sleep(100);
    await page.keyboard.press('Enter');
    await sleep(200);
    ok(/Dex/.test(await kidField.evaluate((f) => f.querySelector('.sc-kid-btn').textContent)), 'picked Dex with the keyboard');
    const photoFrom = await text(page, '[data-photo="heroKidPhotoId"] .sc-photo-from');
    ok(/Dex/.test(photoFrom), `the hero photo follows the kid (${photoFrom})`);
    // Change the photo through the picker
    await page.click('[data-photo="heroKidPhotoId"] .sc-photo-frame');
    await page.waitForSelector('.sc-dialog .sc-tile', { timeout: 8000 });
    ok(/Dex/.test(await text(page, '.sc-pick-kidlist .is-on')), 'the picker opens on Dex’s photos');
    const tiles = await page.$$('.sc-dialog .sc-pick-grid .sc-tile');
    await tiles[Math.min(2, tiles.length - 1)].click();
    ok(/As the page crops it \(4:5/.test(await text(page, '.sc-dialog-foot')), 'the picker shows the page’s crop');
    await shot(page, '02-photo-picker.png', 1200);
    await clickText(page, '.sc-dialog-foot button', /^Use this photo$/);
    await sleep(200);
    ok(!(await page.$('.sc-dialog')), 'the picker closes');
    // The library and an upload
    await page.click('[data-photo="sectionPhotos.roomBath"] .sc-photo-frame');
    await page.waitForSelector('.sc-dialog', { timeout: 5000 });
    await clickText(page, '.sc-dialog .sc-tabs button', /^All images$/);
    await page.waitForSelector('.sc-dialog .sc-pick-lib .sc-tile', { timeout: 8000 }).catch(() => {});
    ok((await page.$$('.sc-dialog .sc-pick-lib .sc-tile')).length > 10, 'All images lists the library');
    await clickText(page, '.sc-dialog .sc-tabs button', /^Upload$/);
    const input = await page.$('.sc-dialog input[type="file"]');
    await input.uploadFile(join(ROOT, 'public/icon-192.png'));
    await page.waitForFunction(() => /test-upload/.test(document.querySelector('.sc-dialog .sc-tile.is-sel img')?.src || ''), { timeout: 8000 }).catch(() => {});
    ok(state.uploads === 1, 'an upload goes to the image library');
    await clickText(page, '.sc-dialog-foot button', /^Use this photo$/);
    await sleep(200);
    ok(/test-upload/.test(await page.$eval('[data-photo="sectionPhotos.roomBath"] img', (i) => i.src)), 'and is used, cropped like the page');
  });

  await section('Kid strip: add, reorder, remove and undo', async () => {
    await page.evaluate(() => document.getElementById('sc-strip').scrollIntoView());
    const before = await page.$$eval('#sc-strip .sc-row strong', (els) => els.map((e) => e.textContent));
    await clickText(page, '#sc-strip .sc-add', /Add a kid/);
    await page.waitForSelector('#sc-strip .sc-adding .sc-kid-btn');
    await page.click('#sc-strip .sc-adding .sc-kid-btn');
    await page.waitForSelector('.sc-pop input');
    const add = KIDS.map((k) => k.content).find((k) => k.publishStatus !== 'draft' && k.name && !(seedDocs.settings.kidShowcase || []).some((x) => x.slug === k.slug));
    await page.keyboard.type(add.name);
    await sleep(100);
    await page.keyboard.press('Enter');
    await sleep(200);
    let names = await page.$$eval('#sc-strip .sc-row strong', (els) => els.map((e) => e.textContent));
    ok(names.length === before.length + 1 && names.at(-1).startsWith(add.name), `added ${add.name} at the end (${names.join(', ')})`);
    const last = (await page.$$('#sc-strip .sc-row')).at(-1);
    await (await last.$('.sc-grip')).focus();
    await page.keyboard.down('Alt'); await page.keyboard.press('ArrowUp'); await page.keyboard.up('Alt');
    await sleep(200);
    const moved = await page.$$eval('#sc-strip .sc-row strong', (els) => els.map((e) => e.textContent));
    ok(moved.at(-2) === names.at(-1) && moved.at(-1) === names.at(-2), `Alt+↑ moves it up one (${moved.slice(-2).join(', ')})`);
    ok(await page.evaluate((n) => document.activeElement?.classList.contains('sc-grip') && document.activeElement.closest('.sc-row').textContent.includes(n), add.name), 'focus stays on the moved kid');
    names = moved;
    const n0 = names.length;
    await (await (await page.$$('#sc-strip .sc-row'))[0].$('.sc-remove')).click();
    await sleep(150);
    ok((await page.$$('#sc-strip .sc-row')).length === n0 - 1, 'remove');
    ok(await clickText(page, '.toast-container button', /^Undo$/), 'Undo is offered');
    await sleep(150);
    ok((await page.$$('#sc-strip .sc-row')).length === n0, 'and brings it back');
  });

  await section('Save writes only what changed, over a fresh copy', async () => {
    // Someone else saves another setting while this editor is open
    const s0 = await stored('settings');
    await writeDoc('settings', { ...s0, social: { ...s0.social, tiktok: 'https://www.tiktok.com/@someone-else' } });
    await saveNow(page);
    const s = await stored('settings');
    ok(s.homeHero.eyebrow === 'Atlanta nonprofit · Since 2012', 'the eyebrow is saved');
    ok(/<em>room<\/em>/.test(s.homeHero.headlineLine2), `the highlight is stored as the page’s markup (${s.homeHero.headlineLine2})`);
    ok(s.heroKidSlug === 'dex' && /kids\/dex\//.test(s.heroKidPhotoId), 'the hero kid and photo');
    ok(s.photoTimestamps?.heroKidPhotoId && s.photoTimestamps?.['sectionPhotos.roomBath'], 'photo dates are kept under their paths');
    ok(s.social.tiktok === 'https://www.tiktok.com/@someone-else', 'someone else’s change to another setting is kept');
    ok(s.application?.openChangedBy === 'peter@soardcharity.com' && s.application.year === '2027', 'the Applications block is untouched');
    ok(/Everything is saved|On the site after you publish/.test(await barState(page)), `the bar settles (${await barState(page)})`);
    const audit = await DB.prepare("SELECT entity_type, changes FROM audit_log WHERE entity_type = 'settings' ORDER BY id DESC").first();
    ok(!!audit, 'logged like any site settings save');
  });

  await section('Conflicts: the same field changed elsewhere', async () => {
    const s0 = await stored('settings');
    await writeDoc('settings', { ...s0, homeHero: { ...s0.homeHero, eyebrow: 'Changed in another tab' } });
    await typeField(page, /^Small line above the headline$/, 'Mine wins');
    await saveNow(page);
    await page.waitForSelector('.sc-dialog .sc-diff', { timeout: 5000 }).catch(() => {});
    const d = await text(page, '.sc-dialog');
    ok(/Someone else changed the same things/.test(d) && /Changed in another tab/.test(d) && /Mine wins/.test(d), 'the sheet shows both');
    await shot(page, '03-conflict.png', 1000);
    await clickText(page, '.sc-dialog-foot button', /^Save with these$/);
    await page.waitForFunction(() => !document.querySelector('.sc-dialog'), { timeout: 8000 }).catch(() => {});
    await sleep(300);
    ok((await stored('settings')).homeHero.eyebrow === 'Mine wins', 'keeping mine writes mine');
    // And taking theirs
    const s1 = await stored('settings');
    await writeDoc('settings', { ...s1, homeHero: { ...s1.homeHero, eyebrow: 'Theirs this time' } });
    await typeField(page, /^Small line above the headline$/, 'Mine again');
    await saveNow(page);
    await page.waitForSelector('.sc-dialog .sc-diff', { timeout: 5000 }).catch(() => {});
    await page.evaluate(() => [...document.querySelectorAll('.sc-dialog input[type="radio"]')].find((r) => /Use theirs/.test(r.parentElement.textContent))?.click());
    await clickText(page, '.sc-dialog-foot button', /^Save with these$/);
    await page.waitForFunction(() => !document.querySelector('.sc-dialog'), { timeout: 8000 }).catch(() => {});
    await sleep(300);
    ok((await stored('settings')).homeHero.eyebrow === 'Theirs this time', 'taking theirs keeps theirs');
    ok(await valueOf(page, /^Small line above the headline$/) === 'Theirs this time', 'and the field shows it');
  });

  await section('History: compare and put back', async () => {
    await clickText(page, '.sc-bar-actions button', /History/);
    await page.waitForSelector('.sc-dialog .sc-hist li', { timeout: 8000 });
    const rows = await page.$$eval('.sc-dialog .sc-hist li', (els) => els.map((e) => e.innerText));
    ok(rows.length >= 3 && rows.some((r) => /Peter/.test(r)), `saves are listed with who (${rows.length})`);
    // The oldest is the seed: compare it and put the eyebrow back
    const buttons = await page.$$('.sc-dialog .sc-hist li button');
    await buttons.at(-1).click();
    await page.waitForSelector('.sc-dialog .sc-diff li, .sc-dialog .sc-empty', { timeout: 8000 });
    const diff = await text(page, '.sc-dialog .sc-diff');
    ok(/Hero: small line above the headline/.test(diff), 'what differs from now, by name');
    await clickText(page, '.sc-dialog-foot button', /^Put these back$/);
    await sleep(200);
    ok(await valueOf(page, /^Small line above the headline$/) === (seedDocs.settings.homeHero?.eyebrow || ''), 'the earlier words are back in the editor');
    ok(/Unsaved changes/.test(await barState(page)), 'waiting to be saved');
    await clickText(page, '.sc-bar-actions button', /^Discard$/);
    await sleep(150);
    ok(await valueOf(page, /^Small line above the headline$/) === 'Theirs this time', 'Discard returns to what’s saved');
  });

  await section('Edits on two pages, one Save; ⌘S', async () => {
    await typeField(page, /^Small line above the headline$/, 'Two pages');
    await goPage(page, 'kids');
    await typeField(page, /^Line$/, 'Every room changes a world.');
    ok(/here and on Homepage/.test(await barState(page)), `the bar names the other page (${await barState(page)})`);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('soard-save')));
    await page.waitForFunction(() => /Everything is saved|after you publish/.test(document.querySelector('.sc-bar-state')?.textContent || ''), { timeout: 8000 }).catch(() => {});
    const s = await stored('settings');
    ok(s.homeHero.eyebrow === 'Two pages' && s.kidsPageSummary === 'Every room changes a world.', '⌘S saves both');
  });

  await section('Apply and Donate', async () => {
    await goPage(page, 'apply');
    ok(/Applications are closed/.test(await text(page, '.sc-callout')), 'Apply shows open or closed from Applications');
    ok(/Same as the small inset photo/.test(await text(page, '[data-photo="applyPhotos.build"]')) || !!(await stored('settings')).applyPhotos?.build, 'a blank Step 4 shows the inset photo');
    await clickText(page, '.sc-page .sc-add', /Add a question/);
    await sleep(100);
    ok(/Fix a question without its words/.test(await barState(page)), 'a new blank question blocks saving');
    const qs = await page.$$('.sc-page .sc-list .sc-row');
    await (await qs.at(-1).$('.sc-remove')).click();
    await sleep(100);
    await goPage(page, 'donate');
    const storyKid = await fieldSel(page, /^Family$/);
    await (await storyKid.$('.sc-kid-btn')).click();
    await page.waitForSelector('.sc-pop input');
    await page.keyboard.type('Dylan');
    await page.keyboard.press('Enter');
    await sleep(150);
    await saveNow(page);
    const dp = (await stored('settings')).donatePhotos;
    ok(/dylan/.test(dp.storyKidSlug || '') && /Dylan/.test(dp.storyKidName || ''), `the story kid is saved by page address too (${dp.storyKidSlug}, ${dp.storyKidName})`);
    ok(!/photo is from/.test(await text(page, '.sc-page')), 'and the photo matches the family now');
    ok(/Donations/.test(await text(page, '.sc-page')), 'the starred FAQ category is listed');
  });

  await section('FAQ', async () => {
    await goPage(page, 'faq');
    ok(await page.$eval('#sc-cats .sc-list .sc-row:nth-child(2) .sc-remove', (b) => b.disabled && /Our Story/.test(b.title)), 'a category Our Story shows can’t be removed');
    const cat = (await stored('faq')).categories[0];
    const firstList = `#sc-cat-${cat.id} .sc-list`;
    const before = await page.$$eval(`${firstList} .sc-faq strong`, (els) => els.map((e) => e.textContent));
    await page.focus(`${firstList} .sc-row:nth-child(2) .sc-grip`);
    await page.keyboard.down('Alt'); await page.keyboard.press('ArrowUp'); await page.keyboard.up('Alt');
    await sleep(150);
    const after = await page.$$eval(`${firstList} .sc-faq strong`, (els) => els.map((e) => e.textContent));
    ok(after[0] === before[1] && after[1] === before[0], 'Alt+↑ swaps the first two questions');
    await clickText(page, `#sc-cat-${cat.id} .sc-add`, /Add a question/);
    await sleep(150);
    ok(/Fix a question without its words/.test(await barState(page)), 'a new question must be filled in');
    await typeField(page, /^Question \d+$/, 'Do you take gift cards?', `#sc-cat-${cat.id}`);
    const ans = await (await fieldSel(page, /^Answer$/, `#sc-cat-${cat.id}`)).$('.sc-rich-text');
    await ans.click();
    await page.keyboard.type('Yes, at the store.');
    await clickText(page, `#sc-cat-${cat.id} .sc-faq-foot button`, /^Done$/);
    await saveNow(page);
    const f = await stored('faq');
    const mine = f.items.filter((i) => i.category === cat.id).sort((a, b) => a.order - b.order);
    ok(mine[0].question === before[1] && mine[1].question === before[0], 'the new order is saved by position');
    ok(mine.at(-1).question === 'Do you take gift cards?' && /Yes, at the store\./.test(mine.at(-1).answer), `the new question is saved last (${JSON.stringify(mine.at(-1))})`);
  });

  await section('Financials', async () => {
    await goPage(page, 'financials');
    const programs = await fieldSel(page, /^Programs$/);
    const inp = await programs.$('input');
    await inp.click({ clickCount: 3 });
    await inp.type('3000000');
    await sleep(100);
    const s0 = seedDocs['financial-snapshot'];
    const want = Math.round((3000000 / (3000000 + s0.managementExpenses + s0.fundraisingExpenses)) * 100);
    ok(new RegExp(`Programs ${want}¢`).test(await text(page, '.sc-split-key')), `the shares recalculate (${(await text(page, '.sc-split-key')).replace(/\n/g, ' · ')})`);
    await clickText(page, '#sc-docs .sc-docs-head button', /Add/);
    await page.waitForSelector('.sc-dialog input[type="file"]');
    await (await page.$('.sc-dialog input[type="file"]')).uploadFile(join(ROOT, 'public/icon-192.png'));
    await sleep(100);
    await clickText(page, '.sc-dialog-foot button', /^Add$/);
    await page.waitForFunction(() => !document.querySelector('.sc-dialog'), { timeout: 8000 }).catch(() => {});
    ok(state.files === 1, 'the file uploads');
    await saveNow(page);
    const snap = await stored('financial-snapshot');
    const fin = await stored('financials');
    ok(snap.programExpenses === 3000000 && snap.programPct > 85 && snap.totalExpenses === 3000000 + snap.managementExpenses + snap.fundraisingExpenses, 'the numbers and shares are saved');
    ok(fin.documents.length === seedDocs.financials.documents.length + 1 && /icon-192/.test(fin.documents.at(-1).fileName || ''), 'the document is added');
    await shot(page, '04-financials.png');
  });

  await section('Our Story: Enter starts a paragraph', async () => {
    await goPage(page, 'about');
    const first = await page.$('#sc-founders .sc-para .sc-rich-text');
    const n0 = (await page.$$('#sc-founders .sc-para')).length;
    await first.click();
    await page.keyboard.press('End');
    await page.evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }, first);
    await page.keyboard.press('Enter');
    await sleep(150);
    ok((await page.$$('#sc-founders .sc-para')).length === n0 + 1, 'Enter adds a paragraph after');
    ok(await page.evaluate(() => document.activeElement?.closest('.sc-para') === document.querySelectorAll('#sc-founders .sc-para')[1]), 'and puts the cursor in it');
    await page.keyboard.type('A new paragraph.');
    await saveNow(page);
    ok((await stored('our-story')).founders.paragraphs[1] === 'A new paragraph.', `saved in place (${JSON.stringify((await stored('our-story')).founders.paragraphs.slice(0, 3).map((x) => String(x).slice(0, 40)))})`);
    ok(/<em class="highlight">/.test((await stored('our-story')).founders.heading), 'the heading keeps its highlight markup');
  });

  await section('A document that fails to load can’t be edited', async () => {
    state.failDoc = 'media';
    await goPage(page, 'media');
    await page.waitForFunction(() => /Couldn’t load/.test(document.querySelector('.sc-main')?.innerText || ''), { timeout: 8000 }).catch(() => {});
    ok(/Couldn’t load this page’s settings/.test(await text(page, '.sc-main')) && !(await page.$('.sc-page input')), 'an error and no fields, so nothing gets overwritten');
    state.failDoc = null;
    await clickText(page, '.sc-main button', /^Try again$/);
    await page.waitForSelector('.sc-page input', { timeout: 8000 }).catch(() => {});
    ok(!!(await page.$('.sc-page input')), 'Try again loads it');
  });

  await section('Leaving with unsaved changes asks first', async () => {
    await goPage(page, 'social');
    await typeField(page, /^Facebook$/, 'https://www.facebook.com/soard-test');
    dialogs.length = 0;
    await clickText(page, '.nav-item', /^Kids$/);
    await sleep(300);
    ok(dialogs.some((m) => /unsaved changes in Site Config/.test(m)), `the admin asks (${dialogs[0] || 'no prompt'})`);
  });

  await section('Dark', async () => {
    const d = await open(1440, 1000, '#site/home');
    await d.page.waitForSelector('.sc-page');
    await setTheme(d.page, true);
    await shot(d.page, '05-homepage-dark.png', 1800);
    await goPage(d.page, 'financials');
    await shot(d.page, '06-financials-dark.png', 1800);
    ok(d.errors.length === 0, `no console errors in dark${d.errors.length ? `: ${d.errors.slice(0, 3).join(' | ')}` : ''}`);
    await d.page.close();
  });

  ok(errors.length === 0, `no console errors on desktop${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
  await page.close();

  await section('Phone', async () => {
    const ph = await open(390, 844, '#site');
    const p = ph.page;
    await p.waitForSelector('.sc-rail', { timeout: 20000 });
    ok(await p.$eval('.sc-area', (e) => e.classList.contains('is-list')) && !(await p.$('.sc-bar')), 'a phone starts on the list of pages');
    await clickText(p, '.sc-rail a', /^Homepage/);
    await p.waitForSelector('.sc-page', { timeout: 10000 });
    ok(await p.$eval('.sc-rail', (e) => getComputedStyle(e).display === 'none'), 'a page fills the screen');
    const wide = () => p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    ok(await wide() <= 1, `nothing wider than the screen (${await wide()}px over)`);
    ok(await p.$eval('.sc-page input', (e) => parseFloat(getComputedStyle(e).fontSize) >= 16), 'inputs are 16px (no zoom on focus)');
    const small = await p.$$eval('.sc-bar button, .sc-row-tools button, .sc-grip', (els) => els.filter((e) => e.offsetParent && (e.getBoundingClientRect().width < 44 && e.getBoundingClientRect().height < 44)).length);
    ok(small === 0, `touch targets are at least 44px (${small} smaller)`);
    await p.screenshot({ path: join(OUT, '10-phone-home.png') });
    for (const k of ['apply', 'financials', 'faq', 'about', 'badges']) {
      await goPage(p, k);
      ok(await wide() <= 1, `${k}: nothing wider than the screen (${await wide()}px over)`);
      await p.screenshot({ path: join(OUT, `11-phone-${k}.png`) });
    }
    await p.click('.sc-back');
    await sleep(200);
    ok(await p.$eval('.sc-area', (e) => e.classList.contains('is-list')), 'back returns to the list');
    // The kid picker is a sheet at the bottom on a phone
    await clickText(p, '.sc-rail a', /^Homepage/);
    await p.waitForSelector('.sc-kid-btn');
    await p.click('.sc-kid-btn');
    await p.waitForSelector('.sc-pop');
    const pop = await p.$eval('.sc-pop', (e) => { const r = e.getBoundingClientRect(); return { bottom: Math.round(r.bottom), w: Math.round(r.width) }; });
    ok(pop.bottom >= 820 && pop.w >= 360, `the kid list is a bottom sheet (${JSON.stringify(pop)})`);
    await p.screenshot({ path: join(OUT, '12-phone-kid-picker.png') });
    ok(ph.errors.length === 0, `no console errors on the phone${ph.errors.length ? `: ${ph.errors.slice(0, 3).join(' | ')}` : ''}`);
    await p.close();
  });
} catch (e) {
  failures.push(`crashed: ${e.message}`);
  console.error(e);
}

await browser.close();
server.close();
console.log(failures.length ? `\n${failures.length} failed:\n - ${failures.join('\n - ')}` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
