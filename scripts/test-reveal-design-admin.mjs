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
 *     six of eight before photos picked, spread across the visit
 *   - the family's address: red on the test sheets (title block and a note on
 *     the drawing). Not one red pixel survives on a picked drawing, the blue
 *     room labels do, and the title block is cut off
 *   - Add: drawings go up named -notitle with their kind, caption, size and
 *     JobTread source; before photos become pairs waiting for their after;
 *     items already added show as on the profile next time
 *   - the kind picker on a plan tile; Save writes it all
 *   - Preview the stream: the real slate framed with ?design=preview (codes and all), and
 *     Preview the live page: the kid's real live page at Starting soon / Live / Replay;
 *     reading the editor's unsaved design; portrait toggle
 *   - phone: the dialog fits, nothing scrolls sideways, buttons reachable
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
  if (opts.kid) st.kids[SLUG] = { ...st.kids[SLUG], ...opts.kid };
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
      const c = m && st.kids[m[1]];
      return c ? json({ success: true, content: c, sha: `sha-${m[1]}-${st.saves.length}` }) : json({ success: false, error: 'Not found' }, 404);
    }
    if (p === '/api/save-content') {
      const b = body();
      const slug = b.path.match(/kids\/(.+)\.json$/)?.[1];
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
  ok(/stay off Dylan’s page until the reveal/.test(note) && /3:00 PM, Wednesday, November 18/.test(note), `plans note says when: “${note}”`);
  ok(/stay off Dylan’s page until the reveal/.test(await page.$eval('#kd-sec-transform .kd-design-short', (e) => e.textContent).catch(() => '')) && !(await page.$('#kd-sec-transform .kd-design-when')), 'Before & after has a short line, not the long note again');

  // Bring in from JobTread
  ok(await clickText(page, '#kd-sec-plans .kd-sec__actions .btn', 'Bring in from JobTread'), 'Bring in from JobTread opens');
  await page.waitForSelector('.rdi', { timeout: 10000 });
  ok(api.st.lastListing?.includes(`job=${JOB}`), 'asks for the job the editor knows');
  // Every page drawn, then the picked ones made ready
  await page.waitForFunction(() => document.querySelectorAll('.rdi .rdi-grid:not(.rdi-grid--photos) > li').length === 5, { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('.rdi .rdi-busy') && /Add 3 drawings and 6 before photos/.test(document.querySelector('.rdi .btn-primary')?.textContent || ''), { timeout: 30000 }).catch(() => {});
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
  ok(befores.length === 8 && befores.filter(Boolean).length === 6, `6 of 8 before photos picked: ${befores.map((b) => (b ? 1 : 0)).join('')}`);
  ok(befores[0] && befores[7], 'the spread starts and ends with the first and last');

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
  ok(add.text === 'Add 3 drawings and 6 before photos' && !add.disabled, `Add says what it adds: “${add.text}”`);

  // Add
  await page.click('.rdi .rdi-foot .btn-primary');
  await page.waitForFunction(() => !document.querySelector('.rdi'), { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll('#kd-sec-plans .kd-plan').length === 3 && !document.querySelector('#kd-sec-plans .kd-tile__busy, #kd-sec-transform .kd-tile__busy'), { timeout: 20000 }).catch(async (e) => {
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
  const pairs = await page.$$eval('#kd-sec-transform .kd-pair', (lis) => lis.map((li) => li.textContent.includes('Add the after once the room is done')));
  ok(pairs.length === 6 && pairs.every(Boolean), `6 before photos wait for their after (${pairs.length})`);
  await shot(page, 'after-add-1440');
  for (const id of ['plans', 'transform']) {
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
  ok(slides?.join() === 'before,before,before,before,before,before,as-built,proposed,board', `the editor hands the screen its design: ${slides?.join()}`);
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
    ok(saved.beforeAfterPhotos.length === 6 && saved.beforeAfterPhotos.every((p) => p.before && p.after === '' && /^jt:B\d$/.test(p.source) && p.beforeAlt), `before photos saved waiting for their after: ${saved.beforeAfterPhotos.length}`);
  }

  // Open the dialog again: what's added shows as on the profile, and nothing is picked twice
  await clickText(page, '#kd-sec-transform .kd-sec__actions .btn', 'Bring in from JobTread');
  await page.waitForSelector('.rdi', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('.rdi .rdi-grid:not(.rdi-grid--photos) > li').length === 5 && !document.querySelector('.rdi .rdi-busy'), { timeout: 30000 });
  await sleep(500);
  const again = await page.evaluate(() => ({
    there: document.querySelectorAll('.rdi .is-there').length,
    on: document.querySelectorAll('.rdi .rdi-tile.is-on').length,
    add: document.querySelector('.rdi .rdi-foot .btn-primary')?.textContent.trim(),
  }));
  ok(again.there === 9 && again.on === 0, `next time, the 9 added show as on the profile and nothing is picked for them (${again.there} there, ${again.on} picked, “${again.add}”)`);
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
  await page.waitForFunction(() => /Add 1 drawing and 6 before photos/.test(document.querySelector('.rdi .rdi-foot .btn-primary')?.textContent || ''), { timeout: 20000 }).catch(() => {});
  ok(/Add 1 drawing and 6 before photos/.test(await page.$eval('.rdi .rdi-foot .btn-primary', (b) => b.textContent.trim())), 'the rest can still be added');
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
  const toasts = await page.$$eval('.toast, [class*="toast"]', (t) => t.map((x) => x.textContent.replace(/\s+/g, ' ').trim()).join(' | '));
  ok(/“(Existing|Proposed) floor plan” didn’t upload\. Cloudflare said no/.test(toasts), `a failed upload names the drawing by its caption: “${toasts.slice(0, 120)}”`);
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
  // A file that isn't a picture, in Add before photos
  const pdfPath = join(OUT, 'not-a-picture.pdf');
  writeFileSync(pdfPath, FILES['planset.pdf']);
  const input = await page.$('#kd-sec-transform input[type="file"][multiple]');
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
    ok(/show nowhere while/.test(await page.$eval('#kd-sec-transform .kd-design-short', (e) => e.textContent)), 'Before & after has the short line');
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
} catch (e) {
  failures.push(`crashed: ${e.stack || e.message}`);
  console.log(e);
} finally {
  await browser.close();
}
console.log(`\n${failures.length ? `${failures.length} failed:\n  ${failures.join('\n  ')}` : 'All passed'}`);
process.exit(failures.length ? 1 : 0);
