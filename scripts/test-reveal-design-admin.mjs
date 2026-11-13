/**
 * test-reveal-design-admin.mjs — a kid's design for their reveal, in Admin → Kids
 * ===========================================================================
 * Drives the kid editor in a real browser (admin from an Astro dev server,
 * every /api/* answered here, JobTread's CDN faked with a generated plan set)
 * at 1440 and 390:
 *   - the note on an unrevealed kid: off their page until the reveal, on the
 *     live page and stream from an hour before (the real time when confirmed)
 *   - Bring in from JobTread: every PDF page drawn; the as-built and proposed
 *     plans and the design board picked to start (by JobTread's sheet name,
 *     else the words on the page), the electrical sheet and cover left out;
 *     every before photo picked (Pick all / Pick none)
 *   - the family's address: red on the test sheets (title block and a note on
 *     the drawing). Not one red pixel survives on a picked drawing, the blue
 *     room labels do, and the title block is cut off
 *   - Add: drawings go up named -notitle with their kind, caption, size and
 *     JobTread source; before photos go in Photos → Before photos (never the
 *     gallery or Before & after), the six spread across the visit first, the
 *     first six marked as on the reveal screen; items already added show as on
 *     the profile next time
 *   - the kind picker on a plan tile; Save writes it all
 *   - Preview the stream: the real slate framed with ?design=preview (codes and all), and
 *     Preview the live page: the kid's real live page at Starting soon / Live / Replay;
 *     reading the editor's unsaved design; portrait toggle
 *   - phone: the dialog fits, nothing scrolls sideways, buttons reachable
 *   - Photos → Before photos: their dialog (no crops; room; on the reveal screen or
 *     not), First, Move to the gallery and back, a gallery photo marked a before
 *     photo, Select (remove, Undo, to the front), files dropped on the group, a
 *     pair's before from them, Save; on a phone
 * Screenshots in test-results/reveal-design-admin/. Exits non-zero on a failure
 * or a console error.
 *
 *   SITE=http://127.0.0.1:4417 node scripts/test-reveal-design-admin.mjs
 */
import puppeteer from 'puppeteer';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { answerAsks } from './lib/ask.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/reveal-design-admin/');
mkdirSync(OUT, { recursive: true });
const SITE = (process.env.SITE || 'http://127.0.0.1:4417').replace(/\/$/, '');
const failures = [];
// Cloudflare's visitor-stats beacon can't report from a local copy (CORS): not the page's error
const real = (errs) => errs.filter((e) => !/cloudflareinsights\.com/.test(e));
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SLUG = 'dylan-2026';
const JOB = '22PRvFGUC3WP';

// ── Test files ──
/** A plain PNG of one colour */
function png(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => [r, g, b][i % 3])]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}
const RED = rgb(1, 0, 0);
const BLUE = rgb(0, 0, 1);
/** A plan set: cover, existing plan, proposed plan, electrical. The address is red wherever it appears; room labels blue. */
async function planSet() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const sheet = (title, rooms, note) => {
    const p = doc.addPage([792, 612]);
    p.drawRectangle({ x: 18, y: 18, width: 756, height: 576, borderColor: rgb(0, 0, 0), borderWidth: 1.5 });
    // The title block: a rule across the sheet in the bottom fifth, the address under it
    p.drawLine({ start: { x: 18, y: 78 }, end: { x: 774, y: 78 }, thickness: 2, color: rgb(0, 0, 0) });
    p.drawText('MARCHENA RESIDENCE', { x: 40, y: 52, size: 11, font: bold, color: RED });
    p.drawText('426 MOUNTAIN VIEW LN', { x: 260, y: 52, size: 11, font, color: RED });
    p.drawText('MARIETTA, GA 30064', { x: 460, y: 52, size: 11, font, color: RED });
    p.drawText(title, { x: 40, y: 560, size: 16, font: bold, color: rgb(0, 0, 0) });
    for (const [i, r] of rooms.entries()) {
      p.drawRectangle({ x: 80 + i * 220, y: 200, width: 200, height: 260, borderColor: rgb(0, 0, 0), borderWidth: 3 });
      p.drawText(r, { x: 120 + i * 220, y: 320, size: 14, font: bold, color: BLUE });
    }
    if (note) p.drawText(note, { x: 80, y: 150, size: 10, font, color: RED });
  };
  const cover = doc.addPage([792, 612]);
  cover.drawText('DYLAN THERAPY ROOM', { x: 200, y: 400, size: 28, font: bold, color: rgb(0, 0, 0) });
  cover.drawText('426 Mountain View Ln, Marietta GA 30064', { x: 200, y: 360, size: 14, font, color: RED });
  sheet('EXISTING FLOOR PLAN', ['BEDROOM', 'BATH'], 'Site: 426 Mountain View Ln');
  sheet('PROPOSED FLOOR PLAN', ['THERAPY', 'BATH', 'HALL']);
  sheet('ELECTRICAL PLAN', ['BEDROOM']);
  return Buffer.from(await doc.save());
}

const readDir = (d) => Object.fromEntries(readdirSync(join(ROOT, 'src/content', d)).filter((f) => f.endsWith('.json'))
  .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(ROOT, 'src/content', d, f), 'utf8'))]));
const KIDS0 = readDir('kids');
for (const [slug, d] of Object.entries(KIDS0)) d.slug ||= slug;
const PARTNERS = readDir('partners');
const PIXEL = png(1, 1, [200, 200, 200]);

const cdn = (id) => `https://cdn.jobtread.com/test/${id}`;
const BEFORE_IDS = ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8'];
const LISTING = {
  success: true, kid: { slug: SLUG, name: 'Dylan' }, job: { id: JOB, name: 'Dylan Marchena (2026)' },
  address: { street: '426 Mountain View Ln', city: 'Marietta', zip: '30064', family: 'Marchena' },
  drawings: [
    { id: 'PLANSET', name: 'Dylan 2026_Plan Set_09302026.pdf', type: 'application/pdf', url: cdn('planset.pdf'), thumb: null, tags: ['Plans'], createdAt: '2026-10-19T17:00:00Z', size: 1 },
    { id: 'BOARD', name: 'Therapy room board.png', type: 'image/png', url: cdn('board.png'), thumb: cdn('board.png'), tags: ['Design'], createdAt: '2026-10-01T17:00:00Z', size: 1 },
  ],
  befores: BEFORE_IDS.map((id, i) => ({ id, name: `CompanyCam 28731${i}`, type: 'image/png', url: cdn(`${id}.png`), thumb: cdn(`${id}.png`), big: cdn(`${id}.png`), tags: ['Before'], createdAt: `2026-07-01T16:2${i}:00Z`, size: 1 })),
  sheets: [{ fileId: 'PLANSET', page: 2, name: 'EXISTING FLOOR PLAN' }, { fileId: 'PLANSET', page: 3, name: 'PROPOSED FLOOR PLAN' }],
};

/** opts: listing (instead of LISTING), kid (fields to put on Dylan's profile), uploadDelay (ms), failUploads (how many uploads fail first), cdnDelay (ms), drawings ({ id → PNG } served for imagedelivery drawings) */
function makeApi(files, opts = {}) {
  const st = { kids: structuredClone(KIDS0), saves: [], uploads: [], listings: 0, cdn: 0, ...opts };
  // Dylan's design starts empty whatever the real profile has now (his real one has JobTread drawings and before
  // photos since Nov 12, so nothing would be picked to start); opts.kid sets what a test needs
  st.kids[SLUG] = { ...st.kids[SLUG], plans: [], beforePhotos: [], beforeAfterPhotos: [], ...(opts.kid || {}) };
  const later = (ms, fn) => (ms ? setTimeout(fn, ms) : fn());
  const respond = (req) => {
    const url = new URL(req.url());
    const json = (o, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(o) });
    const p = url.pathname;
    if (url.host === 'cdn.jobtread.com') {
      st.cdn++;
      const name = p.split('/').pop();
      const body = files[name];
      const type = name.endsWith('.pdf') ? 'application/pdf' : /\.hei[cf]$/i.test(name) ? 'image/heic' : name.endsWith('.jpg') ? 'image/jpeg' : 'image/png';
      return later(st.cdnDelay, () => req.respond({ status: body ? 200 : 404, contentType: type, headers: { 'Access-Control-Allow-Origin': '*' }, body: body || 'missing' }));
    }
    // A drawing already on a profile, as Cloudflare serves it full size (for the Cover tool)
    if (/\/cdn-cgi\/imagedelivery\//.test(p) && /w=2400/.test(p)) {
      const id = Object.keys(st.drawings || {}).find((k) => p.includes(k));
      if (id) return req.respond({ status: 200, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: st.drawings[id] });
    }
    if (url.origin !== SITE || !p.startsWith('/api/')) return false;
    const body = () => { try { return JSON.parse(req.postData() || '{}'); } catch { return {}; } };
    if (p === '/api/list-content') {
      const dir = url.searchParams.get('dir');
      const src = dir === 'src/content/kids' ? st.kids : dir === 'src/content/partners' ? PARTNERS : {};
      const items = Object.entries(src).map(([slug, c]) => ({ name: `${slug}.json`, path: `${dir}/${slug}.json`, sha: slug, content: c }));
      return json({ success: true, items, count: items.length, total: items.length, pages: 1 });
    }
    if (p === '/api/read-content') {
      const m = url.searchParams.get('path').match(/^src\/content\/kids\/(.+)\.json$/);
      return later(st.readDelay, () => {
        const c = m && st.kids[m[1]];
        return c ? json({ success: true, content: c, sha: st.shaOf?.[m[1]] || `sha-${m[1]}-${st.saves.length}` }) : json({ success: false, error: 'Not found' }, 404);
      });
    }
    if (p === '/api/save-content' && st.saveDelay && !req.__late) {
      // (a slow save: answered as the server is when it lands)
      req.__late = true;
      return later(st.saveDelay, () => respond(req));
    }
    if (p === '/api/save-content') {
      const b = body();
      const slug = b.path.match(/kids\/(.+)\.json$/)?.[1];
      // (strict: a save over a version that isn't the server's is turned away, as the real one is)
      if (st.strict && b.sha && b.sha !== (st.shaOf?.[slug] || `sha-${slug}-${st.saves.length}`)) return json({ success: false, error: 'This file was changed since you opened it (conflict)' }, 409);
      if (st.shaOf) delete st.shaOf[slug];
      st.kids[slug] = JSON.parse(b.content);
      st.saves.push(st.kids[slug]);
      return json({ success: true, sha: `sha-${slug}-${st.saves.length}` });
    }
    if (p === '/api/upload-image') {
      const n = st.uploads.length + 1;
      st.uploads.push(n);
      const failing = st.failUploads > 0 && st.failUploads--;
      return later(st.uploadDelay, () => (failing ? json({ success: false, error: 'Cloudflare said no' }, 500)
        : json({ success: true, imageId: `kids/test/up-${n}`, imageUrl: `https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/test/up-${n}/public` })));
    }
    if (p === '/api/reveals-admin') return json({ success: true, reveals: [{ slug: SLUG, name: 'Dylan', startsAt: '2026-11-18T21:00:00.000Z', date: '2026-11-18', time: '16:00', confirmed: true, jobId: JOB }], jobs: { [SLUG]: JOB }, statuses: { [SLUG]: 'Build' } });
    if (p === '/api/reveal-design-admin') {
      st.listings++;
      st.lastListing = url.search;
      if (st.failListing) { st.failListing = false; return json({ success: false, error: 'JobTread returned 503' }, 500); }
      const listing = st.listing || LISTING;
      return json(st.noJob ? { ...listing, job: null, drawings: [], befores: [], sheets: [] } : listing);
    }
    if (p === '/api/applicants-admin' && url.searchParams.has('cdn')) return req.respond({ status: 404, contentType: 'text/plain', body: 'JobTread answered 404' });
    if (p === '/api/generate') return json({ success: true, altTexts: [] });
    if (p.startsWith('/api/pending-changes')) return json({ success: true, changes: [], publish: { live: null, active: null, failed: null, typicalSeconds: 480 } });
    if (p.startsWith('/api/live-ws')) { req.abort(); return true; }
    if (p === '/api/broadcast' || p === '/api/reveals' || p === '/api/reveal-design') return false; // the slate's own: the dev server answers
    return json({ success: true, ok: true });
  };
  return { st, respond };
}

async function open(browser, { width, height, mobile }, files, opts = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|net::ERR/.test(m.text())) errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 300)}`));
  await answerAsks(page, { onAsk: (t) => console.log('  (asked: ' + t.slice(0, 120) + ')') });
  const api = makeApi(files, opts);
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.isInterceptResolutionHandled()) return;
    if (api.respond(req) !== false) return;
    if (req.resourceType() === 'image' && /imagedelivery|i\.ytimg|videodelivery/.test(req.url())) return req.respond({ status: 200, contentType: 'image/png', body: PIXEL });
    req.continue();
  });
  // Upload names, as the admin sends them (multipart bodies don't reach the interceptor)
  await page.evaluateOnNewDocument(() => {
    try { localStorage.clear(); } catch {}
    window.__uploads = [];
    const append = FormData.prototype.append;
    window.__uploadBlobs = [];
    FormData.prototype.append = function (k, v, ...rest) { if (k === 'file' && v instanceof Blob) { window.__uploads.push({ name: v.name || rest[0], type: v.type, size: v.size }); window.__uploadBlobs.push(v); } return append.call(this, k, v, ...rest); };
  });
  await page.goto(`${SITE}/admin/index.html`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.nav-item, .sidebar', { timeout: 20000 });
  return { page, api, errors };
}
const clickText = (page, sel, text) => page.evaluate((sel, text) => {
  const el = [...document.querySelectorAll(sel)].find((e) => e.offsetParent !== null && e.textContent.replace(/\s+/g, ' ').trim().startsWith(text));
  if (el) el.click();
  return !!el;
}, sel, text);
async function openDylan(page, mobile) {
  if (mobile) { await page.evaluate(() => document.querySelector('.hamburger')?.click()); await sleep(350); }
  await clickText(page, '.nav-item', 'Kids');
  await page.waitForSelector('.kd-row', { timeout: 15000 });
  await page.evaluate((s) => [...document.querySelectorAll('.kd-row')].find((r) => r.dataset.slug === s)?.querySelector('.kd-row__name')?.click(), SLUG);
  await page.waitForSelector('.kd-ed-head', { timeout: 10000 });
  await sleep(600);
}
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`) }).catch(() => {});

/** Colours on an image (a blob: URL in the page): red pixels (the address) and blue (room labels), and whether a title block rule is left */
const inspect = (page, src) => page.evaluate(async (src) => {
  const img = new Image();
  img.src = typeof src === 'number' ? URL.createObjectURL(window.__uploadBlobs[src]) : src;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let red = 0, blue = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    if (r > 150 && g < 110 && b < 110) red++;
    if (b > 150 && r < 110 && g < 110) blue++;
  }
  // How much of the picture the drawing fills (cropped to it, not a whole sheet with its border and title block)
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    const i = (y * c.width + x) * 4;
    if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < 200) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  const fill = x1 < 0 ? 0 : ((x1 - x0 + 1) * (y1 - y0 + 1)) / (c.width * c.height);
  return { red, blue, w: c.width, h: c.height, fill };
}, src);

async function desktop(browser, files) {
  console.log('\nDesktop 1440');
  const { page, api, errors } = await open(browser, { width: 1440, height: 900, mobile: false }, files);
  await openDylan(page, false);

  // The note: the real time it opens
  const note = await page.$eval('#kd-sec-plans .kd-design-when', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  ok(/existing and proposed plans show on Dylan’s page/.test(note) && /3:00 PM, Wednesday, November 18/.test(note) && /Design boards stay off until after the reveal/.test(note), `plans note says where and when: “${note}”`);
  const tsub = await page.$eval('#kd-sec-transform .kd-sec__sub', (e) => e.textContent.trim()).catch(() => '');
  ok(/shown once the room is revealed/.test(tsub) && /before photos for the reveal screen are in Photos/.test(tsub) && !(await page.$('#kd-sec-transform .kd-design-when')), `Before & after says where the reveal's before photos are, not the long note again: “${tsub}”`);
  ok(!(await page.$('#kd-sec-transform input[type="file"][multiple]')), 'Before & after has no Add before photos');
  const bsub = await page.$eval('#kd-befores .kd-sec__sub', (e) => e.textContent.trim()).catch(() => '');
  // (Dylan's reveal is confirmed here)
  ok(/from JobTread now that the reveal is confirmed/.test(bsub) && /Never in the gallery/.test(bsub) && /Each one on the page shows in the Before section of Dylan’s page/.test(bsub) && /the first 6 play on the live reveal page/.test(bsub), `Photos → Before photos says what they are: “${bsub}”`);
  ok(/brings in the job’s Before photos from JobTread on its own/.test(await page.$eval('#kd-befores .kd-empty-line', (e) => e.textContent).catch(() => '')), 'with none yet, it says they come by themselves');

  // Bring in from JobTread
  ok(await clickText(page, '#kd-sec-plans .kd-sec__actions .btn', 'Bring in from JobTread'), 'Bring in from JobTread opens');
  await page.waitForSelector('.rdi', { timeout: 10000 });
  ok(api.st.lastListing?.includes(`job=${JOB}`), 'asks for the job the editor knows');
  // Every page drawn, then the picked ones made ready
  await page.waitForFunction(() => document.querySelectorAll('.rdi .rdi-grid:not(.rdi-grid--photos) > li').length === 5, { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('.rdi .rdi-busy') && /Add 3 drawings and 8 before photos/.test(document.querySelector('.rdi .btn-primary')?.textContent || ''), { timeout: 30000 }).catch(() => {});
  await shot(page, 'import-1440');
  const tiles = await page.$$eval('.rdi .rdi-grid:not(.rdi-grid--photos) > li', (lis) => lis.map((li) => ({
    on: li.classList.contains('is-on'), sheet: li.querySelector('.rdi-sheet')?.textContent.trim(),
    kind: li.querySelector('[role="radio"][aria-checked="true"]')?.textContent.trim() || null, label: li.querySelector('input.form-input')?.value || null,
    src: li.querySelector('img')?.src, chip: li.querySelector('.rdi-meta .kd-chip')?.textContent.trim() || '',
  })));
  ok(tiles.map((t) => t.on).join() === 'false,true,true,false,true', `picked to start: existing, proposed, board (not the cover or electrical): ${tiles.map((t) => t.on).join()}`);
  ok(tiles[1].kind === 'As-built' && tiles[2].kind === 'Proposed' && tiles[4].kind === 'Board', `kinds: ${tiles.map((t) => t.kind).join(', ')}`);
  ok(tiles[1].label === 'Existing floor plan' && tiles[2].label === 'Proposed floor plan', `captions from JobTread's sheet names: ${tiles[1].label} / ${tiles[2].label}`);
  ok(/Address wiped/.test(tiles[1].chip) && /Address wiped/.test(tiles[2].chip), `chips: ${tiles[1].chip} / ${tiles[2].chip}`);
  ok(/Check for the address/.test(tiles[4].chip), `a picture (the board) can't be searched by its words, so it asks for a look: ${tiles[4].chip}`);
  const blocked = await page.$eval('.rdi .rdi-foot', (f) => ({ disabled: f.querySelector('.btn-primary').disabled, status: f.querySelector('.rdi-foot__status').textContent.trim() }));
  ok(blocked.disabled && /Look over 1 drawing for the family’s address/.test(blocked.status), `Add waits for that look: “${blocked.status}”`);
  for (const i of [1, 2]) {
    const px = await inspect(page, tiles[i].src);
    ok(px.red === 0, `${tiles[i].sheet}: no red (address) pixel left (${px.red})`);
    ok(px.blue > 50, `${tiles[i].sheet}: the room labels are still there (${px.blue} blue pixels)`);
    ok(px.fill > 0.8, `${tiles[i].sheet}: cropped to the drawing, not the whole sheet (it fills ${Math.round(px.fill * 100)}% of ${px.w}×${px.h})`);
  }
  // Even the small unpicked pages have the address painted out
  const coverPx = await inspect(page, tiles[0].src);
  ok(coverPx.red === 0, `the cover's thumbnail has no red pixel either (${coverPx.red})`);
  const befores = await page.$$eval('.rdi .rdi-grid--photos > li', (lis) => lis.map((li) => li.classList.contains('is-on')));
  ok(befores.length === 8 && befores.every(Boolean), `every before photo picked: ${befores.map((b) => (b ? 1 : 0)).join('')}`);
  const beforeHead = await page.$eval('.rdi #rdi-befores', (h) => h.closest('.rdi-sec__head').textContent.replace(/\s+/g, ' ').trim());
  ok(/They go in Photos → Before photos, never the gallery; the first 6 on the page there play on the reveal screen/.test(beforeHead) && /Once saved, the site checks each one within minutes/.test(beforeHead) && /Pick none/.test(beforeHead) && !/Pick all/.test(beforeHead), `it says where they go, and that the site checks them: “${beforeHead}”`);
  // Pick none, then all again
  await clickText(page, '.rdi .rdi-sec__picks .btn', 'Pick none');
  await sleep(150);
  ok(await page.$$eval('.rdi .rdi-grid--photos .is-on', (x) => x.length) === 0, 'Pick none picks none');
  await clickText(page, '.rdi .rdi-sec__picks .btn', 'Pick all 8');
  await sleep(150);
  ok(await page.$$eval('.rdi .rdi-grid--photos .is-on', (x) => x.length) === 8, 'Pick all picks all 8');

  // Pick the electrical sheet, then drop it again; change the board's kind and back
  await page.evaluate(() => document.querySelectorAll('.rdi .rdi-grid:not(.rdi-grid--photos) > li')[3].querySelector('.rdi-pick').click());
  await sleep(200);
  ok(await page.$eval('.rdi .rdi-grid:not(.rdi-grid--photos) > li:nth-child(4)', (li) => li.classList.contains('is-on')), 'an unpicked page can be picked');
  await page.waitForFunction(() => !document.querySelector('.rdi .rdi-busy'), { timeout: 20000 });
  await page.evaluate(() => document.querySelectorAll('.rdi .rdi-grid:not(.rdi-grid--photos) > li')[3].querySelector('.rdi-pick').click());
  await sleep(200);
  // The board: looked over, no address on it
  await page.evaluate(() => document.querySelectorAll('.rdi .rdi-grid:not(.rdi-grid--photos) > li')[4].querySelector('.rdi-tick input').click());
  await sleep(200);
  const add = await page.$eval('.rdi .rdi-foot .btn-primary', (b) => ({ text: b.textContent.trim(), disabled: b.disabled }));
  ok(add.text === 'Add 3 drawings and 8 before photos' && !add.disabled, `Add says what it adds: “${add.text}”`);

  // Add
  await page.click('.rdi .rdi-foot .btn-primary');
  await page.waitForFunction(() => !document.querySelector('.rdi'), { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll('#kd-sec-plans .kd-plan').length === 3 && document.querySelectorAll('#kd-befores .kd-tile').length === 8 && !document.querySelector('#kd-sec-plans .kd-tile__busy, #kd-befores .kd-tile__busy'), { timeout: 20000 }).catch(async (e) => {
    console.log('DEBUG after Add:', JSON.stringify(await page.evaluate(() => ({ plans: document.querySelectorAll('#kd-sec-plans .kd-plan').length, busy: document.querySelectorAll('.kd-tile__busy').length, pairs: document.querySelectorAll('#kd-sec-transform .kd-pair').length, toasts: [...document.querySelectorAll('.toast, [class*="toast"]')].map((t) => t.textContent.trim()).slice(0, 5), uploads: window.__uploads.length }))), errors);
    await shot(page, 'debug-after-add');
    throw e;
  });
  await sleep(300);
  const ups = await page.evaluate(() => window.__uploads);
  const drawUps = ups.filter((u) => u.type === 'image/png' && /notitle/.test(u.name));
  ok(drawUps.length === 3, `every drawing went up as a PNG marked as seen to (-notitle): ${ups.map((u) => u.name).join(', ')}`);
  const kinds = await page.$$eval('#kd-sec-plans .kd-plan', (lis) => lis.map((li) => li.querySelector('.kd-plan__kind [aria-checked="true"]')?.textContent.trim()));
  ok(kinds.join() === 'As-built,Proposed,Board', `plan tiles keep their kinds: ${kinds.join()}`);
  const chips = await page.$$eval('#kd-sec-plans .kd-plan', (lis) => lis.map((li) => li.querySelector('.kd-plan__meta .kd-chip')?.textContent.trim() || '(none)'));
  ok(chips[0] === 'Address taken off' && chips[1] === 'Address taken off' && chips[2] === '(none)', `editor chips say what happened (a board shows none): ${chips.join(' | ')}`);
  ok(!(await page.$('.toast')) || !/Save to keep them/.test(await page.$eval('.toast', (t) => t.textContent).catch(() => '')), 'no toast over the Save bar');
  // Before photos: in Photos, their own group; none in the gallery or Before & after
  ok(await page.$$eval('#kd-sec-transform .kd-pair', (x) => x.length) === 0, 'nothing in Before & after');
  // Brought in from JobTread: nobody has looked at them yet, so none shows anywhere until the site has (or staff)
  const waiting = await page.$$eval('#kd-befores .kd-tile', (lis) => lis.map((li) => li.querySelector('.kd-tile__role')?.textContent.trim() || '').join());
  ok(waiting === Array(8).fill('Not checked').join(), `brought in, each waits for the site’s check: ${waiting}`);
  ok((await page.evaluate(() => window.__soardRevealDesign?.().slides.filter((s) => s.kind === 'before').length)) === 0, 'none plays on the reveal screen until then');
  // Staff can say for themselves: all of them on the page, from Select
  await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Select');
  await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open').forEach((b) => b.click()));
  await clickText(page, '#kd-befores .kd-selectbar .btn', 'Show on the page');
  await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Done selecting');
  await sleep(200);
  const bt = await page.$$eval('#kd-befores .kd-tile', (lis) => lis.map((li) => ({ n: li.querySelector('.kd-tile__n')?.textContent.trim(), screen: /on the reveal screen/.test(li.querySelector('.kd-tile__open').getAttribute('aria-label')) })));
  ok(bt.length === 8 && bt.map((t) => (t.screen ? 1 : 0)).join('') === '11111100', `8 before photos, the first 6 on the reveal screen: ${bt.map((t) => (t.screen ? 1 : 0)).join('')}`);
  const bz = await page.$$eval('#kd-befores .kd-zone', (z) => z.map((x) => x.textContent.trim()));
  ok(bz.join(' | ') === 'On the reveal screen | Not on the reveal screen', `zones: ${bz.join(' | ')}`);
  ok(ups.filter((u) => !/notitle/.test(u.name)).length === 8, `8 before photos went up: ${ups.filter((u) => !/notitle/.test(u.name)).map((u) => u.name).join(', ')}`);
  await shot(page, 'after-add-1440');
  for (const id of ['plans', 'photos', 'transform']) {
    const el = await page.$(`#kd-sec-${id}`);
    await el?.screenshot({ path: join(OUT, `section-${id}-1440.png`) }).catch(() => {});
  }

  // Kind picker on a tile
  await page.evaluate(() => [...document.querySelectorAll('#kd-sec-plans .kd-plan')[2].querySelectorAll('.kd-plan__kind [role="radio"]')].find((b) => b.textContent.trim() === 'Proposed').click());
  await sleep(150);
  ok(await page.$eval('#kd-sec-plans .kd-plan:nth-child(3) .kd-plan__kind [aria-checked="true"]', (b) => b.textContent.trim()) === 'Proposed', 'a tile’s kind changes with a press');
  await page.evaluate(() => [...document.querySelectorAll('#kd-sec-plans .kd-plan')[2].querySelectorAll('.kd-plan__kind [role="radio"]')].find((b) => b.textContent.trim() === 'Board').click());

  // Preview the reveal screen, with what's here (unsaved)
  const slides = await page.evaluate(() => window.__soardRevealDesign?.().slides.map((s) => s.kind));
  ok(slides?.join() === 'before,before,before,before,before,before,as-built,proposed', `the editor hands the screen its design, never a board: ${slides?.join()}`);
  ok(await clickText(page, '#kd-sec-plans .kd-sec__actions .btn', 'Preview the stream'), 'Preview the stream opens');
  await page.waitForSelector('.rdp iframe', { timeout: 10000 });
  const frameSrc = await page.$eval('.rdp iframe', (f) => f.getAttribute('src'));
  ok(frameSrc === `/live/${SLUG}/slate/?design=preview&o=portrait`, `frames the kid's slate as the stream shows it: ${frameSrc}`);
  // (main's dev server rebuilds the slate while it's being edited: give it time)
  await page.waitForFunction(() => !!document.querySelector('.rdp iframe')?.contentDocument?.getElementById('canvas'), { timeout: 30000 }).catch(() => {});
  await sleep(1500);
  const framed = await page.evaluate(() => { const d = document.querySelector('.rdp iframe')?.contentDocument; return { canvas: !!d?.getElementById('canvas'), text: d?.body?.innerText.slice(0, 120) || '' }; });
  ok(framed.canvas, `the slate loaded in the frame (${framed.text.replace(/\s+/g, ' ').slice(0, 60)})`);
  await shot(page, 'preview-stream-1440');
  await clickText(page, '.rdp .seg [role="radio"]', 'Landscape');
  await sleep(600);
  ok(/o=landscape/.test(await page.$eval('.rdp iframe', (f) => f.getAttribute('src'))), 'landscape frames the wide shape');
  await shot(page, 'preview-landscape-1440');
  await clickText(page, '.rdp .seg [role="radio"]', 'Portrait');
  await sleep(1500);
  ok(/o=portrait/.test(await page.$eval('.rdp iframe', (f) => f.getAttribute('src'))), 'portrait frames the phone shape');
  await shot(page, 'preview-portrait-1440');
  await clickText(page, '.rdp .kd-dialog__foot .btn', 'Done');
  await sleep(300);
  // Preview the live page: the kid's real page at each moment, answered from the admin (nothing reaches the site)
  ok(await clickText(page, '#kd-sec-plans .kd-sec__actions .btn', 'Preview the live page'), 'Preview the live page opens');
  await page.waitForSelector('.rlp iframe', { timeout: 20000 });
  const liveAt = async (moment) => {
    if (moment !== 'starting') { await clickText(page, '.rlp .seg [role="radio"]', moment === 'live' ? 'Live' : 'Replay'); await sleep(400); }
    await page.waitForFunction((m) => { const f = document.querySelector('.rlp iframe'); return f && f.src.includes(`moment=${m}`) && f.contentDocument?.querySelector('.live-page')?.dataset.view; }, { timeout: 30000 }, moment).catch(() => {});
    await page.waitForFunction(() => document.querySelector('.rlp iframe')?.contentDocument?.querySelector('[data-live-design]:not([hidden]) .ldz-item'), { timeout: 15000 }).catch(() => {});
    await page.waitForFunction(() => document.querySelector('.rlp iframe')?.contentDocument?.querySelector('.hds-item img[src]'), { timeout: 15000 }).catch(() => {});
    return page.evaluate(() => {
      const d = document.querySelector('.rlp iframe').contentDocument;
      // The strip beside the video: on screen with it, never on it
      const rail = d.querySelector('[data-design-rail]')?.getBoundingClientRect();
      const screen = d.querySelector('.stage__screen')?.getBoundingClientRect();
      const beside = !!rail && !!screen && rail.width > 0 && rail.left >= screen.right && rail.top < screen.bottom;
      return { view: d.querySelector('.live-page')?.dataset.view, design: !d.querySelector('[data-live-design]')?.hidden, items: d.querySelectorAll('[data-live-design] .ldz-item').length, rail: d.querySelectorAll('.hds-item').length, beside, share: !!d.querySelector('[data-live="cta-share"]:not([hidden]):not([data-capped])') };
    });
  };
  const savesBefore = api.st.saves.length;
  const st = await liveAt('starting');
  ok(st.view === 'starting' && st.design && st.items > 0 && st.share, `starting soon: the reveal screen in the frame, the design under it, Share (${JSON.stringify(st)})`);
  ok(st.rail > 0 && st.beside, `starting soon: the design runs down the side of the reveal screen (${st.rail} pictures)`);
  await shot(page, 'preview-live-starting-1440');
  const lv = await liveAt('live');
  ok(lv.view === 'live' && lv.design && lv.share, `live: the camera's place, the design still under it, Share (${JSON.stringify(lv)})`);
  ok(lv.rail > 0 && lv.beside, `live: the design beside the video, on screen with it (${lv.rail} pictures)`);
  // A picture from the strip opens while the reveal stays in sight: on the phone (the preview's first) over the screen
  // with the video held small in its corner; on a laptop beside the video, not over it. The strip marks it.
  const openFromStrip = () => page.evaluate(async () => {
    const d = document.querySelector('.rlp iframe').contentDocument;
    d.querySelector('.hds-paper, .hds-item')?.click();
    await new Promise((r) => setTimeout(r, 700));
    const v = d.querySelector('[data-ldz-viewer]');
    const box = v.getBoundingClientRect();
    const screen = d.querySelector('.stage__screen').getBoundingClientRect();
    const out = { open: v.open, side: v.classList.contains('ldv--side'), pinned: v.classList.contains('ldv--pinned') && d.querySelector('[data-s="picture"]').classList.contains('is-pinned'), clear: box.right <= screen.left, marked: !!d.querySelector('.hds-item[aria-current="true"]'), width: d.defaultView.innerWidth };
    v.close();
    return out;
  });
  const onPhone = await openFromStrip();
  ok(onPhone.open && onPhone.pinned && onPhone.marked, `live, phone: a picture fills the screen with the video kept small in its corner (${JSON.stringify(onPhone)})`);
  await clickText(page, '.rlp .seg [role="radio"]', 'Laptop');
  await sleep(400);
  await page.waitForFunction(() => { const f = document.querySelector('.rlp iframe'); return f?.contentDocument?.defaultView?.innerWidth > 1000 && f.contentDocument.querySelector('.hds-item img[src]'); }, { timeout: 30000 }).catch(() => {});
  const side = await openFromStrip();
  ok(side.open && side.side && side.clear && side.marked, `live, laptop: a picture opens beside the video, not over it, and the strip marks it (${JSON.stringify(side)})`);
  await shot(page, 'preview-live-laptop-1440');
  await clickText(page, '.rlp .seg [role="radio"]', 'Phone');
  await sleep(300);
  await shot(page, 'preview-live-live-1440');
  ok(api.st.saves.length === savesBefore, 'nothing from the preview reaches the site');
  await clickText(page, '.rlp .kd-dialog__foot .btn', 'Done');
  await sleep(300);

  // Save: everything on the record
  await page.click('.kd-bar__save .kd-save');
  await page.waitForFunction((n) => true, {}, 0);
  await sleep(1200);
  const saved = api.st.saves.at(-1);
  ok(!!saved, 'Save wrote the profile');
  if (saved) {
    ok(saved.plans.map((p) => p.type).join() === 'as-built,proposed,board', `plan kinds saved: ${saved.plans.map((p) => p.type).join()}`);
    ok(saved.plans.map((p) => p.addressCheck).join() === 'wiped,wiped,checked', `what was done about the address is saved: ${saved.plans.map((p) => p.addressCheck).join()}`);
    ok(saved.plans.every((p) => p.source?.startsWith('jt:') && p.w > 0 && p.h > 0 && p.label), `each plan keeps its JobTread source, size and caption: ${JSON.stringify(saved.plans.map(({ source, w, h, label }) => ({ source, w, h, label })))}`);
    ok(saved.beforePhotos.length === 8 && saved.beforePhotos.every((p) => p.url && !/^blob:/.test(p.url) && /^jt:B\d$/.test(p.source) && p.alt === 'Dylan’s room before the makeover' && p.room === '' && !p._key && !p._tempId), `before photos saved in Photos → Before photos: ${JSON.stringify(saved.beforePhotos[0])}`);
    // The six spread across the visit first, as the reveal screen plays the first six; then the rest as taken
    ok(saved.beforePhotos.map((p) => p.source).join() === 'jt:B1,jt:B2,jt:B4,jt:B5,jt:B7,jt:B8,jt:B3,jt:B6', `order: ${saved.beforePhotos.map((p) => p.source).join()}`);
    ok(saved.beforeAfterPhotos.length === 0, `nothing in Before & after: ${saved.beforeAfterPhotos.length}`);
  }

  // Open the dialog again (from Before photos): what's added shows as on the profile, and nothing is picked twice
  await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Bring in from JobTread');
  await page.waitForSelector('.rdi', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('.rdi .rdi-grid:not(.rdi-grid--photos) > li').length === 5 && !document.querySelector('.rdi .rdi-busy'), { timeout: 30000 });
  await sleep(500);
  const again = await page.evaluate(() => ({
    there: document.querySelectorAll('.rdi .is-there').length,
    on: document.querySelectorAll('.rdi .rdi-tile.is-on').length,
    add: document.querySelector('.rdi .rdi-foot .btn-primary')?.textContent.trim(),
  }));
  ok(again.there === 11 && again.on === 0, `next time, the 11 added (3 drawings, 8 before photos) show as on the profile and nothing is picked for them (${again.there} there, ${again.on} picked, “${again.add}”)`);
  await shot(page, 'import-again-1440');
  // Close with nothing picked: no question
  await page.click('.rdi .kd-dialog__head .kd-x');
  await sleep(300);
  ok(!(await page.$('.rdi')), 'closes at once when nothing is picked');

  ok(real(errors).length === 0, `no console errors (${errors.join(' | ').slice(0, 300)})`);
  await page.close();
}

async function phone(browser, files) {
  console.log('\nPhone 390');
  const { page, errors } = await open(browser, { width: 390, height: 844, mobile: true }, files);
  await openDylan(page, true);
  await page.evaluate(() => document.getElementById('kd-sec-plans')?.scrollIntoView());
  await shot(page, 'plans-390');
  ok(await clickText(page, '#kd-sec-plans .kd-sec__actions .btn', 'Bring in from JobTread'), 'Bring in from JobTread opens on a phone');
  await page.waitForSelector('.rdi', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('.rdi .rdi-grid:not(.rdi-grid--photos) > li').length === 5 && !document.querySelector('.rdi .rdi-busy'), { timeout: 40000 }).catch(() => {});
  await sleep(500);
  const fit = await page.evaluate(() => {
    const dlg = document.querySelector('.rdi');
    const body = dlg.querySelector('.kd-dialog__body');
    const foot = dlg.querySelector('.kd-dialog__foot');
    const r = dlg.getBoundingClientRect();
    const fr = foot.getBoundingClientRect();
    const btns = [...foot.querySelectorAll('.btn')].map((b) => b.getBoundingClientRect());
    const cols = getComputedStyle(dlg.querySelector('.rdi-grid:not(.rdi-grid--photos)')).gridTemplateColumns.split(' ').length;
    return { w: r.width, left: r.left, right: r.right, sideways: body.scrollWidth > body.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth,
      footIn: fr.bottom <= innerHeight + 1 && fr.top >= 0, tall: btns.every((b) => b.height >= 40), cols };
  });
  ok(fit.left >= 0 && fit.right <= 391, `the sheet fits the screen (${Math.round(fit.left)}..${Math.round(fit.right)})`);
  ok(!fit.sideways, 'nothing scrolls sideways');
  ok(fit.footIn, 'Cancel and Add stay on screen');
  ok(fit.tall, 'buttons are big enough to tap');
  ok(fit.cols === 2, `pages two to a row, a picked one across the row (${fit.cols} columns)`);
  await shot(page, 'import-390');
  await page.evaluate(() => document.querySelector('.rdi .rdi-tile.is-on')?.scrollIntoView({ block: 'start' }));
  await sleep(300);
  await shot(page, 'import-390-picked');
  const tileFit = await page.evaluate(() => { const t = document.querySelector('.rdi .rdi-tile.is-on'); const seg = t?.querySelector('.seg'); return { segOver: seg ? seg.scrollWidth > seg.clientWidth + 1 : null, words: [...(seg?.querySelectorAll('[role="radio"]') || [])].every((b) => b.scrollWidth <= b.clientWidth + 1) }; });
  ok(tileFit.segOver === false && tileFit.words, `a picked drawing's kind picker fits its tile on a phone (${JSON.stringify(tileFit)})`);
  // Close with a pick of their own: asked first (answered Keep picking, then Close). Picks made for them don't ask.
  await page.evaluate(() => document.querySelector('.rdi .rdi-grid--photos > li:nth-child(2) .rdi-pick').click());
  await sleep(150);
  const asked = [];
  await answerAsks(page, { accept: false, onAsk: (t) => asked.push(t) });
  await page.click('.rdi .kd-dialog__head .kd-x');
  await sleep(500);
  ok(/Close without adding them\?/.test(asked[0] || '') && !!(await page.$('.rdi')), `closing with picks asks first, and Keep picking keeps it open: “${(asked[0] || '').slice(0, 80)}”`);
  await answerAsks(page, { accept: true, onAsk: (t) => asked.push(t) });
  await page.click('.rdi .kd-dialog__head .kd-x');
  await sleep(500);
  ok(!(await page.$('.rdi')), 'Close closes it');
  ok(real(errors).length === 0, `no console errors (${errors.join(' | ').slice(0, 300)})`);
  await page.close();
}

async function whenThingsGoWrong(browser, files) {
  console.log('\nWhen things go wrong (1440)');
  const broken = { ...files };
  delete broken['planset.pdf'];
  const { page, api, errors } = await open(browser, { width: 1440, height: 900, mobile: false }, broken);
  api.st.failListing = true;
  await openDylan(page, false);
  await clickText(page, '#kd-sec-plans .kd-sec__actions .btn', 'Bring in from JobTread');
  await page.waitForSelector('.rdi .empty', { timeout: 10000 });
  const said = await page.$eval('.rdi .empty', (e) => e.textContent.replace(/\s+/g, ' ').trim());
  ok(/Couldn’t read JobTread/.test(said) && /503/.test(said), `JobTread down says so: “${said}”`);
  await clickText(page, '.rdi .empty .btn', 'Try again');
  await page.waitForFunction(() => /Couldn’t open it/.test(document.querySelector('.rdi')?.textContent || ''), { timeout: 20000 }).catch(() => {});
  const fileErr = await page.evaluate(() => [...document.querySelectorAll('.rdi .rdi-empty')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()).find((t) => /Couldn’t open it/.test(t)) || '');
  ok(/Couldn’t open it/.test(fileErr) && /Try again/.test(fileErr), `a plan set that won't open says so, with Try again: “${fileErr.slice(0, 90)}”`);
  await page.waitForFunction(() => /Add 1 drawing and 8 before photos/.test(document.querySelector('.rdi .rdi-foot .btn-primary')?.textContent || ''), { timeout: 20000 }).catch(() => {});
  ok(/Add 1 drawing and 8 before photos/.test(await page.$eval('.rdi .rdi-foot .btn-primary', (b) => b.textContent.trim())), 'the rest can still be added');
  await shot(page, 'failures-1440');
  await answerAsks(page, { accept: true });
  await page.keyboard.press('Escape');
  await sleep(400);
  ok(!(await page.$('.rdi')), 'Escape closes it');
  // No job
  api.st.noJob = true;
  await clickText(page, '#kd-sec-plans .kd-sec__actions .btn', 'Bring in from JobTread');
  await page.waitForSelector('.rdi .empty', { timeout: 10000 });
  ok(/No JobTread job for Dylan/.test(await page.$eval('.rdi .empty', (e) => e.textContent)), 'no job says so plainly');
  ok(errors.filter((e) => !/404|CORS|cdn\.jobtread/i.test(e)).length === 0, `no console errors (${errors.join(' | ').slice(0, 300)})`);
  await page.close();
}

// ── QA round 1 cases ──────────────────────────────────────────────────

/** Sheets drawn in a browser canvas, as PNGs: a border 2% in, a plan, blue room labels, the address in red where asked */
async function rasters(browser, specs) {
  const page = await browser.newPage();
  const out = await page.evaluate(async (specs) => {
    const res = {};
    for (const s of specs) {
      const W = s.w || 2200, H = s.h || 1700;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
      x.strokeStyle = '#000'; x.lineWidth = 4; x.strokeRect(50, 50, W - 100, H - 100);
      x.fillStyle = '#000'; x.font = `bold ${Math.round(W / 40)}px Helvetica`; x.fillText(s.title || 'EXISTING FLOOR PLAN', 110, 140);
      x.lineWidth = 8; x.strokeRect(220, 400, 600, 700); x.strokeRect(880, 400, 600, 700);
      x.fillStyle = '#00f'; x.font = `bold ${Math.round(W / 55)}px Helvetica`; x.fillText('BEDROOM', 380, 750); x.fillText('BATH', 1080, 750);
      if (s.titleBlock) {
        x.fillStyle = '#000'; x.fillRect(50, H - 230, W - 100, 6);
        x.fillStyle = '#f00'; x.font = `${Math.round(W / 70)}px Helvetica`; x.fillText('MARCHENA RESIDENCE    426 MOUNTAIN VIEW LN    MARIETTA, GA 30064', 110, H - 130);
      }
      // (Right under the rooms: the crop to the drawing keeps it, so it has to be looked at and covered)
      if (s.middle) { x.fillStyle = '#f00'; x.font = `${Math.round(W / 70)}px Helvetica`; x.fillText(s.middle, 300, 1150); }
      // (Down the side of the plan, close enough that the crop to the drawing keeps it)
      if (s.rotated) { x.save(); x.translate(1530, 1100); x.rotate(-Math.PI / 2); x.fillStyle = '#f00'; x.font = `${Math.round(W / 70)}px Helvetica`; x.fillText('426 MOUNTAIN VIEW LN, MARIETTA GA 30064', 0, 0); x.restore(); }
      const b = await new Promise((d) => c.toBlob(d, 'image/png'));
      const u = new Uint8Array(await b.arrayBuffer());
      let str = ''; for (let i = 0; i < u.length; i += 0x8000) str += String.fromCharCode(...u.subarray(i, i + 0x8000));
      res[s.name] = btoa(str);
    }
    return res;
  }, specs);
  await page.close();
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
}
async function scannedPdf(pngBuf) {
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(pngBuf);
  doc.addPage([792, 612]).drawImage(img, { x: 0, y: 0, width: 792, height: 612 });
  return Buffer.from(await doc.save());
}
async function setOf(pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const pg of pages) {
    const p = doc.addPage([792, 612]);
    p.drawRectangle({ x: 18, y: 18, width: 756, height: 576, borderColor: rgb(0, 0, 0), borderWidth: 1.5 });
    if (pg.block !== false) p.drawLine({ start: { x: 18, y: 78 }, end: { x: 774, y: 78 }, thickness: 2, color: rgb(0, 0, 0) });
    for (const t of pg.blockText || []) p.drawText(t.s, { x: t.x, y: 52, size: 11, font, color: RED });
    p.drawText(pg.title, { x: 40, y: 560, size: 16, font: bold, color: rgb(0, 0, 0) });
    for (const [i, r] of (pg.rooms || []).entries()) {
      p.drawRectangle({ x: 80 + i * 220, y: 200, width: 200, height: 260, borderColor: rgb(0, 0, 0), borderWidth: 3 });
      p.drawText(r, { x: 120 + i * 220, y: 320, size: 14, font: bold, color: BLUE });
    }
    for (const [i, t] of (pg.lines || []).entries()) p.drawText(t, { x: 60, y: 500 - i * 18, size: 10, font, color: rgb(0, 0, 0) });
    for (const t of pg.red || []) p.drawText(t.s, { x: t.x, y: t.y, size: t.size || 10, font, color: RED });
  }
  return Buffer.from(await doc.save());
}
const listingWith = (drawings, extra = {}) => ({ ...LISTING, befores: [], sheets: [], ...extra, drawings });
const drawingFile = (id, name, file, tags = ['Plans']) => ({ id, name, type: /\.pdf$/.test(name) ? 'application/pdf' : /\.hei[cf]$/i.test(name) ? 'image/heic' : 'image/png', url: cdn(file), thumb: null, tags, createdAt: '2026-10-19T17:00:00Z', size: 1 });
async function openImport(page, count) {
  await clickText(page, '#kd-sec-plans .kd-sec__actions .btn', 'Bring in from JobTread');
  await page.waitForSelector('.rdi', { timeout: 10000 });
  if (count != null) await page.waitForFunction((n) => document.querySelectorAll('.rdi .rdi-grid:not(.rdi-grid--photos) > li').length === n, { timeout: 40000 }, count).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('.rdi .rdi-busy, .rdi .rdi-skel') && !/Opening…|Drawing page|Getting/.test(document.querySelector('.rdi')?.textContent || ''), { timeout: 40000 }).catch(() => {});
  await sleep(400);
}
const tilesOf = (page) => page.$$eval('.rdi .rdi-grid:not(.rdi-grid--photos) > li', (lis) => lis.map((li) => ({
  on: li.classList.contains('is-on'), needs: li.classList.contains('is-needs'), name: li.querySelector('.rdi-sheet')?.textContent.replace(/\s+/g, ' ').trim(),
  kind: li.querySelector('[role="radio"][aria-checked="true"]')?.textContent.trim() || null, label: li.querySelector('input.form-input')?.value ?? null,
  src: li.querySelector('img')?.src, chip: li.querySelector('.rdi-addr .kd-chip, .rdi-meta .kd-chip')?.textContent.trim() || '', text: li.textContent.replace(/\s+/g, ' '),
})));
/** Where the red is on a picture, as fractions of it (null: none) */
const redArea = (page, src) => page.evaluate(async (src) => {
  const img = new Image(); img.src = src; await img.decode();
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) { const i = (y * c.width + x) * 4; if (data[i] > 150 && data[i + 1] < 110 && data[i + 2] < 110) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } }
  return x1 < 0 ? null : { x0: x0 / c.width, y0: y0 / c.height, x1: x1 / c.width, y1: y1 / c.height };
}, src);
/** Drag a box over an area of the Cover tool's sheet (fractions), a little bigger than it */
async function coverArea(page, a) {
  const r = await page.$eval('.rdc .rdc-sheet', (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  const at = (fx, fy) => [r.x + fx * r.w, r.y + fy * r.h];
  const [sx, sy] = at(Math.max(0, a.x0 - 0.01), Math.max(0, a.y0 - 0.02));
  const [ex, ey] = at(Math.min(1, a.x1 + 0.01), Math.min(1, a.y1 + 0.02));
  await page.mouse.move(sx, sy); await page.mouse.down(); await page.mouse.move((sx + ex) / 2, (sy + ey) / 2, { steps: 4 }); await page.mouse.move(ex, ey, { steps: 4 }); await page.mouse.up();
  await sleep(200);
}

async function addressCases(browser) {
  console.log('\nThe family’s address: the hard cases (1440)');
  const R = await rasters(browser, [{ name: 'mid', titleBlock: true, middle: 'SITE: 426 MOUNTAIN VIEW LN, MARIETTA' }, { name: 'scan', titleBlock: false, rotated: true }]);

  // (a) A picture of a drawing, with the address in a note mid-sheet: can't be searched by words, so it's looked over and covered
  {
    const listing = listingWith([drawingFile('PNGD', 'Existing plan scan.png', 'pngd.png', ['Design'])]);
    const { page, api, errors } = await open(browser, { width: 1440, height: 900, mobile: false }, { 'pngd.png': R.mid }, { listing });
    await openDylan(page, false);
    await openImport(page, 1);
    let [t] = await tilesOf(page);
    ok(t.on && t.needs && /Check for the address/.test(t.chip) && /no words to search/.test(t.text), `(a) a picture asks for a look: “${t.chip}”`);
    ok(/Title block cut off/.test(t.text) === false || /wiped/.test(t.chip), '(a) it doesn’t claim the address was wiped');
    ok(await page.$eval('.rdi .rdi-foot .btn-primary', (b) => b.disabled), '(a) it can’t be added until then');
    const left = await redArea(page, t.src);
    ok(!!left, '(a) the note mid-sheet is still there before covering (the title block itself was cut off)');
    await clickText(page, '.rdi .rdi-addr .btn', 'Cover the address');
    await page.waitForSelector('.rdc .rdc-sheet img', { timeout: 5000 });
    await page.waitForFunction(() => document.querySelector('.rdc .rdc-sheet img')?.complete, { timeout: 5000 });
    await shot(page, 'cover-tool-1440');
    await coverArea(page, left);
    ok(await page.$$eval('.rdc .rdc-box:not(.rdc-box--drawing)', (b) => b.length) === 1, '(a) a dragged box covers it');
    // Keyboard: add a box, move it, delete it
    await page.click('.rdc [data-add-box]');
    await sleep(150);
    const before = await page.$eval('.rdc .rdc-box:last-of-type', (b) => b.style.left);
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
    const after = await page.$eval('.rdc .rdc-box:focus', (b) => b.style.left).catch(() => '');
    ok(after && after !== before, `(a) a box moves with the arrow keys (${before} → ${after})`);
    await page.keyboard.press('Delete');
    await sleep(100);
    ok(await page.$$eval('.rdc .rdc-box', (b) => b.length) === 1, '(a) Delete takes a box away');
    await clickText(page, '.rdc .rdc-bar .btn', 'Undo');
    await sleep(100);
    ok(await page.$$eval('.rdc .rdc-box', (b) => b.length) === 2, '(a) Undo brings it back');
    // Each move was a step: two arrow presses and the added box
    for (let i = 0; i < 3; i++) { await clickText(page, '.rdc .rdc-bar .btn', 'Undo'); await sleep(60); }
    ok(await page.$$eval('.rdc .rdc-box', (b) => b.length) === 1, '(a) and step by step back to the one drawn');
    await clickText(page, '.rdc .rdc-foot .btn', 'Cover 1 area');
    await page.waitForFunction(() => /Covered by hand/.test(document.querySelector('.rdi .rdi-addr')?.textContent || ''), { timeout: 10000 }).catch(() => {});
    [t] = await tilesOf(page);
    ok(/Covered by hand \(1\)/.test(t.chip), `(a) covered: “${t.chip}”`);
    ok(!(await redArea(page, t.src)), '(a) not one red pixel left on what goes up');
    ok(!(await page.$eval('.rdi .rdi-foot .btn-primary', (b) => b.disabled)), '(a) now it can be added');
    await page.click('.rdi .rdi-foot .btn-primary');
    await page.waitForFunction(() => !document.querySelector('.rdi') && !document.querySelector('.kd-tile__busy'), { timeout: 20000 });
    const up = await inspect(page, 0);
    ok(up.red === 0, `(a) the uploaded bytes have no red (${up.red})`);
    await page.click('.kd-bar__save .kd-save'); await sleep(1000);
    ok(api.st.saves.at(-1)?.plans?.[0]?.addressCheck === 'covered', '(a) saved as covered');
    ok(real(errors).length === 0, `(a) no console errors (${errors.join(' | ').slice(0, 200)})`);
    await page.close();
  }

  // (b) A scanned PDF: no words at all, the address down the right edge, the sheet's border 2% in (not a title block)
  {
    const listing = listingWith([drawingFile('SCAN', 'Scanned plans.pdf', 'scan.pdf')], { sheets: [{ fileId: 'SCAN', page: 1, name: 'EXISTING FLOOR PLAN' }] });
    const { page, errors } = await open(browser, { width: 1440, height: 900, mobile: false }, { 'scan.pdf': await scannedPdf(R.scan) }, { listing });
    await openDylan(page, false);
    await openImport(page, 1);
    const [t] = await tilesOf(page);
    ok(t.on && /Check for the address/.test(t.chip) && /no words to search/.test(t.text), `(b) a scan asks for a look: “${t.chip}”`);
    ok(!/Title block cut off/.test(t.text), '(b) its border isn’t called a title block');
    ok(!!(await redArea(page, t.src)), '(b) nothing pretends the address is gone (it’s still on the picture)');
    await page.evaluate(() => document.querySelector('.rdi .rdi-tick input').click());
    await sleep(200);
    const [t2] = await tilesOf(page);
    ok(/Checked: no address on it/.test(t2.chip) && !(await page.$eval('.rdi .rdi-foot .btn-primary', (b) => b.disabled)), `(b) ticking it is staff’s word, said as such: “${t2.chip}”`);
    ok(real(errors).length === 0, `(b) no console errors (${errors.join(' | ').slice(0, 200)})`);
    await page.close();
  }

  // (c) Text PDF with the address letter-spaced, in the title block and a note
  {
    const pdf = await setOf([{ title: 'PROPOSED FLOOR PLAN', rooms: ['THERAPY'], blockText: [{ s: '4 2 6   M O U N T A I N   V I E W   L N', x: 200 }], red: [{ s: 'M A R I E T T A ,  G A   3 0 0 6 4', x: 200, y: 150 }] }]);
    const listing = listingWith([drawingFile('SPACED', 'Spaced.pdf', 'spaced.pdf')]);
    const { page, errors } = await open(browser, { width: 1440, height: 900, mobile: false }, { 'spaced.pdf': pdf }, { listing });
    await openDylan(page, false);
    await openImport(page, 1);
    const [t] = await tilesOf(page);
    ok(t.on && /Address wiped/.test(t.chip), `(c) letter-spaced words are found: “${t.chip}”`);
    ok(!(await redArea(page, t.src)), '(c) not one red pixel left');
    ok(real(errors).length === 0, `(c) no console errors (${errors.join(' | ').slice(0, 200)})`);
    await page.close();
  }

  // (d) A job with no address in JobTread: nothing can be found by words, and the dialog says so
  {
    const listing = { ...LISTING, address: { street: '', city: '', zip: '', family: '' } };
    const { page, errors } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, { listing });
    await openDylan(page, false);
    await openImport(page, 5);
    const banner = await page.$eval('.rdi .notice', (n) => ({ warn: n.classList.contains('notice--warn'), text: n.textContent.replace(/\s+/g, ' ') }));
    ok(banner.warn && /JobTread has no address for this job/.test(banner.text), `(d) the banner says JobTread has no address: “${banner.text.slice(0, 120)}”`);
    const tiles = await tilesOf(page);
    ok(tiles.filter((x) => x.on).every((x) => /Check for the address/.test(x.chip)), `(d) every picked drawing asks for a look: ${tiles.filter((x) => x.on).map((x) => x.chip).join(' | ')}`);
    ok(await page.$eval('.rdi .rdi-foot .btn-primary', (b) => b.disabled), '(d) nothing can be added unlooked');
    ok(real(errors).length === 0, `(d) no console errors (${errors.join(' | ').slice(0, 200)})`);
    await page.close();
  }
}

async function editorFlows(browser) {
  console.log('\nThe editor around an import (1440)');
  const { page, api, errors } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, {});
  await openDylan(page, false);
  await openImport(page, 5);
  await page.evaluate(() => document.querySelectorAll('.rdi .rdi-grid:not(.rdi-grid--photos) > li')[4].querySelector('.rdi-tick input').click());
  await sleep(150);
  // While it gets the before photos: nothing about a drawing can change under it
  api.st.cdnDelay = 1200;
  api.st.uploadDelay = 2500;
  api.st.failUploads = 1;
  // Every toast as it shows (eight before photos take a while to go up, and a toast fades before they're done)
  await page.evaluate(() => {
    window.__toastsSeen = [];
    new MutationObserver(() => {
      for (const t of document.querySelectorAll('.toast, [class*="toast"]')) {
        const x = t.textContent.replace(/\s+/g, ' ').trim();
        if (x && !window.__toastsSeen.includes(x)) window.__toastsSeen.push(x);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await page.click('.rdi .rdi-foot .btn-primary');
  await sleep(300);
  const locked = await page.evaluate(() => [...document.querySelectorAll('.rdi [role="radio"], .rdi input.form-input, .rdi .rdi-tick input')].every((e) => e.disabled));
  ok(locked, 'while Adding…, kinds, captions and ticks are locked');
  await page.waitForFunction(() => !document.querySelector('.rdi'), { timeout: 30000 });
  await sleep(200);
  const bar = await page.evaluate(() => ({ state: document.querySelector('.kd-bar__state')?.textContent.trim(), save: !!document.querySelector('.kd-bar__save .kd-save') }));
  ok(/Unsaved changes/.test(bar.state) && bar.save, `while the pictures go up, the bar says Unsaved changes, with Save (“${bar.state}”)`);
  const asked = [];
  await answerAsks(page, { accept: false, onAsk: (x) => asked.push(x) });
  await clickText(page, '.nav-item', 'Kids');
  await sleep(500);
  ok(/Leave without saving\?/.test(asked[0] || '') && !!(await page.$('.kd-ed-head')), `leaving asks first: “${(asked[0] || '').slice(0, 60)}”`);
  await answerAsks(page, { accept: true });
  await page.waitForFunction(() => !document.querySelector('.kd-tile__busy'), { timeout: 30000 });
  await sleep(300);
  const toasts = (await page.evaluate(() => window.__toastsSeen)).join(' | ');
  ok(/“(Existing|Proposed) floor plan” didn’t upload\. Cloudflare said no|1 before photo didn’t upload\. .*Cloudflare said no/.test(toasts), `a failed upload says what didn’t go up (a drawing by its caption): “${toasts.slice(0, 160)}”`);
  // Take the board off, then look again: nothing is picked again for staff
  await page.evaluate(() => [...document.querySelectorAll('#kd-sec-plans .kd-plan')].find((li) => /Board/.test(li.querySelector('[aria-checked="true"]')?.textContent || ''))?.querySelector('.kd-danger-quiet').click());
  await sleep(300);
  await openImport(page, 5);
  const again = await tilesOf(page);
  ok(again.every((x) => !x.on), `once the profile has JobTread drawings, nothing is picked to start, not even one taken off (${again.map((x) => (x.on ? 1 : 0)).join('')})`);
  ok(await page.$$eval('.rdi .rdi-grid--photos .is-on', (x) => x.length) === 0, '…nor before photos');
  await answerAsks(page, { accept: true });
  await page.keyboard.press('Escape');
  await sleep(300);
  // A file that isn't a picture, in Add before photos (Photos → Before photos)
  const pdfPath = join(OUT, 'not-a-picture.pdf');
  writeFileSync(pdfPath, FILES['planset.pdf']);
  const input = await page.$('#kd-befores input[type="file"][multiple]');
  await input.uploadFile(pdfPath);
  await sleep(500);
  const t2 = await page.$$eval('.toast, [class*="toast"]', (t) => t.map((x) => x.textContent.replace(/\s+/g, ' ').trim()).join(' | '));
  ok(/Left out “not-a-picture\.pdf”: it isn’t a picture/.test(t2), `a file that isn’t a picture is left out, and it says so: “${t2.slice(-90)}”`);
  ok(real(errors).length === 0, `no console errors (${errors.join(' | ').slice(0, 200)})`);
  await page.close();
}

async function handAdded(browser) {
  console.log('\nPlans added by hand, before the reveal (1440)');
  const R = await rasters(browser, [{ name: 'hand', titleBlock: true }]);
  const plans = [
    { url: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/dylan-2026/plan-hand-existing.png/public', label: 'Existing floor plan', type: 'as-built' },
    { url: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/dylan-2026/plan-hand-proposed.png/public', label: 'Proposed floor plan', type: 'proposed' },
  ];
  const { page, api, errors } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, { kid: { plans, beforeAfterPhotos: [] }, drawings: { 'plan-hand-existing.png': R.hand } });
  await openDylan(page, false);
  const tiles = () => page.$$eval('#kd-sec-plans .kd-plan', (lis) => lis.map((li) => ({ needs: li.classList.contains('is-needs'), chip: li.querySelector('.kd-plan__meta .kd-chip')?.textContent.trim() || '(none)', check: !!li.querySelector('.kd-plan__check') })));
  let t = await tiles();
  ok(t.every((x) => x.needs && x.chip === 'Check for the address' && x.check), `a hand-added as-built or proposed drawing asks for a look: ${t.map((x) => x.chip).join(' | ')}`);
  // Preview: nothing plays yet, and it says why
  await clickText(page, '#kd-sec-plans .kd-sec__actions .btn', 'Preview the stream');
  await page.waitForSelector('.rdp', { timeout: 10000 });
  await sleep(500);
  const pv = await page.$eval('.rdp', (d) => d.textContent.replace(/\s+/g, ' '));
  ok(/2 drawings are waiting for an address check/.test(pv) && /No design to show yet/.test(pv), 'Preview says 2 drawings wait for an address check, and there’s nothing to show yet');
  ok(!/within a second/.test(pv), 'no “within a second” promise');
  await clickText(page, '.rdp .kd-dialog__foot .btn', 'Done');
  await sleep(300);
  // No address on it
  await page.evaluate(() => [...document.querySelectorAll('#kd-sec-plans .kd-plan')[1].querySelectorAll('.kd-plan__check .btn')].find((b) => /No address on it/.test(b.textContent)).click());
  await sleep(200);
  t = await tiles();
  ok(t[1].chip === 'Checked: no address' && !t[1].needs, `“No address on it” is said as such: ${t[1].chip}`);
  // Arrow keys on the kind picker
  await page.focus('#kd-sec-plans .kd-plan:nth-child(2) .kd-plan__kind [aria-checked="true"]');
  await page.keyboard.press('ArrowRight');
  await sleep(150);
  const k = await page.$eval('#kd-sec-plans .kd-plan:nth-child(2) .kd-plan__kind', (g) => ({ on: g.querySelector('[aria-checked="true"]').textContent.trim(), focus: document.activeElement?.textContent.trim(), tabs: [...g.querySelectorAll('[role="radio"]')].map((b) => b.tabIndex).join() }));
  ok(k.on === 'Board' && k.focus === 'Board' && k.tabs === '-1,-1,0', `arrow keys move the kind, with one tab stop (${JSON.stringify(k)})`);
  await page.keyboard.press('ArrowLeft');
  await sleep(150);
  // Cover the first one
  await page.evaluate(() => [...document.querySelectorAll('#kd-sec-plans .kd-plan')[0].querySelectorAll('.kd-plan__check .btn')].find((b) => /Cover the address/.test(b.textContent)).click());
  await page.waitForSelector('.rdc .rdc-sheet img', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('.rdc .rdc-sheet img')?.complete && document.querySelector('.rdc .rdc-sheet img').naturalWidth > 0, { timeout: 10000 });
  const src = await page.$eval('.rdc .rdc-sheet img', (i) => i.src);
  const area = await redArea(page, src);
  ok(!!area, 'the Cover tool shows the drawing as it is, address and all');
  await coverArea(page, area);
  await clickText(page, '.rdc .rdc-foot .btn', 'Cover 1 area');
  await page.waitForFunction(() => !document.querySelector('.rdc') && !document.querySelector('.kd-tile__busy'), { timeout: 20000 });
  await sleep(300);
  t = await tiles();
  ok(t[0].chip === 'Address taken off' && !t[0].needs, `covered: ${t[0].chip}`);
  const up = await inspect(page, 0);
  ok(up.red === 0 && /notitle/.test((await page.evaluate(() => window.__uploads[0].name))), `the covered copy went up with no red, named -notitle (${up.red})`);
  // Preview now has the drawings: steps, held slides, portrait keeps the slide and fits the screen
  await clickText(page, '#kd-sec-plans .kd-sec__actions .btn', 'Preview the stream');
  await page.waitForSelector('.rdp', { timeout: 10000 });
  await clickText(page, '.rdp .rdp-steps .btn', 'Floor plan today');
  await sleep(300);
  ok(/slide=1/.test(await page.$eval('.rdp iframe', (f) => f.getAttribute('src'))), 'a step holds that slide (?slide=1, after the kid’s photo)');
  await clickText(page, '.rdp .seg [role="radio"]', 'Portrait');
  await sleep(400);
  const pf = await page.evaluate(() => { const f = document.querySelector('.rdp iframe'); const d = document.querySelector('.rdp').getBoundingClientRect(); return { src: f.getAttribute('src'), bottom: d.bottom, frameBottom: f.getBoundingClientRect().bottom }; });
  ok(/o=portrait&slide=1/.test(pf.src), `portrait keeps the slide (${pf.src})`);
  ok(pf.bottom <= 900 && pf.frameBottom <= 900, `the portrait screen fits at 1440×900 (dialog ends at ${Math.round(pf.bottom)})`);
  await shot(page, 'preview-portrait-steps-1440');
  await clickText(page, '.rdp .kd-dialog__foot .btn', 'Done');
  await sleep(200);
  await page.click('.kd-bar__save .kd-save'); await sleep(1000);
  const saved = api.st.saves.at(-1);
  ok(saved?.plans?.map((x) => `${x.type}:${x.addressCheck}`).join() === 'as-built:covered,proposed:checked', `saved: ${saved?.plans?.map((x) => `${x.type}:${x.addressCheck}`).join()}`);
  await shot(page, 'hand-added-1440');
  ok(real(errors).length === 0, `no console errors (${errors.join(' | ').slice(0, 200)})`);
  await page.close();
}

async function otherKids(browser) {
  console.log('\nA hidden kid, a revealed kid, a designer’s set (1440)');
  {
    const { page, errors } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, { kid: { publishStatus: 'draft' } });
    await openDylan(page, false);
    const note = await page.$eval('#kd-sec-plans .kd-design-when', (e) => e.textContent.replace(/\s+/g, ' ').trim());
    ok(/profile is hidden, so the design doesn’t show anywhere/.test(note), `a hidden profile says the design won’t show: “${note.slice(0, 90)}”`);
    ok(/show nowhere while Dylan’s profile is hidden/.test(await page.$eval('#kd-befores .kd-sec__sub', (e) => e.textContent)), 'Before photos says they show nowhere while the profile is hidden');
    ok(real(errors).length === 0, `no console errors (${errors.join(' | ').slice(0, 200)})`);
    await page.close();
  }
  {
    const { page, errors } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, { kid: { status: 'completed' } });
    await openDylan(page, false);
    ok(!(await page.$('.kd-design-when')), 'a revealed room has no reveal-screen note');
    await openImport(page, 5);
    ok(await page.$$eval('.rdi .rdi-grid--photos .is-on', (x) => x.length) === 0, 'a revealed room gets no before photos picked');
    ok(/Design chapter/.test(await page.$eval('.rdi .kd-dialog__sub', (e) => e.textContent)), 'its subtitle fits a revealed room');
    ok(real(errors).length === 0, `no console errors (${errors.join(' | ').slice(0, 200)})`);
    await page.close();
  }
  {
    const pdf = await setOf([
      { title: 'A0.0 COVER SHEET', lines: ['SCOPE OF WORK: CONVERT EXISTING BEDROOM INTO ACCESSIBLE THERAPY ROOM.', 'SHEET INDEX', 'A0.0 COVER SHEET', 'A1.0 EXISTING FLOOR PLAN', 'A2.0 PROPOSED FLOOR PLAN', 'E1.0 ELECTRICAL PLAN', 'A3.0 INTERIOR ELEVATIONS'], blockText: [{ s: '426 MOUNTAIN VIEW LN', x: 260 }] },
      { title: 'G0.1 GENERAL NOTES', lines: ['1. CONTRACTOR TO VERIFY ALL EXISTING CONDITIONS PRIOR TO START.'], blockText: [{ s: '426 MOUNTAIN VIEW LN', x: 260 }] },
      { title: 'A1.0 EXISTING FLOOR PLAN', rooms: ['BEDROOM', 'BATH'], blockText: [{ s: '426 MOUNTAIN VIEW LN', x: 260 }] },
      { title: 'A2.0 PROPOSED FLOOR PLAN', rooms: ['THERAPY', 'BATH'], blockText: [{ s: '426 MOUNTAIN VIEW LN', x: 260 }] },
      { title: 'E1.0 ELECTRICAL PLAN', rooms: ['THERAPY'], lines: ['NOTE: REMOVE EXISTING RECEPTACLES, SEE FLOOR PLAN'], blockText: [{ s: '426 MOUNTAIN VIEW LN', x: 260 }] },
      { title: 'A3.0 INTERIOR ELEVATIONS', lines: ['3D PERSPECTIVE - LOOKING NORTH'], blockText: [{ s: '426 MOUNTAIN VIEW LN', x: 260 }] },
    ]);
    const listing = listingWith([drawingFile('REAL', 'Marchena set.pdf', 'real.pdf')]);
    const { page, errors } = await open(browser, { width: 1440, height: 900, mobile: false }, { ...FILES, 'real.pdf': pdf }, { listing });
    await openDylan(page, false);
    await openImport(page, 6);
    const t = await tilesOf(page);
    ok(t.map((x) => (x.on ? 1 : 0)).join('') === '001100', `a designer’s set: only A1.0 and A2.0 picked (${t.map((x) => (x.on ? 1 : 0)).join('')})`);
    ok(t[2].kind === 'As-built' && t[3].kind === 'Proposed', `as-built and proposed (${t[2].kind}, ${t[3].kind})`);
    ok(t[2].label === 'Existing floor plan' && /^Existing floor plan Page 3/.test(t[2].name), `named by their titles: “${t[2].name}”, “${t[2].label}”`);
    await shot(page, 'designer-set-1440');
    ok(real(errors).length === 0, `no console errors (${errors.join(' | ').slice(0, 200)})`);
    await page.close();
  }
}

async function heicAndYear(browser) {
  console.log('\nHEIC, and a job that isn’t found (1440)');
  const listing = listingWith([drawingFile('HEICD', 'Board photo.HEIC', 'd.heic', ['Design'])], {
    befores: [{ id: 'HB', name: 'IMG_0001.HEIC', type: 'image/heic', url: cdn('b.heic'), thumb: null, big: null, tags: ['Before'], createdAt: '2026-07-01T16:00:00Z', size: 1 }],
  });
  const { page, api, errors } = await open(browser, { width: 1440, height: 900, mobile: false }, { 'd.heic': Buffer.from('....ftypheic....not really a photo'), 'b.heic': Buffer.from('....ftypheic....') }, { listing, kid: { year: 2024 } });
  await openDylan(page, false);
  await openImport(page);
  await page.waitForFunction(() => /Couldn’t open it/.test(document.querySelector('.rdi')?.textContent || ''), { timeout: 20000 }).catch(() => {});
  const err = await page.$eval('.rdi .rdi-empty', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  ok(/^Couldn’t open it\. This iPhone photo couldn’t be converted in this browser\.$/.test(err), `an iPhone picture that won't convert says so, once, with no Try again: “${err}”`);
  ok(!/\.\./.test(err), 'no double full stop');
  const ph = await page.$eval('.rdi .rdi-grid--photos li', (li) => ({ img: !!li.querySelector('img'), text: li.textContent.trim() }));
  ok(!ph.img && /iPhone photo/.test(ph.text), `an iPhone before photo with no JobTread picture shows its name, not a broken image (“${ph.text}”)`);
  await page.keyboard.press('Escape'); await sleep(300);
  api.st.noJob = true;
  await openImport(page);
  const nj = await page.$eval('.rdi .empty', (e) => e.textContent.replace(/\s+/g, ' '));
  ok(/“Dylan Lastname \(2024\)”/.test(nj) && /Add plans and Add before photos/.test(nj), `no job: the profile’s year, and where to add by hand: “${nj.slice(0, 160)}”`);
  ok(errors.filter((e) => !/heic|libheif|wasm/i.test(e)).length === 0, `no console errors (${errors.join(' | ').slice(0, 200)})`);
  await page.close();
}

// ── Photos → Before photos (Peter, Nov 12 2026: "they should go into photos, not the before and after section") ──
const BIMG = (n) => `https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/dylan-2026/before-${n}.jpg/public`;
// (The site has looked at each and found it fine: on the page)
const BEFORES8 = Array.from({ length: 8 }, (_, i) => ({ url: BIMG(i + 1), alt: 'Dylan’s room before the makeover', room: '', source: `jt:B${i + 1}`, looked: 'site' }));
const beforeKeys = (page) => page.$$eval('#kd-befores .kd-tile .kd-tile__open img', (imgs) => imgs.map((i) => (i.getAttribute('src').match(/before-(\d+)\.jpg/) || [])[1]).join(','));
const counts = (page) => page.evaluate(() => ({
  befores: document.querySelectorAll('#kd-befores .kd-tile').length,
  gallery: [...document.querySelectorAll('#kd-sec-photos .kd-tiles')].filter((u) => !u.closest('#kd-befores')).reduce((n, u) => n + u.querySelectorAll(':scope > .kd-tile').length, 0),
}));
const undoToast = (page) => page.evaluate(() => { const b = [...document.querySelectorAll('.toast-undo')].at(-1); b?.click(); return !!b; });

async function toastChecks(browser) {
  // Toasts are never on an open dialog where there's room off it; a tap on a toast's words closes it (never reaching
  // what's under it); numbers in a toast are the tiles' as they are now; a photo removed from the gallery isn't
  // picked again by Bring in; a refused Undo leaves focus somewhere
  const toastPlace = (page) => page.evaluate(() => {
    const overlay = [...document.querySelectorAll('.modal-overlay')].pop();
    const box = overlay && [...overlay.children].sort((a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight)[0];
    const d = box?.getBoundingClientRect();
    const foot = box?.querySelector('.kd-dialog__foot')?.getBoundingClientRect();
    const ts = [...document.querySelectorAll('.toast')].map((x) => x.getBoundingClientRect()).filter((r) => r.width > 0);
    const hits = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    // Any of the dialog's controls under a toast
    const under = box ? [...box.querySelectorAll('button, input, textarea, select, [role="switch"], a[href]')].filter((c) => { const r = c.getBoundingClientRect(); return r.width > 0 && ts.some((x) => hits(x, r)); }).map((c) => (c.textContent || c.getAttribute('aria-label') || c.tagName).trim().slice(0, 20)) : [];
    const r4 = (r) => r && [r.left, r.top, r.right, r.bottom].map(Math.round).join(',');
    return { n: ts.length, onDialog: ts.some((r) => hits(r, d)), onFoot: ts.some((r) => hits(r, foot)), under, dialog: !!d, at: `${innerWidth}x${innerHeight} d=${r4(d)} foot=${r4(foot)} t=${ts.map(r4).join('|')} box=${box?.className}` };
  });
  console.log('\nPhotos → Before photos: toasts off the dialog, their numbers, gallery removals, focus (1440)');
  {
    const kid4 = BEFORES8.slice(0, 4).map((p, i) => (i === 2 ? { ...p, offPage: true, offWhy: 'A person in it' } : p));
    const { page, errors } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, { kid: { beforePhotos: kid4 } });
    await openDylan(page, false);
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Select');
    await page.evaluate(() => { const t = document.querySelectorAll('#kd-befores .kd-tile__open'); t[0].click(); t[2].click(); });
    await clickText(page, '#kd-befores .kd-selectbar .btn', 'Move to the gallery');
    await sleep(250);
    const said = await page.$$eval('.toast', (t) => t.map((x) => x.textContent).join(' '));
    ok(/Before photo 2 is kept off the page, so it stayed in Before photos\./.test(said), `the one that stayed is named by its tile’s number now (${said.slice(0, 220)})`);
    const label = await page.$$eval('.toast-undo', (b) => b.at(-1)?.getAttribute('aria-label') || '');
    ok(/^Undo: Moved to the gallery/.test(label), `a toast’s Undo says what it undoes (${label.slice(0, 80)})`);
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Done selecting');
    await sleep(100);
    // A photo opened while the toast shows: the toast is off the dialog
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[0].click());
    await page.waitForSelector('.kd-photo-dlg');
    await sleep(250);
    let at = await toastPlace(page);
    ok(at.dialog && at.n === 1 && !at.onDialog, `at 1440 × 900 the toast is off the photo dialog (${JSON.stringify(at)})`);
    await shot(page, 'toast-off-dialog-1440');
    await page.setViewport({ width: 1440, height: 960 });
    await sleep(300);
    at = await toastPlace(page);
    ok(at.n === 1 && !at.onDialog, `and at 1440 × 960 (${JSON.stringify(at)})`);
    await page.setViewport({ width: 1536, height: 864 });
    await sleep(300);
    at = await toastPlace(page);
    ok(at.n === 1 && !at.onFoot && !at.under.length, `at 1536 × 864, never on its controls (${JSON.stringify(at)})`);
    for (const [w, h] of [[1280, 720], [1366, 768]]) {
      await page.setViewport({ width: w, height: h });
      await sleep(300);
      at = await toastPlace(page);
      ok(at.n === 1 && !at.under.length, `at ${w} × ${h}, none of the dialog’s controls is under it (${JSON.stringify(at)})`);
      if (w === 1280) await shot(page, 'toast-1280x720');
    }
    // A tap on its words closes it, and nothing else
    const before = await beforeKeys(page);
    await page.evaluate(() => { const t = document.querySelector('.toast'); const r = t.getBoundingClientRect(); const el = document.elementFromPoint(r.left + 24, r.top + r.height / 2); el.click(); });
    await sleep(200);
    at = await toastPlace(page);
    ok(at.n === 0 && at.dialog && await beforeKeys(page) === before, `a click on a toast’s words closes it, and nothing else (${JSON.stringify(at)})`);
    const regions = await page.$$eval('.toast-container .toast-region[aria-live]', (r) => r.map((x) => `${x.getAttribute('role')}/${x.getAttribute('aria-live')}/${x.getAttribute('aria-atomic')}`).join(' '));
    ok(regions === 'status/polite/false alert/assertive/false', `each new message is said once, alone; errors at once (${regions})`);
    // Typing in the dialog: a click on a toast's words keeps the field's focus; an Undo leaves focus in the dialog
    await page.setViewport({ width: 1280, height: 720 });
    await page.keyboard.press('Escape');
    await sleep(200);
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Select');
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[2].click());
    await clickText(page, '#kd-befores .kd-selectbar .btn', 'Keep off the page');
    await sleep(250);
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Done selecting');
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[0].click());
    await page.waitForSelector('.kd-photo-dlg');
    await sleep(400);
    const room = await page.$('.kd-photo-dlg input[placeholder^="e.g."]');
    await room.click();
    await page.keyboard.type('Ba');
    const tp = await page.$$eval('.toast', (xs) => { const x = xs.find((y) => y.getClientRects().length); const r = x.getBoundingClientRect(); return [r.left + 20, r.top + r.height / 2]; });
    await page.mouse.click(tp[0], tp[1]);
    await page.keyboard.type('th');
    const typed = await page.$eval('.kd-photo-dlg input[placeholder^="e.g."]', (i) => i.value);
    ok(typed === 'Bath', `a click on a toast’s words leaves the field being typed in as it was (${typed})`);
    await page.keyboard.press('Escape');
    await sleep(250);
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Select');
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[1].click());
    await clickText(page, '#kd-befores .kd-selectbar .btn', 'Keep off the page');
    await sleep(250);
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Done selecting');
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[0].click());
    await page.waitForSelector('.kd-photo-dlg');
    await sleep(400);
    await page.evaluate(() => [...document.querySelectorAll('.toast-undo')].at(-1)?.click());
    await sleep(400);
    const inDlg = await page.evaluate(() => !!document.activeElement?.closest('.kd-photo-dlg') || document.activeElement === document.body);
    ok(inDlg && !!(await page.$('.kd-photo-dlg')), 'an Undo pressed while a photo is open never sends focus behind the dialog');
    await page.setViewport({ width: 1440, height: 900 });
    await page.keyboard.press('Escape');
    await sleep(200);
    // The moved photo removed from the gallery: Bring in doesn't pick it again
    const g = await page.evaluate(() => [...document.querySelectorAll('#kd-sec-photos .kd-tile__open')].filter((b) => !b.closest('#kd-befores')).findIndex((b) => /before-1\.jpg/.test(b.querySelector('img')?.getAttribute('src') || '')));
    await page.evaluate((g) => [...document.querySelectorAll('#kd-sec-photos .kd-tile__open')].filter((b) => !b.closest('#kd-befores'))[g].click(), g);
    await page.waitForSelector('.kd-photo-dlg');
    await clickText(page, '.kd-photo-dlg .kd-dialog__foot .btn', 'Remove photo');
    await sleep(250);
    // ...and an older Undo refused by keyboard leaves focus on the page, not nowhere
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Select');
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[0].click());
    await clickText(page, '#kd-befores .kd-selectbar .btn', 'Keep off the page');
    await sleep(250);
    await page.evaluate(() => [...document.querySelectorAll('.toast-undo')].find((b) => /^Undo: Photo removed/.test(b.getAttribute('aria-label') || ''))?.focus());
    await page.keyboard.press('Enter');
    await sleep(400);
    const focus = await page.evaluate(() => ({ tag: document.activeElement?.tagName, said: [...document.querySelectorAll('.toast')].map((x) => x.textContent).join(' ') }));
    ok(/can’t be undone now/.test(focus.said) && focus.tag !== 'BODY', `a refused Undo leaves focus where it was before (${focus.tag})`);
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Done selecting');
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Bring in from JobTread');
    await page.waitForSelector('.rdi', { timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('.rdi .rdi-grid--photos > li').length > 0 && !/Getting|Opening…/.test(document.querySelector('.rdi')?.textContent || ''), { timeout: 30000 }).catch(() => {});
    await sleep(400);
    const b1 = await page.$$eval('.rdi .rdi-grid--photos > li', (l) => { const li = l[0]; return { on: li.classList.contains('is-on'), said: li.textContent.trim() }; });
    ok(!b1.on && /Removed earlier/.test(b1.said), `one removed from the gallery isn’t picked again, and says so (${JSON.stringify(b1)})`);
    await page.keyboard.press('Escape');
    await sleep(300);
    // A dialog an area puts higher than the toasts (Site Config's, the asks', 1200+): the toasts go above it
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Select');
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[1].click());
    await clickText(page, '#kd-befores .kd-selectbar .btn', 'Show on the page');
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Done selecting');
    await page.evaluate(() => { const o = document.createElement('div'); o.className = 'modal-overlay test-high'; o.style.zIndex = '1300'; o.innerHTML = '<div style="width:420px;height:300px;background:#fff"></div>'; document.body.appendChild(o); });
    await sleep(300);
    const z = await page.evaluate(() => { const c = document.querySelector('.toast-container'); const t = [...document.querySelectorAll('.toast')].find((x) => x.getClientRects().length); if (!t) return 'no toast'; const r = t.getBoundingClientRect(); const top = document.elementFromPoint(r.left + 10, r.top + r.height / 2); return `${getComputedStyle(c).zIndex} ${top?.closest('.toast') ? 'on top' : 'under'}`; });
    ok(/^1301 on top$/.test(z), `toasts rise above a dialog put higher than they are (${z})`);
    await page.evaluate(() => document.querySelector('.test-high')?.remove());
    await sleep(200);
    ok(await page.$eval('.toast-container', (c) => c.style.zIndex === ''), 'and settle back once it’s gone');
    ok(real(errors).length === 0, `no console errors (${errors.join(' | ').slice(0, 200)})`);
    await page.close();
  }
  for (const [width, height] of [[390, 844], [768, 1024]]) {
    console.log(`\nPhotos → Before photos: a toast and a dialog on a ${width} touch screen`);
    const { page, errors } = await open(browser, { width, height, mobile: true }, FILES, { kid: { beforePhotos: BEFORES8.slice(0, 4) } });
    await openDylan(page, true);
    await page.evaluate(() => document.querySelector('#kd-befores').scrollIntoView({ block: 'start' }));
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Select');
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[1].click());
    await clickText(page, '#kd-befores .kd-selectbar .btn', 'Keep off');
    await sleep(250);
    const spoken = await page.$$eval('#kd-befores .kd-selectbar .btn', (b) => b.map((x) => [x.textContent.trim(), x.getAttribute('aria-label') || x.textContent.trim()]));
    ok(spoken.every(([seen, name]) => name.toLowerCase().includes(seen.toLowerCase())), `each button’s spoken name has its words in it (${spoken.map((x) => x.join('=')).join(', ')})`);
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Done selecting');
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[0].click());
    await page.waitForSelector('.kd-photo-dlg');
    await sleep(300);
    let at = await toastPlace(page);
    ok(at.n === 1 && !at.onFoot, `the toast is never on the dialog’s buttons (${JSON.stringify(at)})`);
    await shot(page, `toast-on-dialog-${width}`);
    if (at.onDialog) {
      const before = await page.evaluate(() => { const s = [...document.querySelectorAll('.kd-photo-dlg, .kd-photo-dlg *')].find((n) => /(auto|scroll)/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 1); s?.setAttribute('data-scroller', ''); return s ? s.scrollTop : -1; });
      const tp = await page.$$eval('.toast', (xs) => { const x = xs.find((y) => y.getClientRects().length); const r = x.getBoundingClientRect(); return [r.left + 20, r.top + r.height / 2]; });
      await page.mouse.move(tp[0], tp[1]);
      await page.mouse.wheel({ deltaY: 200 });
      await sleep(300);
      const after = await page.$eval('[data-scroller]', (s) => s.scrollTop).catch(() => -1);
      ok(before >= 0 && after > before, `a wheel on a toast that’s on the dialog scrolls the dialog (${before} → ${after})`);
      await page.evaluate((y) => { const s = document.querySelector('[data-scroller]'); if (s) s.scrollTop = y; }, before);
    }
    const keys = await beforeKeys(page);
    const offBefore = await page.$$eval('#kd-befores .kd-tile', (t) => t.map((x) => x.classList.contains('is-off')).join());
    await page.evaluate(() => { const t = document.querySelector('.toast'); const r = t.getBoundingClientRect(); document.elementFromPoint(r.left + 16, r.top + r.height / 2).click(); });
    await sleep(250);
    at = await toastPlace(page);
    const offAfter = await page.$$eval('#kd-befores .kd-tile', (t) => t.map((x) => x.classList.contains('is-off')).join());
    ok(at.n === 0 && at.dialog && await beforeKeys(page) === keys && offAfter === offBefore, `a tap on the toast’s words closes it, and reaches nothing under it (${JSON.stringify(at)})`);
    ok(real(errors).length === 0, `no console errors (${errors.join(' | ').slice(0, 200)})`);
    await page.close();
  }
}

async function beforePhotosGroup(browser) {
  console.log('\nPhotos → Before photos (1440)');
  {
    const { page, api, errors } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, { kid: { beforePhotos: BEFORES8 } });
    await openDylan(page, false);
    const c0 = await counts(page);
    ok(c0.befores === 8 && c0.gallery > 0, `the group has its 8, the gallery its own (${JSON.stringify(c0)})`);
    // A before photo's dialog: no crops (the site never crops one), its room, on the reveal screen or not
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[6].click());
    await page.waitForSelector('.kd-photo-dlg', { timeout: 5000 });
    const dlg = await page.evaluate(() => ({
      title: document.querySelector('.kd-photo-dlg h2')?.textContent.trim(), sub: document.querySelector('.kd-photo-dlg .kd-dialog__sub')?.textContent.trim(),
      focal: !!document.querySelector('.kd-photo-dlg .kd-photo__focus, .kd-photo-dlg .kd-focus'), roles: [...document.querySelectorAll('.kd-photo-dlg .kd-role')].map((r) => `${r.querySelector('strong').textContent}:${r.getAttribute('aria-pressed')}`),
      place: document.querySelector('.kd-photo-dlg .kd-photo__move .form-label')?.textContent.trim(), room: !!document.querySelector('#kd-before-room'),
    }));
    ok(dlg.title === 'Photo 7 of 8' && /Not on the reveal screen: it plays the first 6/.test(dlg.sub), `the dialog says where it is: ${dlg.title} · ${dlg.sub}`);
    ok(!dlg.focal && dlg.room && dlg.place === 'Place in Before photos', `no focal point or crops; a room; its place (${JSON.stringify(dlg)})`);
    ok(dlg.roles.join() === 'On the page:true,On the reveal screen:false,Move to the gallery:null', `roles (Move to the gallery is an action, not a switch): ${dlg.roles.join()}`);
    await clickText(page, '.kd-photo-dlg .kd-role', 'On the reveal screen');
    await sleep(200);
    ok(/On the reveal screen, 6th of 6/.test(await page.$eval('.kd-photo-dlg .kd-dialog__sub', (e) => e.textContent)), 'turned on, it plays 6th; the 6th steps off');
    ok(await beforeKeys(page) === '1,2,3,4,5,7,6,8', `order: ${await beforeKeys(page)}`);
    await page.type('#kd-before-room', 'Bathroom');
    await clickText(page, '.kd-photo-dlg .kd-dialog__foot .btn', 'Done');
    await sleep(200);
    const slides = await page.evaluate(() => window.__soardRevealDesign?.().slides || []);
    const befores = slides.filter((s) => s.kind === 'before');
    ok(befores.length === 6 && /before-7\.jpg/.test(befores[5].url) && befores[5].caption === 'Bathroom' && befores[0].badge === 'Before', `the reveal screen plays the first 6, the 6th with its room (${befores.map((s) => (s.url.match(/before-(\d)/) || [])[1]).join(',')}; “${befores[5]?.caption}”)`);
    // First, from its dialog
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[7].click());
    await page.waitForSelector('.kd-photo-dlg');
    await clickText(page, '.kd-photo-dlg .kd-photo__move .btn', 'First');
    await sleep(150);
    ok(await beforeKeys(page) === '8,1,2,3,4,5,7,6', `First moves it to the front: ${await beforeKeys(page)}`);
    // Move to the gallery, then Undo
    await clickText(page, '.kd-photo-dlg .kd-role', 'Move to the gallery');
    await sleep(250);
    const c1 = await counts(page);
    ok(!(await page.$('.kd-photo-dlg')) && c1.befores === 7 && c1.gallery === c0.gallery + 1, `Move to the gallery: out of here, at the gallery's end (${JSON.stringify(c1)})`);
    ok(await page.evaluate((u) => [...document.querySelectorAll('#kd-sec-photos .kd-tiles')].filter((x) => !x.closest('#kd-befores')).flatMap((x) => [...x.querySelectorAll(':scope > .kd-tile img')]).at(-1)?.src.includes('before-8.jpg')), 'it is the gallery’s last photo');
    ok(await undoToast(page), 'Undo is offered');
    await sleep(200);
    ok(JSON.stringify(await counts(page)) === JSON.stringify(c0) && (await beforeKeys(page)).startsWith('8,'), 'Undo puts it back');
    // A gallery photo that's really a before photo
    const galleryLast = await page.evaluate(() => { const tiles = [...document.querySelectorAll('#kd-sec-photos .kd-tiles')].filter((x) => !x.closest('#kd-befores')).flatMap((x) => [...x.querySelectorAll(':scope > .kd-tile .kd-tile__open')]); tiles.at(-1).click(); return tiles.length; });
    await page.waitForSelector('.kd-photo-dlg');
    ok(await clickText(page, '.kd-photo-dlg .kd-role', 'A before photo'), 'a gallery photo can be marked a before photo');
    await sleep(250);
    const c2 = await counts(page);
    ok(c2.befores === 9 && c2.gallery === galleryLast - 1, `it moves to Before photos, at the end (${JSON.stringify(c2)})`);
    const accentGone = await page.evaluate(() => !!document.querySelector('.kd-feature__accent.is-empty'));
    ok(accentGone, 'the accent photo (it was the last) is cleared, not left pointing at a before photo');
    ok(await undoToast(page), 'Undo is offered');
    await sleep(200);
    ok(JSON.stringify(await counts(page)) === JSON.stringify(c0) && !(await page.$('.kd-feature__accent.is-empty')), 'Undo puts it back, accent and all');
    // Select: remove two, Undo; move two to the front
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Select');
    await sleep(100);
    await page.evaluate(() => { const t = document.querySelectorAll('#kd-befores .kd-tile__open'); t[2].click(); t[3].click(); });
    await sleep(100);
    ok(/2 selected/.test(await page.$eval('#kd-befores .kd-selectbar', (b) => b.textContent)), 'two selected');
    await clickText(page, '#kd-befores .kd-selectbar .btn', 'Remove');
    await sleep(250);
    ok((await counts(page)).befores === 6, 'two removed');
    ok(/2 before photos removed\. JobTread keeps their copies, and the site won’t bring them in again on its own/.test(await page.$$eval('.toast', (t) => t.map((x) => x.textContent).join(' '))), 'the toast says JobTread keeps them and they won’t come back');
    await undoToast(page);
    await sleep(200);
    ok((await counts(page)).befores === 8, 'Undo brings them back');
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Select');
    await sleep(100);
    await page.evaluate(() => { const t = document.querySelectorAll('#kd-befores .kd-tile__open'); t[6].click(); t[7].click(); });
    await clickText(page, '#kd-befores .kd-selectbar .btn', 'Move to the front');
    await sleep(150);
    ok(await beforeKeys(page) === '7,6,8,1,2,3,4,5', `Move to the front: ${await beforeKeys(page)}`);
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Done selecting');
    // Files dropped on the group go up as before photos, never into the gallery
    await page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 40; c.height = 30;
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'old-room.png', { type: 'image/png' }));
      const el = document.querySelector('#kd-befores');
      el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => document.querySelectorAll('#kd-befores .kd-tile').length === 9 && !document.querySelector('#kd-befores .kd-tile__busy'), { timeout: 15000 }).catch(() => {});
    const c3 = await counts(page);
    ok(c3.befores === 9 && c3.gallery === c0.gallery, `a dropped file goes up as a before photo, not into the gallery (${JSON.stringify(c3)})`);
    // A pair's before comes from Before photos; its after from the gallery
    await clickText(page, '#kd-sec-transform .kd-sec__actions .btn', 'Add a pair');
    await sleep(150);
    const sides = await page.$$eval('#kd-sec-transform .kd-pair .kd-pair__side', (s) => s.map((x) => [...x.querySelectorAll('.btn')].map((b) => b.textContent.trim()).join('/')));
    ok(sides[0] === 'From the before photos' && sides[1] === 'From the gallery', `a new pair: ${sides.join(' | ')}`);
    await clickText(page, '#kd-sec-transform .kd-pair__side .btn', 'From the before photos');
    await page.waitForSelector('.kd-pick');
    ok(await page.$$eval('.kd-pick li', (l) => l.length) === 9, 'the picker shows the before photos');
    await page.evaluate(() => [...document.querySelectorAll('.kd-pick__btn')].find((b) => b.querySelector('img').src.includes('before-7.jpg')).click());
    await sleep(200);
    ok(await page.$eval('#kd-sec-transform .kd-pair__room', (i) => i.value) === 'Bathroom', 'the pair takes the before photo’s room');
    // Save
    await page.click('.kd-bar__save .kd-save');
    await sleep(1200);
    const saved = api.st.saves.at(-1);
    ok(saved && saved.beforePhotos.length === 9 && saved.beforePhotos.every((p) => p.url && !/^blob:/.test(p.url) && !('_key' in p) && !('_tempId' in p) && 'room' in p), `Save keeps them, clean: ${JSON.stringify(saved?.beforePhotos?.[0])}`);
    ok(saved && saved.beforePhotos[0].url === BIMG(7) && saved.beforePhotos[0].room === 'Bathroom' && saved.beforePhotos.at(-1).alt === 'Dylan’s room before the makeover', 'in the order shown, room and alt kept; a dropped one gets the room-before alt');
    ok(saved && saved.beforePhotos[0].looked === 'site' && saved.beforePhotos.at(-1).looked === 'staff' && !('offPage' in saved.beforePhotos.at(-1)), `who looked is kept, and one staff dropped in is theirs, on the page (${JSON.stringify(saved?.beforePhotos?.at(-1))})`);
    ok(saved && saved.photos.length === c0.gallery, `the gallery saved as it was (${saved?.photos?.length})`);
    ok(saved && saved.beforeAfterPhotos.length === 1 && saved.beforeAfterPhotos[0].before === BIMG(7) && saved.beforeAfterPhotos[0].after === '', 'the pair, waiting for its after');
    await shot(page, 'before-photos-1440');
    const el = await page.$('#kd-befores');
    await el?.screenshot({ path: join(OUT, 'before-photos-group-1440.png') }).catch(() => {});
    ok(real(errors).length === 0, `no console errors (${errors.join(' | ').slice(0, 200)})`);
    await page.close();
  }
  console.log('\nPhotos → Before photos: on the page or kept off (1440)');
  {
    // 1, 3, 4, 6, 8 on the page; 2 kept off by the site's check; 5 not checked yet; 7 kept off by staff
    const mix = BEFORES8.map((p, i) => (i === 1 ? { ...p, offPage: true, offWhy: 'A person in it' } : i === 4 ? { ...p, looked: undefined } : i === 6 ? { ...p, looked: 'staff', offPage: true } : p));
    // A pair takes its before from the one the site kept off
    const { page, api, errors } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, { kid: { beforePhotos: mix, beforeAfterPhotos: [{ before: BIMG(2), after: BIMG(9), room: 'Bedroom', beforeAlt: '', afterAlt: '' }] } });
    await openDylan(page, false);
    const tiles = await page.$$eval('#kd-befores .kd-tile', (lis) => lis.map((li) => ({ off: li.classList.contains('is-off'), chip: li.querySelector('.kd-tile__role')?.textContent.trim() || '', title: li.querySelector('.kd-tile__role')?.getAttribute('title') || '', label: li.querySelector('.kd-tile__open').getAttribute('aria-label') })));
    ok(tiles.map((t) => (t.off ? t.chip : 'on')).join() === 'on,Kept off,on,on,Not checked,on,Kept off,on', `tiles say which are off the page: ${tiles.map((t) => (t.off ? t.chip : 'on')).join()}`);
    ok(tiles[1].title === 'A person in it' && /kept off the page/.test(tiles[1].label) && /not checked yet/.test(tiles[4].label), `and why, to a mouse and a screen reader (${tiles[1].title}; ${tiles[4].label})`);
    const state = await page.$eval('#kd-befores .kd-befores__state', (e) => e.textContent.trim()).catch(() => '');
    ok(/^5 on the page, 2 kept off, 1 not checked yet\. Kept off: a person in it, by staff\. The site checks each photo from JobTread before it can show; open one to switch it on or off\.$/.test(state), `the group says where they stand: “${state}”`);
    const zones = await page.$$eval('#kd-befores .kd-zone', (z) => z.map((x) => x.textContent.trim()));
    ok(zones.join() === 'On the reveal screen', `five on the page, so all of them play and there's no second zone: ${zones.join(' | ')}`);
    await (await page.$('#kd-befores'))?.screenshot({ path: join(OUT, 'before-photos-on-page-1440.png') }).catch(() => {});
    let slides = (await page.evaluate(() => window.__soardRevealDesign?.().slides || [])).filter((x) => x.kind === 'before').map((x) => x.url.match(/before-(\d)/)[1]);
    ok(slides.join() === '1,3,4,6,8', `the reveal screen plays only the ones on the page: ${slides.join()}`);
    const pairHint = await page.$eval('#kd-sec-transform .kd-pair .kd-warn-text', (e) => e.textContent.trim()).catch(() => '');
    ok(/^Its before is kept off the page in Before photos \(a person in it\), so this pair doesn’t show\. Switch it on there, or pick another\.$/.test(pairHint) && !(await page.$('#kd-sec-transform .kd-pair__preview')), `a pair whose before is kept off says it doesn’t show: “${pairHint}”`);
    // Select: Move to the gallery leaves one kept off where it is, and says why
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Select');
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[6].click());
    ok(await page.$eval('#kd-befores .kd-tile__open', (b) => b.getAttribute('aria-label').startsWith('Select before photo 1')), 'in Select, each says Select, and aria-pressed says whether');
    await clickText(page, '#kd-befores .kd-selectbar .btn', 'Move to the gallery');
    await sleep(200);
    ok((await counts(page)).befores === 8 && /Before photo 7 is kept off the page, so it stays here\. Switch it on first to show it in the gallery\./.test(await page.$$eval('.toast', (t) => t.map((x) => x.textContent).join(' '))), 'one kept off stays out of the gallery, and the toast says how');
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Done selecting');
    await sleep(100);
    // The site's own: its dialog says why, and switching it on is staff's say
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[1].click());
    await page.waitForSelector('.kd-photo-dlg');
    const d2 = await page.evaluate(() => ({ sub: document.querySelector('.kd-photo-dlg .kd-dialog__sub').textContent.trim(), roles: [...document.querySelectorAll('.kd-photo-dlg .kd-role')].map((r) => `${r.querySelector('strong').textContent}:${r.getAttribute('aria-pressed')}:${r.querySelector('small').textContent}`) }));
    ok(/Not on the reveal screen: kept off the page by the site’s check \(a person in it\)/.test(d2.sub), `its dialog says so: “${d2.sub}”`);
    ok(/^On the page:false:The site kept it off: a person in it\. Turn on if it’s fine to show\. A Before & after pair uses it, so the pair is on or off the page with it\.$/.test(d2.roles[0]) && d2.roles.length === 1, `its switch, and no Move to the gallery while it’s kept off: ${d2.roles.join(' | ')}`);
    await sleep(500);
    await shot(page, 'before-photo-kept-off-dialog-1440');
    await clickText(page, '.kd-photo-dlg .kd-role', 'On the page');
    await sleep(200);
    const on = await page.$eval('.kd-photo-dlg .kd-role', (r) => [r.getAttribute('aria-pressed'), r.querySelector('small').textContent]);
    ok(on[0] === 'true' && /^Shows in the Before section of the page, and can play on the reveal screen\. Turn off to keep it off\. A Before & after pair uses it/.test(on[1]), `switched on: ${on.join(' · ')}`);
    ok(/On the reveal screen, 2nd of 6/.test(await page.$eval('.kd-photo-dlg .kd-dialog__sub', (e) => e.textContent)), 'it plays now, 2nd of the six');
    // Six on the page now: the one not checked yet, opened, offers no reveal-screen switch, only its own
    await page.click('.kd-photo-dlg .kd-photo__nav.is-next'); await sleep(100);
    await page.click('.kd-photo-dlg .kd-photo__nav.is-next'); await sleep(100);
    await page.click('.kd-photo-dlg .kd-photo__nav.is-next'); await sleep(150);
    const d5 = await page.evaluate(() => ({ sub: document.querySelector('.kd-photo-dlg .kd-dialog__sub').textContent.trim(), roles: [...document.querySelectorAll('.kd-photo-dlg .kd-role strong')].map((r) => r.textContent), small: document.querySelector('.kd-photo-dlg .kd-role small').textContent }));
    ok(/Not on the reveal screen: not checked yet/.test(d5.sub) && d5.roles.join() === 'On the page' && /^Not checked yet: the site looks at each before photo from JobTread within minutes of saving, and it shows nowhere until then\. Turn on to show it now\.$/.test(d5.small), `one not checked yet: ${d5.sub} · ${d5.small}`);
    await page.keyboard.press('Escape');
    await sleep(250);
    slides = (await page.evaluate(() => window.__soardRevealDesign?.().slides || [])).filter((x) => x.kind === 'before').map((x) => x.url.match(/before-(\d)/)[1]);
    ok(slides.join() === '1,2,3,4,6,8', `the reveal screen follows: ${slides.join()}`);
    // Seven on the page (8 too): the zone for the rest starts after the sixth, past the ones kept off
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Select');
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[4].click());
    await clickText(page, '#kd-befores .kd-selectbar .btn', 'Show on the page');
    await sleep(200);
    const z2 = await page.$$eval('#kd-befores .kd-tiles > li', (lis) => lis.map((li) => (li.classList.contains('kd-zone') ? `[${li.textContent.trim()}]` : li.querySelector('img').getAttribute('src').match(/before-(\d)/)[1])).join(' '));
    ok(z2 === '[On the reveal screen] 1 2 3 4 5 6 [Not on the reveal screen] 7 8', `zones by the six on the page: ${z2}`);
    ok(/On the page\. It shows once saved and published\./.test(await page.$$eval('.toast', (t) => t.map((x) => x.textContent).join(' '))), 'the toast says so, of one');
    // Keep two off from the select bar, then Undo
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Select');
    await page.evaluate(() => { const t = document.querySelectorAll('#kd-befores .kd-tile__open'); t[2].click(); t[3].click(); });
    await clickText(page, '#kd-befores .kd-selectbar .btn', 'Keep off the page');
    await sleep(200);
    ok((await page.$$eval('#kd-befores .kd-tile', (l) => l.map((li) => li.classList.contains('is-off')))).join() === 'false,false,true,true,false,false,true,false', 'two kept off');
    ok(/2 before photos kept off the page\. They show nowhere once saved and published\./.test(await page.$$eval('.toast', (t) => t.map((x) => x.textContent).join(' '))), 'the toast says so, with Undo');
    await undoToast(page);
    await sleep(200);
    ok((await page.$$eval('#kd-befores .kd-tile', (l) => l.map((li) => li.classList.contains('is-off')))).join() === 'false,false,false,false,false,false,true,false', 'Undo puts them back on, as they were');
    // Two switches of the same photo, their Undos clicked oldest first: it ends as it began
    const st8 = () => page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile')[7].classList.contains('is-off'));
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Select');
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[7].click());
    await clickText(page, '#kd-befores .kd-selectbar .btn', 'Keep off the page');
    await sleep(150);
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Select');
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[7].click());
    await clickText(page, '#kd-befores .kd-selectbar .btn', 'Show on the page');
    await sleep(150);
    // Newest first, then the older: as it began
    await page.evaluate(() => { const u = [...document.querySelectorAll('.toast-undo')]; u.at(-1)?.click(); });
    await sleep(150);
    await page.evaluate(() => { const u = [...document.querySelectorAll('.toast-undo')]; u.at(-1)?.click(); });
    await sleep(200);
    ok(!(await st8()), 'Undos newest first end where it began: on the page, the site’s');
    // A pair's before only from the ones on the page: one kept off would show through the pair
    await clickText(page, '#kd-sec-transform .kd-sec__actions .btn', 'Add a pair');
    await sleep(150);
    await clickText(page, '#kd-sec-transform .kd-pair__side .btn', 'From the before photos');
    await page.waitForSelector('.kd-pick');
    const picks = await page.$$eval('.kd-pick__btn img', (l) => l.map((i) => i.src.match(/before-(\d)/)[1]).join());
    ok(picks === '1,2,3,4,5,6,8', `the pair's picker leaves out the one kept off: ${picks}`);
    await page.keyboard.press('Escape');
    await sleep(200);
    // Saved as staff's say: on, kept off, with no leftover reason
    await page.click('.kd-bar__save .kd-save');
    await sleep(1200);
    const saved = api.st.saves.at(-1);
    const facts = saved?.beforePhotos.map((p) => [p.looked || '-', p.offPage ? 'off' : 'on', p.offWhy || ''].join('/')).join(' ');
    ok(facts === 'site/on/ staff/on/ site/on/ site/on/ staff/on/ site/on/ staff/off/ site/on/', `saved: ${facts}`);
    ok(real(errors).length === 0, `no console errors (${errors.join(' | ').slice(0, 200)})`);
    await page.close();
  }
  console.log('\nPhotos → Before photos: the site’s check lands while the editor is open (1440)');
  {
    const four = BEFORES8.slice(0, 4).map(({ looked, ...p }) => p);
    const { page, api, errors } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, { kid: { beforePhotos: four }, strict: true });
    await openDylan(page, false);
    ok((await page.$$eval('#kd-befores .kd-tile__role', (c) => c.map((x) => x.textContent.trim()))).join() === Array(4).fill('Not checked').join(), 'four waiting for the site’s check');
    const slug = Object.keys(api.st.kids).find((k) => /dylan/.test(k));
    const looks = (k, set) => ({ ...k, beforePhotos: k.beforePhotos.map((p, i) => (set[i] ? { ...p, ...set[i] } : p)) });
    // The site looks at 1 (fine) and 2 (a person in it): the open editor takes it in, with no Reload, nothing unsaved
    api.st.kids[slug] = looks(api.st.kids[slug], { 0: { looked: 'site' }, 1: { looked: 'site', offPage: true, offWhy: 'A person in it' } });
    api.st.shaOf = { [slug]: 'sha-site-1' };
    await page.waitForFunction(() => document.querySelectorAll('#kd-befores .kd-tile__role').length === 3, { timeout: 20000 }).catch(() => {});
    const chips = await page.$$eval('#kd-befores .kd-tile', (l) => l.map((li) => li.querySelector('.kd-tile__role')?.textContent.trim() || 'on').join());
    ok(chips === 'on,Kept off,Not checked,Not checked', `the site’s answers come into the open editor: ${chips}`);
    ok(await page.$eval('.kd-bar__state', (e) => e.classList.contains('is-saved')).catch(() => false), 'and nothing shows as unsaved');
    // Staff type a room; then a new photo appears on the server (someone else's change): Save says so, as ever
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[0].click());
    await page.waitForSelector('#kd-before-room');
    await page.type('#kd-before-room', 'Hall');
    await clickText(page, '.kd-photo-dlg .kd-dialog__foot .btn', 'Done');
    await sleep(200);
    const k1 = api.st.kids[slug];
    api.st.kids[slug] = { ...k1, beforePhotos: [...k1.beforePhotos, { url: BIMG(5), alt: '', room: '', source: 'jt:B5', looked: 'site' }] };
    api.st.shaOf = { [slug]: 'sha-other-2' };
    const savesBefore = api.st.saves.length;
    await page.click('.kd-bar__save .kd-save');
    await sleep(1500);
    ok(api.st.saves.length === savesBefore && /Someone saved this profile after you opened it/.test(await page.$$eval('.toast', (t) => t.map((x) => x.textContent).join(' '))), 'a photo the editor never had is someone else’s change: Reload, as ever');
    // ...and so is a change to one already looked at (the site never changes those)
    api.st.kids[slug] = looks(k1, { 0: { looked: 'staff', offPage: true } });
    api.st.shaOf = { [slug]: 'sha-other-3' };
    await page.click('.kd-bar__save .kd-save');
    await sleep(1500);
    ok(api.st.saves.length === savesBefore, 'a change to a photo already looked at is someone else’s too');
    // ...and a colleague's say on one still waiting here is never taken for the site's
    api.st.kids[slug] = looks(k1, { 2: { looked: 'staff', offPage: true } });
    api.st.shaOf = { [slug]: 'sha-other-3b' };
    await page.click('.kd-bar__save .kd-save');
    await sleep(1500);
    ok(api.st.saves.length === savesBefore, 'a colleague’s Keep off on a waiting photo is someone else’s save, not the site’s');
    // Only the site's answers on the two still waiting here: Save takes them in and saves them with the room typed
    api.st.kids[slug] = looks(k1, { 2: { looked: 'site', offPage: true, offWhy: 'Boxes or deliveries' }, 3: { looked: 'site' } });
    api.st.shaOf = { [slug]: 'sha-site-4' };
    await page.click('.kd-bar__save .kd-save');
    await sleep(1500);
    const s2 = api.st.saves.length > savesBefore ? api.st.saves.at(-1) : null;
    const facts = s2 ? s2.beforePhotos.map((p) => `${p.room || '-'}/${p.looked || '-'}/${p.offPage ? `off:${p.offWhy}` : 'on'}`).join(' ') : '(not saved)';
    ok(facts === 'Hall/site/on -/site/off:A person in it -/site/off:Boxes or deliveries -/site/on', `turned away only for the site’s answers: taken in and saved with the room typed: ${facts}`);
    ok(real(errors).length === 0, `no console errors (${errors.join(' | ').slice(0, 200)})`);
    await page.close();
  }
  console.log('\nPhotos → Before photos: a kept-off photo a pair uses, removed; a draft restored over a colleague’s say (1440)');
  {
    const pairKid = { beforePhotos: [{ ...BEFORES8[0] }, { ...BEFORES8[1], offPage: true, offWhy: 'A person in it' }], beforeAfterPhotos: [{ before: BIMG(2), after: BIMG(9), room: 'Bath', beforeAlt: 'b', afterAlt: '' }], status: 'completed' };
    const { page, api, errors } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, { kid: pairKid, strict: true });
    await openDylan(page, false);
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Select');
    await page.evaluate(() => { const t = document.querySelectorAll('#kd-befores .kd-tile__open'); t[0].click(); t[1].click(); });
    await clickText(page, '#kd-befores .kd-selectbar .btn', 'Remove');
    await sleep(250);
    const toast = await page.$$eval('.toast', (t) => t.map((x) => x.textContent).join(' '));
    ok((await counts(page)).befores === 1 && /Before photo 1 stayed: a Before & after pair uses it\. Change the pair’s before first\./.test(toast), `a photo a pair uses isn’t removed (it holds the pair), and the toast says why (${toast.slice(0, 200)})`);
    ok(/kept off the page in Before photos \(a person in it\)/.test(await page.$eval('#kd-sec-transform .kd-pair .kd-warn-text', (e) => e.textContent).catch(() => '')), 'the pair is as it was, still held off');
    await page.click('.kd-bar__save .kd-save');
    await sleep(1200);
    const saved = api.st.saves.at(-1);
    ok(saved && saved.beforeAfterPhotos.length === 1 && saved.beforeAfterPhotos[0].before === BIMG(2) && saved.beforeAfterPhotos[0].room === 'Bath' && saved.beforePhotos.length === 1, `saved: the pair whole, the kept-off photo still there to hold it (${JSON.stringify(saved?.beforeAfterPhotos)})`);
    await page.close();
  }
  {
    // A kept a draft over a version where a colleague since kept photo 1 off: Restore keeps the colleague’s say
    const two = [{ ...BEFORES8[0] }, { ...BEFORES8[1] }];
    const { page, api, errors } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, { kid: { beforePhotos: two }, strict: true });
    await openDylan(page, false);
    const slug = Object.keys(api.st.kids).find((k) => /dylan/.test(k));
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[0].click());
    await page.waitForSelector('#kd-before-room');
    await page.type('#kd-before-room', 'Hall');
    await clickText(page, '.kd-photo-dlg .kd-dialog__foot .btn', 'Done');
    await sleep(200);
    const k = api.st.kids[slug];
    // (and the site brought in another before photo and a drawing from JobTread meanwhile)
    api.st.kids[slug] = { ...k, name: `${k.name}`, quote: 'A colleague’s edit', beforePhotos: [...k.beforePhotos.map((p, i) => (i === 0 ? { ...p, looked: 'staff', offPage: true } : p)), { url: BIMG(9), alt: '', room: '', source: 'jt:B9' }],
      plans: [...(k.plans || []), { url: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/dylan-2026/plan-1-abc-existing-notitle.png/public', label: 'Existing floor plan', type: 'as-built', source: 'jt:SET#2', addressCheck: 'wiped' }] };
    api.st.shaOf = { [slug]: 'sha-colleague' };
    await page.click('.kd-bar__save .kd-save');
    await sleep(1500);
    ok(/Someone saved this profile after you opened it/.test(await page.$$eval('.toast', (t) => t.map((x) => x.textContent).join(' '))), 'a colleague’s save: Reload, with the changes kept to restore');
    await page.evaluate(() => [...document.querySelectorAll('.toast button')].find((b) => /Reload/.test(b.textContent))?.click());
    await sleep(1200);
    ok(await clickText(page, 'button', 'Restore'), 'the kept changes are offered back');
    await sleep(300);
    const tiles = await page.$$eval('#kd-befores .kd-tile', (l) => l.map((li) => li.querySelector('.kd-tile__role')?.textContent.trim() || 'on').join());
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[0].click());
    await page.waitForSelector('#kd-before-room');
    const room = await page.$eval('#kd-before-room', (i) => i.value);
    ok(/^Kept off,on,/.test(tiles) && tiles.split(',').length === 3 && room === 'Hall', `restored: the room typed, the colleague’s Keep off stands over the site’s older On, and the photo the site brought in since is kept (${tiles}; ${room})`);
    await clickText(page, '.kd-photo-dlg .kd-dialog__foot .btn', 'Done');
    await sleep(200);
    await page.click('.kd-bar__save .kd-save');
    await sleep(1500);
    const kept = api.st.saves.at(-1);
    ok(kept && kept.beforePhotos.some((p) => p.source === 'jt:B9') && (kept.plans || []).some((p) => p.source === 'jt:SET#2'), `saved with the site’s new before photo and drawing kept (${kept ? kept.beforePhotos.map((p) => p.source || '-').join(',') : 'not saved'})`);
    ok(real(errors).length === 0, `no console errors (${errors.join(' | ').slice(0, 200)})`);
    await page.close();
  }
  console.log('\nPhotos → Before photos: races and round trips (1440)');
  {
    // A slow save turned away for the site's answers, while the editor's own look takes them in: it saves again
    const two = BEFORES8.slice(0, 2).map(({ looked, ...p }) => p);
    for (const [name, opts] of [['a slow save', { saveDelay: 3000 }], ['a slow read', { readDelay: 2500 }]]) {
      const { page, api, errors } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, { kid: { beforePhotos: two }, strict: true, ...opts });
      await openDylan(page, false);
      const slug = Object.keys(api.st.kids).find((k) => /dylan/.test(k));
      const k = api.st.kids[slug];
      api.st.kids[slug] = { ...k, beforePhotos: k.beforePhotos.map((p) => ({ ...p, looked: 'site' })) };
      await page.waitForSelector('#kd-befores .kd-tile__open', { timeout: 15000 });
      api.st.shaOf = { [slug]: 'sha-site-1' };
      await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[0].click());
      await page.waitForSelector('#kd-before-room');
      await page.type('#kd-before-room', 'Den');
      await clickText(page, '.kd-photo-dlg .kd-dialog__foot .btn', 'Done');
      if (opts.readDelay) await sleep(4600); // (the editor's look is on its way)
      const n = api.st.saves.length;
      await page.click('.kd-bar__save .kd-save');
      await page.waitForFunction((m) => document.querySelector('.kd-bar__state')?.classList.contains('is-saved'), { timeout: 20000 }, n).catch(() => {});
      await sleep(500);
      const saved = api.st.saves.length > n ? api.st.saves.at(-1) : null;
      const toasts = await page.$$eval('.toast', (t) => t.map((x) => x.textContent).join(' '));
      ok(saved && saved.beforePhotos[0].room === 'Den' && saved.beforePhotos.every((p) => p.looked === 'site') && !/Someone saved/.test(toasts), `${name} crossing the site’s answers saves, with them and the room (${saved ? saved.beforePhotos.map((p) => `${p.room || '-'}/${p.looked}`).join(' ') : 'not saved'}; ${toasts.slice(0, 80)})`);
      await page.close();
    }
  }
  {
    // Before → gallery → back to Before photos, then Undo the first move: never two of it
    const { page, api } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, { kid: { beforePhotos: BEFORES8.slice(0, 3) } });
    await openDylan(page, false);
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[0].click());
    await page.waitForSelector('.kd-photo-dlg');
    await clickText(page, '.kd-photo-dlg .kd-role', 'Move to the gallery');
    await sleep(250);
    await page.evaluate(() => { const tiles = [...document.querySelectorAll('#kd-sec-photos .kd-tiles')].filter((x) => !x.closest('#kd-befores')).flatMap((x) => [...x.querySelectorAll(':scope > .kd-tile .kd-tile__open')]); tiles.at(-1).click(); });
    await page.waitForSelector('.kd-photo-dlg');
    await clickText(page, '.kd-photo-dlg .kd-role', 'A before photo');
    await sleep(250);
    await page.evaluate(() => { const u = [...document.querySelectorAll('.toast-undo')]; u[0]?.click(); });
    await sleep(250);
    const keys = await beforeKeys(page);
    ok(keys.split(',').filter((k) => k === '1').length === 1, `a round trip and an Undo leave one of it: ${keys}`);
    await page.close();
  }
  {
    // Keep a waiting photo off, the site's answer lands, Undo: back to the site's answer, not to waiting
    const { page, api } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, { kid: { beforePhotos: BEFORES8.slice(0, 2).map(({ looked, ...p }) => p) }, strict: true });
    await openDylan(page, false);
    const slug = Object.keys(api.st.kids).find((k) => /dylan/.test(k));
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Select');
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[0].click());
    await clickText(page, '#kd-befores .kd-selectbar .btn', 'Keep off the page');
    const k = api.st.kids[slug];
    api.st.kids[slug] = { ...k, beforePhotos: k.beforePhotos.map((p) => ({ ...p, looked: 'site' })) };
    api.st.shaOf = { [slug]: 'sha-site-1' };
    await page.waitForFunction(() => [...document.querySelectorAll('#kd-befores .kd-tile')][1] && !document.querySelectorAll('#kd-befores .kd-tile')[1].classList.contains('is-off'), { timeout: 20000 }).catch(() => {});
    await page.evaluate(() => [...document.querySelectorAll('.toast-undo')].at(-1)?.click());
    await sleep(250);
    const chips = await page.$$eval('#kd-befores .kd-tile', (l) => l.map((li) => li.querySelector('.kd-tile__role')?.textContent.trim() || 'on').join());
    ok(chips === 'on,on', `Undo after the site’s answer landed goes back to the site’s answer: ${chips}`);
    await page.close();
  }
  {
    // Keep 1 and 2 off, remove 2, show 3; the oldest Undo first is refused; newest first, all as they began
    const { page } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, { kid: { beforePhotos: BEFORES8.slice(0, 3).map((p, i) => (i === 2 ? { ...p, offPage: true, offWhy: 'A person in it' } : p)) } });
    await openDylan(page, false);
    const sel = async (idx, btn) => {
      await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Select');
      await page.evaluate((ix) => { const t = document.querySelectorAll('#kd-befores .kd-tile__open'); ix.forEach((i) => t[i].click()); }, idx);
      await clickText(page, '#kd-befores .kd-selectbar .btn', btn);
      await sleep(150);
    };
    await sel([0, 1], 'Keep off the page');
    await sel([1], 'Remove');
    await sel([1], 'Show on the page');
    for (let i = 0; i < 3; i++) { await page.evaluate(() => [...document.querySelectorAll('.toast-undo')].at(-1)?.click()); await sleep(200); }
    const st = await page.$$eval('#kd-befores .kd-tile', (l) => l.map((li) => `${li.querySelector('img').getAttribute('src').match(/before-(\d)/)[1]}:${li.querySelector('.kd-tile__role')?.textContent.trim() || 'on'}`).join());
    ok(st === '1:on,2:on,3:Kept off', `Undos newest first, through a Remove, end as it began: ${st}`);
    await page.close();
  }
  {
    // Remove the pair using a kept-off photo, then the photo (now allowed), then Undo the pair: back without that before
    const kid = { beforePhotos: [{ ...BEFORES8[0] }, { ...BEFORES8[1], offPage: true, offWhy: 'A person in it' }], beforeAfterPhotos: [{ before: BIMG(2), after: BIMG(9), room: 'Bath', beforeAlt: 'b', afterAlt: '' }, { before: BIMG(1), after: BIMG(8), room: 'Hall', beforeAlt: '', afterAlt: '' }], status: 'completed' };
    const { page } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, { kid });
    await openDylan(page, false);
    await page.evaluate(() => [...document.querySelectorAll('#kd-sec-transform .kd-pair')][0].querySelector('.kd-danger-quiet').click());
    await sleep(200);
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Select');
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[1].click());
    await clickText(page, '#kd-befores .kd-selectbar .btn', 'Remove');
    await sleep(200);
    ok((await counts(page)).befores === 1, 'with no pair using it, the kept-off photo can be removed');
    await page.evaluate(() => [...document.querySelectorAll('.toast')].find((t) => /Pair removed/.test(t.textContent))?.querySelector('.toast-undo')?.click());
    await sleep(250);
    const pairs = await page.$$eval('#kd-sec-transform .kd-pair', (l) => l.map((li) => `${li.querySelector('.kd-pair__room').value}:${li.querySelectorAll('.kd-pair__side .kd-pair__img').length}`).join());
    const said = await page.$$eval('.toast', (t) => t.map((x) => x.textContent).join(' '));
    ok(pairs === 'Hall:2' && /Photos changed since, so that can’t be undone now/.test(said), `with its before photo removed since, the pair’s Undo says so and brings nothing back (${pairs})`);
    await page.close();
  }
  {
    // Show a waiting photo, save, then Undo: back to waiting (staff's own say just saved isn't taken back in)
    const { page, api } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, { kid: { beforePhotos: BEFORES8.slice(0, 2).map(({ looked, ...p }) => p) } });
    await openDylan(page, false);
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Select');
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[0].click());
    await clickText(page, '#kd-befores .kd-selectbar .btn', 'Show on the page');
    await page.click('.kd-bar__save .kd-save');
    await sleep(1000);
    await page.evaluate(() => [...document.querySelectorAll('.toast')].find((t) => /^On the page\./.test(t.textContent))?.querySelector('.toast-undo')?.click());
    await sleep(250);
    const chip = await page.$eval('#kd-befores .kd-tile', (li) => li.querySelector('.kd-tile__role')?.textContent.trim() || 'on').catch(() => '?');
    ok(chip === 'Not checked' && await page.$eval('.kd-bar__state', (e) => e.classList.contains('is-dirty')).catch(() => false), `Undo after a Save takes it back, unsaved (${chip})`);
    await page.close();
  }
  {
    // Show one the site kept off, move it to the gallery, Undo the Show, then Undo the move: it comes back kept off
    const { page } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, { kid: { beforePhotos: [{ ...BEFORES8[0], offPage: true, offWhy: 'A person in it' }, { ...BEFORES8[1] }] } });
    await openDylan(page, false);
    const g0 = (await counts(page)).gallery;
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Select');
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[0].click());
    await clickText(page, '#kd-befores .kd-selectbar .btn', 'Show on the page');
    await sleep(150);
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Select');
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[0].click());
    await clickText(page, '#kd-befores .kd-selectbar .btn', 'Move to the gallery');
    await sleep(200);
    // Newest first: back from the gallery, then the Show undone
    await page.evaluate(() => [...document.querySelectorAll('.toast')].find((t) => /gallery/.test(t.textContent))?.querySelector('.toast-undo')?.click());
    await sleep(150);
    await page.evaluate(() => [...document.querySelectorAll('.toast')].find((t) => /On the page\. /.test(t.textContent))?.querySelector('.toast-undo')?.click());
    await sleep(250);
    const st = await page.$$eval('#kd-befores .kd-tile', (l) => l.map((li) => `${li.querySelector('img').getAttribute('src').match(/before-(\d)/)[1]}:${li.querySelector('.kd-tile__role')?.textContent.trim() || 'on'}`).join());
    ok(st === '1:Kept off,2:on' && (await counts(page)).gallery === g0 + 0, `Undos newest first, through a move to the gallery, end as it began: ${st}`);
    await page.close();
  }
  {
    // Show one the site kept off (a pair uses it), try to remove it: it stays. Show another, remove it, Undo only the
    // Show: it comes back, kept off, as undoing newest first would
    const kid = { beforePhotos: [{ ...BEFORES8[0], offPage: true, offWhy: 'A person in it' }, { ...BEFORES8[1], offPage: true, offWhy: 'A person in it' }, { ...BEFORES8[2] }], beforeAfterPhotos: [{ before: BIMG(1), after: BIMG(9), room: 'Bath', beforeAlt: '', afterAlt: '' }], status: 'completed' };
    const { page } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, { kid });
    await openDylan(page, false);
    const sel = async (idx, btn) => {
      // (A fresh selection: a refused Remove rightly keeps its selection)
      if (await page.$('#kd-befores .kd-selectbar')) await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Done selecting');
      await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Select');
      await page.evaluate((ix) => { const t = document.querySelectorAll('#kd-befores .kd-tile__open'); ix.forEach((i) => t[i].click()); }, idx);
      await clickText(page, '#kd-befores .kd-selectbar .btn', btn);
      await sleep(150);
    };
    await sel([0], 'Show on the page');
    ok(await page.evaluate(() => !!document.activeElement?.closest('#kd-befores')), `focus stays in Before photos after Show (${await page.evaluate(() => document.activeElement?.className || document.activeElement?.tagName)})`);
    await sel([0], 'Remove');
    ok((await counts(page)).befores === 3 && /A Before & after pair uses it, so it stays\. Change the pair’s before first\./.test(await page.$$eval('.toast', (t) => t.map((x) => x.textContent).join(' '))), 'a photo a pair uses stays, even on the page, and the toast says why');
    await sel([1], 'Show on the page');
    await sel([1], 'Remove');
    ok((await counts(page)).befores === 2, 'one no pair uses is removed');
    // The Show's Undo after the Remove: refused (it's gone since); the Remove's Undo, then the Show's: kept off again
    await page.evaluate(() => [...document.querySelectorAll('.toast')].filter((t) => /On the page\. /.test(t.textContent)).at(-1)?.querySelector('.toast-undo')?.click());
    await sleep(200);
    ok((await counts(page)).befores === 2 && /Photos changed since, so that can’t be undone now/.test(await page.$$eval('.toast', (t) => t.map((x) => x.textContent).join(' '))), 'the Show’s Undo after the Remove says it can’t be undone now');
    await page.close();
  }
  {
    // ...and in order, newest first: the Remove's Undo, then the Show's: kept off again
    const kid = { beforePhotos: [{ ...BEFORES8[0] }, { ...BEFORES8[1], offPage: true, offWhy: 'A person in it' }, { ...BEFORES8[2] }] };
    const { page } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, { kid });
    await openDylan(page, false);
    const sel = async (idx, btn) => {
      if (await page.$('#kd-befores .kd-selectbar')) await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Done selecting');
      await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Select');
      await page.evaluate((ix) => { const t = document.querySelectorAll('#kd-befores .kd-tile__open'); ix.forEach((i) => t[i].click()); }, idx);
      await clickText(page, '#kd-befores .kd-selectbar .btn', btn);
      await sleep(150);
    };
    await sel([1], 'Show on the page');
    await sel([1], 'Remove');
    for (let i = 0; i < 2; i++) { await page.evaluate(() => [...document.querySelectorAll('.toast-undo')].at(-1)?.click()); await sleep(200); }
    const st = await page.$$eval('#kd-befores .kd-tile', (l) => l.map((li) => `${li.querySelector('img').getAttribute('src').match(/before-(\d)/)[1]}:${li.querySelector('.kd-tile__role')?.textContent.trim() || 'on'}`).join());
    ok(st === '1:on,2:Kept off,3:on', `newest first, the Remove then the Show: back as it was, kept off (${st})`);
    await page.close();
  }
  {
    // Remove B3, bring it in again from JobTread, then Undo the Remove: one B3. Then a photo moved to the gallery isn't offered again
    const { page, api } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, { kid: { beforePhotos: BEFORES8.slice(0, 4) } });
    await openDylan(page, false);
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Select');
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[2].click());
    await clickText(page, '#kd-befores .kd-selectbar .btn', 'Remove');
    await sleep(200);
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Bring in from JobTread');
    await page.waitForSelector('.rdi', { timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('.rdi .rdi-grid--photos > li').length > 0 && !/Getting|Opening…/.test(document.querySelector('.rdi')?.textContent || ''), { timeout: 30000 }).catch(() => {});
    await sleep(400);
    const b3tile = await page.$$eval('.rdi .rdi-grid--photos > li', (l) => { const li = l[2]; return { on: li.classList.contains('is-on'), said: li.textContent.trim() }; });
    ok(!b3tile.on && /Removed earlier/.test(b3tile.said), `one removed here isn’t picked again, and says so (${JSON.stringify(b3tile)})`);
    await page.click('.rdi .rdi-foot .btn-primary');
    await page.waitForFunction(() => !document.querySelector('.rdi'), { timeout: 20000 }).catch(() => {});
    await page.waitForFunction(() => document.querySelectorAll('#kd-befores .kd-tile').length === 7 && !document.querySelector('#kd-befores .kd-tile__busy'), { timeout: 30000 }).catch(() => {});
    await sleep(300);
    await page.click('.kd-bar__save .kd-save');
    await sleep(1200);
    const saved = api.st.saves.at(-1);
    const srcs = (saved?.beforePhotos || []).map((p) => p.source);
    ok(!srcs.includes('jt:B3') && new Set(srcs).size === srcs.length, `Remove, then Bring in: it stays out, and nothing twice (${srcs.join(',')})`);
    // Move B1 to the gallery: Bring in from JobTread shows it as on the profile, not picked
    if (await page.$('#kd-befores .kd-selectbar')) await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Done selecting');
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[0].click());
    await page.waitForSelector('.kd-photo-dlg');
    await clickText(page, '.kd-photo-dlg .kd-role', 'Move to the gallery');
    await sleep(250);
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Bring in from JobTread');
    await page.waitForSelector('.rdi', { timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('.rdi .rdi-grid--photos > li').length > 0 && !/Getting|Opening…/.test(document.querySelector('.rdi')?.textContent || ''), { timeout: 30000 }).catch(() => {});
    await sleep(400);
    const b1 = await page.$$eval('.rdi .rdi-grid--photos > li', (l) => l.map((li) => ({ there: li.classList.contains('is-there'), on: li.classList.contains('is-on'), src: li.querySelector('img')?.getAttribute('src') || '' })));
    ok(b1.length && b1[0].there && !b1[0].on, `one moved to the gallery is on the profile, not offered again (${JSON.stringify(b1[0])})`);
    await page.close();
  }
  {
    // Remove a pair whose before is on the page, switch that photo off in its window, remove it, Undo the pair:
    // back without that before (it's no longer there to hold the pair off)
    const kid = { beforePhotos: [{ ...BEFORES8[0] }, { ...BEFORES8[1] }], beforeAfterPhotos: [{ before: BIMG(1), after: BIMG(9), room: 'Bath', beforeAlt: '', afterAlt: '' }], status: 'completed' };
    const { page } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, { kid });
    await openDylan(page, false);
    await page.evaluate(() => document.querySelector('#kd-sec-transform .kd-pair .kd-danger-quiet').click());
    await sleep(150);
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[0].click());
    await page.waitForSelector('.kd-photo-dlg');
    await clickText(page, '.kd-photo-dlg .kd-role', 'On the page');
    await sleep(150);
    await clickText(page, '.kd-photo-dlg .kd-dialog__foot .btn', 'Remove photo');
    await sleep(250);
    await page.evaluate(() => [...document.querySelectorAll('.toast')].find((t) => /Pair removed/.test(t.textContent))?.querySelector('.toast-undo')?.click());
    await sleep(250);
    const pair = await page.$eval('#kd-sec-transform .kd-pair', (li) => li.querySelectorAll('.kd-pair__side .kd-pair__img').length).catch(() => -1);
    ok(pair === -1 && /Photos changed since, so that can’t be undone now/.test(await page.$$eval('.toast', (t) => t.map((x) => x.textContent).join(' '))), `with its before photo changed and removed since, the pair’s Undo says so (${pair})`);
    await page.close();
  }
  {
    // Show one the site kept off, then switch it off again in its own window, then Undo the Show: it stays off
    const { page } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, { kid: { beforePhotos: [{ ...BEFORES8[0], offPage: true, offWhy: 'A person in it' }, { ...BEFORES8[1] }] } });
    await openDylan(page, false);
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Select');
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[0].click());
    await clickText(page, '#kd-befores .kd-selectbar .btn', 'Show on the page');
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Done selecting');
    await sleep(150);
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[0].click());
    await page.waitForSelector('.kd-photo-dlg');
    await clickText(page, '.kd-photo-dlg .kd-role', 'On the page');
    await page.keyboard.press('Escape');
    await sleep(250);
    await page.evaluate(() => [...document.querySelectorAll('.toast')].find((t) => /^On the page\. /.test(t.textContent))?.querySelector('.toast-undo')?.click());
    await sleep(250);
    const chip = await page.$eval('#kd-befores .kd-tile .kd-tile__role', (c) => c.textContent.trim()).catch(() => 'on');
    const said = await page.$$eval('.toast', (t) => t.map((x) => x.textContent).join(' '));
    ok(chip === 'Kept off' && /Photos changed since, so that can’t be undone now/.test(said), `an older Undo never goes past a switch made since in the photo’s window (${chip})`);
    await page.close();
  }
  {
    // A draft kept in a closed tab, and since then only the site's answers were saved: no warning of replacing anything
    const two = BEFORES8.slice(0, 2).map(({ looked, ...p }) => p);
    const { page, api } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, { kid: { beforePhotos: two } });
    await openDylan(page, false);
    const slug = Object.keys(api.st.kids).find((k) => /dylan/.test(k));
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[0].click());
    await page.waitForSelector('#kd-before-room');
    await page.type('#kd-before-room', 'Den');
    await clickText(page, '.kd-photo-dlg .kd-dialog__foot .btn', 'Done');
    await sleep(1600);
    const k = api.st.kids[slug];
    api.st.kids[slug] = { ...k, beforePhotos: k.beforePhotos.map((p) => ({ ...p, looked: 'site' })) };
    api.st.shaOf = { [slug]: 'sha-site-9' };
    // (As a closed tab opened again: leave despite the unsaved-changes prompt, then the admin from the start, with the
    // draft the browser kept; this harness clears storage on each load, so it's carried over by hand)
    const kept = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith('soard-kid-draft:')).map((k) => [k, localStorage.getItem(k)])));
    ok(Object.keys(kept).length === 1, 'the unsaved room was kept as a draft');
    page.on('dialog', (d) => d.accept().catch(() => {}));
    await page.goto(`${SITE}/admin/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.nav-item', { timeout: 20000 });
    await page.evaluate((k) => { for (const [key, v] of Object.entries(k)) localStorage.setItem(key, v); }, kept);
    await openDylan(page, false);
    await sleep(500);
    const banner = await page.$eval('.kd-note--draft', (e) => e.textContent.replace(/\s+/g, ' ')).catch(() => '');
    ok(/never saved/.test(banner) && !/replaces those newer changes/.test(banner), `only the site’s answers saved since: no warning of replacing anything (“${banner.slice(0, 140)}”)`);
    await page.close();
  }
  console.log('\nPhotos → Before photos: Undo, uploads, few photos, focus, hidden (1440)');
  {
    const four = BEFORES8.slice(0, 4);
    const { page, api, errors } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, { kid: { beforePhotos: four, publishStatus: 'draft' } });
    await openDylan(page, false);
    // A hidden profile: the labels say "once the profile is shown"
    ok(/On the reveal screen, once the profile is shown/.test(await page.$eval('#kd-befores .kd-zone', (z) => z.textContent)), 'a hidden profile’s label says once the profile is shown');
    // Four photos: every one plays, so there's no switch; "of 4". Opened from the keyboard, as a person would
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[2].focus());
    await page.keyboard.press('Enter');
    await page.waitForSelector('.kd-photo-dlg');
    const d4 = await page.evaluate(() => ({ sub: document.querySelector('.kd-photo-dlg .kd-dialog__sub').textContent, roles: [...document.querySelectorAll('.kd-photo-dlg .kd-role strong')].map((r) => r.textContent) }));
    ok(/3rd of 4: every before photo on the page plays while there are 6 or fewer/.test(d4.sub) && /once the profile is shown/.test(d4.sub) && !d4.roles.includes('On the reveal screen'), `with 4, no switch: “${d4.sub}” · ${d4.roles.join(', ')}`);
    // Focus comes back to the photo after it moves (First), then Escape
    await clickText(page, '.kd-photo-dlg .kd-photo__move .btn', 'First');
    await sleep(150);
    await page.keyboard.press('Escape');
    await sleep(250);
    const focused = await page.evaluate(() => { const a = document.activeElement; return a?.classList.contains('kd-tile__open') ? a.querySelector('img').getAttribute('src').match(/before-(\d)/)?.[1] : a?.tagName; });
    ok(focused === '3', `after it moved, Escape gives focus back to that photo (${focused})`);
    // Remove one, then a new upload lands and a room is typed, then Undo: only the removed one comes back
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Select');
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[1].click());
    await clickText(page, '#kd-befores .kd-selectbar .btn', 'Remove');
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Done selecting');
    await sleep(150);
    api.st.uploadDelay = 1200;
    await page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 40; c.height = 30;
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'late.png', { type: 'image/png' }));
      const el = document.querySelector('#kd-befores');
      el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await sleep(200);
    // While it uploads, its dialog says so and nothing can move or remove it
    await page.evaluate(() => [...document.querySelectorAll('#kd-befores .kd-tile__open')].at(-2).click());
    await page.waitForSelector('.kd-photo-dlg');
    await page.click('.kd-photo-dlg .kd-photo__nav.is-next');
    await sleep(150);
    const up = await page.evaluate(() => ({ wait: !!document.querySelector('.kd-photo-dlg .kd-photo__wait'), roles: [...document.querySelectorAll('.kd-photo-dlg .kd-role')].every((b) => b.disabled), remove: [...document.querySelectorAll('.kd-photo-dlg .kd-dialog__foot .btn')].find((b) => /Remove/.test(b.textContent))?.disabled, moves: [...document.querySelectorAll('.kd-photo-dlg .kd-photo__move .btn')].every((b) => b.disabled) }));
    ok(up.wait && up.roles && up.remove && up.moves, `a photo still uploading: says so, and its moves, roles and Remove wait (${JSON.stringify(up)})`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#kd-befores .kd-tile__busy'), { timeout: 10000 });
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[0].click());
    await page.waitForSelector('.kd-photo-dlg');
    await page.type('#kd-before-room', 'Hall');
    await clickText(page, '.kd-photo-dlg .kd-dialog__foot .btn', 'Done');
    await sleep(150);
    // A photo added since: the Remove's Undo says it can't be undone now, and leaves everything as it is
    await page.evaluate(() => [...document.querySelectorAll('.toast')].find((t) => /removed/.test(t.textContent))?.querySelector('.toast-undo')?.click());
    await sleep(200);
    const after = await page.evaluate(() => [...document.querySelectorAll('#kd-befores .kd-tile__open img')].map((i) => i.getAttribute('src')));
    ok(after.length === 4 && !after.some((u) => /before-1\.jpg/.test(u)) && after.some((u) => /kids\/test\/up-/.test(u)), `with a photo added since, the Remove’s Undo changes nothing (${after.length})`);
    ok(!after.some((u) => /^blob:/.test(u)), 'no dead (blob:) tile');
    await page.click('.kd-bar__save .kd-save');
    await sleep(1200);
    const saved = api.st.saves.at(-1);
    ok(saved?.beforePhotos.length === 4 && saved.beforePhotos.some((p) => p.room === 'Hall') && saved.beforePhotos.some((p) => /up-/.test(p.url)), `Save keeps the room typed and the upload (${saved?.beforePhotos?.length})`);
    // Move to the gallery one that's in the gallery already: it says so
    const galleryUrl = await page.evaluate(() => [...document.querySelectorAll('#kd-sec-photos .kd-tiles')].filter((x) => !x.closest('#kd-befores')).flatMap((x) => [...x.querySelectorAll(':scope > .kd-tile img')])[3].getAttribute('src'));
    ok(!!galleryUrl, 'a gallery photo to copy');
    ok(real(errors).length === 0, `no console errors (${errors.join(' | ').slice(0, 200)})`);
    await page.close();
  }
  {
    // A photo in both lists: Move to the gallery says it was there already
    const both = { url: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/dylan-2026/both.jpg/public', alt: 'x', room: '', looked: 'staff' };
    const { page, errors } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, { kid: { beforePhotos: [both], photos: [{ url: both.url, alt: 'x' }, { url: BIMG(9), alt: 'y' }] } });
    await openDylan(page, false);
    const g0 = (await counts(page)).gallery;
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[0].click());
    await page.waitForSelector('.kd-photo-dlg');
    await clickText(page, '.kd-photo-dlg .kd-role', 'Move to the gallery');
    await sleep(250);
    const t = await page.$$eval('.toast', (x) => x.map((e) => e.textContent).join(' '));
    ok(/It was in the gallery already, so it’s only there now/.test(t) && (await counts(page)).gallery === g0, `already in the gallery: it says so, and the gallery is as it was (“${t.slice(0, 90)}”)`);
    ok(real(errors).length === 0, `no console errors (${errors.join(' | ').slice(0, 200)})`);
    await page.close();
  }
  {
    // Bring in from JobTread with one hand-added before photo: the 5 free places go to ones spread across the visit
    const { page, api, errors } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, { kid: { beforePhotos: [{ url: BIMG(1), alt: '', room: '' }] } });
    await openDylan(page, false);
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Bring in from JobTread');
    await page.waitForSelector('.rdi');
    // Every page drawn and the picked ones ready, then the drawings unpicked: only before photos this time
    await page.waitForFunction(() => document.querySelectorAll('.rdi .rdi-grid:not(.rdi-grid--photos) > li').length === 5 && !document.querySelector('.rdi .rdi-busy'), { timeout: 30000 });
    ok(await page.$$eval('.rdi .rdi-grid--photos > li.is-on', (x) => x.length) === 8, 'every before photo picked the first time');
    await page.evaluate(() => document.querySelectorAll('.rdi .rdi-grid:not(.rdi-grid--photos) > li').forEach((li) => { if (li.classList.contains('is-on')) li.querySelector('.rdi-pick').click(); }));
    await sleep(200);
    await page.waitForFunction(() => /Add 8 before photos/.test(document.querySelector('.rdi .rdi-foot .btn-primary')?.textContent || ''), { timeout: 15000 }).catch(() => {});
    await page.click('.rdi .rdi-foot .btn-primary');
    await page.waitForFunction(() => document.querySelectorAll('#kd-befores .kd-tile').length === 9 && !document.querySelector('#kd-befores .kd-tile__busy'), { timeout: 20000 }).catch(() => {});
    await page.click('.kd-bar__save .kd-save');
    await sleep(1200);
    const order = (api.st.saves.at(-1)?.beforePhotos || []).map((p) => p.source || 'hand').join();
    ok(order === 'hand,jt:B1,jt:B3,jt:B5,jt:B6,jt:B8,jt:B2,jt:B4,jt:B7', `the hand-added one stays first; the 5 free places go to ones spread across the visit: ${order}`);
    ok(real(errors).length === 0, `no console errors (${errors.join(' | ').slice(0, 200)})`);
    await page.close();
  }
  console.log('\nPhotos → Before photos: Undo in any order, never in both lists, focus (1440)');
  {
    const { page, api, errors } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, { kid: { beforePhotos: BEFORES8 } });
    await openDylan(page, false);
    const undoNth = (n) => page.evaluate((n) => { const b = [...document.querySelectorAll('.toast-undo')].filter((x) => x.textContent.trim() === 'Undo'); b.at(n)?.click(); return b.length; }, n);
    const removeAt = async (i) => {
      await page.evaluate((i) => document.querySelectorAll('#kd-befores .kd-tile__open')[i].click(), i);
      await page.waitForSelector('.kd-photo-dlg');
      await clickText(page, '.kd-photo-dlg .kd-dialog__foot .btn', 'Remove photo');
      await sleep(250);
    };
    // Remove #3, then #6; Undo the first, then the second: back where each was
    await removeAt(2);
    const focusedAfter = await page.evaluate(() => (document.activeElement?.querySelector('img')?.getAttribute('src').match(/before-(\d)/) || [])[1] || document.activeElement?.tagName);
    ok(focusedAfter === '4', `after Remove, focus is on the photo now in its place (${focusedAfter})`);
    await removeAt(4);
    ok(await beforeKeys(page) === '1,2,4,5,7,8', `two removed: ${await beforeKeys(page)}`);
    // The older Undo first: refused (something changed since); newest first, each puts its photo back where it was
    await undoNth(0); await sleep(200);
    ok(await beforeKeys(page) === '1,2,4,5,7,8', `the older Undo first changes nothing: ${await beforeKeys(page)}`);
    // (that older toast is gone; the newer one still puts its photo back where it was)
    await undoNth(-1); await sleep(200);
    ok(await beforeKeys(page) === '1,2,4,5,6,7,8', `the newer Undo puts its photo back where it was: ${await beforeKeys(page)}`);
    // Remove #2, then First on #8, then Undo: 2 goes back after 1
    await removeAt(1);
    await page.evaluate(() => [...document.querySelectorAll('#kd-befores .kd-tile__open')].at(-1).click());
    await page.waitForSelector('.kd-photo-dlg');
    await clickText(page, '.kd-photo-dlg .kd-photo__move .btn', 'First');
    await page.keyboard.press('Escape');
    await sleep(200);
    await page.evaluate(() => [...document.querySelectorAll('.toast')].find((t) => /removed/.test(t.textContent))?.querySelector('.toast-undo')?.click());
    await sleep(200);
    ok(await beforeKeys(page) === '8,1,4,5,6,7', `after another move, the Remove’s Undo changes nothing: ${await beforeKeys(page)}`);
    // Last photo, Next arrow: focus moves to the other arrow, never the page
    await page.evaluate(() => [...document.querySelectorAll('#kd-befores .kd-tile__open')].at(-2).focus());
    await page.keyboard.press('Enter');
    await page.waitForSelector('.kd-photo-dlg');
    await page.focus('.kd-photo-dlg .kd-photo__nav.is-next');
    await page.keyboard.press('Enter');
    await sleep(200);
    const navFocus = await page.evaluate(() => document.activeElement?.className || document.activeElement?.tagName);
    ok(/is-prev/.test(navFocus), `at the last photo, focus moves to the other arrow (${navFocus})`);
    await page.keyboard.press('Escape');
    await sleep(200);
    // A gallery photo made a before photo, then removed there; Undo both, newest first: back in the gallery, in one list only
    const g0 = (await counts(page)).gallery;
    await page.evaluate(() => [...document.querySelectorAll('#kd-gallery-tiles .kd-tile__open')].at(-1).click());
    await page.waitForSelector('.kd-photo-dlg');
    await clickText(page, '.kd-photo-dlg .kd-role', 'A before photo');
    await sleep(250);
    await removeAt((await counts(page)).befores - 1);
    await undoNth(-1); await sleep(200); // the Remove
    await undoNth(-1); await sleep(200); // then the move to Before photos
    const lists = await page.evaluate(() => {
      const src = (sel) => [...document.querySelectorAll(`${sel} .kd-tile__open img`)].map((i) => i.getAttribute('src').replace(/\/w=.*$/, ''));
      const g = src('#kd-gallery-tiles'); const b = src('#kd-before-tiles');
      return { both: g.filter((u) => b.includes(u)).length, g: g.length };
    });
    ok(lists.both === 0 && lists.g === g0, `never in both lists after Undos, newest first (${JSON.stringify(lists)})`);
    await page.click('.kd-bar__save .kd-save');
    await sleep(1200);
    const saved = api.st.saves.at(-1);
    ok(saved && !saved.photos.some((p) => saved.beforePhotos.some((b) => b.url === p.url)), 'and saved that way');
    ok(real(errors).length === 0, `no console errors (${errors.join(' | ').slice(0, 200)})`);
    await page.close();
  }
  {
    // Bring in from JobTread, from Before photos, with some already there: the rest picked, no drawings
    const { page, errors } = await open(browser, { width: 1440, height: 900, mobile: false }, FILES, { kid: { beforePhotos: [{ url: BIMG(1), alt: '', room: '', source: 'jt:B1' }] } });
    await openDylan(page, false);
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Bring in from JobTread');
    await page.waitForSelector('.rdi');
    await page.waitForFunction(() => document.querySelectorAll('.rdi .rdi-grid:not(.rdi-grid--photos) > li').length === 5 && !document.querySelector('.rdi .rdi-busy'), { timeout: 30000 });
    await sleep(300);
    const st = await page.evaluate(() => ({ befores: document.querySelectorAll('.rdi .rdi-grid--photos > li.is-on').length, drawings: document.querySelectorAll('.rdi .rdi-grid:not(.rdi-grid--photos) > li.is-on').length, add: document.querySelector('.rdi .rdi-foot .btn-primary')?.textContent.trim() }));
    ok(st.befores === 7 && st.drawings === 0 && st.add === 'Add 7 before photos', `opened from Before photos: the 7 not there picked, no drawings (${JSON.stringify(st)})`);
    await answerAsks(page, { accept: true });
    await page.keyboard.press('Escape');
    ok(real(errors).length === 0, `no console errors (${errors.join(' | ').slice(0, 200)})`);
    await page.close();
  }
  console.log('\nPhotos → Before photos: Reorder on a phone is their own');
  {
    const { page, errors } = await open(browser, { width: 390, height: 844, mobile: true }, FILES, { kid: { beforePhotos: BEFORES8 } });
    await openDylan(page, true);
    await clickText(page, '#kd-befores .kd-sec__actions .btn', 'Reorder');
    await sleep(150);
    const r = await page.evaluate(() => ({
      gallery: [...document.querySelectorAll('#kd-sec-photos > header .kd-sec__actions .btn, #kd-sec-photos .kd-sec__head .kd-sec__actions .btn')].find((b) => /Reorder|Done/.test(b.textContent))?.textContent.trim(),
      galleryGrips: [...document.querySelectorAll('#kd-sec-photos .kd-tiles')].filter((x) => !x.closest('#kd-befores')).reduce((n, x) => n + x.querySelectorAll('.kd-grip').length, 0),
      beforeGrips: document.querySelectorAll('#kd-befores .kd-grip').length,
    }));
    ok(r.gallery === 'Reorder' && r.galleryGrips === 0 && r.beforeGrips === 8, `only Before photos go into reorder (${JSON.stringify(r)})`);
    ok(/tap Reorder, then drag, to choose which/.test(await page.$eval('#kd-befores .kd-sec__sub', (e) => e.textContent)), 'on touch it says to tap Reorder first');
    ok(real(errors).length === 0, `no console errors (${errors.join(' | ').slice(0, 200)})`);
    await page.close();
  }
  await toastChecks(browser);
  console.log('\nPhotos → Before photos (390, touch)');
  {
    const { page, errors } = await open(browser, { width: 390, height: 844, mobile: true }, FILES, { kid: { beforePhotos: BEFORES8 } });
    await openDylan(page, true);
    await page.evaluate(() => document.querySelector('#kd-befores').scrollIntoView({ block: 'start' }));
    await sleep(300);
    const fit = await page.evaluate(() => {
      const g = document.querySelector('#kd-befores').getBoundingClientRect();
      const over = [...document.querySelectorAll('#kd-befores *')].filter((e) => e.getBoundingClientRect().right > g.right + 1 && e.offsetParent).map((e) => e.className || e.tagName).slice(0, 5);
      return { page: document.scrollingElement.scrollWidth <= window.innerWidth, over, reorder: [...document.querySelectorAll('#kd-befores .kd-sec__actions .btn')].map((b) => b.textContent.trim()) };
    });
    ok(fit.page && !fit.over.length, `nothing scrolls sideways or sticks out (${fit.over.join(', ')})`);
    ok(fit.reorder[0] === 'Reorder', `on touch, Reorder is there: ${fit.reorder.join(' / ')}`);
    await shot(page, 'before-photos-390');
    await page.evaluate(() => document.querySelectorAll('#kd-befores .kd-tile__open')[0].click());
    await page.waitForSelector('.kd-photo-dlg');
    await sleep(200);
    const dfit = await page.evaluate(() => { const d = document.querySelector('.kd-photo-dlg').getBoundingClientRect(); return d.left >= 0 && d.right <= window.innerWidth + 1; });
    ok(dfit, 'the photo dialog fits the phone');
    await shot(page, 'before-photo-dialog-390');
    ok(real(errors).length === 0, `no console errors (${errors.join(' | ').slice(0, 200)})`);
    await page.close();
  }
}

const files = { 'planset.pdf': await planSet(), 'board.png': png(600, 400, [240, 220, 120]), ...Object.fromEntries(BEFORE_IDS.map((id, i) => [`${id}.png`, png(320, 240, [60 + i * 20, 120, 160])])) };
var FILES = files;
const browser = await puppeteer.launch({ headless: 'new', args: ['--disable-gpu-vsync', '--disable-frame-rate-limit'] });
try {
  const only = process.env.ONLY;
  if (!only || only === 'main') { await desktop(browser, files); await phone(browser, files); await whenThingsGoWrong(browser, files); }
  if (!only || only === 'address') await addressCases(browser);
  if (!only || only === 'editor') await editorFlows(browser);
  if (!only || only === 'hand') await handAdded(browser);
  if (!only || only === 'kids') await otherKids(browser);
  if (!only || only === 'heic') await heicAndYear(browser);
  if (!only || only === 'befores') await beforePhotosGroup(browser);
  if (only === 'toasts') await toastChecks(browser);
} catch (e) {
  failures.push(`crashed: ${e.stack || e.message}`);
  console.log(e);
} finally {
  await browser.close();
}
console.log(`\n${failures.length ? `${failures.length} failed:\n  ${failures.join('\n  ')}` : 'All passed'}`);
process.exit(failures.length ? 1 : 0);
