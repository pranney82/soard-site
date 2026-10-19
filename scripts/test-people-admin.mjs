/**
 * test-people-admin.mjs — drive Admin → People (Team & Board) in a real browser
 * ============================================================================
 * Loads the admin from an Astro dev server (so Preview can frame the real
 * Leadership page) with every /api/* call answered from an in-memory copy of
 * src/content/team and src/content/partners. Checks, at 1440px and 390px:
 *   - sections (founders, staff, honorary crew; officers, members, in memory),
 *     tab counts, what each row is missing, search and the Needs attention filter
 *   - reordering by keyboard (Space, arrows, Space; Escape cancels) and by
 *     dragging the handle: one /api/reorder-content request, Undo
 *   - the row menu: Move to alumni (and Undo), Delete (board members included)
 *   - the editor: older records read as structured fields, seat → title, the
 *     invite email saved with Save, LinkedIn checks, framing a photo, background
 *     removal, Preview of the real page, adding someone, changing a web address
 *   - phone layout: nothing past the content column, 44px targets, sheets fit
 * Screenshots land in test-results/people-admin/. Exits non-zero on any
 * failure or console error.
 *
 *   SITE=http://localhost:4321 node scripts/test-people-admin.mjs
 * Without SITE it starts `astro dev` on a spare port and stops it after.
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/people-admin/');
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

// ── The fake API ──
function makeApi() {
  const team = readDir('team');
  for (const [slug, d] of Object.entries(team)) d.slug ||= slug;
  const st = { team, emails: {}, calls: [], waiting: new Set() };
  const respond = (req) => {
    const url = new URL(req.url());
    const json = (o, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(o) });
    const body = () => { try { return JSON.parse(req.postData() || '{}'); } catch { return {}; } };
    const p = url.pathname;
    if (!p.startsWith('/api/')) return false;
    st.calls.push({ path: p, method: req.method(), body: req.method() === 'POST' ? body() : null, query: url.search });
    if (p === '/api/list-content') {
      const dir = url.searchParams.get('dir');
      const src = dir === 'src/content/team' ? st.team : dir === 'src/content/partners' ? PARTNERS : {};
      const items = Object.entries(src).map(([slug, c]) => ({ name: `${slug}.json`, path: `${dir}/${slug}.json`, sha: slug, content: c }));
      return json({ success: true, items, count: items.length, total: items.length, pages: 1 });
    }
    if (p === '/api/read-content') {
      const m = url.searchParams.get('path').match(/^src\/content\/team\/(.+)\.json$/);
      const c = m && st.team[m[1]];
      return c ? json({ success: true, content: c, sha: `sha-${m[1]}-${JSON.stringify(c).length}` }) : json({ success: false, error: 'Not found' }, 404);
    }
    if (p === '/api/save-content') {
      const b = body();
      const slug = b.path.match(/team\/(.+)\.json$/)?.[1];
      st.team[slug] = JSON.parse(b.content);
      st.waiting.add(slug);
      return json({ success: true, sha: `sha-${slug}-${Date.now()}` });
    }
    if (p === '/api/delete-content') {
      const slug = body().path.match(/team\/(.+)\.json$/)?.[1];
      if (!st.team[slug]) return json({ success: false, error: 'not found' }, 404);
      delete st.team[slug];
      return json({ success: true });
    }
    if (p === '/api/reorder-content') {
      const changed = [];
      for (const it of body().items) if (st.team[it.slug] && st.team[it.slug].order !== it.order) { st.team[it.slug] = { ...st.team[it.slug], order: it.order }; changed.push(it.slug); }
      changed.forEach((s) => st.waiting.add(s));
      return json({ success: true, changed, shas: {} });
    }
    if (p === '/api/rename-content') {
      const { from, to } = body();
      if (st.team[to]) return json({ success: false, error: 'taken' }, 409);
      st.team[to] = { ...st.team[from], slug: to };
      delete st.team[from];
      if (st.emails[from]) { st.emails[to] = st.emails[from]; delete st.emails[from]; }
      return json({ success: true, slug: to, photoMoved: true, photo: st.team[to].photo, note: null });
    }
    if (p === '/api/reveal-invites-admin') {
      if (req.method() === 'POST') {
        const { slug, email } = body().boardEmail || {};
        st.emails[slug] = String(email || '').trim().toLowerCase();
        return json({ ok: true, board: [] });
      }
      const board = Object.entries(st.team).filter(([, d]) => d.group === 'board').map(([slug, d]) => ({ slug, name: d.name, email: st.emails[slug] || null }));
      return json({ ok: true, board });
    }
    if (p.startsWith('/api/pending-changes')) {
      return json({ success: true, changes: [...st.waiting].map((slug) => ({ type: 'team', slug, name: st.team[slug]?.name, state: 'waiting', action: 'updated', at: new Date().toISOString() })), publish: { live: null, active: null, failed: null, typicalSeconds: 480 } });
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
    req.continue();
  });
  // astro dev doesn't map /admin/ to its index.html (Cloudflare does)
  await page.goto(`${SITE}/admin/index.html`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.nav-item, .sidebar', { timeout: 20000 });
  return { page, api, errors };
}

const $text = (page, sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
const clickText = (page, sel, text) => page.evaluate((sel, text) => {
  const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.replace(/\s+/g, ' ').trim().startsWith(text));
  if (el) el.click();
  return !!el;
}, sel, text);
// Full-page capture crashes software-rendered Chrome here, so grow the viewport to the page instead
// (grow: false keeps an open menu open: a resize closes it, as it should)
async function shot(page, name, { grow = true } = {}) {
  const vp = page.viewport();
  try {
    const h = grow ? await page.evaluate(() => Math.min(Math.max(document.documentElement.scrollHeight, document.querySelector('.main')?.scrollHeight || 0), 7000)) : 0;
    if (h > vp.height) await page.setViewport({ ...vp, height: h });
    await page.screenshot({ path: join(OUT, `${name}.png`) });
  } catch (e) {
    console.log(`  (screenshot ${name} failed: ${e.message.slice(0, 80)})`);
  } finally {
    if (page.viewport()?.height !== vp.height) await page.setViewport(vp).catch(() => {});
  }
}
async function goPeople(page, tab, mobile) {
  if (mobile) { await page.evaluate(() => document.querySelector('.hamburger')?.click()); await sleep(350); }
  await clickText(page, '.nav-item', 'People');
  await page.waitForSelector('.hub-tabs', { timeout: 10000 });
  if (tab === 'board') await clickText(page, '.hub-tab', 'Board');
  await page.waitForSelector('.ppl-row', { timeout: 10000 });
  await sleep(400);
}
const rowNames = (page, sectionTitle) => page.evaluate((t) => {
  const sec = [...document.querySelectorAll('.ppl-section')].find((s) => s.querySelector('h3')?.textContent.trim().startsWith(t));
  return sec ? [...sec.querySelectorAll('.ppl-row__name')].map((n) => n.textContent.trim()) : null;
}, sectionTitle);
const lastCall = (api, path) => [...api.st.calls].reverse().find((c) => c.path === path);
const callsTo = (api, path) => api.st.calls.filter((c) => c.path === path).length;

// No GPU and no background throttling: with the Mac's display asleep, Chrome's
// GPU path stops producing frames and every screenshot times out
const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 60000,
  args: ['--disable-gpu', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'] });
try {
  // ════════ Desktop ════════
  console.log('Desktop 1440');
  {
    const { page, api, errors } = await open(browser, { width: 1440, height: 1000, mobile: false });
    await goPeople(page, 'team');
    const tabs = await $text(page, '.hub-tab');
    ok(tabs[0] === 'Team9' && tabs[1] === 'Board13', `tab counts show who's on the site (${tabs.join(' | ')})`);
    ok(JSON.stringify(await rowNames(page, 'Founders')) === JSON.stringify(['Holly Ranney', 'Peter Ranney']), 'founders section: Holly, Peter');
    const staff = await rowNames(page, 'Staff');
    ok(staff?.length === 7 && staff[0] === 'Linzi Lawsky' && staff[6] === 'Greg Ranney', `staff section in site order (${staff?.join(', ')})`);
    ok(await page.evaluate(() => [...document.querySelectorAll('.ppl-section')].some((s) => /Honorary crew/.test(s.textContent) && s.querySelector('.ppl-empty'))), 'empty honorary crew explains how to fill it');
    await shot(page, 'desk-team');

    await clickText(page, '.hub-tab', 'Board');
    await page.waitForFunction(() => document.querySelectorAll('.ppl-chip--warn').length > 5, { timeout: 15000 });
    await sleep(1500);
    ok(JSON.stringify(await rowNames(page, 'Officers')) === JSON.stringify(['Scott Wierson']), 'officers: Scott (Board Chair, read from the title)');
    const members = await rowNames(page, 'Members');
    ok(members?.length === 11 && members[0] === 'Mary Atchley', `11 members, Mary first (${members?.length})`);
    ok(JSON.stringify(await rowNames(page, 'In memory')) === JSON.stringify(['Brent Aronson']), 'Brent is in memory, without "In memoriam," in his name');
    const maryChips = await page.evaluate(() => [...document.querySelectorAll('.ppl-row')].find((r) => r.textContent.includes('Mary Atchley'))?.querySelector('.ppl-row__issues')?.textContent);
    ok(/Small photo/.test(maryChips) && /No invite email/.test(maryChips) && /No bio or LinkedIn/.test(maryChips), `Mary: small photo (535px), no invite email, one quiet profile chip (${maryChips})`);
    const brentChips = await page.evaluate(() => [...document.querySelectorAll('.ppl-row')].find((r) => r.textContent.includes('Brent Aronson'))?.querySelector('.ppl-row__issues')?.textContent || '');
    ok(!/invite|bio|LinkedIn/i.test(brentChips), 'a memorial isn\'t asked for an invite email, bio or LinkedIn');
    const attention = await page.$eval('.ppl-filter:nth-child(2) span', (e) => e.textContent);
    ok(attention === '12', `Needs attention counts the 12 active members without an invite email (${attention})`);
    await shot(page, 'desk-board');

    // Search hides the drag handles; filter narrows
    await page.type('.ppl-search input', 'pella');
    await sleep(250);
    ok(JSON.stringify(await page.$$eval('.ppl-row__name', (n) => n.map((x) => x.textContent))) === '["Brian Robbins"]', 'search by company finds Brian Robbins');
    ok(!(await page.$('.ppl-handle')), 'no reordering while the list is narrowed');
    await page.$eval('.ppl-search input', (i) => { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(200);

    // Keyboard reorder: Mary down one
    let before = callsTo(api, '/api/reorder-content');
    await page.evaluate(() => [...document.querySelectorAll('.ppl-row')].find((r) => r.textContent.includes('Mary Atchley')).querySelector('.ppl-handle').focus());
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await sleep(150);
    ok((await page.$eval('[aria-live="assertive"]', (e) => e.textContent)).includes('position 2 of 11'), 'a screen reader hears the new position');
    await page.keyboard.press('Space');
    await sleep(700);
    ok(callsTo(api, '/api/reorder-content') === before + 1, 'one request saves the whole order');
    let m2 = await rowNames(page, 'Members');
    ok(m2[0] === 'Casey Bradley' && m2[1] === 'Mary Atchley', `Mary moved below Casey (${m2.slice(0, 3).join(', ')})`);
    ok(api.st.team['mary-atchley'].order === 2 && api.st.team['casey-bradley'].order === 1, 'orders count from Scott (0): Casey 1, Mary 2');
    ok(await page.evaluate(() => /order saved/i.test(document.body.textContent)), 'toast confirms, with Undo');
    await shot(page, 'desk-reordered');

    // Escape cancels
    before = callsTo(api, '/api/reorder-content');
    await page.evaluate(() => [...document.querySelectorAll('.ppl-row')].find((r) => r.textContent.includes('Travis Couick')).querySelector('.ppl-handle').focus());
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Escape');
    await sleep(400);
    ok(callsTo(api, '/api/reorder-content') === before && (await rowNames(page, 'Members')).indexOf('Travis Couick') === 2, 'Escape puts it back without saving');

    // Pointer drag: Alex Paulson up two rows
    const handle = await page.evaluateHandle(() => [...document.querySelectorAll('.ppl-row')].find((r) => r.textContent.includes('Alex Paulson')).querySelector('.ppl-handle'));
    const hb = await handle.boundingBox();
    const rowH = await page.evaluate(() => document.querySelector('.ppl-row').getBoundingClientRect().height);
    before = callsTo(api, '/api/reorder-content');
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) { await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 - (rowH * 2.1 * i) / 12); await sleep(16); }
    await shot(page, 'desk-dragging');
    await page.mouse.up();
    await sleep(700);
    const m3 = await rowNames(page, 'Members');
    const ai = m3.indexOf('Alex Paulson');
    ok(callsTo(api, '/api/reorder-content') === before + 1 && ai === 5, `dragging the handle up two rows moves Alex from 8th to 6th (now ${ai + 1}: ${m3.join(', ')})`);

    // Row menu: move to alumni, then undo
    await page.evaluate(() => [...document.querySelectorAll('.ppl-row')].find((r) => r.textContent.includes('Thomas Wilson')).querySelector('.ppl-menu__btn').click());
    await page.waitForSelector('.ppl-menu__pop');
    ok(await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem', { timeout: 2000 }).then(() => true, () => false), 'the menu opens with focus on its first item');
    await shot(page, 'desk-menu', { grow: false });
    await clickText(page, '.ppl-menu__pop [role="menuitem"]', 'Move to alumni');
    await page.waitForFunction(() => document.querySelector('.ppl-section--alumni'), { timeout: 5000 });
    ok(api.st.team['thomas-wilson'].status === 'alumni' && api.st.team['thomas-wilson'].until === new Date().getFullYear(), 'saved as alumni, until this year');
    ok((await $text(page, '.hub-tab'))[1] === 'Board12', 'the Board tab counts 12 on the site now');
    await page.evaluate(() => [...document.querySelectorAll('.toast')].find((t) => /moved to alumni/.test(t.textContent))?.querySelector('.toast-undo')?.click());
    await page.waitForFunction(() => !document.querySelector('.ppl-section--alumni'), { timeout: 5000 });
    ok(!api.st.team['thomas-wilson'].status, 'Undo restores the record as it was');

    // Delete a board member from the list (used to look in the partners folder)
    await page.evaluate(() => [...document.querySelectorAll('.ppl-row')].find((r) => r.textContent.includes('Carlos Ramirez')).querySelector('.ppl-menu__btn').click());
    await page.waitForSelector('.ppl-menu__pop');
    await clickText(page, '.ppl-menu__pop [role="menuitem"]', 'Delete');
    await page.waitForSelector('.modal');
    await clickText(page, '.modal .btn-danger', 'Delete');
    await page.waitForFunction(() => ![...document.querySelectorAll('.ppl-row__name')].some((n) => n.textContent === 'Carlos Ramirez'), { timeout: 5000 });
    ok(!api.st.team['carlos-ramirez'] && lastCall(api, '/api/delete-content')?.body.path === 'src/content/team/carlos-ramirez.json', 'deleting a board member works (team folder)');

    // ── Editor: Scott ──
    await clickText(page, '.ppl-row__name', 'Scott Wierson');
    await page.waitForSelector('#ppl-name');
    await sleep(400);
    ok(await page.$eval('#ppl-title', (i) => i.value) === 'Board Chair', 'Scott\'s title');
    ok(await page.$eval('.ppl-role .ppl-seg [aria-checked="true"]', (b) => b.textContent) === 'Board of Directors', 'the group choice shows Board of Directors');
    const seatChecked = await page.evaluate(() => [...document.querySelectorAll('.ppl-seg')][1].querySelector('[aria-checked="true"]').textContent);
    ok(seatChecked === 'Chair', `seat read from the title: ${seatChecked}`);
    ok((await $text(page, '.breadcrumb'))[0].startsWith('Board'), 'breadcrumb says Board');
    await shot(page, 'desk-editor-scott');
    await page.evaluate(() => [...document.querySelectorAll('.ppl-seg')][1].querySelector('[aria-checked="true"]').focus());
    await page.keyboard.press('ArrowRight');
    await sleep(100);
    ok(await page.$eval('#ppl-title', (i) => i.value) === 'Board Vice Chair', 'arrow key moves the seat, and the title follows');
    await page.keyboard.press('ArrowLeft');
    await page.type('#ppl-email', 'Scott@Example.com');
    ok(await page.evaluate(() => !!document.querySelector('.ppl-unsaved')), 'Unsaved changes shows');
    await page.click('#ppl-linkedin');
    await page.type('#ppl-linkedin', 'twitter.com/scott');
    let saves = callsTo(api, '/api/save-content');
    await clickText(page, '.ppl-ed-head .btn-primary', 'Save');
    await sleep(500);
    ok(callsTo(api, '/api/save-content') === saves && (await page.evaluate(() => /linkedin\.com\/in\/name/.test(document.body.textContent))), 'a non-LinkedIn link blocks Save and says why');
    await page.$eval('#ppl-linkedin', (i) => { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.type('#ppl-linkedin', 'linkedin.com/in/scottwierson/');
    await clickText(page, '.ppl-ed-head .btn-primary', 'Save');
    await page.waitForFunction(() => !document.querySelector('.ppl-unsaved'), { timeout: 8000 });
    const scott = api.st.team['scott-wierson'];
    ok(scott.seat === 'chair' && scott.status === 'active' && scott.publishStatus === 'published' && scott.title === 'Board Chair', 'saved with seat, status and visibility');
    ok(scott.linkedin === 'https://www.linkedin.com/in/scottwierson', `LinkedIn saved in full (${scott.linkedin})`);
    ok(api.st.emails['scott-wierson'] === 'scott@example.com', 'the invite email saved with the same Save');

    // Preview frames the real Leadership page
    await clickText(page, '.ppl-ed-head .btn', 'Preview');
    await page.$eval('#ppl-title', (i) => { i.value = 'Chair of the Board'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    let previewOk = false;
    for (let i = 0; i < 40 && !previewOk; i++) {
      await sleep(500);
      previewOk = await page.evaluate(() => [...document.querySelectorAll('iframe')].some((f) => {
        try { return [...f.contentDocument.querySelectorAll('.board-title')].some((t) => t.textContent === 'Chair of the Board'); } catch { return false; }
      }));
    }
    ok(previewOk, 'Preview shows the unsaved title on the real Leadership page');
    await shot(page, 'desk-editor-preview');
    await clickText(page, '.ppl-ed-head .btn', 'Preview');
    await page.$eval('#ppl-title', (i) => { i.value = 'Board Chair'; i.dispatchEvent(new Event('input', { bubbles: true })); });

    // Photo: background removal, then framing
    await page.click('.ppl-switch input');
    await sleep(200);
    ok((await page.$eval('.ppl-photo__circle img', (i) => i.src)).includes('segment=foreground'), 'background removal previews the cutout');
    await page.waitForFunction(() => !document.querySelector('.ppl-photo__circle .ppl-photo__busy'), { timeout: 30000 }).catch(() => {});
    await page.click('.ppl-switch input');
    await page.waitForFunction(() => [...document.querySelectorAll('.ppl-photo__actions .btn')].some((b) => b.textContent.includes('Frame') && !b.disabled), { timeout: 15000 });
    await clickText(page, '.ppl-photo__actions .btn', 'Frame');
    await page.waitForSelector('.ppl-crop__stage');
    await page.waitForFunction(() => !document.querySelector('.ppl-crop__loading'), { timeout: 20000 });
    const stage = await (await page.$('.ppl-crop__stage')).boundingBox();
    await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
    await page.mouse.wheel({ deltaY: -400 });
    await sleep(100);
    await page.mouse.down();
    await page.mouse.move(stage.x + stage.width / 2 + 30, stage.y + stage.height / 2 + 20, { steps: 6 });
    await page.mouse.up();
    await page.focus('.ppl-crop__stage');
    await page.keyboard.press('ArrowLeft');
    for (let i = 0; i < 9; i++) await page.keyboard.press('Tab');
    ok(await page.evaluate(() => document.querySelector('.ppl-crop').contains(document.activeElement)), 'Tab stays inside the framing dialog');
    await page.keyboard.down('Shift');
    for (let i = 0; i < 9; i++) await page.keyboard.press('Tab');
    await page.keyboard.up('Shift');
    ok(await page.evaluate(() => document.querySelector('.ppl-crop').contains(document.activeElement)), 'and Shift+Tab too');
    await page.focus('.ppl-crop__stage');
    await shot(page, 'desk-crop');
    const q = await page.$eval('.ppl-crop__quality', (e) => e.textContent);
    ok(/px across/.test(q), `framing reports sharpness (${q.trim()})`);
    await clickText(page, '.ppl-crop .btn-primary', 'Use this framing');
    await sleep(300);
    ok((await page.$eval('.ppl-photo__circle img', (i) => i.src)).includes('trim='), 'the framed photo uses an exact crop');
    await clickText(page, '.ppl-ed-head .btn-primary', 'Save');
    await page.waitForFunction(() => !document.querySelector('.ppl-unsaved'), { timeout: 8000 });
    const sc = api.st.team['scott-wierson'];
    ok(sc.photoCrop && sc.photoSize?.length === 2 && sc.photoCrop.size > 0 && sc.photoCrop.size < 1, `crop saved as fractions with the photo's size (${JSON.stringify(sc.photoCrop)})`);
    ok(!sc.photoCutout, 'background removal off again');

    // Brent: an older memorial record saves structured
    await clickText(page, '.breadcrumb button', 'Board');
    await page.waitForSelector('.ppl-row');
    await clickText(page, '.ppl-row__name', 'Brent Aronson');
    await page.waitForSelector('#ppl-name');
    ok(await page.$eval('#ppl-name', (i) => i.value) === 'Brent Aronson', 'Brent\'s name loads without the prefix');
    ok(await page.evaluate(() => /Memorial entries are never invited/.test(document.body.textContent)), 'memorials are never invited');
    await clickText(page, '.ppl-ed-head .btn-primary', 'Save');
    await sleep(700);
    ok(api.st.team['brent-aronson'].name === 'Brent Aronson' && api.st.team['brent-aronson'].status === 'memorial', 'saved as name + status: memorial');

    // A new board member, from the Board tab
    await clickText(page, '.breadcrumb button', 'Board');
    await page.waitForSelector('.ppl-head .btn-primary');
    ok((await page.$eval('.ppl-head .btn-primary', (b) => b.textContent)).includes('board member'), 'the add button names the tab');
    await page.click('.ppl-head .btn-primary');
    await page.waitForSelector('#ppl-name');
    ok((await $text(page, '.ppl-ed-head h2'))[0].startsWith('Add a board member'), 'the new-person editor says board member');
    await page.type('#ppl-name', 'Tess Template');
    await page.evaluate(() => [...[...document.querySelectorAll('.ppl-seg')][1].querySelectorAll('[role="radio"]')].find((b) => b.textContent === 'Treasurer').click());
    ok(await page.$eval('#ppl-title', (i) => i.value) === 'Board Treasurer', 'picking Treasurer sets the title');
    await page.type('#ppl-org', 'Real Floors Commercial, CFO');
    ok(await page.evaluate(() => /Link to Real Floors Commercial/.test(document.querySelector('.ppl-suggest')?.textContent || '')), 'the company is offered as a partner link');
    await page.click('.ppl-suggest');
    await page.type('#ppl-email', 'tess@example.com');
    await clickText(page, '.ppl-ed-head .btn-primary', 'Save');
    await page.waitForFunction(() => (document.querySelector('.ppl-ed-head h2')?.textContent || '').startsWith('Tess Template'), { timeout: 8000 });
    const tess = api.st.team['tess-template'];
    ok(tess?.group === 'board' && tess.seat === 'treasurer' && tess.partner === 'real-floors-commercial' && tess.order === 13, `saved at the end of the board with seat and partner (${JSON.stringify({ seat: tess?.seat, partner: tess?.partner, order: tess?.order })})`);
    ok(api.st.emails['tess-template'] === 'tess@example.com', 'a new member\'s invite email saves right after their record');
    ok(await page.$eval('.ppl-partner.is-set', (e) => e.textContent.includes('Real Floors Commercial')), 'the linked partner shows by name');
    await sleep(600); // the page fades in after the editor remounts
    await shot(page, 'desk-editor-new');

    // Change Linzi's web address
    await clickText(page, '.nav-item', 'People');
    await clickText(page, '.hub-tab', 'Team');
    await page.waitForSelector('.ppl-row');
    await clickText(page, '.ppl-row__name', 'Linzi Lawsky');
    await page.waitForSelector('.ppl-admin');
    await page.evaluate(() => [...document.querySelectorAll('.ppl-admin .btn')].find((b) => b.textContent.trim() === 'Change').focus());
    await page.keyboard.press('Enter');
    await page.waitForSelector('#ppl-rename');
    ok(await page.evaluate(() => document.activeElement?.id === 'ppl-rename'), 'the rename dialog opens with its field focused');
    await page.keyboard.press('Escape');
    await sleep(200);
    ok(!(await page.$('#ppl-rename')) && await page.evaluate(() => document.activeElement?.textContent.trim() === 'Change'), 'Escape closes it and focus goes back to Change');
    await clickText(page, '.ppl-admin .btn', 'Change');
    await page.waitForSelector('#ppl-rename');
    ok(await page.$eval('#ppl-rename', (i) => i.value) === 'linzi-lawsky', 'suggests an address from the current name');
    await page.focus('#ppl-rename');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /linzi-lawsky/.test(document.querySelector('.ppl-admin')?.textContent || ''), { timeout: 8000 });
    ok(api.st.team['linzi-lawsky'] && !api.st.team['linzi-berkowitz'], 'renamed; the editor follows to the new address');
    // Holly keeps founder after a title change
    await clickText(page, '.breadcrumb button', 'Team');
    await page.waitForSelector('.ppl-row');
    await clickText(page, '.ppl-row__name', 'Holly Ranney');
    await page.waitForSelector('#ppl-title');
    await page.$eval('#ppl-title', (i) => { i.value = 'Founder & President'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await clickText(page, '.ppl-ed-head .btn-primary', 'Save');
    await sleep(700);
    ok(api.st.team['holly-ranney'].role === 'founder', 'a founder stays a founder after a new title');
    await clickText(page, '.breadcrumb button', 'Team');
    await page.waitForSelector('.ppl-row');
    ok(JSON.stringify(await rowNames(page, 'Founders')) === JSON.stringify(['Holly Ranney', 'Peter Ranney']), 'still in Founders');
    ok(await page.evaluate(() => document.querySelectorAll('.ppl-tag--waiting').length > 0), 'saved rows show Waiting to publish');

    ok(!errors.length, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await page.close();
  }

  // ════════ Phone ════════
  console.log('Phone 390');
  {
    const { page, api, errors } = await open(browser, { width: 390, height: 844, mobile: true });
    await goPeople(page, 'board', true);
    await sleep(800);
    const search = await page.$eval('.ppl-search', (e) => e.getBoundingClientRect().height);
    ok(search < 60, `the search box is one line tall on a phone (${Math.round(search)}px)`);
    const handleGap = await page.evaluate(() => { const r = [...document.querySelectorAll('.ppl-row')].find((x) => x.querySelector('.ppl-handle')); const h = r.querySelector('.ppl-handle').getBoundingClientRect(); const a = r.querySelector('.ppl-avatar').getBoundingClientRect(); return Math.abs(h.top - a.top); });
    ok(handleGap < 12, `drag handles line up with their row (${Math.round(handleGap)}px off)`);
    const layout = await page.evaluate(() => {
      const main = document.querySelector('.main').getBoundingClientRect();
      const past = [...document.querySelectorAll('.main *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > main.right + 1; }).map((e) => e.className || e.tagName);
      const small = [...document.querySelectorAll('.ppl-handle, .ppl-menu__btn, .ppl-filter')].filter((e) => { const r = e.getBoundingClientRect(); return r.height < 44 || r.width < 40; }).length;
      return { past: past.slice(0, 5), small };
    });
    ok(!layout.past.length, `nothing past the content column (${layout.past.join(', ')})`);
    ok(layout.small === 0, `handles, menus and filters are at least 44px tall (${layout.small} smaller)`);
    await shot(page, 'phone-board');
    // A finger drag on the handle: Paul Nielsen up one row
    const before = await rowNames(page, 'Members');
    await page.evaluate(() => [...document.querySelectorAll('.ppl-row')].find((r) => r.textContent.includes('Paul Nielsen')).scrollIntoView({ block: 'center' }));
    await sleep(200);
    const ph = await (await page.evaluateHandle(() => [...document.querySelectorAll('.ppl-row')].find((r) => r.textContent.includes('Paul Nielsen')).querySelector('.ppl-handle'))).boundingBox();
    const rowH = await page.evaluate(() => [...document.querySelectorAll('.ppl-row')].find((r) => r.textContent.includes('Paul Nielsen')).getBoundingClientRect().height);
    const calls0 = callsTo(api, '/api/reorder-content');
    const t = await page.touchscreen.touchStart(ph.x + ph.width / 2, ph.y + ph.height / 2);
    // A quick flick (3 moves): the row must keep up even when the finger outruns the handle
    for (let i = 1; i <= 3; i++) { await t.move(ph.x + ph.width / 2, ph.y + ph.height / 2 - (rowH * 1.05 * i) / 3); await sleep(16); }
    await t.end();
    await sleep(800);
    const after = await rowNames(page, 'Members');
    const pi = before.indexOf('Paul Nielsen');
    ok(callsTo(api, '/api/reorder-content') === calls0 + 1 && after.indexOf('Paul Nielsen') === pi - 1, `a quick finger drag on the handle reorders (${before[pi - 1]} ↔ Paul Nielsen; requests ${callsTo(api, '/api/reorder-content') - calls0}; now ${after.indexOf('Paul Nielsen') + 1} of ${after.length})`);
    ok(!(await page.$('.ppl-row.is-lifted')), 'nothing is left mid-drag');
    await page.evaluate(() => document.querySelector('.ppl-row .ppl-menu__btn').click());
    await page.waitForSelector('.ppl-menu__pop');
    const pop = await page.$eval('.ppl-menu__pop', (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right }; });
    ok(pop.left >= 0 && pop.right <= 390, 'the row menu stays on screen');
    await page.keyboard.press('Escape');
    await clickText(page, '.ppl-row__name', 'Mary Atchley');
    await page.waitForSelector('#ppl-name');
    await sleep(800);
    const ed = await page.evaluate(() => {
      const main = document.querySelector('.main').getBoundingClientRect();
      const past = [...document.querySelectorAll('.main *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > main.right + 1; }).map((e) => e.className || e.tagName);
      const smallFields = [...document.querySelectorAll('.main input, .main textarea')].filter((i) => i.type !== 'file' && i.type !== 'checkbox' && parseFloat(getComputedStyle(i).fontSize) < 16).length;
      const segs = [...document.querySelectorAll('.ppl-seg [role="radio"]')].filter((b) => b.getBoundingClientRect().height < 44).length;
      return { past: past.slice(0, 5), smallFields, segs };
    });
    ok(!ed.past.length, `editor fits the phone (${ed.past.join(', ')})`);
    ok(ed.smallFields === 0, 'every field is 16px, so iOS never zooms');
    ok(ed.segs === 0, 'segmented choices are 44px tall');
    await shot(page, 'phone-editor');
    await page.waitForFunction(() => [...document.querySelectorAll('.ppl-photo__actions .btn')].some((b) => b.textContent.includes('Frame') && !b.disabled), { timeout: 15000 });
    await clickText(page, '.ppl-photo__actions .btn', 'Frame');
    await page.waitForSelector('.ppl-crop__stage');
    await sleep(800);
    const sheet = await page.$eval('.modal.ppl-crop', (m) => { const r = m.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, w: r.width }; });
    ok(sheet.w <= 390 && sheet.bottom <= 845, `the framing sheet fits the phone (${JSON.stringify(sheet)})`);
    await shot(page, 'phone-crop');
    await clickText(page, '.ppl-crop .btn', 'Cancel');
    ok(!errors.length, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await page.close();
  }
} catch (err) {
  failures.push(`crashed: ${err.stack || err.message}`);
  console.error(err);
} finally {
  await browser.close();
  stopDev();
}
console.log(failures.length ? `\n${failures.length} failed:\n- ${failures.join('\n- ')}` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
