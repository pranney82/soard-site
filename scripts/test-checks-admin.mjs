/**
 * test-checks-admin.mjs — drive Job Costs → Checks in a real browser
 * ===================================================================
 * Opens the admin at #job-costs/checks (public/ served directly) with the REAL
 * /api/checks-admin behind it, on an in-memory D1 and a pretend Zeffy, and walks
 * it the way staff would: watching with hand entries scored, turning it on, a
 * check it couldn't read, a possible double, an event gift, a refund that was really a
 * gift, and turning it off. Every state on laptop and phone, axe, no console errors.
 * Screenshots land in test-results/checks/. Names and amounts are made up.
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
import { ensureChecks } from '../functions/api/_check-gifts.js';
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
  payments: [],
  posts: [],
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname !== 'api.zeffy.com') return realFetch(input, init);
  const path = url.pathname.replace('/api/v1', '');
  if (path === '/campaigns') return Response.json({ data: zeffy.forms, has_more: false });
  if (path === '/payments' && (init.method || 'GET') === 'GET') return Response.json({ data: zeffy.payments, has_more: false });
  if (path === '/payments') {
    const b = JSON.parse(init.body);
    zeffy.posts.push(b);
    const p = { id: `zeffy_pay_${zeffy.posts.length}`, amount: b.amount, status: 'succeeded', type: 'manual', campaign_id: b.campaign_id, created: 1793000000, contact: 'c1', description: 'x', payment_method: { type: 'cheque' }, buyer: { first_name: b.first_name, last_name: b.last_name } };
    zeffy.payments.push(p);
    return Response.json(p, { status: 201 });
  }
  const one = path.match(/^\/payments\/(.+)$/);
  if (one) return Response.json(zeffy.payments.find((p) => p.id === one[1]) || {});
  return Response.json({}, { status: 404 });
};

const DB = await createD1();
await DB.prepare('CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)').run();
await DB.prepare('CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)').run();
await ensureChecks(DB);
const env = { DB, ZEFFY_API_KEY: 'z', MERCURY_API_TOKEN: 'm', MERCURY_RELAY_KEY: 'r' };
const seed = (o) => {
  const cols = Object.keys(o);
  return DB.prepare(`INSERT INTO check_gifts (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...cols.map((k) => o[k])).run();
};
const base = { status: 'sent', deposited_at: '2026-11-05T15:00:00Z', posted_at: '2026-11-07T15:00:00Z', link: 'https://app.mercury.com/transactions/x' };
await seed({ ...base, id: 't1', cents: 1000000, state: 'linked', via: 'hand', payer: 'Pine Family Foundation', check_date: '2026-11-03', form_title: 'Grant Funding 2026', zeffy_id: 'zh1', score: JSON.stringify({ payer: true, form: true, gift: true }) });
await seed({ ...base, id: 't2', cents: 50000, state: 'linked', via: 'hand', payer: 'Dana Whitfield', check_date: '2026-11-01', memo: 'in honor of Mom', zeffy_id: 'zh2', score: JSON.stringify({ payer: true, form: false, gift: true }) });
await seed({ ...base, id: 't3', cents: 25000, state: 'would', payer: 'Lee Hardware Co', form_id: 'form_home', form_title: 'Help Build a Brighter Home', check_date: '2026-11-04' });
await seed({ ...base, id: 't4', cents: 7500000, status: 'pending', posted_at: null, state: 'read', payer: 'A Very Long Named Family Charitable Foundation of Greater North Metro Atlanta c/o Harbor Trust Advisors', check_date: '2026-11-04' });
await seed({ ...base, id: 't5', cents: 12000, status: 'pending', posted_at: null, state: 'new' });
await seed({ ...base, id: 't6', cents: 30000, state: 'left-out', reason: 'refund', payer: 'Ace Supply', memo: 'Refund for invoice 88' });
await seed({ ...base, id: 't7', cents: 90000, state: 'store', payer: 'Mina Ortiz' });
await seed({ ...base, id: 't8', cents: 500000, state: 'came-back', reason: 'back', payer: 'Oakline LLC' });
await seed({ ...base, id: 'p1', cents: 20000, state: 'person', reason: 'unreadable' });
await seed({ ...base, id: 'p2', cents: 1000000, state: 'person', reason: 'maybe-double', payer: 'Elm Street Fund', note: JSON.stringify([{ id: 'zeffy_oak_1', name: 'Oak Trust', cents: 1000000, at: 1793750400, form: 'Grant Funding 2026' }]) });
await seed({ ...base, id: 'p3', cents: 1000000, state: 'person', reason: 'event', payer: 'Northgate Builders', memo: 'Golf sponsor' });
await seed({ ...base, id: 'p4', cents: 150000, state: 'person', reason: 'vendor', payer: 'Brightwell' });
// Every check is marked a contribution in Mercury's Category but one, which shows what an unmarked check looks like
const marked = (id, name = 'Individual Contribution') => DB.prepare("INSERT OR REPLACE INTO mercury_txns (id, kind, cents, category_name, created_at) VALUES (?, 'checkDeposit', 1, ?, '2026-11-05T15:00:00Z')").bind(id, name).run();
for (const id of ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 'p1', 'p2', 'p3', 'p4']) await marked(id);
await seed({ ...base, id: 'u1', cents: 35000, state: 'read', payer: 'Grace Okafor', check_date: '2026-11-04' });
zeffy.payments.push({ id: 'zeffy_oak_1', amount: 1000000, status: 'succeeded', type: 'manual', campaign_id: 'form_grant', created: 1793750400, contact: 'c9', description: 'Grant Funding 2026', payment_method: { type: 'cheque' }, buyer: { first_name: 'Oak', last_name: 'Trust' } });

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
  await page.goto(`${origin}/admin/#job-costs/checks`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.ck', { timeout: 15000 });
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
const needIds = (page) => page.$$eval('.ck-need', (r) => r.map((x) => x.dataset.check));
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
  console.log('Watching, before the write test');
  const { page, errors } = await open(browser, origin, { width: 1440, height: 1000 });
  ok(await page.$eval('.seg [role="tab"][aria-selected="true"]', (e) => e.textContent.trim().startsWith('Checks')), 'the Checks tab is open');
  ok(/The site is watching/.test(await textOf(page, '.ck .notice')), 'it says it is watching');
  ok(/1 of 2 matched/.test(await textOf(page, '.ck .notice')), 'it says how the comparison is going');
  ok(!(await textOf(page, '.ck .notice')).includes('Let the site enter checks'), 'no way to turn it on before the write test');
  ok((await needIds(page)).join() === 'p2', `while watching, only a real question waits on someone (${await needIds(page)})`);
  ok(/Oak Trust/.test(await textOf(page, '.ck-need')), 'the possible double shows the Zeffy entry');
  ok((await page.$$('.ck-need input')).length === 0, 'no entry form while staff enter by hand');
  const rows = await page.$$eval('.ck .jc-charge', (r) => r.length);
  ok(rows === 12, `every other check is listed (${rows})`);
  const row = (id) => textOf(page, `[data-check="${id}"]`);
  ok(/In Zeffy/.test(await row('t1')) && /Found the hand entry/.test(await row('t1')), 'a hand entry reads In Zeffy');
  ok(/would use Help Build a Brighter Home/.test(await row('t3')), 'Watch says what it would do');
  ok(/Mercury is reviewing it/.test(await row('t4')), 'a pending check says Mercury has it');
  ok(!/Needs its Category/.test(await row('u1')), 'while watching, no talk of categories');
  ok(/Left out/.test(await row('t6')) && /refund/.test(await row('t6')), 'a refund says it was left out and why');
  ok(/Store account/.test(await row('t7')), 'a store deposit says so');
  ok(/Came back/.test(await row('t8')), 'a returned check says so');
  ok(/Waiting for the hand entry/.test(await row('p1')), 'a check it can\'t read waits for the hand entry while watching');
  ok(/Cancel the record in Zeffy|came back/i.test(await row('t8')), 'a returned check says what happened');
  ok(!/routing|account number/i.test(await textOf(page, '.ck')), 'nothing on the page talks about account numbers');
  await page.screenshot({ path: `${OUT}watch.png`, fullPage: true });
  await axe(page, 'Watch');

  console.log('Turning it on');
  await writeState(DB, 'check-gifts', { writeTest: { id: 'x', ok: true } });
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('.ck');
  let asked = '';
  await answerAsks(page, { accept: true, onAsk: (t) => { asked = t; } });
  ok(await clickIn(page, '.ck .notice', 'Let the site enter checks'), 'the button appears once the write test passed');
  await page.waitForFunction(() => /enters checks in Zeffy/.test(document.querySelector('.ck')?.textContent || ''), { timeout: 5000 });
  ok(/Needs its Category in Mercury/.test(await row('u1')) && /Individual Contribution or Contribution/.test(await row('u1')), 'a check not marked a contribution says so');
  ok(/Staff stop entering/.test(asked), 'it says what changes for staff before it does');
  ok(/Holly/.test(await textOf(page, '.ck .notice')), 'it says who turned it on');
  await page.waitForFunction(() => document.querySelectorAll('.ck-need select option').length > 2, { timeout: 5000 });
  ok((await needIds(page)).length === 4, 'all four checks now wait on someone');
  ok(/Golf sponsor/.test(await textOf(page, '[data-check="p3"]')), 'the event shows its memo');
  ok(!(await page.$('[data-check="p3"] input')), 'an event has no entry form: Zeffy takes it by hand');
  ok(/Open Zeffy/.test(await textOf(page, '[data-check="p3"]')), 'it links to Zeffy');
  await page.screenshot({ path: `${OUT}on.png`, fullPage: true });
  await axe(page, 'On');

  console.log('A check it couldn\'t read');
  const form = '[data-check="p1"]';
  ok(await page.$eval(`${form} .btn-primary`, (b) => b.disabled), 'Save waits for a name');
  await page.type(`${form} input:not([type=date])`, 'Rosa Whitfield');
  await wait(50);
  ok((await page.$eval(`${form} select`, (s) => s.value)) === 'form_home', 'the general form is already picked');
  ok(!(await page.$eval(`${form} select`, (s) => [...s.options].some((o) => /Fairway/.test(o.textContent)))), 'a ticketing campaign is never offered');
  await page.click(`${form} .btn-primary`);
  await page.waitForFunction(() => !document.querySelector('.ck-need[data-check="p1"]'), { timeout: 5000 });
  ok(zeffy.posts.length === 1 && zeffy.posts[0].first_name === 'Rosa' && zeffy.posts[0].last_name === 'Whitfield', 'the record goes to Zeffy with that name');
  ok(zeffy.posts[0].generate_tax_receipt === false && zeffy.posts[0].send_confirmation_email === false, 'nothing is sent to the donor');
  ok(/Saved by Holly/.test(await textOf(page, '[data-check="p1"]')), 'the row says who saved it');

  console.log('A possible double');
  let double = '';
  await answerAsks(page, { accept: false, onAsk: (t) => { double = t; } });
  const two = '[data-check="p2"]';
  await page.click(`${two} .btn-primary`);
  await page.waitForFunction(() => document.querySelector('.ask-overlay') === null, { timeout: 5000 }).catch(() => {});
  await wait(400);
  ok(/different gift/.test(double), 'saving anyway asks first');
  ok(zeffy.posts.length === 1, 'Cancel saves nothing');
  await answerAsks(page, { accept: true });
  await clickIn(page, two, 'This is the check');
  await page.waitForFunction(() => !document.querySelector('.ck-need[data-check="p2"]'), { timeout: 5000 });
  ok(zeffy.posts.length === 1, 'matching it makes no new record');
  ok(/Matched by Holly/.test(await textOf(page, '[data-check="p2"]')), 'the row says who matched it');

  console.log('Not a gift, and a gift left out');
  await clickIn(page, '[data-check="p4"]', 'It isn’t a gift');
  await page.waitForFunction(() => !document.querySelector('.ck-need[data-check="p4"]'), { timeout: 5000 });
  ok(/A person said/.test(await textOf(page, '[data-check="p4"]')), 'it says a person left it out');
  await clickIn(page, '[data-check="t6"]', 'It’s a gift');
  await page.waitForSelector('[data-check="t6"] .ck-entry select');
  await wait(100);
  await page.click('[data-check="t6"] .btn-primary');
  await page.waitForFunction(() => /Saved by Holly/.test(document.querySelector('[data-check="t6"]')?.textContent || ''), { timeout: 5000 });
  ok(zeffy.posts.length === 2, 'a left-out check a person calls a gift goes in');
  await page.screenshot({ path: `${OUT}after.png`, fullPage: true });

  console.log('Letters and addresses');
  // Real-length words: a fund's long name, a long email and a long street line
  const LONG = { line1: '12345 Northwest Peachtree Industrial Boulevard Apt 1402', city: 'Peachtree Corners', state: 'GA', postal_code: '30092-1234', country: 'US' };
  await seed({ ...base, id: 'l1', cents: 2500000, status: 'pending', posted_at: null, deposited_at: new Date().toISOString(), state: 'read', payer: 'Dana Whitfield', drawer: 'Whitfield Family Charitable Fund at Harbor Trust Advisors',
    letter: JSON.stringify({ about: true, name: 'Dana Whitfield', email: 'dana.whitfield.family.giving@example.com', address: LONG, files: ['receipt:letter.jpg'], pending: [] }), address: JSON.stringify({ line1: '400 Harbor Trust Plaza Suite 1900', city: 'Atlanta', state: 'GA', postal_code: '30303', country: 'US', from: 'check', for: 'Whitfield Family Charitable Fund at Harbor Trust Advisors' }) });
  for (const id of ['l1', 'l2', 'l3', 'l4']) await marked(id);
  await seed({ ...base, id: 'l2', cents: 100000, state: 'created', via: 'site', zeffy_id: 'zl2', payer: 'Oakline Design Build LLC', letter: JSON.stringify({ files: ['receipt:IMG_2231.jpg'], pending: [], late: ['receipt:IMG_2231.jpg'] }) });
  await seed({ ...base, id: 'l3', cents: 40000, state: 'created', via: 'site', zeffy_id: 'zl3', payer: 'Rosa Ortiz', address: JSON.stringify({ line1: '9 Elm St', city: 'Roswell', state: 'GA', postal_code: '30075', country: 'US', from: 'check', for: 'Rosa Ortiz' }), address_done: 'refused',
    address_tried: JSON.stringify({ address: { line1: '9 Elm St', city: 'Roswell', state: 'GA', postal_code: '30075', country: 'US' }, email: '', who: 'Rosa Ortiz' }) });
  await seed({ ...base, id: 'l4', cents: 60000, state: 'created', via: 'site', zeffy_id: 'zl4', payer: 'Ken Bryant', address: JSON.stringify({ line1: '77 Mill St', city: 'Alpharetta', state: 'GA', postal_code: '30009', country: 'US', from: 'check', for: 'Ken Bryant' }), address_done: 'written' });
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('.ck');
  await page.waitForFunction(() => !!document.querySelector('.ck-need[data-check="l2"]'), { timeout: 5000 });
  ok(/Goes into Zeffy/.test(await row('l1')), 'a check deposited today says when it goes in');
  ok(/Check from Whitfield Family/.test(await row('l1')) && /Letter: from Dana Whitfield/.test(await row('l1')), 'it shows the name on the check and the letter\'s');
  ok(/Receipt to dana\.whitfield/.test(await row('l1')) && /Mail \(from the letter\): 12345 Northwest/.test(await row('l1')) && /Mail on the check: 400 Harbor/.test(await row('l1')), 'and where the receipt and the mail go');
  ok((await needIds(page)).includes('l2') && (await needIds(page)).includes('l3'), 'a letter after the record and a refused address wait on someone');
  ok(/A file was added in Mercury after this check went into Zeffy/.test(await textOf(page, '.ck-need[data-check="l2"]')), 'a file added after the record says what to do');
  ok(/Add it to Rosa Ortiz in Zeffy: 9 Elm St, Roswell, GA 30075/.test(await textOf(page, '.ck-need[data-check="l3"]')), 'the address to-do names the address');
  ok(/Mail on the check: 77 Mill St, Alpharetta, GA 30009/.test(await row('l4')) && /Address in Zeffy/.test(await row('l4')), 'an address in Zeffy says so');
  await page.screenshot({ path: `${OUT}letters.png`, fullPage: true });
  await axe(page, 'letters');
  ok(await clickIn(page, '.ck-need[data-check="l2"]', 'Looked at it'), 'a letter to-do has "Looked at it"');
  await page.waitForFunction(() => !document.querySelector('.ck-need[data-check="l2"]'), { timeout: 5000 });
  ok(/In Zeffy/.test(await row('l2')), '"Looked at it" takes the to-do off');

  console.log('Back to watching');
  await clickIn(page, '.ck .notice', 'Go back to watching');
  await page.waitForFunction(() => /The site is watching/.test(document.querySelector('.ck')?.textContent || ''), { timeout: 5000 });
  ok(true, 'it goes back to watching');
  ok(errors.length === 0, `no console errors on the laptop${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
  await page.close();

  console.log('Phone');
  await DB.prepare('UPDATE check_gifts SET state = ?, reason = ?, zeffy_id = NULL WHERE id = ?').bind('person', 'unreadable', 'p1').run();
  await writeState(DB, 'check-gifts', { mode: 'on', onBy: 'holly@soardcharity.com', onAt: new Date().toISOString() });
  const phone = await open(browser, origin, { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await phone.page.waitForFunction(() => document.querySelectorAll('.ck-need select option').length > 2, { timeout: 5000 });
  await phone.page.screenshot({ path: `${OUT}phone.png`, fullPage: true });
  await phoneChecks(phone.page, 'On, phone');
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
