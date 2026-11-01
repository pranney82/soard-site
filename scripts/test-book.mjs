/**
 * test-book.mjs — the anniversary book, end to end, in a real browser
 * ===========================================================================
 * 1. Makes a test PDF (Chrome prints it): 11 PDF pages, one of them a
 *    double-width spread, bookmarks, links to its own chapters and the web,
 *    and letter-spaced type.
 * 2. Admin → Site Config → Anniversary book, served from a local server whose
 *    /api/read-content, /api/save-content, /api/content-history and
 *    /api/book-admin are the REAL handlers (an in-memory D1 and R2), with
 *    Cloudflare Images kept in memory: drop the PDF in, watch the pages come,
 *    then check what went up (every page, the whole PDF in parts, the words
 *    file, the manifest), the chapters from the bookmarks, the address check,
 *    Save, the Preview's real reader, and that replacing the PDF twice
 *    clears the first upload away (never the saved or live one). Phone width too.
 * 3. Builds the site with what was saved (BOOK_FIXTURE) and reads it like a
 *    visitor: the hero, the cover, keys, a dragged corner, rapid clicks, the
 *    contents page's links, search and its marks, zoom, full screen, the
 *    address (?page=), a phone's tap, swipe and pinch, reduced motion, and no WebGL.
 * Screenshots land in test-results/book/. Exits non-zero on any failure or
 * page error.
 *
 *   node scripts/test-book.mjs
 */
import puppeteer from 'puppeteer';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import { createR2 } from '../tests/lib/r2-shim.mjs';
import * as readContentApi from '../functions/api/read-content.js';
import * as saveContentApi from '../functions/api/save-content.js';
import * as historyApi from '../functions/api/content-history.js';
import * as bookAdminApi from '../functions/api/book-admin.js';
import * as bookStatsApi from '../functions/api/book-stats.js';
import * as bookStatsAdminApi from '../functions/api/book-stats-admin.js';
import { answerAsks } from './lib/ask.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/book/');
const TMP = mkdtempSync(join(tmpdir(), 'soard-book-'));
mkdirSync(OUT, { recursive: true });
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function section(name, fn) {
  console.log(name);
  try { await fn(); } catch (e) { failures.push(`${name}: crashed: ${e.message}`); console.error(`  ✗ crashed: ${e.stack || e.message}`); }
}
const GL = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--hide-scrollbars'];
const build = (outDir, env = {}) => {
  const r = spawnSync('npx', ['astro', 'build', '--outDir', outDir], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`astro build failed:\n${(r.stdout + r.stderr).slice(-2000)}`);
};

// ── 1. A test PDF ──────────────────────────────────────────────────
const PDF = join(TMP, 'Our 15 Years (final).pdf');
{
  const page = (cls, body, id = '') => `<section class="pg ${cls}"${id ? ` id="${id}"` : ''}>${body}</section>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: 8.5in 11in; margin: 0 } @page wide { size: 17in 11in; margin: 0 }
    * { margin: 0; box-sizing: border-box } body { font: 16pt Georgia, serif; color: #333 }
    .pg { width: 8.5in; height: 11in; padding: 1in; page-break-after: always; position: relative; overflow: hidden; background: #FEFCF5 }
    .wide { page: wide; width: 17in; background: #2B6CB0; color: #fff } .dark { background: #373A36; color: #fff } .sun { background: #FFDA24 }
    h1 { font-size: 44pt; margin-bottom: .3in } h2 { font-size: 30pt } .track { letter-spacing: .3em; font: 700 12pt Arial }
    a { color: inherit } li { margin: .2in 0 }
  </style></head><body>
    ${page('sun', '<p class="track">2012 · 2027</p><h1>Fifteen Years</h1><p>Sunshine on a Ranney Day</p>')}
    ${page('', '<p><em>For every family.</em></p>')}
    ${page('', '<h2>Contents</h2><ol><li><a href="#c1">The First Rooms</a></li><li><a href="#c2">Going Live</a></li></ol>')}
    ${page('dark', '<h1>The First Rooms</h1><p>2012 to 2014</p>', 'c1')}
    ${page('', '<h2>Mathew</h2><p>A military bedroom built for Mathew, the very first room. His zephyr blue walls were his own idea.</p>')}
    ${page('wide', '<p style="font-size:40pt">Reveal day, across two pages</p><p>A photograph across the spread.</p>')}
    ${page('dark', '<h1>Going Live</h1><p>2015 to 2018</p>', 'c2')}
    ${page('', '<h2>Tripp</h2><p>A whole-home makeover watched live by more than a million people.</p>')}
    ${page('', '<h2>Thank you</h2><p>Give at <a href="https://sunshineonaranneyday.com/donate/">sunshineonaranneyday.com/donate</a>.</p>')}
    ${page('', '<p>Notes</p>')}
    ${page('dark', '<p>Sunshine on a Ranney Day</p>')}
  </body></html>`;
  const b = await puppeteer.launch({ headless: 'shell' });
  const p = await b.newPage();
  await p.setContent(html, { waitUntil: 'load' });
  await p.pdf({ path: PDF, printBackground: true, preferCSSPageSize: true, outline: true });
  await b.close();
}
const PDF_BYTES = readFileSync(PDF);
const BOOK_PAGES = 12; // 11 PDF pages, one of them two

// ── 2. The admin, on a local server with the real handlers ─────────
console.log('Building the site (no book yet) for the Preview’s reader page…');
const DIST_A = join(TMP, 'dist-a');
build(DIST_A);
let staticRoots = ['public', DIST_A];

const DB = await createD1({ schemaFiles: [join(ROOT, 'scripts/schema.sql')] });
for (const k of ['settings', 'faq', 'financial-snapshot']) {
  const f = join(ROOT, `src/content/site/${k}.json`);
  if (existsSync(f)) await DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind(k, readFileSync(f, 'utf8'), new Date().toISOString()).run();
}
const FILES = createR2();
const images = new Map(); // Cloudflare Images: id → bytes
const state = { uploads: 0, deletes: [], calls: [], failOnce: null };
const env = { DB, FILES };

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const IMG_PREFIX = '/cdn-cgi/imagedelivery/ROYFuPmfN2vPS6mt5sCkZQ/';
/** An image from the store by its delivery path, or null */
const imageAt = (path) => {
  const rest = path.slice(IMG_PREFIX.length).split('/');
  const variant = rest[rest.length - 1];
  const id = (variant === 'public' || variant.includes('=') ? rest.slice(0, -1) : rest).map(decodeURIComponent).join('/');
  return images.get(id) || null;
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  const send = (status, b, type, extra = {}) => { if (res.writableEnded || res.destroyed) return; res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*', ...extra }); res.end(b); };
  const json = (o, status = 200) => send(status, JSON.stringify(o), 'application/json');
  try {
    // A request the admin cancels (Stop) ends here, not the server
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (p.startsWith(IMG_PREFIX)) { const b = imageAt(p); return b ? send(200, b, 'image/jpeg') : send(404, 'no image', 'text/plain'); }
    if (p.startsWith('/files/')) {
      const o = await FILES.get(p.slice('/files/'.length));
      return o ? send(200, Buffer.from(await o.arrayBuffer()), o.httpMetadata.contentType || 'application/octet-stream') : send(404, 'not found', 'text/plain');
    }
    if (p.startsWith('/api/')) {
      state.calls.push(`${req.method} ${p}${url.search}`);
      const real = async (mod, method) => {
        const request = new Request(`https://admin.test${p}${url.search}`, { method: req.method, body: req.method === 'POST' ? body : undefined, headers: { 'content-type': req.headers['content-type'] || 'application/json' } });
        const r = await mod[method]({ env, request, data: { userEmail: 'staff@example.org' }, waitUntil: () => {} });
        return send(r.status, Buffer.from(await r.arrayBuffer()), 'application/json');
      };
      if (p === '/api/read-content') {
        if ((url.searchParams.get('path') || '').startsWith('src/content/site/')) return real(readContentApi, 'onRequestGet');
        return json({ success: false, error: 'Not found' }, 404);
      }
      if (p === '/api/save-content') return real(saveContentApi, 'onRequestPost');
      if (p === '/api/content-history') return real(historyApi, 'onRequestGet');
      if (p === '/api/book-admin') return real(bookAdminApi, 'onRequestPost');
      if (p === '/api/book-stats') return real(bookStatsApi, 'onRequestPost');
      if (p === '/api/book-stats-admin') return real(bookStatsAdminApi, 'onRequestGet');
      if (p === '/api/upload-image') {
        const fd = await new Request('http://x', { method: 'POST', body, headers: { 'content-type': req.headers['content-type'] } }).formData();
        const id = fd.get('id');
        // A connection that drops on one page, once
        if (state.failOnce && id.endsWith(state.failOnce)) { state.failOnce = null; return json({ success: false, error: 'The connection dropped' }, 400); }
        if (images.has(id)) return json({ success: false, error: 'Resource already exists' }, 400);
        images.set(id, Buffer.from(await fd.get('file').arrayBuffer()));
        state.uploads++;
        return json({ success: true, imageId: id, imageUrl: `https://imagedelivery.net/x/${id}/public` });
      }
      if (p === '/api/delete-image') {
        const { imageId } = JSON.parse(body.toString() || '{}');
        state.deletes.push(imageId);
        return images.delete(imageId) ? json({ success: true }) : json({ success: false, error: 'Image not found' }, 404);
      }
      if (p.startsWith('/api/pending-changes')) return json({ success: true, changes: [], publish: { live: null, active: null, failed: null } });
      if (p.startsWith('/api/live-ws')) return send(404, '', 'text/plain');
      return json({ success: true, ok: true, items: [], list: [], entries: [] });
    }
    for (const base of staticRoots) {
      let f = join(base.startsWith('/') ? base : join(ROOT, base), p);
      try {
        if ((await stat(f)).isDirectory()) f = join(f, 'index.html');
        return send(200, await readFile(f), TYPES[extname(f)] || 'application/octet-stream');
      } catch { /* next */ }
    }
    send(404, 'not found', 'text/plain');
  } catch (e) {
    if (!/aborted|ECONNRESET/.test(String(e?.code || e?.message))) console.error('server:', e);
    json({ success: false, error: String(e.message || e) }, 500);
  }
}).listen(0, '127.0.0.1');
await new Promise((r) => server.on('listening', r));
const SITE = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({ headless: 'shell', args: GL });
/** A page that answers the site's own Cloudflare image addresses from the store */
async function newPage({ width = 1440, height = 1000, mobile = false, reduce = false } = {}, b = browser) {
  const page = await b.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  if (reduce) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|live-ws|WebSocket/.test(m.text())) page.errors.push(m.text()); });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.isInterceptResolutionHandled()) return;
    const u = new URL(req.url());
    if (u.hostname === 'sunshineonaranneyday.com' && u.pathname.startsWith(IMG_PREFIX)) {
      const bytes = imageAt(decodeURIComponent(u.pathname));
      return req.respond(bytes ? { status: 200, contentType: 'image/jpeg', headers: { 'access-control-allow-origin': '*' }, body: bytes } : { status: 404, body: '' });
    }
    if (u.origin !== SITE && !/^(data|blob):/.test(req.url())) return req.respond({ status: 404, body: '' });
    req.continue();
  });
  return page;
}
const text = (page, sel) => page.$eval(sel, (e) => e.innerText).catch(() => '');
const clickText = (page, sel, re) => page.evaluate((s, src, flags) => {
  const r = new RegExp(src, flags);
  const el = [...document.querySelectorAll(s)].find((x) => x.offsetParent !== null && r.test(x.textContent.trim()));
  if (el) { el.click(); return true; }
  return false;
}, sel, re.source, re.flags);
const readStatsNow = async () => (await import('../functions/api/_book-stats.js')).readStats(DB, { days: 0, version: (await stored())?.version });
const stored = async () => { const row = await DB.prepare("SELECT data FROM site_config WHERE key = 'book'").first(); return row ? JSON.parse(row.data) : null; };
const versions = () => [...new Set([...FILES.objects.keys()].filter((k) => k.startsWith('books/')).map((k) => k.split('/')[1]))].sort();
async function upload(page) {
  const input = await page.$('#sc-book input[type="file"]');
  await input.uploadFile(PDF);
  await page.waitForSelector('.bk-work', { timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('.bk-work') && document.querySelector('.bk-have'), { timeout: 180000 });
  await sleep(300);
}
const saveNow = async (page) => {
  await clickText(page, '.sc-bar-actions button', /^Save$/);
  await page.waitForFunction(() => document.querySelector('.sc-bar')?.dataset.state !== 'saving' && !/Saving/.test(document.querySelector('.sc-bar-state')?.textContent || ''), { timeout: 15000 }).catch(() => {});
  await sleep(300);
};

let admin;
await section('Admin: the empty book, then the PDF dropped in', async () => {
  admin = await newPage();
  await answerAsks(admin);
  await admin.goto(`${SITE}/admin/index.html#site/book`, { waitUntil: 'networkidle2' });
  await admin.waitForSelector('.bk-drop', { timeout: 20000 });
  ok(/Drop the book’s PDF here/.test(await text(admin, '.bk-drop')), 'an empty book asks for the PDF');
  await admin.screenshot({ path: join(OUT, 'admin-1-empty.png') });
  const input = await admin.$('#sc-book input[type="file"]');
  await input.uploadFile(PDF);
  await admin.waitForSelector('.bk-work', { timeout: 10000 });
  await admin.waitForFunction(() => document.querySelectorAll('.bk-work-grid img').length >= 3, { timeout: 60000 }).catch(() => {});
  await admin.screenshot({ path: join(OUT, 'admin-2-working.png') });
  ok(/of 12|Preparing|Opening/.test(await text(admin, '.bk-work-title')), `progress shows (${await text(admin, '.bk-work-title')})`);
  await admin.waitForFunction(() => !document.querySelector('.bk-work') && document.querySelector('.bk-have'), { timeout: 180000 });
  await sleep(400);
  await admin.screenshot({ path: join(OUT, 'admin-3-ready.png'), fullPage: false });
  ok(state.uploads === BOOK_PAGES, `every page went up to Cloudflare Images (${state.uploads})`);
  const [v1] = versions();
  const pdfKey = [...FILES.objects.keys()].find((k) => k.startsWith(`books/${v1}/`) && k.endsWith('.pdf'));
  ok(pdfKey === `books/${v1}/Our-15-Years-final.pdf`, `the PDF is kept under its own name (${pdfKey})`);
  ok(pdfKey && Buffer.compare(Buffer.from(FILES.objects.get(pdfKey).bytes), PDF_BYTES) === 0, 'the stored PDF is byte for byte the file');
  const text1 = JSON.parse(new TextDecoder().decode(FILES.objects.get(`books/${v1}/text.json`)?.bytes || new Uint8Array()) || 'null');
  ok(text1?.pages?.length === BOOK_PAGES && text1.pages.some((runs) => runs.some((r) => /zephyr/i.test(r[0]))), 'the words file has every page, with places');
  const manifest = JSON.parse(new TextDecoder().decode(FILES.objects.get(`books/${v1}/manifest.json`)?.bytes || new Uint8Array()) || 'null');
  ok(manifest?.images?.length === BOOK_PAGES && manifest.images.every((id) => id.startsWith(`book/${v1}/p`)), 'the manifest lists its pictures');
  ok(/12 pages/.test(await text(admin, '.bk-have-meta')), `the summary says 12 pages (${await text(admin, '.bk-have-meta')})`);
  ok(/1 two-page spread was cut/.test(await text(admin, '.bk-have-text')), 'the spread was cut in two, and it says so');
  const chapters = await admin.$$eval('.bk-ch-row input', (els) => els.map((e) => e.value));
  ok(chapters.join('|') === 'The First Rooms|Going Live', `chapters come from the bookmarks (${chapters.join(', ')})`);
  ok(/Unsaved/.test(await text(admin, '.sc-bar-state')), 'it waits for Save');
  ok(admin.errors.length === 0, `no admin errors ${admin.errors.join(' | ')}`);
});

await section('Admin: the address, words, Save', async () => {
  const slug = await admin.$('#bk-slug');
  await slug.click({ clickCount: 3 });
  await slug.type('donate');
  await sleep(900);
  ok(/Another page already uses that address/.test(await text(admin, '#sc-book-page')), 'an address another page has is refused');
  ok(await admin.$eval('.sc-bar-actions .btn-primary', (b) => b.disabled), 'and Save waits for it');
  await slug.click({ clickCount: 3 });
  await slug.type('Our Café Book!');
  ok((await admin.$eval('#bk-slug', (e) => e.value)) === 'our-cafe-book-', `while typing, a dash waits for the next word (${await admin.$eval('#bk-slug', (e) => e.value)})`);
  ok(!/sc-bad/.test(await admin.$eval('#sc-book-page', (e) => e.innerHTML)), 'and no complaint about it mid-word');
  await admin.$eval('#bk-slug', (e) => e.blur());
  await sleep(200);
  ok((await admin.$eval('#bk-slug', (e) => e.value)) === 'our-cafe-book', `the address is kept to letters, numbers and dashes, accents plain (${await admin.$eval('#bk-slug', (e) => e.value)})`);
  await slug.click({ clickCount: 3 });
  await slug.type('book 🎉 15');
  await admin.$eval('#bk-slug', (e) => e.blur());
  await sleep(200);
  ok((await admin.$eval('#bk-slug', (e) => e.value)) === 'book-15', `an emoji becomes one dash (${await admin.$eval('#bk-slug', (e) => e.value)})`);
  await slug.click({ clickCount: 3 });
  await slug.type('index');
  await sleep(200);
  ok(/Another page already uses that address/.test(await text(admin, '#sc-book-page')), 'the home page’s own name is refused');
  await slug.click({ clickCount: 3 });
  await slug.type('our-cafe-book');
  await admin.$eval('#bk-slug', (e) => e.blur());
  ok(!(await clickText(admin, '.sc-bar-actions a', /^View page/)), 'no View page while the book isn’t on the site');
  const guarded = await admin.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'other.pdf', { type: 'application/pdf' }));
    const ev = new DragEvent('dragover', { dataTransfer: dt, cancelable: true, bubbles: true });
    document.querySelector('.sc-rail').dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  ok(guarded, 'a PDF dragged over the rest of the screen won’t open in the tab');
  await slug.click({ clickCount: 3 });
  await slug.type('15-years');
  await clickText(admin, '#sc-book-page .sc-seg button', /^On the site$/);
  await saveNow(admin);
  const doc = await stored();
  ok(doc?.show === true && doc.slug === '15-years' && doc.pages?.length === BOOK_PAGES && doc.pdf?.url?.endsWith('.pdf') && doc.textUrl, 'Save writes the book (on the site, its pages, PDF and words file)');
  ok(doc?.pages?.[4]?.text?.includes('zephyr blue walls'), `each page's text is saved (${doc?.pages?.[4]?.text?.slice(0, 40)})`);
  ok(doc?.pages?.[0]?.text?.startsWith('2012 · 2027'), `letter-spaced type reads as words (${doc?.pages?.[0]?.text?.slice(0, 20)})`);
  const links = (doc?.pages || []).flatMap((p, i) => (p.links || []).map((l) => `${i}:${l.page ?? l.url}`));
  ok(links.includes('2:3') && links.includes('2:7') && links.some((l) => /donate/.test(l)), `links: the contents page's, and the web one (${links.join(', ')})`);
  ok(/^Saved|after you publish|saved and live/i.test(await text(admin, '.sc-bar-state')), `then it's saved (${await text(admin, '.sc-bar-state')})`);
});

await section('Admin: the Preview is the real reader', async () => {
  await admin.$eval('#sc-book-preview', (e) => e.scrollIntoView());
  const frameEl = await admin.waitForSelector('#sc-book-preview iframe');
  const frame = await frameEl.contentFrame();
  await frame.waitForSelector('.fb.is-ready', { timeout: 20000 });
  await sleep(800);
  const label = () => frame.$eval('[data-fb="label"]', (e) => e.textContent.trim());
  ok((await label()).startsWith('1'), `the preview opens on the cover (${await label()})`);
  await admin.screenshot({ path: join(OUT, 'admin-4a-preview-cover.png') });
  await frame.$eval('.fb-arrow--next', (b) => b.click());
  await sleep(1400);
  ok((await label()).startsWith('2'), `it turns (${await label()})`);
  await admin.screenshot({ path: join(OUT, 'admin-4-preview.png') });
  // Renaming a chapter: the preview takes it and stays on its page
  const first = await admin.$('.bk-ch-row input');
  await first.click();
  await first.evaluate((el) => el.select());
  await first.type('The Very First Rooms');
  await sleep(1500);
  const frame2 = await (await admin.$('#sc-book-preview iframe')).contentFrame();
  await frame2.waitForSelector('.fb.is-ready', { timeout: 10000 });
  ok((await frame2.$eval('[data-fb="label"]', (e) => e.textContent.trim())).startsWith('2'), 'after an edit the preview stays on its page');
  ok(admin.errors.length === 0, `no admin errors ${admin.errors.join(' | ')}`);
  await saveNow(admin);
});

await section('Admin: replacing the PDF clears away only what nothing uses', async () => {
  const [v1] = versions();
  await upload(admin);
  const v2 = (await admin.evaluate(() => null), versions().find((v) => v !== v1));
  ok(versions().length === 2, `a second upload keeps the saved one (${versions().join(', ')})`);
  const kept = await admin.$$eval('.bk-ch-row input', (els) => els.map((e) => e.value));
  ok(kept[0] === 'The Very First Rooms', `chapter names someone wrote stay with a new PDF (${kept.join(', ')})`);
  ok(/has 2 bookmarks/.test(await text(admin, '#sc-book-chapters')), 'and the new bookmarks are offered');
  ok(state.deletes.length === 0, 'nothing deleted while the first is still saved');
  await saveNow(admin);
  ok((await stored())?.version === v2, 'the second is saved');
  // A third upload, not saved, made two days ago (as if left on screen); and two other uploads nobody saved:
  // one from two days ago (nothing needs it), one from an hour ago (another tab, part way through)
  await upload(admin);
  const v3 = versions().find((v) => v !== v1 && v !== v2);
  const age = (v, ms) => { for (const [k, o] of FILES.objects) if (k.startsWith(`books/${v}/`)) o.uploaded = new Date(Date.now() - ms); };
  for (const [v, ms] of [['oldjunk01', 2 * 864e5], ['othertab01', 36e5]]) {
    await FILES.put(`books/${v}/manifest.json`, JSON.stringify({ images: [`book/${v}/p001`] }));
    await FILES.put(`books/${v}/x.pdf`, '%PDF-');
    images.set(`book/${v}/p001`, Buffer.from('jpeg'));
    age(v, ms);
  }
  for (const v of [v1, v2, v3]) age(v, 2 * 864e5);
  state.deletes = [];
  await upload(admin);
  await sleep(1500);
  const left = versions();
  ok(!left.includes('oldjunk01'), `an old upload nothing uses is cleared (${left.join(', ')})`);
  ok(state.deletes.length === 1 && state.deletes[0] === 'book/oldjunk01/p001', `and only its pictures were deleted (${state.deletes.join(', ')})`);
  ok(left.includes(v3), 'the book that was on screen, not saved yet, is kept');
  ok(left.includes(v2) && left.includes(v1), 'so are the saved one and the one History can put back');
  ok(left.includes('othertab01'), 'and one from the last hour (another tab may be making it)');
  ok([...images.keys()].filter((id) => id.startsWith(`book/${v2}/`)).length === BOOK_PAGES, 'the saved one’s pictures are all still there');
  // Leave the saved book as it was
  await clickText(admin, '.sc-bar-actions button', /^Discard$/);
  await sleep(300);
});

await section('Admin: a dropped connection carries on where it stopped', async () => {
  const before = { uploads: state.uploads, starts: state.calls.filter((c) => /book-admin/.test(c)).length };
  state.failOnce = 'p005';
  const input = await admin.$('#sc-book input[type="file"]');
  await input.uploadFile(PDF);
  await admin.waitForFunction(() => /didn’t finish/.test(document.querySelector('#sc-book')?.textContent || ''), { timeout: 120000 });
  const note = await text(admin, '#sc-book .sc-note');
  ok(/The connection dropped/.test(note) && /carries on from page/.test(note), `a failed upload says what happened and that Try again carries on (${note.slice(0, 120)})`);
  const firstTry = state.uploads - before.uploads;
  await clickText(admin, '#sc-book .sc-note button', /^Try again$/);
  await admin.waitForFunction(() => !document.querySelector('.bk-work') && /12 pages/.test(document.querySelector('.bk-have-meta')?.textContent || '') && !/didn’t finish/.test(document.querySelector('#sc-book')?.textContent || ''), { timeout: 120000 });
  const secondTry = state.uploads - before.uploads - firstTry;
  ok(firstTry + secondTry === BOOK_PAGES && secondTry < BOOK_PAGES, `no page went up twice (${firstTry} then ${secondTry})`);
  await clickText(admin, '.sc-bar-actions button', /^Discard$/);
  await sleep(300);
});

await section('Admin: a phone', async () => {
  const phone = await newPage({ width: 390, height: 844, mobile: true });
  await answerAsks(phone);
  await phone.goto(`${SITE}/admin/index.html#site/book`, { waitUntil: 'networkidle2' });
  await phone.waitForSelector('.bk-have', { timeout: 20000 });
  await sleep(500);
  const wide = await phone.evaluate(() => [...document.querySelectorAll('.sc-page *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1 && !el.closest('.bk-strip, iframe')).map((el) => el.className || el.tagName).slice(0, 5));
  ok(!wide.length, `nothing runs off a phone screen (${wide.join(', ')})`);
  await phone.screenshot({ path: join(OUT, 'admin-5-phone.png') });
  await phone.close();
});

// ── 3. The site, built with what was saved ─────────────────────────
console.log('Building the site with the saved book…');
const saved = await stored();
writeFileSync(join(TMP, 'book.json'), JSON.stringify(saved));
const DIST_B = join(TMP, 'dist-b');
build(DIST_B, { BOOK_FIXTURE: join(TMP, 'book.json') });
staticRoots = [DIST_B];

const BOOK_URL = `${SITE}/15-years/`;
const label = (p) => p.$eval('[data-fb="label"]', (e) => e.textContent.trim());
const toReader = async (p) => { await p.evaluate(() => document.getElementById('read').scrollIntoView({ block: 'start' })); await sleep(1800); };

await section('The page: hero, cover, turning', async () => {
  ok(existsSync(join(DIST_B, '15-years/index.html')) && !existsSync(join(DIST_A, '15-years/index.html')), 'the page is built only once the book is on the site');
  ok(JSON.parse(readFileSync(join(DIST_B, 'book-version.json'), 'utf8')).version === saved.version, 'book-version.json names the live upload');
  const html = readFileSync(join(DIST_B, '15-years/index.html'), 'utf8');
  ok(html.includes('"@type":"Book"') && html.includes('zephyr blue walls'), 'the page carries Book data and the book’s words');
  const p = await newPage();
  await p.goto(BOOK_URL, { waitUntil: 'networkidle0' });
  ok(/Fifteen|15 Years/.test(await text(p, 'h1')), `the hero (${await text(p, 'h1')})`);
  await p.screenshot({ path: join(OUT, 'site-1-hero.png') });
  await p.keyboard.press('ArrowRight');
  await sleep(900);
  ok((await label(p)).startsWith('1') && !(await p.evaluate(() => location.search)), 'arrow keys leave the book alone while it’s scrolled away');
  await p.click('.hero-ctas [data-open-book]');
  await sleep(2200);
  ok((await label(p)).startsWith('2'), `"Open the book" scrolls down and opens the cover (${await label(p)})`);
  ok(!(await p.$eval('.fb', (e) => e.classList.contains('is-flat'))), 'the WebGL curl is on');
  await p.screenshot({ path: join(OUT, 'site-2-open.png') });
  // A dragged corner
  const r = await p.$eval('.fb-page--right', (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  await p.mouse.move(r.x + r.w - 5, r.y + r.h - 5);
  await p.mouse.down();
  await p.mouse.move(r.x + r.w * 0.3, r.y + r.h - 80, { steps: 8 });
  await p.screenshot({ path: join(OUT, 'site-3-drag.png') });
  await p.mouse.move(r.x - r.w * 0.6, r.y + r.h - 40, { steps: 8 });
  await p.mouse.up();
  await sleep(900);
  ok((await label(p)).startsWith('4'), `a dragged corner turns the page (${await label(p)})`);
  ok(/[?&]page=4\b/.test(await p.evaluate(() => location.search)), 'the address follows the page');
  for (let i = 0; i < 3; i++) { await p.keyboard.press('ArrowRight'); await sleep(60); }
  await sleep(2400);
  ok((await label(p)).startsWith('10'), `three quick presses, three spreads (${await label(p)})`);
  await p.keyboard.press('End');
  await sleep(1500);
  ok((await label(p)).startsWith('12'), `End: the back cover (${await label(p)})`);
  // The left page curls back from its own corner
  const lr = await p.$eval('.fb-page--left', (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  await p.mouse.move(lr.x + 5, lr.y + lr.h - 5);
  await p.mouse.down();
  await p.mouse.move(lr.x + lr.w * 0.25, lr.y + lr.h - 60, { steps: 6 });
  await p.screenshot({ path: join(OUT, 'site-3b-left-corner.png') });
  await p.mouse.move(lr.x + lr.w * 1.7, lr.y + lr.h - 30, { steps: 8 });
  await p.mouse.up();
  await sleep(1000);
  ok((await label(p)).startsWith('10'), `dragging the left page's corner turns back (${await label(p)})`);
  // A window resized mid-drag: the drag ends, nothing breaks
  const rr = await p.$eval('.fb-page--right', (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  await p.mouse.move(rr.x + rr.w - 5, rr.y + rr.h - 5);
  await p.mouse.down();
  await p.mouse.move(rr.x + rr.w * 0.5, rr.y + rr.h - 40, { steps: 5 });
  await p.setViewport({ width: 1000, height: 700 });
  await sleep(400);
  await p.mouse.move(rr.x + rr.w * 0.2, rr.y + rr.h - 40, { steps: 5 });
  await p.mouse.up();
  await sleep(800);
  await p.setViewport({ width: 1440, height: 1000 });
  await sleep(600);
  ok(p.errors.length === 0, `resizing mid-drag throws nothing ${p.errors.join(' | ')}`);
  await p.keyboard.press('Home');
  await sleep(1500);
  await p.keyboard.press('ArrowRight');
  await sleep(1300);
  const links = await p.$$eval('.fb-link', (els) => els.map((a) => a.getAttribute('aria-label')));
  ok(links.length === 2, `the contents page's links (${links.join(', ')})`);
  await p.click('.fb-link:nth-child(2)');
  await sleep(1500);
  ok((await label(p)).includes('8'), `a contents link turns to its chapter (${await label(p)})`);
  ok(p.errors.length === 0, `no page errors ${p.errors.join(' | ')}`);
  await p.close();
});

await section('The page: search, zoom, full screen, the address', async () => {
  const p = await newPage();
  await p.goto(BOOK_URL, { waitUntil: 'networkidle0' });
  await toReader(p);
  await p.click('[data-fb="panel"]');
  await sleep(400);
  ok(await p.$eval('.fb-panel', (d) => d.open), 'the panel opens');
  await p.type('.fb-search', 'zephyr');
  await sleep(500);
  ok((await p.$$('.fb-result')).length === 1, 'search finds the page');
  await p.$eval('.fb-search', (el) => { el.value = 'ephyr'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(400);
  ok((await p.$$('.fb-result')).length === 0, 'search matches words from their start (not "ephyr" in zephyr)');
  await p.$eval('.fb-search', (el) => { el.value = 'zephyr'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(400);
  await p.screenshot({ path: join(OUT, 'site-4-search.png') });
  await p.keyboard.press('Enter');
  await sleep(1800);
  ok((await label(p)).includes('5') && (await p.$$('.fb-mark')).length > 0, `Enter goes to it and marks the word (${await label(p)})`);
  await p.screenshot({ path: join(OUT, 'site-5-found.png') });
  await p.click('[data-fb="zoom-in"]');
  await sleep(500);
  ok(await p.$eval('.fb', (e) => e.classList.contains('is-zoomed')), 'zoom in');
  await p.keyboard.press('Escape');
  await sleep(500);
  ok(!(await p.$eval('.fb', (e) => e.classList.contains('is-zoomed'))), 'Escape zooms out');
  await p.click('[data-fb="full"]');
  await sleep(600);
  ok(await p.$eval('.fb', (e) => e.classList.contains('is-full')) && (await p.$eval('[data-fb="full"]', (b) => b.getAttribute('aria-label'))) === 'Exit full screen', 'full screen, and the button says how to leave');
  await p.screenshot({ path: join(OUT, 'site-6-full.png') });
  await p.click('[data-fb="close"]');
  await sleep(400);
  await p.goto(`${BOOK_URL}?page=9`, { waitUntil: 'networkidle0' });
  await toReader(p);
  ok((await label(p)).includes('9'), `?page=9 opens there (${await label(p)})`);
  await p.goto(`${BOOK_URL}?page=999`, { waitUntil: 'networkidle0' });
  await sleep(400);
  ok(!/page=/.test(await p.evaluate(() => location.search)), 'a page that isn’t there leaves no ?page= in the address');
  ok(p.errors.length === 0, `no page errors ${p.errors.join(' | ')}`);
  await p.close();
});

await section('The page: share, go to a page, print, play, sound, text, pick up where you left off', async () => {
  await browser.defaultBrowserContext().overridePermissions(SITE, ['clipboard-read', 'clipboard-write']);
  const p = await newPage();
  await p.goto(BOOK_URL, { waitUntil: 'networkidle0' });
  await toReader(p);
  // Share
  await p.click('[data-fb="share"]');
  await sleep(200);
  const items = await p.$$eval('.fb-menu:not([hidden]) [role="menuitem"]', (els) => els.map((e) => e.textContent.trim()));
  ok(items.join('|') === 'Copy the link|Email|Facebook|X|LinkedIn', `Share has its five ways (${items.join(', ')})`);
  ok(await p.evaluate(() => document.activeElement?.dataset.share === 'copy'), 'the menu takes focus on its first item');
  await p.keyboard.press('ArrowDown');
  ok(await p.evaluate(() => document.activeElement?.dataset.share === 'email'), 'arrow keys move through it');
  await p.keyboard.press('Escape');
  ok(await p.$eval('[data-fb="share"]', (b) => b.getAttribute('aria-expanded') === 'false' && document.activeElement === b), 'Escape closes it, back on the button');
  await p.click('[data-fb="share"]');
  await p.click('[data-share="copy"]');
  await sleep(300);
  // Copied (or, where the clipboard is off, as in a headless browser, shown to copy by hand)
  const toastNow = await text(p, '.fb-toast');
  const clip = await p.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  ok((/copied/.test(toastNow) && /\/15-years\/$/.test(clip)) || /\/15-years\/$/.test(toastNow), `Copy the link gives the page’s address (${toastNow})`);
  // Go to a page
  await p.click('[data-fb="label"]');
  await sleep(100);
  ok(await p.evaluate(() => document.activeElement?.classList.contains('fb-goto-input')), 'the page number opens as a box to type in');
  await p.keyboard.type('99');
  await p.keyboard.press('Enter');
  await sleep(300);
  ok(/from 1 to 12/.test(await text(p, '.fb-toast')), 'a page that isn’t there says which are');
  await p.$eval('.fb-goto-input', (el) => { el.value = ''; });
  await p.keyboard.type('3x');
  await p.keyboard.press('Enter');
  await sleep(300);
  ok(/Type a page number/.test(await text(p, '.fb-toast')) && await p.evaluate(() => !document.querySelector('.fb-goto').hidden), 'letters get the same friendly answer, not the browser’s');
  await p.$eval('.fb-goto-input', (el) => { el.value = ''; });
  await p.keyboard.type('7');
  await p.keyboard.press('Enter');
  await sleep(1500);
  ok((await label(p)).includes('7'), `typing 7 goes to page 7 (${await label(p)})`);
  // Print these pages
  await p.evaluate(() => { window.print = () => { window.__printed = [...document.querySelectorAll('.fb-print img')].map((im) => im.alt); window.dispatchEvent(new Event('afterprint')); }; });
  await p.click('[data-fb="print"]');
  await p.click('[data-print="pages"]');
  await sleep(1500);
  ok((await p.evaluate(() => window.__printed || [])).join() === 'Page 6,Page 7' && !(await p.$('.fb-print')), 'Print: these pages print, and nothing is left behind');
  // Play
  await p.click('[data-fb="play"]');
  await sleep(6500);
  const played = await label(p);
  ok((await p.$eval('.fb', (e) => e.classList.contains('is-playing'))) && !played.includes('6–7'), `Play turns the pages by itself (${played})`);
  const r = await p.$eval('.fb-page--right', (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  await p.mouse.move(r.x + r.w / 2, r.y + 30);
  await p.mouse.down();
  await p.mouse.up();
  await sleep(200);
  ok(!(await p.$eval('.fb', (e) => e.classList.contains('is-playing'))), 'touching the book stops Play');
  await sleep(1200);
  // Sound, remembered
  await p.click('[data-fb="sound"]');
  ok((await p.$eval('.fb', (e) => e.classList.contains('is-sound'))) && (await p.evaluate(() => localStorage.getItem('fb-sound'))) === '1', 'the sound switch turns on, and is remembered');
  await p.click('[data-fb="sound"]');
  // Text
  await p.click('[data-fb="panel"]');
  await sleep(300);
  await p.click('.fb-tabs [data-tab="text"]');
  await sleep(200);
  ok(/page \d+/i.test(await text(p, '.fb-read')) && (await text(p, '.fb-read')).length > 20, `the Text tab shows the pages’ words (${(await text(p, '.fb-read')).slice(0, 60)})`);
  await p.keyboard.press('Escape');
  await sleep(400);
  const at = (await label(p)).split(/[–\s]/)[0];
  await p.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await sleep(500);
  // Pick up where you left off
  await p.goto(BOOK_URL, { waitUntil: 'networkidle0' });
  await toReader(p);
  ok(!(await p.$eval('.fb-resume', (e) => e.hidden)) && (await text(p, '.fb-resume-go')) === `Page ${at}`, `coming back offers the page left on (${await text(p, '.fb-resume-go')})`);
  await p.click('.fb-resume-go');
  await sleep(1500);
  ok((await label(p)).includes(at), `and goes there (${await label(p)})`);
  ok(p.errors.length === 0, `no page errors ${p.errors.join(' | ')}`);
  // Leaving sends what was read (sent while the page is still here: this harness's request interception
  // drops beacons sent mid-navigation, which a real browser delivers)
  await p.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await sleep(800);
  await p.close();
  const counted = await readStatsNow();
  ok(counted.totals.visits >= 1 && counted.totals.readers >= 1 && counted.totals.share >= 1 && counted.totals.print >= 1 && counted.totals.play >= 1 && counted.totals.time > 0, `reading is counted (${JSON.stringify(counted.totals)})`);
  ok(Object.keys(counted.pages.views).length >= 3 && Object.values(counted.pages.reach).some((v) => v > 0), 'page by page, and how far');
});

await section('Admin: Readers shows what was counted', async () => {
  const a = await newPage();
  await answerAsks(a);
  await a.goto(`${SITE}/admin/index.html#site/book`, { waitUntil: 'networkidle2' });
  await a.waitForSelector('.bk-kpis', { timeout: 20000 });
  await a.$eval('#sc-book-readers', (e) => e.scrollIntoView());
  await sleep(400);
  const kpis = await a.$$eval('.bk-kpi', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ')));
  ok(/Visits \d/.test(kpis[0]) && kpis.length === 6, `the headline numbers (${kpis.join(' / ')})`);
  ok((await a.$$('.bk-cols')).length === 3, 'visits each day, how far people read, time on each page');
  const bars = await a.$$('.bk-cols-bars');
  const b = await bars[1].boundingBox();
  await a.mouse.move(b.x + b.width * 0.1, b.y + b.height / 2);
  await sleep(200);
  ok(/got this far/.test(await text(a, '.bk-tip')), `hovering a column says what it is (${await text(a, '.bk-tip')})`);
  await bars[1].focus();
  await a.keyboard.press('Home');
  await sleep(100);
  ok(/Page 1:/.test(await text(a, '.bk-tip')), 'and so do the arrow keys');
  await a.screenshot({ path: join(OUT, 'admin-6-readers.png') });
  ok(a.errors.length === 0, `no admin errors ${a.errors.join(' | ')}`);
  await a.close();
});

await section('Counting is honest; shared links and returns land on the book', async () => {
  const flushOut = async (q) => { await q.evaluate(() => window.dispatchEvent(new Event('pagehide'))); await sleep(600); };
  // A shared link to the last page: the book is on screen, and nobody "read to the end"
  let before = await readStatsNow();
  const a = await newPage({ width: 1280, height: 800 });
  await a.goto(`${BOOK_URL}?page=12`, { waitUntil: 'networkidle0' });
  await sleep(1200);
  const top = await a.$eval('.fb-stage', (e) => Math.round(e.getBoundingClientRect().top));
  ok(top > 0 && top < 200, `a shared page’s link opens with the book on screen (stage at ${top}px)`);
  await flushOut(a);
  await a.close();
  let after = await readStatsNow();
  ok(after.totals.visits === before.totals.visits + 1 && after.totals.end === before.totals.end && after.totals.started === before.totals.started,
    `landing on the last page isn’t reading to the end (end ${before.totals.end}→${after.totals.end}, began at the cover ${before.totals.started}→${after.totals.started})`);
  // Play turning the pages isn't reading; zooming in stops it
  before = after;
  const b = await newPage({ width: 1440, height: 900 });
  await b.goto(BOOK_URL, { waitUntil: 'networkidle0' });
  await toReader(b);
  await b.click('[data-fb="play"]');
  await sleep(6200);
  ok((await label(b)).startsWith('4') || (await label(b)).startsWith('2'), `Play turned the pages (${await label(b)})`);
  await b.keyboard.press('=');
  await sleep(300);
  ok(!(await b.$eval('.fb', (e) => e.classList.contains('is-playing'))), 'zooming in stops Play');
  await flushOut(b);
  await b.close();
  after = await readStatsNow();
  const viewsNow = Object.entries(after.pages.views).filter(([k, v]) => v > (before.pages.views[k] || 0)).map(([k]) => k);
  ok(after.totals.play === before.totals.play + 1 && after.totals.readers === before.totals.readers && viewsNow.join() === '0',
    `Play counts as a play, not as reading (pages counted: ${viewsNow.join(', ')}; readers ${before.totals.readers}→${after.totals.readers})`);
  // Back for more: the hero offers the page, and the book opens there
  const c = await newPage({ width: 1440, height: 900 });
  await c.evaluateOnNewDocument((v) => localStorage.setItem('fb-last:/15-years/', JSON.stringify({ v, page: 8, t: Date.now() })), (await stored()).version);
  await c.goto(BOOK_URL, { waitUntil: 'networkidle0' });
  await sleep(300);
  const cta = await text(c, '.btn[data-open-book]');
  ok(/Pick up at page 9/.test(cta), `the hero offers the page left on (${cta})`);
  await c.click('.btn[data-open-book]');
  await sleep(2600);
  ok((await label(c)).includes('9'), `and opens the book there (${await label(c)})`);
  ok(await c.evaluate(() => document.activeElement?.classList.contains('fb-stage')), 'with the keys on the book');
  ok(c.errors.length === 0, `no page errors ${c.errors.join(' | ')}`);
  await c.close();
});

await section('Short screens and a phone turned on its side', async () => {
  for (const [w, h] of [[667, 375], [568, 320], [844, 390], [600, 800], [700, 600]]) {
    const p = await newPage({ width: w, height: h, mobile: true });
    await p.goto(BOOK_URL, { waitUntil: 'networkidle0' });
    await toReader(p);
    const r = await p.evaluate(() => {
      const hd = document.querySelector('.site-header');
      const pos = getComputedStyle(hd).position;
      return { stage: document.querySelector('.fb-stage').getBoundingClientRect().height, top: document.querySelector('.fb-stage').getBoundingClientRect().top,
        header: pos === 'sticky' || pos === 'fixed' ? hd.getBoundingClientRect().bottom : 0, end: document.querySelector('.fb-controls').getBoundingClientRect().bottom };
    });
    ok(r.end <= h + 1 && r.stage >= 140 && r.top >= r.header - 1, `${w}×${h}: the book and its controls fit on the screen, clear of the header (book ${Math.round(r.top)}–${Math.round(r.top + r.stage)}, header to ${Math.round(r.header)}, controls end at ${Math.round(r.end)})`);
    await p.close();
  }
  const p = await newPage({ width: 390, height: 844, mobile: true });
  await p.goto(BOOK_URL, { waitUntil: 'networkidle0' });
  await toReader(p);
  for (const [w, h] of [[844, 390], [390, 844]]) {
    await p.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await sleep(900);
    const r = await p.evaluate(() => ({ top: document.querySelector('.fb-stage').getBoundingClientRect().top, end: document.querySelector('.fb-controls').getBoundingClientRect().bottom }));
    ok(r.top >= 0 && r.end <= h + 1, `turned to ${w}×${h}, the book is still on screen (top ${Math.round(r.top)}, controls end ${Math.round(r.end)})`);
  }
  ok(p.errors.length === 0, `no page errors ${p.errors.join(' | ')}`);
  await p.close();
});

await section('The page on a phone', async () => {
  const p = await newPage({ width: 390, height: 844, mobile: true });
  await p.goto(BOOK_URL, { waitUntil: 'networkidle0' });
  await toReader(p);
  ok(!(await p.$eval('.fb', (e) => e.classList.contains('is-two'))), 'one page at a time');
  const r = await p.$eval('.fb-page--right', (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  await p.touchscreen.tap(r.x + r.w * 0.8, r.y + r.h / 2);
  await sleep(1100);
  ok((await label(p)).startsWith('2'), `tap turns (${await label(p)})`);
  const cdp = await p.createCDPSession();
  const y = r.y + r.h * 0.6;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x + r.w * 0.85, y }] });
  for (let i = 1; i <= 8; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: r.x + r.w * (0.85 - i * 0.06), y }] }); await sleep(16); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(1000);
  ok((await label(p)).startsWith('3'), `a swipe turns (${await label(p)})`);
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx - 30, y: cy, id: 1 }, { x: cx + 30, y: cy, id: 2 }] });
  for (let i = 1; i <= 8; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - 30 - i * 10, y: cy, id: 1 }, { x: cx + 30 + i * 10, y: cy, id: 2 }] }); await sleep(16); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(400);
  ok(await p.$eval('.fb', (e) => e.classList.contains('is-zoomed')), 'pinch zooms');
  const over = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  ok(!over, 'nothing runs off the side');
  await p.screenshot({ path: join(OUT, 'site-7-phone.png') });
  // More holds what the bar leaves out; full screen from there, and back to the same place on the page
  await p.evaluate(() => window.scrollTo(0, document.getElementById('read').getBoundingClientRect().top + scrollY - 40));
  await sleep(300);
  const at = await p.$eval('.fb', (e) => Math.round(e.getBoundingClientRect().top));
  await (await p.$('[data-fb="more"]')).tap();
  await sleep(300);
  const shown = await p.$$eval('.fb-more [role^="menuitem"]', (els) => els.filter((e) => e.getClientRects().length).map((e) => e.textContent.trim()));
  ok(['Play', 'Print these pages', 'Page-turn sound', 'Download the PDF', 'Full screen'].every((t) => shown.some((s) => s.startsWith(t))), `More has what the phone's bar leaves out (${shown.join(', ')})`);
  await p.screenshot({ path: join(OUT, 'site-8-phone-more.png') });
  await (await p.$('[data-more="full"]')).tap();
  await sleep(500);
  ok(await p.$eval('.fb', (e) => e.classList.contains('is-full')), 'full screen from More');
  await (await p.$('[data-fb="more"]')).tap();
  await sleep(300);
  await (await p.$('[data-more="full"]')).tap();
  await sleep(600);
  const back = await p.$eval('.fb', (e) => Math.round(e.getBoundingClientRect().top));
  ok(Math.abs(back - at) <= 1, `after full screen the book is where it was (${at} → ${back})`);
  ok(p.errors.length === 0, `no page errors ${p.errors.join(' | ')}`);
  await p.close();
});

await section('The bar at every width', async () => {
  // The page number stays in the middle, nothing runs over, and More has exactly what the bar leaves out
  const p = await newPage();
  for (const [w, mobile, inBar, inMore] of [
    [1440, false, ['zoom-in', 'play', 'share', 'print', 'sound', 'download', 'full'], []],
    [1024, true, ['share', 'download', 'more', 'full'], ['Play', 'Print these pages', 'Page-turn sound']],
    [744, true, ['share', 'more'], ['Play', 'Print these pages', 'Page-turn sound', 'Download the PDF', 'Full screen']],
    [360, true, ['share', 'more'], ['Play', 'Print these pages', 'Page-turn sound', 'Download the PDF', 'Full screen']],
    [320, true, ['more'], ['Share this page', 'Play', 'Print these pages', 'Page-turn sound', 'Download the PDF', 'Full screen']],
  ]) {
    await p.setViewport({ width: w, height: 800, isMobile: mobile, hasTouch: mobile });
    await p.goto(`${BOOK_URL}?page=4`, { waitUntil: 'networkidle0' });
    const got = await p.evaluate(() => {
      const bar = document.querySelector('.fb-bar').getBoundingClientRect();
      const lab = document.querySelector('.fb-label').getBoundingClientRect();
      return {
        off: Math.round(lab.left + lab.width / 2 - (bar.left + bar.width / 2)),
        // The bar's buttons inside the bar (a hidden tooltip may hang past it; the page's width catches one off screen)
        over: Math.max(0, ...[...document.querySelectorAll('.fb-bar .fb-btn, .fb-bar .fb-label')].filter((b) => b.getClientRects().length).map((b) => Math.max(bar.left - b.getBoundingClientRect().left, b.getBoundingClientRect().right - bar.right))),
        page: document.documentElement.scrollWidth - innerWidth,
        wide: [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 0.5).slice(0, 4).map((e) => `${e.tagName.toLowerCase()}.${String(e.className?.baseVal ?? e.className).split(' ')[0]} ${Math.round(e.getBoundingClientRect().right)}`),
        bar: [...document.querySelectorAll('.fb-bar-end .fb-btn')].filter((b) => b.getClientRects().length).map((b) => b.dataset.fb),
        more: [...document.querySelectorAll('.fb-more [role^="menuitem"]')].map((e) => { e.closest('.fb-menu').hidden = false; const shown = e.getClientRects().length; e.closest('.fb-menu').hidden = true; return shown ? [...e.childNodes].filter((c) => !c.classList?.contains('fb-menu-note')).map((c) => c.textContent).join('').trim() : null; }).filter(Boolean),
      };
    });
    ok(Math.abs(got.off) <= 1 && got.over <= 0 && got.page <= 0, `${w}px: the page number is centered, nothing runs over (off ${got.off}, bar over ${got.over}, page over ${got.page} ${got.wide.join(' ')})`);
    ok(inBar.every((b) => got.bar.includes(b)) && got.bar.length === inBar.length + (w === 1440 ? 1 : 0), `${w}px: the bar has ${got.bar.join(', ')}`);
    ok(JSON.stringify(got.more) === JSON.stringify(inMore), `${w}px: More has ${got.more.join(', ') || 'nothing (it isn’t there)'}`);
  }
  ok(p.errors.length === 0, `no page errors ${p.errors.join(' | ')}`);
  await p.close();
});

await section('The page with reduced motion, and without WebGL', async () => {
  const p = await newPage({ reduce: true });
  await p.goto(BOOK_URL, { waitUntil: 'networkidle0' });
  await toReader(p);
  await p.keyboard.press('ArrowRight');
  await sleep(60);
  ok(!(await p.$eval('.fb', (e) => e.classList.contains('is-turning'))) && (await label(p)).startsWith('2'), 'reduced motion: straight to the next pages');
  await p.close();
  const flat = await puppeteer.launch({ headless: 'shell', args: ['--disable-webgl', '--disable-3d-apis'] });
  const q = await newPage({}, flat);
  await q.goto(BOOK_URL, { waitUntil: 'networkidle0' });
  await toReader(q);
  await q.keyboard.press('ArrowRight');
  await sleep(500);
  ok(await q.$eval('.fb', (e) => e.classList.contains('is-flat')) && (await label(q)).startsWith('2') && q.errors.length === 0, 'no WebGL: the pages still turn, no errors');
  const fr = await q.$eval('.fb-page--right', (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  await q.mouse.move(fr.x + fr.w - 10, fr.y + fr.h / 2);
  await q.mouse.down();
  await q.mouse.move(fr.x + fr.w * 0.6, fr.y + fr.h / 2, { steps: 4 });
  const mid = await q.$eval('.fb-page--right', (e) => e.dataset.page);
  await q.mouse.move(fr.x + fr.w * 0.2, fr.y + fr.h / 2, { steps: 4 });
  await q.mouse.up();
  await sleep(600);
  ok(mid === '2' && (await label(q)).startsWith('4'), `no WebGL: a drag is a swipe (pages hold still, then turn: ${mid}, ${await label(q)})`);
  await flat.close();
});

await browser.close();
server.close();
rmSync(TMP, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} failed:\n- ${failures.join('\n- ')}` : '\nAll book checks passed.');
process.exit(failures.length ? 1 : 0);
