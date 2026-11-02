/**
 * test-vendor-papers-admin.mjs — drive Job Costs → W-9s & insurance in a real browser
 * ===================================================================
 * Opens the admin at #job-costs/papers (public/ served directly) with the
 * REAL /api/vendor-papers-admin behind it, on an in-memory D1 and R2 and a
 * pretend JobTread and Workers AI, and checks: the tab, every company with
 * where it stands, the "Needs something" filter and search, one company's
 * page, adding a certificate (a PDF drawn to pictures by pdf.js on the way)
 * that ended in June so the company says Expired, opening the file in the
 * viewer, "W-9 only", adding a company paid outside JobTread, copying their
 * link, phones (no sideways scroll, 44px touch targets), axe, and no console
 * errors. Screenshots land in test-results/vendor-papers/.
 *
 *   node scripts/test-vendor-papers-admin.mjs
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { answerAsks } from './lib/ask.mjs';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import { createR2 } from '../tests/lib/r2-shim.mjs';
import { onRequestGet as papersGet, onRequestPost as papersPost } from '../functions/api/vendor-papers-admin.js';
import { ensureVendorSchema, readVendor } from '../functions/api/_vendors.js';
import { ensureSpendSchema } from '../functions/api/_spend.js';
import { ensureBillPaySchema } from '../functions/api/_bill-pay.js';
import { keepFile } from '../functions/api/_vendor-files.js';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/vendor-papers/');
mkdirSync(OUT, { recursive: true });
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf' };
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── The server side: the real admin API on an in-memory world ──────

const jt = {
  fields: [
    { id: 'F-W9', name: 'W-9', type: 'boolean' }, { id: 'F-GL', name: 'Liability Expires', type: 'date' }, { id: 'F-WC', name: 'Workers\' Comp Expires', type: 'date' },
    { id: 'F-DOCS', name: 'Documents', type: 'option', options: [] }, { id: 'F-CHECK', name: 'Insurance Check', type: 'text' }, { id: 'F-TRADES', name: 'Trades', type: 'option', options: [], maxValuesAllowed: null },
    { id: 'F-ADDR', name: 'Address', type: 'text' }, { id: 'F-LIC', name: 'License', type: 'text' }, { id: 'F-MAT', name: 'Materials only', type: 'boolean' },
  ],
  vendors: {
    '22PRZwUjsEcj': { name: 'Bin There Dump That East ATL', email: 'julia@bintherek.example', values: {} },
    '22NWaSZsKkHd': { name: 'TKO Plumbing', email: 'tara@tko.example', values: { 'F-W9': true, 'F-GL': '2026-12-06', 'F-WC': '2026-12-06', 'F-DOCS': 'Current' } },
    '22NWaSZKbrKa': { name: 'Copan Imports LLC', email: null, values: { 'F-W9': true, 'F-GL': '2027-06-02' } },
  },
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.host === 'api.jobtread.com') {
    const { query } = JSON.parse(init.body);
    if (query.organization?.customFields) return Response.json({ organization: { customFields: { nodes: jt.fields }, contactFields: { nodes: [{ id: 'VC-EMAIL', name: 'Email', type: 'emailAddress' }] }, fileTags: { nodes: [{ id: 'T-W9', name: 'W-9' }, { id: 'T-COI', name: 'COI' }] } } });
    if (query.updateCustomField) return Response.json({});
    if (query.account) {
      const v = jt.vendors[query.account.$.id];
      const email = { nodes: v?.email ? [{ value: v.email, customField: { id: 'VC-EMAIL', type: 'emailAddress' } }] : [] };
      return Response.json({ account: v && { id: query.account.$.id, name: v.name, archivedAt: null, customFieldValues: { nodes: Object.entries(v.values).map(([k, value]) => ({ value, customField: { id: k } })) }, primaryContact: { id: 'C1', title: 'Owner', customFieldValues: email }, contacts: { nodes: [{ id: 'C1', title: 'Owner', customFieldValues: email }] } } });
    }
    if (query.updateAccount) { Object.assign(jt.vendors[query.updateAccount.$.id].values, query.updateAccount.$.customFieldValues); return Response.json({}); }
    if (query.createComment) return Response.json({ createComment: { createdComment: { id: 'N1' } } });
    throw new Error(`pretend JobTread: ${Object.keys(query)}`);
  }
  if (url.host === 'slack.com') return Response.json({ ok: true, channel: 'C', ts: '1.1' });
  return realFetch(input, init);
};
const CERT = { isCertificate: true, readable: true, insured: 'Stearns Dumpster Service LLC DBA Bin There Dump That', certificateHolder: 'Sunshine on a Ranney Day',
  policies: [
    { kind: 'general liability', insurer: 'Berkley Specialty', effective: '2025-06-21', expires: '2026-06-21', eachOccurrence: 1000000, aggregate: 2000000 },
    { kind: 'workers compensation', insurer: 'Starstone', effective: '2025-06-21', expires: '2026-06-21', employersLiabilityEachAccident: 1000000 },
  ] };
const env = {
  DB: await createD1({ schemaSql: ['CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)', 'CREATE TABLE audit_log (id INTEGER PRIMARY KEY, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)'] }),
  FILES: createR2(), VENDOR_FILES: createR2(), JOBTREAD_GRANT_KEY: 'jt',
  AI: { toMarkdown: async () => ({ format: 'text', data: 'ACORD 25 CERTIFICATE OF LIABILITY INSURANCE '.repeat(5) }), run: async () => ({ response: CERT }) },
};
await ensureSpendSchema(env.DB);
await ensureBillPaySchema(env.DB);
await ensureVendorSchema(env.DB);
for (const [id, v] of Object.entries(jt.vendors)) {
  await env.DB.prepare('INSERT INTO vendors (id, name, vkey, jt_id, email, facts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(`jt_${id}`, v.name, v.name.toLowerCase(), id, v.email, JSON.stringify({ jobs: id === '22PRZwUjsEcj' ? [{ jobId: 'J1', jobName: 'Max Daniel (2026)', order: true }] : [], emails: [] }), 'x', 'x').run();
  await readVendor(env, id);
}

// What SOARD paid them in the last year: TKO the most, Bin There some, Copan nothing
const bill = (id, account, dollars, date) => env.DB.prepare('INSERT INTO spend_bills (id, job_id, vendor, cents, date, created_at, status, number, lines, account_id, paid, balance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .bind(id, 'J1', account, dollars * 100, date, `${date}T12:00:00Z`, 'approved', id, '[]', account, dollars * 100, 0).run();
await bill('B1', '22NWaSZsKkHd', 12000, '2026-08-01');
await bill('B2', '22PRZwUjsEcj', 5000, '2026-09-15');

// A real one-page PDF for the upload, and one already kept for TKO
async function pdfOf(text) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawText(text, { x: 50, y: 700, size: 18, font: await doc.embedFont(StandardFonts.Helvetica) });
  return doc.save();
}
const CERT_PDF = await pdfOf('CERTIFICATE OF LIABILITY INSURANCE - Stearns Dumpster Service');
const CERT_PATH = join(OUT, 'stearns-coi.pdf');
writeFileSync(CERT_PATH, CERT_PDF);
await keepFile(env, '22NWaSZsKkHd', { doc: 'coi', bytes: await pdfOf('TKO Sunshine COI'), type: 'application/pdf', name: 'TKO Sunshine COI.pdf', source: 'email', receivedAt: '2026-05-22', status: 'checked', summary: 'Found in Christian Nielsen’s email from May 2026', reading: { policies: [{ kind: 'general liability', expires: '2026-12-06', eachOccurrence: 2000000, insurer: 'State Farm' }] } });

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
const JOB_COSTS = { success: true, codes: [], jobs: [], charges: [], recode: [], bills: [], ledgers: [], odd: [], rules: [], config: {}, closeouts: [], health: { mercury: true, jobtread: true, slack: true, webhook: { registered: true }, lastCatchUp: { at: new Date().toISOString() } } };
const posts = [];
function serve() {
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/vendor-papers-admin') {
      const request = await toRequest(req);
      if (req.method === 'POST') posts.push(request.headers.get('content-type')?.includes('json') ? await request.clone().json() : 'upload');
      const ctx = { env, request, data: { userEmail: 'holly@soardcharity.com' } };
      return send(res, await (req.method === 'POST' ? papersPost(ctx) : papersGet(ctx)));
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

async function open(browser, base, viewport, hash = '#job-costs/papers') {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', (req) => (new URL(req.url()).origin === base ? req.continue() : req.abort()));
  await answerAsks(page, { accept: true });
  await page.goto(`${base}/admin/${hash}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.vp', { timeout: 15000 });
  return { page, errors };
}
const clickText = (page, sel, text) => page.evaluate((sel, text) => {
  const el = [...document.querySelectorAll(sel)].find((b) => b.textContent.trim().startsWith(text));
  if (!el) return false;
  el.click();
  return true;
}, sel, text);
async function axe(page, label) {
  await wait(300);
  await page.evaluate(AXE);
  const r = await page.evaluate(async () => (await window.axe.run(document.querySelector('.vp'), { resultTypes: ['violations'] })).violations.map((v) => `${v.id} (${v.nodes.length}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join('; ')})`));
  ok(r.length === 0, `axe: no violations on ${label}${r.length ? `: ${r.join(', ')}` : ''}`);
}
async function phoneChecks(page, label) {
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(sideways <= 1, `${label}: no sideways scroll (${sideways}px)`);
  const small = await page.evaluate(() => [...document.querySelectorAll('.vp button, .vp a.btn, .vp input, .vp select')].filter((e) => e.offsetParent && e.getBoundingClientRect().height < 40 && !e.closest('.vp-row')).map((e) => `${e.tagName} ${e.textContent.trim().slice(0, 20)} ${Math.round(e.getBoundingClientRect().height)}`));
  ok(small.length === 0, `${label}: touch targets 40px or more${small.length ? `: ${small.join(', ')}` : ''}`);
  // Clipped by the admin's .main is invisible to a page-wide scroll check: nothing may reach past the screen's right edge
  const past = await page.evaluate(() => [...document.querySelectorAll('.vp *')].filter((e) => e.offsetParent && e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest('.seg')).map((e) => `${e.tagName}.${e.className} ${Math.round(e.getBoundingClientRect().right)}`).slice(0, 5));
  ok(past.length === 0, `${label}: nothing cut off at the right${past.length ? `: ${past.join(', ')}` : ''}`);
  const cut = await page.evaluate(() => [...document.querySelectorAll('.vp .seg')].filter((g) => g.scrollWidth > g.clientWidth + 1 && !g.closest('.vp-bar')).map((g) => g.getAttribute('aria-label')));
  ok(cut.length === 0, `${label}: every choice shows whole${cut.length ? `: ${cut.join(', ')}` : ''}`);
}

const server = await serve();
const base = `http://localhost:${server.address().port}`;
const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
try {
  console.log('Desktop');
  const { page, errors } = await open(browser, base, { width: 1440, height: 1000 });
  ok(await page.$eval('.seg [role="tab"][aria-selected="true"]', (e) => e.textContent.trim() === 'W-9s & insurance'), 'the W-9s & insurance tab is open');
  let rows = await page.$$eval('.vp-row:not(.is-head) strong', (r) => r.map((x) => x.textContent));
  ok(rows.join('|') === 'Bin There Dump That East ATL|TKO Plumbing', `"Who SOARD pays" leads, what's missing first (${rows.join(', ')})`);
  ok(/1 company SOARD paid in the last year is missing a W-9 or current insurance.*\$5,000/.test(await page.$eval('.vp .notice', (e) => e.textContent)), 'and says how many, and how much they were paid');
  ok((await page.$eval('.vp-row:not(.is-head)', (e) => e.textContent)).includes('$5,000'), 'each row says what they were paid');
  await clickText(page, '.vp-filters [role="radio"]', 'Needs something');
  await wait(100);
  rows = await page.$$eval('.vp-row:not(.is-head) strong', (r) => r.map((x) => x.textContent));
  ok(rows.join('|') === 'Bin There Dump That East ATL|Copan Imports LLC', `"Needs something" lists the two with something missing (${rows.join(', ')})`);
  await clickText(page, '.vp-filters [role="radio"]', 'All');
  await wait(100);
  rows = await page.$$eval('.vp-row:not(.is-head) strong', (r) => r.map((x) => x.textContent));
  ok(rows.length === 3 && rows.includes('TKO Plumbing'), 'All lists every company');
  await page.type('.vp-bar input[type=search]', 'copan');
  await wait(100);
  ok((await page.$$('.vp-row:not(.is-head)')).length === 1, 'search narrows the list');
  await page.screenshot({ path: `${OUT}list.png` });
  await axe(page, 'the list');

  // One company: add the certificate that ended in June
  await page.evaluate(() => { location.hash = '#job-costs/papers/22PRZwUjsEcj'; });
  await page.waitForSelector('.vp-card h4', { timeout: 10000 }).catch(async () => { console.log('DEBUG', await page.evaluate(() => [location.hash, document.querySelector('.vp')?.innerText.slice(0, 400), document.querySelector('main, #app')?.innerText.slice(0, 300)]), errors); });
  ok((await page.$eval('.vp-top h3', (e) => e.textContent)).includes('Bin There Dump That East ATL'), 'the company opens from its address');
  ok((await page.$eval('.vp-top h3 .tag', (e) => e.textContent)) === 'Missing', 'it says Missing');
  await clickText(page, '.vp-drop [role=radio]', 'Certificate');
  const input = await page.$('.vp-drop input[type=file]');
  await input.uploadFile(CERT_PATH);
  await page.waitForSelector('.vp-result', { timeout: 30000 });
  const said = await page.$eval('.vp-result', (e) => e.textContent);
  ok(/doesn’t pass/.test(said) && /ended June 21, 2026/.test(said), `the check says why it doesn’t pass (${said.slice(0, 120)})`);
  ok(/Now on file: liability to Jun 21, 2026, workers’ comp to Jun 21, 2026/.test(said), 'and what the record says now');
  ok(/added by Holly/.test(await page.$eval('.vp-file .vp-file__meta', (e) => e.textContent)), 'the file says who added it');
  // No W-9 either, so it's still Missing, and says the insurance ended
  ok((await page.$eval('.vp-top h3 .tag', (e) => e.textContent)) === 'Missing', 'no W-9 yet: still Missing');
  ok(/Still needed: a W-9, general liability insurance \(it ended June 21, 2026\)/.test(await page.$eval('.vp-top .vp-lead', (e) => e.textContent)), 'and it says the insurance ended, in words that read right');
  ok(jt.vendors['22PRZwUjsEcj'].values['F-GL'] === '2026-06-21' && jt.vendors['22PRZwUjsEcj'].values['F-WC'] === '2026-06-21', 'JobTread’s fields show the dates');
  ok((await page.$$eval('.vp-file', (f) => f.length)) === 1, 'the file is listed');
  await page.screenshot({ path: `${OUT}company.png`, fullPage: true });
  await axe(page, 'a company');

  // The file opens in the viewer
  await page.click('.vp-file__what button.link');
  await page.waitForSelector('.fv-host .fv', { timeout: 15000 }).catch(() => null);
  ok(!!(await page.$('.fv-host .fv')), 'the file opens in the admin’s viewer');
  await page.keyboard.press('Escape');
  await wait(400);

  // W-9 only
  await clickText(page, '.vp-card [role=radio]', 'W-9 only');
  await page.waitForFunction(() => [...document.querySelectorAll('.vp-top h3 .tag')].some((t) => t.textContent === 'W-9 only'), { timeout: 10000 }).catch(() => null);
  ok((await page.$$eval('.vp-top h3 .tag', (t) => t.map((x) => x.textContent))).join('|') === 'Missing|W-9 only', '"W-9 only" sticks, and with no W-9 yet it still says Missing');
  ok(jt.vendors['22PRZwUjsEcj'].values['F-DOCS'] === 'W-9 only', 'and JobTread’s Documents shows it');

  // A company paid outside JobTread
  await clickText(page, '.vp .btn', '← Every company');
  await page.waitForSelector('.vp-row', { timeout: 10000 });
  await clickText(page, '.vp .btn', 'Add a company');
  await page.type('.vp-card input:not([type])', 'Capin Crouse LLP');
  await page.type('.vp-card input[type=email]', 'billing@capin.example');
  await clickText(page, '.vp-card .btn', 'Add');
  await page.waitForFunction(() => /Capin Crouse/.test(document.querySelector('.vp-top h3')?.textContent || ''), { timeout: 10000 }).catch(() => null);
  ok(/Capin Crouse LLP/.test(await page.$eval('.vp-top h3', (e) => e.textContent)), 'the new company opens');
  ok((await page.$$eval('.vp-top h3 .tag', (t) => t.map((x) => x.textContent))).join('|') === 'Missing|W-9 only', 'it needs a W-9 only, and has none yet');
  await page.evaluate(() => { navigator.clipboard.writeText = async (t) => { window.__copied = t; }; });
  await clickText(page, '.vp-card .btn', 'Copy their link');
  await page.waitForFunction(() => !!window.__copied, { timeout: 5000 }).catch(() => null);
  ok(/\/trade-partners\/account\/#t=/.test(await page.evaluate(() => window.__copied || '')), 'their link is copied');
  await page.screenshot({ path: `${OUT}site-company.png`, fullPage: true });
  await axe(page, 'a site company');
  ok(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await page.close();

  console.log('Phone');
  const phone = await open(browser, base, { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await phoneChecks(phone.page, 'the list');
  await phone.page.screenshot({ path: `${OUT}phone-list.png` });
  await phone.page.evaluate(() => { location.hash = '#job-costs/papers/22PRZwUjsEcj'; });
  await phone.page.waitForSelector('.vp-card h4', { timeout: 10000 });
  await phoneChecks(phone.page, 'a company');
  await phone.page.screenshot({ path: `${OUT}phone-company.png`, fullPage: true });
  ok(phone.errors.length === 0, `phone: no console errors${phone.errors.length ? `: ${phone.errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
  server.close();
  globalThis.fetch = realFetch;
}
console.log(failures.length ? `\n${failures.length} failed` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
