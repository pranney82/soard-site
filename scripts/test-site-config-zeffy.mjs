/**
 * test-site-config-zeffy.mjs — drive Admin → Site Config → Zeffy in a real browser
 * ===========================================================================
 * Every Zeffy link on the site in one place. Serves public/ from a local server and answers /api/read-content,
 * /api/save-content and /api/list-content with the REAL handlers on an in-memory D1 seeded with the site's settings,
 * a few kids and both events, so what's saved, the sha check and the audit rows are the real thing. Zeffy's form list
 * and the Advisory Board's route are stand-ins that record what they're sent.
 *
 * Covers, at 1440px and 390px, light and dark:
 *   - Zeffy is in Site Config's list; the four cards; the built-in forms; which kids and events are listed, in order
 *   - picking a form fills its link; one Save writes the settings' form, a kid's link (over someone's newer bio,
 *     which stays) and the Advisory campaign (with its ID); nothing else on a kid changes; audit rows
 *   - problems block Save (an empty or non-Zeffy giving form, a link without https://); Discard
 *   - someone else changed the same kid's link: the conflict sheet names the kid; keep mine
 *   - a kid that won't load can be retried and blocks nothing else; the Advisory Board for someone who doesn't run it
 *   - Donate's "Open Zeffy"; the ⌘K palette; phone: nothing wider than the screen, stacked controls
 * Screenshots in test-results/site-config-zeffy/. Exits non-zero on failure.
 *
 *   node scripts/test-site-config-zeffy.mjs
 */
import puppeteer from 'puppeteer';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import * as readContentApi from '../functions/api/read-content.js';
import * as saveContentApi from '../functions/api/save-content.js';
import * as historyApi from '../functions/api/content-history.js';
import { answerAsks } from './lib/ask.mjs';
import { SITE_FORMS } from '../public/admin/zeffy-links.js';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/site-config-zeffy/');
mkdirSync(OUT, { recursive: true });
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function section(name, fn) {
  console.log(name);
  try { await fn(); } catch (e) { failures.push(`${name}: crashed: ${e.message}`); console.error(`  ✗ crashed: ${e.stack || e.message}`); }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(ROOT, 'public', p);
  try { if ((await stat(f)).isDirectory()) f = join(f, 'index.html'); const b = await readFile(f); res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' }); return res.end(b); } catch { /* none */ }
  res.writeHead(404); res.end('not found');
}).listen(0, '127.0.0.1');
await new Promise((r) => server.on('listening', r));
const SITE = `http://127.0.0.1:${server.address().port}`;

// ── The server side, for real, on an in-memory D1 ──
const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
const env = { DB };
const USER = 'peter@soardcharity.com';
const callApi = async (mod, method, path, { body, user = USER } = {}) => {
  const request = new Request(`https://admin.test${path}`, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } });
  return mod[method]({ env, request, data: { userEmail: user }, waitUntil: () => {} });
};
const save = (path, content, user = 'seed@soardcharity.com') => callApi(saveContentApi, 'onRequestPost', '/api/save-content', { body: { path, content: JSON.stringify(content, null, 2), message: 'seed' }, user });

const settingsSeed = JSON.parse(readFileSync(join(ROOT, 'src/content/site/settings.json'), 'utf8'));
delete settingsSeed.zeffy;
await DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind('settings', JSON.stringify(settingsSeed), new Date().toISOString()).run();
for (const k of ['faq', 'financial-snapshot']) {
  const f = join(ROOT, `src/content/site/${k}.json`);
  if (existsSync(f)) await DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind(k, readFileSync(f, 'utf8'), new Date().toISOString()).run();
}
const kidFile = (slug) => (existsSync(join(ROOT, `src/content/kids/${slug}.json`)) ? JSON.parse(readFileSync(join(ROOT, `src/content/kids/${slug}.json`), 'utf8')) : { slug, name: slug[0].toUpperCase() + slug.slice(1), year: 2026, roomTypes: ['Bedroom'] });
const PETER_URL = 'https://www.zeffy.com/en-US/donation-form/help-build-peters-accessible-bathroom-and-dream-bedroom';
const KIDS = {
  peter: { ...kidFile('peter'), slug: 'peter', name: 'Peter', status: 'in-progress', publishStatus: 'published', fundraisingUrl: PETER_URL },
  jackson: { ...kidFile('jackson'), slug: 'jackson', name: 'Jackson', status: 'needs-funding', publishStatus: 'published', fundraisingUrl: 'https://www.zeffy.com/en-US/donation-form/help-build-jacksons-bedroom-therapy-room' },
  dex: { ...kidFile('dex'), slug: 'dex', name: 'Dex', status: 'completed', publishStatus: 'published', fundraisingUrl: 'https://www.zeffy.com/en-US/donation-form/help-build-dexs-dream-teenage-bedroom' },
  amari: { ...kidFile('amari'), slug: 'amari', name: 'Amari', status: 'completed', publishStatus: 'published', fundraisingUrl: null },
  wren: { slug: 'wren', name: 'Wren', status: 'in-progress', publishStatus: 'draft', year: 2026, roomTypes: ['Bathroom'], fundraisingUrl: null },
};
for (const [slug, k] of Object.entries(KIDS)) { const r = await save(`src/content/kids/${slug}.json`, k); if (!r.ok) throw new Error(`seed kid ${slug}: ${await r.text()}`); }
const EVENTS = {
  '2026-evening-of-sunshine': { ...JSON.parse(readFileSync(join(ROOT, 'src/content/events/2026-evening-of-sunshine.json'), 'utf8')) },
  'sunshine-on-a-ranney-fairway': { ...JSON.parse(readFileSync(join(ROOT, 'src/content/events/sunshine-on-a-ranney-fairway.json'), 'utf8')), ticketUrl: '' },
};
for (const [slug, e] of Object.entries(EVENTS)) { const r = await save(`src/content/events/${slug}.json`, e); if (!r.ok) throw new Error(`seed event ${slug}: ${await r.text()}`); }
const row = async (table, slug) => JSON.parse((await DB.prepare(`SELECT data FROM ${table} WHERE slug = ?`).bind(slug).first()).data);
const settingsNow = async () => JSON.parse((await DB.prepare("SELECT data FROM site_config WHERE key = 'settings'").first()).data);

// Zeffy's forms, as /api/zeffy-forms gives them
const NOW = Math.floor(Date.now() / 1000);
const FORMS = [
  { id: 'f-brighter', title: 'Help Build a Brighter Home', url: 'https://www.zeffy.com/donation-form/help-build-a-brighter-home', kind: 'donation', open: true, created: NOW - 9e6 },
  { id: 'f-monthly', title: 'SOARD Monthly Builders', url: 'https://www.zeffy.com/donation-form/soard-monthly-builders', kind: 'donation', open: true, created: NOW - 8e6 },
  { id: 'f-holiday', title: 'Holiday Giving 2026', url: 'https://www.zeffy.com/donation-form/holiday-giving-2026', kind: 'donation', open: true, created: NOW - 1e5 },
  { id: 'f-peter', title: 'Help build Peter’s accessible bathroom', url: 'https://www.zeffy.com/donation-form/help-build-peters-accessible-bathroom-and-dream-bedroom', kind: 'donation', open: true, created: NOW - 5e6 },
  { id: 'f-jackson', title: 'Help build Jackson’s room', url: 'https://www.zeffy.com/donation-form/help-build-jacksons-bedroom-therapy-room', kind: 'donation', open: true, created: NOW - 4e6 },
  { id: 'f-gala27', title: '2027 Evening of Sunshine', url: 'https://www.zeffy.com/ticketing/2027-evening-of-sunshine', kind: 'tickets', open: true, created: NOW - 2e5 },
  { id: 'f-advisory', title: 'Advisory Board 2026–27', url: 'https://www.zeffy.com/peer-to-peer/advisory-board-2026-27', kind: 'peer', open: true, created: NOW - 3e5 },
];
const state = { advisory: { campaignUrl: '', campaignId: '', hosted: { h1: { title: 'Wine night at the Atchleys', date: '2026-12-05', status: 'approved', giveUrl: '' } } }, advisoryRefused: false, advisoryPosts: [], failKid: null };

async function answer(req) {
  const url = new URL(req.url());
  const p = url.pathname;
  const json = (o, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(o) });
  if (p.startsWith('/cdn-cgi/')) return req.respond({ status: 404, body: '' });
  if (!p.startsWith('/api/')) return false;
  const real = async (mod, method) => {
    const request = new Request(`https://admin.test${p}${url.search}`, { method: req.method(), body: req.method() === 'POST' ? req.postData() : undefined, headers: { 'content-type': 'application/json' } });
    const res = await mod[method]({ env, request, data: { userEmail: USER }, waitUntil: () => {} });
    return req.respond({ status: res.status, contentType: 'application/json', body: Buffer.from(await res.arrayBuffer()) });
  };
  if (p === '/api/read-content') {
    if (state.failKid && url.searchParams.get('path') === `src/content/kids/${state.failKid}.json`) return json({ success: false, error: 'D1 is having a moment' }, 500);
    return real(readContentApi, 'onRequestGet');
  }
  if (p === '/api/save-content') return real(saveContentApi, 'onRequestPost');
  if (p === '/api/content-history') return real(historyApi, 'onRequestGet');
  if (p === '/api/list-content') {
    state.lists = (state.lists || 0) + 1;
    const dir = url.searchParams.get('dir') || '';
    const table = { 'src/content/kids': 'kids', 'src/content/events': 'events' }[dir];
    const rows = table ? ((await DB.prepare(`SELECT slug, data FROM ${table}`).all()).results || []) : [];
    const items = rows.map((r) => ({ name: `${r.slug}.json`, path: `${dir}/${r.slug}.json`, sha: r.slug, content: JSON.parse(r.data) }));
    return json({ success: true, items, count: items.length, total: items.length, pages: 1 });
  }
  if (p === '/api/zeffy-forms') return json({ success: true, forms: FORMS });
  if (p === '/api/advisory-admin') {
    if (state.advisoryRefused) return json({ ok: false, error: 'Only the people who run the Advisory Board can open this' }, 403);
    if (req.method() === 'GET' && url.searchParams.get('zeffyLinks')) return json({ ok: true, ...state.advisory });
    const body = JSON.parse(req.postData() || '{}');
    state.advisoryPosts.push(body);
    if (body.action === 'save-settings') {
      const s = body.settings || {};
      // As the real route: a listed address decides the ID
      const byUrl = FORMS.find((f) => f.url.replace('/en-US', '') === String(s.campaignUrl || '').replace('/en-US', ''));
      state.advisory.campaignUrl = s.campaignUrl;
      state.advisory.campaignId = s.campaignUrl ? (byUrl?.id || s.campaignId || '') : '';
      return json({ ok: true, settings: state.advisory });
    }
    if (body.action === 'hosted-status') { state.advisory.hosted[body.id].giveUrl = body.giveUrl; return json({ ok: true, hosted: state.advisory.hosted[body.id] }); }
    return json({ ok: false, error: 'unexpected' }, 400);
  }
  if (p.startsWith('/api/pending-changes')) return json({ success: true, changes: [], publish: { live: null, active: null, failed: null } });
  if (p.startsWith('/api/live-ws')) return req.abort();
  return json({ success: true, ok: true, items: [], list: [], entries: [] });
}

const browser = await puppeteer.launch({ headless: true, args: ['--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
async function open(width, height, hash) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: width < 500, hasTouch: width < 500 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|Content Security Policy|live-ws/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d) => { errors.push(`browser dialog: ${d.message()}`); d.accept(); });
  await answerAsks(page, { onAsk: () => {} });
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    if (req.isInterceptResolutionHandled()) return;
    try { if (new URL(req.url()).origin === SITE || /\/cdn-cgi\//.test(req.url())) { if ((await answer(req)) !== false) return; } req.continue(); }
    catch (e) { errors.push(`mock: ${e.message}`); req.continue().catch(() => {}); }
  });
  await page.goto(`${SITE}/admin/index.html${hash}`, { waitUntil: 'networkidle2' });
  return { page, errors };
}

const text = (page, sel) => page.$eval(sel, (e) => e.innerText).catch(() => '');
const clickText = (page, sel, re) => page.evaluate((s, src, flags) => {
  const r = new RegExp(src, flags);
  const el = [...document.querySelectorAll(s)].find((x) => x.offsetParent !== null && r.test(x.textContent.trim()));
  if (el) { el.click(); return true; }
  return false;
}, sel, re.source, re.flags);
/** The Zeffy field whose label starts with `name`, inside a card */
const field = (page, card, name) => page.evaluateHandle((c, n) => [...document.querySelectorAll(`#${c} .sc-field`)].find((f) => (f.querySelector('.sc-label')?.textContent || '').trim().startsWith(n)) || null, card, name);
const fieldInfo = (page, card, name) => page.evaluate((c, n) => {
  const f = [...document.querySelectorAll(`#${c} .sc-field`)].find((x) => (x.querySelector('.sc-label')?.textContent || '').trim().startsWith(n));
  if (!f) return null;
  const sel = f.querySelector('select');
  return { label: f.querySelector('.sc-label').textContent.trim(), value: f.querySelector('input')?.value ?? null, chosen: sel?.selectedOptions[0]?.textContent || '', under: f.querySelector('.sc-under')?.textContent.trim() || '', problem: f.querySelector('.sc-bad')?.textContent.trim() || '' };
}, card, name);
async function pick(page, card, name, formTitle) {
  const f = await field(page, card, name);
  const sel = await f.$('select');
  const id = await sel.evaluate((s, t) => [...s.options].find((o) => o.textContent.trim() === t)?.value || '', formTitle);
  if (!id) throw new Error(`no option “${formTitle}” in ${name}`);
  await sel.select(id);
  await sleep(80);
}
async function type(page, card, name, value) {
  const input = await (await field(page, card, name)).$('input');
  await input.click({ clickCount: 3 });
  await input.evaluate((el) => el.select());
  await page.keyboard.press('Backspace');
  if (value) await input.type(value);
  await sleep(60);
}
const barState = (page) => text(page, '.sc-bar-state');
const saveDisabled = (page) => page.$eval('.sc-bar-actions .btn-primary', (b) => b.disabled);
const saveNow = async (page) => {
  await clickText(page, '.sc-bar-actions button', /^Save$/);
  await page.waitForFunction(() => !/Saving/.test(document.querySelector('.sc-bar-state')?.textContent || ''), { timeout: 10000 }).catch(() => {});
  await sleep(250);
};
const ready = async (page) => {
  try {
    await page.waitForFunction(() => document.querySelectorAll('#sc-zeffy-kids .zf-link').length >= 4 && document.querySelectorAll('#sc-zeffy-events .zf-link').length >= 2 && !document.querySelector('.sc-page .spinner') && [...document.querySelectorAll('.sc-page .zf-select')].every((s) => !s.disabled), { timeout: 15000 });
  } catch (e) {
    console.log('  (not ready:', JSON.stringify(await page.evaluate(() => ({ hash: location.hash, bar: document.querySelector('.sc-bar h2')?.textContent, kids: document.querySelectorAll('#sc-zeffy-kids .zf-link').length, events: document.querySelectorAll('#sc-zeffy-events .zf-link').length, spin: !!document.querySelector('.sc-page .spinner'), off: [...document.querySelectorAll('.sc-page .zf-select')].filter((s) => s.disabled).map((s) => s.getAttribute('aria-label')), text: document.querySelector('.sc-main')?.innerText.slice(0, 300) }))), ')');
    throw e;
  }
};
async function shot(page, name, maxH = 3600) {
  const vp = page.viewport();
  const h = Math.min(maxH, await page.evaluate(() => document.documentElement.scrollHeight));
  await page.setViewport({ ...vp, height: Math.max(vp.height, h) });
  await sleep(250);
  await page.screenshot({ path: join(OUT, name) });
  await page.setViewport(vp);
}
const DARK = `:root[data-theme="dark"]{color-scheme:dark;--color-bg:#141518;--color-bg-card:#1C1D21;--color-bg-secondary:#222327;--color-bg-hover:#2A2B30;--color-text:#ECECEF;--color-text-secondary:#B9BAC1;--color-text-muted:#9C9DA5;--color-border:#303137;--color-border-strong:#45464D}:root[data-theme="dark"] body{background:var(--color-bg);color:var(--color-text)}`;

let main;
try {
  main = await open(1440, 1000, '#site/zeffy');
  const { page, errors } = main;

  await section('Zeffy is a Site Config page, with every link on the site', async () => {
    await page.waitForSelector('.sc-page', { timeout: 20000 });
    await ready(page);
    ok((await text(page, '.sc-bar h2')) === 'Zeffy', 'the page opens on #site/zeffy');
    const across = await page.$$eval('.sc-rail-group', (hs) => hs.map((h) => [h.textContent, [...h.nextElementSibling.querySelectorAll('.sc-rail-title')].map((t) => t.textContent.trim())]));
    ok(across.some(([g, t]) => /Across the site/.test(g) && t.includes('Zeffy')), 'it’s listed under Across the site');
    ok(JSON.stringify(await page.$$eval('.sc-page .sc-card h3', (hs) => hs.map((h) => h.textContent))) === '["Giving","Kids","Events","Advisory Board"]', 'four cards: Giving, Kids, Events, Advisory Board');
    for (const [label, key] of [['Donate page: one-time gifts', 'donateUrl'], ['Donate page: monthly gifts', 'monthlyUrl'], ['Live reveal: Fund the next room', 'liveUrl']]) {
      const f = await fieldInfo(page, 'sc-zeffy-giving', label);
      ok(f?.value === SITE_FORMS[key], `${label}: the form the page uses now (${f?.value})`);
      ok(f?.chosen && f.chosen !== 'Choose a Zeffy form', `${label}: its form is chosen in the dropdown (${f?.chosen})`);
    }
    const kids = await page.$$eval('#sc-zeffy-kids .sc-label', (ls) => ls.map((l) => l.textContent.replace(/\s+/g, ' ').trim()));
    ok(JSON.stringify(kids) === JSON.stringify(['Jackson Awaiting funding', 'Peter In build', 'Wren In build Page hidden', 'Dex Completed']), `kids awaiting funding, in build, then any other kid with a link (${kids.join(' | ')})`);
    ok((await fieldInfo(page, 'sc-zeffy-kids', 'Peter'))?.chosen === 'Help build Peter’s accessible bathroom', 'Peter’s form is chosen (a link with /en-US/ finds the form Zeffy lists without it)');
    ok(/no Give button/.test((await fieldInfo(page, 'sc-zeffy-kids', 'Wren'))?.under || ''), 'a kid with no link says what that means');
    const evs = await page.$$eval('#sc-zeffy-events .sc-label', (ls) => ls.map((l) => l.textContent.replace(/\s+/g, ' ').trim()));
    ok(/Evening of Sunshine/.test(evs[0]) && /Fairway/.test(evs[1]), `events newest first (${evs.join(' | ')})`);
    const golf = await fieldInfo(page, 'sc-zeffy-events', 'Sunshine on a Ranney Fairway');
    ok(golf?.value === '' && /^No link: \/events\/golf\/ and its card on the events list have no ticket button/.test(golf.under), `a blank golf link says what that means (${golf?.under})`);
    const adv = await fieldInfo(page, 'sc-zeffy-advisory', 'The group’s campaign');
    ok(adv?.value === '' && /Not connected/.test(adv.under), 'the Advisory Board’s campaign: not connected yet');
    ok(!!(await fieldInfo(page, 'sc-zeffy-advisory', 'Wine night at the Atchleys')), 'an approved fundraiser’s Zeffy page is here too');
    ok(/Everything is saved/.test(await barState(page)), 'nothing unsaved to start');
    await shot(page, '01-zeffy.png');
  });

  await section('Pick, type, one Save: settings, a kid and the Advisory Board, over someone’s newer edit', async () => {
    const peterBefore = await row('kids', 'peter');
    await pick(page, 'sc-zeffy-giving', 'Donate page: one-time gifts', 'Holiday Giving 2026');
    ok((await fieldInfo(page, 'sc-zeffy-giving', 'Donate page: one-time gifts')).value === 'https://www.zeffy.com/donation-form/holiday-giving-2026', 'picking a form fills its link');
    ok(/Unsaved changes here/.test(await barState(page)), 'the bar says unsaved');
    ok(await page.$eval('.sc-rail a[href="#site/zeffy"] .sc-dirty', () => true).catch(() => false), 'Zeffy gets an unsaved dot');
    await type(page, 'sc-zeffy-kids', 'Peter', 'https://www.zeffy.com/en-US/donation-form/peters-new-form');
    ok((await fieldInfo(page, 'sc-zeffy-kids', 'Peter')).chosen === 'Choose a Zeffy form', 'a pasted link no form matches leaves the dropdown unchosen');
    await pick(page, 'sc-zeffy-advisory', 'The group’s campaign', 'Advisory Board 2026–27');
    await pick(page, 'sc-zeffy-advisory', 'Wine night at the Atchleys', 'Holiday Giving 2026');
    // Meanwhile someone saves Peter's bio in the Kids editor
    await save('src/content/kids/peter.json', { ...peterBefore, bio: '<p>Someone else’s newer bio.</p>' }, 'holly@soardcharity.com');
    await saveNow(page);
    ok(/saved/i.test(await barState(page)) && !/Unsaved/.test(await barState(page)), `saved (${await barState(page)})`);
    const st = await settingsNow();
    ok(st.zeffy?.donateUrl === 'https://www.zeffy.com/donation-form/holiday-giving-2026' && !('monthlyUrl' in st.zeffy), 'settings.zeffy has the one-time form, and only what was changed');
    const { zeffy, ...rest } = st;
    ok(JSON.stringify(rest) === JSON.stringify(settingsSeed), 'every other setting is as it was');
    const peter = await row('kids', 'peter');
    ok(peter.fundraisingUrl === 'https://www.zeffy.com/en-US/donation-form/peters-new-form', 'Peter’s link is saved');
    ok(peter.bio === '<p>Someone else’s newer bio.</p>', 'the bio someone saved meanwhile stays');
    const { fundraisingUrl: _a, bio: _b, ...peterRest } = peter;
    const { fundraisingUrl: _c, bio: _d, ...beforeRest } = peterBefore;
    ok(JSON.stringify(peterRest) === JSON.stringify(beforeRest), 'nothing else on Peter changed');
    ok(JSON.stringify(await row('kids', 'jackson')) === JSON.stringify(KIDS.jackson), 'a kid nobody touched isn’t saved');
    const audit = await DB.prepare("SELECT entity_type, entity_slug, user_email FROM audit_log WHERE entity_slug IN ('peter', 'settings') AND user_email = ? ORDER BY id").bind(USER).all();
    ok((audit.results || []).length === 2, `an audit row each for the settings and Peter (${JSON.stringify(audit.results)})`);
    const camp = state.advisoryPosts.find((x) => x.action === 'save-settings');
    ok(camp && camp.settings.campaignUrl === 'https://www.zeffy.com/peer-to-peer/advisory-board-2026-27' && camp.settings.campaignId === 'f-advisory' && Object.keys(camp.settings).length === 2, `the campaign went to the Advisory Board’s route with its ID, and nothing else (${JSON.stringify(camp)})`);
    const host = state.advisoryPosts.find((x) => x.action === 'hosted-status');
    ok(host && host.id === 'h1' && host.status === 'approved' && host.giveUrl === 'https://www.zeffy.com/donation-form/holiday-giving-2026', 'the fundraiser’s page went with its status unchanged');
    ok(/^Connected/.test((await fieldInfo(page, 'sc-zeffy-advisory', 'The group’s campaign')).under), 'the campaign now says Connected');
    ok(/Unsaved/.test(await barState(page)) === false && /Everything is saved|publish/i.test(await barState(page)), 'nothing left unsaved');
  });

  await section('Problems block Save; Discard', async () => {
    await type(page, 'sc-zeffy-giving', 'Donate page: monthly gifts', '');
    ok((await fieldInfo(page, 'sc-zeffy-giving', 'Donate page: monthly gifts')).problem === 'Pick a Zeffy form', 'an empty giving form must be picked');
    ok(await saveDisabled(page), 'Save is blocked');
    ok(/Fix “Donate page: monthly gifts”/.test(await barState(page)), `the bar says what to fix (${await barState(page)})`);
    await type(page, 'sc-zeffy-giving', 'Donate page: monthly gifts', 'https://example.org/give');
    ok(/Zeffy form’s link/.test((await fieldInfo(page, 'sc-zeffy-giving', 'Donate page: monthly gifts')).problem), 'a link that isn’t a Zeffy form won’t do for the Donate page');
    await type(page, 'sc-zeffy-events', 'Sunshine on a Ranney Fairway', 'www.zeffy.com/ticketing/golf-2027');
    ok(/https:\/\//.test((await fieldInfo(page, 'sc-zeffy-events', 'Sunshine on a Ranney Fairway')).problem), 'a link without https:// is explained');
    await clickText(page, '.sc-bar-actions button', /^Discard$/);
    await sleep(150);
    ok((await fieldInfo(page, 'sc-zeffy-giving', 'Donate page: monthly gifts')).value === SITE_FORMS.monthlyUrl && (await fieldInfo(page, 'sc-zeffy-events', 'Sunshine on a Ranney Fairway')).value === '', 'Discard puts both back');
    ok(!(await saveDisabled(page)) || /Everything is saved|publish/i.test(await barState(page)), 'nothing to fix after Discard');
    // Clearing a link that was empty isn't a change
    await type(page, 'sc-zeffy-kids', 'Wren', 'x');
    await type(page, 'sc-zeffy-kids', 'Wren', '');
    ok(!/Unsaved/.test(await barState(page)), 'typing into an empty link and clearing it leaves nothing unsaved');
  });

  await section('Someone changed the same link meanwhile: the conflict sheet names the kid', async () => {
    await pick(page, 'sc-zeffy-kids', 'Jackson', 'Holiday Giving 2026');
    await save('src/content/kids/jackson.json', { ...KIDS.jackson, fundraisingUrl: 'https://www.zeffy.com/donation-form/someone-elses' }, 'holly@soardcharity.com');
    await clickText(page, '.sc-bar-actions button', /^Save$/);
    await page.waitForSelector('.sc-dialog', { timeout: 8000 });
    const sheet = await text(page, '.sc-dialog');
    ok(/Zeffy: Jackson, Fundraising link/.test(sheet), `the sheet names Jackson’s fundraising link (${sheet.split('\n').slice(0, 4).join(' / ')})`);
    await clickText(page, '.sc-dialog-foot button', /^Save with these$/);
    await page.waitForFunction(() => !document.querySelector('.sc-dialog'), { timeout: 8000 });
    await sleep(400);
    ok((await row('kids', 'jackson')).fundraisingUrl === 'https://www.zeffy.com/donation-form/holiday-giving-2026', 'keep mine: my pick is saved');
  });

  await section('The admin’s own lists follow a saved link, without reloading them', async () => {
    const lists = () => state.lists;
    state.lists = 0;
    await type(page, 'sc-zeffy-kids', 'Jackson', '');
    await saveNow(page);
    ok((await row('kids', 'jackson')).fundraisingUrl === null, 'Jackson’s link is cleared the way the Kids editor clears it (null)');
    ok(!!(await fieldInfo(page, 'sc-zeffy-kids', 'Jackson')), 'Jackson’s row stays after clearing');
    await page.evaluate(() => { location.hash = ''; });
    await page.waitForSelector('.dash-families', { timeout: 10000 });
    const chip = await page.$eval('.dash-families', (el) => [...el.querySelectorAll('li, .dkid, a, div')].some((x) => /Jackson/.test(x.textContent) && /No giving link/.test(x.textContent))).catch(() => false);
    ok(chip, 'the Dashboard shows Jackson has no giving link straight away');
    ok(lists() === 0, `no list was reloaded to get there (${lists()} list reads)`);
    await page.evaluate(() => { location.hash = '#site/zeffy'; });
    await page.waitForFunction(() => document.querySelector('.sc-bar h2')?.textContent === 'Zeffy', { timeout: 8000 });
    await ready(page);
  });

  await section('Donate points here; the palette finds it', async () => {
    await page.evaluate(() => { location.hash = '#site/donate'; });
    await page.waitForFunction(() => document.querySelector('.sc-bar h2')?.textContent === 'Donate', { timeout: 8000 });
    await page.waitForSelector('.sc-page .sc-card', { timeout: 8000 });
    ok(await clickText(page, '.sc-page button', /^Open Zeffy$/), 'Donate has Open Zeffy');
    await page.waitForFunction(() => document.querySelector('.sc-bar h2')?.textContent === 'Zeffy', { timeout: 8000 });
    ok(true, 'it opens the Zeffy page');
    await page.keyboard.down('Meta'); await page.keyboard.press('k'); await page.keyboard.up('Meta');
    await page.waitForSelector('.cmd-palette-input', { timeout: 5000 });
    await page.type('.cmd-palette-input', 'zeffy');
    await sleep(250);
    const hit = await page.evaluate(() => [...document.querySelectorAll('.cmd-palette-item')].some((e) => /Zeffy links/.test(e.textContent)));
    ok(hit, 'the ⌘K palette finds “Zeffy links”');
    await page.keyboard.press('Escape');
  });

  ok(!errors.length, `no page errors (${errors.slice(0, 3).join(' | ')})`);
  await page.close();

  await section('A kid that won’t load; someone who doesn’t run the Advisory Board', async () => {
    state.failKid = 'dex';
    state.advisoryRefused = true;
    const { page: p2, errors: e2 } = await open(1440, 1000, '#site/zeffy');
    await p2.waitForSelector('#sc-zeffy-kids', { timeout: 20000 });
    await p2.waitForFunction(() => /Couldn’t load it/.test(document.querySelector('#sc-zeffy-kids')?.textContent || '') && /Only the people who run/.test(document.querySelector('#sc-zeffy-advisory')?.textContent || ''), { timeout: 15000 });
    ok(true, 'Dex says it couldn’t load, with Try again; the Advisory Board says who can change it');
    await p2.waitForFunction(() => [...document.querySelectorAll('#sc-zeffy-kids .zf-select')].every((s) => !s.disabled) && document.querySelectorAll('#sc-zeffy-kids .zf-select').length >= 3, { timeout: 15000 });
    await pick(p2, 'sc-zeffy-kids', 'Wren', 'Holiday Giving 2026');
    await saveNow(p2);
    ok((await row('kids', 'wren')).fundraisingUrl === 'https://www.zeffy.com/donation-form/holiday-giving-2026' && !/Unsaved/.test(await barState(p2)), 'the rest still saves');
    state.failKid = null;
    await clickText(p2, '#sc-zeffy-kids .sc-link', /^Try again$/);
    await p2.waitForFunction(() => !/Couldn’t load it/.test(document.querySelector('#sc-zeffy-kids')?.textContent || ''), { timeout: 8000 }).catch(() => {});
    ok(!!(await fieldInfo(p2, 'sc-zeffy-kids', 'Dex'))?.value, 'Try again loads Dex');
    ok(!e2.length, `no page errors (${e2.slice(0, 3).join(' | ')})`);
    state.advisoryRefused = false;
    await shot(p2, '02-refused-and-retry.png', 2400);
    await p2.close();
  });

  await section('Phone and dark', async () => {
    const { page: ph, errors: e3 } = await open(390, 844, '#site/zeffy');
    await ph.waitForSelector('.sc-page', { timeout: 20000 });
    await ready(ph);
    const wide = await ph.evaluate(() => [...document.querySelectorAll('.sc-page *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1).map((el) => el.className || el.tagName).slice(0, 5));
    ok(!wide.length, `nothing wider than the screen (${wide.join(', ')})`);
    const stacked = await ph.$eval('#sc-zeffy-giving .zf-link', (g) => { const [a, b] = g.children; return a.getBoundingClientRect().bottom <= b.getBoundingClientRect().top + 1; });
    ok(stacked, 'the dropdown sits above the link on a phone');
    const small = await ph.$$eval('.sc-page input, .sc-page select', (els) => els.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 16).length);
    ok(!small, 'inputs are 16px (no zoom on iPhone)');
    await shot(ph, '03-phone.png', 5000);
    await ph.setViewport({ width: 1440, height: 1000 });
    await ph.evaluate((css) => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); document.documentElement.dataset.theme = 'dark'; }, DARK);
    await sleep(200);
    await shot(ph, '04-dark.png');
    ok(!e3.length, `no page errors (${e3.slice(0, 3).join(' | ')})`);
    await ph.close();
  });
} finally {
  await browser.close();
  server.close();
}

console.log(failures.length ? `\n${failures.length} failed:\n- ${failures.join('\n- ')}` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
