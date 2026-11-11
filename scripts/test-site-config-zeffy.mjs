/**
 * test-site-config-zeffy.mjs — drive Admin → Site Config → Zeffy in a real browser
 * ===========================================================================
 * The site's donation forms, each upcoming event's tickets and the Advisory Board's campaign in one place (a kid's
 * fundraising link stays on their page in Kids). Serves public/ and answers /api/read-content, /api/save-content,
 * /api/content-history and /api/list-content with the REAL handlers on an in-memory D1 seeded with the site's settings
 * and four events, so what's saved, the sha check, audit rows and history are the real thing. Zeffy's form list and
 * the Advisory Board's route are stand-ins that record what they're sent, in order.
 *
 * Covers, at 1440px and 390px, light and dark:
 *   - every link is picked from SOARD's Zeffy forms (no box to paste into); three cards and the way to a kid's link;
 *     Giving takes only donation forms, all three required (the monthly one missing, as live data had it, blocks Save
 *     until it's picked); "takes gifts from a donor-advised fund" turns off when the one-time form changes; upcoming
 *     events only, soonest first, each saying where its link shows; a saved form Zeffy no longer has is pointed out
 *   - one Save: the Advisory Board's links first (a refusal there writes nothing else), then settings and events'
 *     links over someone's newer words; a fundraiser's page by its own action; Publish asked about only for the site
 *   - an event selling on another site: its box, https:// put on, problems in the words Save uses; back to Zeffy
 *   - conflicts: an event's link names the event; the campaign is one choice, a fundraiser is named
 *   - History lists an event's link and puts it back; an event deleted meanwhile; events that didn't load or none
 *     upcoming; the Advisory Board for someone who doesn't run it (the server's words)
 *   - Donate's "Open Zeffy", the Kids link keeps Back working, ⌘K; phone: nothing wider than the screen; dark
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
// As live data was on Nov 10 2026: the one-time and live forms saved, the monthly one never saved
const BRIGHTER = 'https://www.zeffy.com/donation-form/a-brighter-day-starts-with-you';
// The live reveal's form has since been closed in Zeffy (a warning, never a block)
const OLD_SPRING = 'https://www.zeffy.com/donation-form/old-spring-appeal';
settingsSeed.zeffy = { donateUrl: BRIGHTER, liveUrl: OLD_SPRING, daf: true };
await DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind('settings', JSON.stringify(settingsSeed), new Date().toISOString()).run();
for (const k of ['faq', 'financial-snapshot']) {
  const f = join(ROOT, `src/content/site/${k}.json`);
  if (existsSync(f)) await DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind(k, readFileSync(f, 'utf8'), new Date().toISOString()).run();
}
// A kid with a link, so the Kids area the Zeffy page points to has someone in it
const kidFile = (slug) => (existsSync(join(ROOT, `src/content/kids/${slug}.json`)) ? JSON.parse(readFileSync(join(ROOT, `src/content/kids/${slug}.json`), 'utf8')) : { slug, name: slug[0].toUpperCase() + slug.slice(1), year: 2026, roomTypes: ['Bedroom'] });
const KIDS = { peter: { ...kidFile('peter'), slug: 'peter', name: 'Peter', status: 'in-progress', publishStatus: 'published', fundraisingUrl: 'https://www.zeffy.com/en-US/donation-form/help-build-peters-accessible-bathroom-and-dream-bedroom' } };
for (const [slug, k] of Object.entries(KIDS)) { const r = await save(`src/content/kids/${slug}.json`, k); if (!r.ok) throw new Error(`seed kid ${slug}: ${await r.text()}`); }
const iso = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
const GALA = '2027-evening-of-sunshine';
const GOLF = 'sunshine-on-a-ranney-fairway-2027';
const SWAP = 'cookie-swap';
const PAST = '2026-evening-of-sunshine';
const galaFile = JSON.parse(readFileSync(join(ROOT, 'src/content/events/2026-evening-of-sunshine.json'), 'utf8'));
const EVENTS = {
  [GALA]: { ...galaFile, slug: GALA, title: '2027 Evening of Sunshine', date: iso(280), endDate: undefined, ticketUrl: 'https://www.zeffy.com/en-US/ticketing/2027-evening-of-sunshine' },
  [GOLF]: { slug: GOLF, title: 'Sunshine on a Ranney Fairway 2027', date: iso(190), time: '8:00 AM', location: 'Indian Hills Country Club', description: 'Golf for good.', ticketUrl: '' },
  // An event with no page of its own: only its card on the events list
  [SWAP]: { slug: SWAP, title: 'Cookie Swap', date: iso(32), time: '2:00 PM', location: 'The SOARD shop', description: 'Bring a dozen, take a dozen.', ticketUrl: '' },
  // Over: its page is the recap, so it isn't listed
  [PAST]: { ...galaFile, slug: PAST, date: iso(-80), endDate: undefined },
};
for (const [slug, e] of Object.entries(EVENTS)) { const r = await save(`src/content/events/${slug}.json`, e); if (!r.ok) throw new Error(`seed event ${slug}: ${await r.text()}`); }
const row = async (table, slug) => JSON.parse((await DB.prepare(`SELECT data FROM ${table} WHERE slug = ?`).bind(slug).first()).data);
const settingsNow = async () => JSON.parse((await DB.prepare("SELECT data FROM site_config WHERE key = 'settings'").first()).data);

// Zeffy's forms, as /api/zeffy-forms gives them
const NOW = Math.floor(Date.now() / 1000);
const FORMS = [
  { id: 'f-brighter', title: 'Help Build a Brighter Home', url: 'https://www.zeffy.com/donation-form/help-build-a-brighter-home', kind: 'donation', open: true, created: NOW - 9e6 },
  { id: 'f-brighter-day', title: 'A Brighter Day Starts With You', url: BRIGHTER, kind: 'donation', open: true, created: NOW - 2e6 },
  { id: 'f-old-spring', title: 'Old Spring Appeal', url: OLD_SPRING, kind: 'donation', open: false, created: NOW - 9e6 },
  { id: 'f-monthly', title: 'SOARD Monthly Builders', url: 'https://www.zeffy.com/donation-form/soard-monthly-builders', kind: 'donation', open: true, created: NOW - 8e6 },
  { id: 'f-holiday', title: 'Holiday Giving 2026', url: 'https://www.zeffy.com/donation-form/holiday-giving-2026', kind: 'donation', open: true, created: NOW - 1e5 },
  { id: 'f-gala27', title: '2027 Evening of Sunshine', url: 'https://www.zeffy.com/ticketing/2027-evening-of-sunshine', kind: 'tickets', open: true, created: NOW - 2e5 },
  { id: 'f-golf27', title: 'Sunshine on a Ranney Fairway 2027', url: 'https://www.zeffy.com/ticketing/fairway-2027', kind: 'tickets', open: true, created: NOW - 1e5 },
  { id: 'f-advisory', title: 'Advisory Board 2026–27', url: 'https://www.zeffy.com/peer-to-peer/advisory-board-2026-27', kind: 'peer', open: true, created: NOW - 3e5 },
  { id: 'f-spring', title: 'Spring Peer Drive', url: 'https://www.zeffy.com/peer-to-peer/spring-peer-drive', kind: 'peer', open: true, created: NOW - 4e5 },
];
const state = { advisory: { campaignUrl: '', campaignId: '', hosted: { h1: { title: 'Wine night at the Atchleys', date: '2026-12-05', status: 'approved', giveUrl: '' }, h2: { title: 'Golf scramble', date: '2027-04-10', status: 'approved', giveUrl: 'https://www.zeffy.com/peer-to-peer/deleted-drive' } } }, advisoryRefused: false, advisoryPosts: [], failEvent: null, failEventsList: false, onlyPast: false, calls: [] };

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
  if (req.method() === 'POST') state.calls.push(p);
  if (p === '/api/read-content') {
    if (state.failEvent && url.searchParams.get('path') === `src/content/events/${state.failEvent}.json`) return json({ success: false, error: 'D1 is having a moment' }, 500);
    return real(readContentApi, 'onRequestGet');
  }
  if (p === '/api/save-content') return real(saveContentApi, 'onRequestPost');
  if (p === '/api/content-history') return real(historyApi, 'onRequestGet');
  if (p === '/api/list-content') {
    const dir = url.searchParams.get('dir') || '';
    if (dir === 'src/content/events' && state.failEventsList) return json({ success: false, error: 'D1 is having a moment' }, 500);
    const table = { 'src/content/kids': 'kids', 'src/content/events': 'events' }[dir];
    const rows = (table ? ((await DB.prepare(`SELECT slug, data FROM ${table}`).all()).results || []) : []).filter((r) => !(state.onlyPast && table === 'events' && r.slug !== PAST));
    const items = rows.map((r) => ({ name: `${r.slug}.json`, path: `${dir}/${r.slug}.json`, sha: r.slug, content: JSON.parse(r.data) }));
    return json({ success: true, items, count: items.length, total: items.length, pages: 1 });
  }
  if (p === '/api/zeffy-forms') {
    if (state.formsFail) return json({ success: false, error: 'Zeffy didn’t answer' }, 503);
    if (state.formsDelay) await sleep(state.formsDelay);
    return json({ success: true, forms: FORMS });
  }
  if (p === '/api/advisory-admin') {
    if (state.advisoryRefused) return json({ ok: false, error: 'Only the people who run the Advisory Board can open this' }, 403);
    if (req.method() === 'GET' && url.searchParams.get('zeffyLinks')) return json({ ok: true, ...state.advisory });
    const body = JSON.parse(req.postData() || '{}');
    state.advisoryPosts.push(body);
    if (body.action === 'save-settings') {
      const s = body.settings || {};
      // As the real route: a listed address decides the ID
      if (/example\.org/.test(s.campaignUrl || '')) return json({ ok: false, error: 'That address isn’t a campaign in SOARD’s Zeffy. Check the link and try again.' }, 400);
      const byUrl = FORMS.find((f) => f.url.replace('/en-US', '') === String(s.campaignUrl || '').replace('/en-US', ''));
      state.advisory.campaignUrl = s.campaignUrl;
      state.advisory.campaignId = s.campaignUrl ? (byUrl?.id || s.campaignId || '') : '';
      return json({ ok: true, settings: state.advisory });
    }
    if (body.action === 'hosted-link') { state.advisory.hosted[body.id].giveUrl = body.giveUrl; return json({ ok: true, hosted: state.advisory.hosted[body.id] }); }
    return json({ ok: false, error: 'unexpected' }, 400);
  }
  if (p.startsWith('/api/pending-changes')) return json({ success: true, changes: [], publish: { live: null, active: null, failed: null } });
  if (p.startsWith('/api/live-ws')) return req.abort();
  return json({ success: true, ok: true, items: [], list: [], entries: [] });
}

const browser = await puppeteer.launch({ headless: 'shell', protocolTimeout: 120000, args: ['--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
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
  const input = f.querySelector('.zf-link input');
  const ctl = input || sel;
  // The saved link: the box's while another site's shows, else the one behind Open (the picked form's)
  return { label: f.querySelector('.sc-label').textContent.trim(), value: input ? input.value : (f.querySelector('a.zf-link__open')?.getAttribute('href') || ''), box: !!input, chosen: sel?.selectedOptions[0]?.textContent || '', options: sel ? [...sel.options].map((o) => o.textContent.trim()) : [],
    under: f.querySelector('.sc-under')?.textContent.trim() || '', problem: f.querySelector('.zf-link__bad, .sc-bad')?.textContent.trim() || '', warning: f.querySelector('.zf-link__warn')?.textContent.trim() || '', switchText: f.querySelector('.zf-link__switch')?.textContent.trim() || '',
    describedBy: ctl?.getAttribute('aria-describedby') || '', boxWidth: ctl ? Math.round(ctl.getBoundingClientRect().width) : 0 };
}, card, name);
async function pick(page, card, name, formTitle) {
  const f = await field(page, card, name);
  const sel = await f.$('select');
  const id = await sel.evaluate((s, t) => [...s.options].find((o) => o.textContent.trim() === t)?.value || '', formTitle);
  if (!id) throw new Error(`no option “${formTitle}” in ${name}`);
  await sel.select(id);
  await sleep(80);
}
/** An event's switch between a Zeffy form and another site */
async function flip(page, card, name) {
  await (await (await field(page, card, name)).$('.zf-link__switch')).click();
  await sleep(80);
}
async function type(page, card, name, value) {
  const input = await (await field(page, card, name)).$('input');
  await input.click({ clickCount: 3 });
  await input.evaluate((el) => el.select());
  await page.keyboard.press('Backspace');
  if (value) await input.type(value);
  // Leaving the box is when the field says what's wrong, and puts https:// on
  await input.evaluate((el) => el.blur());
  await sleep(80);
}
const barState = (page) => text(page, '.sc-bar-state');
const saveDisabled = (page) => page.$eval('.sc-bar-actions .btn-primary', (b) => b.disabled);
const saveNow = async (page) => {
  await clickText(page, '.sc-bar-actions button', /^Save$/);
  await page.waitForFunction(() => !/Saving/.test(document.querySelector('.sc-bar-state')?.textContent || ''), { timeout: 10000 }).catch(() => {});
  await sleep(250);
};
const ready = async (page, n = 3) => {
  try {
    await page.waitForFunction((n) => document.querySelectorAll('#sc-zeffy-events .zf-link').length >= n && document.querySelector('#sc-zeffy-advisory .zf-link') && !document.querySelector('.sc-page .spinner') && [...document.querySelectorAll('.sc-page .zf-select')].every((s) => !s.disabled), { timeout: 15000 }, n);
  } catch (e) {
    console.log('  (not ready:', JSON.stringify(await page.evaluate(() => ({ hash: location.hash, bar: document.querySelector('.sc-bar h2')?.textContent, events: document.querySelectorAll('#sc-zeffy-events .zf-link').length, spin: !!document.querySelector('.sc-page .spinner'), off: [...document.querySelectorAll('.sc-page .zf-select')].filter((s) => s.disabled).map((s) => s.getAttribute('aria-label')), text: document.querySelector('.sc-main')?.innerText.slice(0, 300) }))), ')');
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
  // How often the page told the admin the site's content changed (that's what asks about Publish)
  const changes = () => page.evaluate(() => window.__contentChanged || 0);
  await page.evaluate(() => { window.__contentChanged = 0; addEventListener('soard-content-changed', () => { window.__contentChanged += 1; }); });

  await section('Picked, never pasted: three cards, the site’s forms, upcoming events and the Advisory Board', async () => {
    await page.waitForSelector('.sc-page', { timeout: 20000 });
    await ready(page);
    ok((await text(page, '.sc-bar h2')) === 'Zeffy', 'the page opens on #site/zeffy');
    const across = await page.$$eval('.sc-rail-group', (hs) => hs.map((h) => [h.textContent, [...h.nextElementSibling.querySelectorAll('.sc-rail-title')].map((t) => t.textContent.trim())]));
    ok(across.some(([g, t]) => /Across the site/.test(g) && t.includes('Zeffy')), 'it’s listed under Across the site');
    ok(JSON.stringify(await page.$$eval('.sc-page .sc-card h3', (hs) => hs.map((h) => h.textContent))) === '["Giving","Events","Advisory Board"]', 'three cards: Giving, Events, Advisory Board');
    ok(!(await page.$('.sc-page .zf-link input')), 'no box to paste a link into: every link is picked');
    ok(await page.$$eval('.sc-page > .sc-note', (ns) => ns.some((n) => /A kid’s fundraising link is on their page in Kids\./.test(n.textContent))), 'the page says a kid’s link is on their page in Kids');
    ok(/Before saving, fix “Donate page: monthly gifts”/.test(await text(page, '.sc-page')), 'and, at the top, that the monthly form is missing');
    const once = await fieldInfo(page, 'sc-zeffy-giving', 'Donate page: one-time gifts');
    ok(once.value === BRIGHTER && once.chosen === 'A Brighter Day Starts With You', `the one-time form is the saved one, its link behind Open (${once.chosen})`);
    ok(!once.options.some((o) => /Evening of Sunshine|Advisory Board|Spring Peer/.test(o)), `Giving lists only donation forms (${once.options.join(' | ')})`);
    ok(!once.switchText, 'the site’s forms are Zeffy forms only: no other-site switch');
    ok(!once.options.includes('No form'), 'a required form has no “No form”');
    const live = await fieldInfo(page, 'sc-zeffy-giving', 'Live reveal: Fund the next room');
    ok(live.chosen === 'Old Spring Appeal (closed)' && live.warning === 'That form has closed in Zeffy: pick an open one' && !live.problem, `a form Zeffy closed is a warning (${live.chosen}: ${live.warning})`);
    ok(await page.evaluate(() => { const w = document.querySelector('#sc-zeffy-giving .zf-link__warn'); const b = document.createElement('p'); b.className = 'zf-link__bad'; document.body.append(b); const out = getComputedStyle(w).color !== getComputedStyle(b).color; b.remove(); return out; }), 'in the warning colour, not the problem colour');
    const monthly = await fieldInfo(page, 'sc-zeffy-giving', 'Donate page: monthly gifts');
    ok(monthly.value === '' && monthly.problem === 'Pick a Zeffy form', `a form the settings don’t have says so, never a form from code (${monthly.problem})`);
    ok(monthly.boxWidth === once.boxWidth, `a field with a problem keeps its layout (${monthly.boxWidth} vs ${once.boxWidth}px)`);
    ok(await page.$eval('#sc-zeffy-giving input[type="checkbox"]', (b) => b.checked), 'the one-time form takes donor-advised fund gifts, as saved');
    const evs = await page.$$eval('#sc-zeffy-events .sc-label', (ls) => ls.map((l) => l.textContent.replace(/\s+/g, ' ').trim()));
    ok(evs.length === 3 && /^Cookie Swap/.test(evs[0]) && /Fairway 2027/.test(evs[1]) && /2027 Evening of Sunshine/.test(evs[2]), `upcoming events, soonest first; the 2026 gala is over and left out (${evs.join(' | ')})`);
    const gala = await fieldInfo(page, 'sc-zeffy-events', '2027 Evening of Sunshine');
    ok(gala.chosen === '2027 Evening of Sunshine' && gala.under === 'Shows on /events/gala/, its card on /events/ and the homepage while it’s the next event.', `the gala’s form, picked, and where it shows (${gala.under})`);
    ok(gala.switchText === 'Tickets on another site?', 'an event can sell its tickets on another site');
    ok(gala.options[1] === 'No form', 'an event’s link can be taken off: “No form”');
    const golf = await fieldInfo(page, 'sc-zeffy-events', 'Sunshine on a Ranney Fairway 2027');
    ok(golf.under === 'No link yet, so /events/golf/, its card on /events/ and the homepage while it’s the next event have no ticket button.', `a blank golf link says where (${golf.under})`);
    const swap = await fieldInfo(page, 'sc-zeffy-events', 'Cookie Swap');
    ok(swap.under === 'No link yet, so its card on /events/ and the homepage while it’s the next event have no ticket button.', `an event with no page of its own (${swap.under})`);
    ok(/-hint\b/.test(swap.describedBy), `screen readers hear the hint with the dropdown (${swap.describedBy})`);
    const adv = await fieldInfo(page, 'sc-zeffy-advisory', 'The group’s campaign');
    ok(adv.value === '' && /^Not connected/.test(adv.under) && !adv.switchText && adv.chosen === 'No form', 'the Advisory Board’s campaign: not connected yet (“No form”), Zeffy only');
    ok(!!(await fieldInfo(page, 'sc-zeffy-advisory', 'Wine night at the Atchleys')), 'an approved fundraiser’s Zeffy page is here too');
    const gone = await fieldInfo(page, 'sc-zeffy-advisory', 'Golf scramble');
    ok(gone.chosen === 'Saved: zeffy.com/peer-to-peer/deleted-drive' && gone.warning === 'That form isn’t in SOARD’s Zeffy any more: pick another' && !gone.problem, `a saved form Zeffy no longer has shows what’s saved, as a warning (${gone.chosen}: ${gone.warning})`);
    ok(/Everything is saved/.test(await barState(page)), 'nothing unsaved to start');
    await shot(page, '01-zeffy.png');
  });

  await section('One Save: the Advisory Board first, then the forms and events, over someone’s newer edit', async () => {
    const golfBefore = await row('events', GOLF);
    const golfWidth = (await fieldInfo(page, 'sc-zeffy-events', 'Sunshine on a Ranney Fairway 2027')).boxWidth;
    await pick(page, 'sc-zeffy-giving', 'Donate page: one-time gifts', 'Holiday Giving 2026');
    ok((await fieldInfo(page, 'sc-zeffy-giving', 'Donate page: one-time gifts')).value === 'https://www.zeffy.com/donation-form/holiday-giving-2026', 'picking a form takes its link from Zeffy');
    ok(!(await page.$eval('#sc-zeffy-giving input[type="checkbox"]', (b) => b.checked)), 'a different one-time form isn’t known to take donor-advised fund gifts until someone says so');
    ok(await saveDisabled(page) && /Fix “Donate page: monthly gifts”/.test(await barState(page)), `Save waits for the monthly form (${await barState(page)})`);
    await pick(page, 'sc-zeffy-giving', 'Donate page: monthly gifts', 'SOARD Monthly Builders');
    ok(!(await saveDisabled(page)), 'with it picked, Save is back');
    await pick(page, 'sc-zeffy-events', 'Sunshine on a Ranney Fairway 2027', 'Sunshine on a Ranney Fairway 2027');
    ok((await fieldInfo(page, 'sc-zeffy-events', 'Sunshine on a Ranney Fairway 2027')).boxWidth === golfWidth, `Open appearing doesn’t move the dropdown (${golfWidth}px)`);
    // The Cookie Swap sells on SignUpGenius
    await flip(page, 'sc-zeffy-events', 'Cookie Swap');
    ok((await fieldInfo(page, 'sc-zeffy-events', 'Cookie Swap')).box, '“Tickets on another site?” gives a box for its link');
    await type(page, 'sc-zeffy-events', 'Cookie Swap', 'www.signupgenius.com/go/cookie-swap');
    ok((await fieldInfo(page, 'sc-zeffy-events', 'Cookie Swap')).value === 'https://www.signupgenius.com/go/cookie-swap', 'https:// is put on a link typed without it');
    await pick(page, 'sc-zeffy-advisory', 'The group’s campaign', 'Advisory Board 2026–27');
    ok((await fieldInfo(page, 'sc-zeffy-advisory', 'The group’s campaign')).under === '“Advisory Board 2026–27”: connected when you save.', 'a picked campaign says it connects on Save');
    await pick(page, 'sc-zeffy-advisory', 'Wine night at the Atchleys', 'Holiday Giving 2026');
    await save(`src/content/events/${GOLF}.json`, { ...golfBefore, description: 'Someone else’s newer words.' }, 'holly@soardcharity.com');
    state.calls.length = 0;
    await saveNow(page);
    ok(/saved/i.test(await barState(page)) && !/Unsaved/.test(await barState(page)), `saved (${await barState(page)})`);
    const order = state.calls.filter((c) => c === '/api/advisory-admin' || c === '/api/save-content');
    ok(order[0] === '/api/advisory-admin' && order.lastIndexOf('/api/advisory-admin') < order.indexOf('/api/save-content'), `the Advisory Board’s links go first (${order.join(' → ')})`);
    const st = await settingsNow();
    ok(JSON.stringify(st.zeffy) === JSON.stringify({ donateUrl: 'https://www.zeffy.com/donation-form/holiday-giving-2026', liveUrl: OLD_SPRING, daf: false, monthlyUrl: 'https://www.zeffy.com/donation-form/soard-monthly-builders' }), `settings.zeffy: all three forms, DAF off for the new one, the closed one left as it was (${JSON.stringify(st.zeffy)})`);
    const { zeffy, ...rest } = st;
    const { zeffy: _z, ...seedRest } = settingsSeed;
    ok(JSON.stringify(rest) === JSON.stringify(seedRest), 'every other setting is as it was');
    const golf = await row('events', GOLF);
    ok(golf.ticketUrl === 'https://www.zeffy.com/ticketing/fairway-2027' && golf.description === 'Someone else’s newer words.', 'the golf link is saved, and the words someone saved meanwhile stay');
    const { ticketUrl: _a, description: _b, ...golfRest } = golf;
    const { ticketUrl: _c, description: _d, ...beforeRest } = golfBefore;
    ok(JSON.stringify(golfRest) === JSON.stringify(beforeRest), 'nothing else on the golf tournament changed');
    ok((await row('events', SWAP)).ticketUrl === 'https://www.signupgenius.com/go/cookie-swap', 'the Cookie Swap’s other site is saved, with its https://');
    ok(JSON.stringify(await row('events', GALA)) === JSON.stringify(EVENTS[GALA]), 'an event nobody touched isn’t saved');
    const camp = state.advisoryPosts.find((x) => x.action === 'save-settings');
    ok(camp && camp.settings.campaignUrl === 'https://www.zeffy.com/peer-to-peer/advisory-board-2026-27' && camp.settings.campaignId === 'f-advisory' && Object.keys(camp.settings).length === 2, `the campaign went with its ID, from Zeffy, and nothing else (${JSON.stringify(camp)})`);
    const host = state.advisoryPosts.find((x) => x.action === 'hosted-link');
    ok(host && host.id === 'h1' && host.giveUrl === 'https://www.zeffy.com/donation-form/holiday-giving-2026' && !('status' in host) && !state.advisoryPosts.some((x) => x.action === 'hosted-status'), 'the fundraiser’s page went by its own action, its status untouched');
    ok(!state.advisoryPosts.some((x) => x.id === 'h2'), 'a fundraiser nobody touched isn’t sent, even with a form Zeffy no longer has');
    ok(/^Connected/.test((await fieldInfo(page, 'sc-zeffy-advisory', 'The group’s campaign')).under), 'the campaign now says Connected');
    ok(await changes() === 1, `the site’s content changed once, so Publish is asked about (${await changes()})`);
  });

  await section('“No form” takes a link off', async () => {
    await pick(page, 'sc-zeffy-events', '2027 Evening of Sunshine', 'No form');
    const gala = await fieldInfo(page, 'sc-zeffy-events', '2027 Evening of Sunshine');
    ok(gala.value === '' && gala.chosen === 'No form' && /^No link yet, so \/events\/gala\//.test(gala.under), `the gala’s link is off (${gala.under})`);
    await pick(page, 'sc-zeffy-advisory', 'The group’s campaign', 'No form');
    ok(/^Not connected/.test((await fieldInfo(page, 'sc-zeffy-advisory', 'The group’s campaign')).under), 'the campaign is unlinked');
    ok(!(await saveDisabled(page)), 'and that can be saved');
    await clickText(page, '.sc-bar-actions button', /^Discard$/);
    await sleep(150);
    ok((await fieldInfo(page, 'sc-zeffy-events', '2027 Evening of Sunshine')).chosen === '2027 Evening of Sunshine', 'Discard puts the gala’s form back');
  });

  await section('A save of Advisory links only doesn’t ask about Publish', async () => {
    await pick(page, 'sc-zeffy-advisory', 'The group’s campaign', 'Spring Peer Drive');
    ok((await fieldInfo(page, 'sc-zeffy-advisory', 'The group’s campaign')).under === '“Spring Peer Drive”: connected when you save.', 'a different campaign says it connects on Save');
    await clickText(page, '.sc-bar-actions button', /^Discard$/);
    await sleep(150);
    const before = await changes();
    await pick(page, 'sc-zeffy-advisory', 'Wine night at the Atchleys', 'Help Build a Brighter Home');
    await saveNow(page);
    ok(state.advisory.hosted.h1.giveUrl === 'https://www.zeffy.com/donation-form/help-build-a-brighter-home' && await changes() === before, 'saved, and no Publish asked about');
  });

  await section('Another site’s link: problems in the words Save uses, once the box is left; back to Zeffy', async () => {
    await type(page, 'sc-zeffy-events', 'Cookie Swap', 'signupgenius/oops');
    ok((await fieldInfo(page, 'sc-zeffy-events', 'Cookie Swap')).problem === 'Paste the whole link, starting with https://', 'a link that isn’t a web address is named');
    ok(await saveDisabled(page) && /Fix the Cookie Swap tickets link/.test(await barState(page)), `Save is blocked, naming it (${await barState(page)})`);
    // A pasted link with a space in it
    const box = await (await field(page, 'sc-zeffy-events', 'Cookie Swap')).$('input');
    await box.focus();
    await page.evaluate(() => document.activeElement.select());
    await page.keyboard.sendCharacter('https://www.signupgenius.com/go/cookie swap');
    await box.evaluate((el) => el.blur());
    await sleep(80);
    const spaced = await fieldInfo(page, 'sc-zeffy-events', 'Cookie Swap');
    ok(spaced.problem === 'Take the spaces out of the link', `a space is named (${JSON.stringify(spaced.value)}: ${spaced.problem})`);
    await flip(page, 'sc-zeffy-events', 'Cookie Swap');
    const back = await fieldInfo(page, 'sc-zeffy-events', 'Cookie Swap');
    ok(!back.box && back.value === '' && back.switchText === 'Tickets on another site?', 'back to a Zeffy form: the other site’s link goes, the dropdown is back');
    await clickText(page, '.sc-bar-actions button', /^Discard$/);
    await sleep(150);
    const restored = await fieldInfo(page, 'sc-zeffy-events', 'Cookie Swap');
    ok(restored.box && restored.value === 'https://www.signupgenius.com/go/cookie-swap' && !restored.problem, 'Discard brings the saved other site back, in its box');
    // Typing in the box: it stays the box (even for a Zeffy link), nothing changes under the person, a space is kept and named
    await type(page, 'sc-zeffy-events', 'Cookie Swap', 'https://www.zeffy.com/ticketing/fairway-2027');
    const typed = await fieldInfo(page, 'sc-zeffy-events', 'Cookie Swap');
    ok(typed.box && typed.value === 'https://www.zeffy.com/ticketing/fairway-2027', `typing a Zeffy link keeps the box, every letter (${typed.value})`);
    await type(page, 'sc-zeffy-events', 'Cookie Swap', 'https://www.signupgenius.com/go/cookie swap');
    const spaced2 = await fieldInfo(page, 'sc-zeffy-events', 'Cookie Swap');
    ok(spaced2.value === 'https://www.signupgenius.com/go/cookie swap' && spaced2.problem === 'Take the spaces out of the link', `a typed space is kept and named, never dropped (${spaced2.value})`);
    // ⌘S while still typing: the link gets its https:// as the save starts
    const box2 = await (await field(page, 'sc-zeffy-events', 'Cookie Swap')).$('input');
    await box2.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await box2.type('www.signupgenius.com/go/cookie-swap-3');
    await page.keyboard.down('Meta'); await page.keyboard.press('s'); await page.keyboard.up('Meta');
    await page.waitForFunction(() => !/Saving|Unsaved/.test(document.querySelector('.sc-bar-state')?.textContent || ''), { timeout: 10000 }).catch(() => {});
    await sleep(300);
    ok((await row('events', SWAP)).ticketUrl === 'https://www.signupgenius.com/go/cookie-swap-3', `⌘S while still in the box saves the whole link (${(await row('events', SWAP)).ticketUrl})`);
    await flip(page, 'sc-zeffy-events', 'Sunshine on a Ranney Fairway 2027');
    ok((await fieldInfo(page, 'sc-zeffy-events', 'Sunshine on a Ranney Fairway 2027')).value === 'https://www.zeffy.com/ticketing/fairway-2027', 'switching a Zeffy form to another site starts the box from its link, nothing lost');
    await flip(page, 'sc-zeffy-events', 'Sunshine on a Ranney Fairway 2027');
    ok((await fieldInfo(page, 'sc-zeffy-events', 'Sunshine on a Ranney Fairway 2027')).chosen === 'Sunshine on a Ranney Fairway 2027' && !/Unsaved/.test(await barState(page)), 'and back again, unchanged');
  });

  await section('Conflicts: an event names itself; the campaign is one choice; a fundraiser is named', async () => {
    await pick(page, 'sc-zeffy-events', 'Sunshine on a Ranney Fairway 2027', '2027 Evening of Sunshine');
    await pick(page, 'sc-zeffy-advisory', 'The group’s campaign', 'Spring Peer Drive');
    await pick(page, 'sc-zeffy-advisory', 'Wine night at the Atchleys', 'SOARD Monthly Builders');
    // Meanwhile: someone else sets the golf link, another campaign and the fundraiser's page
    await save(`src/content/events/${GOLF}.json`, { ...(await row('events', GOLF)), ticketUrl: 'https://www.zeffy.com/ticketing/someone-elses' }, 'holly@soardcharity.com');
    Object.assign(state.advisory, { campaignUrl: 'https://www.zeffy.com/peer-to-peer/someone-elses', campaignId: 'f-else' });
    state.advisory.hosted.h1.giveUrl = 'https://www.zeffy.com/peer-to-peer/someone-elses-night';
    await clickText(page, '.sc-bar-actions button', /^Save$/);
    await page.waitForSelector('.sc-dialog', { timeout: 8000 });
    const rows = await page.$$eval('.sc-dialog .sc-diff > li > strong', (ss) => ss.map((x) => x.textContent.trim()));
    ok(rows.includes('Zeffy: Sunshine on a Ranney Fairway 2027, Tickets link'), `the event names itself (${rows.join(' | ')})`);
    ok(rows.filter((r) => /campaign/.test(r)).length === 1 && rows.includes('Zeffy: The Advisory Board’s campaign'), 'the campaign is one row, its ID going with its link');
    ok(rows.includes('Zeffy: “Wine night at the Atchleys” Zeffy page'), 'the fundraiser is named');
    ok(!(await text(page, '.sc-dialog')).includes('f-else'), 'no raw IDs to choose between');
    await clickText(page, '.sc-dialog-foot button', /^Save with these$/);
    await page.waitForFunction(() => !document.querySelector('.sc-dialog'), { timeout: 8000 });
    await sleep(500);
    ok((await row('events', GOLF)).ticketUrl === 'https://www.zeffy.com/ticketing/2027-evening-of-sunshine', 'keep mine: the golf link');
    const last = state.advisoryPosts.filter((x) => x.action === 'save-settings').at(-1);
    ok(last.settings.campaignUrl === 'https://www.zeffy.com/peer-to-peer/spring-peer-drive' && last.settings.campaignId === 'f-spring' && state.advisory.campaignId === 'f-spring', 'keep mine: the campaign and its ID together');
  });

  await section('History: an event’s link, put back', async () => {
    await clickText(page, '.sc-bar-actions button', /History/);
    await page.waitForSelector('.sc-dialog .sc-hist li', { timeout: 8000 });
    const hist = await text(page, '.sc-dialog');
    ok(/Sunshine on a Ranney Fairway 2027: Tickets link/.test(hist) && /Cookie Swap: Tickets link/.test(hist), 'History lists the events’ links with whose they are');
    ok(/The Advisory Board’s links aren’t kept here/.test(hist), 'and says the Advisory Board’s aren’t kept');
    ok(/Zeffy forms|Donate page/.test(hist), 'and the site’s forms');
    // The golf tournament's oldest version: no link yet
    await page.evaluate(() => { const li = [...document.querySelectorAll('.sc-dialog .sc-hist li')].filter((x) => /Ranney Fairway 2027/.test(x.textContent)).at(-1); li.querySelector('button').click(); });
    await page.waitForFunction(() => /Put these back/.test(document.querySelector('.sc-dialog-foot')?.textContent || '') && !document.querySelector('.sc-dialog .spinner'), { timeout: 8000 });
    ok(/Sunshine on a Ranney Fairway 2027: Tickets link/.test(await text(page, '.sc-dialog .sc-diff')), 'comparing shows the link, whose it is');
    await clickText(page, '.sc-dialog-foot button', /^Put these back$/);
    await sleep(200);
    const golf = await fieldInfo(page, 'sc-zeffy-events', 'Sunshine on a Ranney Fairway 2027');
    ok(golf.value === '' && golf.chosen === 'No form', `putting it back takes the link off (“No form”), waiting for Save (${golf.chosen})`);
    await clickText(page, '.sc-bar-actions button', /^Discard$/);
    await sleep(150);
  });

  await section('An event deleted meanwhile', async () => {
    await DB.prepare('DELETE FROM events WHERE slug = ?').bind(SWAP).run();
    await type(page, 'sc-zeffy-events', 'Cookie Swap', 'https://www.signupgenius.com/go/cookie-swap-2');
    await saveNow(page);
    await sleep(300);
    const toast = await page.evaluate(() => [...document.querySelectorAll('.toast, [role="status"], [role="alert"]')].map((t) => t.textContent).join(' | '));
    ok(/Cookie Swap was deleted meanwhile, so its link wasn’t saved/.test(toast), `it says so (${toast.slice(0, 140)})`);
    ok(/This event was deleted since the page opened/.test(await text(page, '#sc-zeffy-events')), 'its row says it’s gone, with nothing to edit');
    ok(!(await row('events', SWAP).catch(() => null)), 'and it isn’t brought back');
    await DB.prepare('INSERT INTO events (slug, data, updated_at) VALUES (?, ?, ?)').bind(SWAP, JSON.stringify(EVENTS[SWAP]), new Date().toISOString()).run().catch(() => save(`src/content/events/${SWAP}.json`, EVENTS[SWAP]));
  });

  await section('Ways in and out: Kids keeps Back working, Donate points here, ⌘K finds it', async () => {
    ok(await clickText(page, '.sc-page > .sc-note .sc-link', /^Kids$/), 'the note’s Kids link');
    await page.waitForFunction(() => location.hash.startsWith('#kids') && !document.querySelector('.sc-bar'), { timeout: 8000 }).then(() => ok(true, 'it opens Kids')).catch(async () => ok(false, `it opens Kids (${await page.evaluate(() => location.hash)})`));
    await page.goBack();
    await page.waitForFunction(() => location.hash === '#site/zeffy' && document.querySelector('.sc-bar h2')?.textContent === 'Zeffy', { timeout: 8000 }).then(() => ok(true, 'Back comes back to Zeffy')).catch(async () => ok(false, `Back comes back to Zeffy (${await page.evaluate(() => location.hash)})`));
    await page.evaluate(() => { location.hash = '#site/donate'; });
    await page.waitForFunction(() => document.querySelector('.sc-bar h2')?.textContent === 'Donate', { timeout: 8000 })
      .catch(async (err) => { console.log('    at failure:', JSON.stringify(await page.evaluate(() => ({ hash: location.hash, h2: document.querySelector('.sc-bar h2')?.textContent, state: document.querySelector('.sc-bar-state')?.textContent })))); throw err; });
    await page.waitForSelector('.sc-page .sc-card', { timeout: 8000 });
    ok(await clickText(page, '.sc-page button', /^Open Zeffy$/), 'Donate has Open Zeffy');
    await page.waitForFunction(() => document.querySelector('.sc-bar h2')?.textContent === 'Zeffy', { timeout: 8000 });
    await page.keyboard.down('Meta'); await page.keyboard.press('k'); await page.keyboard.up('Meta');
    await page.waitForSelector('.cmd-palette-input', { timeout: 5000 });
    await page.type('.cmd-palette-input', 'zeffy');
    await sleep(250);
    ok(await page.evaluate(() => [...document.querySelectorAll('.cmd-palette-item')].some((e) => /Zeffy links/.test(e.textContent))), 'the ⌘K palette finds “Zeffy links”');
    await page.keyboard.press('Escape');
  });

  ok(!errors.length, `no page errors (${errors.slice(0, 3).join(' | ')})`);
  await page.close();

  await section('Events that didn’t load, none upcoming, an event that won’t load; the Advisory Board for someone who doesn’t run it', async () => {
    state.failEventsList = true;
    state.advisoryRefused = true;
    const { page: p2, errors: e2 } = await open(1440, 1000, '#site/zeffy');
    await p2.waitForSelector('#sc-zeffy-events', { timeout: 20000 });
    await p2.waitForFunction(() => /The events didn’t load/.test(document.querySelector('#sc-zeffy-events')?.textContent || '') && /Only the people who run the Advisory Board can open this\./.test(document.querySelector('#sc-zeffy-advisory')?.textContent || ''), { timeout: 15000 })
      .then(() => ok(true, 'events that didn’t load say so (never “No events”); the Advisory Board card has the server’s own words')).catch(async () => ok(false, `failure states (${(await text(p2, '.sc-page')).slice(0, 200)})`));
    state.failEventsList = false;
    state.failEvent = GALA;
    await clickText(p2, '#sc-zeffy-events .sc-link', /^Try again$/);
    await p2.waitForFunction(() => /Couldn’t load it/.test(document.querySelector('#sc-zeffy-events')?.textContent || ''), { timeout: 15000 }).then(() => ok(true, 'Try again loads the list; the gala that won’t load says so')).catch(() => ok(false, 'Try again loads the list'));
    await p2.waitForFunction(() => document.querySelectorAll('#sc-zeffy-events .zf-select').length >= 2 && [...document.querySelectorAll('#sc-zeffy-events .zf-select')].every((s) => !s.disabled), { timeout: 15000 });
    await pick(p2, 'sc-zeffy-events', 'Cookie Swap', 'Holiday Giving 2026');
    await saveNow(p2);
    ok((await row('events', SWAP)).ticketUrl === 'https://www.zeffy.com/donation-form/holiday-giving-2026' && !/Unsaved/.test(await barState(p2)), 'the rest still saves');
    state.failEvent = null;
    await clickText(p2, '#sc-zeffy-events .sc-link', /^Try again$/);
    await p2.waitForFunction(() => !/Couldn’t load it/.test(document.querySelector('#sc-zeffy-events')?.textContent || ''), { timeout: 8000 }).catch(() => {});
    ok(!!(await fieldInfo(p2, 'sc-zeffy-events', '2027 Evening of Sunshine'))?.value, 'Try again loads the gala');
    await shot(p2, '02-failures.png', 2400);
    ok(!e2.length, `no page errors (${e2.slice(0, 3).join(' | ')})`);
    await p2.close();
    state.advisoryRefused = false;
    // Zeffy down: every field still shows what's saved, and an empty one says why there's nothing to pick
    const golfBefore = await row('events', GOLF);
    await DB.prepare('UPDATE events SET data = ? WHERE slug = ?').bind(JSON.stringify({ ...golfBefore, ticketUrl: '' }), GOLF).run();
    state.formsFail = true;
    const { page: p5, errors: e5 } = await open(1440, 1000, '#site/zeffy');
    await p5.waitForSelector('#sc-zeffy-giving .zf-select', { timeout: 20000 });
    await p5.waitForFunction(() => /Zeffy isn’t answering/.test(document.querySelector('.sc-page')?.textContent || ''), { timeout: 15000 }).catch(() => {});
    const downOnce = await fieldInfo(p5, 'sc-zeffy-giving', 'Donate page: one-time gifts');
    ok(/^Saved: zeffy\.com\/donation-form\//.test(downOnce.chosen) && /Zeffy isn’t answering/.test(downOnce.under + (await text(p5, '#sc-zeffy-giving'))), `a saved form still shows, never a blank dropdown (${downOnce.chosen})`);
    const shown = await p5.$$eval('.sc-page .zf-select', (ss) => ss.filter((x) => !x.selectedOptions[0]?.textContent.trim()).length);
    ok(shown === 0, `no dropdown shows nothing (${shown} blank)`);
    const golfDown = await fieldInfo(p5, 'sc-zeffy-events', 'Sunshine on a Ranney Fairway 2027');
    const golfNote = await p5.evaluate(() => [...document.querySelectorAll('#sc-zeffy-events .sc-field')].find((f) => /Fairway/.test(f.querySelector('.sc-label')?.textContent || ''))?.querySelector('.zf-link__note')?.textContent.trim() || '');
    ok(golfDown.chosen === 'No form' && /Zeffy isn’t answering/.test(golfNote), `an empty field (“No form”) says why there’s nothing to pick (${golfDown.chosen}: ${golfNote})`);
    ok(!e5.length, `no page errors (${e5.slice(0, 3).join(' | ')})`);
    await p5.close();
    state.formsFail = false;
    await DB.prepare('UPDATE events SET data = ? WHERE slug = ?').bind(JSON.stringify(golfBefore), GOLF).run();
    // Zeffy's list comes late, after a change: the monthly form (a ticket form, saved some other way) is checked the moment it does
    const st0 = await settingsNow();
    await DB.prepare("UPDATE site_config SET data = ? WHERE key = 'settings'").bind(JSON.stringify({ ...st0, zeffy: { ...st0.zeffy, monthlyUrl: 'https://www.zeffy.com/ticketing/2027-evening-of-sunshine' } })).run();
    state.formsDelay = 3000;
    const { page: p4, errors: e4 } = await open(1440, 1000, '#site/zeffy');
    await p4.waitForSelector('#sc-zeffy-giving input[type="checkbox"]', { timeout: 20000 });
    await p4.click('#sc-zeffy-giving input[type="checkbox"]');
    await sleep(100);
    ok(!(await saveDisabled(p4)), 'before the list, nothing says the monthly form is a ticket form');
    await p4.waitForFunction(() => /Fix “Donate page: monthly gifts”/.test(document.querySelector('.sc-bar-state')?.textContent || ''), { timeout: 8000 })
      .then(() => ok(true, 'the list comes: Save is blocked, naming the monthly form')).catch(async () => ok(false, `the list comes: Save is blocked (${await barState(p4)})`));
    ok(await saveDisabled(p4) && (await fieldInfo(p4, 'sc-zeffy-giving', 'Donate page: monthly gifts')).problem === 'Pick a form from “Donation forms”: this one is in “Events and tickets”', 'the field says the same');
    ok(!e4.length, `no page errors (${e4.slice(0, 3).join(' | ')})`);
    await p4.close();
    state.formsDelay = 0;
    await DB.prepare("UPDATE site_config SET data = ? WHERE key = 'settings'").bind(JSON.stringify(st0)).run();
    state.onlyPast = true;
    const { page: p3, errors: e3 } = await open(1440, 1000, '#site/zeffy');
    await p3.waitForFunction(() => /No upcoming events/.test(document.querySelector('#sc-zeffy-events')?.textContent || ''), { timeout: 15000 }).then(() => ok(true, 'no upcoming events says so, with a way to Events')).catch(async () => ok(false, `none upcoming (${await text(p3, '#sc-zeffy-events')})`));
    ok(!e3.length, `no page errors (${e3.slice(0, 3).join(' | ')})`);
    await p3.close();
    state.onlyPast = false;
  });

  await section('A link saved earlier is left as it is; Discard and History put the field back as it was', async () => {
    const swapWas = await row('events', SWAP);
    const golfWas = await row('events', GOLF);
    const galaWas = await row('events', GALA);
    await DB.prepare('UPDATE events SET data = ? WHERE slug = ?').bind(JSON.stringify({ ...swapWas, ticketUrl: 'www.eventbrite.com/e/1' }), SWAP).run();
    await DB.prepare('UPDATE events SET data = ? WHERE slug = ?').bind(JSON.stringify({ ...golfWas, ticketUrl: 'https://www.zeffy.com/ticketing/fairway-2027' }), GOLF).run();
    await DB.prepare('UPDATE events SET data = ? WHERE slug = ?').bind(JSON.stringify({ ...galaWas, ticketUrl: 'https://www.zeffy.com/ticketing/2027-evening-of-sunshine' }), GALA).run();
    // A version from before the field put https:// on, for History to bring back
    await DB.prepare('INSERT INTO content_versions (collection, slug, data, action, user_email, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('events', SWAP, JSON.stringify({ ...swapWas, ticketUrl: 'www.signupgenius.com/go/swap-2025' }), 'save', 'linzi@soardcharity.com', '2026-01-02T12:00:00.000Z').run();
    const { page: p6, errors: e6 } = await open(1440, 1000, '#site/zeffy');
    await ready(p6);
    await p6.waitForFunction(() => /donation-form|Help Build/.test(document.querySelector('#sc-zeffy-giving')?.textContent || '') && document.querySelectorAll('#sc-zeffy-giving option').length > 3, { timeout: 15000 }).catch(() => {});
    const old = await fieldInfo(p6, 'sc-zeffy-events', 'Cookie Swap');
    ok(old.box && old.value === 'www.eventbrite.com/e/1' && old.warning === 'Paste the whole link, starting with https://' && !old.problem, `a saved link without its https:// is said, as a warning, the page can’t use it (${old.value}: ${old.warning || old.problem})`);
    ok(/saved/i.test(await barState(p6)), `opening the page changes nothing (${await barState(p6)})`);
    // Tabbing through its box, typing nothing: still nothing changed
    await p6.evaluate(() => { const f = [...document.querySelectorAll('#sc-zeffy-events .sc-field')].find((x) => /Cookie Swap/.test(x.querySelector('.sc-label')?.textContent || '')); const i = f.querySelector('.zf-link input'); i.focus(); i.blur(); });
    await sleep(150);
    ok((await fieldInfo(p6, 'sc-zeffy-events', 'Cookie Swap')).value === 'www.eventbrite.com/e/1' && /saved/i.test(await barState(p6)), `tabbing through its box leaves it as it is (${await barState(p6)})`);
    // ⌘S with another change, the cursor nowhere near it: the link nobody touched is left exactly as saved
    await pick(p6, 'sc-zeffy-giving', 'Donate page: monthly gifts', 'SOARD Monthly Builders');
    await pick(p6, 'sc-zeffy-events', '2027 Evening of Sunshine', 'Sunshine on a Ranney Fairway 2027');
    await p6.keyboard.down('Meta'); await p6.keyboard.press('s'); await p6.keyboard.up('Meta');
    await p6.waitForFunction(() => !/Saving|Unsaved/.test(document.querySelector('.sc-bar-state')?.textContent || ''), { timeout: 10000 }).catch(() => {});
    await sleep(300);
    ok((await row('events', GALA)).ticketUrl === 'https://www.zeffy.com/ticketing/fairway-2027', '⌘S saved the change');
    ok((await row('events', SWAP)).ticketUrl === 'www.eventbrite.com/e/1', `and left the link nobody touched as it was (${(await row('events', SWAP)).ticketUrl})`);
    // Discard after typing another site's link: the field is back to the saved form, in its dropdown
    await flip(p6, 'sc-zeffy-events', 'Sunshine on a Ranney Fairway 2027');
    await type(p6, 'sc-zeffy-events', 'Sunshine on a Ranney Fairway 2027', 'https://www.signupgenius.com/go/golf');
    await clickText(p6, '.sc-bar-actions button', /^Discard$/);
    await sleep(200);
    const golf = await fieldInfo(p6, 'sc-zeffy-events', 'Sunshine on a Ranney Fairway 2027');
    ok(!golf.box && golf.chosen === 'Sunshine on a Ranney Fairway 2027', `Discard puts the saved form back, in its dropdown (${golf.box ? `box: ${golf.value}` : golf.chosen})`);
    // History: a link from before gets its https:// as it comes back, as a typed one does
    await clickText(p6, '.sc-bar-actions button', /History/);
    await p6.waitForSelector('.sc-dialog .sc-hist li', { timeout: 8000 });
    const picked = await p6.evaluate(() => { const li = [...document.querySelectorAll('.sc-dialog .sc-hist li')].find((x) => /Cookie Swap/.test(x.textContent) && /Linzi|linzi/.test(x.textContent)); li?.querySelector('button')?.click(); return li?.textContent.trim().slice(0, 120) || ''; });
    await p6.waitForFunction(() => /Put these back/.test(document.querySelector('.sc-dialog-foot')?.textContent || '') && !document.querySelector('.sc-dialog .spinner'), { timeout: 8000 }).catch(() => {});
    await clickText(p6, '.sc-dialog-foot button', /^Put these back$/);
    await sleep(250);
    const back = await fieldInfo(p6, 'sc-zeffy-events', 'Cookie Swap');
    ok(back.box && back.value === 'https://www.signupgenius.com/go/swap-2025' && !back.problem && !back.warning, `History’s old link comes back whole (${back.value}; from “${picked}”)`);
    await clickText(p6, '.sc-bar-actions button', /^Discard$/);
    await sleep(150);
    ok((await fieldInfo(p6, 'sc-zeffy-events', 'Cookie Swap')).value === 'www.eventbrite.com/e/1', 'Discard brings the saved one back, untouched');
    ok(!e6.length, `no page errors (${e6.slice(0, 3).join(' | ')})`);
    await p6.close();
    for (const [slug, was] of [[SWAP, swapWas], [GOLF, golfWas], [GALA, galaWas]]) await DB.prepare('UPDATE events SET data = ? WHERE slug = ?').bind(JSON.stringify(was), slug).run();
  });

  await section('Phone and dark', async () => {
    const { page: ph, errors: e3 } = await open(390, 844, '#site/zeffy');
    await ph.waitForSelector('.sc-page', { timeout: 20000 });
    await ready(ph);
    const wide = await ph.evaluate(() => [...document.querySelectorAll('.sc-page *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1).map((el) => el.className || el.tagName).slice(0, 5));
    ok(!wide.length, `nothing wider than the screen (${wide.join(', ')})`);
    const tall = await ph.$$eval('.sc-page .zf-select, .sc-page a.zf-link__open, .sc-page .zf-link__switch', (els) => els.filter((e) => e.getBoundingClientRect().height < 44).map((e) => e.className));
    ok(!tall.length, `every dropdown, Open and switch is a 44px target on a phone (${tall.slice(0, 3).join(', ')})`);
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
