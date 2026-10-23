/**
 * test-demo-invites.mjs — drive the admin's Demo Day page in a real browser
 * ==========================================================================
 * Opens the admin at #demo-day (its own page in the menu, not a Reveals tab)
 * with public/ served directly. Every
 * /api/demo-invites-admin call goes to the real handler
 * (functions/api/demo-invites-admin.js) running here in Node over a local
 * D1 copy (sql.js) with JobTread and Google Calendar faked, so the page and
 * the server are checked together. Other /api calls are stubbed.
 *
 * Checks: each demo day coming up shows where it stands (sent, sent by hand,
 * ready, waiting for Set Start Date, no Demo date, not sent with Retry), the
 * invite and its guests by group, adding and removing people on the
 * every-demo-day list, the sponsor coming from the Sponsor role on the job
 * (flagged when the job names a sponsor with nobody on it), turning invites on (which sends the ready
 * one), Send ours anyway, Retry, Send it to me, the wording and default time
 * with a live preview, and a phone with no sideways scroll. Screenshots land
 * in test-results/demo-invites/. Exits non-zero on any failure or console error.
 *
 *   node scripts/test-demo-invites.mjs
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import * as admin from '../functions/api/demo-invites-admin.js';
import { reconcileDemo, writeConfig, FIELD_MONETARY_SPONSOR } from '../functions/api/_demo-invites.js';
import { FIELD_STATUS, FIELD_MAKEOVER_TYPE, FIELD_CONTACT_EMAIL } from '../functions/api/_reveal-invites.js';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/demo-invites/');
mkdirSync(OUT, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const D = 86400e3;
const easternDay = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(Date.now() + n * D));
const ORG = '22NJw42j5GLg';
const ORGANIZER = 'ccunningham@soardcharity.com';

// ── A pretend JobTread: five open jobs, made up, with example.com families ──
function job(id, name, { demo = 5, demoTime = null, startSet = true, sponsor = null, type = 'Bedroom', family = 'family', aces = [] } = {}) {
  return {
    id, name, closedOn: null, organization: { id: ORG },
    location: { address: `${id.length * 7} Example Way, Atlanta, GA 30301, USA`, account: { contacts: { nodes: [
      { name: `${name.split(' ')[0]}'s parent`, customFieldValues: { nodes: [{ value: `${family}.${id.slice(-4).toLowerCase()}@example.com`, customField: { id: FIELD_CONTACT_EMAIL } }] } },
    ] } } },
    customFieldValues: { nodes: [
      { value: 'Mobilization', customField: { id: FIELD_STATUS } },
      { value: type, customField: { id: FIELD_MAKEOVER_TYPE } },
      ...(sponsor ? [{ value: sponsor, customField: { id: FIELD_MONETARY_SPONSOR } }] : []),
    ] },
    tasks: { nodes: [
      { id: `${id}D`, name: 'Demo', isGroup: false, startDate: demo === null ? null : easternDay(demo), startTime: demoTime, endDate: demo === null ? null : easternDay(demo), endTime: null, progress: null },
      { id: `${id}S`, name: 'Set Start Date', isGroup: false, startDate: easternDay(-7), startTime: null, endDate: easternDay(-7), endTime: null, progress: startSet ? 1 : null },
    ] },
    aces: { nodes: aces },
  };
}
const JOBS = {
  '22PMaxSample1': job('22PMaxSample1', 'Max Sample (2026)', { demo: 2, type: 'Bathroom', sponsor: 'Jackson Healthcare', aces: [
    { membership: { isInternal: false, role: { name: 'Vendor' }, user: { name: 'Jen Designer', emailAddress: 'jen@design.example.com' } } },
    { membership: { isInternal: true, role: { name: 'Admin' }, user: { name: 'Qualification Committee', emailAddress: 'selection@soardcharity.com' } } },
  ] }),
  '22PLeoExampl1': job('22PLeoExampl1', 'Leo Example (2026)', { demo: 4, type: 'Therapy Room' }),
  '22PAvaStone01': job('22PAvaStone01', 'Ava Stone (2026)', { demo: 6, demoTime: '13:30:00.000', sponsor: 'Beazer', aces: [
    { membership: { isInternal: false, role: { name: 'Sponsor' }, user: { name: 'Bea Sponsor', emailAddress: 'bea@beazer.example.com' } } },
  ] }),
  '22PNoraExamp1': job('22PNoraExamp1', 'Nora Example (2026)', { demo: 8 }),
  '22PIslaExamp1': job('22PIslaExamp1', 'Isla Example (2026)', { demo: 12, startSet: false, sponsor: 'Brian Robins Family Foundation' }),
  '22PRemiExamp1': job('22PRemiExamp1', 'Remi Example (2026)', { demo: null }),
};
const MEMBERS = [
  { isInternal: true, role: { name: 'Admin' }, user: { name: 'Clareece Cunningham', emailAddress: ORGANIZER } },
  { isInternal: true, role: { name: 'Admin' }, user: { name: 'Christian Nielsen', emailAddress: 'cnielsen@soardcharity.com' } },
  { isInternal: true, role: { name: 'Designer' }, user: { name: 'Linzi Berkowitz', emailAddress: 'linzi@soardcharity.com' } },
  { isInternal: true, role: { name: 'Admin' }, user: { name: 'Qualification Committee', emailAddress: 'selection@soardcharity.com' } },
];
const SPONSORS = ['Jackson Healthcare', 'Helen & Jimmy Carlos', 'Beazer', 'SOARF', 'Make a Wish', 'MCN (Babby)', "Family's Community Crowd Funding", 'Brian Robins Family Foundation'];

// ── A pretend Google Calendar: Leo's demo day was already sent by hand ──
const events = new Map();
const handEvents = [{ id: 'handmade01', status: 'confirmed', summary: 'CONFIRMED: Leo Demo Day', start: { dateTime: `${easternDay(4)}T09:00:00-04:00` } }];
let googleDown = false;
const googleCalls = [];
async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  if (u.hostname === 'api.jobtread.com') {
    const q = JSON.parse(init.body).query;
    if (q.job) return Response.json({ job: JOBS[q.job.$.id] || null });
    if (q.organization?.jobs) return Response.json({ organization: { jobs: { nodes: Object.values(JOBS).map((j) => ({ id: j.id, name: j.name, tasks: j.tasks })), nextPage: null } } });
    if (q.organization?.customFields) return Response.json({ organization: { customFields: { nodes: [{ options: SPONSORS }] } } });
    if (JSON.stringify(q.organization?.memberships?.$?.where || '').includes('role')) return Response.json({ organization: { memberships: { nodes: [] } } });
    return Response.json({ organization: { memberships: { nodes: MEMBERS } } });
  }
  if (u.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'ya29.test', expires_in: 3600 });
  if (u.hostname === 'www.googleapis.com') {
    const method = init.method || 'GET';
    googleCalls.push(`${method} ${u.pathname}`);
    if (u.pathname.endsWith('/events') && method === 'GET') return Response.json({ items: [...handEvents, ...events.values()] });
    if (googleDown && method !== 'GET') return Response.json({ error: { message: 'Calendar usage limits exceeded.' } }, { status: 403 });
    const id = u.pathname.split('/events/')[1];
    if (method === 'GET') return events.has(id) ? Response.json(events.get(id)) : Response.json({ error: { message: 'Not Found' } }, { status: 404 });
    if (method === 'DELETE') { events.delete(id); return new Response(null, { status: 204 }); }
    const ev = JSON.parse(init.body);
    events.set(ev.id || id, ev);
    return Response.json(ev);
  }
  return Response.json({ ok: true });
}
globalThis.fetch = fakeFetch;

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const DB = await createD1({ schemaSql: [
  'CREATE TABLE kids (slug TEXT PRIMARY KEY, name TEXT NOT NULL, year INTEGER, status TEXT, data TEXT NOT NULL)',
  'CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)',
] });
await DB.prepare('INSERT INTO kids (slug, name, year, status, data) VALUES (?, ?, ?, ?, ?)').bind('max-2026', 'Max', 2026, 'in-progress', '{"name":"Max","slug":"max-2026"}').run();
await DB.prepare('INSERT INTO kids (slug, name, year, status, data) VALUES (?, ?, ?, ?, ?)').bind('ava-2026', 'Ava', 2026, 'in-progress', '{"name":"Ava","slug":"ava-2026"}').run();
const env = { DB, JOBTREAD_GRANT_KEY: 'grant_test', GOOGLE_CALENDAR_KEY: JSON.stringify({ client_email: 'cal@soard.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }) };

// Where things stand before the page opens: Max's invite went out, Leo's was found sent by hand,
// Nora's failed (Google refused it); then sending was paused, so Ava's is ready and waiting
await writeConfig(DB, { enabled: true });
await reconcileDemo(env, '22PMaxSample1');
await reconcileDemo(env, '22PLeoExampl1');
googleDown = true;
await reconcileDemo(env, '22PNoraExamp1');
googleDown = false;
await writeConfig(DB, { enabled: false });

const posts = [];
async function callAdmin(req) {
  const url = new URL(req.url());
  const waits = [];
  const context = { env, data: { userEmail: 'peter@soardcharity.com' }, waitUntil: (p) => waits.push(p) };
  let res;
  if (req.method() === 'POST') {
    const body = req.postData() || '{}';
    posts.push(JSON.parse(body));
    res = await admin.onRequestPost({ ...context, request: new Request(url, { method: 'POST', body }) });
  } else {
    res = await admin.onRequestGet({ ...context, request: new Request(url) });
  }
  await Promise.allSettled(waits);
  return { status: res.status, body: await res.text() };
}

function serve() {
  const server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(ROOT, 'public', p));
    if (!file.startsWith(join(ROOT, 'public')) || !existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

const BROADCAST = {
  success: true,
  state: { phase: 'idle', broadcastId: null, kit: {}, fb: {} },
  public: { phase: 'idle', live: false, upcoming: false, replay: false },
  config: { kitLive: { enabled: true, audience: { name: 'All subscribers' } }, messages: { enabled: true }, liveInput: { uid: 'in1', enabled: true }, facebook: { mode: 'api' }, youtube: {}, instagram: {}, reminders: { enabled: true, hoursBefore: [24, 1] }, orientation: 'portrait', reels: { enabled: true }, defaults: {}, alerts: { emails: [] }, replayHours: 72, timezone: 'America/New_York', outputs: {} },
  setup: { streamConfigured: true, inputReady: true, hubBound: true, kitConfigured: true, emailConfigured: true, alertEmails: [] },
  health: { lastTick: { at: new Date().toISOString(), source: 'hub:alarm', work: [] }, stream: { ok: true }, facebook: { ok: true }, webhook: {}, lifecycle: {} },
  hub: { ok: true, clients: 1 }, live: { lifecycle: { live: false } },
  outputs: [], recordings: [], sends: [], history: [], healthReports: {}, fbRecent: null, reminders: { counts: {}, recent: [] }, larix: {}, playback: {},
  schedule: { checkedAt: new Date().toISOString(), error: null, next: null, waiting: [] },
};

async function open(browser, base, viewport, hash = '#demo-day') {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource') && !m.text().includes('/api/live-ws')) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const url = new URL(req.url());
    const json = (obj, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.origin !== base) return req.abort();
    if (url.pathname === '/api/demo-invites-admin') {
      const r = await callAdmin(req);
      return req.respond({ status: r.status, contentType: 'application/json', body: r.body });
    }
    if (url.pathname === '/api/broadcast-admin') return json(BROADCAST);
    if (url.pathname === '/api/broadcast') return json({ success: true, state: BROADCAST.public });
    if (url.pathname === '/api/live-ws') return req.abort();
    if (url.pathname.startsWith('/api/list-content')) return json({ success: true, items: [], total: 0, hasMore: false });
    if (url.pathname.startsWith('/api/pending-changes')) return json({ success: true, changes: [], since: null });
    if (url.pathname.startsWith('/api/audit-log')) return json({ success: true, entries: [], total: 0 });
    if (url.pathname.startsWith('/api/deployments')) return json({ success: true, deploys: [], source: 'cloudflare' });
    if (url.pathname.startsWith('/api/')) return json({ success: true, ok: true });
    return req.continue();
  });
  await page.goto(`${base}/admin/${hash}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector(hash === '#broadcast' ? '.bc-tabs' : '.dd-list, .dd .card', { timeout: 20000 });
  return { page, errors };
}

const text = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
const row = (page, name) => page.evaluate((name) => {
  const li = [...document.querySelectorAll('.dd-row')].find((l) => l.querySelector('.dd-row__name')?.textContent.trim().startsWith(name));
  return li ? { chip: li.querySelector('.dd-chip')?.textContent.trim(), when: li.querySelector('.dd-row__when')?.textContent.trim(), text: li.textContent.replace(/\s+/g, ' ').trim(), buttons: [...li.querySelectorAll('button')].map((b) => b.textContent.trim()) } : null;
}, name);
const clickIn = (page, scope, label) => page.evaluate((scope, label) => {
  const root = typeof scope === 'string' && scope.startsWith('row:')
    ? [...document.querySelectorAll('.dd-row')].find((l) => l.querySelector('.dd-row__name')?.textContent.trim().startsWith(scope.slice(4)))
    : document.querySelector(scope);
  const b = [...(root?.querySelectorAll('button') || [])].find((x) => x.textContent.trim() === label);
  if (!b) return false;
  b.click();
  return true;
}, scope, label);
const until = (page, fn, arg) => page.waitForFunction(fn, { timeout: 15000 }, arg).then(() => true).catch(() => false);
const toast = (page) => page.evaluate(() => [...document.querySelectorAll('.toast, [class*="toast"]')].map((t) => t.textContent.trim()).filter(Boolean).pop() || '');

const server = await serve();
const base = `http://localhost:${server.address().port}`;
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
try {
  console.log('Desktop');
  const { page, errors } = await open(browser, base, { width: 1280, height: 1000 });
  ok((await text(page, '.page-header h2')) === 'Demo Day' && !(await page.$('.bc-tabs')), 'Demo Day is its own page, not inside Reveals');
  const menu = await page.evaluate(() => [...document.querySelectorAll('.sidebar a, .sidebar button, nav a, nav button')].map((e) => e.textContent.trim()));
  ok(menu.includes('Demo Day') && menu.includes('Reveals'), `the menu has Demo Day beside Reveals (${menu.filter((m) => /Demo|Reveal/.test(m)).join(', ')})`);
  ok((await text(page, '.dd-status h3')) === 'Demo day invites are paused', 'paused until turned on');
  ok((await text(page, '.dd-status')).includes('Set Start Date'), 'says Set Start Date is what sends it');
  await page.screenshot({ path: join(OUT, 'desktop.png'), fullPage: true });

  const names = await page.$$eval('.dd-row__name', (n) => n.map((x) => x.textContent.trim().split(' ')[0]));
  ok(JSON.stringify(names) === JSON.stringify(['Max', 'Leo', 'Ava', 'Nora', 'Isla', 'Remi']), `in date order, no date last (${names.join(', ')})`);
  const max = await row(page, 'Max');
  ok(max?.chip === 'Sent' && /Sent .* to 3 people\./.test(max.text), `Max: sent to the family and two staff, not the design partner on the job (${max?.text.slice(0, 120)})`);
  ok(max?.text.includes('Monetary Sponsor: Jackson Healthcare. Nobody with the Sponsor role has access to this job in JobTread'), 'Max: says nobody from the sponsor is on the job');
  ok(await page.evaluate(() => [...document.querySelectorAll('.dd-row')].find((l) => l.textContent.includes('Max'))?.querySelectorAll('.dd-meta.dd-warn').length === 1), 'Max: flagged, since his invite is out without the sponsor');
  const leo = await row(page, 'Leo');
  ok(leo?.chip === 'Sent by hand' && leo.text.includes('(“CONFIRMED: Leo Demo Day”)'.replace(/[“”]/g, '"')), `Leo: found sent by hand, with its title (${leo?.text.slice(0, 160)})`);
  ok(leo?.buttons.includes('Send ours anyway'), 'Leo: Send ours anyway');
  const ava = await row(page, 'Ava');
  ok(ava?.chip === 'Ready' && ava.when.endsWith('1:30 PM'), `Ava: ready, at the Demo task's own time (${ava?.when})`);
  ok(ava?.text.includes('Monetary Sponsor: Beazer (Bea Sponsor).'), 'Ava: the sponsor named, with who from it is on the job');
  const nora = await row(page, 'Nora');
  ok(nora?.chip === 'Not sent' && nora.text.includes('Calendar usage limits exceeded') && nora.buttons.includes('Retry'), 'Nora: not sent, with what Google said and Retry');
  ok(nora?.when.endsWith('9:00 AM (the default time)'), `Nora: the default time, said so (${nora?.when})`);
  const isla = await row(page, 'Isla');
  ok(isla?.chip === 'Waiting' && isla.text.includes('Goes out when Set Start Date is checked off'), 'Isla: waiting for Set Start Date');
  const remi = await row(page, 'Remi');
  ok(remi?.chip === 'No date' && remi.text.includes('Demo task has no date'), 'Remi: Set Start Date done but no Demo date');
  ok(!(await row(page, 'Max')).buttons.includes('Retry'), 'no Retry where nothing failed');

  // The invite and who gets it
  await clickIn(page, 'row:Max', 'See the invite (3 guests)');
  await until(page, () => document.querySelector('.dd-row .dd-invite'));
  const inv = await text(page, '.dd-row .dd-invite');
  ok(inv.startsWith("Max's Demo Day") && inv.includes('Example Way') && inv.includes("Max's bathroom makeover starts with demo day on"), `the invite as sent (${inv.slice(0, 140)})`);
  ok(inv.includes('Meet Max: https://sunshineonaranneyday.com/kids/max-2026/'), 'with the kid\'s page');
  const guests = await text(page, '.dd-row .dd-guests');
  ok(guests.includes('Family') && guests.includes('Internal team') && guests.includes('Christian Nielsen') && !guests.includes('Jen Designer') && !guests.includes('Qualification'), `guests by group, nobody else on the job (${guests})`);
  ok(!guests.includes('Clareece'), 'the organizer is never a guest');

  // Who gets it: the internal team named; the sponsor comes from JobTread, so no lists to keep here
  const who = await text(page, '.dd-who');
  ok(who.includes('Christian Nielsen, Linzi Berkowitz'), 'the internal team, named');
  ok(who.includes('Sponsor role') && !(await page.$('.dd-sponsor')), 'the sponsor is the Sponsor role on the job: no sponsor lists to keep');
  ok(who.includes('Nobody from the sponsor is on these jobs in JobTread yet: Max (Jackson Healthcare), Isla (Brian Robins Family Foundation).'), 'and says which jobs name a sponsor with nobody on them');

  // Add Mindi to every demo day
  const before = posts.length;
  await page.type('#dd-email-always', 'mindi@example.com');
  await page.type('#dd-name-always', 'Mindi');
  await page.type('#dd-role-always', 'Social media');
  await clickIn(page, '.dd-who', 'Add');
  ok(await until(page, () => [...document.querySelectorAll('.dd-person')].some((p) => p.textContent.includes('Mindi'))), 'Mindi added to every demo day');
  ok(JSON.stringify(posts.at(-1)) === JSON.stringify({ person: { list: 'always', email: 'mindi@example.com', name: 'Mindi', role: 'Social media' } }) && posts.length === before + 1, 'posted once, as typed');
  ok((await text(page, '.dd-who')).includes('Social media'), 'with what she covers');

  // A bad email is refused with the server's words
  await page.$eval('#dd-email-always', (e) => { e.type = 'text'; });
  await page.type('#dd-email-always', 'not-an-email');
  await clickIn(page, '.dd-who', 'Add');
  await pause(400);
  ok((await toast(page)).includes("doesn't look right"), `a bad email is refused (${await toast(page)})`);

  // Someone from Jackson Healthcare is given access to Max's job in JobTread (Sponsor role): they're on his invite
  JOBS['22PMaxSample1'].aces.nodes.push({ membership: { isInternal: false, role: { name: 'Sponsor' }, user: { name: 'Jo Giving', emailAddress: 'giving@jackson.example.com' } } });
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('.dd-list');
  ok((await row(page, 'Max')).text.includes('Monetary Sponsor: Jackson Healthcare (Jo Giving).'), 'Max\'s row names the sponsor\'s person on the job');
  ok((await text(page, '.dd-who')).includes('Nobody from the sponsor is on this job in JobTread yet: Isla (Brian Robins Family Foundation).'), 'and Max comes off the flag (Isla is still on it)');
  await clickIn(page, 'row:Max', 'See the invite (5 guests)');
  await until(page, () => document.querySelector('.dd-row .dd-guests'));
  const g2 = await text(page, '.dd-row .dd-guests');
  ok(g2.includes('Sponsor') && g2.includes('Jo Giving') && g2.includes('Every demo day') && g2.includes('Mindi (Social media)') && !g2.includes('Jen Designer'), `Max's invite gains the sponsor and Mindi, still not the designer (${g2})`);

  // Take Mindi off, then put her back
  await page.evaluate(() => [...document.querySelectorAll('.dd-person button')].find((b) => b.getAttribute('aria-label') === 'Take Mindi off').click());
  ok(await until(page, () => ![...document.querySelectorAll('.dd-person')].some((p) => p.textContent.includes('Mindi'))), 'Mindi taken off');
  ok(JSON.stringify(posts.at(-1)) === JSON.stringify({ removePerson: { list: 'always', email: 'mindi@example.com' } }), 'the right removal posted');
  await page.type('#dd-email-always', 'mindi@example.com');
  await page.type('#dd-name-always', 'Mindi');
  await page.type('#dd-role-always', 'Social media');
  await clickIn(page, '.dd-who', 'Add');
  await until(page, () => [...document.querySelectorAll('.dd-person')].some((p) => p.textContent.includes('Mindi')));

  // Send it to me
  googleCalls.length = 0;
  await clickIn(page, 'row:Ava', 'Send it to me');
  await pause(600);
  ok((await toast(page)).includes("Test of Ava's demo day invite sent to peter@soardcharity.com"), `Send it to me (${await toast(page)})`);
  const testEv = [...events.values()].find((e) => e.summary?.startsWith('TEST'));
  ok(testEv && JSON.stringify(testEv.attendees) === JSON.stringify([{ email: 'peter@soardcharity.com' }]), 'the test goes only to the person who asked');

  // Turn on: the confirm names what's ready; Ava's then goes out
  await clickIn(page, '.dd-status', 'Turn on invites');
  await page.waitForSelector('.modal');
  const modal = await text(page, '.modal');
  ok(modal.includes('Turn on demo day invites?') && modal.includes('Ready now: Ava'), `the confirm says what's ready (${modal.slice(0, 200)})`);
  await clickIn(page, '.modal', 'Turn on');
  ok(await until(page, () => document.querySelector('.dd-status h3')?.textContent === 'Demo day invites are on'), 'turned on');
  await pause(300);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('.dd-list');
  const ava2 = await row(page, 'Ava');
  ok(ava2?.chip === 'Sent', `Ava's invite went out once turned on (${ava2?.chip})`);

  // Retry Nora (Google is fine now)
  await clickIn(page, 'row:Nora', 'Retry');
  ok(await until(page, () => [...document.querySelectorAll('.dd-row')].find((l) => l.textContent.includes('Nora'))?.querySelector('.dd-chip')?.textContent === 'Sent'), 'Retry sends Nora\'s');

  // Send ours anyway (Leo): asks first
  await clickIn(page, 'row:Leo', 'Send ours anyway');
  await page.waitForSelector('.modal');
  ok((await text(page, '.modal')).includes('may see two'), 'Send ours anyway warns about two invites');
  await clickIn(page, '.modal', 'Send it');
  ok(await until(page, () => [...document.querySelectorAll('.dd-row')].find((l) => l.textContent.includes('Leo'))?.querySelector('.dd-chip')?.textContent === 'Sent'), 'and then sends the site\'s');

  // Wording and the default time
  await page.$eval('#dd-title', (e) => { e.focus(); e.select(); });
  await page.keyboard.type('Demo Day: ');
  await clickIn(page, '.dd-tokens', '{name}kid\'s name');
  const previewTitle = await text(page, '.dd-wording .dd-invite__title');
  ok(previewTitle === 'Demo Day: Max', `the preview follows the typing and the placeholder lands at the cursor (${previewTitle})`);
  await page.select('#dd-length', '120');
  await page.$eval('#dd-start', (e) => { e.value = '08:30'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  const pv = await text(page, '.dd-wording .dd-facts');
  ok(pv.includes('8:30 AM to 10:30 AM ET') || pv.includes('1:30 PM'), `the preview uses the new default time (${pv.slice(0, 80)})`);
  await clickIn(page, '.dd-savebar', 'Save');
  ok(await until(page, () => [...document.querySelectorAll('.dd-savebar button')].some((b) => b.textContent.trim() === 'Saved')), 'saved');
  ok(posts.some((p) => p.template?.title === 'Demo Day: {name}' && p.startTime === '08:30' && p.minutes === 120), 'title, start and length posted');
  const nora2 = [...events.values()].find((e) => e.summary?.includes('Nora'));
  ok(nora2?.start.dateTime.endsWith('T08:30:00') && nora2.end.dateTime.endsWith('T10:30:00'), 'a new default time moves invites out that use it');
  ok(nora2?.summary === 'Demo Day: Nora', 'the new wording rides along with the time change (a fact); wording alone waits (tests/demo-invites.test.mjs)');

  ok(errors.length === 0, `no console errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  await page.screenshot({ path: join(OUT, 'desktop-after.png'), fullPage: true });
  await page.close();

  console.log('Reveals, and the old address');
  const rv = await open(browser, base, { width: 1280, height: 1000 }, '#broadcast');
  const tabs = await rv.page.$$eval('.bc-tabs [role="tab"]', (t) => t.map((x) => x.textContent.trim()));
  ok(!tabs.includes('Demo Day'), `Reveals has no Demo Day tab (${tabs.join(', ')})`);
  await rv.page.close();
  const old = await open(browser, base, { width: 1280, height: 1000 }, '#broadcast/demo');
  ok((await text(old.page, '.page-header h2')) === 'Demo Day', 'the old #broadcast/demo address (in early alert emails) opens the Demo Day page');
  ok(old.errors.length === 0, `no console errors there${old.errors.length ? ': ' + old.errors.slice(0, 3).join(' | ') : ''}`);
  await old.page.close();

  console.log('Phone');
  const phone = await open(browser, base, { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await clickIn(phone.page, 'row:Max', 'See the invite (5 guests)');
  await pause(300);
  const sideways = await phone.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok(sideways <= 0, `no sideways scroll on a phone (${sideways}px over)`);
  const overflow = await phone.page.evaluate(() => [...document.querySelectorAll('.dd *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).map((e) => e.className || e.tagName).slice(0, 5));
  ok(!overflow.length, `nothing pokes past the edge${overflow.length ? `: ${overflow.join(', ')}` : ''}`);
  await phone.page.screenshot({ path: join(OUT, 'phone.png'), fullPage: true });
  // Close-ups: the top, the people lists, the wording
  for (const [sel, name] of [['.dd-status', 'phone-top'], ['.dd-who', 'phone-who'], ['.dd-wording', 'phone-wording']]) {
    await phone.page.$eval(sel, (e) => e.scrollIntoView({ block: 'start' }));
    await phone.page.screenshot({ path: join(OUT, `${name}.png`) });
  }
  ok(phone.errors.length === 0, `no console errors on a phone${phone.errors.length ? ': ' + phone.errors.slice(0, 3).join(' | ') : ''}`);
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} failed` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
