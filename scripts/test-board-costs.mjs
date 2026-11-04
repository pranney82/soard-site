/**
 * test-board-costs.mjs — What makeovers cost and the Families, on the board page, in a real browser
 * ==================================================================================================
 * The real handlers behind the real sign-in middleware on an in-memory D1, JobTread faked with finished
 * makeovers (made-up families and costs; the repo is public). Checks, at 1440px and 390px:
 *   - Home's "What makeovers cost": the money over the $500,000 operating balance (the same cash as Home's
 *     figure), a makeover lately, the families waiting best score first, each netted by its sponsor's pledge
 *   - the dots: a row a type, the hover and keyboard readout, the season switch, the table
 *   - a Board admin changes the operating balance where it shows; a member can't
 *   - the Families: the list ranked by score, a family's facts and every scorer's card, never their contact
 *     details or a scorer's notes; Home stays lit in the menu
 *   - the Qualification Committee's agenda item and its slide on the screen (1280x720 and 1920x1080)
 *   - axe, nothing past the right edge on a phone, no console errors
 * Screenshots land in test-results/board-costs/. Exits non-zero on any failure.
 *
 *   node scripts/test-board-costs.mjs
 */
import puppeteer from 'puppeteer';
import http from 'node:http';
import { mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, extname } from 'node:path';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import { answerAsks } from './lib/ask.mjs';
import { onRequest as middleware, _resetKeyCacheForTests } from '../functions/api/_middleware.js';
import * as boardAdmin from '../functions/api/board-admin.js';
import * as boardPortal from '../functions/api/board-portal.js';
import { saveMeeting, ensureSchema } from '../functions/api/_board.js';
import { writeState } from '../functions/api/_board-roles.js';
import { ensureApplicantSchema } from '../functions/api/_applicants.js';
import { saveScorecard } from '../functions/api/_applicant-scores.js';
import { savePledge } from '../functions/api/_sponsor-pledges.js';
import { cleanMeeting } from '../public/admin/board-shared.js';
import { criteriaOf, SHEET_RUBRIC } from '../public/admin/scoring-shared.js';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/board-costs/');
mkdirSync(OUT, { recursive: true });
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const STATUS = '22P52qfFub9b';

const FOUNDER = 'jane@soardcharity.com';
const MEMBER = 'kim.board@example.com';
const PEOPLE = {
  'jane-doe': { name: 'Jane Doe', group: 'team', title: 'Co-Founder/President', order: 1 },
  'kim-park': { name: 'Kim Park', group: 'board', title: 'Board Member', organization: 'Park Media', committees: ['Qualification'], order: 1 },
};
const img = (id) => `https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/${id}/public`;
const KIDS = {
  'ava-2026': { name: 'Ava', year: 2026, roomTypes: ['Accessible Bathroom'], status: 'completed', heroImage: img('kids/ava') },
  'ben-2026': { name: 'Ben', year: 2026, roomTypes: ['Therapy Room'], status: 'completed' },
  'cleo-2025': { name: 'Cleo', year: 2025, roomTypes: ['Accessible Bathroom', 'Dream Bedroom'], status: 'completed' },
  'dan-2025': { name: 'Dan', year: 2025, roomTypes: ['Dream Bedroom'], status: 'completed' },
  'eve-2025': { name: 'Eve', year: 2025, roomTypes: ['Therapy Room'], status: 'completed' },
  'finn-2024': { name: 'Finn', year: 2024, roomTypes: ['Accessible Bathroom'], status: 'completed' },
  'gia-2026': { name: 'Gia & Rosa', year: 2026, roomTypes: ['Accessible Bathroom', 'Dream Bedroom'], status: 'completed' },
  'hal-2026': { name: 'Hal', year: 2026, roomTypes: ['Therapy Room'], status: 'completed' },
  'kai-2025': { name: 'Kai', year: 2025, roomTypes: ['Dream Bedroom'], status: 'completed' },
  'iris-2026': { name: 'Iris', year: 2026, roomTypes: ['Therapy Room'], status: 'needs-funding', publishStatus: 'draft', sponsors: ['acme-builders'], heroImage: img('kids/iris') },
  'jay-2026': { name: 'Jay', year: 2026, roomTypes: ['Accessible Bathroom'], status: 'needs-funding' },
};
const job = (id, name, status, cost, extra = {}) => ({ id, name, description: extra.description ?? null, createdAt: extra.createdAt || '2025-03-05T17:20:00Z', closedOn: extra.closedOn ?? null, actualCost: cost, location: { account: { name: extra.account || name.replace(/ \(\d{4}\)$/, '') } }, customFieldValues: { nodes: status ? [{ value: status, customField: { id: STATUS } }] : [] } });
const JOBS = [
  job('jAva', 'Ava Example (2026)', 'Closed Done', 26000),
  job('jBen', 'Ben Example (2026)', 'Closed Done', 18000),
  job('jCleo', 'Cleo Example (2025)', 'Closed Done', 42000, { closedOn: '2026-03-10' }),
  job('jDan', 'Dan Example (2025)', 'Closed Done', 6500, { closedOn: '2026-03-10' }),
  job('jEve', 'Eve Example (2025)', 'Closed Done', 3000),
  job('jFinn', 'Job 15', null, 14500, { account: 'Finn Reid Example', createdAt: '2023-05-02T15:00:00Z', closedOn: '2024-07-30' }),
  job('jGia', 'Gia & Rosa Example (2026)', 'Closed Done', 51000),
  job('jHal', 'Hal Example (2026)', 'Closed Done', 22500),
  job('jKai', 'Kai Example (2025)', 'Closed Done', null, { closedOn: '2026-03-10' }),
  job('jLou', 'Lou Example (2023)', null, 19000, { description: 'Accessible Bathroom,Dream Bedroom', createdAt: '2023-05-01T15:00:00Z', closedOn: '2025-02-03' }),
  job('jIris', 'Iris Example (2026)', 'Awaiting Funding', null),
  job('jJay', 'Jay Example (2026)', 'Awaiting Funding', null),
  job('jMax', 'Max Example (2026)', 'Build', 12500),
  job('jTest', 'TEST Ava Example (2026)', 'Closed Done', 99999),
];

const certsKey = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', certsKey.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
async function tokenFor(email) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ iss: 'https://soard.cloudflareaccess.com', aud: ['aud-tag'], email, iat: now, nbf: now, exp: now + 3600 }));
  return `${h}.${p}.${b64u(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', certsKey.privateKey, new TextEncoder().encode(`${h}.${p}`))))}`;
}

const DB = await createD1();
for (const sql of [
  'CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)',
  'CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)',
  'CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)',
  'CREATE TABLE kids (slug TEXT PRIMARY KEY, name TEXT, year INTEGER, data TEXT)',
  'CREATE TABLE community (slug TEXT PRIMARY KEY, name TEXT, data TEXT)',
  'CREATE TABLE events (slug TEXT PRIMARY KEY, data TEXT)',
  'CREATE TABLE partners (slug TEXT PRIMARY KEY, data TEXT)',
  'CREATE TABLE audit_log (id INTEGER PRIMARY KEY, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)',
]) await DB.exec(sql);
for (const [slug, d] of Object.entries(PEOPLE)) await DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.group, JSON.stringify(d)).run();
await DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind('kim-park', MEMBER).run();
for (const [slug, d] of Object.entries(KIDS)) await DB.prepare('INSERT INTO kids (slug, name, year, data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.year, JSON.stringify({ slug, childCount: 1, roomCount: d.roomTypes.length, ...d })).run();
await DB.prepare('INSERT INTO partners (slug, data) VALUES (?, ?)').bind('acme-builders', JSON.stringify({ slug: 'acme-builders', name: 'Acme Builders' })).run();
await ensureSchema(DB);
await ensureApplicantSchema(DB);
const applicant = (id, name, status, year, types, fields, jobId = null) => DB.prepare(`INSERT INTO applicants (account_id, name, status, year, types, fields, address, city, county, contact_name, contact_email, contact_phone, job_id, job_name, created_at, synced_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, name, status, year, JSON.stringify(types), JSON.stringify(fields), '12 Elm St, Roswell, GA 30075', 'Roswell', 'Fulton', 'Parent Example', 'parent@example.com', '+15555550100', jobId, jobId ? `${name} (${year})` : null, '2026-01-10T15:00:00Z', new Date().toISOString()).run();
await applicant('acctIris01', 'Iris Example', 'Approved', '2026', ['Therapy Room'], { diagnosis: 'Example diagnosis, for the test', birthday: '2018-05-01', mobile: 'No', verbal: 'No', language: 'English', referredBy: 'A therapist', qualified: 'Yes' }, 'jIris');
await applicant('acctJay001', 'Jay Example', 'Approved', '2026', ['Bathroom'], { diagnosis: 'Another example diagnosis', birthday: '2015-09-12', mobile: 'Yes', verbal: 'Yes', language: 'Spanish' }, 'jJay');
await applicant('acctNora01', 'Nora Example', 'In Review', '2026', ['Bedroom'], { diagnosis: 'Example', birthday: '2019-01-01' });
await applicant('acctOmar01', 'Omar Example', 'Denied', '2026', ['Ramp'], { denialReason: 'Outside the service area (an example)' });
await applicant('acctTest01', 'TEST Applicant', 'Applied', '2026', ['Bedroom'], {});
// A newer season with only a community project in it (the page opens on the newest season with a family)
await applicant('acctOak001', 'Oak Academy Example', 'Approved', '2027', [], {});
const keys = criteriaOf(SHEET_RUBRIC).map((c) => c.key);
const card = (n, odd = null) => Object.fromEntries(keys.map((k, i) => [k, odd != null && i === 0 ? odd : n]));
await saveScorecard(DB, 'acctIris01', { evaluator: 'lin.smith@soardcharity.com', name: 'Lin Smith', scores: card(4), notes: 'A scorer’s private note' });
await saveScorecard(DB, 'acctIris01', { evaluator: 'max.ruiz@soardcharity.com', name: 'Max Ruiz', scores: card(4, 1) });
await saveScorecard(DB, 'acctJay001', { evaluator: 'lin.smith@soardcharity.com', name: 'Lin Smith', scores: card(4, 1) });
await saveScorecard(DB, 'acctJay001', { evaluator: 'max.ruiz@soardcharity.com', name: 'Max Ruiz', scores: card(3) });
await saveScorecard(DB, 'acctNora01', { evaluator: 'lin.smith@soardcharity.com', name: 'Lin Smith', scores: card(3) });
await savePledge(DB, { kid: 'iris-2026', partner: 'acme-builders', pledged: 10000, received: 2500 });
// The bank, as Plaid last read Chase: $669,602
const now = new Date().toISOString();
await writeState(DB, 'cash', { at: now, value: { total: 669602, mercuryTotal: null, accounts: [{ bank: 'Chase', name: 'Checking', kind: 'checking', balance: 569602 }, { bank: 'Chase', name: 'CD', kind: 'cd', balance: 100000 }], owed: [], banksAt: now, stale: [], at: now } });
const meeting = await saveMeeting(DB, cleanMeeting({ date: day(6), start: '08:00', end: '10:00', shared: true, sections: [
  { title: 'Committee reports', items: [{ title: 'Financial', live: 'cash' }, { title: 'Qualification Committee', live: 'costs', presenter: 'Kim Park', who: ['kim-park'] }] },
] }), { by: FOUNDER });
const QUAL = meeting.sections[0].items[1].id;

const env = { DB, CF_ACCESS_TEAM_DOMAIN: 'soard', CF_ACCESS_AUD: 'aud-tag', RESEND_API_KEY: 're_test', JOBTREAD_GRANT_KEY: 'jt-test' };
const realFetch = globalThis.fetch;
let jtCalls = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === 'https://soard.cloudflareaccess.com/cdn-cgi/access/certs') return Response.json({ keys: [jwk] });
  if (url.startsWith('https://api.resend.com/')) return Response.json({ id: 'em_1' });
  if (url === 'https://api.jobtread.com/pave') { jtCalls += 1; return Response.json({ organization: { jobs: { nodes: JOBS, nextPage: null } } }); }
  if (/googleapis\.com/.test(url)) return Response.json({ items: [], messages: [], members: [], files: [] });
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url)) throw new Error(`test-board-costs: unexpected outside call ${url}`);
  return realFetch(input, init);
};
_resetKeyCacheForTests();

const ROUTES = { '/api/board-admin': boardAdmin, '/api/board-portal': boardPortal };
const csp = (() => {
  const lines = readFileSync(join(ROOT, 'public/_headers'), 'utf8').split('\n');
  const at = lines.findIndex((l) => l.trim() === '/admin/*');
  return lines.slice(at + 1).find((l) => /^\s+Content-Security-Policy:/.test(l)).split('Content-Security-Policy:')[1].trim();
})();
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const who = req.headers['x-test-user'] || '';
    if (url.pathname === '/cdn-cgi/access/get-identity') { res.writeHead(who ? 200 : 401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(who ? { email: who, name: '' } : {})); return; }
    if (url.pathname.startsWith('/cdn-cgi/imagedelivery/')) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG); return; }
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !['host', 'connection', 'content-length'].includes(k)) headers.set(k, v);
      if (who) headers.set('CF-Access-JWT-Assertion', await tokenFor(who));
      const request = new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks), duplex: 'half' });
      const ctx = { request, env, data: {}, waitUntil: () => {} };
      ctx.next = async () => {
        const fn = ROUTES[url.pathname]?.[`onRequest${req.method[0]}${req.method.slice(1).toLowerCase()}`];
        return fn ? fn(ctx) : Response.json({ success: true, ok: true, items: [], pages: 1, files: [], entries: [] });
      };
      const out = await middleware(ctx);
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
      return;
    }
    let file = join(ROOT, 'public', decodeURIComponent(url.pathname));
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) { res.writeHead(404); res.end('Not found'); return; }
    const head = { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' };
    if (url.pathname.startsWith('/admin/')) head['Content-Security-Policy'] = csp;
    res.writeHead(200, head);
    res.end(readFileSync(file));
  } catch (err) {
    console.error('server', err);
    res.writeHead(500); res.end(String(err));
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const SITE = `http://localhost:${server.address().port}`;
const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-gpu', '--disable-gpu-vsync', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'] });
const consoleErrors = [];
async function tab(email, width = 1440, height = 1000) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: width < 600, hasTouch: width < 600 });
  await page.setExtraHTTPHeaders({ 'x-test-user': email });
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|x-test-user/.test(m.text())) consoleErrors.push(`${email} ${width}: ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`${email} ${width}: ${e.message}`));
  await answerAsks(page);
  return page;
}
// (counts and amounts are kept with their words by no-break spaces: read as plain ones)
const textOf = (page, sel) => page.$eval(sel, (e) => e.innerText.replace(/\u00a0/g, ' ')).catch(() => '');
const overflow = (page) => page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
async function shotOf(page, sel, name) {
  const el = await page.$(sel);
  if (!el) return;
  await el.scrollIntoView();
  await sleep(250);
  await el.screenshot({ path: join(OUT, `${name}.png`) });
}
async function axe(page, sel, label) {
  await sleep(300);
  await page.evaluate(AXE);
  const r = await page.evaluate(async (s) => (await window.axe.run(document.querySelector(s), { resultTypes: ['violations'] })).violations.map((v) => `${v.id} (${v.nodes.length}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join('; ')})`), sel);
  ok(r.length === 0, `axe: no violations on ${label}${r.length ? `: ${r.join(', ')}` : ''}`);
}

try {
  console.log('Home, a board member, 1440px');
  const kim = await tab(MEMBER);
  await kim.goto(`${SITE}/admin/board/#/`, { waitUntil: 'networkidle0' });
  await kim.waitForSelector('#costs', { timeout: 10000 });
  const card = await textOf(kim, '#costs');
  ok(/For makeovers now\s*\$169,602/.test(card), 'For makeovers now: $669,602 in the bank less the $500,000 operating balance');
  ok(/\$669,602 in the bank, less \$500,000 kept to run SOARD/.test(card), 'it says where the number comes from');
  ok(/Enough for Iris and Jay, about \$30,500 together, then about 6 more makeovers at the median cost, \$22,500\./.test(await textOf(kim, '#costs .bc-answer__says')), `the answer, in a sentence (${await textOf(kim, '#costs .bc-answer__says')})`);
  const parts = await kim.$$eval('#costs > *', (els) => els.map((e) => e.className.split(' ')[0]));
  ok(parts.indexOf('bc-answer') === 1 && parts.indexOf('bc-split') === 2, `the answer first, then who’s waiting beside the median (${parts.join(', ')})`);
  const homeCash = await kim.$eval('.bp-fig .bp-fig__value', (e) => e.textContent).catch(() => '');
  ok(/\$670K/.test(homeCash), `Home’s cash figure is the same money (${homeCash})`);
  ok(/Median makeover, 2025 and 2026\s*\$22,500/.test(card), 'the median makeover of the last two seasons');
  ok(/Average\s*\$24,143\s*Low\s*\$3,000\s*High\s*\$51,000\s*Of 7 completed makeovers/.test(await textOf(kim, '#costs .bc-median')), 'with the average, the low and the high, of the 7 (Kai, with no bills, left out)');
  ok(/7 completed makeovers: median \$22,500, average \$24,143, low \$3,000 \(Eve, 2025\), high \$51,000 \(Gia & Rosa, 2026\)/.test(card), 'the four numbers over the chart, with who each end is');
  ok(/Waiting on the money, best score first/.test(card), 'two families waiting');
  const fams = await kim.$$eval('.bc-fam', (els) => els.map((e) => e.innerText.replace(/[\s\u00a0]+/g, ' ')));
  ok(fams.length === 2 && /Iris/.test(fams[0]) && /Score 38\.5/.test(fams[0]) && /Jay/.test(fams[1]), `best score first: Iris 38.5, then Jay (${fams.map((f) => f.slice(0, 40)).join(' | ')})`);
  ok(/About \$8,000/.test(fams[0]) && /\$18,000, less \$10,000 pledged by Acme Builders/.test(fams[0]), 'Iris: the therapy rooms’ typical, less Acme’s pledge');
  ok(/the median of 3 therapy rooms in 2025 and 2026/.test(fams[0]), 'what her estimate rests on');
  ok(/Covered/.test(fams[0]) && /Covered/.test(fams[1]), 'both covered');
  ok(/About \$22,500/.test(fams[1]) && /The median of 7 completed makeovers in 2025 and 2026/.test(fams[1]), 'Jay: too few bathrooms alone, so every makeover lately');

  ok(!(await kim.$('.bc-link')), 'a board member can’t change the operating balance');
  ok(!/99,999/.test(card), 'a TEST job never counts');
  const rows = await kim.$$eval('#costs .bc-row__label strong', (els) => els.map((e) => e.textContent));
  ok(rows.join('|') === 'Accessible bathroom|Dream bedroom|Therapy room|Bathroom and bedroom', `rows by what was built, lately (${rows.join(', ')})`);
  ok((await kim.$$('#costs .bc-dot')).length === 7, 'a dot each for the 7 lately');
  ok(/Not counted: Kai \(2025\), with no bills in JobTread\./.test(card), 'Kai is named, not counted');
  // Hover a dot: the family, the season, the rooms, the cost
  const dot = await kim.$('#costs .bc-row:nth-child(4) .bc-dot:last-of-type');
  await dot.hover();
  await sleep(200);
  const tipText = await textOf(kim, '#costs .bc-tip');
  ok(/\$51,000/.test(tipText) && /Gia & Rosa · 2026/.test(tipText) && /Accessible Bathroom \+ Dream Bedroom/.test(tipText), `hovering a dot says who and what (${tipText.replace(/\n/g, ' · ')})`);
  // (the row's name and its numbers: a dot's readout may still be open over it)
  const byRoom = await kim.$$eval('#costs .bc-row', (rs) => rs.map((r) => [...r.querySelectorAll('.bc-row__label, .bc-row__nums')].map((e) => e.innerText).join(' ').replace(/[\s\u00a0]+/g, ' ').trim()));
  ok(byRoom.join(' | ') === 'Accessible bathroom 1 makeover Paid $26,000 | Dream bedroom 1 makeover Paid $6,500 | Therapy room 3 makeovers Median $18,000 Average $14,500 Range $3,000 to $22,500 | Bathroom and bedroom 2 makeovers Median $46,500 Average $46,500 Range $42,000 to $51,000', `by room, at each row’s end: how many, median, average, low to high (${byRoom.join(' | ')})`);
  await shotOf(kim, '#costs', 'home-costs-1440');
  // The keyboard: one stop, arrows along and between rows
  await kim.focus('#costs .bc-dot[tabindex="0"]');
  const first = await kim.evaluate(() => document.activeElement.getAttribute('aria-label'));
  await kim.keyboard.press('ArrowRight');
  const second = await kim.evaluate(() => document.activeElement.getAttribute('aria-label'));
  await kim.keyboard.press('ArrowDown');
  const below = await kim.evaluate(() => document.activeElement.getAttribute('aria-label'));
  ok(/^Ava, 2026: \$26,000/.test(first) && /^Dan, 2025: \$6,500/.test(second), `→ moves to the next dot, the next row’s after a row’s last (${first} → ${second})`);
  ok(below && below !== second, `↓ moves to the next row (${below})`);
  ok((await kim.$$eval('#costs .bc-dot[tabindex="0"]', (e) => e.length)) === 1, 'the chart is one stop for Tab');
  // Every year: Finn (2024) and Lou (2023, no page) join
  await kim.evaluate(() => [...document.querySelectorAll('#costs .bc-seg button')].find((b) => /Every year/.test(b.textContent)).click());
  await sleep(200);
  ok((await kim.$$('#costs .bc-dot')).length === 9, 'every year: 9 dots');
  ok(/^Accessible bathroom 2 makeovers Median \$20,250 Average \$20,250 Range \$14,500 to \$26,000$/.test(await kim.$eval('#costs .bc-row', (r) => [...r.querySelectorAll('.bc-row__label, .bc-row__nums')].map((e) => e.innerText).join(' ').replace(/[\s\u00a0]+/g, ' ').trim())), 'by room follows the switch (Finn’s 2024 bathroom joins)');
  ok(/Every year since 2023/.test(await textOf(kim, '#costs .bc-seg')), 'since the first season with bills');
  ok(/9 completed makeovers: median \$19,000, average \$22,500, low \$3,000 \(Eve, 2025\), high \$51,000 \(Gia & Rosa, 2026\)/.test(await textOf(kim, '#costs .bc-stats')), `the four numbers follow the switch (${await textOf(kim, '#costs .bc-stats')})`);
  // (after the season switch has laid the chart out again: a click aimed before it lands where the summary was)
  await sleep(400);
  await kim.click('#costs .bc-table summary');
  await kim.waitForFunction(() => document.querySelector('#costs .bc-table')?.open, { timeout: 4000, polling: 100 }).catch(() => {});
  await sleep(150);
  const table = await textOf(kim, '#costs .bc-table');
  ok(/Lou\s+2023\s+Accessible Bathroom \+ Dream Bedroom\s+\$19,000/.test(table), `the table lists every one (Lou, a job with no page, under his first name)${/Lou/.test(table) ? '' : `: ${table.slice(0, 300)}`}`);
  ok(await kim.$('#costs .bc-table a[href="/kids/ava-2026/"]'), 'a makeover with a page links to it');
  await axe(kim, '#costs', 'What makeovers cost');

  console.log('The Families, read-only');
  await kim.click('#costs .bc-families a');
  await kim.waitForSelector('.bf-list', { timeout: 8000 });
  const list = await textOf(kim, '.bf');
  ok(await kim.$eval('.bc-seg button[aria-pressed="true"]', (b) => b.textContent.trim()).then((t) => t === '2026', () => false), 'it opens on 2026, the newest season with a family (2027 has only a school)');
  ok(/^4 families · 2 ranked · 2 Strong Candidate$/.test(await textOf(kim, '.bf-sum')), `families counted as families (${await textOf(kim, '.bf-sum')})`);
  const order = await kim.$$eval('.bf-row__who strong', (els) => els.map((e) => e.textContent));
  ok(order.join('|') === 'Iris Example|Jay Example|Nora Example|Omar Example', `ranked best first, then partway, then the rest; no TEST (${order.join(', ')})`);
  ok(/38\.5\s*Strong Candidate/.test(list) && /33\.5\s*Strong Candidate/.test(list), 'scores with their tiers');
  ok(/1 of 2 scored/.test(list), 'Nora: partway');
  ok(await kim.$eval('.bp-nav a[aria-current="page"]', (a) => a.getAttribute('href')).then((h) => h === '#/', () => false), 'Home stays lit in the menu');
  ok(!/parent@example\.com|5555550100|12 Elm St|Parent Example/.test(list), 'never how to reach a family');
  await kim.evaluate(() => [...document.querySelectorAll('.bf-chips button')].find((b) => /^Approved/.test(b.textContent)).click());
  ok((await kim.$$('.bf-row')).length === 2, 'the Approved chip keeps the two approved');
  await axe(kim, '.bf', 'Families');
  await shotOf(kim, 'main', 'families-1440');
  await kim.goto(`${SITE}/admin/board/#/families/acctIris01`, { waitUntil: 'networkidle0' });
  await kim.waitForSelector('.bf-cards', { timeout: 8000 });
  const fam = await textOf(kim, '.bf');
  ok(/Iris Example/.test(fam) && /Example diagnosis, for the test/.test(fam) && /A therapist/.test(fam), 'the facts their score rests on');
  ok(/Lin Smith/i.test(fam) && /Max Ruiz/i.test(fam) && /Total, of 50\s+38\.5\s+40\s+37/.test(fam), 'each scorer’s card, and the average of their totals');
  ok(/Worth talking about/.test(fam), 'a criterion the scorers are far apart on is marked');
  ok(!/private note|parent@example\.com|5555550100|12 Elm St|lin\.smith@/.test(fam), 'never a scorer’s notes or the family’s contact details');
  ok(await kim.waitForFunction(() => document.title === 'Iris Example · SOARD Board', { timeout: 4000 }).then(() => true, () => false), `the tab names the family (${await kim.title()})`);
  await axe(kim, '.bf', 'a family');
  await shotOf(kim, 'main', 'family-1440');
  await kim.goto(`${SITE}/admin/board/#/families/acctOmar01`, { waitUntil: 'networkidle0' });
  await kim.waitForFunction(() => /Omar Example/.test(document.querySelector('.bf-head')?.innerText || ''), { timeout: 8000 }).catch(() => {});
  ok(/Why not\s*Outside the service area/.test(await textOf(kim, '.bf-facts')), 'a family turned down says why');

  console.log('The Qualification Committee’s agenda item');
  await kim.goto(`${SITE}/admin/board/#/meetings/${meeting.id}`, { waitUntil: 'networkidle0' });
  await kim.waitForSelector('.bp-aglive--costs', { timeout: 10000 });
  await sleep(1200); // (the page's own transition settles before the picture)
  const ag = await textOf(kim, '.bp-aglive--costs');
  ok(/For makeovers now\s*\$169,602/.test(ag) && /Iris/.test(ag), 'the item shows the costs and who the money starts');
  ok(!/Every family’s application/.test(ag), 'without Home’s link out');
  await shotOf(kim, '.bp-aglive--costs', 'agenda-costs-1440');

  console.log('A Board admin changes the operating balance where it shows');
  const jane = await tab(FOUNDER);
  await jane.goto(`${SITE}/admin/board/#/`, { waitUntil: 'networkidle0' });
  await jane.waitForSelector('#costs .bc-link', { timeout: 10000 });
  await jane.click('#costs .bc-link');
  await jane.click('.bc-balance__input', { clickCount: 3 });
  await jane.keyboard.type('660,000');
  await jane.click('.bc-balance button[type="submit"]');
  await jane.waitForFunction(() => /For makeovers now\s*\$9,602/.test(document.querySelector('#costs')?.innerText || ''), { timeout: 8000 }).catch(() => {});
  const after = await textOf(jane, '#costs');
  ok(/For makeovers now\s*\$9,602/.test(after), 'at $660,000 kept, $9,602 is over it');
  ok(/Enough for Iris’s therapy room, about \$8,000\. Jay needs \$20,898 more\./.test(after), 'Iris is covered; Jay needs $20,898 more');
  const chips = await jane.$$eval('#costs .bc-fam .bc-chip', (els) => els.map((e) => e.textContent.replace(/\u00a0/g, ' ')));
  ok(chips.join('|') === 'Covered|Needs $20,898 more', `each family says where it stands (${chips.join(', ')})`);
  await shotOf(jane, '#costs', 'home-costs-short-1440');
  await jane.reload({ waitUntil: 'networkidle0' });
  await jane.waitForSelector('#costs', { timeout: 10000 });
  ok(/Change the \$660,000/.test(await textOf(jane, '#costs')), 'the new amount is kept');

  console.log('The screen');
  for (const [w, hh] of [[1280, 720], [1920, 1080]]) {
    const scr = await tab(FOUNDER, w, hh);
    await scr.goto(`${SITE}/admin/board/?present&at=${encodeURIComponent(QUAL)}#/meetings/${meeting.id}/screen`, { waitUntil: 'networkidle0' });
    await scr.waitForSelector('.bc--screen', { timeout: 10000 }).catch(() => {});
    const slide = await textOf(scr, '.bc--screen');
    ok(/For makeovers now/.test(slide) && /Enough for Iris’s therapy room/.test(slide) && /Completed makeovers by room, 2025 and 2026/.test(slide), `${w}x${hh}: the slide shows the money, its sentence and the dots`);
    const fits = await scr.evaluate(() => { const s = document.querySelector('.bc--screen'); if (!s) return false; const r = s.getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1; });
    ok(fits, `${w}x${hh}: it fits the screen`);
    await scr.screenshot({ path: join(OUT, `screen-${w}.png`) });
    await scr.close();
  }

  console.log('A phone, 390px');
  const phone = await tab(MEMBER, 390, 844);
  await phone.goto(`${SITE}/admin/board/#/`, { waitUntil: 'networkidle0' });
  await phone.waitForSelector('#costs', { timeout: 10000 });
  ok((await overflow(phone)) <= 0, 'Home: nothing past the right edge');
  const loose = await phone.$$eval('#costs .bc-fig__sub, #costs .bc-fig__value, #costs .bc-fam span, #costs .bc-lead, #costs .bc-answer__says, #costs .bc-row__nums dd, #costs .bc-mini dd, #costs .bc-stats', (els) => els.filter((e) => /\d[KMB%]? \p{L}/u.test(e.textContent)).map((e) => e.textContent.slice(0, 40)));
  ok(!loose.length, `every count and amount kept with its word (${loose.join(' | ')})`);
  await shotOf(phone, '#costs', 'home-costs-390');
  await phone.goto(`${SITE}/admin/board/#/families`, { waitUntil: 'networkidle0' });
  await phone.waitForSelector('.bf-list', { timeout: 8000 });
  ok((await overflow(phone)) <= 0, 'Families: nothing past the right edge');
  await phone.goto(`${SITE}/admin/board/#/families/acctIris01`, { waitUntil: 'networkidle0' });
  await phone.waitForSelector('.bf-cards', { timeout: 8000 });
  ok((await overflow(phone)) <= 0, 'a family: nothing past the right edge (the score table scrolls in its own box)');
  await shotOf(phone, 'main', 'family-390');
  ok(jtCalls <= 3, `JobTread read a few times, not on every page (${jtCalls})`);
} catch (err) {
  failures.push(`crashed: ${err.stack || err.message}`);
  console.error(err);
}
ok(consoleErrors.length === 0, `no console errors${consoleErrors.length ? `: ${consoleErrors.slice(0, 5).join(' | ')}` : ''}`);
await browser.close();
server.close();
console.log(failures.length ? `\n${failures.length} failed` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
