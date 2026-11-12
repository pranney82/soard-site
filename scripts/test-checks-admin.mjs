/**
 * test-checks-admin.mjs — drive Donors & Partners → Checks in a real browser
 * ===================================================================
 * Opens the admin at #donors/checks (public/ served directly) with the REAL
 * /api/checks-admin behind it, on an in-memory D1 and a pretend Zeffy, and walks
 * it the way staff would (Peter, Nov 10 2026: a person approves every entry into
 * Zeffy): a card with two names and two possible donors, a typed address, a
 * possible double matched instead of sent, a refund not sent and then sent after
 * all, a check nobody could read, and the to-dos after a check is in Zeffy.
 * Laptop and phone, axe, no console errors. Screenshots land in
 * test-results/checks/. Names and amounts are made up.
 *
 *   node scripts/test-checks-admin.mjs
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { answerAsks } from './lib/ask.mjs';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import { onRequestGet as checksGet, onRequestPost as checksPost } from '../functions/api/checks-admin.js';
import { ensureChecks, prepareCard } from '../functions/api/_check-gifts.js';
import { writeState } from '../functions/api/_mercury.js';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/checks/');
mkdirSync(OUT, { recursive: true });
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── The server side: the real admin API on an in-memory world ──────

const zeffy = {
  forms: [
    { id: 'form_home', type: 'donation_form', status: 'active', title: 'Help Build a Brighter Home' },
    { id: 'form_grant', type: 'donation_form', status: 'active', title: 'Grant Funding 2026' },
    { id: 'form_golf', type: 'ticketing', status: 'active', title: 'Fairway 2026' },
  ],
  // Rosa Whitfield gave online in May: Zeffy knows her, though no check of hers was ever read
  payments: [{ id: 'zeffy_rosa_may', amount: 5000, status: 'succeeded', type: 'online', campaign_id: 'form_home', created: 1779000000, contact: 'ct_rosa', description: 'x', payment_method: { type: 'card' }, buyer: { first_name: 'Rosa', last_name: 'Whitfield', email: 'rosa.whitfield@example.com' } }],
  posts: [],
  contacts: {
    ct_rosa: { id: 'ct_rosa', email: 'rosa.whitfield@example.com', first_name: 'Rosa', last_name: 'Whitfield', donation_count: 1 },
    // A joint check's other spouse: Zeffy knows Elena, at her own address, with no email
    ct_elena: { id: 'ct_elena', email: null, first_name: 'Elena', last_name: 'Abernathy', donation_count: 2, address: { line1: '14 Birch Ln', city: 'Marietta', state: 'GA', postal_code: '30062', country: 'US' } },
    ct_dana: { id: 'ct_dana', email: 'dana.whitfield.family.giving@example.com', first_name: 'Dana', last_name: 'Whitfield', donation_count: 4 },
    ct_dana2: { id: 'ct_dana2', email: null, first_name: 'Dana', last_name: 'Whitfield', donation_count: 1 },
  },
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  // Never the real world: the page's own server, the fake Zeffy, and nothing else (Mercury not answering is a case it handles)
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return realFetch(input, init);
  if (url.hostname !== 'api.zeffy.com') return Response.json({ error: 'offline in this walk' }, { status: 503 });
  const path = url.pathname.replace('/api/v1', '');
  const method = init.method || 'GET';
  if (path === '/campaigns') return Response.json({ data: zeffy.forms, has_more: false });
  if (path === '/payments' && method === 'GET') return Response.json({ data: zeffy.payments, has_more: false });
  if (path === '/payments') {
    const b = JSON.parse(init.body);
    zeffy.posts.push(b);
    const holder = b.email && Object.values(zeffy.contacts).find((c) => c.email === b.email);
    const p = { id: `zeffy_pay_${zeffy.posts.length}`, amount: b.amount, status: 'succeeded', type: 'manual', campaign_id: b.campaign_id, created: 1793000000, contact: holder?.id || `ct_new_${zeffy.posts.length}`, description: 'x', payment_method: { type: 'cheque' }, buyer: { first_name: b.first_name, last_name: b.last_name, email: b.email || null } };
    zeffy.payments.push(p);
    return Response.json(p, { status: 201 });
  }
  const one = path.match(/^\/payments\/(.+)$/);
  if (one) return Response.json(zeffy.payments.find((p) => p.id === one[1]) || {});
  if (path === '/contacts' && method === 'GET') {
    const email = url.searchParams.get('email');
    return Response.json({ data: Object.values(zeffy.contacts).filter((c) => !email || c.email === email), has_more: false });
  }
  const contact = path.match(/^\/contacts\/(.+)$/);
  if (contact && method === 'GET') return zeffy.contacts[contact[1]] ? Response.json(zeffy.contacts[contact[1]]) : Response.json({ error: { message: 'no' } }, { status: 404 });
  return Response.json({}, { status: 404 });
};

const DB = await createD1();
await DB.prepare('CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)').run();
await DB.prepare('CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)').run();
await ensureChecks(DB);
await writeState(DB, 'check-gifts', { writeTest: { id: 'x', ok: true, join: { ok: true }, address: { ok: true } } });
const env = { DB, ZEFFY_API_KEY: 'z', MERCURY_API_TOKEN: 'm', MERCURY_RELAY_KEY: 'r' };
const seed = (o) => {
  const cols = Object.keys(o);
  return DB.prepare(`INSERT INTO check_gifts (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...cols.map((k) => o[k])).run();
};
const marked = (id, name = 'Individual Contribution') => DB.prepare("INSERT OR REPLACE INTO mercury_txns (id, kind, cents, category_name, created_at) VALUES (?, 'checkDeposit', 1, ?, '2026-11-05T15:00:00Z')").bind(id, name).run();
const base = { status: 'sent', deposited_at: '2026-11-05T15:00:00Z', posted_at: '2026-11-07T15:00:00Z', link: 'https://app.mercury.com/transactions/x' };
// Real-length words: a fund's long name, a long email, a long street line
const LONG = { line1: '12345 Northwest Peachtree Industrial Boulevard Apt 1402', city: 'Peachtree Corners', state: 'GA', postal_code: '30092', country: 'US' };
const HARBOR = { line1: '400 Harbor Trust Plaza Suite 1900', city: 'Atlanta', state: 'GA', postal_code: '30303', country: 'US' };
const cardOf = (o) => JSON.stringify({ names: [], name: '', donors: [], donor: 'new', formId: 'form_home', day: '2026-11-03', email: '', letterAddress: null, letterAddressFor: '', checkAddress: null, checkAddressFor: '', notes: [], entries: [], category: null, suggest: 'send', dontReason: null, at: new Date().toISOString(), ...o });

// Cards
await seed({ ...base, id: 'c1', cents: 2500000, state: 'person', reason: 'ready', payer: 'Dana Whitfield', drawer: 'Whitfield Family Charitable Fund at Harbor Trust Advisors', check_number: '21459', check_date: '2026-11-03', form_id: 'form_home',
  address: JSON.stringify({ ...HARBOR, from: 'check', for: 'Whitfield Family Charitable Fund at Harbor Trust Advisors' }),
  letter: JSON.stringify({ about: true, name: 'Dana Whitfield', email: 'dana.whitfield.family.giving@example.com', address: LONG, files: ['receipt:letter.jpg'], reads: { 'receipt:letter.jpg': { about: true, name: 'Dana Whitfield' } }, pending: [] }),
  card: cardOf({
    names: [{ name: 'Dana Whitfield', from: 'letter' }, { name: 'Whitfield Family Charitable Fund at Harbor Trust Advisors', from: 'check' }], name: 'Dana Whitfield',
    donors: [{ id: 'ct_dana', name: 'Dana Whitfield', email: 'dana.whitfield.family.giving@example.com', gifts: 4, last: 1790000000, address: { line1: '9 Elm St', city: 'Alpharetta', state: 'GA', postal_code: '30009', country: 'US' }, sure: true, for: ['Dana Whitfield'], sureFor: ['Dana Whitfield'] },
      { id: 'ct_dana2', name: 'Dana Whitfield', email: '', gifts: 1, last: 1780000000, address: null, sure: true, for: ['Dana Whitfield'], sureFor: ['Dana Whitfield'] }],
    donor: null, email: 'dana.whitfield.family.giving@example.com', letterAddress: LONG, letterAddressFor: 'Dana Whitfield',
    checkAddress: HARBOR, checkAddressFor: 'Whitfield Family Charitable Fund at Harbor Trust Advisors',
  }) });
await seed({ ...base, id: 'c2', cents: 1000000, state: 'person', reason: 'maybe-double', payer: 'Elm Street Fund', check_date: '2026-11-04', form_id: 'form_grant',
  note: JSON.stringify([{ id: 'zeffy_oak_1', name: 'Oak Trust', cents: 1000000, at: 1793750400, form: 'Grant Funding 2026' }]),
  card: cardOf({ names: [{ name: 'Elm Street Fund', from: 'check' }], name: 'Elm Street Fund', formId: 'form_grant', notes: ['maybe-double'] }) });
await seed({ ...base, id: 'c3', cents: 30000, state: 'person', reason: 'refund', payer: 'Ace Supply', memo: 'Refund for invoice 88',
  card: cardOf({ names: [{ name: 'Ace Supply', from: 'check' }], name: 'Ace Supply', notes: ['refund'], suggest: 'dont', dontReason: 'refund' }) });
await seed({ ...base, id: 'c4', cents: 20000, state: 'person', reason: 'unreadable', card: cardOf({ notes: ['unreadable'] }) });
zeffy.payments.push({ id: 'zeffy_oak_1', amount: 1000000, status: 'succeeded', type: 'manual', campaign_id: 'form_grant', created: 1793750400, contact: 'c9', description: 'Grant Funding 2026', payment_method: { type: 'cheque' }, buyer: { first_name: 'Oak', last_name: 'Trust' } });
// Everything else
await seed({ ...base, id: 't1', cents: 1000000, state: 'linked', via: 'hand', payer: 'Pine Family Foundation', check_date: '2026-11-03', form_title: 'Grant Funding 2026', zeffy_id: 'zh1' });
await seed({ ...base, id: 't2', cents: 50000, state: 'created', via: 'person', by: 'linzi@soardcharity.com', payer: 'Rosa Ortiz', form_title: 'Help Build a Brighter Home', zeffy_id: 'zh2', address_done: 'written', address: JSON.stringify({ line1: '77 Mill St', city: 'Alpharetta', state: 'GA', postal_code: '30009', country: 'US', from: 'check', for: 'Rosa Ortiz' }) });
await seed({ ...base, id: 't5', cents: 12000, status: 'pending', posted_at: null, state: 'new' });
await seed({ ...base, id: 't6', cents: 75000, state: 'read', payer: 'Grace Okafor' });
await seed({ ...base, id: 't7', cents: 90000, state: 'store', payer: 'Mina Ortiz' });
await seed({ ...base, id: 't8', cents: 500000, state: 'came-back', reason: 'back', payer: 'Oakline LLC' });
await seed({ ...base, id: 'l2', cents: 100000, state: 'created', via: 'person', by: 'linzi@soardcharity.com', zeffy_id: 'zl2', payer: 'Oakline Design Build LLC', letter: JSON.stringify({ files: ['receipt:IMG_2231.jpg'], pending: [], late: ['receipt:IMG_2231.jpg'] }) });
await seed({ ...base, id: 'l3', cents: 40000, state: 'created', via: 'person', by: 'linzi@soardcharity.com', zeffy_id: 'zl3', payer: 'Ken Bryant', address_done: 'refused',
  address_tried: JSON.stringify({ address: { line1: '9 Elm St', city: 'Roswell', state: 'GA', postal_code: '30075', country: 'US' }, email: '', who: 'Ken Bryant' }) });
// A joint check, its letter from one spouse with his email; Zeffy knows only the other. Made by the site's own prepareCard
zeffy.payments.push({ id: 'zeffy_elena_may', amount: 10000, status: 'succeeded', type: 'online', campaign_id: 'form_home', created: 1779500000, contact: 'ct_elena', description: 'x', payment_method: { type: 'card' }, buyer: { first_name: 'Elena', last_name: 'Abernathy', email: null } });
await seed({ ...base, id: 'c5', cents: 15000, state: 'read', payer: 'Marcus Abernathy', drawer: 'Marcus and Elena Abernathy', check_number: '3301', check_date: '2026-11-02',
  letter: JSON.stringify({ about: true, name: 'Marcus Abernathy', email: 'marcus.abernathy.home@example.com', files: ['receipt:note.jpg'], reads: { 'receipt:note.jpg': { about: true, name: 'Marcus Abernathy' } }, pending: [] }) });
// A send Zeffy never answered and never showed: its card comes back as that person left it
await seed({ ...base, id: 'c6', cents: 60000, state: 'person', reason: 'unsure', payer: 'Imogen Castellanos', drawer: 'Imogen Castellanos',
  card: cardOf({ names: [{ name: 'Imogen Castellanos', from: 'check' }], name: 'Imogen Castellanos', donor: 'new', email: 'imogen.castellanos@example.com', emailFor: 'Imogen Castellanos', notes: ['unsure'],
    sent: { name: 'Imogen Castellanos', donor: 'new', formId: 'form_home', email: 'imogen.castellanos@example.com', address: { line1: '515 Magnolia Bluff Terrace', city: 'Canton', state: 'GA', postal_code: '30114', country: 'US' } } }) });
// A letter whose address is read again while a person has its address picked
const OAKLEAF = { line1: '88 Peachtree Street NE Apt 4', city: 'Atlanta', state: 'GA', postal_code: '30308', country: 'US' };
await seed({ ...base, id: 'c7', cents: 45000, state: 'person', reason: 'ready', payer: 'Wendeline Marsh', drawer: 'Wendeline Marsh',
  card: cardOf({ names: [{ name: 'Wendeline Marsh', from: 'check' }], name: 'Wendeline Marsh', letterAddress: OAKLEAF, letterAddressFor: 'Wendeline Marsh' }) });
for (const id of ['c1', 'c2', 'c4', 'c5', 'c6', 'c7', 't1', 't2', 'l2', 'l3']) await marked(id);
await prepareCard({ DB, ZEFFY_API_KEY: 'z', MERCURY_API_TOKEN: 'm', MERCURY_RELAY_KEY: 'r' }, { id: 'c5' }, { now: Date.now(), fetchImpl: globalThis.fetch });
await marked('c3', 'Refund / Reimbursement');

async function toRequest(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  return new Request(`http://local${req.url}`, { method: req.method, headers: req.headers, body: req.method === 'GET' ? undefined : body });
}
async function send(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}
const JOB_COSTS = { success: true, checksWaiting: 0, codes: [], jobs: [], charges: [], recode: [], bills: [], ledgers: [], odd: [], rules: [], config: {}, closeouts: [], ramp: {}, health: { mercury: true, jobtread: true, slack: true, webhook: { registered: true, lastEventAt: new Date().toISOString() } } };
function serve() {
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/checks-admin') {
      const request = await toRequest(req);
      const ctx = { env, request, data: { userEmail: 'holly@soardcharity.com' } };
      return send(res, await (req.method === 'POST' ? checksPost(ctx) : checksGet(ctx)));
    }
    if (u.pathname === '/api/job-costs-admin') return send(res, Response.json(JOB_COSTS));
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

// ─── The browser side ───────────────────────────────────────────────

async function open(browser, origin, viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', (req) => (new URL(req.url()).origin === origin ? req.continue() : req.abort()));
  await answerAsks(page, { accept: true });
  await page.goto(`${origin}/admin/#donors/checks`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.ck', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('.ck-approve select option').length > 3, { timeout: 8000 }).catch(() => {});
  return { page, errors };
}
const clickIn = (page, scope, text) => page.evaluate((scope, text) => {
  const root = document.querySelector(scope);
  const el = root && [...root.querySelectorAll('button, a')].find((b) => b.textContent.trim().startsWith(text));
  if (!el) return false;
  el.click();
  return true;
}, scope, text);
const textOf = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
const cardIds = (page) => page.$$eval('.ck-need', (r) => r.map((x) => x.dataset.check));
/** A card's select or input by its label's words */
const field = (page, id, label) => page.evaluateHandle((id, label) => {
  const card = document.querySelector(`.ck-need[data-check="${id}"]`);
  const l = card && [...card.querySelectorAll('label')].find((x) => x.querySelector('span')?.textContent.trim().startsWith(label));
  return l?.querySelector('select, input') || null;
}, id, label);
async function pick(page, id, label, value) {
  const el = await field(page, id, label);
  await el.select(value);
  await wait(60);
}
async function typeInto(page, id, label, text) {
  const el = await field(page, id, label);
  await el.click({ clickCount: 3 });
  await el.type(text);
  await wait(30);
}
async function axe(page, label) {
  await wait(300);
  await page.evaluate(AXE);
  const r = await page.evaluate(async () => (await window.axe.run(document.querySelector('.ck'), { resultTypes: ['violations'] })).violations.map((v) => `${v.id}: ${v.nodes[0]?.html?.slice(0, 90)}`));
  ok(r.length === 0, `axe: no violations on ${label}${r.length ? `: ${r.join(', ')}` : ''}`);
}
async function phoneChecks(page, label) {
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(sideways <= 1, `${label}: no sideways scroll (${sideways}px)`);
  const small = await page.evaluate(() => [...document.querySelectorAll('.ck button, .ck a.btn, .ck input, .ck select')].filter((e) => e.offsetParent && e.getBoundingClientRect().height < 40).map((e) => `${e.tagName} ${e.textContent.trim().slice(0, 20)} ${Math.round(e.getBoundingClientRect().height)}`));
  ok(small.length === 0, `${label}: touch targets 40px or more${small.length ? `: ${small.join(', ')}` : ''}`);
  const past = await page.evaluate(() => [...document.querySelectorAll('.ck *')].filter((e) => e.offsetParent && e.getBoundingClientRect().right > window.innerWidth + 1).map((e) => e.tagName));
  ok(past.length === 0, `${label}: nothing cut off at the right${past.length ? `: ${past.slice(0, 4).join(', ')}` : ''}`);
}

const server = await serve();
const origin = `http://localhost:${server.address().port}`;
const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
try {
  console.log('The cards');
  const { page, errors } = await open(browser, origin, { width: 1440, height: 1000 });
  ok(await page.$eval('.hub-tab.active', (e) => e.textContent.trim().startsWith('Checks')), 'the Checks tab is open');
  const ids = await cardIds(page);
  ok(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'l2', 'l3'].every((x) => ids.includes(x)), `every card and to-do waits on someone (${ids})`);
  ok(/To send to Zeffy/.test(await textOf(page, '.ck h3')), 'the section says what it’s for');
  ok(!/Let the site enter checks|watching/i.test(await textOf(page, '.ck')), 'no talk of the site entering checks by itself');
  // Every check in Zeffy opens its own record there, as it opens in Mercury (?transactionId= is Zeffy's own link to one payment)
  const hrefs = (sel) => page.$$eval(`${sel} a`, (as) => as.map((a) => [a.textContent.trim(), a.getAttribute('href')]));
  const l2Links = await hrefs('.ck-need[data-check="l2"]');
  ok(l2Links.some(([t, h]) => t === 'Open in Zeffy' && /\/o\/all-payments\?transactionId=zl2$/.test(h)), `a to-do opens its own record in Zeffy (${JSON.stringify(l2Links)})`);
  const t1Links = await hrefs('[data-check="t1"]');
  ok(t1Links.some(([t, h]) => t === 'Open in Zeffy' && /transactionId=zh1$/.test(h)) && t1Links.some(([t]) => t === 'Open in Mercury'), `a check in Zeffy links its record beside Mercury (${JSON.stringify(t1Links)})`);
  const c1 = '.ck-need[data-check="c1"]';
  ok(/Dana Whitfield \(from the letter\)/.test(await textOf(page, c1)) && /Whitfield Family Charitable Fund at Harbor Trust Advisors \(on the check\)/.test(await textOf(page, c1)), 'two names: the letter’s first, then the check’s');
  ok(await page.$eval(`${c1} button[type=submit]`, (b) => b.getAttribute('aria-disabled') === 'true'), 'Send waits until a donor is picked');
  ok(/Pick the Zeffy donor/.test(await textOf(page, c1)), 'it says what’s missing');
  ok(/more than one donor who could be them/.test(await textOf(page, c1)), 'it says why it asks');
  await page.screenshot({ path: `${OUT}cards.png`, fullPage: true });
  await axe(page, 'the cards');

  console.log('Who it’s from and the donor agree');
  const donorGroups = await page.evaluate((sel) => [...document.querySelector(sel).querySelectorAll('optgroup')].map((g) => `${g.label}: ${[...g.children].map((o) => o.value).join(',')}`), c1);
  ok(donorGroups.length === 1 && /^Dana Whitfield \(from the letter\): ct_dana,ct_dana2$/.test(donorGroups[0]), `each Zeffy donor is under the name it’s for (${donorGroups.join(' | ')})`);
  const valueOf = (label) => page.evaluate((sel, label) => [...document.querySelector(sel).querySelectorAll('label')].find((l) => l.querySelector('span')?.textContent.trim().startsWith(label))?.querySelector('select, input')?.value, c1, label);
  await pick(page, 'c1', 'Who it’s from', 'Whitfield Family Charitable Fund at Harbor Trust Advisors');
  ok(await valueOf('Zeffy donor') === 'new' && /no donor by this name yet/.test(await textOf(page, c1)), 'the fund has no Zeffy donor, so its donor is a new one');
  ok(/On the check: 400 Harbor/.test(await page.evaluate((sel) => [...document.querySelector(sel).querySelectorAll('label')].find((l) => /Mailing address/.test(l.textContent)).querySelector('select').selectedOptions[0].textContent, c1)), 'the fund’s address is the check’s, with no “whose” on it');
  await pick(page, 'c1', 'Zeffy donor', 'ct_dana2');
  ok(await valueOf('Who it’s from') === 'Dana Whitfield', 'picking Dana’s donor makes it from Dana, so the two never disagree');

  console.log('A joint check');
  const c5 = '.ck-need[data-check="c5"]';
  const c5Value = (label) => page.evaluate((sel, label) => [...document.querySelector(sel).querySelectorAll('label')].find((l) => l.querySelector('span')?.textContent.trim().startsWith(label))?.querySelector('select, input')?.value, c5, label);
  const c5Groups = await page.evaluate((sel) => [...document.querySelector(sel).querySelectorAll('optgroup')].map((g) => `${g.label}: ${[...g.children].map((o) => o.value).join(',')}`), c5);
  ok(c5Groups.length === 1 && /^Marcus and Elena Abernathy \(on the check\): ct_elena$/.test(c5Groups[0]), `Elena’s donor is the joint name’s, never Marcus’s (${c5Groups.join(' | ')})`);
  ok(await c5Value('Zeffy donor') === 'new' && await c5Value('Email') === 'marcus.abernathy.home@example.com', 'from Marcus: a new donor, with the letter’s email (his)');
  await pick(page, 'c5', 'Mailing address', 'none');
  await pick(page, 'c5', 'Zeffy donor', 'ct_elena');
  ok(await c5Value('Who it’s from') === 'Marcus and Elena Abernathy', 'picking Elena’s donor makes it from the joint name, not Marcus');
  ok(await c5Value('Email') === '', 'Marcus’s email isn’t put on Elena');
  ok(await c5Value('Mailing address') === 'keep', '“No address” stays as “Keep what Zeffy has”, never the letter’s or the check’s');
  await pick(page, 'c5', 'Who it’s from', 'Marcus Abernathy');
  ok(await c5Value('Zeffy donor') === 'new', 'back to Marcus: Elena’s donor is let go');

  console.log('A send Zeffy never answered');
  const c6 = '.ck-need[data-check="c6"]';
  const c6Value = (label) => page.evaluate((sel, label) => [...document.querySelector(sel).querySelectorAll('label')].find((l) => l.querySelector('span')?.textContent.trim().startsWith(label))?.querySelector('select, input')?.value, c6, label);
  ok(await c6Value('Mailing address') === 'type' && await c6Value('Street') === '515 Magnolia Bluff Terrace' && await c6Value('Email') === 'imogen.castellanos@example.com', 'its card comes back with the address and email that person chose');

  const seg = (name) => page.evaluate((name) => [...document.querySelectorAll('.hub-tab')].find((b) => b.textContent.trim().startsWith(name))?.click(), name);
  console.log('A pick and the card made again');
  const c7 = '.ck-need[data-check="c7"]';
  const c7Value = (label) => page.evaluate((sel, label) => [...document.querySelector(sel).querySelectorAll('label')].find((l) => l.querySelector('span')?.textContent.trim().startsWith(label))?.querySelector('select, input')?.value, c7, label);
  await pick(page, 'c7', 'Mailing address', 'type');
  await pick(page, 'c7', 'Mailing address', 'letter');
  const remake = async (letterAddress) => {
    const row = await DB.prepare("SELECT card FROM check_gifts WHERE id = 'c7'").first();
    await DB.prepare("UPDATE check_gifts SET card = ? WHERE id = 'c7'").bind(JSON.stringify({ ...JSON.parse(row.card), letterAddress })).run();
    await seg('Donors'); await wait(400); await seg('Checks');
    await page.waitForSelector(c7, { timeout: 8000 }); await wait(500);
  };
  await remake({ ...OAKLEAF, line1: '88 Peachtree St NE #4' });
  ok(await c7Value('Mailing address') === 'letter' && !/changed since you picked it/.test(await textOf(page, c7)), 'the letter’s address read again in another spelling is still the one picked');
  await remake({ ...OAKLEAF, line1: '9 Elm St', city: 'Decatur', postal_code: '30030' });
  ok(await c7Value('Mailing address') === '' && /The letter’s address changed since you picked it/.test(await textOf(page, c7)), 'a different address from the letter lets the pick go, says so, and asks again');
  ok(await page.$eval(`${c7} button[type=submit]`, (b) => b.getAttribute('aria-disabled') === 'true'), 'Send waits for the new pick');
  await pick(page, 'c7', 'Mailing address', 'letter');
  ok(await page.$eval(`${c7} button[type=submit]`, (b) => b.getAttribute('aria-disabled') !== 'true'), 'picking it again is enough');

  console.log('Sending a card');
  await pick(page, 'c1', 'Zeffy donor', 'ct_dana');
  ok(await page.$eval(`${c1}`, (c) => [...c.querySelectorAll('input')].some((i) => i.readOnly && i.value === 'dana.whitfield.family.giving@example.com')), 'the donor’s email shows, not to be changed here');
  const addr = await page.evaluate((sel) => [...document.querySelector(sel).querySelectorAll('label')].find((l) => /Mailing address/.test(l.textContent)).querySelector('select').selectedOptions[0].textContent, c1);
  ok(/From the letter: 12345 Northwest/.test(addr), 'the address starts on the letter’s');
  ok(/Keep what Zeffy has: 9 Elm St/.test(await textOf(page, c1)), 'Zeffy’s own address is a choice once that donor is picked');
  await pick(page, 'c1', 'Mailing address', 'type');
  ok(!!(await page.$(`${c1} .ck-typed`)), 'typing an address opens its four boxes');
  ok(await page.$eval(`${c1} button[type=submit]`, (b) => b.getAttribute('aria-disabled') === 'true'), 'Send waits for the address to be whole');
  await typeInto(page, 'c1', 'Street', '40 Pine Rd Apt 2');
  await typeInto(page, 'c1', 'City', 'Marietta');
  await typeInto(page, 'c1', 'State', 'GA');
  await typeInto(page, 'c1', 'ZIP', '30062');
  ok(!(await page.$eval(`${c1} button[type=submit]`, (b) => b.getAttribute('aria-disabled') === 'true')), 'Send is ready once everything is filled in');
  ok(/Ready to send/.test(await textOf(page, `${c1} .ck-approve__head .tag`)), 'it says it’s ready only once it is');
  // Another donor picked after typing an address keeps the address typed
  await pick(page, 'c1', 'Zeffy donor', 'ct_dana2');
  ok(await valueOf('Street') === '40 Pine Rd Apt 2' && await valueOf('Mailing address') === 'type', 'a typed address stays when the donor changes');
  await pick(page, 'c1', 'Zeffy donor', 'ct_dana');
  await page.click(`${c1} button[type=submit]`);
  await page.waitForFunction(() => !document.querySelector('.ck-need[data-check="c1"]'), { timeout: 8000 });
  const sent = zeffy.posts.at(-1);
  ok(sent && sent.email === 'dana.whitfield.family.giving@example.com' && sent.first_name === 'Dana' && sent.last_name === 'Whitfield', 'the record goes to Zeffy on the donor picked, by their email');
  ok(sent.generate_tax_receipt === false && sent.send_confirmation_email === false, 'nothing is sent to the donor');
  const plan = await DB.prepare("SELECT send FROM check_gifts WHERE id = 'c1'").first();
  ok(/40 Pine Rd Apt 2/.test(plan?.send || ''), 'the typed address is what goes on the donor');
  ok(/Sent by Holly/.test(await textOf(page, '[data-check="c1"]')), 'the row says who sent it');

  console.log('A possible double');
  const c2 = '.ck-need[data-check="c2"]';
  ok(/Oak Trust/.test(await textOf(page, c2)) && /may already have this check/.test(await textOf(page, c2)), 'the card shows the entry Zeffy may already have, and why');
  let asked = '';
  await answerAsks(page, { accept: false, onAsk: (t) => { asked = t; } });
  const posts = zeffy.posts.length;
  await typeInto(page, 'c2', 'Email', 'grants.office.elm.street.fund@example.com');
  if (process.env.DEBUG_WALK) console.log('c2 submit', await page.$eval(`${c2} button[type=submit]`, (b) => ({ disabled: b.disabled, hint: b.closest('form').querySelector('.ck-missing')?.textContent })));
  await page.click(`${c2} button[type=submit]`);
  await wait(800);
  ok(/different gift/.test(asked), 'sending anyway asks first, naming the entry');
  ok(zeffy.posts.length === posts, 'Cancel sends nothing');
  // What was typed stays through the answer and a look at another tab
  await seg('Donors');
  await wait(400);
  await seg('Checks');
  await page.waitForSelector(c2, { timeout: 8000 });
  await wait(400);
  ok(await page.evaluate((sel) => [...document.querySelector(sel).querySelectorAll('input')].some((i) => i.value === 'grants.office.elm.street.fund@example.com'), c2), 'the email typed stays after the question and another tab');
  await answerAsks(page, { accept: true });
  await clickIn(page, c2, 'This is the check');
  await page.waitForFunction(() => !document.querySelector('.ck-need[data-check="c2"]'), { timeout: 5000 });
  ok(zeffy.posts.length === posts, 'matching it makes no new record');
  ok(/Matched by Holly/.test(await textOf(page, '[data-check="c2"]')), 'the row says who matched it');

  console.log('Not for Zeffy');
  const c3 = '.ck-need[data-check="c3"]';
  ok(/A refund or reimbursement/.test(await page.$eval(`${c3} .ck-dont select`, (s) => s.selectedOptions[0]?.textContent || '').catch(() => '')), 'a refund comes with “Don’t send” open and the reason picked');
  ok(/Category in Mercury: Refund/.test(await textOf(page, c3)), 'it shows the Category in Mercury');
  await clickIn(page, `${c3} .ck-dont`, 'Don’t send');
  await page.waitForFunction(() => !document.querySelector('.ck-need[data-check="c3"]'), { timeout: 5000 });
  ok(/Not sent to Zeffy: A refund or reimbursement/.test(await textOf(page, '[data-check="c3"]')), 'the row says it wasn’t sent, and why');
  await clickIn(page, '[data-check="c3"]', 'Send to Zeffy after all');
  await page.waitForFunction(() => /Getting its card ready/.test(document.querySelector('[data-check="c3"]')?.textContent || ''), { timeout: 5000 });
  ok(true, '“Send to Zeffy after all” makes its card again');

  console.log('A check nobody could read');
  const c4 = '.ck-need[data-check="c4"]';
  ok(/couldn’t read who wrote this check/.test(await textOf(page, c4)), 'it says the name couldn’t be read');
  ok(await page.$eval(`${c4} button[type=submit]`, (b) => b.getAttribute('aria-disabled') === 'true'), 'Send waits for a name');
  await typeInto(page, 'c4', 'Who it’s from', 'Rosa Whitfield');
  ok((await page.evaluate((sel) => [...document.querySelector(sel).querySelectorAll('label')].find((l) => /Zeffy form/.test(l.textContent)).querySelector('select').value, c4)) === 'form_home', 'the general form is picked');
  ok(!(await page.evaluate((sel) => [...document.querySelector(sel).querySelectorAll('option')].some((o) => /Fairway/.test(o.textContent)), c4)), 'a ticketing campaign is never offered');
  // The card never looked up a typed name: Send shows Zeffy's donor by that name first, and sends nothing
  const before = zeffy.posts.length;
  await page.click(`${c4} button[type=submit]`);
  await page.waitForFunction(() => /already has a donor named Rosa Whitfield/.test(document.body.textContent), { timeout: 8000 });
  ok(zeffy.posts.length === before, 'nothing is sent while Zeffy has a donor by that name');
  // (the message shows as the card is read again: her donor arrives with it)
  ok(await page.waitForFunction((sel) => [...(document.querySelector(sel)?.querySelectorAll('option') || [])].some((o) => o.value === 'ct_rosa' && /rosa\.whitfield@example\.com/.test(o.textContent)), { timeout: 5000 }, c4).then(() => true, () => false), 'her Zeffy donor is now a choice on the card');
  ok(await page.evaluate((sel) => [...document.querySelector(sel).querySelectorAll('input')].some((i) => i.value === 'Rosa Whitfield'), c4), 'the name typed is still there');
  await pick(page, 'c4', 'Zeffy donor', 'ct_rosa');
  await page.click(`${c4} button[type=submit]`);
  await page.waitForFunction(() => !document.querySelector('.ck-need[data-check="c4"]'), { timeout: 8000 });
  ok(zeffy.posts.at(-1).first_name === 'Rosa' && zeffy.posts.at(-1).last_name === 'Whitfield', 'it goes in under the name typed');
  ok(zeffy.posts.at(-1).email === 'rosa.whitfield@example.com', 'and on her own Zeffy donor, not a second one');

  console.log('After a check is in Zeffy');
  ok(/A file was added in Mercury after this check went into Zeffy/.test(await textOf(page, '.ck-need[data-check="l2"]')), 'a file added after says what to do');
  ok(/Add it to Ken Bryant in Zeffy: 9 Elm St, Roswell, GA 30075/.test(await textOf(page, '.ck-need[data-check="l3"]')), 'an address Zeffy wouldn’t take is named, with whom');
  ok(await clickIn(page, '.ck-need[data-check="l2"]', 'Looked at it'), 'a to-do has “Looked at it”');
  await page.waitForFunction(() => !document.querySelector('.ck-need[data-check="l2"]'), { timeout: 5000 });
  ok(/Address in Zeffy/.test(await textOf(page, '[data-check="t2"]')), 'an address in Zeffy says so');
  ok(/Came back/.test(await textOf(page, '[data-check="t8"]')), 'a returned check says so');
  ok(/Store account/.test(await textOf(page, '[data-check="t7"]')), 'a store deposit says so');
  ok(/Getting its card ready/.test(await textOf(page, '[data-check="t6"]')), 'a check being prepared says so');
  ok(!/routing|account number/i.test(await textOf(page, '.ck')), 'nothing on the page talks about account numbers');
  await page.screenshot({ path: `${OUT}after.png`, fullPage: true });
  await axe(page, 'after sending');
  ok(errors.length === 0, `no console errors on the laptop${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
  await page.close();

  console.log('Phone');
  await DB.prepare("UPDATE check_gifts SET state = 'person', reason = 'ready', by = NULL, via = NULL, zeffy_id = NULL WHERE id IN ('c1', 'c4')").run();
  const phone = await open(browser, origin, { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await phone.page.screenshot({ path: `${OUT}phone.png`, fullPage: true });
  await phoneChecks(phone.page, 'Cards, phone');
  await pick(phone.page, 'c1', 'Mailing address', 'type');
  await phoneChecks(phone.page, 'Typing an address, phone');
  await axe(phone.page, 'the phone');
  ok(phone.errors.length === 0, `no console errors on the phone${phone.errors.length ? `: ${phone.errors.slice(0, 3).join(' | ')}` : ''}`);
  await phone.page.close();

  console.log('A small laptop');
  const small = await open(browser, origin, { width: 1024, height: 700 });
  const sideways = await small.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(sideways <= 1, `no sideways scroll at 1024 (${sideways}px)`);
  await small.page.close();
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} FAILED:\n - ${failures.join('\n - ')}` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
