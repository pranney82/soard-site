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
 *   - the row menu: Mark as completed (and Undo)
 *   - the editor: rooms (counts → roomTypes/roomCount), unsaved state that
 *     clears when an edit is undone, the photo dialog (alt text, main photo),
 *     reordering photos by mouse and keyboard, removing the main photo (the
 *     next one takes over, Undo), uploading (alt text written after), plan
 *     captions (address block crop), partners from the directory, the video
 *     the page plays, validation, the saved record, Preview, a new kid, delete
 *   - Profiles to tidy: partner logo names and alt text, Stop
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
import * as KS from '../public/admin/kids-shared.js';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/kids-admin/');
mkdirSync(OUT, { recursive: true });
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
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
writeFileSync(PNG, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64'));

// ── The fake API ──
function makeApi() {
  const kids = structuredClone(KIDS0);
  const st = { kids, calls: [], waiting: new Set(), uploads: 0 };
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
      st.kids[slug] = JSON.parse(b.content);
      st.waiting.add(slug);
      return json({ success: true, sha: `sha-${slug}-${Date.now()}` });
    }
    if (p === '/api/delete-content') {
      const slug = body().path.match(/kids\/(.+)\.json$/)?.[1];
      if (!st.kids[slug]) return json({ success: false, error: 'not found' }, 404);
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
    if (p === '/api/reveals-admin') return json({ success: true, reveals: [{ slug: 'colin', name: 'Colin', date: '2026-10-25', confirmed: true }, { slug: 'axel', name: 'Axel', date: '2026-11-08', confirmed: false }], jobs: { amari: '22PAMARI', colin: '22PCOLIN' } });
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
  const api = makeApi();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.isInterceptResolutionHandled()) return;
    if (new URL(req.url()).origin === SITE && api.respond(req) !== false) return;
    // Images: answered locally (the network isn't what's under test)
    if (req.resourceType() === 'image' && /imagedelivery|i\.ytimg|videodelivery/.test(req.url())) {
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
  await page.waitForSelector('.kd-ed-head', { timeout: 10000 });
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
    ok(!errors.length, `no console errors (${errors.join(' | ').slice(0, 300)})`);
    await page.close();
  }

  console.log('Desktop 1440: the editor');
  {
    const { page, api, errors } = await open(browser, { width: 1440, height: 1000, mobile: false });
    await goKids(page, false);
    await openKid(page, 'Amari');
    ok(await page.$eval('.kd-ed-id h2', (e) => e.textContent.startsWith('Amari')), 'the editor opens on Amari');
    ok(await page.$$eval('.kd-bar__chip', (c) => c.length) === 10, 'the section bar has all ten sections');
    ok(!(await page.$('.kd-ed-actions .ppl-unsaved')), 'opening a profile leaves nothing unsaved');
    await shot(page, 'desk-editor');

    // Rooms: + Therapy room, then − (unsaved clears again)
    const therapyPlus = await page.evaluateHandle(() => [...document.querySelectorAll('.kd-builds__list li')].find((li) => /Therapy room/.test(li.textContent)).querySelectorAll('button')[1]);
    await therapyPlus.click();
    await sleep(150);
    ok(await page.$('.kd-ed-actions .ppl-unsaved'), 'a change shows Unsaved changes');
    ok(await page.evaluate(() => /Adds 3 to “rooms built”/.test(document.querySelector('.kd-builds .form-hint').textContent)), 'the room summary counts three rooms');
    const therapyMinus = await page.evaluateHandle(() => [...document.querySelectorAll('.kd-builds__list li')].find((li) => /Therapy room/.test(li.textContent)).querySelectorAll('button')[0]);
    await therapyMinus.click();
    await sleep(150);
    ok(!(await page.$('.kd-ed-actions .ppl-unsaved')), 'undoing the change by hand clears it');
    await therapyPlus.click();

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
    ok(await page.$eval('.kd-photo-dlg h3', (e) => e.textContent.trim()) === `Photo 3 of ${amari.photos.length}`, 'a photo opens large, with its place');
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
    await page.click('.kd-ed-actions .kd-save');
    await sleep(200);
    await settle(page);
    ok(callsTo(api, '/api/save-content') === 0, 'a bad link blocks Save');
    ok(await page.evaluate(() => { const r = document.getElementById('kd-sec-giving').getBoundingClientRect(); return r.top >= 0 && r.top < 200; }), 'and scrolls to Giving');
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
    ok(!(await page.$('.kd-ed-actions .ppl-unsaved')), 'after saving nothing is unsaved');

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
    await page.evaluate(() => document.getElementById('kd-sec-record').scrollIntoView());
    await clickText(page, '#kd-sec-record .btn', 'Delete…');
    await sleep(200);
    await clickText(page, '.modal .btn-danger', 'Delete profile');
    await page.waitForSelector('.kd-row', { timeout: 10000 });
    ok(!api.st.kids.amari, 'Delete removes the profile and goes back to the list');
    ok(!errors.length, `no console errors (${errors.join(' | ').slice(0, 300)})`);
    await page.close();
  }

  console.log('Desktop 1440: a new kid, the tidy tool');
  {
    const { page, api, errors } = await open(browser, { width: 1440, height: 1000, mobile: false });
    await goKids(page, false);
    await clickText(page, '.kd-head__actions .btn-primary', 'Add a kid');
    await page.waitForSelector('#kd-name');
    await page.type('#kd-name', 'Test Kid');
    ok(await page.evaluate(() => /\/kids\/test-kid\//.test(document.querySelector('#kd-sec-basics').textContent)), 'the web address follows the name');
    ok(await page.$eval('.ppl-seg [aria-checked="true"]', (e) => e.textContent) === 'In build', 'a new kid starts in build');
    await page.type('#kd-ages', '7, x');
    await page.click('#kd-diagnosis');
    ok(await page.evaluate(() => document.querySelector('#kd-ages').classList.contains('is-invalid')), 'a bad age is flagged');
    await page.click('#kd-ages', { clickCount: 3 });
    await page.type('#kd-ages', '7, 9');
    await page.click('.kd-ed-actions .kd-save');
    await page.waitForFunction(() => /Test Kid/.test(document.querySelector('.kd-ed-id h2')?.textContent || '') && document.querySelector('.kd-ed-head [aria-pressed]'), { timeout: 10000 });
    await sleep(800);
    const made = api.st.kids['test-kid'];
    ok(made && made.status === 'in-progress' && JSON.stringify(made.age) === '[7,9]' && made.roomTypes?.join() === 'Dream Bedroom', 'Save creates /kids/test-kid with the details');
    ok(await page.evaluate(() => !!document.querySelector('#kd-sec-record .kd-danger-quiet')), 'and the editor switches to the saved profile');

    // Tidy: names only (fast), then alt text, stopped after a few
    await page.evaluate(() => document.querySelector('.breadcrumb button').click());
    await page.waitForSelector('.kd-tidy-banner');
    await page.click('.kd-tidy-banner .btn');
    await page.waitForSelector('.kd-tidy-job');
    const job = (text) => page.evaluate((t) => [...document.querySelectorAll('.kd-tidy-job')].find((j) => j.textContent.includes(t))?.querySelector('input').click(), text);
    await job('alt text');
    const before = callsTo(api, '/api/save-content');
    await clickText(page, '.kd-dialog__foot .btn-primary', 'Start');
    await page.waitForFunction(() => /updated/.test(document.querySelector('.kd-tidy-run strong')?.textContent || ''), { timeout: 60000 });
    const namedKids = callsTo(api, '/api/save-content') - before;
    const unnamedLeft = Object.values(api.st.kids).reduce((n, k) => n + (k.partnerLogos || []).filter((l) => !String(l.name || '').trim() && /\/partners\//.test(l.url)).length, 0);
    ok(namedKids > 50 && callsTo(api, '/api/generate') === 0, `names come from the directory, no AI (${namedKids} profiles saved)`);
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
    await shot(page, 'phone-editor');
    ok(!(await overflowing(page)).length, `the editor fits the screen (${(await overflowing(page)).join(', ')})`);
    const bar = await page.$eval('.kd-bar', (e) => e.getBoundingClientRect().top);
    await page.evaluate(() => window.scrollTo(0, 1500));
    await sleep(300);
    const barScrolled = await page.$eval('.kd-bar', (e) => e.getBoundingClientRect().top);
    ok(bar > 56 && Math.abs(barScrolled - 56) < 2, `the section bar sticks under the top bar (${Math.round(barScrolled)}px)`);
    ok(await page.$eval('.kd-footer', (e) => { const r = e.getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.top < innerHeight; }), 'Save stays at the bottom of the screen');
    const smallEd = await smallTargets(page, '.kd-sec .btn:not(.kd-small-input), .kd-stepper button, .kd-bar__chip, .kd-grip--tile, .kd-footer .btn');
    ok(!smallEd.length, `editor targets are 44px (${smallEd.join('; ')})`);
    // Touch drag on a photo's grip
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
console.log(failures.length ? `\n${failures.length} failed:\n- ${failures.join('\n- ')}` : '\nAll kids admin checks passed.');
process.exit(failures.length ? 1 : 0);
