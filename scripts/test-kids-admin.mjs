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
 *   - the side panel (status, profile health), Discard with Undo, adding a kid
 *     from the dialog, the photo wall, "/" to search, broken logos repaired
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
const PNG = join(OUT, 'pixel.png');
// Logos whose file is gone in Cloudflare (as on the live site): their old IDs answer 404
const BROKEN_IDS = ['partners/real-floors-commercial', 'partners/usa-insulation', 'partners/eclipse-brand-builders'];
const isBrokenImage = (url) => BROKEN_IDS.some((id) => url.includes(`/${id}/w=`) || url.endsWith(`/${id}/public`));
writeFileSync(PNG, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64'));

// ── The fake API ──
function makeApi() {
  const kids = structuredClone(KIDS0);
  const st = { kids, calls: [], waiting: new Set(), uploads: 0, versions: {}, vid: 0 };
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
      st.uploads++;
      return json({ success: true, imageId: `kids/test/up-${st.uploads}`, imageUrl: `https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/test/up-${st.uploads}/public` });
    }
    if (p === '/api/generate') {
      const b = body();
      if (b.type === 'alt-text') return json({ success: true, altTexts: (b.kid.photos || []).map((x, i) => `Described photo ${i + 1}`) });
      if (b.type === 'hero-summary') return json({ success: true, heroSummary: `${b.kid.name} is a test. SOARD built a room.` });
      if (b.type === 'seo') return json({ success: true, shortDescription: 'Short.', metaDescription: 'Meta description.' });
      return json({ success: false, error: 'type' }, 400);
    }
    if (p === '/api/stream-check') return json({ success: true, state: url.searchParams.get('uid')?.startsWith('6f3b') ? 'playable' : 'gone' });
    if (p === '/api/reveals-admin') return json({ success: true, reveals: [{ slug: 'colin', name: 'Colin', date: '2026-10-25', confirmed: true }, { slug: 'axel', name: 'Axel', date: '2026-11-08', confirmed: false }], jobs: { amari: '22PAMARI', colin: '22PCOLIN' }, statuses: { amari: 'Closed Done', colin: 'Build' } });
    if (p.startsWith('/api/pending-changes')) {
      return json({ success: true, changes: [...st.waiting].map((slug) => ({ type: 'kids', slug, name: st.kids[slug]?.name, state: 'waiting', action: 'updated', at: new Date().toISOString() })), publish: { live: null, active: null, failed: null, typicalSeconds: 480 } });
    }
    if (p.startsWith('/api/audit-log')) return json({ success: true, entries: [], total: 0 });
    if (p.startsWith('/api/deployments')) return json({ success: true, deploys: [], source: 'cloudflare' });
    if (p.startsWith('/api/live-ws')) { req.abort(); return true; }
    return json({ success: true, ok: true });
  };
  return { st, respond };
}

async function open(browser, { width, height, mobile }) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|net::ERR/.test(m.text())) errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 300)}`));
  page.on('dialog', (d) => d.accept());
  await answerAsks(page);
  const api = makeApi();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.isInterceptResolutionHandled()) return;
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

    // Validation: a bad fundraising link stops Save and shows where
    await page.type('#kd-fund', 'zeffy.com/oops');
    await page.click('.kd-bar__save .kd-save');
    await sleep(200);
    await settle(page);
    ok(callsTo(api, '/api/save-content') === 0, 'a bad link blocks Save');
    ok(await page.evaluate(() => { const r = document.getElementById('kd-sec-giving').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && document.activeElement?.id === 'kd-sec-giving-h'; }), 'and brings Giving into view');
    await page.click('#kd-fund', { clickCount: 3 });
    await page.type('#kd-fund', 'https://www.zeffy.com/en-US/donation-form/amari');

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
    ok(saved.fundraisingUrl === 'https://www.zeffy.com/en-US/donation-form/amari', 'the fundraising link saved');
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
    ok(!(await page.$('.kd-hist')) && await page.$eval('#kd-fund', (e) => e.value) === (amari.fundraisingUrl || '') && await page.$('.kd-bar__state.is-dirty'), 'Restore loads that version into the editor, unsaved');
    await clickToast(page, 'Undo');
    await sleep(250);
    ok(await page.$eval('#kd-fund', (e) => e.value) === 'https://www.zeffy.com/en-US/donation-form/amari' && await page.$('.kd-bar__state.is-saved'), 'Undo puts the saved version back');

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

  console.log('Desktop 1440: a new kid, the tidy tool');
  {
    const { page, api, errors } = await open(browser, { width: 1440, height: 1000, mobile: false });
    await goKids(page, false);
    await clickText(page, '.kd-head__actions .btn-primary', 'Add a kid');
    await page.waitForSelector('#kd-new-name');
    ok(await page.evaluate(() => document.activeElement?.id === 'kd-new-name'), 'Add a kid opens a dialog, ready to type');
    ok(await page.$eval('.kd-status-pick [aria-checked="true"]', (e) => e.textContent.startsWith('In build')), 'a new kid starts in build');
    await page.type('#kd-new-name', 'Dylan');
    ok(await page.evaluate(() => /already a Dylan/.test(document.querySelector('.kd-create').textContent) && /\/kids\/dylan-2026-2\//.test(document.querySelector('.kd-create').textContent)), 'a name already in use says so, with the new address');
    await page.click('#kd-new-name', { clickCount: 3 });
    await page.type('#kd-new-name', 'Test Kid');
    ok(await page.evaluate(() => /\/kids\/test-kid\//.test(document.querySelector('.kd-create').textContent)), 'the web address follows the name');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.kd-ed-head', { timeout: 10000 }).catch(async (e) => { console.log('DEBUG main:', (await page.evaluate(() => document.querySelector('.main')?.innerText.slice(0, 600))).replace(/\n+/g, ' | ')); console.log('DEBUG errors:', errors); throw e; });
    await sleep(600);
    const made0 = api.st.kids['test-kid'];
    ok(made0 && made0.publishStatus === 'draft' && made0.status === 'in-progress' && made0.year === new Date().getFullYear(), 'Create saves a hidden profile and opens it');
    ok(await page.$eval('.kd-ed-id h2', (e) => /Test Kid/.test(e.textContent)) && await page.$('.kd-card__delete'), 'the editor opens on the new profile');
    await page.type('#kd-ages', '7, x');
    await page.click('#kd-diagnosis');
    ok(await page.evaluate(() => document.querySelector('#kd-ages').classList.contains('is-invalid')), 'a bad age is flagged');
    await page.click('#kd-ages', { clickCount: 3 });
    await page.type('#kd-ages', '7, 9');
    await page.click('.kd-bar__save .kd-save');
    await sleep(800);
    const made = api.st.kids['test-kid'];
    ok(made && JSON.stringify(made.age) === '[7,9]' && made.roomTypes?.join() === 'Dream Bedroom', 'Save keeps the details');

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
    await page.click('.kd-bar__save .kd-save');
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
    await clickText(page, '.kd-dialog__foot .btn-primary', 'Start');
    await page.waitForFunction(() => /updated/.test(document.querySelector('.kd-tidy-run strong')?.textContent || ''), { timeout: 60000 });
    const namedKids = callsTo(api, '/api/save-content') - before;
    const unnamedLeft = Object.values(api.st.kids).reduce((n, k) => n + (k.partnerLogos || []).filter((l) => !String(l.name || '').trim() && /\/partners\//.test(l.url)).length, 0);
    ok(namedKids > 50 && callsTo(api, '/api/generate') === 0, `names come from the directory, no AI (${namedKids} profiles saved)`);
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
