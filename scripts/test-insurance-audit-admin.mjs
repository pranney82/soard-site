/**
 * test-insurance-audit-admin.mjs — drive Admin → Job Costs → Insurance audit in a real browser
 * ===========================================================================
 * Opens the admin at #job-costs/insurance (public/ served directly, on a port
 * of its own) with /api/insurance-audit-admin answered by the REAL handler
 * (functions/api/insurance-audit-admin.js → _insurance-audit.js) over an
 * in-memory D1 and a pretend JobTread, Ramp and Mercury; /api/job-costs-admin
 * answers with a small fixture. Checks: the tab; the headline and the counts;
 * a gap in workers' comp; one sub's payments; leaving a payee out from its
 * "⋯" menu (drawn in the top layer) and undoing it; another term; both
 * downloads; phones (no sideways scroll, 44px targets); axe; no console
 * errors. Screenshots land in test-results/insurance-audit/.
 *
 *   node scripts/test-insurance-audit-admin.mjs
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { PDFDocument } from 'pdf-lib';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import { onRequestGet as auditGet, onRequestPost as auditPost } from '../functions/api/insurance-audit-admin.js';
import { ensureSpendSchema } from '../functions/api/_spend.js';
import { ensureVendorSchema } from '../functions/api/_vendors.js';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/insurance-audit/');
mkdirSync(OUT, { recursive: true });
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ME = 'holly@example.org';
const thisYear = Number(new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).slice(0, 4));
const termYear = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) >= `${thisYear}-04-11` ? thisYear : thisYear - 1;
const d = (m, dd) => { const y = m >= 4 ? termYear : termYear + 1; return `${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`; };

// ─── A pretend JobTread, Ramp and Mercury ───────────────────────────
const certPdf = async () => { const doc = await PDFDocument.create(); doc.addPage([612, 792]).drawText('ACORD 25 CERTIFICATE OF LIABILITY INSURANCE', { x: 60, y: 700, size: 12 }); return doc.save(); };
const jtBills = [
  { id: 'B1', account: { id: 'V1', name: 'Sample Tile' }, number: '101', issueDate: d(5, 1), cost: 42, amountPaid: 42, status: 'approved', costItems: { nodes: [{ costType: { name: 'Subcontractor' } }] } },
  { id: 'B2', account: { id: 'V2', name: 'Example Framing Co' }, number: '7', issueDate: d(6, 1), cost: 185, amountPaid: 185, status: 'approved', costItems: { nodes: [] } },
  { id: 'B3', account: { id: 'V3', name: 'Example Supply' }, number: '55', issueDate: d(7, 1), cost: 9, amountPaid: 9, status: 'approved', costItems: { nodes: [] } },
  { id: 'B4', account: { id: 'V4', name: 'Example Gym Equipment' }, number: '9', issueDate: d(8, 1), cost: 64, amountPaid: 64, status: 'approved', costItems: { nodes: [] } },
];
const jtPayments = [{ id: 'P1', amount: 42, paidAt: d(5, 10), account: { id: 'V1', name: 'Sample Tile', type: 'vendor' }, documentPayments: { nodes: [{ amount: 42, document: { id: 'B1', type: 'vendorBill' } }] } }];
const rampBills = [{ id: 'R2', vendor: { name: 'Example Framing Co' }, amount: { amount: 18500, minor_unit_conversion_rate: 100 }, invoice_number: '7', paid_at: `${d(6, 5)}T15:00:00Z`, payment: { payment_method: 'CHECK' }, line_items: [] }];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.host === 'api.jobtread.com') {
    const { query } = JSON.parse(init.body);
    // Only the current term has payments (its questions end where it ends)
    const mine = (where) => JSON.stringify(where).includes(`${termYear + 1}-04-11`);
    if (query.organization?.documents) return Response.json({ organization: { documents: { nextPage: null, nodes: mine(query.organization.documents.$.where) ? jtBills : [] } } });
    if (query.organization?.payments) return Response.json({ organization: { payments: { nextPage: null, nodes: mine(query.organization.payments.$.where) ? jtPayments : [] } } });
    if (query.file) return Response.json({ file: { id: query.file.$.id, name: 'COI.pdf', url: 'https://files.jobtread.example/coi.pdf' } });
    if (query.account) return Response.json({ account: { files: { nodes: [] } } });
    throw new Error(`JobTread doesn't know ${Object.keys(query)}`);
  }
  if (url.host === 'files.jobtread.example') return new Response(await certPdf());
  if (url.host === 'api.ramp.com') {
    if (url.pathname.endsWith('/token')) return Response.json({ access_token: 'tok', expires_in: 3600 });
    return Response.json({ data: String(url.searchParams.get('from_paid_at')).startsWith(`${termYear}-04`) ? rampBills : [], page: { next: null } });
  }
  return realFetch(input, init);
};

const DB = await createD1({ schemaSql: ['CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)'] });
const env = { DB, JOBTREAD_GRANT_KEY: 'jt', RAMP_CLIENT_ID: 'id', RAMP_CLIENT_SECRET: 'secret' };
await ensureSpendSchema(DB);
await ensureVendorSchema(DB);
const cache = (jtId, name, email, fields) => DB.prepare('INSERT INTO vendors (id, name, vkey, jt_id, email, facts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  .bind(`jt_${jtId}`, name, name.toLowerCase(), jtId, email, JSON.stringify({ emails: email ? [email] : [], fields }), '', '').run();
await cache('V1', 'Sample Tile', 'office@tile.example', { trades: ['Tile'], gl: null, wc: null, docs: null, materials: false });
await cache('V2', 'Example Framing Co', null, { trades: ['Carpentry and framing'], gl: null, wc: null, docs: null, materials: false });
await cache('V3', 'Example Supply', 'sales@supply.example', { trades: [], gl: null, wc: null, docs: 'W-9 only', materials: true });
await cache('V4', 'Example Gym Equipment', 'hello@gym.example', { trades: ['Accessibility and lifts'], gl: null, wc: null, docs: null, materials: false });
await DB.prepare(`CREATE TABLE coi_coverage (id TEXT PRIMARY KEY, jt_id TEXT, insured TEXT NOT NULL, kind TEXT NOT NULL, effective TEXT, expires TEXT, insurer TEXT, policy_no TEXT,
  each_cents INTEGER, aggregate_cents INTEGER, exempt INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL, source_ref TEXT, file_hash TEXT NOT NULL, jt_file_id TEXT, found_at TEXT NOT NULL)`).run();
for (const [id, kind, eff, exp, insurer] of [['c1', 'gl', d(1, 1), d(12, 31), 'Example Mutual'], ['c2', 'wc', d(6, 1), d(3, 31), 'Example Comp']]) {
  await DB.prepare("INSERT INTO coi_coverage (id, jt_id, insured, kind, effective, expires, insurer, source, file_hash, jt_file_id, found_at) VALUES (?, 'V1', 'Sample Tile LLC', ?, ?, ?, ?, 'gmail', 'h1', 'F1', ?)")
    .bind(id, kind, eff.replace(/^\d{4}/, String(termYear)), exp, insurer, new Date().toISOString()).run();
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

const JOB_COSTS = {
  success: true, codes: [], jobs: [], ledgers: [], charges: [], rules: [], recode: [], bills: [], odd: [], closeouts: [], history: { jobs: 0, codes: [] },
  config: { accountBuckets: {}, cardBuckets: {}, categories: {}, caps: false, receiptInbox: 'ap@example.org' },
  health: { mercury: true, jobtread: true, slack: true, webhook: { registered: true, lastEventAt: new Date().toISOString() }, lastCatchUp: { at: new Date().toISOString() }, lastRebuildAt: new Date().toISOString(), agentUsedAt: new Date().toISOString() },
  ramp: { connected: false },
};

async function open(browser, base, viewport, hash = '#job-costs/insurance') {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const url = new URL(req.url());
    const json = (obj, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.origin !== base) return req.abort();
    if (url.pathname === '/api/insurance-audit-admin') {
      const request = new Request(`https://x.example${url.pathname}${url.search}`, req.method() === 'POST' ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: req.postData() } : {});
      const r = await (req.method() === 'POST' ? auditPost : auditGet)({ env, request, data: { userEmail: ME }, waitUntil: () => {} });
      return req.respond({ status: r.status, headers: Object.fromEntries(r.headers), body: Buffer.from(await r.arrayBuffer()) });
    }
    if (url.pathname === '/api/job-costs-admin') return json(JOB_COSTS);
    if (url.pathname === '/api/live-ws') return req.abort();
    if (url.pathname.startsWith('/api/list-content')) return json({ success: true, items: [], total: 0, hasMore: false });
    if (url.pathname.startsWith('/api/pending-changes')) return json({ success: true, changes: [], since: null });
    if (url.pathname.startsWith('/api/audit-log')) return json({ success: true, entries: [], total: 0 });
    if (url.pathname.startsWith('/api/deployments')) return json({ success: true, deploys: [], source: 'cloudflare' });
    if (url.pathname.startsWith('/api/')) return json({ success: true, ok: true });
    return req.continue();
  });
  await page.goto(`${base}/admin/${hash}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.ia .ia-stats', { timeout: 20000 });
  return { page, errors };
}
const textOf = (page, sel) => page.$eval(sel, (e) => e.innerText).catch(() => '');
const clickText = (page, sel, text) => page.evaluate((sel, text) => {
  const el = [...document.querySelectorAll(sel)].find((b) => b.textContent.trim().startsWith(text));
  if (!el) return false;
  el.click();
  return true;
}, sel, text);
async function axe(page, label) {
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))));
  await page.addScriptTag({ content: AXE });
  const r = await page.evaluate(async () => (await window.axe.run(document.querySelector('.jc') || document, { runOnly: ['wcag2a', 'wcag2aa'] })).violations.map((v) => `${v.id} ×${v.nodes.length} (${v.nodes[0]?.target})`));
  ok(r.length === 0, `axe (${label}): no violations${r.length ? `: ${r.join(', ')}` : ''}`);
}

const server = await serve();
const base = `http://localhost:${server.address().port}`;
const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
try {
  console.log('Desktop');
  const { page, errors } = await open(browser, base, { width: 1440, height: 1000 });
  ok(await page.$eval('.seg[aria-label="Job costs"] [aria-selected="true"]', (e) => e.textContent.trim()) === 'Insurance audit', 'Job Costs has an Insurance audit tab, open');
  const stats = await textOf(page, '.ia-stats');
  ok(/PAID TO SUBCONTRACTORS WITHOUT INSURANCE\s*\$291\.00/i.test(stats), `the headline: what was paid without workers’ comp (${stats.split('\n').slice(0, 3).join(' | ')})`);
  ok(stats.includes('3 subcontractors paid in all'), 'how many subcontractors were paid');
  const names = await page.$$eval('.ia-list[aria-label="Subcontractors paid"] .ia-name', (els) => els.map((e) => e.textContent));
  ok(names.join() === 'Example Framing Co,Example Gym Equipment,Sample Tile', `the subs, biggest gap first (${names})`);
  const framing = await textOf(page, '.ia-list[aria-label="Subcontractors paid"] .ia-item');
  ok(framing.includes('$185.00 not covered') && framing.includes('None, and no email in JobTread to ask'), 'a gap, and why nobody was asked');
  const tile = await page.evaluate(() => [...document.querySelectorAll('.ia-item')].find((e) => e.textContent.includes('Sample Tile'))?.innerText || '');
  ok(tile.includes('$42.00 not covered') && tile.includes('Example Mutual'), 'the tile sub: paid before their workers’ comp began, general liability covered');
  await page.screenshot({ path: `${OUT}audit.png`, fullPage: false });
  await axe(page, 'the audit');

  await clickText(page, '.ia-link', 'Show 1 payment');
  await page.waitForSelector('.ia-pays table');
  ok((await textOf(page, '.ia-pays')).includes('Ramp, Invoice 7'), 'one sub’s payments, with where each came from');

  // Leave the gym company out: it builds equipment off site
  await page.evaluate(() => [...document.querySelectorAll('.ia-item')].find((e) => e.textContent.includes('Example Gym Equipment')).querySelector('.ia-more').click());
  await page.waitForSelector('.ia-menu[role="menu"]');
  ok(await page.$eval('.ia-menu', (e) => e.matches(':popover-open')), 'the menu draws in the top layer');
  const hit = await page.evaluate(() => { const b = document.querySelector('.ia-menu button'); const r = b.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b; });
  ok(hit, 'nothing covers the menu');
  await page.screenshot({ path: `${OUT}menu.png` });
  await axe(page, 'the menu');
  await clickText(page, '.ia-menu button', 'Leave out: works off site');
  await page.waitForFunction(() => document.querySelector('.ia-out summary')?.textContent.includes('2'));
  ok(!(await page.$$eval('.ia-list[aria-label="Subcontractors paid"] .ia-name', (els) => els.map((e) => e.textContent))).includes('Example Gym Equipment'), 'left out, it leaves the list');
  ok(/PAID TO SUBCONTRACTORS WITHOUT INSURANCE\s*\$227\.00/i.test(await textOf(page, '.ia-stats')), 'and the headline drops');
  await page.click('.ia-out summary');
  ok((await textOf(page, '.ia-out')).includes('Works off site (holly)'), 'with who decided and why');
  await page.evaluate(() => [...document.querySelectorAll('.ia-out .ia-item')].find((e) => e.textContent.includes('Example Gym Equipment')).querySelector('.ia-more').click());
  await page.waitForSelector('.ia-menu[role="menu"]');
  await clickText(page, '.ia-menu button', 'Undo');
  await page.waitForFunction(() => document.querySelector('.ia-out summary')?.textContent.includes('1'));
  ok(true, 'undone');

  // Downloads
  const csv = await page.evaluate(async (u) => { const r = await fetch(u); return { type: r.headers.get('content-type'), text: await r.text() }; }, await page.$eval('.ia-downloads a', (a) => a.getAttribute('href')));
  ok(csv.type.startsWith('text/csv') && csv.text.startsWith('Payee,In JobTread,Counts for the audit'), 'the spreadsheet downloads');
  const pdf = await page.evaluate(async (u) => { const r = await fetch(u); return { type: r.headers.get('content-type'), bytes: [...new Uint8Array(await r.arrayBuffer())] }; }, await page.$eval('.ia-downloads a.btn-primary', (a) => a.getAttribute('href')));
  const packet = await PDFDocument.load(new Uint8Array(pdf.bytes));
  ok(pdf.type === 'application/pdf' && packet.getPageCount() === 2, `the auditor’s packet: the summary, then the tile sub’s certificate (${packet.getPageCount()} pages)`);

  // The term before
  await clickText(page, '.seg[aria-label="Policy term"] button', `Apr ${termYear - 1}`);
  await page.waitForFunction(() => document.body.innerText.includes('No subcontractor payments in'));
  ok(true, 'the term before opens on its own');
  ok(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await page.close();

  console.log('Phone');
  const phone = await open(browser, base, { width: 390, height: 844, isMobile: true, hasTouch: true });
  const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow <= 0, `no sideways scroll on a phone (${overflow}px)`);
  const small = await phone.page.$$eval('.ia-more, .ia-downloads a, .seg[aria-label="Policy term"] button', (els) => els.filter((e) => e.getBoundingClientRect().height < 44).length);
  ok(small === 0, 'the menus, downloads and terms are 44px touch targets');
  await phone.page.screenshot({ path: `${OUT}phone.png`, fullPage: true });
  await axe(phone.page, 'phone');
  ok(phone.errors.length === 0, `no console errors on a phone${phone.errors.length ? `: ${phone.errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} failed` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
