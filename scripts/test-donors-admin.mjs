/**
 * test-donors-admin.mjs — drive Admin → Donors & Partners in a real browser
 * ===========================================================================
 * Serves public/ with the REAL /api/donors-admin over an in-memory D1, filled by the real reads of a fake Zeffy
 * (functions/api/_donors.js, _donor-crm.js), then walks the Donors list, a donor's page, an organization's page (its
 * Zeffy names, who gave for it, Move to Champion, Keep anonymous), Needs you (a near name, the same person, a big
 * giver kept as an organization and put on the website through Partners' own Add dialog), renaming and taking out an
 * organization, the area's tabs into Partners and back, gift links from Slack, the old #job-costs/checks address, the
 * year-end list, To thank (Thanked, Undo, on the list and on a donor's page), Owner, notes, History, a phone, and axe. Names, emails and amounts are made up.
 * Run: node scripts/test-donors-admin.mjs
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import { onRequestGet as donorsGet, onRequestPost as donorsPost } from '../functions/api/donors-admin.js';
import * as D from '../functions/api/_donors.js';
import * as C from '../functions/api/_donor-crm.js';
import { updatePartners } from '../functions/api/partners-batch.js';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/donors/');
mkdirSync(OUT, { recursive: true });
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 864e5;
const NOW = Date.now();
const S = (ms) => Math.floor(ms / 1000);
const y = (yr, m = 3, d = 10) => S(Date.UTC(yr, m, d, 16));
const thisYear = new Date().getUTCFullYear();

// ─── A fake Zeffy ───────────────────────────────────────────────────
let seq = 0;
const pay = (o = {}) => ({
  id: o.id || `pay_${String(++seq).padStart(4, '0')}`, object: 'payment', created: o.created ?? S(NOW - DAY), amount: o.amount ?? 10000, status: 'succeeded', type: o.type || 'online',
  refund_status: 'none', refunds: [], description: o.description ?? 'Help Build a Brighter Home', contact: o.contact === undefined ? 'ct_jane' : o.contact,
  payment_method: { type: o.method || 'card' }, campaign_category: o.category || 'donation', items: o.items || [{ type: 'donation', amount: o.amount ?? 10000 }],
  buyer: { email: o.email ?? 'jane.doe@example.com', first_name: o.first ?? 'Jane', last_name: o.last ?? 'Doe', is_corporate: !!o.company, company_name: o.company || null },
  buyer_questions: o.questions || [], recurring: null, metadata: {},
});
const payments = [
  pay({ id: 'jane_2024', created: y(thisYear - 2), amount: 5000 }),
  pay({ id: 'jane_split_a', created: y(thisYear - 1), amount: 400000 }), pay({ id: 'jane_split_b', created: y(thisYear - 1) + 120, amount: 400000 }), pay({ id: 'jane_split_c', created: y(thisYear - 1) + 240, amount: 200000 }),
  pay({ id: 'jane_acme', created: S(NOW - 40 * DAY), amount: 1200000, company: 'Acme Builders' }),
  pay({ id: 'jane_daf', created: S(NOW - 60 * DAY), amount: 100000, method: 'daf', company: 'Fidelity Charitable' }),
  pay({ id: 'jane_check', created: S(NOW - 20 * DAY), amount: 50000, method: 'cheque', type: 'manual', items: [] }),
  pay({ id: 'jane_kid', created: S(NOW - 10 * DAY), amount: 7500, description: 'Kyle’s Room Makeover' }),
  pay({ id: 'sam_1', created: S(NOW - 5 * DAY), amount: 2500, contact: null, email: 'sam.lee@example.com', first: 'Sam', last: 'Lee' }),
  pay({ id: 'pat_1', created: y(thisYear - 3), amount: 30000, contact: 'ct_pat', email: 'pat.quiet@example.com', first: 'Pat', last: 'Quiet', questions: [{ question: 'Make my gift anonymous', answer: 'Yes' }] }),
  pay({ id: 'gala_ticket', created: S(NOW - 30 * DAY), amount: 15000, contact: 'ct_guest', email: 'guest@example.com', first: 'Gus', last: 'Guest', category: 'event', items: [{ type: 'ticket', amount: 15000, rate_title: 'General admission' }] }),
  // Needs you: a near name (Pella), one person twice (Maria), a big giver with no organization (Ivers)
  pay({ id: 'lee_pella', created: S(NOW - 15 * DAY), amount: 80000, contact: 'ct_lee', email: 'lee@example.com', first: 'Lee', last: 'Sample', company: 'Pella Window & Door of Georgia' }),
  pay({ id: 'lee_own', created: S(NOW - 12 * DAY), amount: 30000, contact: 'ct_lee', email: 'lee@example.com', first: 'Lee', last: 'Sample', company: 'Sample Builders' }),
  pay({ id: 'maria_1', created: S(NOW - 25 * DAY), amount: 5000, contact: 'ct_maria1', email: 'maria@example.com', first: 'Maria', last: 'Lopez' }),
  pay({ id: 'maria_2', created: S(NOW - 300 * DAY), amount: 7000, contact: 'ct_maria2', email: 'mlopez@example.org', first: 'Maria J.', last: 'Lopez' }),
  pay({ id: 'ann_ivers', created: S(NOW - 45 * DAY), amount: 3000000, contact: 'ct_ann', email: 'ann@example.com', first: 'Ann', last: 'Ivers', company: 'Ivers Foundation' }),
  // A foundation giving under its own Zeffy record, under Champion's amount: is it an organization?
  pay({ id: 'lark_1', created: S(NOW - 50 * DAY), amount: 100000, contact: 'ct_lark', email: 'office@larkwren.example', first: 'Lark & Wren', last: 'Foundation' }),
  ...Array.from({ length: 130 }, (_, i) => pay({ id: `fill_${i}`, created: S(NOW - (i + 2) * DAY), amount: 1000 + i * 10, contact: `ct_fill_${i}`, email: `filler${i}@example.com`, first: 'Filler', last: `Donor ${String(i).padStart(3, '0')}` })),
];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return realFetch(input, init);
  if (url.hostname !== 'api.zeffy.com') return Response.json({ error: 'offline in this walk' }, { status: 503 });
  const gte = Number(url.searchParams.get('created[gte]') ?? 0);
  const lte = Number(url.searchParams.get('created[lte]') ?? Infinity);
  const list = payments.filter((p) => p.created >= gte && p.created <= lte).sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1));
  const after = url.searchParams.get('starting_after');
  const start = after ? list.findIndex((p) => p.id === after) + 1 : 0;
  const data = list.slice(start, start + 100);
  const more = start + 100 < list.length;
  return Response.json({ object: 'list', data, has_more: more, next_cursor: more ? data.at(-1).id : null });
};

const partnerRow = (slug, d) => `INSERT INTO partners (slug, name, level, data) VALUES ('${slug}', '${String(d.name).replace(/'/g, "''")}', '${d.level || 'friend'}', '${JSON.stringify(d).replace(/'/g, "''")}')`;
const DB = await createD1({ schemaSql: ['CREATE TABLE kids (slug TEXT, name TEXT, data TEXT)', "INSERT INTO kids VALUES ('kyle', 'Kyle', '{\"name\":\"Kyle\"}')",
  'CREATE TABLE audit_log (id INTEGER PRIMARY KEY, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)',
  // As the site has it (scripts/schema.sql): the real partner changes write its columns too
  'CREATE TABLE partners (slug TEXT PRIMARY KEY, name TEXT NOT NULL, level TEXT, category TEXT, featured INTEGER DEFAULT 0, data TEXT NOT NULL, updated_at TEXT)', partnerRow('acme', { name: 'Acme Builders', level: 'friend', category: ['funding'], logo: '' }), partnerRow('pella', { name: 'Pella', level: 'friend', category: ['build'], logo: '' }),
  // The team, as Google's list has it: who can be an owner (the site's own account never)
  'CREATE TABLE staff_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)',
  `INSERT INTO staff_state (key, data) VALUES ('directory', '${JSON.stringify({ ok: true, accounts: [{ email: 'alex@soardcharity.com', aliases: [], name: 'Alex Rivera', active: true }, { email: 'jordan@soardcharity.com', aliases: [], name: 'Jordan Hale', active: true }, { email: 'automation@soardcharity.com', aliases: [], name: 'Agent Gracie', active: true }] })}')`,
  'CREATE TABLE check_gifts (id TEXT, zeffy_id TEXT, link TEXT)', "INSERT INTO check_gifts VALUES ('t1', 'jane_check', 'https://app.mercury.com/transactions/t1')"] });
const env = { DB, ZEFFY_API_KEY: 'z' };
// The heartbeat at 3 AM Eastern today: the window, and the whole history
const eastern3 = Date.parse(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(NOW))}T08:00:00Z`);
for (let i = 0; i < 10; i++) { const s = await D.maybeReadDonors(env, { now: eastern3 + i * 16 * 60e3 }); if (s?.filledAt && !s.fill) break; }

async function toRequest(req) {
  const chunks = [];
  if (req.method === 'POST') for await (const c of req) chunks.push(c);
  return new Request(`http://local${req.url}`, { method: req.method, headers: req.headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined });
}
const readBody = async (req) => { const chunks = []; for await (const c of req) chunks.push(c); try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { return {}; } };
const partnersNow = async () => ((await DB.prepare('SELECT slug, data FROM partners').all()).results || []).map((r) => ({ slug: r.slug, ...JSON.parse(r.data) }));
async function send(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}
const calls = [];
const saved = [];
// An answer lost on the way back (a 524): the change is made, and the page is told the site didn't answer
let lose = null;
// Every change the page sent (its act and state): a double click is one press
const posts = [];
// In another area of the admin (the walk serves Donors only): its errors aren't counted
let awayFromDonors = false;
// A slow answer: the change waits this long (ms) before it's made and answered
let slow = null;
function serve() {
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/donors-admin') {
      calls.push(u.search);
      const request = await toRequest(req);
      if (req.method === 'POST') posts.push(await request.clone().json().catch(() => ({})));
      if (req.method === 'POST' && slow) {
        const b = await request.clone().json().catch(() => ({}));
        const ms = slow(b);
        if (ms) { slow = null; await new Promise((r) => setTimeout(r, ms)); }
      }
      if (req.method === 'POST' && lose) {
        const b = await request.clone().json().catch(() => ({}));
        if (lose(b)) { lose = null; await donorsPost({ env, request, data: { userEmail: 'alex@soardcharity.com' } }); res.writeHead(524, { 'Content-Type': 'text/html' }); return res.end('<html>A timeout occurred</html>'); }
      }
      return send(res, req.method === 'POST' ? await donorsPost({ env, request, data: { userEmail: 'alex@soardcharity.com' } }) : await donorsGet({ env, request, data: { userEmail: 'alex@soardcharity.com' } }));
    }
    // Partners as the admin reads and saves them, over the same D1
    if (u.pathname === '/api/list-content' && /partners$/.test(u.searchParams.get('dir') || '')) {
      const items = (await partnersNow()).map(({ slug, ...c }) => ({ name: `${slug}.json`, path: `src/content/partners/${slug}.json`, sha: 'x', content: { slug, ...c } }));
      return send(res, Response.json({ success: true, items, count: items.length, total: items.length, pages: 1 }));
    }
    if (u.pathname === '/api/save-content' && req.method === 'POST') {
      const b = await readBody(req);
      const m = /^src\/content\/partners\/([a-z0-9-]+)\.json$/.exec(b.path || '');
      if (!m) return send(res, Response.json({ success: false, error: 'Path not allowed in this walk' }, { status: 403 }));
      await DB.prepare('INSERT OR REPLACE INTO partners (slug, name, level, data) VALUES (?, ?, ?, ?)').bind(m[1], JSON.parse(b.content).name || m[1], JSON.parse(b.content).level || 'friend', b.content).run();
      saved.push(m[1]);
      return send(res, Response.json({ success: true, sha: 'y' }));
    }
    // The real partner changes (functions/api/partners-batch.js), as the admin's Partners page makes them
    if (u.pathname === '/api/partners-batch' && req.method === 'POST') {
      const b = await readBody(req);
      const r = await updatePartners(env, b.updates, 'alex@soardcharity.com');
      return send(res, Response.json(r.body, { status: r.status }));
    }
    if (u.pathname === '/api/checks-admin') return send(res, Response.json({ success: true, list: [], waiting: 0, sending: true, joinOk: true, dontReasons: {}, writeTest: { ok: true }, limited: false, shown: 0, all: 0, configured: { mercury: true, zeffy: true, ai: true } }));
    if (u.pathname.startsWith('/api/list-content')) return send(res, Response.json({ success: true, items: [], total: 0, hasMore: false }));
    if (u.pathname.startsWith('/api/audit-log')) return send(res, Response.json({ success: true, entries: [], total: 0 }));
    if (u.pathname.startsWith('/api/deployments')) return send(res, Response.json({ success: true, deploys: [], source: 'cloudflare' }));
    if (u.pathname.startsWith('/api/')) return send(res, Response.json({ success: true, ok: true }));
    let p = decodeURIComponent(u.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(ROOT, 'public', p));
    if (!file.startsWith(join(ROOT, 'public')) || !existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

async function open(browser, origin, viewport, hash = '#donors') {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const errors = [];
  // (while the walk is in another area, which it doesn't serve, that area's errors aren't the Donors pages')
  page.on('console', (m) => { if (!awayFromDonors && m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  page.on('pageerror', (e) => { if (!awayFromDonors) errors.push(e.message); });
  // (the browser's own "leave with a note unsaved?" on a reload with words typed: answered, so a step never stalls)
  page.on('dialog', (d) => { d.accept().catch(() => {}); });
  await page.setRequestInterception(true);
  page.on('request', (req) => (new URL(req.url()).origin === origin ? req.continue() : req.abort()));
  await page.goto(`${origin}/admin/${hash}`, { waitUntil: 'networkidle2' });
  return { page, errors };
}
// Screenshots to show a person: a fixed window (a full-page capture resizes it and squashes the sidebar)
async function showShot(page, name, height = 1000) {
  const vp = page.viewport();
  await page.setViewport({ ...vp, height });
  await wait(600);
  // Without the walk's own messages piling up in the corner (it clicks faster than a person)
  await page.evaluate(() => { const st = document.createElement('style'); st.id = 'walk-no-toasts'; st.textContent = '[class*="toast"] { display: none !important; }'; document.head.append(st); });
  await page.screenshot({ path: join(OUT, `show-${name}.png`) });
  await page.evaluate(() => document.getElementById('walk-no-toasts')?.remove());
  await page.setViewport(vp);
  await wait(200);
}
const textOf = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
// The timeline's lines of one kind (a page's gifts, notes, the team's changes), as one text
const linesText = (page, kinds) => page.$$eval(kinds.map((k) => `.dn-tl__item[data-kind="${k}"]`).join(', '), (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()).join(' | ')).catch(() => '');
const giftsText = (page) => linesText(page, ['gift']);
const notesText = (page) => linesText(page, ['note']);
const teamText = (page) => linesText(page, ['team', 'thanks']);
const rowNames = (page) => page.$$eval('.dn-table tbody .dn-name', (els) => els.map((e) => e.textContent.trim()));
async function axe(page, label) {
  await wait(300);
  await page.evaluate(AXE);
  const r = await page.evaluate(async () => (await window.axe.run(document.querySelector('.dn'), { resultTypes: ['violations'] })).violations.map((v) => `${v.id}: ${v.nodes[0]?.html?.slice(0, 90)}`));
  ok(r.length === 0, `axe: no violations on ${label}${r.length ? `: ${r.join(', ')}` : ''}`);
}
async function phoneChecks(page, label) {
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(sideways <= 1, `${label}: no sideways scroll (${sideways}px)`);
  // Nothing runs off the right edge, clipped where the page can't scroll (what scrolls inside its own row is fine)
  const off = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const scrolls = (e) => { for (let a = e.parentElement; a && !a.matches('.main'); a = a.parentElement) if (/auto|scroll/.test(getComputedStyle(a).overflowX)) return true; return false; };
    return [...document.querySelectorAll('.dn, .dn *')].filter((e) => e.offsetParent && e.getBoundingClientRect().right > vw + 1 && !scrolls(e)).slice(0, 4).map((e) => `${e.tagName}.${String(e.className).split(' ')[0]} to ${Math.round(e.getBoundingClientRect().right)}px`);
  });
  ok(off.length === 0, `${label}: everything inside the screen's width${off.length ? `: ${off.join(', ')}` : ''}`);
  // A box inside its label is tapped by the label
  const small = await page.evaluate(() => [...document.querySelectorAll('.dn button, .dn a, .dn input, .dn select, .dn label')].map((e) => (e.matches('label input') ? e.closest('label') : e)).filter((e) => e.offsetParent && e.getBoundingClientRect().height < 40).map((e) => `${e.tagName} ${e.textContent.trim().slice(0, 20)} ${Math.round(e.getBoundingClientRect().height)}`));
  ok(small.length === 0, `${label}: touch targets 40px or more${small.length ? `: ${small.slice(0, 5).join(', ')}` : ''}`);
}

const server = await serve();
const origin = `http://localhost:${server.address().port}`;
const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
try {
  console.log('Donors');
  const { page, errors } = await open(browser, origin, { width: 1440, height: 1000 });
  await page.waitForSelector('.dn-table', { timeout: 15000 });
  ok(await page.$eval('.nav-item.active, [aria-current="page"]', (e) => /Donors & Partners/.test(e.textContent)).catch(() => false), 'Donors & Partners is the current place in the sidebar');
  ok(JSON.stringify(await page.$$eval('.hub-tab', (b) => b.map((x) => x.textContent.replace(/\d+/g, '').trim()))) === JSON.stringify(['Donors', 'Partners', 'Community partners', 'Checks']), 'the area’s tabs: Donors, Partners, Community partners, Checks');
  ok(/^Donors$/.test(await textOf(page, '.hub-tab.active')), 'the Donors tab is open');
  const pills = await page.$$eval('.ppl-filter', (b) => b.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  ok(pills[0] === 'Everyone 139' && pills[1] === 'Organizations 1' && /^New \d+$/.test(pills[2]) && /^Lapsed 1$/.test(pills[4]) && pills[5] === 'Not yet this year 0' && /^Needs you \d+$/.test(pills[6]), `people and organizations counted (${pills.join(' | ')}); a ticket buyer isn’t a donor; nothing to thank from before thank-yous began`);
  ok((await rowNames(page)).length === 100 && /Show 39 more of 139/.test(await textOf(page, '.dn-more')), 'the first 100, then Show more');
  const badge = () => page.$eval('.sidebar a[href="#donors"]', (a) => a.querySelector('.nav-count')?.textContent.trim() || '').catch(() => 'no link');
  ok(await badge() === '', 'no count on Donors & Partners in the sidebar while no gift waits for a thank-you');
  await page.screenshot({ path: join(OUT, 'people.png') });
  await showShot(page, '1-donors');
  await axe(page, 'the People list');
  // Search with "/"
  await page.keyboard.press('/');
  ok(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Search donors'), '“/” goes to the search');
  await page.keyboard.type('acme');
  await wait(200);
  ok(JSON.stringify(await rowNames(page)) === JSON.stringify(['Acme Builders']), 'a gift for a partner’s name counts for the partner');
  ok(/Friend partner/.test(await textOf(page, '.dn-table tbody tr')), 'the row says where it is on the website');
  await page.$eval('input[aria-label="Search donors"]', (i) => { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
  // Lapsed
  await page.evaluate(() => [...document.querySelectorAll('.ppl-filter')].find((b) => b.textContent.trim().startsWith('Lapsed'))?.click());
  await wait(200);
  ok(JSON.stringify(await rowNames(page)) === JSON.stringify(['Pat Quiet']) && /asked to be anonymous/.test(await textOf(page, '.dn-table tbody tr')), 'Lapsed: no gift in 18 months; anonymous is marked for staff');
  ok(/No gift in the last 18 months/.test(await textOf(page, '.dn-status')), 'the filter says what Lapsed means');
  await page.evaluate(() => [...document.querySelectorAll('.ppl-filter')].find((b) => b.textContent.trim().startsWith('Everyone'))?.click());
  await page.select('.dn-sort-by select', 'total');
  await wait(200);
  ok(JSON.stringify((await rowNames(page)).slice(0, 3)) === JSON.stringify(['Ann Ivers', 'Acme Builders', 'Jane Doe']), 'Most given: people and organizations together');

  console.log('A donor');
  await page.evaluate(() => [...document.querySelectorAll('.dn-name')].find((b) => b.textContent.trim() === 'Jane Doe')?.click());
  await page.waitForSelector('.dn-tl__list', { timeout: 8000 });
  ok((await page.evaluate(() => location.hash)) === '#donors/ct_jane', 'her page has an address of its own: her Zeffy contact');
  const tiles = await page.$$eval('.dn-tile', (t) => t.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  ok(tiles.some((t) => /^Largest gift\s*\$10,000/.test(t)) && tiles.some((t) => /^Years in a row\s*3$/.test(t)), `the $10,000 taken in three charges is one gift; three years in a row (${tiles.join(' | ')})`);
  const gifts = await giftsText(page);
  ok(/in 3 charges/.test(gifts) && !/Acme/.test(gifts) && /through Fidelity Charitable/.test(gifts) && /Makeovers/.test(gifts) && !/Kyle/.test(gifts), 'each gift says how it came; a kid’s campaign reads Makeovers; the Acme gift is Acme’s');
  ok(/Gave \$12,000 for Acme Builders/.test(await textOf(page, '.kd-rail')), 'what she gave for Acme shows on her page, counted for them');
  const links = await page.$$eval('.dn-tl__item[data-kind="gift"] a', (a) => a.map((x) => [x.textContent.trim(), x.getAttribute('href')]));
  ok(links.filter(([t]) => t === 'Open in Zeffy').every(([, h]) => /\/o\/all-payments\?transactionId=jane_/.test(h)) && links.filter(([t]) => t === 'Open in Zeffy').length === 5, 'every gift opens its own record in Zeffy');
  ok(links.some(([t, h]) => t === 'See the check in Mercury' && h === 'https://app.mercury.com/transactions/t1'), 'the check links its deposit in Mercury');
  ok(await page.$eval('.kd-rail a.btn', (a) => a.getAttribute('href')).then((h) => /\/o\/crm\/contacts\?contactId=ct_jane$/.test(h)).catch(() => false), 'Open in Zeffy opens her contact');
  ok(/Kit isn’t connected/.test(await textOf(page, '.kd-rail')), 'the newsletter line says when Kit can’t be asked');
  // The timeline: in place of Gifts, Notes and History
  ok(!(await page.$('.kd-card--history')) && !(await page.$('#dn-gifts-h')) && /^Timeline/.test(await textOf(page, '.dn-tl__head')), 'one Timeline in place of Gifts, Notes and History');
  await page.waitForFunction(() => /Read /.test(document.querySelector('.dn-tl__state')?.textContent || ''), { timeout: 8000 }).catch(() => {});
  ok(/Gmail, Google Calendar, Quo, Kit aren’t connected yet/.test(await textOf(page, '.dn-tl__notices')), `what can’t be read here says so, rather than the timeline looking quiet (${await textOf(page, '.dn-tl__notices')})`);
  const tlPills = await page.$$eval('.dn-tl__filters .pill', (b) => b.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  ok(tlPills[0].startsWith('Everything') && tlPills.some((p) => /^Gifts \d+$/.test(p)), `filters with counts (${tlPills.join(' · ')})`);
  ok(/In the last 12 months: \d+ gifts? \(\$[\d,]+\)/.test(await textOf(page, '.dn-gl__said')) && !!(await page.$('.dn-gl__svg')), `At a glance: the year in a sentence, and the strip (${await textOf(page, '.dn-gl__said')})`);
  await page.evaluate(() => document.querySelector('.dn-gl__svg')?.focus());
  await page.keyboard.press('End');
  await wait(100);
  const dayWords = await textOf(page, '.dn-gl__day');
  ok(/\d{4}: /.test(dayWords) && /Show in the list/.test(dayWords), `the strip by keys: End is the latest day, said in words (${dayWords})`);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.dn-tl__item.is-flash', { timeout: 3000 }).catch(() => {});
  ok(!!(await page.$('.dn-tl__item.is-flash')), 'Enter shows that day in the list, marked');
  ok(await page.$eval('.dn-tl__month h4', (h) => getComputedStyle(h).top) === '0px', 'a month’s heading sticks at the very top on a computer (no top bar there, so no gap with lines showing through)');
  await page.evaluate(() => [...document.querySelectorAll('.dn-tl__filters .pill')].find((b) => b.textContent.trim().startsWith('Gifts'))?.click());
  await wait(150);
  ok(await page.$$eval('.dn-tl__item', (els) => els.length > 0 && els.every((e) => ['gift', 'thanks'].includes(e.dataset.kind))), 'Gifts: only the gifts (and their thank-yous)');
  await page.evaluate(() => [...document.querySelectorAll('.dn-tl__filters .pill')].find((b) => b.textContent.trim().startsWith('Everything'))?.click());
  await wait(150);
  await page.screenshot({ path: join(OUT, 'donor.png'), fullPage: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await showShot(page, '4-a-person', 1100);
  await axe(page, 'a donor’s page');
  await page.evaluate(() => document.querySelector('.dn-back')?.click());
  await page.waitForSelector('.dn-table', { timeout: 8000 });
  ok((await page.evaluate(() => location.hash)) === '#donors', 'back to the list');

  console.log('Back keeps the place');
  await page.evaluate(() => [...document.querySelectorAll('.ppl-filter')].find((b) => b.textContent.trim().startsWith('Everyone'))?.click());
  await page.select('.dn-sort-by select', 'latest');
  await wait(200);
  await page.evaluate(() => document.querySelector('.dn-more button')?.click());
  await wait(200);
  const shownBefore = (await rowNames(page)).length;
  const far = await page.evaluate(() => { const b = document.querySelectorAll('.dn-table tbody .dn-name')[120]; b.scrollIntoView({ block: 'center' }); return b.textContent.trim(); });
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await page.evaluate((n) => [...document.querySelectorAll('.dn-name')].find((b) => b.textContent.trim() === n)?.focus(), far);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.dn-tl__list', { timeout: 8000 });
  await wait(300);
  ok(await page.evaluate((n) => document.activeElement?.tagName === 'H2' && document.activeElement.textContent.startsWith(n), far), 'opening a donor puts the focus on their name');
  await page.evaluate(() => document.querySelector('.dn-back')?.click());
  await page.waitForSelector('.dn-table', { timeout: 8000 });
  await wait(400);
  ok((await rowNames(page)).length === shownBefore, `Back shows as many as before (${shownBefore})`);
  ok(await page.evaluate((n) => document.activeElement?.classList.contains('dn-name') && document.activeElement.textContent.trim() === n, far), 'and the focus is back on the donor opened');
  ok(Math.abs((await page.evaluate(() => window.scrollY)) - scrollBefore) < 80, 'scrolled where it was');

  console.log('Links in');
  await page.goto(`${origin}/admin/#donors/gift/jane_split_b`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.dn-tl__list', { timeout: 8000 });
  ok((await page.evaluate(() => location.hash)) === '#donors/ct_jane', 'a link to one charge of a gift opens its donor, at her own address');
  ok(await page.evaluate(() => !!document.querySelector('[data-gifts~="jane_split_b"]')), 'the gift it named is on the page');
  await page.goto(`${origin}/admin/#donors`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.dn-table');
  await page.keyboard.press('/');
  await page.keyboard.type('sam lee');
  await wait(200);
  await page.evaluate(() => document.querySelector('.dn-name')?.click());
  await page.waitForSelector('.dn-tl__list', { timeout: 8000 });
  ok((await page.evaluate(() => location.hash)) === '#donors/gift/sam_1', 'a donor Zeffy has no contact for is addressed by a gift, never their email');
  await wait(300);
  ok(await page.evaluate(() => document.activeElement?.tagName === 'H2' && /Sam Lee/.test(document.activeElement.textContent) && !document.querySelector('.dn-tl__item.is-flash')), 'opened from the list: the focus on their name, no gift flashed');
  ok(!calls.some((c) => /%40|@/.test(c)), 'no email ever goes in a request to the site');
  ok(/Zeffy has no contact for these gifts/.test(await textOf(page, '.kd-rail')), 'and their page says Zeffy has no contact');
  await page.goto(`${origin}/admin/#job-costs/checks`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => location.hash === '#donors/checks', { timeout: 8000 }).catch(() => {});
  ok((await page.evaluate(() => location.hash)) === '#donors/checks' && /^Checks/.test(await textOf(page, '.hub-tab.active')), 'the old Job Costs address opens Checks in Donors & Partners');
  await page.goto(`${origin}/admin/#donors/gift/jane_acme`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => location.hash === '#donors/org/p%3Aacme', { timeout: 8000 }).catch(() => {});
  ok((await page.evaluate(() => location.hash)) === '#donors/org/p%3Aacme', 'a gift link from Slack for a gift that counts for Acme opens Acme');

  console.log('An organization');
  await page.waitForSelector('.dn-tl__list', { timeout: 8000 });
  ok(/Acme Builders/.test(await textOf(page, '.dn-head h2')) && /Friend partner/.test(await textOf(page, '.dn-head h2')), 'its name and where it is on the website');
  await page.waitForFunction(() => document.activeElement?.tagName === 'H2', { timeout: 3000 }).catch(() => {});
  ok(await page.evaluate(() => document.activeElement?.tagName === 'H2'), 'the focus on its name');
  const names = await textOf(page, '[aria-labelledby="dn-names-h"]');
  ok(/Acme Builders/.test(names) && /the same name, linked by itself/.test(names), `the Zeffy names it gives under, and why (${names.slice(0, 120)})`);
  ok(/Jane Doe/.test(await textOf(page, '[aria-labelledby="dn-people-h"]')) && /from Jane Doe/.test(await giftsText(page)), 'who gave for it, on the page and on each gift');
  ok(/Gave \$12,000 in the last 12 months/.test(await textOf(page, '.dn-suggest')), 'a Funding partner giving $10,000 in 12 months: Champion is suggested');
  await page.screenshot({ path: join(OUT, 'org.png'), fullPage: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await showShot(page, '3-an-organization', 1100);
  await axe(page, 'an organization’s page');
  await page.evaluate(() => [...document.querySelectorAll('.dn-suggest button')].find((b) => /Move to Champion/.test(b.textContent))?.click());
  await page.waitForSelector('.ask-overlay', { timeout: 4000 }).catch(() => {});
  ok(/JobTread/.test(await textOf(page, '.ask-overlay')) && await page.evaluate(() => document.activeElement?.getAttribute('data-ask') === 'no'), 'Move to Champion asks first (JobTread changes too), the focus on Cancel');
  // Its answer lost on the way back: it went through, and the page says so (never "couldn't" for a move that worked)
  lose = (b) => b.act === 'level' && b.move === true;
  await page.evaluate(() => document.querySelector('.ask-overlay [data-ask="yes"]')?.click());
  await page.waitForFunction(() => !document.querySelector('.dn-suggest'), { timeout: 8000 }).catch(() => {});
  ok((await partnersNow()).find((x) => x.slug === 'acme')?.level === 'champion', 'Acme is Champion (on the next publish)');
  ok(lose === null && !(await page.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => /Couldn’t move/.test(t.textContent)))), 'its answer lost on the way back: no “Couldn’t move” for a move that worked');
  ok(await page.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => /Acme Builders moves to Champion when you publish/.test(t.textContent) && [...t.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Publish'))), 'a partner’s level waits for Publish: its message offers Publish');
  ok(/Champion partner/.test(await textOf(page, '.dn-head h2')) && !(await page.$('.dn-suggest')), 'the page says Champion, and the suggestion is gone');
  await page.click('.kd-rail .dn-check input');
  await page.waitForFunction(() => /Kept anonymous/.test(document.querySelector('.dn-head h2')?.textContent || ''), { timeout: 6000 }).catch(() => {});
  ok(/Kept anonymous/.test(await textOf(page, '.dn-head h2')), 'Keep anonymous on the organization');
  await page.click('.kd-rail .dn-check input');
  await wait(800);
  // Add a Zeffy name: the picker, its axe, Escape back
  await page.evaluate(() => [...document.querySelectorAll('[aria-labelledby="dn-names-h"] button')].find((b) => /Add a Zeffy name/.test(b.textContent))?.click());
  await page.waitForSelector('.dn-picker', { timeout: 4000 });
  await wait(150);
  ok(await page.evaluate(() => document.activeElement?.matches('.dn-picker input')), 'the picker opens with the focus in its search box');
  await page.keyboard.type('sample');
  await page.waitForFunction(() => /Sample Builders/.test(document.querySelector('.dn-picker__list')?.textContent || ''), { timeout: 6000 }).catch(() => {});
  ok(/Sample Builders/.test(await textOf(page, '.dn-picker__list')) && /Lee Sample/.test(await textOf(page, '.dn-picker__list')), 'Add a Zeffy name finds company names and contacts');
  await axe(page, 'the Zeffy name picker');
  await page.keyboard.press('Escape');
  await wait(200);
  ok(!(await page.$('.dn-picker')), 'Escape closes it');

  console.log('Needs you');
  await page.goto(`${origin}/admin/#donors/needs`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.dn-needs', { timeout: 8000 });
  const needText = await textOf(page, '.dn-needs');
  ok(/Is “Pella Window & Door of Georgia” Pella\?/.test(needText) && /Same person\? Maria Lopez and Maria J\. Lopez/.test(needText) && /Ivers Foundation gave \$30,000/.test(needText), `a near name, one person twice, a big giver (${needText.slice(0, 160)})`);
  ok(/Is Lark & Wren Foundation an organization\?/.test(needText) && /It gave \$1,000 in all/.test(needText), 'a foundation under Champion’s amount that shows as a person is asked about too');
  await page.screenshot({ path: join(OUT, 'needs.png'), fullPage: true });
  await showShot(page, '2-needs-you');
  await axe(page, 'Needs you');
  const press = async (label) => { await page.evaluate((l) => [...document.querySelectorAll('.dn-need button')].find((b) => b.textContent.trim().startsWith(l))?.click(), label); await wait(1200); };
  await press('Yes, it’s Pella');
  ok(!/Pella Window/.test(await textOf(page, '.dn-needs, .dn-done')), 'Yes: asked no more');
  await press('Same person');
  ok(!/Maria/.test(await textOf(page, '.dn-needs, .dn-done')), 'Same person: asked no more');
  await press('Keep it as an organization');
  ok(!/Ivers/.test(await textOf(page, '.dn-needs, .dn-done')), 'Ivers kept as an organization: asked no more');
  await press('No, it’s a person');
  ok(/Nothing needs you/.test(await textOf(page, '.dn-done')), 'No, it’s a person: nothing left');
  ok(await page.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => /Lark & Wren Foundation stays a person/.test(t.textContent) && !/publish/i.test(t.textContent))), 'it says so, and offers no Publish (nothing here is on the website)');
  // The search from before is kept (Back keeps the place): cleared first
  await page.$eval('input[aria-label="Search donors"]', (i) => { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.evaluate(() => [...document.querySelectorAll('.ppl-filter')].find((b) => b.textContent.trim().startsWith('Organizations'))?.click());
  await wait(500);
  const orgs = await rowNames(page);
  ok(['Acme Builders', 'Ivers Foundation', 'Pella'].every((n) => orgs.includes(n)) && orgs.length === 3, `Organizations: Acme, Pella (linked), Ivers (kept here) (${orgs.join(', ')})`);
  ok((await rowNames(page)).length && (await page.evaluate(() => [...document.querySelectorAll('.ppl-filter')].find((b) => b.textContent.trim().startsWith('Everyone'))?.textContent.replace(/\s+/g, ' ').trim())) === 'Everyone 139', 'the two Marias are one; Pella and Ivers took their gifts from Lee and Ann');

  console.log('Put on the website');
  await page.evaluate(() => [...document.querySelectorAll('.dn-name')].find((b) => b.textContent.trim() === 'Ivers Foundation')?.click());
  await page.waitForSelector('.dn-tl__list', { timeout: 8000 });
  ok(/Not on the website/.test(await textOf(page, '.dn-head h2')), 'kept here, not on the website');
  await page.waitForFunction(() => document.activeElement?.tagName === 'H2', { timeout: 3000 }).catch(() => {});
  ok(await page.evaluate(() => document.activeElement?.tagName === 'H2' && /Ivers/.test(document.activeElement.textContent)), 'opened from the list: the focus on its name');
  await page.evaluate(() => [...document.querySelectorAll('.kd-rail button')].find((b) => /Put it on the website/.test(b.textContent))?.click());
  await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"]')].some((d) => /Add Ivers Foundation/.test(d.textContent)), { timeout: 6000 }).catch(() => {});
  ok(await page.evaluate(() => document.querySelector('#pt-new-name')?.value === 'Ivers Foundation'), 'Partners’ own Add dialog opens, with its name');
  ok(/under Funding/.test(await textOf(page, '[role="dialog"]')) && !/JobTread/.test(await textOf(page, '[role="dialog"]')), 'it says where they go, and nothing about a kid’s job');
  await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find((b) => /^Add partner$/.test(b.textContent.trim()))?.click());
  await page.waitForFunction(() => location.hash === '#donors/org/p%3Aivers-foundation', { timeout: 8000 }).catch(() => {});
  await page.waitForFunction(() => /Friend partner/.test(document.querySelector('.dn-head h2')?.textContent || ''), { timeout: 8000 }).catch(() => {});
  ok(saved.includes('ivers-foundation') && /Friend partner/.test(await textOf(page, '.dn-head h2')) && /\$30,000/.test(await textOf(page, '.dn-tiles')), 'its partner card is made and its gifts are the partner’s');
  // Its old address (the toast from when it was kept here) leads to the partner now
  await page.evaluate(() => [...document.querySelectorAll('.toast')].filter((t) => /Ivers Foundation is an organization here/.test(t.textContent)).at(-1)?.querySelectorAll('button').forEach((b) => { if (b.textContent.trim() === 'Open') b.click(); }));
  await page.waitForFunction(() => location.hash === '#donors/org/p%3Aivers-foundation' && /Friend partner/.test(document.querySelector('.dn-head h2')?.textContent || ''), { timeout: 8000 }).catch(() => {});
  ok((await page.evaluate(() => location.hash)) === '#donors/org/p%3Aivers-foundation', 'its old address leads to the partner');

  console.log('Rename and take out');
  await page.goto(`${origin}/admin/#donors/ct_lee`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.dn-tl__list', { timeout: 8000 });
  ok(/Gave \$800 for Pella/.test(await textOf(page, '.kd-rail')) && /Gave \$300 for Sample Builders/.test(await textOf(page, '.kd-rail')), 'Lee: what counts for Pella, and a company name not linked yet');
  // Link to…: every organization, read from the site (the ones kept here too)
  await page.evaluate(() => [...document.querySelectorAll('.kd-rail button')].find((b) => /Link to/.test(b.textContent))?.click());
  await page.waitForSelector('.dn-picker', { timeout: 4000 });
  await page.keyboard.type('a');
  await page.waitForFunction(() => /Acme Builders/.test(document.querySelector('.dn-picker__list')?.textContent || ''), { timeout: 6000 }).catch(() => {});
  const choices = await textOf(page, '.dn-picker__list');
  ok(/Acme Builders/.test(choices) && /Champion partner/.test(choices) && /Ivers Foundation/.test(choices), `Link to… lists every organization (${choices.slice(0, 120)})`);
  await page.keyboard.press('Escape');
  await wait(200);
  await page.evaluate(() => [...document.querySelectorAll('.kd-rail button')].find((b) => /Keep as an organization/.test(b.textContent))?.click());
  await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /Sample Builders is an organization here/.test(t.textContent)), { timeout: 6000 }).catch(() => {});
  await page.evaluate(() => [...document.querySelectorAll('.toast')].filter((t) => /Sample Builders is an organization here/.test(t.textContent)).at(-1)?.querySelectorAll('button').forEach((b) => { if (b.textContent.trim() === 'Open') b.click(); }));
  await page.waitForFunction(() => /Sample Builders/.test(document.querySelector('.dn-head h2')?.textContent || ''), { timeout: 8000 }).catch(() => {});
  await page.waitForFunction(() => /Sample Builders/.test(document.querySelector('.dn-head h2')?.textContent || '') && !!document.querySelector('.dn-tl__list'), { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => [...document.querySelectorAll('.kd-rail button')].find((b) => b.textContent.trim() === 'Rename')?.click());
  await page.waitForSelector('#dn-rename-input', { timeout: 4000 });
  await wait(150);
  ok(await page.evaluate(() => document.activeElement?.id === 'dn-rename-input'), 'Rename opens with the focus in the name');
  await axe(page, 'the rename dialog');
  await page.$eval('#dn-rename-input', (i) => { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.type('#dn-rename-input', 'Sample Builders Group');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /Sample Builders Group/.test(document.querySelector('.dn-head h2')?.textContent || ''), { timeout: 6000 }).catch(() => {});
  ok(/Sample Builders Group/.test(await textOf(page, '.dn-head h2')), 'renamed (staff only)');
  await page.evaluate(() => [...document.querySelectorAll('.kd-rail button')].find((b) => b.textContent.trim() === 'Take it out')?.click());
  await page.waitForSelector('.ask-overlay', { timeout: 4000 });
  await page.evaluate(() => document.querySelector('.ask-overlay [data-ask="yes"]')?.click());
  await page.waitForSelector('.dn-table', { timeout: 8000 });
  ok(!(await rowNames(page)).includes('Sample Builders Group'), 'taken out: back to the list, its gifts Lee’s again');

  console.log('The area’s tabs');
  await page.evaluate(() => [...document.querySelectorAll('.hub-tab')].find((b) => b.textContent.startsWith('Partners'))?.click());
  await page.waitForFunction(() => location.hash === '#partners', { timeout: 6000 }).catch(() => {});
  await page.waitForSelector('.hub-tab.active', { timeout: 8000 });
  await wait(600);
  await showShot(page, '5-partners-tab');
  ok(/^Partners/.test(await textOf(page, '.hub-tab.active')) && await page.$eval('.nav-item.active, [aria-current="page"]', (e) => /Donors & Partners/.test(e.textContent)).catch(() => false), 'Partners: its tab open, Donors & Partners still the place in the sidebar');
  ok(!(await page.$$eval('.nav-item', (n) => n.map((x) => x.textContent.trim()))).includes('Partners'), 'no Partners line of its own in the sidebar');
  await page.evaluate(() => [...document.querySelectorAll('.hub-tab')].find((b) => b.textContent.startsWith('Donors'))?.click());
  await page.waitForSelector('.dn-table', { timeout: 8000 });
  ok((await page.evaluate(() => location.hash)) === '#donors', 'and Donors brings it back');
  console.log('Same person as…');
  await page.goto(`${origin}/admin/#donors/ct_fill_120`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.dn-tl__list', { timeout: 8000 });
  await page.evaluate(() => [...document.querySelectorAll('.kd-rail button')].find((b) => /Same person as another donor/.test(b.textContent))?.click());
  await page.waitForSelector('.dn-picker', { timeout: 4000 });
  await wait(150);
  await page.keyboard.type('Donor 121');
  await page.waitForFunction(() => /Filler Donor 121/.test(document.querySelector('.dn-picker__list')?.textContent || ''), { timeout: 6000 }).catch(() => {});
  ok(!/Filler Donor 120/.test(await textOf(page, '.dn-picker__list')), 'the picker never offers the donor themselves');
  await page.evaluate(() => [...document.querySelectorAll('.dn-picker__item')].find((b) => /Filler Donor 121/.test(b.textContent))?.click());
  await page.waitForFunction(() => /Also in Zeffy as/.test(document.querySelector('.kd-rail')?.textContent || ''), { timeout: 8000 }).catch(() => {});
  ok(/Record 2 in Zeffy/.test(await textOf(page, '.kd-rail')) && /2 gifts/.test(await textOf(page, '.dn-tiles')), 'Same person as…: one donor, both records, both gifts');
  // And undone: Not the same person
  await page.evaluate(() => [...document.querySelectorAll('.kd-rail button')].find((b) => /Not the same person/.test(b.textContent))?.click());
  await page.waitForSelector('.ask-overlay', { timeout: 4000 });
  await page.evaluate(() => document.querySelector('.ask-overlay [data-ask="yes"]')?.click());
  await page.waitForFunction(() => !/Also in Zeffy as/.test(document.querySelector('.kd-rail')?.textContent || ''), { timeout: 8000 }).catch(() => {});
  ok(!/Also in Zeffy as/.test(await textOf(page, '.kd-rail')) && /1 gift/.test(await textOf(page, '.dn-tiles')), 'Not the same person: two donors again');

  console.log('To thank, owners, notes, the year-end list');
  // New gifts since thank-yous began: a check (Zeffy sends checks nothing), a $2,000 card gift, a $40 card gift; and a donor from last year
  const later = Math.max(NOW, eastern3) + 3 * 3600e3;
  for (const p of [
    pay({ id: 'rosa_chk', created: S(later - 2 * 3600e3), amount: 25000, method: 'cheque', type: 'manual', items: [], contact: 'ct_rosa', email: 'rosa@example.com', first: 'Rosa', last: 'Diaz' }),
    pay({ id: 'tom_big', created: S(later - 3600e3), amount: 200000, contact: 'ct_tom', email: 'tom@example.com', first: 'Tom', last: 'Banks' }),
    pay({ id: 'uma_small', created: S(later - 1800e3), amount: 4000, contact: 'ct_uma', email: 'uma@example.com', first: 'Uma', last: 'Small' }),
    pay({ id: 'yara_last', created: y(thisYear - 1, 5, 2), amount: 60000, contact: 'ct_yara', email: 'yara@example.com', first: 'Yara', last: 'Last' }),
  ]) { payments.push(p); await D.noteDonorPayment(env, p, { now: later }); }
  await page.goto(`${origin}/admin/#donors`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.dn-table', { timeout: 8000 });
  // The list shows the copy it read last at once, then reads again: wait for that read (the new donors in it)
  await page.waitForFunction(() => /Everyone 143/.test(document.querySelector('.ppl-filters')?.textContent.replace(/\s+/g, ' ') || ''), { timeout: 8000 }).catch(() => {});
  await wait(300);
  const pills2 = await page.$$eval('.ppl-filter', (b) => b.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  ok(pills2.includes('To thank 2') && pills2.includes('Not yet this year 1'), `To thank counts the check and the $2,000 gift, not the $40 one; the year-end list has last year’s donor (${pills2.join(' | ')})`);
  // The year-end list
  await page.evaluate(() => [...document.querySelectorAll('.ppl-filter')].find((b) => b.textContent.trim().startsWith('Not yet this year'))?.click());
  await wait(200);
  ok(JSON.stringify(await rowNames(page)) === JSON.stringify(['Yara Last']), 'Not yet this year: gave last year, nothing yet this year');
  ok(await page.$eval('.dn-sort-by select', (s) => s.value) === 'last' && /Last year/.test(await textOf(page, '.dn-table thead')) && /\$600/.test(await textOf(page, '.dn-table tbody tr')), 'it reads by last year’s giving, and shows it');
  ok(/gave in \d{4}, nothing yet in \d{4}/.test(await textOf(page, '.dn-status')), 'and says what the list is');
  await showShot(page, '9-not-yet-this-year');
  await page.evaluate(() => [...document.querySelectorAll('.ppl-filter')].find((b) => b.textContent.trim().startsWith('Everyone'))?.click());
  await wait(200);
  ok(await page.$eval('.dn-sort-by select', (s) => s.value) === 'latest', 'leaving it, the list reads by the latest gift again');
  // To thank
  await page.evaluate(() => [...document.querySelectorAll('.ppl-filter')].find((b) => b.textContent.trim().startsWith('To thank'))?.click());
  await page.waitForSelector('.dn-needs[aria-label="To thank"]', { timeout: 8000 });
  ok((await page.evaluate(() => location.hash)) === '#donors/thanks', 'To thank has an address of its own');
  const thanks = await page.$$eval('.dn-needs[aria-label="To thank"] .dn-need__q', (q) => q.map((x) => x.textContent.trim()));
  ok(JSON.stringify(thanks) === JSON.stringify(['Thank Rosa Diaz: $250', 'Thank Tom Banks: $2,000']), `the one waiting longest first (${thanks.join(' | ')})`);
  ok(/A check: Zeffy sends checks no thank-you/.test(await textOf(page, '.dn-needs')) && /\$1,000 or more/.test(await textOf(page, '.dn-needs')), 'each says why');
  ok(/No one looks after them yet/.test(await textOf(page, '.dn-needs')), 'and who looks after them');
  await showShot(page, '7-to-thank');
  await axe(page, 'To thank');
  ok(await badge() === '2', `the sidebar counts the gifts to thank on Donors & Partners (${await badge()})`);
  ok(/2 gifts wait for a thank-you/.test(await textOf(page, '.sidebar a[href="#donors"]')), 'and says so to a screen reader');
  // Thanked, then Undo: just after a website save elsewhere (the admin once took any message then as waiting for Publish)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('soard-content-changed')));
  await page.evaluate(() => [...document.querySelectorAll('.dn-need')].find((li) => /Rosa Diaz/.test(li.textContent))?.querySelector('.btn-primary')?.click());
  await page.waitForFunction(() => document.querySelectorAll('.dn-needs[aria-label="To thank"] .dn-need').length === 1, { timeout: 8000 }).catch(() => {});
  ok(/Thank Tom Banks/.test(await textOf(page, '.dn-needs')) && !/Rosa/.test(await textOf(page, '.dn-needs')), 'Thanked: off the list');
  await page.waitForFunction(() => /To thank 1/.test(document.querySelector('.ppl-filters')?.textContent.replace(/\s+/g, ' ') || ''), { timeout: 8000 }).catch(() => {});
  ok(/To thank 1/.test(await textOf(page, '.ppl-filters')), 'and the count goes down');
  await page.waitForFunction(() => document.querySelector('.sidebar a[href="#donors"] .nav-count')?.textContent.trim() === '1', { timeout: 6000 }).catch(() => {});
  ok(await badge() === '1', `the sidebar’s count goes down at once (${await badge()})`);
  const thankToast = await page.evaluate(() => [...document.querySelectorAll('.toast')].filter((t) => /Thanked: \$250 from Rosa Diaz/.test(t.textContent)).map((t) => ({ text: t.textContent, buttons: [...t.querySelectorAll('button')].map((b) => b.textContent.trim()) })).at(-1));
  ok(thankToast && !/publish/i.test(thankToast.text) && JSON.stringify(thankToast.buttons) === '["Undo"]', `a thank-you is never offered Publish, even just after a website save (${JSON.stringify(thankToast)})`);
  await page.evaluate(() => [...document.querySelectorAll('.toast')].filter((t) => /Thanked: \$250 from Rosa Diaz/.test(t.textContent)).at(-1)?.querySelectorAll('button').forEach((b) => { if (b.textContent.trim() === 'Undo') b.click(); }));
  await page.waitForFunction(() => document.querySelectorAll('.dn-needs[aria-label="To thank"] .dn-need').length === 2, { timeout: 8000 }).catch(() => {});
  ok(/Rosa Diaz/.test(await textOf(page, '.dn-needs')), 'Undo puts it back');
  await page.waitForFunction(() => document.querySelector('.sidebar a[href="#donors"] .nav-count')?.textContent.trim() === '2', { timeout: 6000 }).catch(() => {});
  ok(await badge() === '2', 'and the sidebar’s count with it');
  // His page, from the list
  await page.evaluate(() => [...document.querySelectorAll('.dn-need')].find((li) => /Tom Banks/.test(li.textContent))?.querySelectorAll('a').forEach((a) => { if (a.textContent.trim() === 'Open Tom Banks') a.click(); }));
  await page.waitForSelector('.dn-thank', { timeout: 8000 });
  await page.waitForFunction(() => location.hash === '#donors/ct_tom', { timeout: 6000 }).catch(() => {});
  ok((await page.evaluate(() => location.hash)) === '#donors/ct_tom', 'Open goes to his page, at his own address');
  ok(await page.evaluate(() => window.scrollY < 80 && document.querySelector('.dn-thank').getBoundingClientRect().top < window.innerHeight), 'opened from To thank: his page from the top, the To thank box in sight (not scrolled to the gift)');
  ok(/To thank 1/.test(await textOf(page, '.dn-thank')) && /\$2,000/.test(await textOf(page, '.dn-thank')), 'his page says what to thank him for, at the top');
  ok(/To thank/.test(await giftsText(page)), 'and the gift says so too');
  // Owner
  const ownerOptions = await page.$$eval('#dn-owner-pick option', (o) => o.map((x) => x.textContent.trim()));
  ok(JSON.stringify(ownerOptions) === JSON.stringify(['No one yet', 'Alex Rivera', 'Jordan Hale']), `the team to pick from, not the site’s own account (${ownerOptions.join(', ')})`);
  await page.select('#dn-owner-pick', 'alex@soardcharity.com');
  await page.waitForFunction(() => /Looked after by Alex Rivera/.test([...document.querySelectorAll('.dn-tl__item[data-kind="team"], .dn-tl__item[data-kind="thanks"]')].map((e) => e.textContent).join(' ')), { timeout: 8000 }).catch(() => {});
  ok(await page.$eval('#dn-owner-pick', (s) => s.value) === 'alex@soardcharity.com', 'Owner: Alex looks after him');
  // Read in the order it shows: from Owner, the next stop is what shows right after it (just below, in its column),
  // never a card far down the page with the page's own column skipped
  const nextAfterOwner = await page.evaluate(() => {
    const all = [...document.querySelectorAll('.kd-layout a[href], .kd-layout button, .kd-layout select, .kd-layout textarea, .kd-layout input')].filter((e) => !e.disabled && e.getClientRects().length);
    const o = document.querySelector('#dn-owner-pick');
    const n = all[all.indexOf(o) + 1];
    const a = o.getBoundingClientRect();
    const b = n?.getBoundingClientRect() || { top: 0, left: 0 };
    return { dy: Math.round(b.top - a.top), dx: Math.round(b.left - a.left), inMain: !!n?.closest('.kd-main') };
  });
  ok(nextAfterOwner.dy > 0 && nextAfterOwner.dy < 700 && Math.abs(nextAfterOwner.dx) < 80, `Tab from Owner goes to what shows right after it (${JSON.stringify(nextAfterOwner)})`);
  // And on a narrow screen (one column), the page's own column comes right after Owner
  await page.setViewport({ width: 900, height: 900 });
  await wait(400);
  const narrowNext = await page.evaluate(() => {
    const all = [...document.querySelectorAll('.kd-layout a[href], .kd-layout button, .kd-layout select, .kd-layout textarea, .kd-layout input')].filter((e) => !e.disabled && e.getClientRects().length);
    const o = document.querySelector('#dn-owner-pick');
    const n = all[all.indexOf(o) + 1];
    return { inMain: !!n?.closest('.kd-main'), dy: Math.round((n?.getBoundingClientRect().top || 0) - o.getBoundingClientRect().top) };
  });
  ok(narrowNext.inMain && narrowNext.dy > 0 && narrowNext.dy < 700, `one column: Tab from Owner goes to the page’s own column, right below (${JSON.stringify(narrowNext)})`);
  await page.setViewport({ width: 1440, height: 1000 });
  await wait(300);
  ok(/Looked after by Alex Rivera/.test(await teamText(page)), 'the timeline says who did what, at once (no reading again)');
  // Notes
  await page.click('#dn-note-text');
  await page.keyboard.type('Called to say thank you. He wants to see a reveal.');
  await page.keyboard.down('Control');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Control');
  await page.waitForFunction(() => document.querySelectorAll('.dn-tl__item[data-kind="note"]').length === 1, { timeout: 8000 }).catch(() => {});
  ok(/Called to say thank you\. He wants to see a reveal\./.test(await notesText(page)) && /Alex Rivera wrote a note/.test(await notesText(page)), 'a note, saved with Ctrl+Enter, with who and when');
  ok(await page.$eval('#dn-note-text', (t) => t.value === '' && document.activeElement === t), 'the box empties and keeps the focus for the next one');
  await page.evaluate(() => [...document.querySelectorAll('.dn-tl__item[data-kind="note"] button')].find((b) => b.textContent.trim() === 'Change')?.click());
  await page.waitForSelector('.dn-tl__item[data-kind="note"] textarea', { timeout: 4000 });
  await page.$eval('.dn-tl__item[data-kind="note"] textarea', (t) => { t.value = 'Called to thank him. He wants to see a reveal in March.'; t.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.evaluate(() => [...document.querySelectorAll('.dn-tl__item[data-kind="note"] button')].find((b) => b.textContent.trim() === 'Save')?.click());
  await page.waitForFunction(() => /in March/.test([...document.querySelectorAll('.dn-tl__item[data-kind="note"]')].map((e) => e.textContent).join(' ')) && !document.querySelector('.dn-tl__item[data-kind="note"] textarea'), { timeout: 8000 }).catch(() => {});
  ok(/in March/.test(await notesText(page)) && /changed/.test(await notesText(page)), 'Change: the new words, marked changed');
  // The mark on the gift the link opened at goes by itself, changes on the page or not
  await page.waitForFunction(() => !document.querySelector('.dn-tl__item.is-flash'), { timeout: 5000 }).catch(() => {});
  const jump = await page.evaluate(() => ({ flash: !!document.querySelector('.dn-tl__item.is-flash'), note: Math.round(document.querySelector('.dn-tl__item[data-kind="note"]')?.getBoundingClientRect().top), gift: Math.round(document.querySelector('.dn-tl__item[data-kind="gift"]')?.getBoundingClientRect().top), h: window.innerHeight, y: Math.round(window.scrollY) }));
  ok(!jump.flash && jump.note >= 0 && jump.note < jump.h, `a change never jumps the page back to the gift the link opened at (${JSON.stringify(jump)})`);
  ok(!/in March/.test(await teamText(page)) && !/Note (added|changed)/.test(await teamText(page)), 'the team’s changes never repeat a note: the note is on the timeline as itself');
  await page.evaluate(() => window.scrollTo(0, 0));
  await showShot(page, '8-a-donor-to-thank-owner-notes', 1250);
  await axe(page, 'a donor with an owner, a note and a gift to thank');
  // Thanked on his page
  await page.evaluate(() => document.querySelector('.dn-thank .btn-primary')?.click());
  await page.waitForFunction(() => !document.querySelector('.dn-thank'), { timeout: 8000 }).catch(() => {});
  ok(!(await page.$('.dn-thank')) && /Thanked [A-Z][a-z]{2} \d+ by Alex/.test(await giftsText(page)), 'Thanked on his page: the box goes, the gift says when and by whom');
  // (the timeline's own lines read again once the page has: a moment after)
  await page.waitForFunction(() => /Thanked: \$2,000 from Tom Banks/.test([...document.querySelectorAll('.dn-tl__item[data-kind="team"], .dn-tl__item[data-kind="thanks"]')].map((e) => e.textContent).join(' ')), { timeout: 8000 }).catch(() => {});
  ok(/Thanked: \$2,000 from Tom Banks/.test(await teamText(page)), 'and the timeline has it, said by whom and when');
  // Delete the note, after asking
  await page.evaluate(() => [...document.querySelectorAll('.dn-tl__item[data-kind="note"] button')].find((b) => b.textContent.trim() === 'Delete')?.click());
  await page.waitForSelector('.ask-overlay', { timeout: 4000 });
  await page.evaluate(() => document.querySelector('.ask-overlay [data-ask="yes"]')?.click());
  await page.waitForFunction(() => !document.querySelector('.dn-tl__item[data-kind="note"]'), { timeout: 8000 }).catch(() => {});
  ok(!(await page.$('.dn-tl__item[data-kind="note"]')), 'Delete, after asking: the note is gone');
  // Opened from To thank: Back says so and goes there (working down the list), and the list is a pill away
  ok(/← To thank/.test(await textOf(page, '.dn-back')), `Back says where it goes (${await textOf(page, '.dn-back')})`);
  await page.evaluate(() => document.querySelector('.dn-back')?.click());
  await page.waitForSelector('.dn-needs[aria-label="To thank"], .dn-done', { timeout: 8000 });
  ok((await page.evaluate(() => location.hash)) === '#donors/thanks', 'Back from a donor opened from To thank: To thank again');
  // (his gift thanked on his page: the one that took its place has the focus, to work on down the list)
  await page.waitForFunction(() => document.activeElement?.closest('.dn-needs[aria-label="To thank"] > li'), { timeout: 4000 }).catch(() => {});
  await wait(300);
  ok(await page.evaluate(() => !!document.activeElement?.closest('.dn-needs[aria-label="To thank"] > li') && !/Tom Banks/.test(document.activeElement.closest('li').textContent)), `and the focus on the gift that took his place, never lost to the page (${await page.evaluate(() => `${document.activeElement?.tagName} "${(document.activeElement?.textContent || '').slice(0, 40)}"`)})`);
  // The list by owner
  await page.evaluate(() => [...document.querySelectorAll('.ppl-filter')].find((b) => b.textContent.trim().startsWith('Everyone'))?.click());
  await page.waitForSelector('.dn-table', { timeout: 8000 });
  ok(JSON.stringify(await page.$$eval('.dn-owner-filter option', (o) => o.map((x) => x.textContent.trim()))) === JSON.stringify(['Anyone', 'Me', 'No one', 'Jordan Hale']), 'Owner: Anyone, Me, No one, then the team');
  await page.select('.dn-owner-filter select', 'alex@soardcharity.com');
  await wait(250);
  ok(JSON.stringify(await rowNames(page)) === JSON.stringify(['Tom Banks']) && /Alex/.test(await textOf(page, '.dn-table tbody tr')), 'Owner: Me shows the donors Alex looks after, and says so in the row');
  ok(/Looked after by you/.test(await textOf(page, '.dn-status')), 'and the line above says so');
  await page.select('.dn-owner-filter select', '');
  await wait(150);

  console.log('Found in review');
  // The To thank count follows the Owner filter like every other count: Rosa's gift (no one looks after her)
  await page.select('.dn-owner-filter select', 'alex@soardcharity.com');
  await wait(250);
  ok(/To thank 0/.test(await textOf(page, '.ppl-filters')), `To thank counts what the Owner filter shows (${await textOf(page, '.ppl-filters')})`);
  await page.select('.dn-owner-filter select', 'none');
  await wait(250);
  ok(/To thank 1/.test(await textOf(page, '.ppl-filters')), 'No one: Rosa’s gift');
  await page.select('.dn-owner-filter select', '');
  await wait(150);
  // One donor's address, then another's: the second donor's page, nothing of the first left open on it; Back, the first
  const h2 = (name) => page.waitForFunction((n) => (document.querySelector('.dn-head h2')?.textContent || '').includes(n), { timeout: 8000 }, name).catch(() => {});
  await page.evaluate(() => { location.hash = '#donors/ct_uma'; });
  await h2('Uma Small');
  await page.evaluate(() => [...document.querySelectorAll('.dn button')].find((b) => /Count it for an organization|Add a Zeffy name|Same person as/.test(b.textContent))?.click());
  await page.waitForSelector('.dn-picker', { timeout: 4000 }).catch(() => {});
  const pickerWas = !!(await page.$('.dn-picker'));
  await page.evaluate(() => { location.hash = '#donors/ct_rosa'; });
  await h2('Rosa Diaz');
  ok(pickerWas && !(await page.$('.dn-picker')) && /Rosa Diaz/.test(await textOf(page, '.dn-head h2')), 'another donor’s address: their page, with nothing of the one before left open on it');
  await page.evaluate(() => history.back());
  await h2('Uma Small');
  ok((await page.evaluate(() => location.hash)) === '#donors/ct_uma' && /Uma Small/.test(await textOf(page, '.dn-head h2')), 'Back: the first donor again, at their address');
  // The Owner picker keeps the focus while it saves (a disabled one drops it to the page)
  await page.evaluate(() => { location.hash = '#donors/ct_rosa'; });
  await h2('Rosa Diaz');
  await page.focus('#dn-owner-pick');
  await page.select('#dn-owner-pick', 'jordan@soardcharity.com');
  await page.waitForFunction(() => /Looked after by Jordan Hale/.test([...document.querySelectorAll('.dn-tl__item[data-kind="team"], .dn-tl__item[data-kind="thanks"]')].map((e) => e.textContent).join(' ')), { timeout: 8000 }).catch(() => {});
  ok(await page.evaluate(() => document.activeElement?.id === 'dn-owner-pick'), 'the Owner picker keeps the focus');
  // Escape leaves a note's change, the focus back on its Change
  await page.click('#dn-note-text');
  await page.keyboard.type('Asked for a tour.');
  await page.evaluate(() => [...document.querySelectorAll('.dn-note-new button')].find((b) => b.textContent.trim() === 'Add note')?.click());
  await page.waitForSelector('.dn-tl__item[data-kind="note"] .dn-note__change', { timeout: 8000 }).catch(() => {});
  await page.click('.dn-tl__item[data-kind="note"] .dn-note__change');
  await page.waitForSelector('.dn-tl__item[data-kind="note"] textarea', { timeout: 4000 }).catch(() => {});
  await page.keyboard.press('Escape');
  await wait(200);
  ok(!(await page.$('.dn-tl__item[data-kind="note"] textarea')) && await page.evaluate(() => document.activeElement?.classList.contains('dn-note__change')), 'Escape leaves a change to a note, the focus back on its Change');
  // Thanked on To thank, then Undo from somewhere else: every count and list agrees again
  await page.evaluate(() => { location.hash = '#donors/thanks'; });
  await page.waitForSelector('.dn-needs[aria-label="To thank"] .dn-need', { timeout: 8000 });
  await page.evaluate(() => document.querySelector('.dn-needs[aria-label="To thank"] .dn-need .btn-primary')?.click());
  await page.waitForSelector('.dn-done', { timeout: 8000 }).catch(() => {});
  ok(await page.evaluate(() => document.activeElement?.matches('.dn-done')), 'the last one said: the focus on the words saying nothing is left');
  await page.evaluate(() => { location.hash = '#donors'; });
  await page.waitForSelector('.dn-table', { timeout: 8000 });
  await page.evaluate(() => [...document.querySelectorAll('.toast')].filter((t) => /Thanked: \$250 from Rosa Diaz/.test(t.textContent)).at(-1)?.querySelectorAll('button').forEach((b) => { if (b.textContent.trim() === 'Undo') b.click(); }));
  await page.waitForFunction(() => /To thank 1/.test(document.querySelector('.ppl-filters')?.textContent.replace(/\s+/g, ' ') || '') && document.querySelector('.sidebar a[href="#donors"] .nav-count')?.textContent.trim() === '1', { timeout: 8000 }).catch(() => {});
  ok(/To thank 1/.test(await textOf(page, '.ppl-filters')) && await badge() === '1', `Undo from another page: the list’s count and the sidebar’s agree (${await textOf(page, '.ppl-filters')} | ${await badge()})`);
  // Opened from To thank, then a link elsewhere (a Slack gift link in the same tab): Back is to the list, the gift marked
  await page.evaluate(() => { location.hash = '#donors/thanks'; });
  await page.waitForSelector('.dn-needs[aria-label="To thank"] .dn-need a', { timeout: 8000 });
  await page.evaluate(() => [...document.querySelectorAll('.dn-needs[aria-label="To thank"] .dn-need a')].find((a) => /^Open /.test(a.textContent.trim()))?.click());
  await page.waitForSelector('.dn-head h2', { timeout: 8000 });
  ok(/← To thank/.test(await textOf(page, '.dn-back')), 'opened from To thank: Back says To thank');
  await page.evaluate(() => { location.hash = '#donors/gift/jane_acme'; });
  await page.waitForFunction(() => /← Donors|← /.test(document.querySelector('.dn-back')?.textContent || '') && !!document.querySelector('.dn-tl__list, .dn-head'), { timeout: 8000 }).catch(() => {});
  await wait(600);
  ok(/← Donors/.test(await textOf(page, '.dn-back')), `a link followed after that: Back is to the list again (${await textOf(page, '.dn-back')})`);
  // ─── Found in the seventh round ───
  // An owner and Keep anonymous whose answers are lost on the way back: the page reads again and shows what was saved
  await page.evaluate(() => { location.hash = '#donors/ct_fill_7'; });
  await page.waitForSelector('#dn-owner-pick', { timeout: 8000 });
  lose = (b) => b.act === 'owner';
  await page.evaluate(() => { const s = document.querySelector('#dn-owner-pick'); s.value = 'jordan@soardcharity.com'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForFunction(() => document.querySelector('#dn-owner-pick')?.value === 'jordan@soardcharity.com' && !document.querySelector('#dn-owner-pick[aria-busy="true"]'), { timeout: 8000 }).catch(() => {});
  await wait(400);
  ok(await page.$eval('#dn-owner-pick', (s) => s.value) === 'jordan@soardcharity.com', 'an owner saved whose answer was lost: the page shows Jordan, as saved');
  lose = (b) => b.act === 'anon';
  await page.click('.kd-rail .dn-check input');
  await page.waitForFunction(() => document.querySelector('.kd-rail .dn-check input')?.checked && /Kept anonymous/.test(document.querySelector('.dn-head h2')?.textContent || ''), { timeout: 8000 }).catch(() => {});
  ok(await page.$eval('.kd-rail .dn-check input', (i) => i.checked) && /Kept anonymous/.test(await textOf(page, '.dn-head h2')), 'Keep anonymous saved whose answer was lost: the box shows it on, as saved');
  // A note a teammate changed while it was being changed: the person's words stay, the note as it is now above them
  await page.click('#dn-note-text');
  await page.keyboard.type('Likes the gala.');
  await page.evaluate(() => [...document.querySelectorAll('.dn-note-new button')].find((b) => b.textContent.trim() === 'Add note')?.click());
  await page.waitForSelector('.dn-tl__item[data-kind="note"] .dn-note__change', { timeout: 8000 });
  await page.click('.dn-tl__item[data-kind="note"] .dn-note__change');
  await page.waitForSelector('.dn-tl__item[data-kind="note"] textarea', { timeout: 4000 });
  await DB.prepare("UPDATE donor_notes SET body = 'Likes the gala; bring a guest.', edited_by = 'jordan@soardcharity.com' WHERE body = 'Likes the gala.'").run();
  await page.keyboard.press('End');
  await page.keyboard.type(' Call in May.');
  await page.evaluate(() => [...document.querySelectorAll('.dn-tl__item[data-kind="note"] button')].find((b) => b.textContent.trim() === 'Save')?.click());
  await page.waitForFunction(() => /It reads now/.test([...document.querySelectorAll('.dn-tl__item[data-kind="note"]')].map((e) => e.textContent).join(' ')), { timeout: 8000 }).catch(() => {});
  ok(/Call in May/.test(await page.$eval('.dn-tl__item[data-kind="note"] textarea', (t) => t.value).catch(() => '')) && /bring a guest/.test(await notesText(page)), 'a note changed by a teammate meanwhile: the person’s words stay in the box, the note as it is now above them');
  await DB.prepare("DELETE FROM donor_notes WHERE body = 'Likes the gala; bring a guest.'").run();
  await page.evaluate(() => [...document.querySelectorAll('.dn-tl__item[data-kind="note"] button')].find((b) => b.textContent.trim() === 'Save')?.click());
  await page.waitForFunction(() => /Call in May/.test(document.querySelector('#dn-note-text')?.value || ''), { timeout: 8000 }).catch(() => {});
  ok(/Call in May/.test(await page.$eval('#dn-note-text', (t) => t.value)), 'deleted meanwhile: the person’s words go to the new note box');
  // (the words cleared from the box, so the moves that follow don't ask about a note)
  await page.click('#dn-note-text', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await wait(200);
  // Someone whose every gift counts for an organization is found by their own name, at the organization's row
  await C.act(env, { act: 'link', kind: 'contact', subject: 'ct_fill_5', org: 'p:pella' }, 'alex@soardcharity.com');
  await page.goto(`${origin}/admin/#donors`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.dn-table', { timeout: 15000 });
  await page.click('input[aria-label="Search donors"]', { clickCount: 3 });
  await page.keyboard.type('Donor 005');
  await wait(400);
  ok((await rowNames(page)).includes('Pella') && /given by Filler Donor 005/.test(await textOf(page, '.dn-table tbody')), `a giver whose gifts all count for an organization is found at its row (${(await rowNames(page)).join(', ')})`);
  await page.click('input[aria-label="Search donors"]', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  // Undo from a toast by keyboard: the focus on the thank-you put back, never on a heading no one sees
  await page.evaluate(() => { location.hash = '#donors/thanks'; });
  await page.waitForSelector('.dn-needs[aria-label="To thank"] [data-thank] .btn-primary', { timeout: 8000 }).catch(() => {});
  const undoId = await page.evaluate(() => document.querySelector('.dn-needs[aria-label="To thank"] [data-thank]')?.dataset.thank || '');
  await page.evaluate(() => document.querySelector('.dn-needs[aria-label="To thank"] [data-thank] .btn-primary')?.click());
  await page.waitForFunction(() => [...document.querySelectorAll('.toast .toast-undo')].length, { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => [...document.querySelectorAll('.toast .toast-undo')].at(-1)?.focus());
  await page.keyboard.press('Enter');
  await page.waitForFunction((id) => document.activeElement?.closest?.(`[data-thank="${id}"]`), { timeout: 8000 }, undoId).catch(() => {});
  const undoAt = await page.evaluate(() => ({ at: document.activeElement?.outerHTML.slice(0, 80), items: [...document.querySelectorAll('[data-thank]')].map((li) => li.dataset.thank), toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim().slice(0, 50)) }));
  ok(!!undoId && await page.evaluate((id) => !!document.activeElement?.closest?.(`[data-thank="${id}"]`), undoId), `Undo from a toast by keyboard: the focus on the thank-you put back (${undoId} ${JSON.stringify(undoAt)})`);
  // Thanked whose answer is lost on the way back: it's sent once more and says what happened (Thanked, with Undo);
  // then ⌘Z / Ctrl+Z is its Undo, the focus on the thank-you put back
  lose = (b) => b.act === 'thanks' && b.state === 'thanked';
  const lostId = await page.evaluate(() => document.querySelector('.dn-needs[aria-label="To thank"] [data-thank]')?.dataset.thank || '');
  await page.evaluate(() => document.querySelector('.dn-needs[aria-label="To thank"] [data-thank] .btn-primary')?.click());
  await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /^Thanked:/.test(t.textContent.trim())), { timeout: 8000 }).catch(() => {});
  ok(!!lostId && lose === null && await page.evaluate(() => { const ts = [...document.querySelectorAll('.toast')]; return ts.some((t) => /^Thanked:/.test(t.textContent.trim()) && t.querySelector('.toast-undo')) && !ts.some((t) => /didn’t answer/.test(t.textContent)); }), 'Thanked whose answer was lost: “Thanked” with its Undo, never “didn’t answer” for one that saved');
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
  await page.keyboard.press('z');
  await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
  await page.waitForFunction((id) => document.activeElement?.closest?.(`[data-thank="${id}"]`), { timeout: 8000 }, lostId).catch(() => {});
  ok(await page.evaluate((id) => !!document.activeElement?.closest?.(`[data-thank="${id}"]`), lostId), '⌘Z / Ctrl+Z undoes it: back on the list, the focus on it');
  // A double click on Thanked is one press: the item that moves up under the pointer isn't thanked too
  await page.waitForSelector('.dn-needs[aria-label="To thank"] [data-thank] .btn-primary', { timeout: 8000 }).catch(() => {});
  const before = posts.filter((b) => b.act === 'thanks' && b.state === 'thanked').length;
  const box = await page.$eval('.dn-needs[aria-label="To thank"] [data-thank] .btn-primary', (b) => { const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }).catch(() => null);
  if (box) await page.mouse.click(box.x, box.y, { clickCount: 1 });
  await wait(250);
  if (box) await page.mouse.click(box.x, box.y, { clickCount: 2 });
  await wait(1500);
  ok(!!box && posts.filter((b) => b.act === 'thanks' && b.state === 'thanked').length - before === 1, `a double click on Thanked thanks one gift (${posts.filter((b) => b.act === 'thanks' && b.state === 'thanked').length - before})`);
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
  await page.keyboard.press('z');
  await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
  await wait(800);
  // A held Enter is one press: its repeats never answer the item that takes the focus next
  await page.waitForSelector('.dn-needs[aria-label="To thank"] [data-thank] .btn-primary', { timeout: 8000 }).catch(() => {});
  const heldBefore = posts.filter((b) => b.act === 'thanks' && b.state === 'thanked').length;
  await page.focus('.dn-needs[aria-label="To thank"] [data-thank] .btn-primary').catch(() => {});
  await page.keyboard.down('Enter');
  for (let i = 0; i < 12; i++) { await wait(60); await page.keyboard.down('Enter'); }
  await page.keyboard.up('Enter');
  await wait(1200);
  ok(posts.filter((b) => b.act === 'thanks' && b.state === 'thanked').length - heldBefore === 1, `a held Enter on Thanked thanks one gift (${posts.filter((b) => b.act === 'thanks' && b.state === 'thanked').length - heldBefore})`);
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
  await page.keyboard.press('z');
  await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
  await wait(800);
  // The page changing columns (the window made narrower) keeps the focus where it was: typing goes on
  await page.evaluate(() => { location.hash = '#donors/ct_fill_9'; });
  await page.waitForSelector('#dn-note-text', { timeout: 8000 });
  await page.click('#dn-note-text');
  await page.keyboard.type('Met at the');
  await page.setViewport({ width: 900, height: 900 });
  await wait(500);
  await page.keyboard.type(' gala');
  ok(await page.$eval('#dn-note-text', (t) => t.value) === 'Met at the gala' && await page.evaluate(() => document.activeElement?.id === 'dn-note-text'), `the window made narrower: the note box keeps the focus, and the typing (${await page.$eval('#dn-note-text', (t) => t.value)})`);
  await page.setViewport({ width: 1440, height: 1000 });
  await wait(300);
  // Browser Back with the note typed: the page goes (nothing asks), and coming back the words are in the box
  const hereNow = await page.evaluate(() => location.hash);
  await page.evaluate(() => history.back());
  await page.waitForFunction((h) => location.hash !== h, { timeout: 6000 }, hereNow).catch(() => {});
  ok(!(await page.$('.ask-overlay')) && await page.evaluate((h) => location.hash !== h, hereNow), 'Back with a note typed: the page goes, nothing asks');
  await page.evaluate(() => history.forward());
  await page.waitForFunction(() => /Met at the gala/.test(document.querySelector('#dn-note-text')?.value || ''), { timeout: 8000 }).catch(() => {});
  ok(await page.evaluate((h) => location.hash === h, hereNow) && await page.$eval('#dn-note-text', (t) => t.value).catch(() => '') === 'Met at the gala', 'back on the page: the words typed are in the box again');
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#dn-note-text', { timeout: 8000 });
  ok(await page.$eval('#dn-note-text', (t) => t.value) === 'Met at the gala', 'and after a reload too');
  await page.click('#dn-note-text', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  // A note half written, then Count it for an organization: the page becomes the organization's, the words go with it
  await page.click('#dn-note-text');
  await page.keyboard.type('Wants a tour of a finished room');
  await wait(300);
  await page.evaluate(() => [...document.querySelectorAll('.dn button')].find((b) => /Count it for an organization/.test(b.textContent))?.click());
  await page.waitForSelector('.dn-picker input', { timeout: 5000 });
  await page.type('.dn-picker input', 'Acme');
  await page.waitForFunction(() => [...document.querySelectorAll('.dn-picker__item')].some((b) => /Acme Builders/.test(b.textContent)), { timeout: 6000 }).catch(() => {});
  await page.evaluate(() => [...document.querySelectorAll('.dn-picker__item')].find((b) => /Acme Builders/.test(b.textContent))?.click());
  await page.waitForFunction(() => /Acme Builders/.test(document.querySelector('.dn-head h2')?.textContent || ''), { timeout: 8000 }).catch(() => {});
  await page.waitForSelector('#dn-note-text', { timeout: 8000 }).catch(() => {});
  ok(/Acme Builders/.test(await textOf(page, '.dn-head h2')) && await page.$eval('#dn-note-text', (t) => t.value).catch(() => '') === 'Wants a tour of a finished room', `counted for an organization: the note being written is in its note box (${await page.$eval('#dn-note-text', (t) => t.value).catch(() => 'none')})`);
  await page.click('#dn-note-text', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await wait(300);
  // Put on the website from a page read before a teammate took the organization out: nothing is made
  const { key: walkOrg } = await C.act(env, { act: 'org-new', name: 'Walkthrough Works', links: [] }, 'alex@soardcharity.com');
  await page.evaluate((k) => { location.hash = `#donors/org/${encodeURIComponent(k)}`; }, walkOrg);
  await page.waitForFunction(() => /Walkthrough Works/.test(document.querySelector('.dn-head h2')?.textContent || ''), { timeout: 8000 });
  await C.act(env, { act: 'org-delete', key: walkOrg }, 'jordan@soardcharity.com');
  const savedBefore = saved.length;
  await page.evaluate(() => [...document.querySelectorAll('.kd-rail button')].find((b) => /Put it on the website/.test(b.textContent))?.click());
  await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /taken out since this page was read/.test(t.textContent)), { timeout: 8000 }).catch(() => {});
  ok(saved.length === savedBefore && !(await page.$('.kd-dialog')) && await page.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => /taken out since this page was read/.test(t.textContent))), 'taken out by a teammate meanwhile: Put it on the website says so and makes no partner card');
  // A note whose save is slow, the page left while it saves: back on the page, it's in the list once, the box empty,
  // never back in its box as not saved (and Add note can't make it twice)
  await page.evaluate(() => { location.hash = '#donors/ct_fill_11'; });
  await page.waitForSelector('#dn-note-text', { timeout: 8000 });
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => { t.dataset.before = '1'; }));
  await page.click('#dn-note-text');
  await page.keyboard.type('Sent the gala photos');
  slow = (b) => (b.act === 'note-add' ? 2000 : 0);
  await page.evaluate(() => [...document.querySelectorAll('.dn-note-new button')].find((b) => b.textContent.trim() === 'Add note')?.click());
  await wait(200);
  await page.evaluate(() => history.back());
  await wait(3000);
  await page.evaluate(() => history.forward());
  await page.waitForFunction(() => [...document.querySelectorAll('.dn-note__body')].some((n) => /Sent the gala photos/.test(n.textContent)), { timeout: 8000 }).catch(() => {});
  const after = { box: await page.$eval('#dn-note-text', (t) => t.value).catch(() => '?'), shown: await page.$$eval('.dn-note__body', (l) => l.filter((n) => /Sent the gala photos/.test(n.textContent)).length), toasts: await page.evaluate(() => [...document.querySelectorAll('.toast:not([data-before])')].map((t) => t.textContent.trim())) };
  ok(after.box === '' && after.shown === 1 && !after.toasts.some((t) => /not saved yet/.test(t)), `a note saved after the page was left: in the list once, its box empty, nothing says it isn’t saved (${JSON.stringify(after)})`);
  ok((await DB.prepare("SELECT COUNT(*) AS n FROM donor_notes WHERE body = 'Sent the gala photos'").first()).n === 1, 'and saved once');
  // Back through another area: the list as it was (its search), not fresh
  await page.evaluate(() => { location.hash = '#donors'; });
  await page.waitForSelector('input[aria-label="Search donors"]', { timeout: 8000 });
  await page.$eval('input[aria-label="Search donors"]', (i) => { i.value = 'Filler'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await wait(500);
  await page.evaluate(() => [...document.querySelectorAll('.dn-table .dn-name')].find((b) => /Filler Donor 012/.test(b.textContent))?.click());
  await page.waitForFunction(() => /Filler Donor 012/.test(document.querySelector('.dn-head h2')?.textContent || ''), { timeout: 8000 }).catch(() => {});
  // (another area from the sidebar: the first one that isn't Donors)
  awayFromDonors = true;
  await page.evaluate(() => [...document.querySelectorAll('.sidebar a.nav-item')].find((a) => /^#[a-z]/.test(a.getAttribute('href') || '') && !/^#donors/.test(a.getAttribute('href')))?.click());
  await page.waitForFunction(() => !/^#donors/.test(location.hash), { timeout: 6000 }).catch(() => {});
  const away = await page.evaluate(() => location.hash);
  await wait(1200);
  await page.evaluate(() => history.back());
  await page.waitForFunction(() => /Filler Donor 012/.test(document.querySelector('.dn-head h2')?.textContent || ''), { timeout: 8000 }).catch(() => {});
  await wait(1000);
  awayFromDonors = false;
  await page.evaluate(() => history.back());
  await page.waitForSelector('input[aria-label="Search donors"]', { timeout: 8000 }).catch(() => {});
  await wait(400);
  ok(!/^#donors/.test(away) && await page.$eval('input[aria-label="Search donors"]', (i) => i.value).catch(() => '') === 'Filler', `Back through another area (${away}): the list as it was, its search kept`);
  await page.$eval('input[aria-label="Search donors"]', (i) => { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
  ok(!calls.some((c) => /%40|@/.test(c)), 'still no email in any request');
  ok(errors.length === 0, `no console errors on the laptop${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);

  console.log('Found in round 18');
  // Two tabs on one giver: words typed in the second while the first saves the note are never wiped
  await page.evaluate(() => { location.hash = '#donors/ct_fill_14'; });
  await page.waitForSelector('#dn-note-text', { timeout: 8000 });
  const tabB = await open(browser, origin, { width: 1280, height: 900 }, '#donors/ct_fill_14');
  await tabB.page.waitForSelector('#dn-note-text', { timeout: 15000 });
  await page.click('#dn-note-text');
  await page.keyboard.type('Hello from tab A');
  await tabB.page.waitForFunction(() => document.querySelector('#dn-note-text')?.value === 'Hello from tab A', { timeout: 4000 }).catch(() => {});
  const mirrored = await tabB.page.$eval('#dn-note-text', (t) => t.value);
  slow = (b) => (b.act === 'note-add' ? 2000 : 0);
  await page.evaluate(() => [...document.querySelectorAll('.dn-note-new button')].find((b) => b.textContent.trim() === 'Add note')?.click());
  await wait(300);
  await tabB.page.click('#dn-note-text');
  await tabB.page.keyboard.press('End');
  await tabB.page.keyboard.type(', and B adds this');
  await wait(3200);
  await tabB.page.waitForFunction(() => [...document.querySelectorAll('.dn-note__body')].some((n) => /Hello from tab A/.test(n.textContent)), { timeout: 6000 }).catch(() => {});
  const bNow = { box: await tabB.page.$eval('#dn-note-text', (t) => t.value), notes: await tabB.page.$$eval('.dn-note__body', (l) => l.map((n) => n.textContent.trim())) };
  ok(mirrored === 'Hello from tab A' && /and B adds this/.test(bNow.box) && bNow.notes.includes('Hello from tab A'), `two tabs: the second's words typed while the first saved stay in its box, and it shows the note saved (${JSON.stringify(bNow)})`);
  ok((await DB.prepare("SELECT COUNT(*) AS n FROM donor_notes WHERE body = 'Hello from tab A'").first()).n === 1, 'and the note is saved once');
  await tabB.page.click('#dn-note-text', { clickCount: 3 });
  await tabB.page.keyboard.press('Backspace');
  await wait(200);
  await tabB.page.close();
  // A note half written and left; a teammate counts the giver for an organization: opening them again, the words are
  // on the organization's page they now open
  await page.evaluate(() => { location.hash = '#donors/ct_fill_15'; });
  await page.waitForSelector('#dn-note-text', { timeout: 8000 });
  await page.click('#dn-note-text');
  await page.keyboard.type('Wants to sponsor a room');
  await wait(300);
  await page.evaluate(() => { location.hash = '#donors'; });
  await page.waitForSelector('.dn-table', { timeout: 8000 });
  await C.act(env, { act: 'link', kind: 'contact', subject: 'ct_fill_15', subjects: ['ct_fill_15'], org: 'p:acme' }, 'jordan@soardcharity.com');
  await page.evaluate(() => { location.hash = '#donors/ct_fill_15'; });
  await page.waitForFunction(() => /Acme Builders/.test(document.querySelector('.dn-head h2')?.textContent || ''), { timeout: 8000 }).catch(() => {});
  await page.waitForSelector('#dn-note-text', { timeout: 8000 }).catch(() => {});
  ok(/Wants to sponsor a room/.test(await page.$eval('#dn-note-text', (t) => t.value).catch(() => '')), `counted for an organization by a teammate while away: the words written on their page are on the organization's (${await page.$eval('#dn-note-text', (t) => t.value).catch(() => 'none')})`);
  await page.click('#dn-note-text', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await wait(200);
  // A note being changed, then Same person with a record that leads: the change goes on, in its own editor
  await C.act(env, { act: 'note-add', key: 'c:ct_fill_16', body: 'Prefers a call in the morning', id: 'note-walk-r18' }, 'alex@soardcharity.com');
  await page.evaluate(() => { location.hash = '#donors/ct_fill_16'; });
  await page.waitForSelector('.dn-tl__item[data-kind="note"] .dn-note__change', { timeout: 8000 });
  await page.click('.dn-tl__item[data-kind="note"] .dn-note__change');
  await page.waitForSelector('.dn-tl__item[data-kind="note"] textarea', { timeout: 4000 });
  await page.keyboard.press('End');
  await page.keyboard.type(', never after 5');
  await wait(300);
  await page.evaluate(() => [...document.querySelectorAll('.kd-rail button, .dn button')].find((b) => /Same person as another donor/.test(b.textContent))?.click());
  await page.waitForSelector('.dn-picker input', { timeout: 4000 });
  await page.type('.dn-picker input', 'Filler Donor 104');
  await page.waitForFunction(() => [...document.querySelectorAll('.dn-picker__item')].some((b) => /Filler Donor 104/.test(b.textContent)), { timeout: 6000 }).catch(() => {});
  await page.evaluate(() => [...document.querySelectorAll('.dn-picker__item')].find((b) => /Filler Donor 104/.test(b.textContent))?.click());
  await page.waitForFunction(() => !document.querySelector('.dn-picker'), { timeout: 8000 }).catch(() => {});
  await page.waitForSelector('.dn-tl__item[data-kind="note"] textarea', { timeout: 8000 }).catch(() => {});
  const editNow = { editor: await page.$eval('.dn-tl__item[data-kind="note"] textarea', (t) => t.value).catch(() => 'none'), box: await page.$eval('#dn-note-text', (t) => t.value).catch(() => '?') };
  ok(editNow.editor === 'Prefers a call in the morning, never after 5' && editNow.box === '', `joined under another record mid-change: the change goes on in its note's editor, never a new note (${JSON.stringify(editNow)})`);
  await page.keyboard.press('Escape');
  await wait(200);
  // Typing in the note box when the page is read again under another key (a teammate joins them under another lead):
  // the typing goes on in the box, never to the page
  await page.evaluate(() => { location.hash = '#donors/ct_fill_18'; });
  await page.waitForSelector('#dn-note-text', { timeout: 8000 });
  await page.click('#dn-note-text');
  await page.keyboard.type('First half typed, ');
  await C.act(env, { act: 'same', a: 'c:ct_fill_18', b: 'c:ct_fill_102', same: true }, 'jordan@soardcharity.com');
  await page.evaluate(() => window.dispatchEvent(new Event('soard-thanks-moved')));
  await page.waitForFunction(() => document.activeElement?.id === 'dn-note-text' && document.querySelector('.dn-tl')?.isConnected, { timeout: 8000 }).catch(() => {});
  await wait(600);
  await page.keyboard.type('second half right after.');
  await wait(300);
  ok(await page.$eval('#dn-note-text', (t) => t.value).catch(() => '') === 'First half typed, second half right after.', `joined under another lead while typing: the typing goes on in the box (${await page.$eval('#dn-note-text', (t) => t.value).catch(() => 'none')})`);
  await page.click('#dn-note-text', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await wait(200);
  // An owner picked, then Back at once while it saves: the list shows them once it's saved
  await page.evaluate(() => { location.hash = '#donors/ct_fill_17'; });
  await page.waitForSelector('#dn-owner-pick', { timeout: 8000 });
  slow = (b) => (b.act === 'owner' ? 1500 : 0);
  await page.select('#dn-owner-pick', 'jordan@soardcharity.com');
  await page.evaluate(() => document.querySelector('.dn-back')?.click());
  await page.waitForSelector('.dn-table', { timeout: 8000 });
  await page.waitForFunction(() => /Jordan/.test([...document.querySelectorAll('.dn-row')].find((r) => /Filler Donor 017/.test(r.textContent))?.textContent || ''), { timeout: 8000 }).catch(() => {});
  ok(/Jordan/.test(await page.evaluate(() => [...document.querySelectorAll('.dn-row')].find((r) => /Filler Donor 017/.test(r.textContent))?.textContent || '')), 'an owner picked, then Back at once: saved, and the list shows them once it is');
  // Straight from the list to another area and Back: the list as it was (search, sort)
  await page.$eval('input[aria-label="Search donors"]', (i) => { i.value = 'Filler'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.select('.dn-sort-by select', 'name');
  await wait(400);
  const hereList = await page.evaluate(() => location.hash);
  awayFromDonors = true;
  await page.evaluate(() => [...document.querySelectorAll('.sidebar a.nav-item')].find((a) => /^#[a-z]/.test(a.getAttribute('href') || '') && !/^#donors/.test(a.getAttribute('href')))?.click());
  await page.waitForFunction(() => !/^#donors/.test(location.hash), { timeout: 6000 }).catch(() => {});
  const away2 = await page.evaluate(() => location.hash);
  await wait(1200);
  await page.evaluate(() => history.back());
  await page.waitForSelector('input[aria-label="Search donors"]', { timeout: 8000 }).catch(() => {});
  await wait(1000);
  awayFromDonors = false;
  const listNow = { from: hereList, away: away2, at: await page.evaluate(() => location.hash), q: await page.$eval('input[aria-label="Search donors"]', (i) => i.value).catch(() => '?'), sort: await page.$eval('.dn-sort-by select', (x) => x.value).catch(() => '?') };
  ok(listNow.q === 'Filler' && listNow.sort === 'name', `straight from the list to another area and Back: its search and sort as they were (${JSON.stringify(listNow)})`);
  await page.$eval('input[aria-label="Search donors"]', (i) => { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.select('.dn-sort-by select', 'latest');
  // A giver of millions, with cents: on a phone the list and the Giving tiles show it whole
  for (const p of [pay({ id: 'mega_1', created: S(NOW - 3 * DAY), amount: 125000050, contact: 'ct_mega', email: 'mega@example.com', first: 'Mega', last: 'Giver' })]) { payments.push(p); await D.noteDonorPayment(env, p, { now: NOW }); }
  const xs = await open(browser, origin, { width: 360, height: 780, isMobile: true, hasTouch: true });
  await xs.page.waitForSelector('.dn-table', { timeout: 15000 });
  await xs.page.$eval('input[aria-label="Search donors"]', (i) => { i.value = 'Mega'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await wait(400);
  const cut = await xs.page.evaluate(() => { const td = [...document.querySelectorAll('.dn-row td.num')].find((c) => c.offsetParent); const card = document.querySelector('.dn-list'); return td && card ? { amount: td.textContent.trim(), right: Math.round(td.getBoundingClientRect().right), edge: Math.round(card.getBoundingClientRect().right) } : null; });
  ok(cut && cut.amount === '$1,250,000.50' && cut.right <= cut.edge, `360px: a total of millions shows whole in the list (${JSON.stringify(cut)})`);
  await xs.page.evaluate(() => { location.hash = '#donors/ct_mega'; });
  await xs.page.waitForSelector('.dn-tile', { timeout: 8000 });
  const tilesOut = await xs.page.evaluate(() => [...document.querySelectorAll('.dn-tile__value')].filter((v) => v.scrollWidth > v.clientWidth + 1 || v.getBoundingClientRect().right > v.closest('.dn-tile').getBoundingClientRect().right || v.getClientRects().length > 1 || v.getBoundingClientRect().height > parseFloat(getComputedStyle(v).lineHeight || '0') * 1.5).map((v) => v.textContent));
  ok(tilesOut.length === 0, `360px: every Giving tile holds its amount on one line (${tilesOut.join(', ') || 'all fit'})`);
  await phoneChecks(xs.page, 'A giver of millions, 360px');
  await xs.page.close();
  console.log('Phone');
  const ph = await open(browser, origin, { width: 390, height: 844, isMobile: true, hasTouch: true });
  await ph.page.waitForSelector('.dn-table', { timeout: 15000 });
  await phoneChecks(ph.page, 'People, phone');
  // A message with a long unbroken name wraps, its button in reach
  await ph.page.evaluate(() => { location.hash = '#donors/ct_uma'; });
  await ph.page.waitForSelector('#dn-owner-pick', { timeout: 8000 });
  await ph.page.evaluate(() => { const s = document.querySelector('#dn-owner-pick'); s.value = 'jordan@soardcharity.com'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  await ph.page.waitForSelector('.toast', { timeout: 6000 }).catch(() => {});
  await ph.page.evaluate(() => { const t = document.querySelector('.toast-container'); t.insertAdjacentHTML('beforeend', '<div class="toast toast-success" role="alert" id="walk-long"><span class="toast-action"><span>Thanked: $250 from ' + 'Averyveryveryveryverylongunbrokenname'.repeat(3) + '</span><button class="toast-undo">Undo</button></span></div>'); });
  const longToast = await ph.page.evaluate(() => { const b = document.querySelector('#walk-long .toast-undo').getBoundingClientRect(); const r = document.querySelector('#walk-long').getBoundingClientRect(); document.querySelector('#walk-long').remove(); return { right: Math.round(b.right), toast: Math.round(r.right), vw: document.documentElement.clientWidth }; });
  ok(longToast.right <= longToast.vw && longToast.toast <= longToast.vw, `a message with a long unbroken name keeps Undo on the screen (${JSON.stringify(longToast)})`);
  await ph.page.goto(`${origin}/admin/#donors`, { waitUntil: 'networkidle2' });
  await ph.page.waitForSelector('.dn-table', { timeout: 15000 });
  await ph.page.goto(`${origin}/admin/#donors/ct_jane`, { waitUntil: 'networkidle2' });
  await ph.page.waitForSelector('.dn-tl__list', { timeout: 8000 });
  await phoneChecks(ph.page, 'A donor, phone');
  ok(await ph.page.$eval('.dn-tl__month h4', (h) => Math.round(parseFloat(getComputedStyle(h).top)) === Math.round(document.querySelector('.mobile-bar').getBoundingClientRect().height)).catch(() => false), 'on a phone, a month’s heading sticks just under the top bar');
  await ph.page.screenshot({ path: join(OUT, 'donor-phone.png'), fullPage: true });
  await ph.page.goto(`${origin}/admin/#donors/org/p%3Aacme`, { waitUntil: 'networkidle2' });
  await ph.page.waitForSelector('.dn-tl__list', { timeout: 8000 });
  await phoneChecks(ph.page, 'An organization, phone');
  await ph.page.screenshot({ path: join(OUT, 'org-phone.png'), fullPage: true });
  await showShot(ph.page, '6-an-organization-phone', 844);
  await ph.page.goto(`${origin}/admin/#donors/ct_tom`, { waitUntil: 'networkidle2' });
  await ph.page.waitForSelector('.dn-tl__list', { timeout: 8000 });
  await phoneChecks(ph.page, 'A donor with an owner, phone');
  await showShot(ph.page, '10-a-donor-phone', 844);
  await ph.page.goto(`${origin}/admin/#donors/thanks`, { waitUntil: 'networkidle2' });
  await ph.page.waitForSelector('.dn-needs', { timeout: 8000 });
  await phoneChecks(ph.page, 'To thank, phone');
  ok(ph.errors.length === 0, `no console errors on the phone${ph.errors.length ? `: ${ph.errors.slice(0, 3).join(' | ')}` : ''}`);
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} failed:\n- ${failures.join('\n- ')}` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
