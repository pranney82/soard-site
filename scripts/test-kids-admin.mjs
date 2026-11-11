/**
 * test-kids-admin.mjs — drive Admin → Kids in a real browser
 * ==========================================================
 * Loads the admin from an Astro dev server (so Preview can frame the real kid
 * page) with every /api/* call answered from an in-memory copy of
 * src/content/kids and src/content/partners. Checks, at 1440px and 390px:
 *   - the list: Awaiting funding, In build, Completed by year; counts, the
 *     Needs attention filter (matches kids-shared.js), search, reveal dates
 *   - setting the order at the top of Meet the Kids by keyboard and by
 *     dragging: one /api/reorder-content request with every active kid, Undo
 *   - the row menu: Mark as completed (and Undo); a kid with a JobTread job
 *     takes its status from JobTread (no Mark as…, read-only in the editor)
 *   - the editor: rooms (counts → roomTypes/roomCount), unsaved state that
 *     clears when an edit is undone, the photo dialog (alt text, main photo),
 *     reordering photos by mouse and keyboard, removing the main photo (the
 *     next one takes over, Undo), uploading (alt text written after), plan
 *     captions (address block crop), partners from the directory, the video
 *     the page plays, validation, the saved record, Preview, a new kid, delete
 *   - Profiles to tidy: broken partner logos, room counts, logo names, alt text, Stop
 *   - the side panel (status, profile health), Discard with Undo, the photo
 *     wall, "/" to search, broken logos repaired
 *   - Upload photos and videos (no Add a kid: profiles are made on approval):
 *     files waiting for a kid, drafts offered, gallery order, alt text, the
 *     page's video vs. one kept in Stream (and swapping, Undo), duplicates,
 *     empty and failed files, Try again, a save someone else beat, past the
 *     30 the page shows, drops anywhere on the dialog, Stop, phone sheet
 *   - history: versions after saves, what each changed, restoring one (and
 *     Undo), Recently deleted and bringing a profile back
 *   - a photo's focal point: set by clicking the photo, previews, saved
 *   - phone: the story shows as a preview until you edit it
 *   - phone: nothing past the content column, 44px targets, touch drag on a
 *     photo's grip, sheets that fit the screen
 * Screenshots land in test-results/kids-admin/. Exits non-zero on any failure
 * or console error.
 *
 *   SITE=http://localhost:4321 node scripts/test-kids-admin.mjs
 * Without SITE it starts `astro dev` on a spare port and stops it after.
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hoverSweep } from './lib/hover-sweep.mjs';
import * as KS from '../public/admin/kids-shared.js';
import { answerAsks } from './lib/ask.mjs';
import { tiff, jpeg, heic as heicFile, pngImage } from '../tests/lib/exif-fixtures.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/kids-admin/');
mkdirSync(OUT, { recursive: true });
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const hoverSeen = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let SITE = process.env.SITE?.replace(/\/$/, '');
let dev = null;
if (!SITE) {
  const port = 4300 + Math.floor(Math.random() * 600);
  dev = spawn('npx', ['astro', 'dev', '--port', String(port)], { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TZ: 'UTC' } });
  SITE = `http://localhost:${port}`;
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('astro dev did not start within 2 minutes')), 120000);
    const seen = (b) => { if (/Local\s+http/.test(String(b))) { clearTimeout(t); resolve(); } };
    dev.stdout.on('data', seen);
    dev.stderr.on('data', seen);
    dev.on('exit', (code) => { clearTimeout(t); reject(new Error(`astro dev exited (${code})`)); });
  });
}
const stopDev = () => { if (dev) try { process.kill(-dev.pid); } catch {} };

const readDir = (d) => Object.fromEntries(readdirSync(join(ROOT, 'src/content', d)).filter((f) => f.endsWith('.json'))
  .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(ROOT, 'src/content', d, f), 'utf8'))]));
const PARTNERS = readDir('partners');
const KIDS0 = readDir('kids');
for (const [slug, d] of Object.entries(KIDS0)) d.slug ||= slug;
// Amari's and Anna's pages link to sites that aren't Zeffy, as links saved before every link was picked could:
// Giving warns, and that never stops the rest of a profile saving
KIDS0.amari.fundraisingUrl = 'https://example.org/give';
KIDS0.anna.fundraisingUrl = 'https://www.gofundme.com/f/anna-room';
const PNG = join(OUT, 'pixel.png');
// Logos whose file is gone in Cloudflare (as on the live site): their old IDs answer 404
const BROKEN_IDS = ['partners/real-floors-commercial', 'partners/usa-insulation', 'partners/eclipse-brand-builders'];
const isBrokenImage = (url) => BROKEN_IDS.some((id) => url.includes(`/${id}/w=`) || url.endsWith(`/${id}/public`));
writeFileSync(PNG, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64'));

// A Stream video id (32 hex), the nth one uploaded
const VID = (n) => n.toString(16).padStart(32, 'c');
const TUS = 'https://upload.videodelivery.net/tus/';

// ── The fake API ──
// The link behind the Fundraising link's Open (the picked form's), or '' with none
const fundLink = (page) => page.evaluate(() => document.querySelector('#kd-sec-giving a.zf-link__open')?.getAttribute('href') || '');
function makeApi() {
  const kids = structuredClone(KIDS0);
  const st = { kids, calls: [], waiting: new Set(), uploads: 0, versions: {}, vid: 0, videos: 0, tus: {}, conflicts: 0, ids: [], folders: [] };
  // The history the server keeps (functions/api/_content-history.js), in memory
  const version = (slug, data, by, action = 'save') => { (st.versions[slug] ||= []).push({ id: ++st.vid, at: new Date(Date.now() + st.vid).toISOString(), by, action, data: structuredClone(data) }); };
  const IGN = new Set(['order', 'sortOrder', 'photoCount']);
  const changed = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !IGN.has(k) && JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)).sort();
  const respond = (req) => {
    const url = new URL(req.url());
    const json = (o, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(o) });
    const body = () => { try { return JSON.parse(req.postData() || '{}'); } catch { return {}; } };
    const p = url.pathname;
    if (!p.startsWith('/api/')) return false;
    const isPost = req.method() === 'POST';
    st.calls.push({ path: p, method: req.method(), body: isPost && !/upload-image/.test(p) ? body() : null, query: url.search });
    // Dropbox folders to name (functions/api/kid-folders-admin.js)
    if (p === '/api/kid-folders-admin') {
      const kidsOut = Object.values(st.kids).map((k) => ({ slug: k.slug, name: k.name, year: k.year ?? null }));
      if (!isPost) return json({ success: true, folders: st.folders, kids: kidsOut });
      const b = body();
      const f = st.folders.find((x) => x.folder === b.folder);
      if (!f) return json({ success: false, error: 'That folder isn’t on the list any more. Reload.' }, 404);
      if (b.decision === 'new' && !(b.newYear >= 2010 && b.newYear <= 2030)) return json({ success: false, error: 'The year of the makeover, 2010 to 2030.' }, 400);
      Object.assign(f, { decision: b.decision ?? null, kidSlug: b.kidSlug || null, newName: b.newName || null, newYear: b.newYear || null, note: b.note || null,
        decidedBy: b.decision ? 'linzi@example.org' : null, decidedAt: b.decision ? new Date().toISOString() : null });
      return json({ success: true, folder: f });
    }
    if (p === '/api/list-content') {
      const dir = url.searchParams.get('dir');
      const src = dir === 'src/content/kids' ? st.kids : dir === 'src/content/partners' ? PARTNERS : {};
      const items = Object.entries(src).map(([slug, c]) => ({ name: `${slug}.json`, path: `${dir}/${slug}.json`, sha: slug, content: c }));
      return json({ success: true, items, count: items.length, total: items.length, pages: 1 });
    }
    if (p === '/api/read-content') {
      const m = url.searchParams.get('path').match(/^src\/content\/kids\/(.+)\.json$/);
      const c = m && st.kids[m[1]];
      return c ? json({ success: true, content: c, sha: `sha-${m[1]}-${JSON.stringify(c).length}` }) : json({ success: false, error: 'Not found' }, 404);
    }
    if (p === '/api/save-content') {
      const b = body();
      // Someone else saved between this read and this save (once, when asked)
      if (st.conflictOnce) { st.conflictOnce = false; st.conflicts++; return json({ success: false, error: 'Conflict: this item was changed since you loaded it. Reload to get the latest version.' }, 409); }
      if (st.failSaves) { st.failSaves--; return json({ success: false, error: 'D1 is busy' }, 500); }
      const slug = b.path.match(/kids\/(.+)\.json$/)?.[1];
      const previous = st.kids[slug];
      st.kids[slug] = JSON.parse(b.content);
      if (!st.versions[slug]?.length && previous) version(slug, previous, null);
      version(slug, st.kids[slug], 'staff@soard.org');
      st.waiting.add(slug);
      return json({ success: true, sha: `sha-${slug}-${Date.now()}` });
    }
    if (p === '/api/delete-content') {
      const slug = body().path.match(/kids\/(.+)\.json$/)?.[1];
      if (!st.kids[slug]) return json({ success: false, error: 'not found' }, 404);
      version(slug, st.kids[slug], 'staff@soard.org', 'delete');
      delete st.kids[slug];
      return json({ success: true });
    }
    if (p === '/api/reorder-content') {
      const b = body();
      if (b.collection !== 'kids') return json({ success: false, error: 'wrong list' }, 403);
      const changed = [];
      for (const it of b.items) if (st.kids[it.slug] && st.kids[it.slug].sortOrder !== it.order) { st.kids[it.slug] = { ...st.kids[it.slug], sortOrder: it.order }; changed.push(it.slug); }
      changed.forEach((s) => st.waiting.add(s));
      return json({ success: true, changed, shas: {} });
    }
    if (p === '/api/content-history') {
      const q = url.searchParams;
      if (q.get('deleted')) {
        const deleted = Object.entries(st.versions).filter(([s2, v]) => v.at(-1).action === 'delete' && !st.kids[s2])
          .map(([s2, v]) => ({ id: v.at(-1).id, slug: s2, name: v.at(-1).data.name, year: v.at(-1).data.year, image: v.at(-1).data.heroImage, at: v.at(-1).at, by: v.at(-1).by }));
        return json({ success: true, deleted });
      }
      const list = st.versions[q.get('slug')] || [];
      if (q.get('id')) { const v = list.find((x) => x.id === Number(q.get('id'))); return v ? json({ success: true, data: v.data }) : json({ success: false, error: 'That version is gone' }, 404); }
      return json({ success: true, versions: list.map((v, i) => ({ id: v.id, at: v.at, by: v.by, action: v.action, changed: i ? changed(list[i - 1].data, v.data) : null })).reverse() });
    }
    if (p === '/api/upload-image') {
      if (st.failUploads) return json({ success: false, error: 'Image too large. Maximum size is 10 MB.' }, 413);
      st.uploads++;
      const n = st.uploads;
      // The image name, checked as functions/api/upload-image.js checks it (a binary body needs fetchPostData)
      const named = req.fetchPostData().catch(() => null).then((raw) => {
        const id = String(raw ?? req.postData() ?? '').match(/name="id"\r\n\r\n([^\r\n]*)/)?.[1] || '';
        st.ids.push(id);
        // (a body Chrome can't hand over, like a file made in the page, has no name to check)
        return id && (id.length > 256 || id.includes('..') || !/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(id)) ? 'Invalid image id. Use letters, numbers, and / _ . - only (max 256 chars).' : null;
      });
      // A request the page stopped can't be answered any more
      const answer = () => named.then((bad) => (bad ? json({ success: false, error: bad }, 400) : json({ success: true, imageId: `kids/test/up-${n}`, imageUrl: `https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/test/up-${n}/public` }))).catch(() => {});
      if (st.slowFirst) { const ms = st.slowFirst; st.slowFirst = 0; setTimeout(answer, ms); return true; }
      if (st.slowUploads) { setTimeout(answer, st.slowUploads); return true; }
      answer();
      return true;
    }
    // SOARD's Zeffy forms, for the Fundraising link's dropdown
    if (p === '/api/zeffy-forms') return json({ success: true, forms: [{ id: 'f-amari', title: 'Help build Amari’s room', url: 'https://www.zeffy.com/donation-form/amari', kind: 'donation', open: true, created: 1 }] });
    if (p === '/api/kid-homes' && st.slowHomes) { const ms = st.slowHomes; setTimeout(() => Promise.resolve().then(() => json({ success: true, homes: [{ slug: 'axel', lat: 33.749, lng: -84.388 }] })).catch(() => {}), ms); return true; }
    if (p === '/api/kid-homes') return st.homesFail ? json({ success: false, error: 'JobTread is down' }, 500) : json({ success: true, homes: [{ slug: 'axel', lat: 33.749, lng: -84.388 }] });
    if (p === '/api/upload-video') {
      const uid = VID(++st.videos);
      st.tus[uid] = body().fileSize;
      return json({ success: true, uploadUrl: `${TUS}${uid}`, videoId: uid });
    }
    if (p === '/api/generate') {
      const b = body();
      if (b.type === 'alt-text') return json({ success: true, altTexts: (b.kid.photos || []).map((x, i) => `Described photo ${i + 1}`) });
      if (b.type === 'hero-summary') return json({ success: true, heroSummary: `${b.kid.name} is a test. SOARD built a room.` });
      if (b.type === 'seo') return json({ success: true, shortDescription: 'Short.', metaDescription: 'Meta description.' });
      return json({ success: false, error: 'type' }, 400);
    }
    if (p === '/api/stream-check') return json({ success: true, state: url.searchParams.get('uid')?.startsWith('6f3b') ? 'playable' : 'gone' });
    // The Home card (/api/job-home): Colin's job has a home in JobTread; Amari's has none yet (scripts/test-kid-home.mjs covers the card)
    if (p === '/api/job-home') {
      const job = url.searchParams.get('job');
      const fields = [{ id: 'z', name: 'Zestimate', type: 'number', position: 'a0' }, { id: 'y', name: 'Year Built', type: 'text', position: 'a1' }];
      return json({ success: true, job: { id: job, name: '' }, fields, home: job === '22PCOLIN' ? { id: 'loc1', street: '1 Main St', address: '1 Main St, Marietta, GA 30060, USA', city: 'Marietta', state: 'GA', postalCode: '30060', url: 'https://app.jobtread.com/locations/loc1', values: { z: 336500, y: '2000' } } : null });
    }
    if (p === '/api/reveals-admin') return json({ success: true, reveals: [{ slug: 'colin', name: 'Colin', date: '2026-10-25', confirmed: true }, { slug: 'axel', name: 'Axel', date: '2026-11-08', confirmed: false }], jobs: { amari: '22PAMARI', colin: '22PCOLIN' }, statuses: { amari: 'Closed Done', colin: 'Build' } });
    if (p.startsWith('/api/pending-changes')) {
      return json({ success: true, changes: [...st.waiting].map((slug) => ({ type: 'kids', slug, name: st.kids[slug]?.name, state: 'waiting', action: 'updated', at: new Date().toISOString() })), publish: { live: null, active: null, failed: null, typicalSeconds: 480 } });
    }
    if (p.startsWith('/api/audit-log')) return json({ success: true, entries: [], total: 0 });
    if (p.startsWith('/api/deployments')) return json({ success: true, deploys: [], source: 'cloudflare' });
    if (p.startsWith('/api/live-ws')) { req.abort(); return true; }
    return json({ success: true, ok: true });
  };
  // Stream's resumable upload (tus) on its own host, where a video's bytes go after /api/upload-video
  const tus = (req) => {
    const len = String(st.tus[new URL(req.url()).pathname.split('/').pop()] || 0);
    const h = { 'Access-Control-Allow-Origin': SITE, 'Access-Control-Allow-Methods': 'HEAD, PATCH, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Tus-Resumable, Upload-Offset, Upload-Length, Content-Type',
      'Access-Control-Expose-Headers': 'Upload-Offset, Upload-Length, Tus-Resumable, Location', 'Tus-Resumable': '1.0.0', 'Cache-Control': 'no-store' };
    if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: h, body: '' });
    if (req.method() === 'HEAD') return req.respond({ status: 200, headers: { ...h, 'Upload-Offset': '0', 'Upload-Length': len }, body: '' });
    st.tusPatches = (st.tusPatches || 0) + 1;
    return req.respond({ status: 204, headers: { ...h, 'Upload-Offset': len }, body: '' });
  };
  return { st, respond, tus };
}

// prep(st): change the fake data before the admin loads it
async function open(browser, { width, height, mobile, prep }) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|net::ERR/.test(m.text())) errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 300)}`));
  page.on('dialog', (d) => d.accept());
  await answerAsks(page);
  const api = makeApi();
  prep?.(api.st);
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.isInterceptResolutionHandled()) return;
    if (req.url().startsWith(TUS)) return api.tus(req);
    if (new URL(req.url()).origin === SITE && api.respond(req) !== false) return;
    // Images: answered locally (the network isn't what's under test)
    if (req.resourceType() === 'image' && /imagedelivery|i\.ytimg|videodelivery/.test(req.url())) {
      if (isBrokenImage(req.url())) return req.respond({ status: 404, contentType: 'text/plain', body: 'not found' });
      return req.respond({ status: 200, contentType: 'image/png', body: readFileSync(PNG) });
    }
    req.continue();
  });
  await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch {} });
  await page.goto(`${SITE}/admin/index.html`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.nav-item, .sidebar', { timeout: 20000 });
  return { page, api, errors };
}

const clickText = (page, sel, text) => page.evaluate((sel, text) => {
  const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.replace(/\s+/g, ' ').trim().startsWith(text));
  if (el) el.click();
  return !!el;
}, sel, text);
async function shot(page, name, { grow = true } = {}) {
  const vp = page.viewport();
  try {
    const h = grow ? await page.evaluate(() => Math.min(Math.max(document.documentElement.scrollHeight, document.querySelector('.main')?.scrollHeight || 0), 9000)) : 0;
    if (h > vp.height) await page.setViewport({ ...vp, height: h });
    await page.screenshot({ path: join(OUT, `${name}.png`) });
  } catch (e) {
    console.log(`  (screenshot ${name} failed: ${e.message.slice(0, 80)})`);
  } finally {
    if (page.viewport()?.height !== vp.height) await page.setViewport(vp).catch(() => {});
  }
  for (const f of await hoverSweep(page, hoverSeen)) ok(false, `${name}: “${f.text}” in “${f.label}” drops to ${f.hover}:1 under the pointer (${f.resting}:1 resting, ${f.colors})`);
}
// Hover an element and return its label's contrast ratio against its own fill (WCAG formula)
async function hoverContrast(page, sel) {
  await page.hover(sel);
  await sleep(250);
  const ratio = await page.$eval(sel, (el) => {
    const lum = (c) => { const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const s = getComputedStyle(el);
    const [a, b] = [lum(s.color), lum(s.backgroundColor)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  });
  await page.mouse.move(0, 0);
  return ratio;
}
async function goKids(page, mobile) {
  if (mobile) { await page.evaluate(() => document.querySelector('.hamburger')?.click()); await sleep(350); }
  await clickText(page, '.nav-item', 'Kids');
  await page.waitForSelector('.kd-row', { timeout: 15000 });
  await sleep(400);
}
const sectionNames = (page, title) => page.evaluate((t) => {
  const sec = [...document.querySelectorAll('.kd-section')].find((s) => s.querySelector('h3')?.textContent.trim().startsWith(t));
  return sec ? [...sec.querySelectorAll(':scope > .kd-rows .kd-row__name')].map((n) => n.textContent.trim()) : null;
}, title);
const sectionSlugs = (page, title) => page.evaluate((t) => {
  const sec = [...document.querySelectorAll('.kd-section')].find((s) => s.querySelector('h3')?.textContent.trim().startsWith(t));
  return sec ? [...sec.querySelectorAll(':scope > .kd-rows .kd-row')].map((r) => r.dataset.slug) : null;
}, title);
// Waits for the window to stop scrolling (smooth scrolls), up to 3 s
const settle = async (page) => {
  let last = -1;
  for (let i = 0; i < 30; i++) { const y = await page.evaluate(() => scrollY); if (y === last) return; last = y; await sleep(100); }
};
const lastCall = (api, path) => [...api.st.calls].reverse().find((c) => c.path === path);
const callsTo = (api, path) => api.st.calls.filter((c) => c.path === path).length;
const clickToast = (page, label) => page.evaluate((l) => { const b = [...document.querySelectorAll('.toast-undo')].reverse().find((x) => x.textContent.trim() === l); b?.click(); return !!b; }, label);
const openKid = async (page, name) => {
  await page.evaluate((n) => {
    const row = [...document.querySelectorAll('.kd-row__name')].find((x) => x.textContent.trim() === n);
    if (row) { row.click(); return; }
    // Closed year: open them all, then try again
    document.querySelectorAll('.kd-year__btn[aria-expanded="false"]').forEach((b) => b.click());
  }, name);
  if (!(await page.$('.kd-ed-head'))) {
    await sleep(300);
    await page.evaluate((n) => [...document.querySelectorAll('.kd-row__name')].find((x) => x.textContent.trim() === n)?.click(), name);
  }
  await page.waitForSelector('.kd-ed-head', { timeout: 10000 }).catch(async (e) => {
    console.log('DEBUG openKid:', name, (await page.evaluate(() => document.querySelector('.main')?.innerText.slice(0, 500))).replace(/\n+/g, ' | '));
    throw e;
  });
  await sleep(500);
};
// past: how far beyond the target's middle to let go (a row moves once you pass its middle)
const dragBetween = async (page, fromSel, toSel, { steps = 12, past = 0 } = {}) => {
  const a = await page.$eval(fromSel, (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const b0 = await page.$eval(toSel, (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const b = { x: b0.x, y: b0.y + Math.sign(b0.y - a.y) * past };
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps); await sleep(25); }
  await sleep(150);
  await page.mouse.up();
  await sleep(400);
};
const overflowing = (page) => page.evaluate(() => {
  const main = document.querySelector('.main');
  const right = main.getBoundingClientRect().right;
  const scrollers = [...document.querySelectorAll('.main *')].filter((el) => /auto|scroll/.test(getComputedStyle(el).overflowX));
  return [...document.querySelectorAll('.main *')]
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width && r.right > right + 1 && !scrollers.some((s) => s !== el && s.contains(el)); })
    .slice(0, 6).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} → ${Math.round(el.getBoundingClientRect().right)}`);
});
const smallTargets = (page, sel) => page.evaluate((sel) => [...document.querySelectorAll(sel)]
  .filter((el) => { const r = el.getBoundingClientRect(); return r.width && r.height && getComputedStyle(el).visibility !== 'hidden' && (r.height < 43.5 || r.width < 43.5); })
  .slice(0, 6).map((el) => `${el.className || el.tagName} ${Math.round(el.getBoundingClientRect().width)}×${Math.round(el.getBoundingClientRect().height)} “${el.textContent.trim().slice(0, 20)}”`), sel);

const kidsList = Object.values(KIDS0);
const expectWarn = kidsList.filter((k) => KS.kidIssues(k).some((i) => i.tone === 'warn')).length;
const expectBuilding = kidsList.filter((k) => k.status === 'in-progress').sort((a, b) => (a.sortOrder ?? 1e9) - (b.sortOrder ?? 1e9) || (b.year || 0) - (a.year || 0)).map((k) => k.name);
const served = kidsList.filter(KS.isListed).reduce((n, k) => n + (Number(k.childCount) || 1), 0);
const amari = KIDS0.amari;
const newPartner = Object.values(PARTNERS).find((p) => p.logo && !amari.partnerLogos.some((l) => l.url === p.logo) && /^[A-Z][a-z]+ [A-Z]/.test(p.name));

// A dev server from before the runtime-only site keys were left out can write
// them back; the kid pages then fail to build in dev (see scripts/d1-helpers.js)
for (const f of ['broadcast-schedule-lock', 'reveal-invites-guest-check']) { try { rmSync(join(ROOT, 'src/content/site', `${f}.json`)); } catch {} }

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 90000,
  args: ['--disable-gpu', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'] });
try {
  // ════════ Desktop ════════
  console.log('Desktop 1440: the list');
  {
    const { page, api, errors } = await open(browser, { width: 1440, height: 1000, mobile: false });
    await goKids(page, false);
    const sub = await page.$eval('.kd-head .page-sub', (e) => e.textContent);
    ok(sub.startsWith(`${kidsList.length} profiles · ${served} kids served`), `the header counts profiles and kids served (${sub.slice(0, 40)})`);
    ok(JSON.stringify(await sectionNames(page, 'Awaiting funding')) === JSON.stringify(kidsList.filter((k) => k.status === 'needs-funding').map((k) => k.name)), 'Awaiting funding lists the families waiting');
    ok(JSON.stringify(await sectionNames(page, 'In build')) === JSON.stringify(expectBuilding), `In build follows sortOrder (${expectBuilding.join(', ')})`);
    const years = await page.$$eval('.kd-year__btn', (bs) => bs.map((b) => [b.querySelector('.kd-year__label').textContent, b.getAttribute('aria-expanded')]));
    ok(years.length > 10 && years.slice(0, 3).every((y) => y[1] === 'true') && years.slice(3).every((y) => y[1] === 'false'), `Completed is grouped by year, the newest three open (${years.slice(0, 4).map((y) => y.join(':')).join(' ')})`);
    ok(await page.evaluate(() => [...document.querySelectorAll('.kd-row')].some((r) => /Colin/.test(r.textContent) && /Reveal Sun, Oct 25/.test(r.textContent))), 'a confirmed reveal date shows on its row');
    ok(await page.evaluate(() => [...document.querySelectorAll('.kd-row')].some((r) => /Axel/.test(r.textContent) && /tentatively/.test(r.textContent))), 'a tentative reveal says so');
    ok(await page.evaluate(() => /Home page/.test([...document.querySelectorAll('.kd-row')].find((r) => r.querySelector('.kd-tag--home'))?.textContent || '')), 'the first kid in build is marked as the home page feature');
    const attention = await page.$eval('.kd-filter:nth-child(2) span', (e) => Number(e.textContent));
    ok(attention === expectWarn, `Needs attention counts what kids-shared.js flags (${attention} = ${expectWarn})`);
    ok(await page.$eval('.kd-tidy-banner', (e) => /partner logos? without a name/.test(e.textContent) && /without alt text/.test(e.textContent)), 'Profiles to tidy names both bulk fixes');
    ok(!(await page.evaluate(() => [...document.querySelectorAll('.kd-row__issues .kd-chip')].some((c) => /alt text|unnamed/.test(c.textContent)))), 'rows leave bulk fixes to the tidy banner');
    await shot(page, 'desk-list');

    // "/" jumps to search; the photo wall
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('/');
    ok(await page.evaluate(() => document.activeElement?.matches('.kd-search input')), '“/” puts the cursor in search');
    await page.keyboard.press('Escape');
    await page.evaluate(() => [...document.querySelectorAll('.kd-view button')].find((b) => /Photos/.test(b.textContent)).click());
    await sleep(200);
    ok(await page.$$eval('.kd-wall .kd-wall__btn', (b) => b.length) > 10 && !(await page.$('.kd-section:last-of-type .kd-row')), 'completed rooms show as a photo wall');
    await page.evaluate(() => [...document.querySelectorAll('.kd-view button')].find((b) => /List/.test(b.textContent)).click());
    await sleep(200);
    ok(await page.evaluate(() => /missing from pages/.test(document.querySelector('.kd-tidy-banner')?.textContent || '')), 'Profiles to tidy counts partner logos missing from pages');

    // Search and the filter
    await page.type('.kd-search input', 'cerebral');
    await sleep(250);
    const found = await page.$$eval('.kd-row__name', (ns) => ns.length);
    ok(found > 3 && found < 60, `search narrows the list (${found} rows for “cerebral”)`);
    ok(await page.$$eval('.kd-grip', (g) => g.length) === 0, 'no reordering while the list is narrowed');
    await page.click('.kd-search input', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.click('.kd-filter:nth-child(2)');
    await sleep(250);
    ok(await page.$$eval('.kd-row', (rs) => rs.length) === expectWarn, 'Needs attention shows exactly those profiles');
    const pressedHover = await hoverContrast(page, '.kd-filter[aria-pressed="true"]');
    ok(pressedHover >= 4.5, `a selected filter keeps its label readable under the pointer (${pressedHover.toFixed(1)}:1)`);
    await page.click('.kd-filter:nth-child(1)');
    await sleep(250);

    // Reorder In build by keyboard: second row up one
    const before = await sectionNames(page, 'In build');
    const beforeSlugs = await sectionSlugs(page, 'In build');
    await page.evaluate(() => {
      const sec = [...document.querySelectorAll('.kd-section')].find((s) => /In build/.test(s.querySelector('h3').textContent));
      sec.querySelectorAll('.kd-grip')[1].focus();
    });
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowUp');
    await sleep(150);
    await page.keyboard.press('Space');
    await sleep(700);
    const reorder = lastCall(api, '/api/reorder-content');
    const sent = reorder?.body?.items?.map((i) => i.slug) || [];
    const expected = [...kidsList.filter((k) => k.status === 'needs-funding').map((k) => k.slug), beforeSlugs[1], beforeSlugs[0], ...beforeSlugs.slice(2)];
    ok(reorder?.body?.collection === 'kids' && JSON.stringify(sent) === JSON.stringify(expected) && reorder.body.items.every((it, i) => it.order === i),
      'Space, ↑, Space saves every active kid’s place in one request');
    ok(JSON.stringify(await sectionNames(page, 'In build')) === JSON.stringify([before[1], before[0], ...before.slice(2)]), 'the row moved up');
    const n = callsTo(api, '/api/reorder-content');
    ok(await clickToast(page, 'Undo'), 'the toast offers Undo');
    await sleep(700);
    ok(callsTo(api, '/api/reorder-content') === n + 1 && JSON.stringify(await sectionNames(page, 'In build')) === JSON.stringify(before), 'Undo puts the order back');

    // Reorder by dragging the grip: first row down two
    const before2 = await sectionNames(page, 'In build');
    await page.evaluate(() => window.scrollTo(0, 0));
    const grips = '.kd-section:nth-of-type(2) .kd-grip';
    await page.evaluate(() => {
      const sec = [...document.querySelectorAll('.kd-section')].find((s) => /In build/.test(s.querySelector('h3').textContent));
      sec.querySelectorAll('.kd-grip').forEach((g, i) => g.setAttribute('data-t', `g${i}`));
    });
    await dragBetween(page, '[data-t="g0"]', '[data-t="g2"]', { past: 10 });
    await sleep(500);
    const after2 = await sectionNames(page, 'In build');
    ok(after2[2] === before2[0] && after2[0] === before2[1], `dragging the grip moves the row (${after2.slice(0, 3).join(', ')})`);
    ok(callsTo(api, '/api/reorder-content') === n + 2, 'and saves once');

    // Row menu: Mark as completed, then Undo
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('.kd-row')].find((r) => r.querySelector('.kd-row__name')?.textContent.trim() === 'Max');
      row.querySelector('.ppl-menu__btn').click();
    });
    await sleep(200);
    await clickText(page, '.ppl-menu__pop [role="menuitem"]', 'Mark as completed');
    await sleep(700);
    ok(api.st.kids.max.status === 'completed', 'Mark as completed saves the status');
    ok(!(await sectionNames(page, 'In build')).includes('Max'), 'and the row leaves In build');
    await clickToast(page, 'Undo');
    await sleep(700);
    ok(api.st.kids.max.status === 'in-progress', 'Undo puts the status back');

    // Colin has a JobTread job: his status comes from there
    ok(await page.evaluate(() => /JobTread: Build/.test([...document.querySelectorAll('.kd-row')].find((r) => r.dataset.slug === 'colin')?.textContent || '')), 'a kid with a JobTread job shows its JobTread status');
    await page.evaluate(() => [...document.querySelectorAll('.kd-row')].find((r) => r.dataset.slug === 'colin').querySelector('.ppl-menu__btn').click());
    await sleep(200);
    const menu = await page.$$eval('.ppl-menu__pop [role="menuitem"]', (m) => m.map((x) => x.textContent.trim()));
    ok(!menu.some((t) => /^Mark as/.test(t)) && menu.some((t) => /^Change status in JobTread/.test(t)), `and its menu sends status changes to JobTread (${menu.filter((t) => /status|Mark/.test(t)).join(', ')})`);
    await page.keyboard.press('Escape');
    await sleep(200);
    await openKid(page, 'Colin');
    ok(!(await page.$('.kd-card--status .kd-status-pick')) && /Follows JobTread, where the job is at Build/.test(await page.$eval('.kd-card--status', (e) => e.textContent)), 'in the editor the status is read-only, from JobTread');
    ok(await page.$eval('.kd-card--status a[href*="jobtread.com/jobs/22PCOLIN"]', (a) => !!a), 'with a link to change it in JobTread');
    ok(!errors.length, `no console errors (${errors.join(' | ').slice(0, 300)})`);
    await page.close();
  }

  console.log('Desktop 1440: Dropbox folders to name');
  {
    const ellie = Object.values(KIDS0).find((k) => /^Ellie\b/.test(k.name || ''));
    const folders = [
      { folder: 'Zed Story 2014', photos: 49, videos: 0, decision: null, url: 'https://www.dropbox.com/home/SOARD-Main/Makeover%20Photos/Zed%20Story%202014', guesses: [] },
      { folder: `${ellie?.name || 'Ellie'} Grant ${ellie?.year || 2023}`, photos: 181, videos: 4, decision: null, url: 'https://www.dropbox.com/home/x', guesses: ellie ? [{ slug: ellie.slug, name: ellie.name, year: ellie.year }] : [] },
    ];
    const { page, api, errors } = await open(browser, { width: 1440, height: 1000, mobile: false, prep: (s) => { s.folders = structuredClone(folders); } });
    await goKids(page, false);
    const banner = await page.$eval('.kd-fold-banner', (e) => e.textContent.replace(/\s+/g, ' ')).catch(() => '');
    ok(/Dropbox folders to name/.test(banner) && /2 folders of makeover photos/.test(banner), `the banner counts the folders to name (${banner.slice(0, 80)})`);
    await clickText(page, '.kd-fold-banner button', 'Name them');
    await page.waitForSelector('.kd-fold', { timeout: 5000 });
    const rows = await page.$$eval('.kd-fold', (ls) => ls.map((l) => l.querySelector('.kd-fold__name').textContent));
    ok(rows.length === 2, `the dialog lists both folders (${rows.join(', ')})`);
    ok(await page.$eval('.kd-fold .kd-fold__open', (a) => a.target === '_blank' && /dropbox\.com/.test(a.href)), 'each opens in Dropbox in a new tab');
    // A kid page, from the guess
    if (ellie) {
      const row = await page.evaluateHandle(() => [...document.querySelectorAll('.kd-fold')].find((l) => /Grant/.test(l.textContent)));
      ok(await row.evaluate((l) => /Maybe /.test(l.textContent)), 'a likely kid page is suggested');
      const sel = await row.$('select');
      await sel.select(`kid:${ellie.slug}`);
      await (await row.$('.btn-primary')).click();
      await sleep(400);
      ok(await page.evaluate(() => [...document.querySelectorAll('.kd-fold')].some((l) => /Grant/.test(l.textContent) && l.classList.contains('is-done') && /Linzi/.test(l.textContent))), 'saved: the answer shows with who named it');
      const posted = api.st.calls.filter((c) => c.path === '/api/kid-folders-admin' && c.method === 'POST').at(-1)?.body;
      ok(posted?.decision === 'kid' && posted?.kidSlug === ellie.slug, 'it sends the kid page picked');
    }
    // A kid with no page: name and year; Save waits for a name
    const zedSel = () => page.evaluateHandle(() => [...document.querySelectorAll('.kd-fold')].find((l) => /Zed Story/.test(l.textContent)));
    await (await (await zedSel()).$('select')).select('new');
    await sleep(200);
    const zed = await zedSel();
    const inputs = await zed.$$('input.form-input');
    ok(inputs.length === 2 && (await inputs[1].evaluate((i) => i.value)) === '2014', 'a kid with no page asks for name and year, the year filled from the folder');
    ok(await zed.$eval('.btn-primary', (b) => b.disabled), 'Save waits for a name');
    await inputs[0].type('Zed Story');
    await (await zed.$('.btn-primary')).click();
    await sleep(400);
    ok(await page.evaluate(() => [...document.querySelectorAll('.kd-fold')].some((l) => /Zed Story \(2014\), no page yet/.test(l.textContent))), 'a kid with no page is saved with name and year');
    await clickText(page, '.kd-dialog__foot .btn', 'Done');
    await sleep(300);
    ok(!(await page.$('.kd-fold-banner')), 'with every folder named, the banner goes');
    await shot(page, 'desktop-kid-folders');
    ok(errors.length === 0, `no console errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
    await page.close();
  }

  console.log('Desktop 1440: the editor');
  {
    const { page, api, errors } = await open(browser, { width: 1440, height: 1000, mobile: false });
    await goKids(page, false);
    await openKid(page, 'Amari');
    ok(await page.$eval('.kd-ed-id h2', (e) => e.textContent.startsWith('Amari')), 'the editor opens on Amari');
    ok(await page.$$eval('.kd-bar__chip', (c) => c.length) === 9, 'the section bar has all nine sections');
    ok(await page.$('.kd-bar__state.is-saved'), 'opening a profile leaves nothing unsaved');
    const panel = await page.evaluate(() => { const r = document.querySelector('.kd-rail').getBoundingClientRect(); const m = document.querySelector('.kd-main').getBoundingClientRect(); return { side: r.left > m.right, w: Math.round(r.width) }; });
    ok(panel.side && panel.w === 300, `status, health and the page sit in a side panel (${panel.w}px)`);
    const health = await page.$eval('.kd-card--health h3', (h) => h.textContent);
    const amariChecks = KS.kidChecks(KS.kidRecord({ ...amari }));
    ok(health.includes(`${amariChecks.filter((c) => c.done).length} of ${amariChecks.length}`), `profile health counts what’s done (${health.replace('Profile health', '').trim()})`);
    await page.evaluate(() => [...document.querySelectorAll('.kd-checks button')].find((b) => /Plan captions/.test(b.textContent))?.click());
    await sleep(200);
    await settle(page);
    ok(await page.evaluate(() => { const r = document.getElementById('kd-sec-plans').getBoundingClientRect(); return r.top >= 0 && r.top < 160; }), 'a health item jumps to the section that fixes it');
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, 'desk-editor');

    // Rooms: + Therapy room, then − (unsaved clears again)
    const therapyPlus = await page.evaluateHandle(() => [...document.querySelectorAll('.kd-builds__list li')].find((li) => /Therapy room/.test(li.textContent)).querySelectorAll('button')[1]);
    await therapyPlus.click();
    await sleep(150);
    ok(await page.$('.kd-bar__state.is-dirty') && await page.$('.kd-bar__save .kd-save'), 'a change shows Unsaved changes, with Save');
    ok(await page.evaluate(() => /Adds 3 to “rooms built”/.test(document.querySelector('.kd-builds .form-hint').textContent)), 'the room summary counts three rooms');
    const therapyMinus = await page.evaluateHandle(() => [...document.querySelectorAll('.kd-builds__list li')].find((li) => /Therapy room/.test(li.textContent)).querySelectorAll('button')[0]);
    await therapyMinus.click();
    await sleep(150);
    ok(await page.$('.kd-bar__state.is-saved'), 'undoing the change by hand clears it');
    // Discard puts the saved version back, with Undo
    await therapyPlus.click();
    await page.type('#kd-diagnosis', ' (test)');
    await clickText(page, '.kd-bar__save .btn', 'Discard');
    await sleep(250);
    ok(await page.$eval('#kd-diagnosis', (e) => e.value) === amari.diagnosis && await page.$('.kd-bar__state.is-saved'), 'Discard puts the saved version back');
    await clickToast(page, 'Undo');
    await sleep(250);
    ok(/\(test\)$/.test(await page.$eval('#kd-diagnosis', (e) => e.value)), 'and Undo brings the changes back');
    await page.click('#kd-diagnosis', { clickCount: 3 });
    await page.type('#kd-diagnosis', amari.diagnosis);

    // The section bar jumps
    await page.evaluate(() => [...document.querySelectorAll('.kd-bar__chip')].find((c) => c.textContent.startsWith('Partners')).click());
    await sleep(200);
    await settle(page);
    await sleep(400);
    ok(await page.evaluate(() => { const r = document.getElementById('kd-sec-partners').getBoundingClientRect(); return r.top >= 0 && r.top < 160; }), 'a section chip scrolls to its section, clear of the sticky bar');
    ok(await page.$eval('.kd-bar__chip.is-active', (c) => c.textContent.startsWith('Partners')), 'and the chip shows where you are');

    // Photo dialog: alt text and main photo
    const firstUrl = amari.photos[0].url;
    await page.evaluate(() => document.getElementById('kd-sec-photos').scrollIntoView());
    await sleep(200);
    await page.evaluate(() => document.querySelectorAll('.kd-tile__open')[2].click());
    await page.waitForSelector('.kd-photo-dlg', { timeout: 5000 });
    ok(await page.$eval('.kd-photo-dlg h2', (e) => e.textContent.trim()) === `Photo 3 of ${amari.photos.length}`, 'a photo opens large, with its place');
    await page.type('#kd-photo-alt', 'Amari laughing in his new room');
    await page.evaluate(() => [...document.querySelectorAll('.kd-role')].find((b) => /Main photo/.test(b.textContent)).click());
    await sleep(150);
    await page.keyboard.press('Escape');
    await sleep(300);
    ok(!(await page.$('.kd-photo-dlg')), 'Escape closes the photo');
    ok(await page.evaluate(() => !document.querySelectorAll('.kd-tile')[2].querySelector('.kd-tile__noalt')), 'the tile loses its Alt flag');
    ok(await page.evaluate(() => /Main/.test(document.querySelectorAll('.kd-tile')[2].querySelector('.kd-tile__role')?.textContent || '')), 'and it is the main photo now');

    // Reorder photos with the keyboard: tile 2 → right one
    const keyAt = (i) => page.evaluate((i) => document.querySelectorAll('.kd-tile img')[i].getAttribute('src'), i);
    const t1 = await keyAt(1);
    await page.evaluate(() => document.querySelectorAll('.kd-tile')[1].querySelector('[data-kd-grip]').focus());
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowRight');
    await sleep(120);
    await page.keyboard.press('Space');
    await sleep(300);
    ok(await keyAt(2) === t1, 'Space, →, Space moves a photo one place');
    // …and by dragging a tile with the mouse: tile 6 onto tile 1
    const t5 = await keyAt(5);
    await page.evaluate(() => document.querySelectorAll('.kd-tile').forEach((t, i) => t.setAttribute('data-t', `t${i}`)));
    await page.evaluate(() => document.querySelector('[data-t="t0"]').scrollIntoView({ block: 'center' }));
    await sleep(200);
    await dragBetween(page, '[data-t="t5"] .kd-tile__open', '[data-t="t0"] .kd-tile__open', { steps: 16 });
    ok(await keyAt(0) === t5, 'dragging a photo onto the first tile makes it first');
    ok(!(await page.$('.kd-photo-dlg')), 'a drag doesn’t open the photo');

    // Removing the main photo: the first photo takes over, Undo restores
    const heroTile = await page.evaluate(() => [...document.querySelectorAll('.kd-tile')].findIndex((t) => t.querySelector('.kd-tile__role.is-hero')));
    await page.evaluate((i) => document.querySelectorAll('.kd-tile__open')[i].click(), heroTile);
    await page.waitForSelector('.kd-photo-dlg');
    await clickText(page, '.kd-dialog__foot .btn', 'Remove photo');
    await sleep(300);
    ok(await page.evaluate(() => !!document.querySelectorAll('.kd-tile')[0].querySelector('.kd-tile__role.is-hero')), 'removing the main photo makes the first photo the main one');
    await clickToast(page, 'Undo');
    await sleep(300);
    ok(await page.$$eval('.kd-tile', (t) => t.length) === amari.photos.length, 'Undo puts the photo back');

    // Upload two photos: alt text is written for them afterwards
    const input = await page.$('#kd-sec-photos input[type=file]');
    await input.uploadFile(PNG, PNG);
    await page.waitForFunction((n) => document.querySelectorAll('.kd-tile').length === n && !document.querySelector('.kd-tile__busy'), { timeout: 15000 }, amari.photos.length + 2);
    ok(callsTo(api, '/api/upload-image') === 2, 'two uploads');
    const gen = api.st.calls.filter((c) => c.path === '/api/generate' && c.body?.type === 'alt-text').pop();
    ok(gen && gen.body.kid.photos.length === 2 && gen.body.kid.photos.every((p) => /kids\/test\/up-/.test(p.url)), 'alt text is written for just the new photos');

    // Plans: a floor plan caption hides the address block
    await page.evaluate(() => document.getElementById('kd-sec-plans').scrollIntoView());
    const cap = await page.$('.kd-plan input');
    await cap.click({ clickCount: 3 });
    await cap.type('Floor plan, after');
    ok(await page.$eval('.kd-plan .kd-plan__meta', (e) => /Address block hidden/.test(e.textContent)), 'a floor plan caption crops the address block');

    // Partners: add one from the directory
    const nLogos = await page.$$eval('.kd-logo', (l) => l.length);
    await page.type('#kd-partner-q', newPartner.name.slice(0, 6));
    await sleep(200);
    await page.evaluate((name) => [...document.querySelectorAll('#kd-partner-list [role=option]')].find((o) => o.textContent.includes(name))?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })), newPartner.name);
    await sleep(200);
    ok(await page.$$eval('.kd-logo', (l) => l.length) === nLogos + 1, `adding ${newPartner.name} from the directory adds its logo`);

    // Video: the uploaded video plays (Stream says so)
    ok(await page.$eval('.kd-plays strong', (e) => e.textContent) === 'The page plays the uploaded video', 'the Video section says which video the page plays');

    // A saved link that isn't a Zeffy form: a warning (never a problem), and "No form" takes it off
    await page.waitForFunction(() => !document.querySelector('#kd-fund')?.disabled, { timeout: 8000 });
    ok(await page.$eval('#kd-sec-giving', (e) => /What’s saved isn’t a Zeffy form: pick one/.test(e.querySelector('.zf-link__warn')?.textContent || '') && !e.querySelector('.zf-link__bad')), 'a saved link that isn’t a Zeffy form is a warning');
    await page.select('#kd-fund', '__none');
    await sleep(100);
    ok(await fundLink(page) === '' && !(await page.$('#kd-sec-giving .zf-link__warn')), '“No form” takes the link off');

    // The fundraising link: one of SOARD's Zeffy forms, picked; its link comes from Zeffy, nothing typed
    ok(await page.$$eval('#kd-fund option', (os) => os.some((o) => o.textContent.trim() === 'Help build Amari’s room')), 'Giving lists SOARD’s Zeffy forms');
    ok(!(await page.$('#kd-sec-giving input[type="url"]')), 'with no link box to paste into');
    await page.select('#kd-fund', 'f-amari');
    await sleep(100);
    ok(await fundLink(page) === 'https://www.zeffy.com/donation-form/amari', 'picking a form puts its link behind Open');

    // Save: the record as the site reads it
    await page.keyboard.down('Meta');
    await page.keyboard.press('KeyS');
    await page.keyboard.up('Meta');
    await sleep(900);
    const saved = JSON.parse(lastCall(api, '/api/save-content')?.body?.content || '{}');
    const raw = JSON.stringify(saved);
    ok(callsTo(api, '/api/save-content') === 1, 'Save writes once');
    ok(!/"_(key|tempId|ages)"/.test(raw) && !('scheduledPublish' in saved), 'no editor-only fields in the saved record');
    ok(saved.roomTypes?.includes('Therapy Room') && saved.roomCount === 3 && saved.therapyRoomCount === 1, 'rooms saved from the counts');
    ok(saved.photos.find((p) => p.alt === 'Amari laughing in his new room') && saved.photoCount === saved.photos.length, 'alt text and photo count saved');
    ok(saved.photos.filter((p) => /up-\d/.test(p.url)).every((p) => /^Described photo/.test(p.alt)), 'uploaded photos saved with their alt text');
    ok(saved.partnerLogos.every((l) => String(l.name || '').trim()) && saved.partnerLogos.some((l) => l.url === newPartner.logo), 'every partner logo is named, the new one included');
    ok(saved.plans[0].label === 'Floor plan, after' && saved.plans.every((p) => ['as-built', 'proposed'].includes(p.type)), 'plans saved with captions and a valid type');
    ok(saved.fundraisingUrl === 'https://www.zeffy.com/donation-form/amari', 'the fundraising link saved');
    ok(await page.$('.kd-bar__state.is-saved'), 'after saving nothing is unsaved');

    // History: the save and the version before it, and what the save changed
    await page.waitForFunction(() => document.querySelectorAll('.kd-history__row').length >= 2, { timeout: 5000 }).catch(() => {});
    const hist = await page.$$eval('.kd-history__row', (r) => r.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
    ok(hist.length === 2 && /^Staff/.test(hist[0]) && /Story|Photos|What was built/.test(hist[0]) && /Before history/.test(hist[1]), `History lists the save, who made it and what changed (${hist[0]?.slice(0, 80)})`);
    await page.evaluate(() => document.querySelector('.kd-history__all').click()); // (a toast can sit over the rail)
    await page.waitForSelector('.kd-hist__item');
    await page.evaluate(() => [...document.querySelectorAll('.kd-hist__item')].at(-1).click());
    await page.waitForFunction(() => /Restoring it changes/.test(document.querySelector('.kd-hist__detail')?.textContent || ''), { timeout: 5000 });
    ok(await page.evaluate(() => /Fundraising link/.test(document.querySelector('.kd-hist__changes.is-restore')?.textContent || '')), 'the oldest version shows what restoring it would change');
    await clickText(page, '.kd-dialog__foot .btn-primary', 'Restore this version');
    await sleep(300);
    ok(!(await page.$('.kd-hist')) && await fundLink(page) === (amari.fundraisingUrl || '') && await page.$('.kd-bar__state.is-dirty'), 'Restore loads that version into the editor, unsaved');
    await clickToast(page, 'Undo');
    await sleep(250);
    ok(await fundLink(page) === 'https://www.zeffy.com/donation-form/amari' && await page.$('.kd-bar__state.is-saved'), 'Undo puts the saved version back');

    // A focal point: click the photo where crops should center
    await page.evaluate(() => document.querySelectorAll('.kd-tile__open')[0].click());
    await page.waitForSelector('.kd-focus img');
    await sleep(300);
    const fbox = await page.$eval('.kd-focus', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    await page.mouse.click(fbox.x + fbox.w * 0.25, fbox.y + fbox.h * 0.75);
    await sleep(300);
    const fp = await page.evaluate(() => ({ mark: !!document.querySelector('.kd-focus__mark'), crops: [...document.querySelectorAll('.kd-crops img')].map((i) => i.getAttribute('src')) }));
    ok(fp.mark && fp.crops.length === 3 && fp.crops.every((u) => /gravity=0\.2\d*x0\.7\d*/.test(u)), `clicking the photo sets its focal point, and the crop previews use it (${fp.crops[0]?.match(/gravity=[^,]+/)?.[0]})`);
    await page.keyboard.press('Escape');
    await sleep(200);
    ok(/gravity=0\.2\d*x0\.7\d*/.test(await page.evaluate(() => document.querySelectorAll('.kd-tile img')[0].getAttribute('src'))), 'the photo’s tile crops around it too');
    await page.click('.kd-bar__save .kd-save');
    await sleep(700);
    const focused = api.st.kids.amari.photos.find((x) => x.focus);
    ok(focused && Math.abs(focused.focus.x - 0.25) < 0.02 && Math.abs(focused.focus.y - 0.75) < 0.02, `the focal point is saved on the photo (${JSON.stringify(focused?.focus)})`);

    // Preview frames the real page
    await page.click('.kd-ed-actions .btn-ghost[aria-pressed]');
    await page.waitForSelector('.page-preview iframe', { timeout: 20000 });
    await page.waitForFunction(() => !document.querySelector('.page-preview__msg[role=status]'), { timeout: 30000 }).catch(() => {});
    await page.waitForFunction(() => [...document.querySelectorAll('.page-preview iframe')].some((f) => f.style.visibility !== 'hidden' && f.contentDocument?.querySelector('article.kid-profile')), { timeout: 30000 }).catch(() => {});
    const framed = await page.evaluate(() => {
      const f = [...document.querySelectorAll('.page-preview iframe')].find((x) => x.style.visibility !== 'hidden');
      return f?.contentDocument?.querySelector('article.kid-profile h1')?.textContent.replace(/\s+/g, ' ').trim() || f?.contentDocument?.title || '';
    });
    ok(!(await page.$('.page-preview__msg p strong')) && /Amari/.test(framed), `Preview frames Amari’s real page (${framed.slice(0, 40)})`);
    await shot(page, 'desk-editor-preview', { grow: false });
    await page.keyboard.press('Escape');
    await sleep(300);

    // Delete
    await page.click('.kd-card__delete');
    await sleep(200);
    await clickText(page, '.modal .btn-danger', 'Delete profile');
    await page.waitForSelector('.kd-row', { timeout: 10000 });
    ok(!api.st.kids.amari, 'Delete removes the profile and goes back to the list');
    await page.waitForSelector('.kd-deleted-link', { timeout: 5000 }).catch(() => {});
    ok(await page.evaluate(() => /Recently deleted\s*1/.test(document.querySelector('.kd-deleted-link')?.textContent || '')), 'the list offers Recently deleted');
    await page.click('.kd-deleted-link');
    await page.waitForSelector('.kd-deleted li');
    await clickText(page, '.kd-deleted .btn', 'Restore');
    await sleep(700);
    ok(api.st.kids.amari?.name === 'Amari' && api.st.kids.amari.photos.some((x) => x.focus), 'Restore brings the profile back as it was');
    ok(!errors.length, `no console errors (${errors.join(' | ').slice(0, 300)})`);
    await page.close();
  }

  console.log('Desktop 1440: uploading photos and videos, the tidy tool');
  {
    // Peter's page as a new family's: made hidden when they're approved
    // AJ's gallery has a photo from an earlier upload (images are named kids/<slug>/<time>-<file>)
    const { page, api, errors } = await open(browser, { width: 1440, height: 1000, mobile: false, prep: (st) => {
      st.kids.peter = { ...st.kids.peter, publishStatus: 'draft' };
      st.kids.aj = { ...st.kids.aj, photos: [...st.kids.aj.photos, { url: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/aj/1762700000000-old-1.jpg/public', alt: 'AJ in his room' }] };
      // A new family's page with no photos yet
      st.kids.zed = { slug: 'zed', name: 'Zed', year: 2026, status: 'in-progress', publishStatus: 'draft', photos: [], heroImage: '', partnerLogos: [], plans: [], beforeAfterPhotos: [] };
    } });
    await page.click('.dnew-btn');
    await sleep(250);
    const created = await page.$$eval('[role="menuitem"]', (m) => m.map((x) => x.textContent.trim()));
    ok(created.length && !created.some((t) => /^Kid\b/.test(t)), `the Dashboard’s Create new has no Kid (${created.join(', ')})`);
    await page.keyboard.press('Escape');
    await goKids(page, false);
    ok(!(await page.evaluate(() => /Add a kid/.test(document.querySelector('.kd-head')?.textContent || ''))), 'Kids has no Add a kid: profiles are made when a family is approved');
    await clickText(page, '.kd-head__actions .btn-primary', 'Upload photos and videos');
    await page.waitForSelector('#kd-up-kid');
    await sleep(200);
    ok(await page.evaluate(() => document.activeElement?.id === 'kd-up-kid'), 'Upload photos and videos opens on “Whose page?”');
    const opts = await page.$$eval('#kd-up-kid option', (o) => o.filter((x) => x.value).map((x) => ({ v: x.value, t: x.textContent, g: x.parentElement.label || '' })));
    ok(opts.length === Object.keys(api.st.kids).length, `every kid is offered (${opts.length} of ${Object.keys(api.st.kids).length})`);
    ok(opts.find((o) => o.v === 'peter')?.t === 'Peter (2026) · draft', 'a draft page is offered, marked as a draft');
    ok(opts.find((o) => o.v === 'anna')?.g === 'Completed in 2015' && opts.find((o) => o.v === 'colin')?.g === 'In build', 'kids are grouped as the list groups them');
    ok(/^Dylan \(20\d\d\)$/.test(opts.find((o) => o.v === 'dylan')?.t || '') && /^Dylan \(2026\)$/.test(opts.find((o) => o.v === 'dylan-2026')?.t || ''), 'two kids with one name both show their year');
    await shot(page, 'desk-upload-open', { grow: false });

    const F = (name, buf) => { const f = join(OUT, name); writeFileSync(f, buf); return f; };
    const png = readFileSync(PNG);
    const files = {
      a2: F('a-2.png', png), a10: F('a-10.png', png), a3: F('a-3.png', png), txt: F('notes.txt', 'hello'), empty: F('empty.png', ''),
      v1: F('clip-1.mp4', Buffer.alloc(2048, 1)), v2: F('clip-2.mov', Buffer.alloc(4096, 2)), v3: F('clip-3.mov', Buffer.alloc(3072, 3)), v4: F('clip-4.mp4', Buffer.alloc(1024, 4)),
      old: F('old-1.png', png), new1: F('new-1.png', png), live: F('IMG_7.jpg', png), liveClip: F('IMG_7.mov', Buffer.alloc(1024, 5)),
      reveal: F('reveal-9.jpg', png), revealVid: F('reveal-9.mp4', Buffer.alloc(2048, 6)), annaName: F('anna-reveal-1.png', png), dots: F('Photo 1..png', png),
      // Phone photos taken at Axel's home (the fake /api/kid-homes puts it at 33.749, -84.388)
      gps: F('gps-1.jpg', jpeg(tiff({ lat: 33.7492, lng: -84.3883, taken: '2026:10:25 14:30:00' }))),
      gps2: F('gps-2.jpg', jpeg(tiff({ lat: 33.7489, lng: -84.3879, taken: '2026:10:25 14:31:00', le: true }))),
      d: Array.from({ length: 26 }, (_, i) => F(`d-${i + 1}.png`, png)),
      ellie: F('ellie-bedroom-01.png', png), x1: F('x-1.png', png), y1: F('y-1.png', png),
      gps3: F('gps-3.jpg', jpeg(tiff({ lat: 33.7490, lng: -84.3881, taken: '2026:10:25 14:32:00' }))),
      gps4: F('gps-4.jpg', jpeg(tiff({ lat: 33.7491, lng: -84.3880, taken: '2026:10:25 14:33:00' }))),
      long: F(`${'reveal-day-'.repeat(20)}final.png`, png),
      heic: F('IMG_8.HEIC', heicFile(tiff({ lat: 33.7491, lng: -84.3881, taken: '2026:10:25 15:00:00' }))), heicClip: F('IMG_8.MOV', Buffer.alloc(3000, 7)),
      c: Array.from({ length: 6 }, (_, i) => F(`c-${i + 1}.png`, png)),
      b: Array.from({ length: 8 }, (_, i) => F(`b-${i + 1}.png`, png)),
    };
    mkdirSync(join(OUT, 'web'), { recursive: true });
    mkdirSync(join(OUT, 'full'), { recursive: true });
    const webCopy = join(OUT, 'web', 'Axel-001.png');
    const fullCopy = join(OUT, 'full', 'Axel-001.png');
    writeFileSync(webCopy, png);
    writeFileSync(fullCopy, Buffer.concat([png, Buffer.alloc(5000)]));
    const chooseFiles = async (...list) => { await (await page.$('.kd-up input[type=file]')).uploadFile(...list); await sleep(150); };
    const idle = () => page.waitForFunction(() => [...document.querySelectorAll('.kd-dialog__foot .btn')].some((b) => /^(Done|Close)$/.test(b.textContent.trim())), { timeout: 20000 })
      .catch(async (e) => { console.log('DEBUG upload dialog:', (await page.evaluate(() => [...document.querySelectorAll('.kd-up-kid, .kd-up-notice, .kd-dialog__foot')].map((e) => e.innerText).join(' || ') || 'no dialog')).replace(/\n+/g, ' | ').slice(0, 1500)); console.log('DEBUG errors:', errors); throw e; });
    const card = (name) => page.evaluate((n) => document.querySelector(`.kd-up-kid[aria-label="${n}’s uploads"]`)?.textContent.replace(/\s+/g, ' ') || '', name);

    // Chosen before a kid is, and nothing in them says whose: they wait to be checked
    await chooseFiles(files.a10, files.a2, files.txt);
    await page.waitForSelector('.kd-up-held', { timeout: 10000 });
    ok(await page.evaluate(() => /Couldn’t tell whose these are/.test(document.querySelector('.kd-up-held')?.textContent || '') && document.querySelector('.kd-up-held .btn-primary').disabled),
      'files nothing says the kid of wait in “Check whose page”, with Upload off until a kid is chosen');
    ok(callsTo(api, '/api/upload-image') === 0, 'nothing uploads before a kid is chosen');
    const anna0 = structuredClone(api.st.kids.anna);
    const ups0 = api.st.uploads;
    await page.select('#kd-up-kid', 'anna');
    await sleep(200);
    ok(await page.$eval('.kd-up-group select', (x) => x.value) === 'anna' && callsTo(api, '/api/upload-image') === 0, 'choosing Anna up top fills the group in; still nothing uploads');
    await clickText(page, '.kd-up-held .btn-primary', 'Upload to Anna’s page');
    await idle();
    const anna = api.st.kids.anna;
    ok(anna.photos.length === anna0.photos.length + 2 && anna.photoCount === anna.photos.length, `choosing Anna uploads them into her gallery (${anna0.photos.length} → ${anna.photos.length})`);
    ok(JSON.stringify(anna.photos.slice(0, anna0.photos.length).map((x) => x.url)) === JSON.stringify(anna0.photos.map((x) => x.url)) && anna.heroImage === anna0.heroImage, 'the photos already there keep their place, and the main photo stays');
    ok(JSON.stringify(anna.photos.slice(-2).map((x) => x.url.match(/up-(\d+)/)?.[1])) === JSON.stringify([ups0 + 1, ups0 + 2].map(String)), 'the new ones go last, in file-name order (a-2 before a-10)');
    ok(anna.photos.slice(-2).every((x) => /^Described photo/.test(x.alt)), 'the new photos the page shows get alt text');
    ok(anna.name === anna0.name && anna.bio === anna0.bio && anna.status === anna0.status, 'nothing else on the profile changes');
    ok(/notes\.txt/.test(await page.$eval('.kd-up-notice', (e) => e.textContent)), 'a file that isn’t a photo or video is left out, by name');
    ok(/2 photos added to Anna’s gallery\. Alt text written for 2\./.test(await card('Anna')), `Anna’s card says what happened (${(await card('Anna')).slice(0, 120)})`);

    // Whose they are, guessed (from a file name, from where it was taken), and put right before anything uploads
    const heldText = () => page.$eval('.kd-up-held', (e) => e.textContent.replace(/\s+/g, ' ')).catch(() => '');
    await page.select('#kd-up-kid', '');
    const upsG = api.st.uploads;
    await chooseFiles(files.annaName);
    await page.waitForSelector('.kd-up-held', { timeout: 10000 });
    ok(/Named like “anna-reveal-1”/.test(await heldText()) && await page.$eval('.kd-up-group select', (x) => x.value) === 'anna', `a file named for a kid is guessed as theirs (${(await heldText()).slice(0, 140)})`);
    await clickText(page, '.kd-up-held .btn', 'Leave them out');
    await sleep(200);
    ok(!(await page.$('.kd-up-held')) && api.st.uploads === upsG, '“Leave them out” drops them, with nothing uploaded');
    const aj1 = api.st.kids.aj.photos.length;
    const axel1 = api.st.kids.axel.photos.length;
    await chooseFiles(files.gps);
    await page.waitForSelector('.kd-up-held', { timeout: 10000 });
    ok(/Taken at Axel’s home/.test(await heldText()) && await page.$eval('.kd-up-group select', (x) => x.value) === 'axel', `a phone photo taken at a family’s home is guessed as that kid’s (${(await heldText()).slice(0, 140)})`);
    await shot(page, 'desk-upload-guess', { grow: false });
    await page.select('.kd-up-group select', 'aj');
    await sleep(150);
    ok(/You changed it from Axel/.test(await heldText()), 'a wrong guess is put right in place, and says so');
    await clickText(page, '.kd-up-held .btn-primary', 'Upload to AJ’s page');
    await idle();
    ok(api.st.kids.aj.photos.length === aj1 + 1 && api.st.kids.axel.photos.length === axel1, 'it goes to the kid chosen, not the guess');
    // A kid chosen up top, and a photo that says it's someone else's: it waits to be checked
    await page.select('#kd-up-kid', 'anna');
    const annaG = api.st.kids.anna.photos.length;
    await chooseFiles(files.gps2);
    await page.waitForSelector('.kd-up-held', { timeout: 10000 });
    ok(/Taken at Axel’s home/.test(await heldText()) && api.st.kids.anna.photos.length === annaG, 'with Anna chosen, a photo taken at Axel’s home waits to be checked instead of going to Anna');
    // More while it waits: a file no one can tell joins the kid chosen now, never an older choice; the same file again is one file
    await chooseFiles(files.x1, files.gps3);
    await page.waitForFunction(() => document.querySelectorAll('.kd-up-group').length === 2, { timeout: 10000 }).catch(() => {});
    await page.select('#kd-up-kid', 'ayden');
    await chooseFiles(files.y1, files.x1, files.gps4);
    await page.waitForFunction(() => document.querySelectorAll('.kd-up-group').length === 3, { timeout: 10000 }).catch(() => {});
    const groupsNow = await page.$$eval('.kd-up-group', (gs) => gs.map((g) => `${g.querySelector('select').value}:${g.querySelector('strong').textContent}`));
    ok(groupsNow.includes('anna:1 photo') && groupsNow.includes('ayden:1 photo'), `a file added after switching to Ayden waits for Ayden, not Anna (${groupsNow.join(', ')})`);
    ok(/1 file was already added/.test(await page.$eval('.kd-up-notice', (e) => e.textContent).catch(() => '')), 'the same file added again while it waits is one file');
    ok((await page.$$eval('label[for^="kd-up-g-"]', (ls) => ls.map((l) => l.textContent.trim()))).includes('Whose page is this photo for?'), 'a group of one reads “this photo” to a screen reader');
    await clickText(page, '.kd-up-held .btn', 'Leave them all out');
    await sleep(200);
    // A name two kids share goes to the one chosen
    await page.select('#kd-up-kid', 'ellie');
    const ellie0 = api.st.kids.ellie.photos.length;
    await chooseFiles(files.ellie);
    await idle();
    ok(!(await page.$('.kd-up-held')) && api.st.kids.ellie.photos.length === ellie0 + 1, 'with Ellie (2022) chosen, “ellie-bedroom-01” goes straight to her, not the other Ellie');
    // A photographer's Web and Full Resolution copies are one photo; a very long file name still uploads
    await page.select('#kd-up-kid', 'axel');
    const axel2 = api.st.kids.axel.photos.length;
    await chooseFiles(webCopy, fullCopy, files.long);
    await idle();
    ok(api.st.kids.axel.photos.length === axel2 + 2 && /Left out 1 smaller copy of a photo with the same name for the same kid/.test(await page.$eval('.kd-up-notice', (e) => e.textContent)),
      'two copies of one photo (Web and Full) go up once, and it says so');
    ok(!/Invalid image id/.test(await card('Axel')) && api.st.ids.some((id) => /reveal-day-.*final\.png$/.test(id) && id.length <= 256), 'a 200-character file name uploads, its image name cut to fit');
    await page.select('#kd-up-kid', 'anna');

    // Videos: the first plays on a page without one; another waits in Stream
    await chooseFiles(files.v1);
    await idle();
    ok(api.st.kids.anna.streamVideoId === VID(1) && lastCall(api, '/api/upload-video')?.body?.name === 'Anna - clip-1', 'a video for a page without one plays there, named for her in Stream');
    ok(/On the page/.test(await card('Anna')), 'and says it’s on the page');
    await chooseFiles(files.v2);
    await idle();
    ok(api.st.kids.anna.streamVideoId === VID(1), 'a second video doesn’t replace the first by itself');
    ok(/Saved in Stream\. Anna’s page already has a video\./.test(await card('Anna')), 'it says it’s waiting in Stream');
    await shot(page, 'desk-upload-anna', { grow: false });
    await clickText(page, '.kd-up-video .btn', 'Play this one instead');
    await sleep(700);
    ok(api.st.kids.anna.streamVideoId === VID(2), '“Play this one instead” swaps the page’s video');
    ok(await page.evaluate(() => [...document.querySelectorAll('.kd-up-video')].some((v) => v.querySelector('strong')?.textContent === 'clip-2.mov' && [...v.querySelectorAll('.btn')].some((b) => b.textContent.trim() === 'Undo'))), 'Undo is in the dialog too, where the keyboard reaches it');
    ok(await clickToast(page, 'Undo'), 'with Undo');
    await sleep(700);
    ok(api.st.kids.anna.streamVideoId === VID(1) && /Play this one instead/.test(await card('Anna')), 'Undo puts the first one back');
    // An older Undo never changes a newer choice
    const playRow = (name) => page.evaluate((n) => [...document.querySelectorAll('.kd-up-video')].find((v) => v.querySelector('strong')?.textContent === n)?.querySelector('.btn')?.click(), name);
    const onPage = () => page.evaluate(() => [...document.querySelectorAll('.kd-up-video')].filter((v) => /On the page/.test(v.textContent)).map((v) => v.querySelector('strong').textContent));
    await chooseFiles(files.v3);
    await idle();
    await playRow('clip-2.mov');
    await sleep(600);
    await playRow('clip-3.mov');
    await sleep(600);
    ok(api.st.kids.anna.streamVideoId === VID(3), 'a third video can be played instead too');
    await page.evaluate(() => [...document.querySelectorAll('.toast-undo')].find((b) => b.textContent.trim() === 'Undo')?.click());
    await sleep(700);
    ok(api.st.kids.anna.streamVideoId === VID(3) && JSON.stringify(await onPage()) === '["clip-3.mov"]', `an older Undo leaves the newer choice alone, rows and all (${await onPage()})`);
    ok(await page.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => /Nothing to undo/.test(t.textContent))), 'and says there was nothing to undo');
    await playRow('clip-1.mp4'); // back to the first, for the checks below
    await sleep(600);

    // The same file again, an empty one (iCloud), an upload that fails, then a save someone else beat
    api.st.failUploads = true;
    const annaN = api.st.kids.anna.photos.length;
    await chooseFiles(files.a2, files.empty, files.a3);
    await idle();
    ok(/1 file was already added/.test(await page.$eval('.kd-up-notice', (e) => e.textContent)), 'a file already added is left out, and says so');
    const annaCard = await card('Anna');
    ok(/2 photos didn’t upload/.test(annaCard) && /empty\.png: The file is empty\. If it’s in iCloud/.test(annaCard) && /a-3\.png: Image too large/.test(annaCard), 'failures are listed by name, with why');
    ok(api.st.kids.anna.photos.length === annaN, 'nothing is saved for them');
    api.st.failUploads = false;
    api.st.conflictOnce = true;
    await clickText(page, '.kd-up-fails .btn', 'Try again');
    await idle();
    ok(api.st.conflicts === 1 && api.st.kids.anna.photos.length === annaN + 1, 'Try again uploads it, and a save someone else beat is read again and made');
    ok(/1 photo didn’t upload/.test(await card('Anna')) && !(await page.evaluate(() => [...document.querySelectorAll('.kd-up-fails .btn')].length)), 'the empty file stays listed, with nothing to retry');

    // A photo already in the gallery from an earlier upload, and an iPhone Live Photo's clip
    await page.select('#kd-up-kid', 'aj');
    const aj0 = api.st.kids.aj.photos.length;
    const vids0 = callsTo(api, '/api/upload-video');
    await chooseFiles(files.old, files.new1, files.live, files.liveClip);
    await idle();
    const ajNote = await page.$eval('.kd-up-notice', (e) => e.textContent.replace(/\s+/g, ' '));
    ok(/1 file with the same name is already on AJ’s page, so it was left out: old-1\.png/.test(ajNote), `a photo already in the gallery is left out, by name (${ajNote.slice(0, 160)})`);
    ok(/Left out 1 Live Photo clip/.test(ajNote) && callsTo(api, '/api/upload-video') === vids0, 'a Live Photo’s clip isn’t uploaded as a video');
    ok(api.st.kids.aj.photos.length === aj0 + 2, 'the other photos go in');
    await clickText(page, '.kd-up-notice .btn', 'Add them anyway');
    await idle();
    ok(api.st.kids.aj.photos.length === aj0 + 3 && callsTo(api, '/api/upload-video') === vids0 + 1, '“Add them anyway” adds the photo and the clip');
    await chooseFiles(files.reveal, files.revealVid);
    await idle();
    ok(callsTo(api, '/api/upload-video') === vids0 + 2, 'a real video named like a photo (reveal-9.mp4 beside reveal-9.jpg) isn’t taken for a Live Photo clip');

    // A page whose uploaded video no longer plays gets the new one
    await page.select('#kd-up-kid', 'dex');
    await chooseFiles(files.v4);
    await idle();
    ok(api.st.kids.dex.streamVideoId === KIDS0.dex.streamVideoId, 'a page whose uploaded video doesn’t play right now keeps it (Stream says the same while one is getting ready)');
    ok(/has an uploaded video that doesn’t play right now/.test(await card('Dex')) && /Play this one instead/.test(await card('Dex')), 'and says so, offering this one instead');

    // An iPhone photo taken at Axel's, and its Live Photo clip asked for anyway, with no kid chosen: both go once checked
    await page.select('#kd-up-kid', '');
    const vidsC = callsTo(api, '/api/upload-video');
    await chooseFiles(files.heic, files.heicClip);
    await page.waitForSelector('.kd-up-held', { timeout: 10000 });
    ok(/Taken at Axel’s home/.test(await heldText()) && /Left out 1 Live Photo clip/.test(await page.$eval('.kd-up-notice', (e) => e.textContent)), 'an iPhone photo (HEIC) taken at Axel’s is guessed as his; its clip is left out');
    await clickText(page, '.kd-up-notice .btn', 'Add it anyway');
    await sleep(300);
    ok(await page.$$eval('.kd-up-group', (gs) => gs.length === 1 && /1 photo and 1 video/.test(gs[0].textContent)), 'the clip asked for joins its photo’s group (Axel’s), not the kid chosen');
    await clickText(page, '.kd-up-held .btn-primary', 'Upload to Axel');
    await idle();
    ok(callsTo(api, '/api/upload-video') === vidsC + 1, 'the clip asked for goes up too, not left out again');

    // With Lizzie chosen, an iPhone photo taken at Axel's waits; its clip, added anyway after the photo goes up, follows it to Axel
    await page.select('#kd-up-kid', 'lizzie');
    const lizzieVid = api.st.kids.lizzie.streamVideoId;
    writeFileSync(join(OUT, 'IMG_6.HEIC'), heicFile(tiff({ lat: 33.7491, lng: -84.3881, taken: '2026:10:26 10:00:00' })));
    writeFileSync(join(OUT, 'IMG_6.MOV'), Buffer.alloc(2800, 6));
    await chooseFiles(join(OUT, 'IMG_6.HEIC'), join(OUT, 'IMG_6.MOV'));
    await page.waitForSelector('.kd-up-held', { timeout: 10000 });
    writeFileSync(join(OUT, 'lizzie-x-1.png'), png);
    await chooseFiles(join(OUT, 'lizzie-x-1.png'));
    await idle();
    ok(/Left out 1 Live Photo clip/.test(await page.$eval('.kd-up-notice', (e) => e.textContent).catch(() => '')), 'another drop keeps the offer to add the clip anyway');
    await clickText(page, '.kd-up-held .btn-primary', 'Upload to Axel');
    await idle();
    await clickText(page, '.kd-up-notice .btn', 'Add it anyway');
    await idle();
    ok(lastCall(api, '/api/upload-video')?.body?.name === 'Axel - IMG_6' && api.st.kids.lizzie.streamVideoId === lizzieVid, 'the clip follows its photo to Axel, not to Lizzie on screen');

    // Two different photos with one camera name, for two kids, aren't copies
    mkdirSync(join(OUT, 'cam-a'), { recursive: true });
    mkdirSync(join(OUT, 'cam-b'), { recursive: true });
    const camA = join(OUT, 'cam-a', 'IMG_0001.jpg');
    const camB = join(OUT, 'cam-b', 'IMG_0001.jpg');
    writeFileSync(camA, jpeg(tiff({ lat: 33.7490, lng: -84.3880, taken: '2026:10:25 16:00:00' })));
    writeFileSync(camB, png);
    await page.select('#kd-up-kid', '');
    await chooseFiles(camA, camB);
    await page.waitForSelector('.kd-up-held', { timeout: 10000 });
    const camGroups = await page.$$eval('.kd-up-group', (gs) => gs.map((g) => `${g.querySelector('select').value}:${g.querySelector('strong').textContent}`));
    ok(camGroups.length === 2 && !/copy/.test(await page.$eval('.kd-up-notice', (e) => e.textContent).catch(() => '')), `one camera name in two kids’ photos isn’t a copy (${camGroups.join(', ')})`);
    await clickText(page, '.kd-up-held .btn', 'Leave them all out');
    await sleep(200);
    // Web, then Full Resolution in a second drop, for one kid: one photo
    mkdirSync(join(OUT, 'web2'), { recursive: true });
    mkdirSync(join(OUT, 'full2'), { recursive: true });
    writeFileSync(join(OUT, 'web2', 'COLIN-1.png'), png);
    writeFileSync(join(OUT, 'full2', 'COLIN-1.png'), Buffer.concat([png, Buffer.alloc(4000)]));
    await page.select('#kd-up-kid', 'colin');
    const colinW = api.st.kids.colin.photos.length;
    await chooseFiles(join(OUT, 'web2', 'COLIN-1.png'));
    await idle();
    await chooseFiles(join(OUT, 'full2', 'COLIN-1.png'));
    await idle();
    const colinLast = api.st.kids.colin.photos.at(-1).url;
    ok(api.st.kids.colin.photos.length === colinW + 1 && colinLast.includes(`up-${api.st.uploads}/`) && /The larger copy of 1 photo \(Full Resolution after Web\) takes the smaller one’s place/.test(await page.$eval('.kd-up-notice', (e) => e.textContent)),
      'Full Resolution after Web takes the Web copy’s place: one photo, the larger, and it says so');
    // A Google Photos Live Photo (HEIC beside a camera-named .MP4) leaves its clip out too
    const vidsG = callsTo(api, '/api/upload-video');
    writeFileSync(join(OUT, 'IMG_9.jpg'), png);
    writeFileSync(join(OUT, 'IMG_9.mp4'), Buffer.alloc(2500, 9));
    await chooseFiles(join(OUT, 'IMG_9.jpg'), join(OUT, 'IMG_9.mp4'));
    await idle();
    ok(callsTo(api, '/api/upload-video') === vidsG && /Left out 1 Live Photo clip/.test(await page.$eval('.kd-up-notice', (e) => e.textContent)), 'a Google Photos Live Photo’s .MP4 clip is left out like an iPhone’s');
    // Long photographer names that differ only at the end are different photos
    const longName = (n) => `Sunshine on a Ranney Day - Colin Reveal October 25 2026 - Jane Doe Photography LLC - ${String(n).padStart(3, '0')}.jpg`;
    for (const n of [1, 2, 3, 4]) writeFileSync(join(OUT, longName(n)), png);
    const colinL = api.st.kids.colin.photos.length;
    await chooseFiles(join(OUT, longName(1)), join(OUT, longName(2)), join(OUT, longName(3)));
    await idle();
    await chooseFiles(join(OUT, longName(4)));
    await idle();
    ok(api.st.kids.colin.photos.length === colinL + 4, `long names that differ only at the end (… - 004) aren’t taken as already added (${api.st.kids.colin.photos.length - colinL} of 4)`);
    // Before and after shots both named 001.png, with no dates in them, are two photos: both go in, each its own
    const ramp = (w, dir) => pngImage(w, w, (x) => { const v = Math.round(((dir > 0 ? x : w - 1 - x) / (w - 1)) * 255); return [v, v, v]; });
    for (const [dir, w, d] of [['before', 16, 1], ['after', 24, -1], ['web3', 16, 1], ['full3', 48, 1]]) { mkdirSync(join(OUT, dir), { recursive: true }); writeFileSync(join(OUT, dir, '001.png'), ramp(w, d)); }
    const colinB = api.st.kids.colin.photos.length;
    await chooseFiles(join(OUT, 'before', '001.png'));
    await idle();
    await chooseFiles(join(OUT, 'after', '001.png'));
    await idle();
    ok(api.st.kids.colin.photos.length === colinB + 2 && !/takes the smaller one’s place|smaller copy/.test(await page.$eval('.kd-up-notice', (e) => e.textContent).catch(() => '')),
      'two different photos with one name (before/001, after/001) both go in: neither is taken for a copy of the other');
    // A Web copy still uploading when its Full Resolution copy comes: the Full one takes its place, and the Web one never lands on the page
    const prey = api.st.kids.lizzie.photos.length;
    await page.select('#kd-up-kid', 'lizzie');
    api.st.slowFirst = 2500;
    await chooseFiles(join(OUT, 'web3', '001.png'));
    await sleep(400);
    await chooseFiles(join(OUT, 'full3', '001.png'));
    await idle();
    await sleep(2600);
    await idle();
    ok(api.st.kids.lizzie.photos.length === prey + 1, `a Web copy still uploading when its Full copy comes doesn’t end up on the page as well (${api.st.kids.lizzie.photos.length - prey} added)`);
    // Someone else put this photo on the page after the list loaded: it isn't added twice
    api.st.kids.colin = { ...api.st.kids.colin, photos: [...api.st.kids.colin.photos, { url: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/colin/1762800000000-colin-st-1.png/public', alt: 'Added in another tab' }] };
    const colinM = api.st.kids.colin.photos.length;
    await page.select('#kd-up-kid', 'colin');
    writeFileSync(join(OUT, 'colin-st-1.png'), png);
    await chooseFiles(join(OUT, 'colin-st-1.png'));
    await idle();
    ok(api.st.kids.colin.photos.length === colinM && /already on the page \(added meanwhile\)/.test(await card('Colin')), 'a photo someone added meanwhile (another tab) isn’t added twice, and the card says so');
    await clickText(page, '.kd-up-kid[aria-label="Colin’s uploads"] .kd-up-line .btn', 'Add it anyway');
    await idle();
    ok(api.st.kids.colin.photos.length === colinM + 1, '“Add it anyway” puts it on the page after all (it was only the same name)');
    // A file that failed, then a new file of the same name: that one is tried again, not called a copy
    api.st.failUploads = true;
    writeFileSync(join(OUT, 'big-02.png'), Buffer.concat([png, Buffer.alloc(9000)]));
    await chooseFiles(join(OUT, 'big-02.png'));
    await idle();
    api.st.failUploads = false;
    mkdirSync(join(OUT, 'smaller'), { recursive: true });
    writeFileSync(join(OUT, 'smaller', 'big-02.png'), png);
    const colinF = api.st.kids.colin.photos.length;
    await chooseFiles(join(OUT, 'smaller', 'big-02.png'));
    await idle();
    ok(api.st.kids.colin.photos.length === colinF + 1 && !/big-02\.png: Image too large/.test(await card('Colin')) && !/smaller copy|takes the smaller/.test(await page.$eval('.kd-up-notice', (e) => e.textContent).catch(() => '')),
      'a new file named like one that failed is that one tried again: no copy note, no failure left');
    // A different picture named like one that failed is its own photo: the failed one stays, to try again
    for (const [dir, d] of [['before4', 1], ['after4', -1]]) { mkdirSync(join(OUT, dir), { recursive: true }); writeFileSync(join(OUT, dir, '005.png'), ramp(20, d)); }
    api.st.failUploads = true;
    await chooseFiles(join(OUT, 'before4', '005.png'));
    await idle();
    api.st.failUploads = false;
    const colinR = api.st.kids.colin.photos.length;
    await chooseFiles(join(OUT, 'after4', '005.png'));
    await idle();
    ok(api.st.kids.colin.photos.length === colinR + 1 && /005\.png: Image too large/.test(await card('Colin')), 'a different picture named like one that failed goes in as its own; the failed one stays listed to try again');
    // Done with a photo that didn't upload asks first
    const askedNotUp = [];
    await answerAsks(page, { accept: false, onAsk: (t) => askedNotUp.push(t) });
    await clickText(page, '.kd-dialog__foot .btn', 'Done');
    await sleep(500);
    ok(askedNotUp.some((t) => /1 file didn’t upload/.test(t)) && await page.$('.kd-up-dialog'), 'Done with a photo that didn’t upload asks first');
    await answerAsks(page, { accept: true });
    await clickText(page, '.kd-up-kid[aria-label="Colin’s uploads"] .kd-up-fails .btn', 'Try again');
    await idle();
    // A page with no photos: the main photo is the first by name, even when it lands last
    await page.select('#kd-up-kid', 'zed');
    const upsZ = api.st.uploads;
    for (let n = 1; n <= 26; n++) writeFileSync(join(OUT, `z-${String(n).padStart(2, '0')}.png`), png);
    api.st.slowFirst = 3000;
    await chooseFiles(...Array.from({ length: 26 }, (_, n) => join(OUT, `z-${String(n + 1).padStart(2, '0')}.png`)));
    await idle();
    ok(api.st.kids.zed.heroImage.includes(`up-${upsZ + 1}/`) && api.st.kids.zed.photos[0].url === api.st.kids.zed.heroImage, `the main photo is the first by name (z-01), though it landed last (${api.st.kids.zed.heroImage.match(/up-\d+/)?.[0]})`);
    // A year in the name beats the kid chosen
    await page.select('#kd-up-kid', 'ellie');
    writeFileSync(join(OUT, 'ellie-2023-1.png'), png);
    await chooseFiles(join(OUT, 'ellie-2023-1.png'));
    await page.waitForSelector('.kd-up-held', { timeout: 10000 });
    ok(await page.$eval('.kd-up-group select', (x) => x.value) === 'ellie-2023', 'with Ellie (2022) chosen, “ellie-2023-1” waits to be checked, guessed as the 2023 Ellie');
    await clickText(page, '.kd-up-held .btn', 'Leave them out');
    await sleep(200);
    // An upload that couldn't be saved to the profile isn't dropped without asking
    await page.select('#kd-up-kid', 'anna');
    api.st.failSaves = 4;
    writeFileSync(join(OUT, 'unsaved-1.png'), png);
    await chooseFiles(join(OUT, 'unsaved-1.png'));
    await idle();
    const askedUnsaved = [];
    await answerAsks(page, { accept: false, onAsk: (t) => askedUnsaved.push(t) });
    await page.keyboard.press('Escape');
    await sleep(500);
    ok(askedUnsaved.some((t) => /couldn’t be saved to its profile yet/.test(t)) && await page.$('.kd-up-dialog'), 'closing with an upload not saved to its profile asks first');
    await answerAsks(page, { accept: true });
    api.st.failSaves = 0;
    await clickText(page, '.kd-up-line .btn', 'Try saving again');
    await idle();
    ok(api.st.kids.anna.photos.some((x) => x.url.includes(`up-${api.st.uploads}/`)), 'and Try saving again saves it');

    // A full gallery: a new photo goes past the 30 the page shows; dropped on the dialog's title
    await page.select('#kd-up-kid', 'max');
    const max0 = api.st.kids.max.photos.length;
    const drop = (sel) => page.evaluate(async (s) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'dropped-1.png', { type: 'image/png' }));
      const el = document.querySelector(s);
      el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 80));
      const cover = document.querySelector('.kd-up .kd-dropcover')?.textContent.trim() || '';
      const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      return { cover, prevented: ev.defaultPrevented };
    }, sel);
    const d1 = await drop('.kd-up-dialog .kd-dialog__head h2');
    ok(/Drop to add to Max’s page/.test(d1.cover) && d1.prevented, `dragging files over the dialog says where they’ll go (${d1.cover})`);
    await sleep(300);
    await idle();
    ok(api.st.kids.max.photos.length === max0 + 1, 'a file dropped on the dialog’s title goes to the kid chosen');
    ok(/The page shows the first 30 photos, so this one doesn’t show until you move it up in Max’s profile\./.test(await card('Max')), `it says the page won’t show it until it’s moved up (${(await card('Max')).slice(0, 160)})`);
    ok(!String(api.st.kids.max.photos.at(-1).alt || ''), 'and writes no alt text for a photo the page doesn’t show');
    const up1 = api.st.uploads;
    const d2 = await drop('.kd-overlay');
    await sleep(400);
    ok(d2.prevented && api.st.uploads === up1, 'a file dropped beside the dialog is ignored, never opened in place of the admin');

    // One slow photo never holds the rest back: they're saved as they land, and it slots in by name when it comes
    await page.select('#kd-up-kid', 'adrian');
    const adr0 = api.st.kids.adrian.photos.length;
    const upsD = api.st.uploads;
    api.st.slowFirst = 3000;
    await chooseFiles(...files.d, files.dots);
    // Every 25 photos is saved straight away: here before the slow first one (3 s) has landed
    let early = false;
    for (let i = 0; i < 25 && !early; i++) { early = api.st.kids.adrian.photos.length >= adr0 + 25; if (!early) await sleep(100); }
    ok(early, `the photos that landed are saved without waiting for the slow one (${api.st.kids.adrian.photos.length - adr0} of 27 saved within 2.5 s)`);
    await idle();
    const tail = api.st.kids.adrian.photos.slice(adr0).map((x) => Number(x.url.match(/up-(\d+)/)?.[1]));
    ok(tail.length === 27 && tail.every((n, i) => n === upsD + 1 + i), `the slow one slots in first, by its name (${tail.slice(0, 4).map((n) => n - upsD).join(', ')}…)`);
    ok(api.st.ids.some((id) => /Photo-1\.png$/.test(id)) && !api.st.ids.some((id) => id.includes('..')), `a file name with “..” in it (Photo 1..png) uploads (${api.st.ids.find((id) => /Photo-1/.test(id))})`);

    // Stop: what's in stays saved; the rest can follow
    await page.select('#kd-up-kid', 'colin');
    const colin0 = api.st.kids.colin.photos.length;
    api.st.slowUploads = 700;
    await chooseFiles(...files.b);
    await sleep(900);
    ok(await page.evaluate(() => [...document.querySelectorAll('.kd-dialog__foot .btn')].some((b) => b.textContent.trim() === 'Stop')) && await page.$eval('.kd-up-dialog .kd-x', (b) => b.disabled), 'while uploading, the dialog stays open with Stop');
    await clickText(page, '.kd-dialog__foot .btn', 'Stop');
    await idle();
    api.st.slowUploads = 0;
    const landed = api.st.kids.colin.photos.length - colin0;
    ok(landed > 0 && landed < 8, `Stop keeps the photos already in (${landed} of 8)`);
    ok(new RegExp(`${8 - landed} photos? (weren’t|wasn’t) uploaded because you stopped`).test(await card('Colin')), 'and says how many weren’t');
    // Meanwhile someone else takes one of the new photos off in the editor
    const removed = api.st.kids.colin.photos.at(-1).url;
    api.st.kids.colin = { ...api.st.kids.colin, photos: api.st.kids.colin.photos.slice(0, -1) };
    await clickText(page, '.kd-up-fails .btn', 'Upload the rest');
    await idle();
    ok(api.st.kids.colin.photos.length === colin0 + 7 && !api.st.kids.colin.photos.some((x) => x.url === removed), '“Upload the rest” finishes them, and a photo someone else took off stays off');
    ok(await page.evaluate(() => [...document.querySelectorAll('.kd-dialog__foot .btn')].some((b) => b.textContent.trim() === 'Publish')), 'once done it offers Publish');
    await shot(page, 'desk-upload-done', { grow: false });

    // Open profile: the editor has them
    const annaOpen = api.st.kids.anna.photos.length;
    await page.evaluate(() => [...document.querySelectorAll('.kd-up-kid[aria-label="Anna’s uploads"] .btn')].find((b) => b.textContent.trim() === 'Open profile')?.click());
    await page.waitForSelector('.kd-ed-head', { timeout: 10000 });
    await sleep(600);
    ok(await page.$$eval('#kd-sec-photos .kd-tile', (t) => t.length) === api.st.kids.anna.photos.length, 'Open profile shows Anna’s gallery with the new photos');
    await page.click('#kd-ages', { clickCount: 3 });
    await page.type('#kd-ages', '7, x');
    await page.click('#kd-diagnosis');
    ok(await page.evaluate(() => document.querySelector('#kd-ages').classList.contains('is-invalid')), 'a bad age is flagged');
    await page.click('#kd-ages', { clickCount: 3 });
    await page.type('#kd-ages', '7, 9');
    await page.click('.kd-bar__save .kd-save');
    await sleep(800);
    const made = api.st.kids.anna;
    ok(made && JSON.stringify(made.age) === '[7,9]' && made.streamVideoId === VID(1) && made.photos.length === annaOpen, 'Save keeps the details and the uploads');

    // Closing with photos waiting to be checked asks first (and the homes not loading is said, not hidden)
    await page.evaluate(() => document.querySelector('.breadcrumb button').click());
    await page.waitForSelector('.kd-row');
    api.st.homesFail = true;
    await clickText(page, '.kd-head__actions .btn-primary', 'Upload photos and videos');
    await page.waitForSelector('#kd-up-kid');
    await chooseFiles(files.x1);
    await page.waitForSelector('.kd-up-held', { timeout: 10000 });
    ok(/can’t be checked right now/.test(await page.$eval('.kd-up-homes-off', (e) => e.textContent).catch(() => '')), 'when the homes don’t load, it says guesses go by names only');
    api.st.homesFail = false;
    const askedClose = [];
    await answerAsks(page, { accept: false, onAsk: (t) => askedClose.push(t) });
    await page.keyboard.press('Escape');
    await sleep(500);
    ok(askedClose.some((t) => /Leave them off the pages\?.*1 file is waiting in “Check whose page these are for”/.test(t)) && await page.$('.kd-up-held'), 'closing with photos waiting asks first; “Go back” keeps them');
    await answerAsks(page, { accept: true, onAsk: (t) => askedClose.push(t) });
    await clickText(page, '.kd-dialog__foot .btn', 'Close');
    await sleep(500);
    ok(!(await page.$('.kd-up-dialog')), 'and “Close without them” closes');

    // Changing "Whose page?" while the files are still being read: they go to the kid on screen
    api.st.slowHomes = 3000;
    await clickText(page, '.kd-head__actions .btn-primary', 'Upload photos and videos');
    await page.waitForSelector('#kd-up-kid');
    await page.select('#kd-up-kid', 'anna');
    const annaS = api.st.kids.anna.photos.length;
    const aydenS = api.st.kids.ayden.photos.length;
    writeFileSync(join(OUT, 'switch-1.png'), png);
    await chooseFiles(join(OUT, 'switch-1.png'));
    await page.select('#kd-up-kid', 'ayden');
    await idle();
    api.st.slowHomes = 0;
    ok(api.st.kids.ayden.photos.length === aydenS + 1 && api.st.kids.anna.photos.length === annaS, 'switching to Ayden while they’re read sends them to Ayden, the kid on screen');
    // The same video again in a new dialog isn't uploaded to Stream twice
    await page.select('#kd-up-kid', 'anna');
    const vidsR = callsTo(api, '/api/upload-video');
    await chooseFiles(files.v1);
    await idle();
    ok(callsTo(api, '/api/upload-video') === vidsR && /already on Anna’s page/.test(await page.$eval('.kd-up-notice', (e) => e.textContent).catch(() => '')), 'a video already uploaded to a page isn’t uploaded again after reopening');

    // Leaving mid-upload ("Leaving drops them"): nothing more uploads or saves
    await page.select('#kd-up-kid', 'ayden');
    const ayden0 = api.st.kids.ayden.photos.length;
    api.st.slowUploads = 800;
    await chooseFiles(...files.c);
    await sleep(300);
    const asked = [];
    await answerAsks(page, { onAsk: (t) => asked.push(t) });
    const hash0 = await page.evaluate(() => location.hash);
    // As Back would to another area: the address changes, the admin asks
    await page.evaluate(() => { location.hash = '#events'; });
    await sleep(400);
    const upsAtLeave = api.st.uploads;
    await sleep(3500);
    api.st.slowUploads = 0;
    const hash1 = await page.evaluate(() => location.hash);
    ok(asked.some((t) => /Leave without saving/.test(t)) && !(await page.$('.kd-up-dialog')), `leaving mid-upload asks first, then the dialog is gone (asked: ${asked.join(' / ').slice(0, 120) || 'nothing'}; ${hash0} → ${hash1})`);
    ok(api.st.kids.ayden.photos.length === ayden0 && api.st.uploads - upsAtLeave <= 3, `and nothing more uploads or saves (${api.st.uploads - upsAtLeave} were already on their way; Ayden ${ayden0} → ${api.st.kids.ayden.photos.length})`);
    await goKids(page, false);
    await openKid(page, 'Anna');
    // Anna's old link (not a Zeffy form) warns, and the rest of her profile still saves, the link left as it was
    await page.waitForFunction(() => !document.querySelector('#kd-fund')?.disabled, { timeout: 8000 });
    ok(await page.$eval('#kd-sec-giving', (e) => !!e.querySelector('.zf-link__warn') && !e.querySelector('.zf-link__bad')), 'Anna’s old link is a warning');
    const annaSaves = callsTo(api, '/api/save-content');
    await page.type('#kd-photographer', 'Jane Doe');
    await page.click('.kd-bar__save .kd-save');
    await sleep(800);
    const annaSaved = JSON.parse(lastCall(api, '/api/save-content')?.body?.content || '{}');
    ok(callsTo(api, '/api/save-content') === annaSaves + 1 && /Jane Doe/.test(annaSaved.photographer || '') && annaSaved.fundraisingUrl === 'https://www.gofundme.com/f/anna-room', 'an old link never stops the rest of a profile saving, and stays as it was');

    // Broken partner logos: flagged, and switched to the partner's current logo
    await page.evaluate(() => document.querySelector('.breadcrumb button').click());
    await page.waitForSelector('.kd-row');
    await openKid(page, 'Abby');
    await page.evaluate(() => document.getElementById('kd-sec-partners').scrollIntoView());
    await page.waitForFunction(() => document.querySelectorAll('.kd-logo__broken').length >= 3, { timeout: 15000 }).catch(() => {});
    ok(await page.$$eval('.kd-logo__broken', (b) => b.length) === 3, 'the three logos that no longer load say so');
    ok(await page.evaluate(() => /3 logos don’t load/.test(document.querySelector('#kd-sec-partners .kd-sec__issues')?.textContent || '')), 'and the Partners section flags them');
    await clickText(page, '#kd-sec-partners .kd-sec__actions .btn', 'Use current logos');
    await sleep(500);
    ok(await page.$$eval('.kd-logo__broken', (b) => b.length) === 0, '“Use current logos” switches them to the directory’s logos');
    // Nothing to save when no logo was flagged (the checks above say so): carry on to the rest of the suite
    if (await page.$('.kd-bar__save .kd-save')) await page.click('.kd-bar__save .kd-save');
    await sleep(800);
    const abby = api.st.kids.abby;
    ok(abby.partnerLogos.filter((l) => /real-floors-commercial|usa-insulation|eclipse-brand-builders/.test(l.url)).every((l) => /\/\d{10,}\/public$/.test(l.url) && l.name), 'the saved profile has the current logos, named');

    // Tidy: logos, room counts and names (fast), then alt text, stopped after a few
    await page.evaluate(() => document.querySelector('.breadcrumb button').click());
    await page.waitForSelector('.kd-tidy-banner');
    await page.click('.kd-tidy-banner .btn');
    await page.waitForSelector('.kd-tidy-job');
    ok(await page.evaluate(() => [...document.querySelectorAll('.kd-tidy-job')].some((j) => /Restore \d+ partner logos?/.test(j.textContent))), 'the tidy tool restores broken partner logos');
    const job = (text) => page.evaluate((t) => [...document.querySelectorAll('.kd-tidy-job')].find((j) => j.textContent.includes(t))?.querySelector('input').click(), text);
    await job('alt text');
    const before = callsTo(api, '/api/save-content');
    const gen0 = callsTo(api, '/api/generate'); // the uploads above wrote alt text
    await clickText(page, '.kd-dialog__foot .btn-primary', 'Start');
    await page.waitForFunction(() => /updated/.test(document.querySelector('.kd-tidy-run strong')?.textContent || ''), { timeout: 60000 });
    const namedKids = callsTo(api, '/api/save-content') - before;
    const unnamedLeft = Object.values(api.st.kids).reduce((n, k) => n + (k.partnerLogos || []).filter((l) => !String(l.name || '').trim() && /\/partners\//.test(l.url)).length, 0);
    ok(namedKids > 50 && callsTo(api, '/api/generate') === gen0, `names come from the directory, no AI (${namedKids} profiles saved)`);
    const stillBroken = Object.values(api.st.kids).reduce((n, k) => n + (k.partnerLogos || []).filter((l) => isBrokenImage(l.url)).length, 0);
    ok(stillBroken === 0, `broken partner logos are restored everywhere (${stillBroken} left)`);
    ok(unnamedLeft < 300, `directory logos are named (${unnamedLeft} left that the directory doesn’t know)`);
    const roomsOff = Object.values(api.st.kids).filter((k) => (Number(k.roomCount) || 1) !== Math.max(1, KS.roomTotal(KS.buildsOf(k))));
    ok(!roomsOff.length && api.st.kids.marilyn?.roomCount === 3, `room counts are corrected too (${roomsOff.map((k) => k.slug).join(', ') || 'none left'})`);
    await shot(page, 'desk-tidy-done', { grow: false });
    await clickText(page, '.kd-dialog__foot .btn-primary', 'Done');
    await sleep(800);
    await page.click('.kd-tidy-banner .btn');
    await page.waitForSelector('.kd-tidy-job');
    ok(!(await page.evaluate(() => [...document.querySelectorAll('.kd-tidy-job')].some((j) => /room count/.test(j.textContent)))), 'with the counts fixed, the room job is gone');
    await page.evaluate(() => { const j = [...document.querySelectorAll('.kd-tidy-job')].find((x) => /logo/.test(x.textContent)); const i = j?.querySelector('input'); if (i?.checked) i.click(); });
    await clickText(page, '.kd-dialog__foot .btn-primary', 'Start');
    await page.waitForFunction(() => document.querySelectorAll('.kd-tidy-log li').length >= 3, { timeout: 30000 });
    await clickText(page, '.kd-dialog__foot .btn', 'Stop');
    await page.waitForFunction(() => /updated/.test(document.querySelector('.kd-tidy-run strong')?.textContent || ''), { timeout: 30000 });
    const altSaved = Object.values(api.st.kids).reduce((n, k) => n + (k.photos || []).filter((p) => /^Described photo/.test(p.alt || '')).length, 0);
    ok(altSaved > 0 && await page.evaluate(() => /Stopped/.test(document.querySelector('.kd-tidy-log').textContent)), `alt text runs and stops cleanly (${altSaved} written)`);
    const handWritten = Object.values(KIDS0).flatMap((k) => (k.photos || []).filter((p) => p.alt).map((p) => [k.slug, p.url, p.alt]));
    ok(handWritten.every(([slug, url, alt]) => !api.st.kids[slug] || api.st.kids[slug].photos.find((p) => p.url === url)?.alt === alt), 'alt text written by hand is never replaced');
    ok(!errors.length, `no console errors (${errors.join(' | ').slice(0, 300)})`);
    await page.close();
  }

  // ════════ Phone ════════
  console.log('Phone 390');
  {
    const { page, api, errors } = await open(browser, { width: 390, height: 844, mobile: true });
    await goKids(page, true);
    await shot(page, 'phone-list');
    ok(!(await overflowing(page)).length, `the list fits the screen (${(await overflowing(page)).join(', ')})`);
    const small = await smallTargets(page, '.kd-row .kd-grip, .kd-row .ppl-menu__btn, .kd-filter, .kd-head__actions .btn, .kd-year__btn');
    ok(!small.length, `list targets are 44px (${small.join('; ')})`);
    // Upload photos and videos, as a sheet
    await clickText(page, '.kd-head__actions .btn-primary', 'Upload photos and videos');
    await page.waitForSelector('#kd-up-kid');
    await page.select('#kd-up-kid', 'axel');
    writeFileSync(join(OUT, 'clip-a-really-long-file-name-from-the-photographer-2026-11-09-final-final.mp4'), Buffer.alloc(2048, 1));
    writeFileSync(join(OUT, 'IMG_20231025_143012345_HDR_PORTRAIT_BURST_COVER_EXTRA_LONG_NAME_FROM_THE_CAMERA_FINAL_FINAL_V2.pdf'), 'x');
    await (await page.$('.kd-up input[type=file]')).uploadFile(PNG, join(OUT, 'clip-a-really-long-file-name-from-the-photographer-2026-11-09-final-final.mp4'), join(OUT, 'notes.txt'),
      join(OUT, 'IMG_20231025_143012345_HDR_PORTRAIT_BURST_COVER_EXTRA_LONG_NAME_FROM_THE_CAMERA_FINAL_FINAL_V2.pdf'));
    await page.waitForFunction(() => [...document.querySelectorAll('.kd-dialog__foot .btn')].some((b) => b.textContent.trim() === 'Done'), { timeout: 20000 });
    await sleep(500); // the sheet's slide up
    await shot(page, 'phone-upload', { grow: false });
    const sheet = await page.evaluate(() => {
      const d = document.querySelector('.kd-up-dialog').getBoundingClientRect();
      const out = [...document.querySelectorAll('.kd-up-dialog *')].filter((el) => { const r = el.getBoundingClientRect(); return r.width && (r.right > d.right + 1 || r.left < d.left - 1); });
      return { fits: d.left >= 0 && d.right <= innerWidth, out: out.slice(0, 4).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 30)}`) };
    });
    ok(sheet.fits && !sheet.out.length, `the upload sheet fits the screen, long file names too (${sheet.out.join(', ')})`);
    const smallUp = await smallTargets(page, '.kd-up-dialog .btn, .kd-up-dialog .kd-x');
    ok(!smallUp.length, `upload sheet targets are 44px (${smallUp.join('; ')})`);
    ok(api.st.kids.axel.photos.length === KIDS0.axel.photos.length + 1 && api.st.kids.axel.streamVideoId === VID(1), 'on a phone the photo and the video land on Axel’s page');
    await clickText(page, '.kd-dialog__foot .btn', 'Done');
    await sleep(300);
    await openKid(page, 'Colin');
    ok(await page.$('.kd-story-peek') && !(await page.$('#kd-sec-story .rte-wrap')), 'on a phone the story shows as a preview');
    await page.evaluate(() => document.querySelector('.kd-story-peek').click());
    await sleep(300);
    ok(await page.$('#kd-sec-story .rte-wrap'), 'tapping it opens the story editor');
    await shot(page, 'phone-editor');
    ok(!(await overflowing(page)).length, `the editor fits the screen (${(await overflowing(page)).join(', ')})`);
    const bar = await page.$eval('.kd-bar', (e) => e.getBoundingClientRect().top);
    await page.evaluate(() => window.scrollTo(0, 1500));
    await sleep(300);
    const barScrolled = await page.$eval('.kd-bar', (e) => e.getBoundingClientRect().top);
    ok(bar > 56 && Math.abs(barScrolled - 56) < 2, `the section bar sticks under the top bar (${Math.round(barScrolled)}px)`);
    ok(await page.$eval('.kd-footer', (e) => { const r = e.getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.top < innerHeight; }), 'Save stays at the bottom of the screen');
    const smallEd = await smallTargets(page, '.kd-sec .btn:not(.kd-small-input), .kd-stepper button, .kd-bar__chip, .kd-footer .btn, .kd-status-opt, .kd-checks__row, .kd-card__delete, .kd-card__actions .btn');
    ok(!smallEd.length, `editor targets are 44px (${smallEd.join('; ')})`);
    // Touch drag on a photo's grip
    ok(!(await page.$('.kd-tile [data-kd-grip]')), 'on a phone, photo tiles stay clear of drag handles');
    await clickText(page, '#kd-sec-photos .kd-sec__actions .btn', 'Reorder');
    await sleep(200);
    ok((await smallTargets(page, '.kd-grip--tile')).length === 0 && await page.$('.kd-tile [data-kd-grip]'), 'Reorder shows 44px handles');
    await page.evaluate(() => document.querySelectorAll('.kd-tile')[0].scrollIntoView({ block: 'center' }));
    await sleep(300);
    const src0 = await page.evaluate(() => document.querySelectorAll('.kd-tile img')[0].getAttribute('src'));
    const g = await page.evaluate(() => { const r = document.querySelectorAll('.kd-tile')[0].querySelector('[data-kd-grip]').getBoundingClientRect(); const t = document.querySelectorAll('.kd-tile')[4].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, tx: t.x + t.width / 2, ty: t.y + t.height / 2 }; });
    await page.touchscreen.touchStart(g.x, g.y);
    for (let i = 1; i <= 12; i++) { await page.touchscreen.touchMove(g.x + (g.tx - g.x) * i / 12, g.y + (g.ty - g.y) * i / 12); await sleep(30); }
    await page.touchscreen.touchEnd();
    await sleep(400);
    const idx = await page.evaluate((s) => [...document.querySelectorAll('.kd-tile img')].findIndex((i) => i.getAttribute('src') === s), src0);
    ok(idx === 4, `a touch drag on the grip moves the photo (now at ${idx + 1})`);
    // The photo sheet fits
    await page.evaluate(() => document.querySelectorAll('.kd-tile__open')[1].click());
    await page.waitForSelector('.kd-photo-dlg');
    await sleep(400);
    ok(await page.$eval('.kd-photo-dlg', (e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight + 1 && r.width <= innerWidth; }), 'the photo opens as a sheet that fits the screen');
    await shot(page, 'phone-photo', { grow: false });
    ok(!errors.length, `no console errors (${errors.join(' | ').slice(0, 300)})`);
    await page.close();
  }
} catch (e) {
  failures.push(`crashed: ${e.stack}`);
  console.log(e);
} finally {
  await browser.close();
  stopDev();
}
console.log(`  hover sweep: ${hoverSeen.size} kinds of control checked under the pointer`);
console.log(failures.length ? `\n${failures.length} failed:\n- ${failures.join('\n- ')}` : '\nAll kids admin checks passed.');
process.exit(failures.length ? 1 : 0);
