/**
 * test-advisory-real.mjs — the advisors' page on the real server code
 * ============================================================================
 * test-advisory-page.mjs walks every screen on made-up answers. This one answers from the real handlers behind the real
 * sign-in middleware, on an in-memory D1 with made-up people, so what's proved here is the whole path: who gets in, what
 * they're refused, and each thing a person does reaching the database and coming back on the page.
 * Outside services are cut off: emails are caught, nothing reaches Google, Zeffy, JobTread or Cloudflare.
 *
 *   node scripts/test-advisory-real.mjs            (PORT=<n> KEEP=1 leaves it running for a person to use)
 */
import puppeteer from 'puppeteer';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import { createR2 } from '../tests/lib/r2-shim.mjs';
import { onRequest as middleware, _resetKeyCacheForTests } from '../functions/api/_middleware.js';
import * as portal from '../functions/api/advisory-portal.js';
import * as admin from '../functions/api/advisory-admin.js';
import * as file from '../functions/api/advisory-file.js';
import * as action from '../functions/api/advisory-action.js';
import * as boardPortal from '../functions/api/board-portal.js';
import * as boardAdmin from '../functions/api/board-admin.js';
import * as boardFile from '../functions/api/board-file.js';

const ROOT = join(import.meta.dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const ROUTES = { '/api/advisory-portal': portal, '/api/advisory-admin': admin, '/api/advisory-file': file, '/api/advisory-action': action, '/api/board-portal': boardPortal, '/api/board-admin': boardAdmin, '/api/board-file': boardFile };
const lines = readFileSync(join(ROOT, 'public/_headers'), 'utf8').split('\n');
const csp = lines.slice(lines.findIndex((l) => l.startsWith('/admin/*'))).find((l) => /^\s+Content-Security-Policy:/.test(l)).split(': ').slice(1).join(': ').trim();

const certsKey = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', certsKey.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64u = (x) => Buffer.from(x).toString('base64url');
async function tokenFor(email) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ iss: 'https://soard.cloudflareaccess.com', aud: ['aud-tag'], email, iat: now, nbf: now, exp: now + 3600 }));
  return `${h}.${p}.${b64u(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', certsKey.privateKey, new TextEncoder().encode(`${h}.${p}`))))}`;
}

// ─── Made-up world ──────────────────────────────────────────────────
const env = { DB: await createD1(), CF_ACCESS_TEAM_DOMAIN: 'soard', CF_ACCESS_AUD: 'aud-tag', RESEND_API_KEY: 're_test', FILES: createR2() };
const SQL = [
  'CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)',
  'CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)',
  'CREATE TABLE kids (slug TEXT PRIMARY KEY, name TEXT, year INTEGER, data TEXT NOT NULL, updated_at TEXT)',
  'CREATE TABLE community (slug TEXT PRIMARY KEY, name TEXT, data TEXT NOT NULL)',
  'CREATE TABLE partners (slug TEXT PRIMARY KEY, name TEXT, data TEXT NOT NULL, updated_at TEXT)',
  'CREATE TABLE events (slug TEXT PRIMARY KEY, data TEXT NOT NULL)',
  'CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)',
  'CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT)',
];
for (const s of SQL) await env.DB.exec(s);
const PEOPLE = [
  ['sam-ortiz', { name: 'Sam Ortiz', group: 'advisory', title: 'Advisory Board Member', organization: 'Ortiz Supply', bio: 'Sam sells building materials.' }, 'sam@private.example'],
  ['dana-bright', { name: 'Dana Bright', group: 'advisory', title: 'Advisory Board Member', organization: 'Bright Events' }, 'dana@private.example'],
  ['drew-draft', { name: 'Drew Draft', group: 'advisory', title: 'Advisory Board Member', publishStatus: 'draft' }, 'drew@private.example'],
  ['morgan-lead', { name: 'Morgan Lead', group: 'board', title: 'Board Member', committees: ['Advisory Board'] }, 'morgan@private.example'],
  ['casey-board', { name: 'Casey Board', group: 'board', title: 'Board Member', committees: ['Advisory Board'] }, 'casey@private.example'],
  ['bo-kim', { name: 'Bo Kim', group: 'board', title: 'Treasurer', committees: ['Finance'] }, 'bo@private.example'],
  ['jane-doe', { name: 'Jane Doe', group: 'team', title: 'Co-Founder/President', role: 'founder' }, null],
];
for (const [slug, d, email] of PEOPLE) {
  await env.DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.group, JSON.stringify(d)).run();
  if (email) await env.DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind(slug, email).run();
}
await env.DB.prepare('INSERT INTO kids (slug, name, year, data) VALUES (?, ?, ?, ?)').bind('riley-2026', 'Riley', 2026, JSON.stringify({ name: 'Riley Sample', status: 'needs-funding', year: 2026 })).run();
await env.DB.prepare('INSERT INTO kids (slug, name, year, data) VALUES (?, ?, ?, ?)').bind('hidden-2026', 'Zelda', 2026, JSON.stringify({ name: 'Zelda Secretname', status: 'needs-funding', publishStatus: 'draft', year: 2026 })).run();
const { saveSettings, ensureAdvisory } = await import('../functions/api/_advisory.js');
await ensureAdvisory(env.DB);
await saveSettings(env.DB, { lead: 'morgan-lead' });

// Nothing leaves: emails are caught, anything else outside answers nothing useful
const mail = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === 'https://soard.cloudflareaccess.com/cdn-cgi/access/certs') return Response.json({ keys: [jwk] });
  if (url.startsWith('https://api.resend.com/')) { const b = JSON.parse(init.body); const l = Array.isArray(b) ? b : [b]; mail.push(...l); return Response.json(Array.isArray(b) ? { data: l.map((_, i) => ({ id: `e${i}` })) } : { id: 'e' }); }
  if (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) return realFetch(input, init);
  return new Response('{}', { status: 503 });
};
_resetKeyCacheForTests?.();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const who = req.headers['x-test-user'] || new URL(`http://x${req.url}`).searchParams.get('as') || (req.headers.cookie || '').match(/as=([^;]+)/)?.[1]?.replace('%40', '@') || '';
    if (url.pathname.startsWith('/cdn-cgi/imagedelivery/')) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG); return; }
    if (url.pathname === '/cdn-cgi/access/get-identity') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ email: who })); return; }
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
        return fn ? fn(ctx) : Response.json({ success: true, ok: true, items: [] });
      };
      const out = await middleware(ctx);
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
      return;
    }
    let f = join(ROOT, 'public', decodeURIComponent(url.pathname));
    if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
    if (!existsSync(f)) { res.writeHead(404); res.end('Not found'); return; }
    const head = { 'Content-Type': TYPES[extname(f)] || 'application/octet-stream' };
    if (url.pathname.startsWith('/admin/')) head['Content-Security-Policy'] = csp;
    res.writeHead(200, head);
    res.end(readFileSync(f));
  } catch (err) { console.error('server', err); res.writeHead(500); res.end(String(err)); }
});
await new Promise((r) => server.listen(Number(process.env.PORT) || 0, '127.0.0.1', r));
const SITE = `http://localhost:${server.address().port}`;
if (process.env.KEEP) console.log(`Real handlers on ${SITE}. Sign in by adding ?as=<email> once (kept in a cookie): sam@private.example, dana@private.example, morgan@private.example (runs it), casey@private.example (committee), bo@private.example (board), jane@soardcharity.com (admin).`);

// ─── The walk ───────────────────────────────────────────────────────
let pass = 0, fail = 0; const failed = [];
const ok = (c, name) => { if (c) pass++; else { fail++; failed.push(name); console.log(`  ✗ ${name}`); } };
const api = async (who, path, body) => {
  const r = await realFetch(`${SITE}${path}`, { method: body ? 'POST' : 'GET', headers: { 'x-test-user': who, 'Content-Type': 'application/json', Origin: SITE }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const SAM = 'sam@private.example', DANA = 'dana@private.example', LEAD = 'morgan@private.example', CASEY = 'casey@private.example', BO = 'bo@private.example', JANE = 'jane@soardcharity.com', STRANGER = 'nobody@example.com';

if (!process.env.KEEP) {
  // Who gets in, by the real middleware
  for (const p of ['/api/board-portal', '/api/board-admin', '/api/board-file?id=f_x', '/api/advisory-admin']) ok((await api(SAM, p)).status === 403, `an advisor is refused ${p}`);
  ok((await api(SAM, '/api/board-portal')).body?.advisory === '/admin/advisory/', 'and is pointed at their page');
  ok((await api(SAM, '/api/advisory-portal')).status === 200, 'an advisor opens their page');
  ok((await api('drew@private.example', '/api/advisory-portal')).status === 403, 'a draft advisor is refused');
  ok((await api(STRANGER, '/api/advisory-portal')).status === 403, 'a stranger is refused');
  ok((await api(BO, '/api/advisory-portal')).status === 403, 'a board member off the committee is refused');
  ok((await api(CASEY, '/api/advisory-portal')).status === 200, 'a committee member reads it');
  ok((await api(CASEY, '/api/advisory-admin')).status === 403, 'but can’t run it');
  ok((await api(LEAD, '/api/advisory-admin')).status === 200, 'whoever runs it opens the tools');
  ok((await api(LEAD, '/api/board-admin')).status === 403, 'and still can’t open staff Board');
  ok((await api(JANE, '/api/advisory-admin')).status === 200, 'an admin opens the tools');
  ok((await api('advisory@soardcharity.com', '/api/advisory-portal')).status === 403, 'the group’s inbox opens nothing');

  // The whole loop, by the API, through the real handlers
  const a0 = (await api(LEAD, '/api/advisory-admin')).body;
  ok(a0.docs.filter((d) => d.kind !== 'library').length === 7 && a0.docs.filter((d) => d.kind === 'library').length === 7 && a0.wishes.length === 3 && a0.asks.length === 1, 'the first words are there');
  const ask = a0.asks[0];
  ok((await api(LEAD, '/api/advisory-admin', { action: 'send-ask', id: ask.id })).status === 200, 'the ask goes out');
  ok(mail.length === 0, 'and no email, with the switch off');
  const p1 = (await api(SAM, '/api/advisory-portal')).body;
  ok(p1.ask?.id === ask.id, 'an advisor sees the ask');
  ok((await api(SAM, '/api/advisory-portal', { action: 'answer', askId: ask.id, answer: 'yes', note: 'My cousin' })).status === 200, 'they answer');
  ok((await api(SAM, '/api/advisory-portal', { action: 'intro', name: 'Pat Plumber', company: 'Pat Co', email: 'pat@private.example', help: ['vendor'] })).status === 200, 'they make an introduction');
  ok(mail.some((m) => /introduction/.test(m.subject)), 'whoever runs it is told');
  ok(!JSON.stringify(mail).includes('pat@private.example'), 'without the contact’s email');
  const a1 = (await api(LEAD, '/api/advisory-admin')).body;
  ok(a1.intros[0].email === 'pat@private.example', 'the contact is in Run it');
  ok(a1.asks[0].answers[0]?.name === 'Sam Ortiz', 'and the answer');
  ok((await api(LEAD, '/api/advisory-admin', { action: 'intro-status', id: a1.intros[0].id, status: 'talking' })).status === 200, 'its status changes');
  ok((await api(SAM, '/api/advisory-portal')).body.intros[0].status === 'talking', 'the advisor sees it');
  ok((await api(DANA, '/api/advisory-portal')).body.intros.length === 0, 'another advisor doesn’t');
  ok((await api(SAM, '/api/advisory-portal', { action: 'host', title: 'Backyard BBQ', when: 'Spring' })).status === 200, 'they ask to host');
  const h = (await api(LEAD, '/api/advisory-admin')).body.hosted[0];
  ok(h.status === 'new', 'it waits for a yes');
  ok((await api(LEAD, '/api/advisory-admin', { action: 'hosted-status', id: h.id, status: 'approved', date: '2031-05-01' })).status === 200, 'it’s approved');
  ok((await api(DANA, '/api/advisory-portal')).body.coming.hosted[0]?.title === 'Backyard BBQ', 'and is on everyone’s Coming up');
  const agree = a1.docs.find((d) => d.kind === 'agreement');
  ok((await api(SAM, '/api/advisory-portal', { action: 'sign', docId: agree.id, name: 'Dana Bright', version: agree.version })).status === 400, 'signing someone else’s name is refused');
  ok((await api(SAM, '/api/advisory-portal', { action: 'sign', docId: agree.id, name: 'Sam Ortiz', version: agree.version })).status === 200, 'signing their own works');
  ok(!(await api(SAM, '/api/advisory-portal')).body.todos.some((t) => t.kind === 'sign'), 'the to-do clears');
  ok((await api(LEAD, '/api/advisory-portal', { action: 'sign', docId: agree.id, name: 'Morgan Lead', version: agree.version })).status === 403, 'whoever runs it has no seat to sign in');
  ok((await api(SAM, '/api/advisory-admin', { action: 'save-settings', settings: { goal: 1 } })).status === 403, 'an advisor can’t reach the tools by posting');

  // Two people, a stale switch, and an ask mailed late
  const pitch = (await api(LEAD, '/api/advisory-admin')).body.docs.find((d) => d.kind === 'pitch');
  ok((await api(LEAD, '/api/advisory-admin', { action: 'save-doc', doc: { ...pitch, body: 'Morgan’s words' }, base: pitch.updatedAt })).status === 200, 'a paper saves');
  await new Promise((r) => setTimeout(r, 5));
  const stale = await api(JANE, '/api/advisory-admin', { action: 'save-doc', doc: { ...pitch, body: 'Jane’s older words' }, base: pitch.updatedAt });
  ok(stale.status === 409 && stale.body.current?.body === 'Morgan’s words', 'a second person is told, and gets the newer words');
  const fresh = await api(LEAD, '/api/advisory-admin', { action: 'save-ask', ask: { title: 'Next month’s ask' } });
  const noEmail = mail.length;
  ok((await api(LEAD, '/api/advisory-admin', { action: 'save-settings', settings: { emails: true } })).status === 200, 'emails go on');
  const refused = await api(LEAD, '/api/advisory-admin', { action: 'send-ask', id: fresh.body.ask.id });
  ok(refused.status === 409 && refused.body.emails === true && mail.length === noEmail, 'with emails on, an ask isn’t sent without saying so');
  ok((await api(LEAD, '/api/advisory-admin', { action: 'send-ask', id: fresh.body.ask.id, emailsOk: true })).status === 200 && mail.length === noEmail + 2, 'said so, it goes to both advisors');
  const again = await api(LEAD, '/api/advisory-admin', { action: 'email-ask', id: fresh.body.ask.id });
  ok(again.body.sent?.already === true && mail.length === noEmail + 2, 'and never twice');
  ok(mail.slice(-2).every((m) => [m.reply_to].flat().join() === 'morgan@private.example'), 'replies go to whoever runs the group');
  ok((await api(LEAD, '/api/advisory-admin', { action: 'delete-ask', id: fresh.body.ask.id })).status === 409, 'an ask that went out can’t be deleted');
  await api(LEAD, '/api/advisory-admin', { action: 'save-settings', settings: { emails: false } });

  // The page itself
  const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-gpu', '--disable-gpu-vsync', '--disable-renderer-backgrounding'] });
  const errors = [];
  const tab = async (who, width = 1280) => {
    const page = await browser.newPage();
    await page.setViewport({ width, height: 900, isMobile: width < 600, hasTouch: width < 600 });
    await page.setExtraHTTPHeaders({ 'x-test-user': who });
    page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|imagedelivery|x-test-user|fonts\.g/.test(m.text())) errors.push(`${who}: ${m.text()}`); });
    return page;
  };
  const text = (p) => p.evaluate(() => document.body.innerText);
  const see = (p, re, t = 8000) => p.waitForFunction((s) => new RegExp(s, 'i').test(document.body.innerText), { timeout: t }, re.source).then(() => true, () => false);
  const sam = await tab(SAM, 390);
  await sam.goto(`${SITE}/admin/advisory/`, { waitUntil: 'networkidle0' });
  ok(await see(sam, /Next month.s ask/), 'the page shows the ask, from the real server');
  ok(!/\$\s?\d/.test(await text(sam)), 'no dollars on Home');
  for (const [hash, re, name] of [['#/introductions', /Pat Plumber/, 'their introduction'], ['#/fundraise', /30-second pitch/, 'the Fundraise words'], ['#/people', /Dana Bright/, 'the group']]) {
    await sam.goto(`${SITE}/admin/advisory/${hash}`, { waitUntil: 'networkidle0' }); await sam.reload({ waitUntil: 'networkidle0' });
    ok(await see(sam, re), `${name} on ${hash}`);
  }
  ok(!/private\.example/.test(await text(sam)), 'no private address on People');
  const toBoard = await tab(SAM);
  await toBoard.goto(`${SITE}/admin/board/`, { waitUntil: 'networkidle0' });
  ok(await toBoard.waitForFunction(() => location.pathname === '/admin/advisory/', { timeout: 8000 }).then(() => true, () => false), 'an advisor at the board page lands on theirs');
  const lead = await tab(LEAD);
  await lead.goto(`${SITE}/admin/advisory/#/run`, { waitUntil: 'networkidle0' }); await lead.reload({ waitUntil: 'networkidle0' });
  ok(await see(lead, /Run it/) && await see(lead, /Pat Plumber|Backyard BBQ|Members|Goal/), 'whoever runs it has Run it, from the real server');
  const casey = await tab(CASEY);
  await casey.goto(`${SITE}/admin/advisory/`, { waitUntil: 'networkidle0' });
  ok(!/Run it/.test(await text(casey)), 'a committee member has no Run it');
  ok(errors.length === 0, `no errors on the page: ${errors.slice(0, 4).join(' | ')}`);
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log(failed.map((f) => `  ✗ ${f}`).join('\n'));
  server.close();
  process.exit(fail ? 1 : 0);
}
