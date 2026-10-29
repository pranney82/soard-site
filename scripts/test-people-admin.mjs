/**
 * test-people-admin.mjs — drive Admin → People (Team, Board & Advisory) in a real browser
 * ============================================================================
 * Loads the admin from an Astro dev server (so Preview can frame the real
 * Leadership page) with every /api/* call answered from an in-memory copy of
 * a frozen team (tests/fixtures/people-team.json) and src/content/partners. Checks, at 1440px and 390px:
 *   - sections (founders, staff, honorary crew; officers, members, in memory),
 *     tab counts, what each row is missing, search and the Needs attention filter
 *   - reordering by keyboard (Space, arrows, Space; Escape cancels) and by
 *     dragging the handle: one /api/reorder-content request, Undo
 *   - the row menu: Move to alumni (and Undo), Delete (board members included)
 *   - the editor: older records read as structured fields, seat → title, the
 *     invite email saved with Save, LinkedIn checks, framing a photo, background
 *     removal, Preview of the real page, adding someone, changing a web address
 *   - readiness tiles as filters, Email the board, Export (spreadsheet and the
 *     printable roster), the Photos review (one switch, "everyone" with a
 *     before/after preview, framing), a bio request link, reviewing what
 *     someone sent, Tidy to house style, History and restore, and merging a
 *     save made meanwhile (quietly, or by asking where both changed a field)
 *   - the Advisory tab: empty at first, Paste a list (what each line does, the
 *     records and private reveal emails it saves), an advisor's editor (no
 *     seat or role, the invite email, Preview of the real Advisory Board page),
 *     the Email menu, the Dashboard and the same on an iPad and a phone
 *   - phone layout: nothing past the content column, 44px targets, sheets fit
 * Screenshots land in test-results/people-admin/. Exits non-zero on any
 * failure or console error. AXE=<path to axe.min.js> adds an accessibility
 * pass (WCAG 2.1 AA and best practice) on the Advisory screens; axe-core
 * isn't a dependency of the site.
 *
 *   SITE=http://localhost:4321 node scripts/test-people-admin.mjs
 * Without SITE it starts `astro dev` on a spare port and stops it after.
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hoverSweep } from './lib/hover-sweep.mjs';
import { answerAsks } from './lib/ask.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/people-admin/');
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

// ── The fake API ──
// The team as it was when these checks were written (tests/fixtures/people-team.json),
// so editing real people in the admin can't break them
const TEAM = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/people-team.json'), 'utf8'));
function makeApi() {
  const team = structuredClone(TEAM);
  for (const [slug, d] of Object.entries(team)) d.slug ||= slug;
  // site: src/content/site docs by key (board-committees starts unsaved: the starter list)
  const st = { team, site: {}, emails: {}, calls: [], waiting: new Set(), shas: {}, n: 0, versions: {}, audit: [], requests: [], deletedImages: [] };
  // Each person's sha changes with every write, like read-content's hash of the stored record
  const shaOf = (slug) => st.shas[slug] || `sha-${slug}-${JSON.stringify(st.team[slug]).length}`;
  const bump = (slug) => { st.shas[slug] = `sha-${slug}-v${++st.n}`; return st.shas[slug]; };
  const changedKeys = (a, b) => [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].filter((k) => k !== 'order' && JSON.stringify(a?.[k] ?? null) !== JSON.stringify(b?.[k] ?? null)).sort();
  // Saved versions and the audit trail, as save-content and people-batch keep them
  st.record = (slug, before, after, by = 'admin@example.com') => {
    const list = (st.versions[slug] ||= []);
    if (!list.length && before) list.push({ id: ++st.n, at: new Date(Date.now() - 60000).toISOString(), by: null, data: structuredClone(before) });
    list.push({ id: ++st.n, at: new Date().toISOString(), by, data: structuredClone(after) });
    st.audit.unshift({ id: ++st.n, user_email: by, action: 'updated', entity_type: 'team', entity_slug: slug, entity_name: after?.name, created_at: new Date().toISOString() });
  };
  // Someone else saving a person (another tab): the record, its sha, history and audit move on
  st.external = (slug, patch, by = 'jen.smith@example.com') => {
    const before = structuredClone(st.team[slug]);
    st.team[slug] = { ...st.team[slug], ...patch };
    st.record(slug, before, st.team[slug], by);
    bump(slug);
  };
  const future = new Date(Date.now() + 20 * 86400000).toISOString();
  // Jennifer sent her profile back; Lori was asked and hasn't answered
  st.requests.push({ id: 900, slug: 'jennifer-crosby', status: 'pending', createdBy: 'admin@example.com', createdAt: new Date(Date.now() - 5 * 86400000).toISOString(), expiresAt: future,
    submittedAt: new Date(Date.now() - 3600000).toISOString(),
    submission: { bio: 'Jennifer Crosby runs a commercial interiors firm in Atlanta and has helped SOARD plan rooms since 2019.', quote: 'Every child deserves a room that feels like theirs.',
      linkedin: 'https://www.linkedin.com/in/jennifer-crosby', photo: team['scott-wierson'].photo } });
  st.requests.push({ id: 901, slug: 'lori-geary', status: 'open', createdBy: 'admin@example.com', createdAt: new Date(Date.now() - 2 * 86400000).toISOString(), expiresAt: future, submittedAt: null, submission: null });
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
      const site = url.searchParams.get('path').match(/^src\/content\/site\/(.+)\.json$/);
      if (site) {
        const c = st.site[site[1]];
        return c ? json({ success: true, content: c, sha: `sha-${site[1]}-${JSON.stringify(c).length}` }) : json({ success: false, error: 'Not found' }, 404);
      }
      const m = url.searchParams.get('path').match(/^src\/content\/team\/(.+)\.json$/);
      const c = m && st.team[m[1]];
      return c ? json({ success: true, content: c, sha: shaOf(m[1]) }) : json({ success: false, error: 'Not found' }, 404);
    }
    if (p === '/api/save-content') {
      const b = body();
      const site = b.path.match(/^src\/content\/site\/(.+)\.json$/)?.[1];
      if (site) {
        const cur = st.site[site];
        if (cur && b.sha !== `sha-${site}-${JSON.stringify(cur).length}`) return json({ success: false, error: 'Conflict: this item was changed since you loaded it.' }, 409);
        st.site[site] = JSON.parse(b.content);
        return json({ success: true, sha: `sha-${site}-${Date.now()}` });
      }
      const slug = b.path.match(/team\/(.+)\.json$/)?.[1];
      if (b.sha && st.team[slug] && b.sha !== shaOf(slug)) return json({ success: false, error: 'Conflict: this item was changed since you loaded it. Reload to get the latest version.' }, 409);
      const before = st.team[slug] ? structuredClone(st.team[slug]) : null;
      st.team[slug] = JSON.parse(b.content);
      st.record(slug, before, st.team[slug]);
      st.waiting.add(slug);
      return json({ success: true, sha: bump(slug) });
    }
    if (p === '/api/delete-content') {
      const slug = body().path.match(/team\/(.+)\.json$/)?.[1];
      if (!st.team[slug]) return json({ success: false, error: 'not found' }, 404);
      delete st.team[slug];
      return json({ success: true });
    }
    if (p === '/api/reorder-content') {
      const changed = [];
      for (const it of body().items) if (st.team[it.slug] && st.team[it.slug].order !== it.order) { st.team[it.slug] = { ...st.team[it.slug], order: it.order }; bump(it.slug); changed.push(it.slug); }
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
      const group = url.searchParams.get('advisory') === '1' ? 'advisory' : 'board';
      const list = Object.entries(st.team).filter(([, d]) => d.group === group).map(([slug, d]) => ({ slug, name: d.name, email: st.emails[slug] || null }));
      return json({ ok: true, [group]: list });
    }
    if (p.startsWith('/api/pending-changes')) {
      return json({ success: true, changes: [...st.waiting].map((slug) => ({ type: 'team', slug, name: st.team[slug]?.name, state: 'waiting', action: 'updated', at: new Date().toISOString() })), publish: { live: null, active: null, failed: null, typicalSeconds: 480 } });
    }
    if (p.startsWith('/api/audit-log')) {
      const slug = url.searchParams.get('slug');
      const entries = slug ? st.audit.filter((e) => e.entity_slug === slug) : [];
      return json({ success: true, entries: entries.slice(0, Number(url.searchParams.get('limit') || 50)), total: entries.length });
    }
    if (p === '/api/profile-requests-admin') {
      if (req.method() === 'POST') {
        const b = body();
        if (b.action === 'create') {
          if (!st.team[b.slug]) return json({ success: false, error: 'Save this person first' }, 404);
          for (const r of st.requests) if (r.slug === b.slug && r.status === 'open') r.status = 'replaced';
          const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
          st.requests.push({ id: ++st.n, slug: b.slug, status: 'open', createdBy: 'admin@example.com', createdAt: new Date().toISOString(), expiresAt, submittedAt: null, submission: null });
          return json({ success: true, url: `https://sunshineonaranneyday.com/profile-update/#t=${`tok${st.n}`.padEnd(32, 'x')}`, expiresAt });
        }
        if (b.action === 'resolve') { const r = st.requests.find((x) => x.id === b.id); if (r) r.status = b.status; return json({ success: true }); }
        return json({ success: false, error: 'Unknown action' }, 400);
      }
      const seen = new Set();
      const requests = [...st.requests].reverse().filter((r) => ['open', 'pending'].includes(r.status) && !seen.has(r.slug) && seen.add(r.slug));
      return json({ success: true, requests });
    }
    if (p === '/api/content-history') {
      const list = st.versions[url.searchParams.get('slug')] || [];
      const id = url.searchParams.get('id');
      if (id) { const v = list.find((x) => x.id === Number(id)); return v ? json({ success: true, data: v.data }) : json({ success: false, error: 'That version is gone' }, 404); }
      return json({ success: true, versions: list.map((v, i) => ({ id: v.id, at: v.at, by: v.by, action: 'save', changed: i ? changedKeys(list[i - 1].data, v.data) : null })).reverse() });
    }
    if (p === '/api/people-batch') {
      const changed = [];
      const shas = {};
      for (const u of body().updates || []) {
        if (!st.team[u.slug]) return json({ success: false, error: `Not found: ${u.slug}` }, 409);
        const before = structuredClone(st.team[u.slug]);
        const after = { ...before };
        for (const [k, v] of Object.entries(u.set)) { if (v === false || v === null) delete after[k]; else after[k] = v; }
        if (JSON.stringify(before) === JSON.stringify(after)) continue;
        st.team[u.slug] = after;
        st.record(u.slug, before, after);
        st.waiting.add(u.slug);
        shas[u.slug] = bump(u.slug);
        changed.push(u.slug);
      }
      return json({ success: true, changed, shas });
    }
    if (p === '/api/people-ai') {
      const first = String(body().name || '').split(' ')[0] || 'They';
      const suggestion = `${first} plans rooms around what each child needs, and has helped SOARD design them since 2019.`;
      return json({ success: true, suggestion, words: suggestion.split(/\s+/).length });
    }
    if (p === '/api/delete-image') { st.deletedImages.push(body().imageId); return json({ success: true }); }
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
// Accessibility (optional): axe-core on the open dialog, or the content column
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
    // Dashboard: board members without an invite email are a Needs you item
    await page.waitForFunction(() => /won’t get reveal invites/.test(document.body.textContent), { timeout: 15000 }).catch(() => {});
    const need = await page.evaluate(() => [...document.querySelectorAll('.dneed-title')].find((e) => /reveal invites/.test(e.textContent))?.textContent.trim());
    ok(/^12 board members won’t get reveal invites/.test(need || ''), `the Dashboard says who misses reveal invites (${need})`);
    await shot(page, 'desk-dashboard');
    // New: the shared row menu, on top of everything, focus on its first item
    await page.$eval('.dnew-btn', (b) => b.click());
    await page.waitForSelector('.ppl-menu__pop', { timeout: 3000 }).catch(() => {});
    const dnew = await page.evaluate(() => {
      const items = [...document.querySelectorAll('.ppl-menu__pop [role="menuitem"]')];
      const onTop = items.every((m) => { const r = m.getBoundingClientRect(); return m.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); });
      return { labels: items.map((m) => m.textContent.trim()), onTop, focus: document.activeElement?.textContent.trim() };
    });
    ok(dnew.labels.length === 8 && dnew.labels[0] === 'Kid' && dnew.onTop && dnew.focus === 'Kid', `the Dashboard’s New menu lists 8 things to make, on top, focus on Kid (${dnew.labels.join(', ')})`);
    await page.keyboard.press('Escape');
    await sleep(100);
    ok(!(await page.$('.ppl-menu__pop')) && await page.evaluate(() => document.activeElement?.classList.contains('dnew-btn')), 'Escape closes it, back on New');
    await page.evaluate(() => [...document.querySelectorAll('.dneed')].find((li) => /reveal invites/.test(li.textContent))?.querySelector('.dneed-act')?.click());
    await page.waitForSelector('.ppl-row', { timeout: 10000 });
    await sleep(500);
    ok(await page.evaluate(() => document.querySelector('.hub-tab.active')?.textContent.startsWith('Board') && document.querySelector('.ppl-filter[aria-pressed="true"]')?.textContent.trim().startsWith('No invite email 12')
      && document.querySelector('.ppl-ready__tile[aria-pressed="true"]')?.textContent.includes('Invite emails')),
      'Show them opens People → Board showing just the 12 without an invite email');
    await clickText(page, '.hub-tab', 'Team');
    await page.waitForSelector('.ppl-row');
    await clickText(page, '.hub-tab', 'Board');
    await page.waitForSelector('.ppl-row');
    ok(await page.$eval('.ppl-filter[aria-pressed="true"]', (b) => b.textContent.startsWith('All')), 'coming back to Board later shows everyone again');
    const pressedHover = await hoverContrast(page, '.ppl-filter[aria-pressed="true"]');
    ok(pressedHover >= 4.5, `a selected filter keeps its label readable under the pointer (${pressedHover.toFixed(1)}:1)`);
    await clickText(page, '.hub-tab', 'Team');
    await page.waitForSelector('.ppl-row');
    await sleep(300);
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
    await page.evaluate(() => [...document.querySelectorAll('.ppl-row')].find((r) => r.textContent.includes('Alex Paulson')).scrollIntoView({ block: 'center' }));
    await sleep(200);
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

    // A bio turns on Preview profile: the real profile page with the unsaved bio
    ok(!(await page.evaluate(() => [...document.querySelectorAll('.ppl-ed-head .btn')].some((b) => b.textContent.trim() === 'Preview profile'))), 'no Preview profile without a bio');
    await page.type('#ppl-bio', 'Scott leads the board.\n\nSecond paragraph about Scott.');
    await page.waitForFunction(() => [...document.querySelectorAll('.ppl-ed-head .btn')].some((b) => b.textContent.trim() === 'Preview profile'), { timeout: 3000 });
    ok((await page.$eval('.ppl-note', (e) => e.textContent)).includes('/about/leadership/scott-wierson/'), 'the Profile section names their page');
    await clickText(page, '.ppl-ed-head .btn', 'Preview profile');
    let profileOk = false;
    for (let i = 0; i < 40 && !profileOk; i++) {
      await sleep(500);
      profileOk = await page.evaluate(() => [...document.querySelectorAll('iframe')].some((f) => {
        try { const d = f.contentDocument; return d.querySelector('h1')?.textContent.includes('Scott') && [...d.querySelectorAll('.bio-text p')].map((p) => p.textContent).join('|') === 'Scott leads the board.|Second paragraph about Scott.'; } catch { return false; }
      }));
    }
    ok(profileOk, 'Preview profile shows the unsaved bio on the profile page');
    await shot(page, 'desk-editor-profile-preview');
    await clickText(page, '.ppl-ed-head .btn', 'Preview profile');
    await page.$eval('#ppl-bio', (t) => { t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); });

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
    const br = api.st.team['brent-aronson'];
    ok(br.title === 'Board Member' && br.since === 2024 && br.until === 2025, `the years in his old title save as since/until (${br.title}, ${br.since}–${br.until})`);

    // A bio raises the photo bar: Mary's 535px photo is too small for a profile portrait
    await clickText(page, '.breadcrumb button', 'Board');
    await page.waitForSelector('.ppl-row');
    await clickText(page, '.ppl-row__name', 'Mary Atchley');
    await page.waitForSelector('#ppl-bio');
    await page.waitForFunction(() => /px across/.test(document.querySelector('.ppl-quality')?.textContent || ''), { timeout: 15000 });
    ok(!(await page.$eval('.ppl-checklist', (e) => e.textContent)).includes('too small for their profile'), 'no profile warning without a bio');
    await page.type('#ppl-bio', 'Mary designs.');
    await sleep(200);
    ok((await page.$eval('.ppl-checklist', (e) => e.textContent)).includes('Photo too small for their profile') && (await page.$eval('.ppl-quality', (e) => e.textContent)).includes('Soft on their profile page'),
      'with a bio, a 535px photo is flagged as too small for the profile');
    await page.$eval('#ppl-bio', (t) => { t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); });

    // ── Past Chair and committees: Casey ──
    const seatLabels = () => page.evaluate(() => [...[...document.querySelectorAll('.ppl-role .ppl-seg')][1].querySelectorAll('[role="radio"]')].map((b) => b.textContent));
    const badges = () => page.$$eval('#ppl-committees .ppl-cmte:not(.ppl-cmte--new)', (bs) => bs.map((b) => `${b.textContent.trim()}${b.getAttribute('aria-pressed') === 'true' ? '*' : ''}`));
    const badge = (name) => page.evaluate((n) => [...document.querySelectorAll('#ppl-committees .ppl-cmte')].find((b) => b.textContent.trim() === n)?.click(), name);
    await clickText(page, '.breadcrumb button', 'Board');
    await page.waitForSelector('.ppl-row');
    await clickText(page, '.ppl-row__name', 'Casey Bradley');
    await page.waitForSelector('#ppl-committees');
    ok(JSON.stringify(await seatLabels()) === JSON.stringify(['Member', 'Chair', 'Vice Chair', 'Treasurer', 'Secretary', 'Past Chair']), `six seat choices, Past Chair last (${(await seatLabels()).join(', ')})`);
    await page.evaluate(() => [...[...document.querySelectorAll('.ppl-role .ppl-seg')][1].querySelectorAll('[role="radio"]')].find((b) => b.textContent === 'Past Chair').click());
    ok(await page.$eval('#ppl-title', (i) => i.value) === 'Past Board Chair', 'picking Past Chair sets the title to Past Board Chair');
    await page.waitForFunction(() => document.querySelectorAll('#ppl-committees .ppl-cmte').length > 1, { timeout: 5000 });
    ok(JSON.stringify(await badges()) === JSON.stringify(['Finance', 'Gala', 'Golf Tournament', 'Governance']), `the starter committees are badges, none picked (${(await badges()).join(', ')})`);
    await badge('Golf Tournament');
    await badge('Finance');
    ok(JSON.stringify(await badges()) === JSON.stringify(['Finance*', 'Gala', 'Golf Tournament*', 'Governance']), `a tap picks a committee (${(await badges()).join(', ')})`);
    await badge('New committee');
    await page.waitForSelector('.ppl-cmte-new input');
    ok(await page.evaluate(() => document.activeElement === document.querySelector('.ppl-cmte-new input')), 'New committee opens a focused field');
    await page.type('.ppl-cmte-new input', ' finance ');
    ok(await page.evaluate(() => /Finance is already picked/.test(document.querySelector('.ppl-cmte-new')?.textContent || '') && document.querySelector('.ppl-cmte-new .btn-primary').disabled),
      'typing a picked committee says so, and Add waits');
    await page.keyboard.press('Escape');
    await sleep(150);
    ok(!(await page.$('.ppl-cmte-new')) && await page.evaluate(() => document.activeElement?.textContent.trim() === 'New committee'), 'Escape closes the field and focus goes back to New committee');
    await badge('New committee');
    await page.waitForSelector('.ppl-cmte-new input');
    await page.type('.ppl-cmte-new input', '  Marketing ');
    await page.keyboard.press('Enter');
    await sleep(150);
    ok(JSON.stringify(await badges()) === JSON.stringify(['Finance*', 'Gala', 'Golf Tournament*', 'Governance', 'Marketing*']), `a new committee joins the badges, picked (${(await badges()).join(', ')})`);
    await shot(page, 'desk-editor-committees');
    await clickText(page, '.ppl-ed-head .btn-primary', 'Save');
    await page.waitForFunction(() => !document.querySelector('.ppl-unsaved'), { timeout: 8000 });
    await sleep(500);
    const casey = api.st.team['casey-bradley'];
    ok(casey.seat === 'past-chair' && casey.title === 'Past Board Chair', `Casey saved as Past Chair (${casey.seat}, ${casey.title})`);
    ok(JSON.stringify(casey.committees) === JSON.stringify(['Finance', 'Golf Tournament', 'Marketing']), `committees saved A to Z, tidied (${JSON.stringify(casey.committees)})`);
    ok(JSON.stringify(api.st.site['board-committees']?.committees) === JSON.stringify(['Finance', 'Gala', 'Golf Tournament', 'Governance', 'Marketing']),
      `Marketing joined the saved list (${JSON.stringify(api.st.site['board-committees'])})`);
    await clickText(page, '.breadcrumb button', 'Board');
    await page.waitForSelector('.ppl-row');
    await sleep(300);
    ok(JSON.stringify(await rowNames(page, 'Officers')) === JSON.stringify(['Scott Wierson', 'Casey Bradley']), `officers: the Chair, then the Past Chair (${(await rowNames(page, 'Officers'))?.join(', ')})`);
    ok(await page.evaluate(() => /Secretary, Past Chair\./.test([...document.querySelectorAll('.ppl-section')].find((s) => /Officers/.test(s.textContent))?.querySelector('.ppl-hint')?.textContent || '')), 'the Officers note lists Past Chair');

    // The committee list: rename, a clash, remove, add
    const cmteRows = () => page.$$eval('.ppl-cmte-row', (rs) => rs.map((r) => r.querySelector('strong')?.textContent || r.textContent.trim().slice(0, 30)));
    const rowBtn = (name, label) => page.evaluate((n, l) => [...document.querySelectorAll('.ppl-cmte-row')].find((r) => r.querySelector('strong')?.textContent === n)
      ?.querySelector(`[aria-label="${l} ${n}"]`)?.click(), name, label);
    // From the keyboard, so focus has a button to come back to
    await page.evaluate(() => [...document.querySelectorAll('.ppl-head .btn')].find((b) => b.textContent.trim() === 'Committees').focus());
    await page.keyboard.press('Enter');
    await page.waitForSelector('.ppl-cmte-list');
    ok(JSON.stringify(await cmteRows()) === JSON.stringify(['Finance', 'Gala', 'Golf Tournament', 'Governance', 'Marketing']), `the dialog lists the committees (${(await cmteRows()).join(', ')})`);
    ok(await page.evaluate(() => [...document.querySelectorAll('.ppl-cmte-row')].find((r) => r.textContent.includes('Finance'))?.textContent.includes('1 · Casey Bradley')), 'each committee says who is on it');
    await sleep(600); // the dialog fades in
    await shot(page, 'desk-committees', { grow: false });
    await rowBtn('Marketing', 'Rename');
    await page.waitForSelector('#ppl-cmte-rename');
    ok(await page.evaluate(() => document.activeElement?.id === 'ppl-cmte-rename' && document.activeElement.selectionEnd - document.activeElement.selectionStart === 9), 'Rename selects the name to type over');
    await page.type('#ppl-cmte-rename', 'Outreach');
    let saves2 = callsTo(api, '/api/save-content');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#ppl-cmte-rename') && !document.querySelector('.ppl-cmte-modal .spinner'), { timeout: 8000 });
    await sleep(300);
    ok(JSON.stringify(api.st.team['casey-bradley'].committees) === JSON.stringify(['Finance', 'Golf Tournament', 'Outreach']), `renaming updates Casey's record (${JSON.stringify(api.st.team['casey-bradley'].committees)})`);
    ok(callsTo(api, '/api/save-content') === saves2 + 2, 'one save for Casey, one for the list');
    ok(JSON.stringify(await cmteRows()) === JSON.stringify(['Finance', 'Gala', 'Golf Tournament', 'Governance', 'Outreach']), `the list shows Outreach (${(await cmteRows()).join(', ')})`);
    await rowBtn('Gala', 'Rename');
    await page.waitForSelector('#ppl-cmte-rename');
    await page.type('#ppl-cmte-rename', 'FINANCE');
    ok(await page.evaluate(() => /already a Finance committee/.test(document.querySelector('.ppl-cmte-row.is-editing')?.textContent || '') && document.querySelector('.ppl-cmte-row.is-editing .btn-primary').disabled),
      'renaming to a name already on the list is stopped');
    await page.keyboard.press('Escape');
    await sleep(150);
    ok(!(await page.$('#ppl-cmte-rename')) && !!(await page.$('.ppl-cmte-modal')), 'Escape leaves the rename, not the dialog');
    saves2 = callsTo(api, '/api/save-content');
    await rowBtn('Gala', 'Remove');
    await page.waitForFunction(() => ![...document.querySelectorAll('.ppl-cmte-row strong')].some((s) => s.textContent === 'Gala'), { timeout: 8000 });
    ok(callsTo(api, '/api/save-content') === saves2 + 1, 'removing a committee no one is on saves only the list');
    await rowBtn('Finance', 'Remove');
    await page.waitForSelector('.ppl-cmte-row.is-confirm');
    ok((await page.$eval('.ppl-cmte-row.is-confirm', (e) => e.textContent)).includes('Take Finance off Casey Bradley too?'), 'removing a committee with members asks first, by name');
    await shot(page, 'desk-committees-confirm', { grow: false });
    await clickText(page, '.ppl-cmte-row.is-confirm .btn', 'Remove');
    await page.waitForFunction(() => !document.querySelector('.ppl-cmte-row.is-confirm') && !document.querySelector('.ppl-cmte-modal .spinner'), { timeout: 8000 });
    await sleep(300);
    ok(JSON.stringify(api.st.team['casey-bradley'].committees) === JSON.stringify(['Golf Tournament', 'Outreach']), `Finance comes off Casey (${JSON.stringify(api.st.team['casey-bradley'].committees)})`);
    await page.type('#ppl-cmte-add', 'Audit');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => [...document.querySelectorAll('.ppl-cmte-row strong')].some((s) => s.textContent === 'Audit'), { timeout: 8000 });
    ok(JSON.stringify(api.st.site['board-committees'].committees) === JSON.stringify(['Audit', 'Golf Tournament', 'Governance', 'Outreach']), `the saved list after all that (${JSON.stringify(api.st.site['board-committees'].committees)})`);
    await page.focus('#ppl-cmte-add');
    for (let i = 0; i < 14; i++) await page.keyboard.press('Tab');
    ok(await page.evaluate(() => document.querySelector('.ppl-cmte-modal').contains(document.activeElement)), 'Tab stays inside the committees dialog');
    await page.keyboard.press('Escape');
    await sleep(200);
    ok(!(await page.$('.ppl-cmte-modal')) && await page.evaluate(() => document.activeElement?.textContent.trim() === 'Committees'), 'Escape closes it and focus goes back to Committees');
    await clickText(page, '.ppl-row__name', 'Casey Bradley');
    await page.waitForSelector('#ppl-committees');
    await page.waitForFunction(() => [...document.querySelectorAll('#ppl-committees .ppl-cmte')].some((b) => b.textContent.trim() === 'Audit'), { timeout: 5000 });
    ok(JSON.stringify(await badges()) === JSON.stringify(['Audit', 'Golf Tournament*', 'Governance', 'Outreach*']), `Casey's badges follow the list (${(await badges()).join(', ')})`);

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
    // The admin-wide a11y pass can focus the field a moment before the dialog wires up Escape (modal-open marks that)
    ok(await page.waitForFunction(() => document.activeElement?.id === 'ppl-rename' && document.body.classList.contains('modal-open'), { timeout: 3000 }).then(() => true, () => false), 'the rename dialog opens with its field focused');
    await page.keyboard.press('Escape');
    ok(await page.waitForFunction(() => !document.querySelector('#ppl-rename') && document.activeElement?.textContent.trim() === 'Change', { timeout: 3000 }).then(() => true, () => false),
      `Escape closes it and focus goes back to Change (${await page.evaluate(() => `${!!document.querySelector('#ppl-rename')} ${document.activeElement?.tagName} ${document.activeElement?.textContent.trim().slice(0, 20)}`)})`);
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
    // A founder's editor, then Greg to Honorary crew
    await clickText(page, '.ppl-row__name', 'Holly Ranney');
    await page.waitForSelector('#ppl-title');
    await sleep(600);
    ok((await page.$eval('.ppl-role', (e) => e.textContent)).includes('Founders get the larger cards'), 'a founder\'s role explains the larger cards');
    await shot(page, 'desk-editor-founder');
    await clickText(page, '.breadcrumb button', 'Team');
    await page.waitForSelector('.ppl-row');
    await clickText(page, '.ppl-row__name', 'Greg Ranney');
    await page.waitForSelector('#ppl-title');
    await page.evaluate(() => [...[...document.querySelectorAll('.ppl-role .ppl-seg')][1].querySelectorAll('[role="radio"]')].find((b) => b.textContent === 'Honorary crew').click());
    ok((await page.$eval('.ppl-role', (e) => e.textContent)).includes('after the staff'), 'Honorary crew says where they show');
    ok(!(await page.evaluate(() => [...document.querySelectorAll('.ppl-role [role="radio"]')].some((b) => b.textContent === 'In memoriam'))), 'In memoriam isn\'t offered for the team (only board cards show it)');
    ok(!(await page.$('#ppl-email')) && !(await page.$('#ppl-committees')), 'no invite email or committees for the team');
    ok(!(await page.$('#ppl-linkedin')) && !(await page.$eval('.ppl-checklist', (e) => e.textContent)).includes('LinkedIn'), 'honorary crew aren\'t asked for LinkedIn');
    await sleep(500);
    await shot(page, 'desk-editor-team');
    await clickText(page, '.ppl-ed-head .btn-primary', 'Save');
    await page.waitForFunction(() => !document.querySelector('.ppl-unsaved'), { timeout: 8000 });
    ok(api.st.team['greg-ranney'].role === 'honorary', 'saved as honorary crew');
    await clickText(page, '.breadcrumb button', 'Team');
    await page.waitForSelector('.ppl-row');
    await sleep(300);
    ok(JSON.stringify(await rowNames(page, 'Honorary crew')) === JSON.stringify(['Greg Ranney']) && (await rowNames(page, 'Staff')).length === 6, 'Greg moves to Honorary crew; Staff has 6');
    await shot(page, 'desk-team-after');
    ok(await page.evaluate(() => document.querySelectorAll('.ppl-tag--waiting').length > 0), 'saved rows show Waiting to publish');

    ok(!errors.length, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await page.close();
  }

  // ════════ Desktop: content tools ════════
  console.log('Desktop 1440: readiness, export, photos, bio requests, tidy, history, merging');
  {
    const { page, api, errors } = await open(browser, { width: 1440, height: 1000, mobile: false });
    // Mail links and downloads are caught here instead of leaving the page
    await page.evaluate(() => {
      window.__mail = [];
      window.__blobs = [];
      window.__copied = [];
      document.addEventListener('click', (e) => { const a = e.target.closest?.('a[href^="mailto:"]'); if (a) { window.__mail.push(a.href); e.preventDefault(); } }, true);
      const make = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (b) => { window.__blobs.push(b); return make(b); };
      try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied.push(t); } }, configurable: true }); } catch {}
    });
    api.st.emails['scott-wierson'] = 'scott@example.com';
    api.st.emails['mary-atchley'] = 'mary@example.com';

    // The Dashboard says whose profile came back
    await page.waitForFunction(() => /sent their profile/.test(document.body.textContent), { timeout: 15000 }).catch(() => {});
    const bioNeed = await page.evaluate(() => [...document.querySelectorAll('.dneed-title')].find((e) => /sent their profile/.test(e.textContent))?.textContent.trim());
    ok(bioNeed === 'Jennifer Crosby sent their profile', `the Dashboard says Jennifer's profile came back (${bioNeed})`);

    // ── Readiness tiles on Board ──
    await goPeople(page, 'board', false);
    await page.waitForFunction(() => !document.querySelector('.ppl-ready .spinner'), { timeout: 15000 });
    const tiles = await $text(page, '.ppl-ready__tile');
    ok(tiles.length === 4 && tiles[0].startsWith('Profiles live0 of 12') && tiles[1].startsWith('Invite emails2 of 12') && tiles[2].startsWith('Photos ready') && tiles[3].startsWith('Bios to review1'),
      `four tiles: profiles, invite emails, photos, bios to review (${tiles.join(' | ')})`);
    ok(await page.evaluate(() => [...document.querySelectorAll('.ppl-row')].find((r) => r.textContent.includes('Jennifer Crosby'))?.querySelector('.ppl-tag--review')?.textContent === 'Bio to review'),
      'Jennifer\'s row says Bio to review');
    ok(await page.evaluate(() => [...document.querySelectorAll('.ppl-row')].find((r) => r.textContent.includes('Lori Geary'))?.textContent.includes('Bio asked')), 'Lori\'s row says Bio asked');
    await clickText(page, '.ppl-ready__tile', 'Invite emails');
    await sleep(200);
    let names = await page.$$eval('.ppl-row__name', (n) => n.map((x) => x.textContent));
    ok(names.length === 10 && !names.includes('Scott Wierson') && !names.includes('Brent Aronson'), `the Invite emails tile shows the 10 without one (${names.length})`);
    ok((await page.$eval('.ppl-filter--clear', (b) => b.textContent.trim())).startsWith('No invite email 10'), 'a chip names the filter, to clear it');
    await shot(page, 'desk-ready-filter');
    await page.click('.ppl-filter--clear');
    await sleep(200);
    ok((await page.$$('.ppl-row__name')).length === 13, 'clearing it shows everyone');
    await clickText(page, '.ppl-ready__tile', 'Bios to review');
    await sleep(200);
    names = await page.$$eval('.ppl-row__name', (n) => n.map((x) => x.textContent));
    ok(JSON.stringify(names) === '["Jennifer Crosby"]', `Bios to review shows Jennifer (${names.join(', ')})`);
    await page.click('.ppl-filter--clear');

    // ── Email the board ──
    await clickText(page, '.ppl-head-menu', 'More');
    await page.waitForSelector('.ppl-menu__pop');
    await shot(page, 'desk-email-menu', { grow: false });
    await clickText(page, '.ppl-menu__pop [role="menuitem"]', 'Write to the whole board');
    await sleep(200);
    const mail = await page.evaluate(() => window.__mail.at(-1) || '');
    ok(/^mailto:\?bcc=/.test(mail) && mail.includes('scott@example.com') && mail.includes('mary@example.com'), `Email the board opens a Bcc email to the invite addresses (${mail})`);
    await clickText(page, '.ppl-head-menu', 'More');
    await page.waitForSelector('.ppl-menu__pop');
    await clickText(page, '.ppl-menu__pop [role="menuitem"]', 'Copy the addresses');
    await sleep(200);
    ok(await page.evaluate(() => window.__copied.at(-1)) === 'scott@example.com, mary@example.com' || await page.evaluate(() => window.__copied.at(-1)) === 'mary@example.com, scott@example.com', 'Copy the addresses copies both');

    // ── Export ──
    await clickText(page, '.ppl-head-menu', 'More');
    await page.waitForSelector('.ppl-menu__pop');
    await clickText(page, '.ppl-menu__pop [role="menuitem"]', 'Download a spreadsheet');
    await sleep(200);
    const { csv, bom } = await page.evaluate(async () => {
      const b = window.__blobs.at(-1);
      if (!b) return { csv: '', bom: false };
      const head = new Uint8Array(await b.slice(0, 3).arrayBuffer());
      return { csv: await b.text(), bom: head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF };
    });
    const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n');
    ok(bom && lines[0].startsWith('"Name","Seat","Title","Company","On the board since"'), 'the spreadsheet starts with a UTF-8 mark (so Excel reads accents) and a header row');
    ok(lines[1].startsWith('"Scott Wierson","Chair","Board Chair"') && lines[1].includes('"scott@example.com"'), `Scott first, with seat and invite email (${lines[1]})`);
    ok(lines.length === 14 && lines.at(-1).startsWith('"Brent Aronson"'), `everyone on the board, the memorial last (${lines.length - 1} rows)`);
    await clickText(page, '.ppl-head-menu', 'More');
    await page.waitForSelector('.ppl-menu__pop');
    const popup = new Promise((resolve) => browser.once('targetcreated', (t) => resolve(t.page())));
    await clickText(page, '.ppl-menu__pop [role="menuitem"]', 'Print the roster');
    const roster = await popup;
    await roster.waitForSelector('#pr-print', { timeout: 10000 });
    await roster.setViewport({ width: 1000, height: 1200 });
    const rosterInfo = await roster.evaluate(() => ({ rows: document.querySelectorAll('tbody tr').length, h1: document.querySelector('h1')?.textContent, sections: [...document.querySelectorAll('h2')].map((h) => h.textContent), email: getComputedStyle(document.querySelector('td.email') || document.body).display }));
    ok(rosterInfo.h1 === 'Board of Directors' && rosterInfo.rows === 12 && rosterInfo.sections.join('|') === 'Officers 1|Members 11', `the printable roster lists the current board by section (${JSON.stringify(rosterInfo)})`);
    ok(rosterInfo.email === 'none', 'emails stay off the roster until asked for');
    const imgs = await roster.waitForFunction(() => [...document.images].every((i) => i.complete), { timeout: 20000 }).then(() => roster.evaluate(() => [...document.images].filter((i) => i.naturalWidth > 0).length), () => -1);
    ok(imgs === 12, `every photo loads in the roster window (${imgs} of 12)`);
    await roster.click('#pr-email');
    ok(await roster.evaluate(() => getComputedStyle(document.querySelector('td.email')).display === 'table-cell'), 'Include emails adds them');
    await roster.screenshot({ path: join(OUT, 'desk-roster.png') }).catch(() => {});
    await roster.close();

    // ── What Jennifer sent ──
    await clickText(page, '.ppl-row__name', 'Jennifer Crosby');
    await page.waitForSelector('.ppl-sg');
    await sleep(500);
    const sgRows = await $text(page, '.ppl-sg__label');
    ok(JSON.stringify(sgRows) === '["Bio","Why I serve","LinkedIn","Photo"]', `the review card lists what she sent (${sgRows.join(', ')})`);
    ok(await page.evaluate(() => /Check them and use what you like/.test(document.querySelector('.ppl-ask')?.textContent || '')), 'the Profile section points to the review');
    await shot(page, 'desk-review');
    await page.evaluate(() => [...document.querySelectorAll('.ppl-sg__row')].find((r) => r.textContent.startsWith('Bio')).querySelector('.btn').click());
    await sleep(150);
    ok((await page.$eval('#ppl-bio', (t) => t.value)).startsWith('Jennifer Crosby runs'), 'Use puts her bio in the field');
    await page.evaluate(() => [...document.querySelectorAll('.ppl-sg__row')].find((r) => r.textContent.startsWith('Bio')).querySelector('.btn').click());
    await sleep(150);
    ok((await page.$eval('#ppl-bio', (t) => t.value)) === '', 'Undo puts it back');
    await clickText(page, '.ppl-sg .btn', 'Use all');
    await sleep(300);
    ok((await page.$eval('#ppl-quote', (t) => t.value)).startsWith('Every child') && (await page.$eval('#ppl-linkedin', (t) => t.value)).includes('jennifer-crosby'), 'Use all fills the quote and LinkedIn too');
    ok((await page.$eval('.ppl-photo__circle img', (i) => i.src)).includes(api.st.team['scott-wierson'].photo.match(/imagedelivery\.net\/[^/]+\/(.+)\/public/)[1]), 'and her photo');
    const oldPhoto = api.st.team['jennifer-crosby'].photo;
    await clickText(page, '.ppl-ed-head .btn-primary', 'Save');
    await page.waitForFunction(() => !document.querySelector('.ppl-unsaved') && !document.querySelector('.ppl-sg'), { timeout: 8000 }).catch(() => {});
    await sleep(400);
    const jen = api.st.team['jennifer-crosby'];
    ok(jen.bio.startsWith('Jennifer Crosby runs') && jen.quote.startsWith('Every child') && jen.photo === api.st.team['scott-wierson'].photo && !jen.photoCrop, 'Save keeps what she sent');
    ok(api.st.requests.find((r) => r.id === 900).status === 'used' && !(await page.$('.ppl-sg')), 'her message is marked used and the card goes');
    ok(api.st.deletedImages.some((id) => oldPhoto.includes(id)), 'the photo hers replaced is deleted');
    ok(/^Last saved by Admin today at/.test(await page.$eval('.ppl-ed-meta span', (e) => e.textContent)), `the header says who saved last (${await page.$eval('.ppl-ed-meta span', (e) => e.textContent)})`);

    // ── Ask Clareece, tidy her bio, history ──
    await clickText(page, '.nav-item', 'People');
    await clickText(page, '.hub-tab', 'Team');
    await page.waitForSelector('.ppl-row');
    await clickText(page, '.ppl-row__name', 'Clareece Cunningham');
    await page.waitForSelector('.ppl-ask');
    await clickText(page, '.ppl-ask .btn', 'Get a link');
    await page.waitForSelector('.ppl-ask.is-link');
    const link = await page.$eval('.ppl-ask__link input', (i) => i.value);
    ok(/^https:\/\/sunshineonaranneyday\.com\/profile-update\/#t=/.test(link), `a private link is shown once (${link})`);
    await clickText(page, '.ppl-ask .btn', 'Copy');
    await sleep(150);
    ok(await page.evaluate(() => window.__copied.at(-1)) === link, 'Copy copies it');
    await clickText(page, '.ppl-ask .btn', 'Email Clareece');
    await sleep(150);
    const askMail = decodeURIComponent(await page.evaluate(() => window.__mail.at(-1) || ''));
    ok(askMail.startsWith('mailto:?subject=Your bio for the Sunshine on a Ranney Day website') && askMail.includes(link) && askMail.includes('Hi Clareece,') && !/—/.test(askMail),
      'Email Clareece drafts the ask with the link, no em dashes');
    await shot(page, 'desk-ask-link');
    // Tidy
    await page.type('#ppl-bio', 'clareece is our designer she designs the rooms for the kids and does a great job');
    await clickText(page, '.ppl-bio-tools .btn', 'Tidy to house style');
    await page.waitForSelector('.ppl-tidy');
    ok(await page.evaluate(() => document.querySelectorAll('.ppl-tidy ins').length > 0 && document.querySelectorAll('.ppl-tidy del').length > 0), 'the suggestion marks what changed, word by word');
    ok(lastCall(api, '/api/people-ai')?.body.name === 'Clareece Cunningham' && lastCall(api, '/api/people-ai')?.body.bio.startsWith('clareece is'), 'the helper gets the bio and who it\'s about');
    await shot(page, 'desk-tidy');
    await clickText(page, '.ppl-tidy .btn', 'Use this');
    await sleep(150);
    ok((await page.$eval('#ppl-bio', (t) => t.value)).startsWith('Clareece plans rooms') && !(await page.$('.ppl-tidy')), 'Use this replaces the bio');
    await clickText(page, '.ppl-ed-head .btn-primary', 'Save');
    await page.waitForFunction(() => !document.querySelector('.ppl-unsaved'), { timeout: 8000 });
    // History: the version before, restored
    await clickText(page, '.ppl-ed-meta .ppl-link', 'History');
    await page.waitForSelector('.ppl-hist__item');
    const hist = await $text(page, '.ppl-hist__row');
    ok(hist.length === 2 && hist[0].startsWith('Latest save') && hist[0].includes('Changed Bio') && hist[1].includes('As it was before history began'), `History lists the save and the version before (${hist.join(' | ')})`);
    await page.evaluate(() => document.querySelectorAll('.ppl-hist__row')[1].click());
    await page.waitForSelector('.ppl-hist__diff');
    ok((await page.$eval('.ppl-hist__diff dt', (e) => e.textContent)) === 'Bio', 'opening a version compares it with the editor');
    await sleep(500); // the dialog fades in
    await shot(page, 'desk-history', { grow: false });
    await clickText(page, '.ppl-hist__restore', 'Restore this version');
    await page.waitForFunction(() => !document.querySelector('.ppl-hist'), { timeout: 5000 });
    ok((await page.$eval('#ppl-bio', (t) => t.value)) === '' && await page.evaluate(() => !!document.querySelector('.ppl-unsaved')), 'Restore fills the editor and waits for Save');
    await clickText(page, '.ppl-ed-head .btn-primary', 'Save');
    await page.waitForFunction(() => !document.querySelector('.ppl-unsaved'), { timeout: 8000 });
    ok(!api.st.team['clareece-cunningham'].bio, 'saved as it was');

    // ── Someone saves Holly meanwhile ──
    await clickText(page, '.breadcrumb button', 'Team');
    await page.waitForSelector('.ppl-row');
    await clickText(page, '.ppl-row__name', 'Holly Ranney');
    await page.waitForSelector('#ppl-title');
    await page.$eval('#ppl-title', (i) => { i.value = 'Co-Founder & President'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    api.st.external('holly-ranney', { quote: 'From another tab' });
    await clickText(page, '.ppl-ed-head .btn-primary', 'Save');
    await page.waitForFunction(() => !document.querySelector('.ppl-unsaved'), { timeout: 8000 }).catch(() => {});
    await sleep(300);
    let holly = api.st.team['holly-ranney'];
    ok(holly.title === 'Co-Founder & President' && holly.quote === 'From another tab', `different fields merge quietly: her title and their quote (${holly.title} / ${holly.quote})`);
    ok(await page.evaluate(() => /Jen changed Why I serve while you were editing/.test(document.body.textContent)), 'and a note says whose change was kept');
    ok((await page.$eval('#ppl-quote', (t) => t.value)) === 'From another tab', 'the editor shows their change too');
    await page.$eval('#ppl-bio', (t) => { t.value = 'Mine.'; t.dispatchEvent(new Event('input', { bubbles: true })); });
    api.st.external('holly-ranney', { bio: 'Theirs.' });
    await clickText(page, '.ppl-ed-head .btn-primary', 'Save');
    await page.waitForSelector('.ppl-merge');
    ok((await page.$eval('.ppl-merge h2', (e) => e.textContent)) === 'Jen saved Holly Ranney while you were editing' && (await $text(page, '.ppl-merge__field legend')).join() === 'Bio',
      'the same field changed on both sides is asked about');
    await sleep(500);
    await shot(page, 'desk-merge', { grow: false });
    await page.evaluate(() => [...document.querySelectorAll('.ppl-merge__opt')].find((l) => l.textContent.includes('Jen’s')).querySelector('input').click());
    await clickText(page, '.ppl-merge .btn-primary', 'Save');
    await page.waitForFunction(() => !document.querySelector('.ppl-merge') && !document.querySelector('.ppl-unsaved'), { timeout: 8000 }).catch(() => {});
    holly = api.st.team['holly-ranney'];
    ok(holly.bio === 'Theirs.' && holly.title === 'Co-Founder & President', `picking theirs saves their bio, keeping the rest (${holly.bio})`);

    // ── Photos ──
    await clickText(page, '.breadcrumb button', 'Team');
    await page.waitForSelector('.hub-tabs');
    await clickText(page, '.hub-tab', 'Photos');
    await page.waitForSelector('.ppl-pcard');
    await sleep(800);
    ok((await page.$$('.ppl-pcard')).length === 22, `everyone on the page has a card (${(await page.$$('.ppl-pcard')).length})`);
    await page.waitForFunction(() => !document.querySelector('.ppl-pcard__busy'), { timeout: 30000 }).catch(() => {});
    await shot(page, 'desk-photos');
    await clickText(page, '.ppl-photo-filters .ppl-filter', 'Own background');
    await sleep(200);
    const ownBg = await hoverContrast(page, '.ppl-photo-filters .ppl-filter[aria-pressed="true"]');
    ok(ownBg >= 4.5, `"Own background" stays readable when it's selected and under the pointer (${ownBg.toFixed(1)}:1)`);
    await page.hover('.ppl-photo-filters .ppl-filter[aria-pressed="true"]');
    await sleep(250);
    await page.screenshot({ path: join(OUT, 'desk-photos-filter-hover.png'), clip: await page.$eval('.ppl-photo-filters', (e) => { const r = e.getBoundingClientRect(); return { x: r.x - 8, y: r.y - 8, width: r.width + 16, height: r.height + 16 }; }) });
    await clickText(page, '.ppl-photo-filters .ppl-filter', 'Everyone');
    await sleep(200);
    let batches = callsTo(api, '/api/people-batch');
    await page.click('[aria-label="Remove Scott Wierson’s background"]');
    await page.waitForFunction((n) => true, {}, batches);
    await sleep(500);
    ok(callsTo(api, '/api/people-batch') === batches + 1 && api.st.team['scott-wierson'].photoCutout === true, 'one switch removes Scott\'s background');
    await page.evaluate(() => [...document.querySelectorAll('.toast')].find((t) => /Background removed for Scott/.test(t.textContent))?.querySelector('.toast-undo')?.click());
    await sleep(600);
    ok(!api.st.team['scott-wierson'].photoCutout, 'Undo puts it back');
    await clickText(page, '.ppl-head .btn-primary', 'Remove backgrounds for everyone');
    await page.waitForSelector('.ppl-review-bar');
    const cands = await page.$$eval('.ppl-pcard__pick input', (i) => i.length);
    ok(cands > 10 && (await page.$$('.ppl-pcard__compare')).length === cands, `the preview shows before and after for everyone left (${cands})`);
    await page.waitForFunction(() => !document.querySelector('.ppl-pcard__busy'), { timeout: 45000 }).catch(() => {});
    await shot(page, 'desk-photos-review');
    await page.evaluate(() => [...document.querySelectorAll('.ppl-pcard')].find((c) => c.textContent.includes('Greg Ranney')).querySelector('.ppl-pcard__pick input').click());
    batches = callsTo(api, '/api/people-batch');
    await clickText(page, '.ppl-review-bar .btn-primary', 'Save for');
    await page.waitForFunction(() => !document.querySelector('.ppl-review-bar'), { timeout: 8000 });
    const sent = lastCall(api, '/api/people-batch')?.body.updates || [];
    ok(callsTo(api, '/api/people-batch') === batches + 1 && sent.length === cands - 1 && !sent.some((u) => u.slug === 'greg-ranney'), `one request for everyone ticked, Greg left as he is (${sent.length})`);
    ok(!api.st.team['greg-ranney'].photoCutout && api.st.team['mary-atchley'].photoCutout === true, 'saved');
    // Framing from a card
    await page.waitForFunction(() => [...document.querySelectorAll('.ppl-pcard')].find((c) => c.textContent.includes('Mary Atchley'))?.querySelector('[aria-label^="Frame"]:not([disabled])'), { timeout: 15000 });
    await page.evaluate(() => [...document.querySelectorAll('.ppl-pcard')].find((c) => c.textContent.includes('Mary Atchley')).querySelector('[aria-label^="Frame"]').click());
    await page.waitForSelector('.ppl-crop__stage');
    await page.focus('.ppl-crop__stage');
    await page.keyboard.press('+');
    await page.keyboard.press('+');
    await clickText(page, '.ppl-crop .btn-primary', 'Use this framing');
    await sleep(600);
    const framed = lastCall(api, '/api/people-batch')?.body.updates?.[0];
    ok(framed?.slug === 'mary-atchley' && framed.set.photoCrop?.size < 1 && framed.set.photoSize?.length === 2 && api.st.team['mary-atchley'].photoCrop, 'Frame on a card saves the crop with the photo\'s size');
    // A card's name opens the editor, and comes back to Photos
    await clickText(page, '.ppl-pcard__name', 'Tom Duncan');
    await page.waitForSelector('#ppl-name');
    ok((await $text(page, '.breadcrumb button'))[0] === 'Photos', 'the editor\'s breadcrumb leads back to Photos');
    await clickText(page, '.breadcrumb button', 'Photos');
    await page.waitForSelector('.ppl-pcard');
    ok(await page.$eval('.hub-tab.active', (t) => t.textContent.startsWith('Photos')), 'and lands on Photos');

    ok(!errors.length, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await page.close();
  }

  // ════════ iPad ════════
  console.log('iPad 820 (touch)');
  {
    const { page, errors } = await open(browser, { width: 820, height: 1180, mobile: true });
    const fits = () => page.evaluate(() => { const main = document.querySelector('.main').getBoundingClientRect(); return [...document.querySelectorAll('.main *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > main.right + 1; }).map((e) => e.className || e.tagName).slice(0, 5); });
    const small = (sel) => page.$$eval(sel, (els) => els.filter((e) => e.getClientRects().length && e.getBoundingClientRect().height < 44).map((e) => e.textContent.trim().slice(0, 24)));
    await goPeople(page, 'board', true);
    await page.waitForFunction(() => !document.querySelector('.ppl-ready .spinner'), { timeout: 15000 });
    await sleep(600);
    const f1 = await fits();
    const s1 = await small('.ppl-head .btn, .ppl-filter, .ppl-ready__tile');
    ok(!f1.length && !s1.length, `Board on an iPad: header, tiles and filters fit, 44px targets (${f1.join(', ')}${s1.join(', ')})`);
    await shot(page, 'ipad-board');
    await clickText(page, '.ppl-row__name', 'Jennifer Crosby');
    await page.waitForSelector('.ppl-sg');
    await sleep(800);
    const f2 = await fits();
    const s2 = await small('.ppl-sg .btn, .ppl-ask .btn, .ppl-bio-tools .btn, .ppl-ed-meta .ppl-link, .ppl-admin__row .btn');
    ok(!f2.length && !s2.length, `the editor with the review card fits an iPad, 44px targets (${f2.join(', ')}${s2.join(', ')})`);
    await shot(page, 'ipad-review');
    await page.evaluate(() => document.querySelector('.breadcrumb button')?.click());
    await page.waitForSelector('.hub-tabs');
    await clickText(page, '.hub-tab', 'Photos');
    await page.waitForSelector('.ppl-pcard');
    await sleep(1000);
    const f3 = await fits();
    const s3 = await small('.ppl-pcard .btn, .ppl-filter, .ppl-head .btn');
    ok(!f3.length && !s3.length, `Photos fits an iPad, 44px targets (${f3.join(', ')}${s3.join(', ')})`);
    await shot(page, 'ipad-photos');
    ok(!errors.length, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await page.close();
  }

  // ════════ Advisory Board ════════
  console.log('Advisory Board 1440');
  {
    const { page, api, errors } = await open(browser, { width: 1440, height: 1000, mobile: false });
    await goPeople(page, 'team', false);
    let tabs = await $text(page, '.hub-tab');
    ok(tabs.join('|') === 'Team9|Board13|Advisory0|Photos', `an Advisory tab sits after Board (${tabs.join(' | ')})`);
    await clickText(page, '.hub-tab', 'Advisory');
    await page.waitForSelector('.ppl-empty-all');
    await sleep(600);
    const empty = await page.$eval('.ppl-empty-all', (e) => e.textContent.replace(/\s+/g, ' ').trim());
    ok(/No one on the Advisory Board yet/.test(empty) && /Paste a list/.test(empty) && /Add an advisor/.test(empty), `the empty tab offers Paste a list and Add advisor (${empty.slice(0, 90)})`);
    ok(await page.$eval('.ppl-head a.btn', (a) => a.getAttribute('href') === '/advisory-board/' && a.textContent.includes('Advisory Board page')), 'the header links to the Advisory Board page');
    await shot(page, 'adv-empty');
    await axeCheck(page, 'the empty Advisory tab');

    // Paste a list: each line says what Add will do
    await clickText(page, '.ppl-head .btn', 'Paste a list');
    await page.waitForSelector('#ppl-paste');
    await sleep(300);
    ok(await page.evaluate(() => document.activeElement?.id === 'ppl-paste'), 'the list box takes focus');
    const LIST = ['Ada Lovelace: Ada@Example.com', 'Grace Hopper, grace@example.org', '• Alan Turing <alan@example.net>', 'Mary Jackson',
      'Scott Wierson: scott@example.com', 'ada lovelace: again@example.com', 'Bad Email: nope@'].join('\n');
    await page.$eval('#ppl-paste', (t, v) => { t.value = v; t.dispatchEvent(new Event('input', { bubbles: true })); }, LIST);
    await sleep(300);
    const plan = await page.$$eval('.ppl-paste__row', (rows) => rows.map((r) => [r.querySelector('strong').textContent, r.querySelector('small')?.textContent || '', r.querySelector('.ppl-paste__state').textContent.trim()]));
    ok(JSON.stringify(plan.map((p) => p[2])) === JSON.stringify(['Adds them with their email', 'Adds them with their email', 'Adds them with their email', 'Adds them, no email yet',
      'Already in Board of Directors', 'Listed twice', 'The email doesn’t look right']), `each pasted line says what happens (${plan.map((p) => `${p[0]}: ${p[2]}`).join('; ')})`);
    ok(plan[0][1] === 'ada@example.com' && plan[2][0] === 'Alan Turing', 'names and emails come out clean (lowercase email, no bullet or brackets)');
    const addBtn = await page.$eval('.ppl-paste .kd-dialog__foot .btn-primary', (b) => b.textContent.trim());
    ok(addBtn === 'Add 4 advisors', `the button counts who it adds (${addBtn})`);
    await shot(page, 'adv-paste', { grow: false });
    await axeCheck(page, 'Paste a list');
    const saves = callsTo(api, '/api/save-content');
    await clickText(page, '.ppl-paste .kd-dialog__foot .btn-primary', 'Add 4');
    await page.waitForFunction(() => !document.querySelector('.ppl-paste'), { timeout: 15000 });
    await page.waitForSelector('.ppl-row', { timeout: 10000 });
    await sleep(500);
    ok(callsTo(api, '/api/save-content') - saves === 4, 'one save per new advisor');
    const ada = api.st.team['ada-lovelace'];
    ok(ada?.group === 'advisory' && ada.title === 'Advisory Board Member' && ada.status === 'active' && ada.publishStatus === 'published' && ada.since === new Date().getFullYear() && !('role' in ada) && !('seat' in ada),
      `an added advisor is a full record (${JSON.stringify(ada)})`);
    ok(!Object.keys(api.st.team).some((s) => s.startsWith('bad-email')), 'a line whose email is broken adds no one');
    ok(api.st.emails['ada-lovelace'] === 'ada@example.com' && api.st.emails['grace-hopper'] === 'grace@example.org' && api.st.emails['alan-turing'] === 'alan@example.net' && !api.st.emails['mary-jackson'],
      'their private emails are saved, nothing for someone without one');
    ok(!api.st.emails['scott-wierson'] && api.st.team['scott-wierson'].group === 'board', 'someone on the board stays on the board');
    ok(JSON.stringify(await rowNames(page, 'Members')) === JSON.stringify(['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Mary Jackson']), 'the Members section lists them in the pasted order');
    tabs = await $text(page, '.hub-tab');
    ok(tabs[2] === 'Advisory4', `the tab counts them (${tabs[2]})`);
    const tiles = await $text(page, '.ppl-ready__tile');
    ok(tiles.some((t) => /^Invite emails3 of 4/.test(t)), `the Invite emails tile says who gets invites (${tiles.join(' | ')})`);
    const chips = await page.evaluate(() => [...document.querySelectorAll('.ppl-row')].find((r) => r.textContent.includes('Mary Jackson'))?.querySelector('.ppl-row__issues')?.textContent || '');
    ok(/No photo/.test(chips) && /No invite email/.test(chips), `a row says what's missing (${chips})`);
    ok(await page.evaluate(() => [...document.querySelectorAll('.ppl-row__sub')].some((s) => s.textContent.trim() === 'Advisory Board Member')), 'rows show the title');
    await shot(page, 'adv-list');
    await axeCheck(page, 'the Advisory list');

    // Email the advisory board: Bcc of the three addresses
    await page.click('.ppl-head-menu');
    await page.waitForSelector('.ppl-menu__pop');
    const mail = await $text(page, '.ppl-menu__pop [role="menuitem"]');
    ok(mail[0].startsWith('Write to the whole advisory board') && /3 addresses in Bcc/.test(mail[0]) && mail.some((m) => m.startsWith('1 without an invite email')), `the Email menu (${mail.join(' | ')})`);
    await page.keyboard.press('Escape');
    await sleep(200);

    // The Dashboard counts an advisor with no invite email with the board, and Show them lands on the board first
    await clickText(page, '.nav-item', 'Dashboard');
    await page.waitForFunction(() => /won’t get reveal invites/.test(document.body.textContent), { timeout: 15000 }).catch(() => {});
    const need = await page.evaluate(() => [...document.querySelectorAll('.dneed-title')].find((e) => /reveal invites/.test(e.textContent))?.textContent.trim());
    ok(/^13 board and advisory board members won’t get reveal invites/.test(need || ''), `the Dashboard counts advisors without an invite email (${need})`);
    await clickText(page, '.nav-item', 'People');
    await page.waitForSelector('.hub-tabs');
    await clickText(page, '.hub-tab', 'Advisory');
    await page.waitForSelector('.ppl-row');
    await sleep(400);

    // An advisor's editor: no seat or role, a private email, the Advisory Board page in Preview
    await clickText(page, '.ppl-row__name', 'Mary Jackson');
    await page.waitForSelector('#ppl-title');
    await sleep(600);
    const ed = await page.evaluate(() => ({
      group: document.querySelector('[aria-label="On the page under"] [aria-checked="true"]')?.textContent.trim(),
      labels: [...document.querySelectorAll('.ppl-role .form-label')].map((l) => l.textContent.trim()),
      contact: document.querySelector('#ppl-adv-h')?.textContent === 'Reveal invites' && document.querySelector('label[for="ppl-email"]')?.textContent.trim() === 'Email for reveal invites' && !document.querySelector('#ppl-board-h'),
      org: document.querySelector('label[for="ppl-org"]')?.textContent.trim(),
      partner: !!document.querySelector('label[for="ppl-partner"]'),
      since: document.querySelector('label[for="ppl-since"]')?.textContent.trim(),
      show: document.querySelector('.ppl-role .ppl-switch')?.textContent.trim(),
    }));
    ok(ed.group === 'Advisory Board' && !ed.labels.includes('Seat') && !ed.labels.includes('Role'), `an advisor has no seat or role (${ed.group}; ${ed.labels.join(', ')})`);
    ok(ed.contact && ed.org?.startsWith('Company and role') && ed.partner && ed.since?.startsWith('On the advisory board since') && ed.show === 'Show on the site', `the editor speaks advisory (${JSON.stringify(ed)})`);
    await page.type('#ppl-email', 'Mary@Example.com');
    await page.type('#ppl-org', 'Langley Research, Engineer');
    await clickText(page, '.ppl-ed-head .btn-primary', 'Save');
    await page.waitForFunction(() => !document.querySelector('.ppl-unsaved'), { timeout: 8000 });
    ok(api.st.emails['mary-jackson'] === 'mary@example.com' && api.st.team['mary-jackson'].organization === 'Langley Research, Engineer', 'the email and company save with Save');
    await shot(page, 'adv-editor');
    await axeCheck(page, 'an advisor’s editor');
    await clickText(page, '.ppl-ed-head .btn', 'Preview');
    let previewOk = false;
    for (let i = 0; i < 40 && !previewOk; i++) {
      await sleep(500);
      previewOk = await page.evaluate(() => [...document.querySelectorAll('iframe')].some((f) => {
        try {
          const d = f.contentDocument;
          const names = [...d.querySelectorAll('#members .abm-name')].map((n) => n.textContent.trim());
          return /\/advisory-board\//.test(f.contentWindow.location.pathname) && names.join('|') === 'Ada Lovelace|Grace Hopper|Alan Turing|Mary Jackson'
            && [...d.querySelectorAll('.abm-org')].some((o) => o.textContent === 'Langley Research, Engineer');
        } catch { return false; }
      }));
    }
    ok(previewOk, 'Preview shows the real Advisory Board page with every advisor and the new company');
    await shot(page, 'adv-preview');
    await clickText(page, '.ppl-ed-head .btn', 'Preview');
    // Moving them to the board gives them the board's title, and back
    await page.evaluate(() => [...document.querySelectorAll('[aria-label="On the page under"] [role="radio"]')].find((b) => b.textContent.trim() === 'Board of Directors').click());
    await sleep(200);
    ok(await page.$eval('#ppl-title', (i) => i.value === 'Board Member') && !!(await page.$('#ppl-board-h')), 'moved to the board: Board Member, with the board details');
    await page.evaluate(() => [...document.querySelectorAll('[aria-label="On the page under"] [role="radio"]')].find((b) => b.textContent.trim() === 'Advisory Board').click());
    await sleep(200);
    ok(await page.$eval('#ppl-title', (i) => i.value === 'Advisory Board Member'), 'and back: Advisory Board Member');
    await page.evaluate(() => document.querySelector('.breadcrumb button')?.click());
    await sleep(400);
    await page.waitForSelector('.hub-tabs');

    // A pasted line for someone already here saves their email only
    await clickText(page, '.hub-tab', 'Advisory');
    await page.waitForSelector('.ppl-row');
    await clickText(page, '.ppl-head-menu', 'More');
    await page.waitForSelector('.ppl-menu__pop');
    await clickText(page, '.ppl-menu__pop [role="menuitem"]', 'Paste a list');
    await page.waitForSelector('#ppl-paste');
    await page.$eval('#ppl-paste', (t) => { t.value = 'Ada Lovelace: ada@example.com\nMary Jackson: mary.j@example.com'; t.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(300);
    const again = await $text(page, '.ppl-paste__state');
    ok(again[0] === 'Already here' && /replaces mary@example\.com/.test(again[1]), `a second paste knows who's here (${again.join(' | ')})`);
    const saves2 = callsTo(api, '/api/save-content');
    await clickText(page, '.ppl-paste .kd-dialog__foot .btn-primary', 'Save 1 email');
    await page.waitForFunction(() => !document.querySelector('.ppl-paste'), { timeout: 10000 });
    ok(callsTo(api, '/api/save-content') === saves2 && api.st.emails['mary-jackson'] === 'mary.j@example.com', 'it saves the new email and no record');

    // Photos and the search box know the third group
    await clickText(page, '.hub-tab', 'Photos');
    await page.waitForSelector('.ppl-pcard');
    ok((await $text(page, '.ppl-photos h3')).some((t) => t.startsWith('Advisory Board')), 'Photos has an Advisory Board section');
    // With Mary's email in, the Dashboard is back to the board alone
    await clickText(page, '.nav-item', 'Dashboard');
    await page.waitForSelector('.dneed-title', { timeout: 15000 }).catch(() => {});
    await sleep(800);
    // The Dashboard shows its top few; the rest are behind Show more
    await page.evaluate(() => { const more = document.querySelector('.dneeds-more'); if (more?.getAttribute('aria-expanded') === 'false') more.click(); });
    await page.waitForFunction(() => /won’t get reveal invites/.test(document.body.textContent), { timeout: 15000 }).catch(() => {});
    const need2 = await page.evaluate(() => [...document.querySelectorAll('.dneed-title')].find((e) => /reveal invites/.test(e.textContent))?.textContent.trim());
    ok(/^12 board members won’t get reveal invites/.test(need2 || ''), `once every advisor has one, the Dashboard counts only the board (${need2})`);
    ok(!errors.length, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await page.close();
  }
  console.log('Advisory Board 820 (iPad, touch)');
  {
    const { page, errors } = await open(browser, { width: 820, height: 1180, mobile: true });
    const fits = () => page.evaluate(() => { const main = document.querySelector('.main').getBoundingClientRect(); return [...document.querySelectorAll('.main *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > main.right + 1; }).map((e) => e.className || e.tagName).slice(0, 5); });
    const small = (sel) => page.$$eval(sel, (els) => els.filter((e) => e.getClientRects().length && e.getBoundingClientRect().height < 44).map((e) => e.textContent.trim().slice(0, 24)));
    await page.evaluate(() => document.querySelector('.hamburger')?.click());
    await sleep(350);
    await clickText(page, '.nav-item', 'People');
    await page.waitForSelector('.hub-tabs');
    await clickText(page, '.hub-tab', 'Advisory');
    await page.waitForSelector('.ppl-empty-all');
    await sleep(500);
    await clickText(page, '.ppl-head .btn', 'Paste a list');
    await page.waitForSelector('#ppl-paste');
    await page.$eval('#ppl-paste', (t) => { t.value = 'Katherine Johnson: katherine@example.com\nDorothy Vaughan, dorothy@example.com\nScott Wierson: scott@example.com'; t.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(400);
    const sheet = await page.evaluate(() => {
      const m = document.querySelector('.modal.ppl-paste').getBoundingClientRect();
      const wide = [...document.querySelectorAll('.ppl-paste *')].filter((e) => e.getBoundingClientRect().right > m.right + 1).length;
      const who = Math.round(Math.min(...[...document.querySelectorAll('.ppl-paste__who')].map((e) => e.getBoundingClientRect().width)));
      const btns = [...document.querySelectorAll('.ppl-paste .btn')].filter((b) => b.getBoundingClientRect().height < 44).length;
      return { w: Math.round(m.width), wide, who, btns };
    });
    ok(!sheet.wide && sheet.who >= 300 && !sheet.btns, `the paste dialog on an iPad: rows use the width, 44px buttons (${JSON.stringify(sheet)})`);
    await shot(page, 'ipad-adv-paste', { grow: false });
    await clickText(page, '.ppl-paste .kd-dialog__foot .btn-primary', 'Add 2');
    await page.waitForFunction(() => !document.querySelector('.ppl-paste'), { timeout: 15000 });
    await page.waitForSelector('.ppl-row');
    await sleep(600);
    const f1 = await fits();
    const s1 = await small('.ppl-head .btn, .ppl-filter, .ppl-ready__tile, .ppl-menu__btn');
    ok(!f1.length && !s1.length, `the Advisory list fits an iPad, 44px targets (${f1.join(', ')}${s1.join(', ')})`);
    await shot(page, 'ipad-adv-list');
    await clickText(page, '.ppl-row__name', 'Katherine Johnson');
    await page.waitForSelector('#ppl-email');
    await sleep(700);
    const f2 = await fits();
    const clipped = await page.evaluate(() => [...document.querySelectorAll('.ppl-seg [role="radio"]')].filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent));
    ok(!f2.length && !clipped.length, `an advisor's editor fits an iPad, no choice cut off (${f2.join(', ')}${clipped.join(', ')})`);
    await shot(page, 'ipad-adv-editor');
    ok(!errors.length, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await page.close();
  }
  console.log('Advisory Board 390 (touch)');
  {
    const { page, errors } = await open(browser, { width: 390, height: 844, mobile: true });
    const fits = () => page.evaluate(() => { const main = document.querySelector('.main').getBoundingClientRect(); return [...document.querySelectorAll('.main *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > main.right + 1; }).map((e) => e.className || e.tagName).slice(0, 5); });
    const small = (sel) => page.$$eval(sel, (els) => els.filter((e) => e.getClientRects().length && e.getBoundingClientRect().height < 44).map((e) => e.textContent.trim().slice(0, 24)));
    if (true) { await page.evaluate(() => document.querySelector('.hamburger')?.click()); await sleep(350); }
    await clickText(page, '.nav-item', 'People');
    await page.waitForSelector('.hub-tabs');
    await clickText(page, '.hub-tab', 'Advisory');
    await page.waitForSelector('.ppl-empty-all');
    await sleep(500);
    const f1 = await fits();
    const s1 = await small('.ppl-head .btn, .ppl-empty-all .btn, .hub-tab');
    ok(!f1.length && !s1.length, `the empty Advisory tab fits a phone, 44px targets (${f1.join(', ')}${s1.join(', ')})`);
    await shot(page, 'phone-adv-empty');
    await clickText(page, '.ppl-empty-all .btn', 'Paste a list');
    await page.waitForSelector('#ppl-paste');
    await page.$eval('#ppl-paste', (t) => { t.value = 'Katherine Johnson: katherine.johnson.long.address@example-university.edu\nDorothy Vaughan, dorothy@example.com\nScott Wierson'; t.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(400);
    const sheet = await page.evaluate(() => {
      const m = document.querySelector('.modal.ppl-paste').getBoundingClientRect();
      const wide = [...document.querySelectorAll('.ppl-paste *')].filter((e) => e.getBoundingClientRect().right > m.right + 1).length;
      const field = parseFloat(getComputedStyle(document.querySelector('#ppl-paste')).fontSize);
      const btns = [...document.querySelectorAll('.ppl-paste .btn')].filter((b) => b.getBoundingClientRect().height < 44).length;
      const who = Math.round(Math.min(...[...document.querySelectorAll('.ppl-paste__who')].map((e) => e.getBoundingClientRect().width)));
      const nameLines = Math.round(document.querySelector('.ppl-paste__who strong').getBoundingClientRect().height / parseFloat(getComputedStyle(document.querySelector('.ppl-paste__who strong')).lineHeight || 20));
      return { w: Math.round(m.width), bottom: Math.round(m.bottom), wide, field, btns, who, nameLines };
    });
    ok(sheet.w <= 390 && sheet.bottom <= 845 && !sheet.wide && sheet.field >= 16 && !sheet.btns, `the paste sheet fits the phone, 16px field, 44px buttons (${JSON.stringify(sheet)})`);
    ok(sheet.who >= 220 && sheet.nameLines <= 1, `each pasted name gets the sheet's width, on one line (${sheet.who}px, ${sheet.nameLines} line)`);
    await shot(page, 'phone-adv-paste', { grow: false });
    await axeCheck(page, 'Paste a list on a phone');
    await clickText(page, '.ppl-paste .kd-dialog__foot .btn-primary', 'Add 2');
    await page.waitForFunction(() => !document.querySelector('.ppl-paste'), { timeout: 15000 });
    await page.waitForSelector('.ppl-row');
    await sleep(600);
    const f2 = await fits();
    ok(!f2.length, `the Advisory list fits the phone (${f2.join(', ')})`);
    await shot(page, 'phone-adv-list');
    await clickText(page, '.ppl-row__name', 'Katherine Johnson');
    await page.waitForSelector('#ppl-email');
    await sleep(700);
    const f3 = await fits();
    const clipped = await page.evaluate(() => [...document.querySelectorAll('.ppl-seg [role="radio"]')].filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent));
    ok(!f3.length && !clipped.length, `an advisor's editor fits the phone, no choice cut off (${f3.join(', ')}${clipped.join(', ')})`);
    ok(await page.$eval('#ppl-email', (i) => i.value === 'katherine.johnson.long.address@example-university.edu'), 'the editor shows the pasted email');
    await shot(page, 'phone-adv-editor');
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
    const cmteSmall = await page.$$eval('#ppl-committees .ppl-cmte', (bs) => bs.filter((b) => b.getBoundingClientRect().height < 44).length);
    ok(cmteSmall === 0 && (await page.$$('#ppl-committees .ppl-cmte')).length === 5, `committee badges are 44px tall (${cmteSmall} smaller)`);
    await page.evaluate(() => [...document.querySelectorAll('#ppl-committees .ppl-cmte')].find((b) => b.textContent.trim() === 'New committee').click());
    await page.waitForSelector('.ppl-cmte-new input');
    const newFit = await page.evaluate(() => { const main = document.querySelector('.main').getBoundingClientRect(); const i = document.querySelector('.ppl-cmte-new input'); const r = i.getBoundingClientRect(); return { fits: r.right <= main.right + 1, font: parseFloat(getComputedStyle(i).fontSize) }; });
    ok(newFit.fits && newFit.font >= 16, `the new committee field fits and won't zoom (${JSON.stringify(newFit)})`);
    await page.evaluate(() => [...document.querySelectorAll('.ppl-cmte-new .btn')].find((b) => b.textContent === 'Cancel').click());
    await shot(page, 'phone-editor');
    await page.waitForFunction(() => [...document.querySelectorAll('.ppl-photo__actions .btn')].some((b) => b.textContent.includes('Frame') && !b.disabled), { timeout: 15000 });
    await clickText(page, '.ppl-photo__actions .btn', 'Frame');
    await page.waitForSelector('.ppl-crop__stage');
    await sleep(800);
    const sheet = await page.$eval('.modal.ppl-crop', (m) => { const r = m.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, w: r.width }; });
    ok(sheet.w <= 390 && sheet.bottom <= 845, `the framing sheet fits the phone (${JSON.stringify(sheet)})`);
    await shot(page, 'phone-crop');
    await clickText(page, '.ppl-crop .btn', 'Cancel');
    await sleep(300);
    // The committees sheet on a phone
    await page.evaluate(() => document.querySelector('.breadcrumb button')?.click());
    await page.waitForSelector('.ppl-head');
    await clickText(page, '.ppl-head .btn', 'Committees');
    await page.waitForSelector('.ppl-cmte-list');
    await sleep(500);
    const cSheet = await page.evaluate(() => {
      const m = document.querySelector('.ppl-cmte-modal').getBoundingClientRect();
      const small = [...document.querySelectorAll('.ppl-cmte-modal .btn')].filter((b) => b.getBoundingClientRect().height < 44).length;
      const smallFields = [...document.querySelectorAll('.ppl-cmte-modal input')].filter((i) => parseFloat(getComputedStyle(i).fontSize) < 16).length;
      return { w: Math.round(m.width), bottom: Math.round(m.bottom), small, smallFields };
    });
    ok(cSheet.w <= 390 && cSheet.bottom <= 845 && cSheet.small === 0 && cSheet.smallFields === 0, `the committees sheet fits, with 44px buttons and 16px fields (${JSON.stringify(cSheet)})`);
    await shot(page, 'phone-committees', { grow: false });
    await clickText(page, '.ppl-cmte-modal .btn', 'Done');
    await sleep(300);
    // The Team tab and a team member's editor on a phone
    await page.waitForSelector('.hub-tabs');
    await clickText(page, '.hub-tab', 'Team');
    await page.waitForSelector('.ppl-row');
    await sleep(800);
    const teamFit = await page.evaluate(() => { const main = document.querySelector('.main').getBoundingClientRect(); return [...document.querySelectorAll('.main *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > main.right + 1; }).length; });
    ok(teamFit === 0, 'the Team tab fits the phone');
    await shot(page, 'phone-team');
    await clickText(page, '.ppl-row__name', 'Holly Ranney');
    await page.waitForSelector('#ppl-title');
    await sleep(800);
    const tedFit = await page.evaluate(() => { const main = document.querySelector('.main').getBoundingClientRect(); return [...document.querySelectorAll('.main *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > main.right + 1; }).length; });
    ok(tedFit === 0, 'a team member\'s editor fits the phone');
    const clipped = await page.evaluate(() => [...document.querySelectorAll('.ppl-seg [role="radio"]')].filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent));
    ok(!clipped.length, `no choice label is cut off (${clipped.join(', ')})`);
    await shot(page, 'phone-editor-team');

    // The new tools on a phone: readiness tiles, the review card, History, Photos
    const fits = () => page.evaluate(() => { const main = document.querySelector('.main').getBoundingClientRect(); return [...document.querySelectorAll('.main *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > main.right + 1; }).map((e) => e.className || e.tagName).slice(0, 5); });
    const smallTargets = (sel) => page.$$eval(sel, (els) => els.filter((e) => e.getClientRects().length && e.getBoundingClientRect().height < 44).map((e) => e.textContent.trim().slice(0, 30)));
    await page.evaluate(() => document.querySelector('.breadcrumb button')?.click());
    await page.waitForSelector('.hub-tabs');
    await clickText(page, '.hub-tab', 'Board');
    await page.waitForSelector('.ppl-ready__tile');
    await sleep(600);
    const cols = await page.$eval('.ppl-ready', (g) => getComputedStyle(g).gridTemplateColumns.split(' ').length);
    ok(cols === 2 && !(await fits()).length, `the readiness tiles sit two by two and fit (${cols} columns)`);
    await shot(page, 'phone-board-ready');
    await clickText(page, '.ppl-row__name', 'Jennifer Crosby');
    await page.waitForSelector('.ppl-sg');
    await sleep(800);
    const sgFit = await fits();
    const sgSmall = await smallTargets('.ppl-sg .btn, .ppl-ask .btn, .ppl-bio-tools .btn, .ppl-ed-meta .ppl-link');
    ok(!sgFit.length && !sgSmall.length, `the review card fits the phone, with 44px buttons (${sgFit.join(', ')}${sgSmall.join(', ')})`);
    await shot(page, 'phone-review');
    await clickText(page, '.ppl-ed-meta .ppl-link', 'History');
    await page.waitForSelector('.ppl-hist');
    await sleep(600);
    const hSheet = await page.$eval('.modal.ppl-hist', (m) => { const r = m.getBoundingClientRect(); return { w: Math.round(r.width), bottom: Math.round(r.bottom) }; });
    ok(hSheet.w <= 390 && hSheet.bottom <= 845, `History fits the phone (${JSON.stringify(hSheet)})`);
    await shot(page, 'phone-history', { grow: false });
    await page.keyboard.press('Escape');
    await sleep(300);
    await page.evaluate(() => document.querySelector('.breadcrumb button')?.click());
    await page.waitForSelector('.hub-tabs');
    await clickText(page, '.hub-tab', 'Photos');
    await page.waitForSelector('.ppl-pcard');
    await sleep(1000);
    const pcols = await page.$eval('.ppl-pgrid', (g) => getComputedStyle(g).gridTemplateColumns.split(' ').length);
    const pSmall = await smallTargets('.ppl-pcard .btn, .ppl-filter, .ppl-head .btn');
    ok(pcols === 2 && !(await fits()).length && !pSmall.length, `Photos: two columns that fit, 44px buttons (${pcols}; ${pSmall.join(', ')})`);
    await shot(page, 'phone-photos');
    await clickText(page, '.ppl-head .btn-primary', 'Remove backgrounds for everyone');
    await page.waitForSelector('.ppl-review-bar');
    await sleep(800);
    const rSmall = await smallTargets('.ppl-review-bar .btn, .ppl-pcard__pick');
    ok(!(await fits()).length && !rSmall.length, `the background preview fits, with 44px controls (${rSmall.join(', ')})`);
    await shot(page, 'phone-photos-review');
    await page.evaluate(() => window.scrollBy(0, 1600));
    await sleep(300);
    const stick = await page.evaluate(() => ({ bar: Math.round(document.querySelector('.ppl-review-bar').getBoundingClientRect().top), top: Math.round(document.querySelector('.mobile-bar').getBoundingClientRect().bottom) }));
    ok(stick.bar >= stick.top, `scrolled, the preview bar stays in view below the top bar (${JSON.stringify(stick)})`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await clickText(page, '.ppl-review-bar .btn', 'Cancel');
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
console.log(`  hover sweep: ${hoverSeen.size} kinds of control checked under the pointer`);
console.log(failures.length ? `\n${failures.length} failed:\n- ${failures.join('\n- ')}` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
