/**
 * test-community-admin.mjs — drive Admin → Kids → Community Projects in a real browser
 * ====================================================================================
 * Loads the admin from an Astro dev server (so Preview can frame the real
 * project page) with every /api/* call answered from an in-memory copy of
 * src/content/community, kids and partners. Checks, at 1440px and 390px:
 *   - the list: the Community page's order, the children reached total, Needs
 *     attention (matches community-shared.js), search, "/" to search, cards
 *   - the order on the Community page by keyboard and by dragging: one
 *     /api/reorder-content request with every project, Undo
 *   - the row menu: Mark as in progress, Hide from the site (and Undo)
 *   - the editor: an older plain-text story keeps its paragraphs without
 *     reading as unsaved, impact numbers and the one counted toward "children
 *     reached", the photo dialog (alt text, main photo, focal point), the saved
 *     record (imageId and imageAlt follow the main photo), removing the main
 *     photo (Undo), alt text, quote and who said it, AI summary and search
 *     description, partners, the video, validation, Discard with Undo,
 *     History and restore, Preview, delete and Recently deleted
 *   - adding a project from the dialog (saved hidden, first on the page)
 *   - the Dashboard's item for projects that need attention; uploading photos
 *     (alt text written after) and a logo; unsaved work surviving a reload
 *   - Projects to tidy: search descriptions and alt text, Stop
 *   - phone: nothing past the content column, 44px targets, the story preview,
 *     touch drag on a photo's grip, sheets that fit the screen
 * Screenshots land in test-results/community-admin/. Exits non-zero on any
 * failure or console error.
 *
 *   SITE=http://localhost:4321 node scripts/test-community-admin.mjs
 * Without SITE it starts `astro dev` on a spare port and stops it after.
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hoverSweep } from './lib/hover-sweep.mjs';
import * as CS from '../public/admin/community-shared.js';
import { answerAsks } from './lib/ask.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/community-admin/');
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
const KIDS = readDir('kids');
const PROJECTS0 = readDir('community');
for (const [slug, d] of Object.entries(PROJECTS0)) d.slug ||= slug;
const PNG = join(OUT, 'pixel.png');
writeFileSync(PNG, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64'));

// ── The fake API ──
function makeApi() {
  const projects = structuredClone(PROJECTS0);
  const st = { projects, calls: [], waiting: new Set(), uploads: 0, versions: {}, vid: 0 };
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
      const src = dir === 'src/content/community' ? st.projects : dir === 'src/content/partners' ? PARTNERS : dir === 'src/content/kids' ? KIDS : {};
      const items = Object.entries(src).map(([slug, c]) => ({ name: `${slug}.json`, path: `${dir}/${slug}.json`, sha: slug, content: c }));
      return json({ success: true, items, count: items.length, total: items.length, pages: 1 });
    }
    if (p === '/api/read-content') {
      const m = url.searchParams.get('path').match(/^src\/content\/community\/(.+)\.json$/);
      const c = m && st.projects[m[1]];
      return c ? json({ success: true, content: c, sha: `sha-${m[1]}-${JSON.stringify(c).length}` }) : json({ success: false, error: 'Not found' }, 404);
    }
    if (p === '/api/save-content') {
      const b = body();
      const slug = b.path.match(/community\/(.+)\.json$/)?.[1];
      if (!slug) return json({ success: false, error: 'not a project' }, 400);
      const previous = st.projects[slug];
      st.projects[slug] = JSON.parse(b.content);
      if (!st.versions[slug]?.length && previous) version(slug, previous, null);
      version(slug, st.projects[slug], 'staff@soard.org');
      st.waiting.add(slug);
      return json({ success: true, sha: `sha-${slug}-${Date.now()}` });
    }
    if (p === '/api/delete-content') {
      const slug = body().path.match(/community\/(.+)\.json$/)?.[1];
      if (!st.projects[slug]) return json({ success: false, error: 'not found' }, 404);
      version(slug, st.projects[slug], 'staff@soard.org', 'delete');
      delete st.projects[slug];
      return json({ success: true });
    }
    if (p === '/api/reorder-content') {
      const b = body();
      if (b.collection !== 'community') return json({ success: false, error: 'wrong list' }, 403);
      const moved = [];
      for (const it of b.items) if (st.projects[it.slug] && st.projects[it.slug].order !== it.order) { st.projects[it.slug] = { ...st.projects[it.slug], order: it.order }; moved.push(it.slug); }
      moved.forEach((s) => st.waiting.add(s));
      return json({ success: true, changed: moved, shas: {} });
    }
    if (p === '/api/content-history') {
      const q = url.searchParams;
      if (q.get('collection') !== 'community') return json({ success: true, versions: [], deleted: [] });
      if (q.get('deleted')) {
        const deleted = Object.entries(st.versions).filter(([s2, v]) => v.at(-1).action === 'delete' && !st.projects[s2])
          .map(([s2, v]) => ({ id: v.at(-1).id, slug: s2, name: v.at(-1).data.name, year: v.at(-1).data.year, image: v.at(-1).data.heroImage, at: v.at(-1).at, by: v.at(-1).by }));
        return json({ success: true, deleted });
      }
      const list = st.versions[q.get('slug')] || [];
      if (q.get('id')) { const v = list.find((x) => x.id === Number(q.get('id'))); return v ? json({ success: true, data: v.data }) : json({ success: false, error: 'That version is gone' }, 404); }
      return json({ success: true, versions: list.map((v, i) => ({ id: v.id, at: v.at, by: v.by, action: v.action, changed: i ? changed(list[i - 1].data, v.data) : null })).reverse() });
    }
    if (p === '/api/upload-image') {
      st.uploads++;
      return json({ success: true, imageId: `community/test/up-${st.uploads}`, imageUrl: `https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/community/test/up-${st.uploads}/public` });
    }
    if (p === '/api/generate') {
      const b = body();
      if (b.type === 'alt-text') return json({ success: true, altTexts: (b.kid.photos || []).map((x, i) => (b.kid.kind === 'community' ? `Project photo ${i + 1}` : `Kid photo ${i + 1}`)) });
      if (b.type === 'project-summary') return json({ success: true, description: `${b.kid.name} serves children. SOARD renovated it.` });
      if (b.type === 'seo') return json({ success: true, metaDescription: `Sunshine on a Ranney Day renovated ${b.kid.name}.` });
      return json({ success: false, error: 'type' }, 400);
    }
    if (p === '/api/stream-check') return json({ success: true, state: url.searchParams.get('uid') === '15a406d484ac21cec7d98ce015eddc15' ? 'playable' : 'gone' });
    if (p.startsWith('/api/pending-changes')) {
      return json({ success: true, changes: [...st.waiting].map((slug) => ({ type: 'community', slug, name: st.projects[slug]?.name, state: 'waiting', action: 'updated', at: new Date().toISOString() })), publish: { live: null, active: null, failed: null, typicalSeconds: 480 } });
    }
    if (p.startsWith('/api/audit-log')) return json({ success: true, entries: [], total: 0 });
    if (p.startsWith('/api/deployments')) return json({ success: true, deploys: [], source: 'cloudflare' });
    if (p.startsWith('/api/live-ws')) { req.abort(); return true; }
    return json({ success: true, ok: true, reveals: [], jobs: {} });
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
    if (req.resourceType() === 'image' && /imagedelivery|i\.ytimg|videodelivery/.test(req.url())) return req.respond({ status: 200, contentType: 'image/png', body: readFileSync(PNG) });
    req.continue();
  });
  // A fresh start each time, unless a test reloads on purpose (unsaved work surviving a closed tab)
  await page.evaluateOnNewDocument(() => { try { if (!sessionStorage.getItem('soard-test-keep')) localStorage.clear(); } catch {} });
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
async function goCommunity(page, mobile) {
  if (mobile) { await page.evaluate(() => document.querySelector('.hamburger')?.click()); await sleep(350); }
  await clickText(page, '.nav-item', 'Kids');
  await page.waitForSelector('.hub-tab', { timeout: 15000 });
  await clickText(page, '.hub-tab', 'Community Projects');
  await page.waitForSelector('.cm-row', { timeout: 15000 });
  await sleep(400);
}
const rowSlugs = (page) => page.$$eval('.cm-row', (rs) => rs.map((r) => r.dataset.slug));
const lastCall = (api, path) => [...api.st.calls].reverse().find((c) => c.path === path);
const callsTo = (api, path) => api.st.calls.filter((c) => c.path === path).length;
const clickToast = (page, label) => page.evaluate((l) => { const b = [...document.querySelectorAll('.toast-undo')].reverse().find((x) => x.textContent.trim() === l); b?.click(); return !!b; }, label);
const openProject = async (page, slug) => {
  await page.evaluate((s) => document.querySelector(`.cm-row[data-slug="${s}"] .kd-row__name`)?.click(), slug);
  await page.waitForSelector('.kd-ed-head', { timeout: 10000 });
  await sleep(600);
};
const saved = (api, slug) => api.st.projects[slug];
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

const projects = Object.values(PROJECTS0);
const order0 = CS.adminOrder(projects).map((p) => p.slug);
const expectWarn = projects.filter((p) => CS.projectIssues(p).some((i) => i.tone === 'warn')).length;
const reached0 = CS.listOrder(projects).reduce((n, p) => n + CS.reachedCount(p), 0);
const cottage = PROJECTS0['the-cottage-school'];
const harmony = PROJECTS0['perfect-harmony-health'];
const newPartner = Object.values(PARTNERS).find((p) => p.logo && !cottage.partnerLogos.some((l) => l.url === p.logo) && /^[A-Z][a-z]+ [A-Z]/.test(p.name));
const idOf = CS.imageIdOf;

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 90000,
  args: ['--disable-gpu', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'] });
try {
  // ════════ Desktop ════════
  console.log('Desktop 1440: the list');
  {
    const { page, api, errors } = await open(browser, { width: 1440, height: 1000, mobile: false });
    await goCommunity(page, false);
    const sub = await page.$eval('.kd-head .page-sub', (e) => e.textContent);
    ok(sub.startsWith(`${projects.length} projects · ${reached0.toLocaleString()} children reached`), `the header counts projects and children reached, as the page does (${sub.slice(0, 48)})`);
    ok(JSON.stringify(await rowSlugs(page)) === JSON.stringify(order0), 'rows follow the Community page’s order');
    const attention = await page.$eval('.kd-filter:nth-child(2) span', (e) => Number(e.textContent));
    ok(attention === expectWarn, `Needs attention counts what community-shared.js flags (${attention} = ${expectWarn})`);
    ok(await page.evaluate(() => /Counted number isn’t people/.test(document.querySelector('.cm-row[data-slug="perfect-harmony-health"]')?.textContent || '')), 'Perfect Harmony is flagged: it counts hours toward children reached');
    ok(await page.$eval('.kd-tidy-banner', (e) => /search descriptions? to write/.test(e.textContent) && /without alt text/.test(e.textContent)), 'Projects to tidy names the bulk fixes');
    ok(!(await page.evaluate(() => [...document.querySelectorAll('.kd-row__issues .kd-chip')].some((c) => /alt text|unnamed|Summary runs long/.test(c.textContent)))), 'rows leave bulk fixes to the tidy banner');
    await shot(page, 'desk-list');

    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('/');
    ok(await page.evaluate(() => document.activeElement?.matches('.kd-search input')), '“/” puts the cursor in search');
    await page.keyboard.type('twin lakes');
    await sleep(250);
    ok(JSON.stringify(await rowSlugs(page)) === JSON.stringify(['camp-twin-lakes']), 'search narrows the list');
    ok(await page.$$eval('.cm-row .kd-grip', (g) => g.length) === 0, 'no reordering while the list is narrowed');
    await page.keyboard.press('Escape');
    await sleep(200);
    await page.evaluate(() => [...document.querySelectorAll('.kd-view button')].find((b) => /Cards/.test(b.textContent)).click());
    await sleep(250);
    ok(await page.$$eval('.cm-cards__btn', (b) => b.length) === projects.length && !(await page.$('.cm-row')), 'Cards shows every project as the page does');
    ok(await page.evaluate(() => /In Progress/.test(document.querySelector('.cm-cards__item[data-slug="perfect-harmony-health"]')?.textContent || '')), 'an in-progress card carries the badge');
    await shot(page, 'desk-cards');
    await page.evaluate(() => [...document.querySelectorAll('.kd-view button')].find((b) => /List/.test(b.textContent)).click());
    await sleep(250);

    // Reorder by keyboard: second row up one
    await page.evaluate(() => document.querySelectorAll('.cm-row .kd-grip')[1].focus());
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Space');
    await sleep(500);
    const r1 = lastCall(api, '/api/reorder-content');
    const expect1 = [order0[1], order0[0], ...order0.slice(2)];
    ok(r1 && r1.body.collection === 'community' && JSON.stringify(r1.body.items.map((i) => i.slug)) === JSON.stringify(expect1) && r1.body.items.every((it, i) => it.order === i + 1),
      'the keyboard moves a project: one request, every project, orders from 1');
    ok(JSON.stringify(await rowSlugs(page)) === JSON.stringify(expect1), 'the list shows the new order');
    await clickToast(page, 'Undo');
    await sleep(600);
    ok(JSON.stringify(lastCall(api, '/api/reorder-content').body.items.map((i) => i.slug)) === JSON.stringify(order0), 'Undo puts the order back');

    // Drag: the third row to the top
    await sleep(300);
    const before = await rowSlugs(page);
    await dragBetween(page, `.cm-row[data-slug="${before[2]}"] .kd-grip`, `.cm-row[data-slug="${before[0]}"] .kd-grip`, { past: 10 });
    await sleep(500);
    const r2 = lastCall(api, '/api/reorder-content');
    ok(r2.body.items[0].slug === before[2], `dragging a row to the top saves that order (${r2.body.items.slice(0, 3).map((i) => i.slug).join(', ')})`);

    // Row menu: in progress, then hide
    const slug = 'camp-twin-lakes';
    await page.evaluate((s) => document.querySelector(`.cm-row[data-slug="${s}"] .ppl-menu__btn`).click(), slug);
    await sleep(150);
    await clickText(page, '.ppl-menu__item, [role="menuitem"]', 'Mark as in progress');
    await sleep(600);
    ok(saved(api, slug).status === 'in-progress', 'the row menu marks a project in progress');
    await clickToast(page, 'Undo');
    await sleep(600);
    ok(saved(api, slug).status === 'completed', 'Undo puts the status back');
    await page.evaluate((s) => document.querySelector(`.cm-row[data-slug="${s}"] .ppl-menu__btn`).click(), slug);
    await sleep(150);
    await clickText(page, '.ppl-menu__item, [role="menuitem"]', 'Hide from the site');
    await sleep(700);
    ok(saved(api, slug).publishStatus === 'draft' && await page.evaluate((s) => /Draft/.test(document.querySelector(`.cm-row[data-slug="${s}"]`)?.textContent || ''), slug), 'Hide from the site makes it a draft, tagged in the list');
    ok(await page.evaluate(() => [...document.querySelectorAll('.kd-filter')].some((f) => /Drafts/.test(f.textContent))), 'a Drafts filter appears');
    ok(!errors.length, `no console errors (${errors.join(' | ').slice(0, 300)})`);
    await page.close();
  }

  console.log('Desktop 1440: the editor');
  {
    const { page, api, errors } = await open(browser, { width: 1440, height: 1000, mobile: false });
    await goCommunity(page, false);
    await openProject(page, 'the-cottage-school');
    ok(await page.$eval('.kd-ed-id h2', (e) => e.textContent.trim().startsWith('The Cottage School')), 'the editor opens on the project');
    ok(await page.$('.kd-bar__state.is-saved'), 'an older plain-text story doesn’t read as an unsaved change');
    ok(await page.$$eval('#kd-sec-story .ProseMirror p', (ps) => ps.length) === CS.storyParas(cottage.story).length, `its paragraphs stay paragraphs in the editor (${CS.storyParas(cottage.story).length})`);
    ok(await page.$eval('.kd-card--site .cm-card__name', (e) => e.textContent.trim()) === 'The Cottage School', 'On the site shows the card as the page will');
    const checks = await page.$eval('.kd-card--health .kd-card__count', (e) => e.textContent.trim());
    ok(checks === `${CS.projectChecks(CS.projectRecord(CS.forEditing(cottage))).filter((c) => c.done).length} of ${CS.projectChecks(CS.projectRecord(CS.forEditing(cottage))).length}`, `project health counts its checks (${checks})`);

    // Impact numbers and the counted one
    await page.click('.cm-stat__value', { clickCount: 3 });
    await page.keyboard.type('250');
    await sleep(200);
    ok(await page.$('.kd-bar__state.is-dirty') && /Adds 250 to/.test(await page.$eval('.cm-stats .form-hint[role="status"]', (e) => e.textContent)), 'editing the number marks the project unsaved and updates what it adds');
    await page.click('.cm-stat__none input');
    await sleep(150);
    ok(/Adds nothing/.test(await page.$eval('.cm-stats .form-hint[role="status"]', (e) => e.textContent)), '“None of these” counts nothing');
    await page.click('.cm-stat .cm-stat__count input');
    await clickText(page, '.cm-stats__foot .btn', 'Add a number');
    await sleep(150);
    const vals = await page.$$('.cm-stat__value');
    await vals[1].type('60');
    await (await page.$$('.cm-stat__label'))[1].type('years serving families');
    await sleep(150);

    // A photo: main photo, alt text, focal point
    await page.evaluate(() => document.querySelectorAll('#kd-sec-photos .kd-tile__open')[1].click());
    await page.waitForSelector('.kd-photo-dlg');
    ok(await page.$eval('.kd-photo-dlg h2', (e) => e.textContent.trim()) === `Photo 2 of ${cottage.photos.length}`, 'a photo opens large');
    await page.type('#kd-photo-alt', 'The new lobby');
    await clickText(page, '.kd-photo-dlg .kd-role', 'Main photo');
    await page.waitForSelector('.kd-focus img');
    await sleep(300);
    const fp = await page.$eval('.kd-photo-dlg .kd-focus', (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width * 0.25, y: r.y + r.height * 0.75, w: r.width, h: r.height }; });
    const hit = await page.evaluate((x, y) => { const e = document.elementFromPoint(x, y); return `${e?.tagName}.${e?.className}`; }, fp.x, fp.y);
    await page.mouse.click(fp.x, fp.y);
    await sleep(300);
    if (!(await page.$('.kd-focus__mark'))) console.log('   focal click landed on', hit, JSON.stringify(fp));
    const crops = await page.$$eval('.kd-photo-dlg .kd-crops img', (is) => is.map((i) => ({ src: i.getAttribute('src'), pos: i.style.objectPosition })));
    const at2575 = (pos) => /^2[45](\.\d)?% 7[45](\.\d)?%$/.test(pos);
    ok(crops.length === 4 && crops.slice(0, 3).every((c) => at2575(c.pos)) && /gravity=0\.2\d*x0\.7\d*/.test(crops[3].src),
      `the page’s crops (card, phone card, top of page) center on the focal point as the page does, and so does the shared image (${crops[0]?.pos}; ${crops[3]?.src.match(/gravity=[^,]+/)?.[0]})`);
    await page.keyboard.press('Escape');
    await sleep(200);
    ok(at2575(await page.$eval('.cm-feature__img', (e) => e.style.objectPosition)) && at2575(await page.$eval('.kd-card--site .cm-card__frame img', (e) => e.style.objectPosition)), 'the main photo and the card preview show the new crop');

    // Quote, summary, search description (AI)
    await page.type('#cm-quote-by', 'Jane Doe, Head of School');
    await clickText(page, '#kd-sec-basics .btn', 'Rewrite from the story');
    await page.waitForFunction(() => /serves children/.test(document.querySelector('#cm-summary').value), { timeout: 5000 }).catch(() => {});
    ok(await page.$eval('#cm-summary', (e) => e.value) === 'The Cottage School serves children. SOARD renovated it.', 'the summary is written from the story');
    const gen = api.st.calls.filter((c) => c.path === '/api/generate').at(-1);
    ok(gen?.body.type === 'project-summary' && gen.body.kid.kind === 'community', 'it asks for a project summary');

    // Partners from the directory
    await page.type('#cm-partner-q', newPartner.name.slice(0, 6));
    await sleep(250);
    await page.keyboard.press('Enter');
    await sleep(200);
    ok(await page.evaluate((n) => [...document.querySelectorAll('.kd-logo input')].some((i) => i.value === n), newPartner.name), `a partner comes in from the directory, named (${newPartner.name})`);

    // Validation, then save
    await page.click('#cm-yt');
    await page.keyboard.type('https://example.com/video');
    await page.click('.kd-bar__save .kd-save');
    await sleep(400);
    ok(!api.st.calls.some((c) => c.path === '/api/save-content'), 'a link the page can’t play stops the save');
    await page.click('#cm-yt', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.click('.kd-bar__save .kd-save');
    await sleep(800);
    const rec = saved(api, 'the-cottage-school');
    const photo2 = cottage.photos[1];
    ok(rec.heroImage === photo2.url && rec.imageId === idOf(photo2.url) && rec.imageAlt === 'The new lobby', 'the saved record: the card fields follow the new main photo and its alt text');
    ok(JSON.stringify(rec.stats) === JSON.stringify([{ value: '250', label: 'students supported', reached: true }, { value: '60', label: 'years serving families', reached: false }]) && rec.impact === '250',
      `the saved numbers, with the counted one marked (${JSON.stringify(rec.stats)})`);
    ok(rec.photos[1].focus && Math.abs(rec.photos[1].focus.x - 0.25) < 0.02 && rec.photos[1].alt === 'The new lobby', 'the photo keeps its focal point and alt text');
    ok(rec.quoteBy === 'Jane Doe, Head of School' && /^<p>/.test(rec.story) && rec.partnerLogos.some((l) => l.name === newPartner.name), 'quote by, the story as paragraphs, and the new partner are saved');
    ok(!('cfImageId' in rec.photos[0]) && !rec.photos.some((p) => p._key), 'editor-only fields stay out of the record');

    // Removing the main photo: the first one takes over, Undo
    await page.evaluate(() => document.querySelectorAll('#kd-sec-photos .kd-tile__open')[1].click());
    await page.waitForSelector('.kd-photo-dlg');
    await clickText(page, '.kd-photo-dlg .btn', 'Remove photo');
    await sleep(300);
    ok(await page.$eval('.cm-feature__img', (e) => e.getAttribute('src')).then((s) => s.includes(idOf(cottage.photos[0].url))), 'removing the main photo makes the first one main');
    await clickToast(page, 'Undo');
    await sleep(300);
    ok(await page.$('.kd-bar__state.is-saved'), 'Undo brings it back, nothing unsaved');

    // Alt text for the rest
    await clickText(page, '#kd-sec-photos .btn', 'Write');
    await page.waitForFunction(() => !document.querySelector('#kd-sec-photos .kd-tile__noalt'), { timeout: 8000 }).catch(() => {});
    ok(!(await page.$('#kd-sec-photos .kd-tile__noalt')), 'alt text is written for every photo without it');
    await clickText(page, '#kd-sec-search .btn', 'Rewrite it');
    await sleep(500);
    ok(await page.$eval('#cm-meta', (e) => e.value) === 'Sunshine on a Ranney Day renovated The Cottage School.', 'the search description is written');
    // Discard with Undo
    await clickText(page, '.kd-bar__save .btn', 'Discard');
    await sleep(300);
    ok(await page.$('.kd-bar__state.is-saved') && await page.$eval('#cm-meta', (e) => e.value) === cottage.metaDescription, 'Discard goes back to the saved version');
    await clickToast(page, 'Undo');
    await sleep(300);
    ok(await page.$eval('#cm-meta', (e) => e.value).then((v) => /renovated The Cottage School/.test(v)), 'Undo brings the changes back');
    await page.click('.kd-bar__save .kd-save');
    await sleep(800);

    // History
    await page.waitForFunction(() => document.querySelectorAll('.kd-card--history .kd-history__row').length >= 3, { timeout: 5000 }).catch(() => {});
    const hist = await page.$$eval('.kd-history__row', (r) => r.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
    ok(hist.length === 3 && /^Staff/.test(hist[0]) && /Before history/.test(hist[2]) && /Impact numbers|Main photo/.test(hist[1]), `History lists each save and what it changed (${hist[1]?.slice(0, 80)})`);
    await page.evaluate(() => document.querySelector('.kd-history__all').click());
    await page.waitForSelector('.kd-hist__item');
    await page.evaluate(() => [...document.querySelectorAll('.kd-hist__item')].at(-1).click());
    await page.waitForFunction(() => /Restoring it changes/.test(document.querySelector('.kd-hist__detail')?.textContent || ''), { timeout: 5000 });
    ok(await page.evaluate(() => /Impact numbers/.test(document.querySelector('.kd-hist__changes.is-restore')?.textContent || '')), 'the oldest version shows what restoring it changes');
    await clickText(page, '.kd-dialog .btn', 'Restore this version');
    await sleep(300);
    ok(await page.$eval('.cm-stat__value', (e) => e.value) === '200+' && await page.$('.kd-bar__state.is-dirty'), 'Restore loads that version, unsaved');
    await clickToast(page, 'Undo');
    await sleep(300);
    ok(await page.$eval('.cm-stat__value', (e) => e.value) === '250', 'Undo puts the editor back');

    // Preview frames the real page
    await page.click('.kd-ed-actions .btn-ghost[aria-pressed]');
    await page.waitForSelector('.page-preview iframe', { timeout: 20000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.page-preview iframe')].some((f) => f.style.visibility !== 'hidden' && f.contentDocument?.querySelector('.cp-detail-hero')), { timeout: 30000 }).catch(() => {});
    const framed = await page.evaluate(() => {
      const f = [...document.querySelectorAll('.page-preview iframe')].find((x) => x.style.visibility !== 'hidden');
      const d = f?.contentDocument;
      return d ? { by: d.querySelector('.cp-detail-quote-by')?.textContent.trim(), stats: [...d.querySelectorAll('.cp-detail-stat-num')].map((s) => s.textContent.trim()) } : null;
    });
    ok(framed && framed.by === 'Jane Doe, Head of School' && framed.stats.join(',') === '250,60', `Preview shows the real page with the edits (${JSON.stringify(framed)})`);
    await shot(page, 'desk-editor-preview', { grow: false });
    await page.click('.kd-ed-actions .btn-ghost[aria-pressed]');
    await sleep(300);

    // Perfect Harmony: count the people stat, not hours
    await clickText(page, '.breadcrumb button', 'Community Projects');
    await page.waitForSelector('.cm-row');
    await openProject(page, 'perfect-harmony-health');
    ok(await page.evaluate(() => /doesn’t read as people/.test(document.querySelector('.cm-stats .form-hint[role="status"]')?.textContent || '')), 'the editor says when the counted number isn’t people');
    await page.evaluate(() => document.querySelectorAll('.cm-stat .cm-stat__count input')[2].click());
    await sleep(200);
    ok(!(await page.evaluate(() => /doesn’t read as people/.test(document.querySelector('.cm-stats .form-hint[role="status"]')?.textContent || ''))), 'marking the people number clears it');
    await page.click('.kd-bar__save .kd-save');
    await sleep(800);
    ok(JSON.stringify(saved(api, 'perfect-harmony-health').stats.map((s) => s.reached)) === '[false,false,true]' && CS.reachedCount(saved(api, 'perfect-harmony-health')) === 1502, 'saved: 1,502 clients count toward children reached, not 4,850 hours');
    await shot(page, 'desk-editor');

    // Delete, then bring it back from Recently deleted
    await page.evaluate(() => document.querySelector('.kd-card__delete').click());
    await page.waitForSelector('.modal-overlay');
    await clickText(page, '.modal-overlay .btn', 'Delete project');
    await page.waitForSelector('.cm-row', { timeout: 8000 });
    await sleep(500);
    ok(!saved(api, 'perfect-harmony-health') && !(await page.$('.cm-row[data-slug="perfect-harmony-health"]')), 'Delete removes the project');
    await page.waitForSelector('.kd-deleted-link', { timeout: 5000 }).catch(() => {});
    await page.evaluate(() => document.querySelector('.kd-deleted-link').click());
    await page.waitForSelector('.kd-deleted li');
    await clickText(page, '.kd-deleted .btn', 'Restore');
    await sleep(800);
    ok(saved(api, 'perfect-harmony-health')?.name === 'Perfect Harmony Health', 'Recently deleted brings it back');
    ok(!errors.length, `no console errors (${errors.join(' | ').slice(0, 300)})`);
    await page.close();
  }

  console.log('Desktop 1440: a new project, the tidy tool');
  {
    const { page, api, errors } = await open(browser, { width: 1440, height: 1000, mobile: false });
    await goCommunity(page, false);
    await clickText(page, '.kd-head__actions .btn', 'Add a project');
    await page.waitForSelector('#cm-new-name');
    await page.type('#cm-new-name', 'Hope Academy');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.kd-ed-head', { timeout: 8000 });
    const made = saved(api, 'hope-academy');
    ok(made && made.publishStatus === 'draft' && made.order === 0 && made.status === 'in-progress', 'Add a project saves it hidden, in progress, first on the page');
    ok(await page.$eval('.kd-ed-id h2', (e) => e.textContent.trim().startsWith('Hope Academy')) && !(await page.$eval('.kd-visible input', (e) => e.checked)), 'the editor opens on it, hidden');
    ok(await page.evaluate(() => /No impact number/.test(document.querySelector('#kd-sec-basics')?.textContent || '')), 'Basics says it has no impact number yet');
    await page.type('#cm-name', ' of Atlanta');
    await page.click('.kd-bar__save .kd-save');
    await sleep(400);
    ok(await page.evaluate(() => /impact number/.test([...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' '))) && saved(api, 'hope-academy').name === 'Hope Academy', 'saving without an impact number says so, and doesn’t save');
    await clickText(page, '.breadcrumb button', 'Community Projects');
    await page.waitForSelector('.kd-tidy-banner');
    await page.click('.kd-tidy-banner .btn');
    await page.waitForSelector('.kd-tidy-job');
    const jobs = await page.$$eval('.kd-tidy-job strong', (s) => s.map((x) => x.textContent));
    ok(jobs.some((j) => /Write \d+ search descriptions?/.test(j)) && jobs.some((j) => /Write alt text for \d+ photos/.test(j)), `the tidy tool offers search descriptions and alt text (${jobs.join(' | ')})`);
    await clickText(page, '.kd-dialog .btn', 'Start');
    await page.waitForFunction(() => document.querySelectorAll('.kd-tidy-log li').length >= 2, { timeout: 30000 });
    await clickText(page, '.kd-dialog .btn', 'Stop');
    await page.waitForFunction(() => /updated/.test(document.querySelector('.kd-tidy-run strong')?.textContent || ''), { timeout: 60000 });
    const wrote = Object.values(api.st.projects).filter((p) => (p.photos || []).some((x) => /^Project photo/.test(x.alt))).length;
    const seo = Object.values(api.st.projects).filter((p) => /^Sunshine on a Ranney Day renovated/.test(p.metaDescription || '')).length;
    ok(wrote > 0 && seo > 0 && await page.evaluate(() => /Stopped/.test(document.querySelector('.kd-tidy-log').textContent)), `the tidy tool writes and stops cleanly (${seo} search descriptions, ${wrote} projects’ alt text)`);
    await shot(page, 'desk-tidy', { grow: false });
    ok(!errors.length, `no console errors (${errors.join(' | ').slice(0, 300)})`);
    await page.close();
  }

  console.log('Desktop 1440: the Dashboard, uploads, unsaved work');
  {
    const { page, api, errors } = await open(browser, { width: 1440, height: 1000, mobile: false });
    await page.waitForSelector('.dneed', { timeout: 15000 }).catch(() => {});
    const need = await page.evaluate(() => [...document.querySelectorAll('.dneed')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()).find((t) => /Perfect Harmony Health needs attention/.test(t)));
    ok(need && /Counted number isn’t people/i.test(need), `the Dashboard lists the project that needs attention (${need?.slice(0, 90)})`);
    await page.evaluate(() => [...document.querySelectorAll('.dneed')].find((n) => /Perfect Harmony/.test(n.textContent))?.querySelector('.dneed-act')?.click());
    await page.waitForSelector('.kd-ed-head', { timeout: 8000 });
    ok(await page.$eval('.kd-ed-id h2', (e) => e.textContent.trim().startsWith('Perfect Harmony Health')), 'its Fix it opens the project');
    await clickText(page, '.breadcrumb button', 'Community Projects');
    await page.waitForSelector('.cm-row');
    await openProject(page, 'murphy-harpst');

    // Uploads: photos (their alt text is written after), a logo
    const before = (await page.$$('#kd-sec-photos .kd-tile')).length;
    const input = await page.$('#kd-sec-photos input[type=file]');
    await input.uploadFile(PNG, PNG);
    await page.waitForFunction((n) => document.querySelectorAll('#kd-sec-photos .kd-tile').length >= n + 2 && !document.querySelector('#kd-sec-photos .kd-tile__busy'), { timeout: 15000 }, before).catch(() => {});
    await sleep(500);
    ok(api.st.uploads === 2 && callsTo(api, '/api/upload-image') === 2, `two photos upload (${api.st.uploads})`);
    const upAlt = await page.evaluate(() => {
      const tiles = [...document.querySelectorAll('#kd-sec-photos .kd-tile__open')].slice(-2);
      return tiles.map((t) => t.getAttribute('aria-label'));
    });
    ok(upAlt.every((l) => /Project photo/.test(l || '')) && /photo 4[34]\b/.test(upAlt.join(' ')), `the new photos show at the end of the grid, their alt text written as project photos (${upAlt.join(' | ').slice(0, 120)})`);
    ok(!api.st.calls.some((c) => c.path === '/api/generate' && c.body?.kid?.kind !== 'community'), 'every AI request says it’s a community project');
    const logos = (await page.$$('.kd-logo')).length;
    await (await page.$('#kd-sec-partners input[type=file]')).uploadFile(PNG);
    await page.waitForFunction((n) => document.querySelectorAll('.kd-logo').length > n && !document.querySelector('.kd-logo .kd-tile__busy'), { timeout: 15000 }, logos).catch(() => {});
    ok(await page.evaluate(() => [...document.querySelectorAll('.kd-logo input')].some((i) => i.value === 'pixel')), 'an uploaded logo comes in, named from its file to check');
    await page.click('.kd-bar__save .kd-save');
    await sleep(800);
    const mh = saved(api, 'murphy-harpst');
    ok(mh.photos.filter((x) => /community\/test\/up-/.test(x.url)).length === 2 && mh.photos.slice(-2).every((x) => /^Project photo/.test(x.alt)) && mh.partnerLogos.some((l) => /community\/test\/up-3/.test(l.url)),
      'the uploads are saved in Cloudflare’s address, with their alt text');

    // Unsaved work survives a reload
    await page.click('#cm-summary', { clickCount: 3 });
    await page.keyboard.type('Murphy-Harpst helps children heal. SOARD renovated its cottages.');
    await sleep(1600);
    await page.evaluate(() => sessionStorage.setItem('soard-test-keep', '1'));
    await page.reload({ waitUntil: 'networkidle2' });
    await goCommunity(page, false);
    await openProject(page, 'murphy-harpst');
    ok(await page.$('.kd-note--draft'), 'reopened after a reload, the editor offers the unsaved changes');
    await clickText(page, '.kd-note--draft .btn', 'Restore');
    await sleep(300);
    ok(await page.$eval('#cm-summary', (e) => e.value) === 'Murphy-Harpst helps children heal. SOARD renovated its cottages.' && await page.$('.kd-bar__state.is-dirty'), 'Restore brings them back, unsaved');
    ok(!errors.length, `no console errors (${errors.join(' | ').slice(0, 300)})`);
    await page.close();
  }

  // ════════ Phone ════════
  console.log('Phone 390');
  {
    const { page, errors } = await open(browser, { width: 390, height: 844, mobile: true });
    await goCommunity(page, true);
    ok(!(await overflowing(page)).length, `the list fits the screen (${(await overflowing(page)).join(', ')})`);
    const smallList = await smallTargets(page, '.cm-row .kd-grip, .cm-row .ppl-menu__btn, .kd-filter, .kd-head__actions .btn, .kd-view button');
    ok(!smallList.length, `list targets are 44px (${smallList.join('; ')})`);
    await shot(page, 'phone-list');
    await openProject(page, 'the-cottage-school');
    ok(!(await overflowing(page)).length, `the editor fits the screen (${(await overflowing(page)).join(', ')})`);
    ok(await page.$('.kd-story-peek') && !(await page.$('#kd-sec-story .ProseMirror')), 'a long story shows as a preview on a phone');
    await page.click('.kd-story-peek');
    await sleep(300);
    ok(await page.$('#kd-sec-story .ProseMirror'), 'Edit the story opens the editor');
    const smallEd = await smallTargets(page, '.kd-sec .btn:not(.kd-small-input), .cm-stat__count, .cm-stat__tools .btn, .kd-bar__chip, .kd-footer .btn, .kd-status-opt, .kd-checks__row, .kd-card__actions .btn, .cm-swatch');
    ok(!smallEd.length, `editor targets are 44px (${smallEd.join('; ')})`);
    ok(!(await page.$('.kd-tile [data-kd-grip]')), 'on a phone, photo tiles stay clear of drag handles');
    await clickText(page, '#kd-sec-photos .kd-sec__actions .btn', 'Reorder');
    await sleep(200);
    await page.evaluate(() => document.querySelectorAll('.kd-tile')[0].scrollIntoView({ block: 'center' }));
    await sleep(300);
    const src0 = await page.evaluate(() => document.querySelectorAll('.kd-tile img')[0].getAttribute('src'));
    const g = await page.evaluate(() => { const r = document.querySelectorAll('.kd-tile')[0].querySelector('[data-kd-grip]').getBoundingClientRect(); const t = document.querySelectorAll('.kd-tile')[3].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, tx: t.x + t.width / 2, ty: t.y + t.height / 2 }; });
    await page.touchscreen.touchStart(g.x, g.y);
    for (let i = 1; i <= 12; i++) { await page.touchscreen.touchMove(g.x + (g.tx - g.x) * i / 12, g.y + (g.ty - g.y) * i / 12); await sleep(30); }
    await page.touchscreen.touchEnd();
    await sleep(400);
    const idx = await page.evaluate((s) => [...document.querySelectorAll('.kd-tile img')].findIndex((i) => i.getAttribute('src') === s), src0);
    ok(idx === 3, `a touch drag on the grip moves the photo (now at ${idx + 1})`);
    await clickText(page, '#kd-sec-photos .kd-sec__actions .btn', 'Done');
    await page.evaluate(() => document.querySelectorAll('.kd-tile__open')[1].click());
    await page.waitForSelector('.kd-photo-dlg');
    await sleep(400);
    ok(await page.$eval('.kd-photo-dlg', (e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight + 1 && r.width <= innerWidth; }), 'the photo opens as a sheet that fits the screen');
    await page.keyboard.press('Escape');
    await sleep(200);
    await shot(page, 'phone-editor');
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
console.log(failures.length ? `\n${failures.length} failed:\n- ${failures.join('\n- ')}` : '\nAll community admin checks passed.');
process.exit(failures.length ? 1 : 0);
