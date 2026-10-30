/**
 * test-insurance-audit-admin.mjs — drive Admin → Job Costs → Insurance audit in a real browser
 * ===========================================================================
 * Opens the admin at #job-costs/insurance (public/ served directly, on a port
 * of its own) with /api/insurance-audit-admin answered by the REAL handler
 * (functions/api/insurance-audit-admin.js → _insurance-audit.js) over an
 * in-memory D1 and a pretend JobTread, Ramp and Mercury; /api/job-costs-admin
 * answers with a small fixture. Checks: the tab; the workers' comp audit's
 * headline and counts; a gap in workers' comp; one sub's payments; leaving a
 * payee out from its "⋯" menu (drawn in the top layer) and undoing it; both
 * downloads; another term; then the liability audit: its own headline, its
 * own coverage, its menu (no "one person, no employees"), its downloads and
 * its terms; phones (no sideways scroll, 44px targets); axe; no console
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
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const thisYear = Number(today.slice(0, 4));
const termYear = today >= `${thisYear}-04-11` ? thisYear : thisYear - 1;     // workers' comp's current term
const glYear = today >= `${thisYear}-11-21` ? thisYear : thisYear - 1;        // liability's
const WC_START = `${termYear}-04-11`;
const GL_START = `${glYear}-11-21`;
const plus = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);

// ─── A pretend JobTread, Ramp and Mercury ───────────────────────────
const certPdf = async () => { const doc = await PDFDocument.create(); doc.addPage([612, 792]).drawText('ACORD 25 CERTIFICATE OF LIABILITY INSURANCE', { x: 60, y: 700, size: 12 }); return doc.save(); };
// The same payments in each audit's current term, days after it began (from April 11: May 1, May 10, June 1, June 5, July 1, August 1)
const world = (start) => {
  const d = (n) => plus(start, n);
  return {
    jtBills: [
      { id: 'B1', account: { id: 'V1', name: 'Sample Tile' }, number: '101', issueDate: d(20), cost: 42, amountPaid: 42, status: 'approved', costItems: { nodes: [{ costType: { name: 'Subcontractor' } }] } },
      { id: 'B2', account: { id: 'V2', name: 'Example Framing Co' }, number: '7', issueDate: d(51), cost: 185, amountPaid: 185, status: 'approved', costItems: { nodes: [] } },
      { id: 'B3', account: { id: 'V3', name: 'Example Supply' }, number: '55', issueDate: d(81), cost: 9, amountPaid: 9, status: 'approved', costItems: { nodes: [] } },
      { id: 'B4', account: { id: 'V4', name: 'Example Gym Equipment' }, number: '9', issueDate: d(112), cost: 64, amountPaid: 64, status: 'approved', costItems: { nodes: [] } },
    ],
    jtPayments: [{ id: 'P1', amount: 42, paidAt: d(29), account: { id: 'V1', name: 'Sample Tile', type: 'vendor' }, documentPayments: { nodes: [{ amount: 42, document: { id: 'B1', type: 'vendorBill' } }] } }],
    rampBills: [{ id: 'R2', vendor: { name: 'Example Framing Co' }, amount: { amount: 18500, minor_unit_conversion_rate: 100 }, invoice_number: '7', paid_at: `${d(55)}T15:00:00Z`, payment: { payment_method: 'CHECK' }, line_items: [] }],
  };
};
const WC = world(WC_START);
const GL = world(GL_START);
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.host === 'api.jobtread.com') {
    const { query } = JSON.parse(init.body);
    // Only each audit's current term has payments (its questions end where it ends)
    const mine = (where) => { const w = JSON.stringify(where); return w.includes(`${termYear + 1}-04-11`) ? WC : w.includes(`${glYear + 1}-11-21`) ? GL : null; };
    if (query.organization?.documents) return Response.json({ organization: { documents: { nextPage: null, nodes: mine(query.organization.documents.$.where)?.jtBills || [] } } });
    if (query.organization?.payments) return Response.json({ organization: { payments: { nextPage: null, nodes: mine(query.organization.payments.$.where)?.jtPayments || [] } } });
    if (query.file) return Response.json({ file: { id: query.file.$.id, name: 'COI.pdf', url: 'https://files.jobtread.example/coi.pdf' } });
    if (query.account) return Response.json({ account: { files: { nodes: [] } } });
    throw new Error(`JobTread doesn't know ${Object.keys(query)}`);
  }
  if (url.host === 'files.jobtread.example') return new Response(await certPdf());
  if (url.host === 'api.ramp.com') {
    if (url.pathname.endsWith('/token')) return Response.json({ access_token: 'tok', expires_in: 3600 });
    const from = String(url.searchParams.get('from_paid_at'));
    return Response.json({ data: from.startsWith(plus(WC_START, -1)) ? WC.rampBills : from.startsWith(plus(GL_START, -1)) ? GL.rampBills : [], page: { next: null } });
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
// The tile sub: liability through both terms; workers' comp only from 51 days into its term (after its May payment)
for (const [id, kind, eff, exp, insurer] of [['c1', 'gl', plus(GL_START, -400), plus(GL_START, 800), 'Example Mutual'], ['c2', 'wc', plus(WC_START, 51), plus(WC_START, 354), 'Example Comp']]) {
  await DB.prepare("INSERT INTO coi_coverage (id, jt_id, insured, kind, effective, expires, insurer, source, file_hash, jt_file_id, found_at) VALUES (?, 'V1', 'Sample Tile LLC', ?, ?, ?, ?, 'gmail', 'h1', 'F1', ?)")
    .bind(id, kind, eff, exp, insurer, new Date().toISOString()).run();
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
  ok(await page.$eval('.seg[aria-label="Audit"] [aria-selected="true"]', (e) => e.textContent.trim()) === 'Workers’ comp', 'the workers’ comp audit opens first');
  ok(/PAID TO SUBCONTRACTORS WITHOUT WORKERS’ COMPENSATION\s*\$291\.00/i.test(stats), `the headline: what was paid without workers’ comp (${stats.split('\n').slice(0, 3).join(' | ')})`);
  ok(stats.includes('3 subcontractors paid in all'), 'how many subcontractors were paid');
  const names = await page.$$eval('.ia-list[aria-label="Subcontractors paid"] .ia-name', (els) => els.map((e) => e.textContent));
  ok(names.join() === 'Example Framing Co,Example Gym Equipment,Sample Tile', `the subs, biggest gap first (${names})`);
  const framing = await textOf(page, '.ia-list[aria-label="Subcontractors paid"] .ia-item');
  ok(framing.includes('$185.00 not covered') && framing.includes('None, and no email in JobTread to ask'), 'a gap, and why nobody was asked');
  const tile = await page.evaluate(() => [...document.querySelectorAll('.ia-item')].find((e) => e.textContent.includes('Sample Tile'))?.innerText || '');
  ok(tile.includes('$42.00 not covered') && !tile.includes('Example Mutual'), 'the tile sub: paid before their workers’ comp began; their liability isn’t this audit’s');
  ok((await page.$$eval('.ia-list[aria-label="Subcontractors paid"] .ia-head span', (els) => els.map((e) => e.textContent))).join('|') === 'Subcontractor|Paid in the term|Workers’ compensation|Certificate|', 'one coverage column: workers’ comp');
  await page.screenshot({ path: `${OUT}audit.png`, fullPage: false });
  await axe(page, 'the audit');

  await clickText(page, '.ia-link', 'Show 1 payment');
  await page.waitForSelector('.ia-pays table');
  ok((await textOf(page, '.ia-pays')).includes('Ramp, Invoice 7'), 'one sub’s payments, with where each came from');

  // Leave the gym company out: it builds equipment off site
  await page.evaluate(() => [...document.querySelectorAll('.ia-item')].find((e) => e.textContent.includes('Example Gym Equipment')).querySelector('.ia-more').click());
  await page.waitForSelector('.ia-menu[role="menu"]');
  // The menu is lifted into the top layer by an effect after it first draws: wait for it, don't race it
  ok(await page.waitForFunction(() => document.querySelector('.ia-menu')?.matches(':popover-open'), { timeout: 3000 }).then(() => true, () => false), 'the menu draws in the top layer');
  const hit = await page.evaluate(() => { const b = document.querySelector('.ia-menu button'); const r = b.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b; });
  ok(hit, 'nothing covers the menu');
  await page.screenshot({ path: `${OUT}menu.png` });
  await axe(page, 'the menu');
  await clickText(page, '.ia-menu button', 'Leave out: works off site');
  await page.waitForFunction(() => document.querySelector('.ia-out summary')?.textContent.includes('2'));
  ok(!(await page.$$eval('.ia-list[aria-label="Subcontractors paid"] .ia-name', (els) => els.map((e) => e.textContent))).includes('Example Gym Equipment'), 'left out, it leaves the list');
  ok(/PAID TO SUBCONTRACTORS WITHOUT WORKERS’ COMPENSATION\s*\$227\.00/i.test(await textOf(page, '.ia-stats')), 'and the headline drops');
  await page.click('.ia-out summary');
  ok((await textOf(page, '.ia-out')).includes('Works off site (holly)'), 'with who decided and why');
  await page.evaluate(() => [...document.querySelectorAll('.ia-out .ia-item')].find((e) => e.textContent.includes('Example Gym Equipment')).querySelector('.ia-more').click());
  await page.waitForSelector('.ia-menu[role="menu"]');
  await clickText(page, '.ia-menu button', 'Undo');
  await page.waitForFunction(() => document.querySelector('.ia-out summary')?.textContent.includes('1'));
  ok(true, 'undone');

  // Downloads
  const csv = await page.evaluate(async (u) => { const r = await fetch(u); return { type: r.headers.get('content-type'), text: await r.text() }; }, await page.$eval('.ia-downloads a', (a) => a.getAttribute('href')));
  ok(csv.type.startsWith('text/csv') && csv.text.startsWith('Payee,In JobTread,Counts for the audit') && csv.text.includes('Paid without workers comp'), 'the workers’ comp spreadsheet downloads');
  const pdf = await page.evaluate(async (u) => { const r = await fetch(u); return { type: r.headers.get('content-type'), bytes: [...new Uint8Array(await r.arrayBuffer())] }; }, await page.$eval('.ia-downloads a.btn-primary', (a) => a.getAttribute('href')));
  const packet = await PDFDocument.load(new Uint8Array(pdf.bytes));
  ok(pdf.type === 'application/pdf' && packet.getPageCount() === 2, `the auditor’s packet: the summary, then the tile sub’s certificate (${packet.getPageCount()} pages)`);

  // The term before
  await clickText(page, '.seg[aria-label="Policy term"] button', `Apr ${termYear - 1}`);
  await page.waitForFunction(() => document.body.innerText.includes('No subcontractor payments in'));
  ok(true, 'the term before opens on its own');

  // The liability audit: its own term, headline and coverage
  await clickText(page, '.seg[aria-label="Audit"] button', 'Liability');
  await page.waitForFunction(() => document.querySelector('.seg[aria-label="Audit"] [aria-selected="true"]')?.textContent.trim() === 'Liability' && document.querySelector('.ia-list[aria-label="Subcontractors paid"]'));
  const glTerms = await page.$$eval('.seg[aria-label="Policy term"] button', (els) => els.map((e) => [e.textContent.trim(), e.getAttribute('aria-selected')]));
  ok(glTerms.length === 3 && glTerms[0][0] === `Nov ${glYear} to Nov ${glYear + 1}` && glTerms[0][1] === 'true', `its own terms, November to November, the current one open (${glTerms.map((x) => x[0]).join(', ')})`);
  const glStats = await textOf(page, '.ia-stats');
  ok(/PAID TO SUBCONTRACTORS WITHOUT GENERAL LIABILITY\s*\$249\.00/i.test(glStats), `the liability headline: the framer and the gym company, not the tile sub (${glStats.split('\n').slice(0, 3).join(' | ')})`);
  ok((await textOf(page, '.ia-lead')).includes('general liability policy term'), 'the lead says which audit');
  const glNames = await page.$$eval('.ia-list[aria-label="Subcontractors paid"] .ia-name', (els) => els.map((e) => e.textContent));
  ok(glNames.join() === 'Example Framing Co,Example Gym Equipment,Sample Tile', `the subs, biggest liability gap first (${glNames})`);
  const glTile = await page.evaluate(() => [...document.querySelectorAll('.ia-item')].find((e) => e.textContent.includes('Sample Tile'))?.innerText || '');
  ok(glTile.includes('Covered') && glTile.includes('Example Mutual') && !glTile.includes('not covered'), 'the tile sub: covered by their own liability');
  ok((await page.$$eval('.ia-list[aria-label="Subcontractors paid"] .ia-head span', (els) => els.map((e) => e.textContent))).join('|') === 'Subcontractor|Paid in the term|General liability|Certificate|', 'one coverage column: general liability');
  await page.screenshot({ path: `${OUT}liability.png`, fullPage: false });
  await axe(page, 'the liability audit');
  await page.evaluate(() => [...document.querySelectorAll('.ia-item')].find((e) => e.textContent.includes('Example Gym Equipment')).querySelector('.ia-more').click());
  await page.waitForSelector('.ia-menu[role="menu"]');
  const glMenu = await page.$$eval('.ia-menu button', (els) => els.map((e) => e.textContent.trim()));
  ok(glMenu.join('|') === 'Leave out: works off site|Leave out: sells materials only', `the liability menu has no “one person, no employees” (${glMenu.join(' | ')})`);
  await page.waitForFunction(() => document.querySelector('.ia-menu')?.matches(':popover-open'));   // its keys are listened for once it's lifted
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.ia-menu'));
  const glHrefs = await page.$$eval('.ia-downloads a', (els) => els.map((a) => a.getAttribute('href')));
  ok(glHrefs.every((h) => h.includes(`term=gl-${glYear}`)), 'the downloads are the liability audit’s');
  const glCsv = await page.evaluate(async (u) => { const r = await fetch(u); return { name: r.headers.get('content-disposition'), text: await r.text() }; }, glHrefs[0]);
  ok(glCsv.text.split('\n')[0].includes('Paid without general liability') && !glCsv.text.includes('workers comp') && glCsv.name.includes('SOARD liability audit'), 'the liability spreadsheet: its own columns and name');
  const glPdf = await page.evaluate(async (u) => { const r = await fetch(u); return { name: r.headers.get('content-disposition'), bytes: [...new Uint8Array(await r.arrayBuffer())] }; }, glHrefs[1]);
  const glPacket = await PDFDocument.load(new Uint8Array(glPdf.bytes));
  ok(glPacket.getTitle().startsWith('General liability audit') && glPacket.getPageCount() === 2 && glPdf.name.includes('SOARD liability audit'), `the liability packet: named for it, the summary and the tile sub’s certificate (${glPacket.getPageCount()} pages)`);
  await clickText(page, '.seg[aria-label="Policy term"] button', `Nov ${glYear - 1}`);
  await page.waitForFunction(() => document.body.innerText.includes('No subcontractor payments in'));
  ok(true, 'the liability term before opens on its own');
  await clickText(page, '.seg[aria-label="Audit"] button', 'Workers’ comp');
  await page.waitForFunction((y) => document.querySelector('.seg[aria-label="Policy term"] [aria-selected="true"]')?.textContent.trim() === `Apr ${y} to Apr ${y + 1}`, {}, termYear);
  ok(true, 'back to workers’ comp, its current term');
  ok(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await page.close();

  console.log('Phone');
  const phone = await open(browser, base, { width: 390, height: 844, isMobile: true, hasTouch: true });
  const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow <= 0, `no sideways scroll on a phone (${overflow}px)`);
  const small = await phone.page.$$eval('.ia-more, .ia-downloads a, .seg[aria-label="Policy term"] button, .seg[aria-label="Audit"] button', (els) => els.filter((e) => e.getBoundingClientRect().height < 44).length);
  ok(small === 0, 'the menus, downloads, audits and terms are 44px touch targets');
  await phone.page.screenshot({ path: `${OUT}phone.png`, fullPage: true });
  await axe(phone.page, 'phone');
  ok(phone.errors.length === 0, `no console errors on a phone${phone.errors.length ? `: ${phone.errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} failed` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
