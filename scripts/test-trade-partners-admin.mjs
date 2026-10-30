/**
 * test-trade-partners-admin.mjs — drive Admin → Trade Partners in a real browser
 * ===========================================================================
 * Opens the admin at #trade-partners (public/ served directly) with
 * /api/trade-partners-admin answered by the REAL handler
 * (functions/api/trade-partners-admin.js → _trade-partners.js) over an
 * in-memory D1 and a pretend JobTread, Resend and Slack, and checks: the menu
 * entry; the counts and filters; finding a partner; one partner's documents,
 * files, invoices and bank, and marking them materials only (in JobTread);
 * approving a "Work with us" request (a JobTread vendor made and invited);
 * confirming a bank account after the call (through the admin's own ask
 * dialog); the minimums and "Send me the vendor email"; "Add a trade
 * partner"; the address of each tab; phones (no sideways scroll, 44px
 * targets), axe, and no console errors. Screenshots land in
 * test-results/trade-partners-admin/.
 *
 *   node scripts/test-trade-partners-admin.mjs
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { answerAsks } from './lib/ask.mjs';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import { onRequestGet as adminGet, onRequestPost as adminPost } from '../functions/api/trade-partners-admin.js';
import { ensureVendorSchema, jtSetup, TRADES, readDocSettings } from '../functions/api/_vendors.js';
import { ensurePartnerSchema } from '../functions/api/_trade-partners.js';
import { ensureSpendSchema } from '../functions/api/_spend.js';
import { ensureBillPaySchema } from '../functions/api/_bill-pay.js';
import { writeSlackConfig } from '../functions/api/_broadcast-notify.js';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/trade-partners-admin/');
mkdirSync(OUT, { recursive: true });
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ME = 'holly@example.org';
const EMAIL_F = '22NJw43QvHeJ';
const PHONE_F = '22NJw43UauSc';

// ─── A pretend JobTread, Resend and Slack ───────────────────────────
const FIELDS = [
  ['F-W9', 'W-9', 'boolean'], ['F-GL', 'Liability Expires', 'date'], ['F-WC', 'Workers\' Comp Expires', 'date'], ['F-DOCS', 'Documents', 'option'],
  ['F-CHECK', 'Insurance Check', 'text'], ['F-TRADES', 'Trades', 'option'], ['F-ADDR', 'Address', 'text'], ['F-LIC', 'License', 'text'], ['F-MAT', 'Materials only', 'boolean'],
].map(([id, name, type]) => ({ id, name, type, options: id === 'F-TRADES' ? TRADES : id === 'F-DOCS' ? ['Current', 'Expiring soon', 'Requested', 'Expired', 'Missing', 'Needs a look', 'W-9 only', 'Not needed'] : null }));
const contact = (id, name, title, email, phone = null) => ({ id, name, title, email, phone });
const world = {
  accounts: {
    'ACC-TKO': { name: 'TKO Plumbing', values: { 'F-GL': '2026-09-30', 'F-WC': '2027-06-01', 'F-TRADES': ['Plumbing'] }, primary: 'C1', contacts: [contact('C1', 'Tom Kowalski', 'Main contact', 'tom@tko.example', '+14045550134')],
      files: [{ name: 'COI TKO Plumbing 2025-10-01.pdf', tags: ['T-COI'] }] },
    'ACC-RIV': { name: 'Rivera Example Roofing', values: { 'F-W9': true, 'F-GL': '2027-06-01', 'F-WC': '2027-06-01' }, primary: 'C2', contacts: [contact('C2', 'Maria Rivera', 'Main contact', 'maria@rivera.example', '+14045550100')], files: [] },
  },
  made: [], comments: [], emails: [], slack: [],
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.host === 'api.jobtread.com') {
    const { query } = JSON.parse(init.body);
    if (query.organization?.customFields) return Response.json({ organization: { customFields: { nodes: FIELDS }, fileTags: { nodes: [{ id: 'T-W9', name: 'W-9' }, { id: 'T-COI', name: 'COI' }] } } });
    if (query.account) {
      const a = world.accounts[query.account.$.id];
      const cf = (c) => ({ nodes: c ? [c.email && { value: c.email, customField: { id: EMAIL_F } }, c.phone && { value: c.phone, customField: { id: PHONE_F } }].filter(Boolean) : [] });
      return Response.json({ account: a && {
        id: query.account.$.id, name: a.name, type: 'vendor', archivedAt: null,
        customFieldValues: { nodes: Object.entries(a.values).map(([id, value]) => ({ value, customField: { id } })) },
        primaryContact: a.primary ? { id: a.primary, customFieldValues: cf(a.contacts.find((c) => c.id === a.primary)) } : null,
        contacts: { nodes: a.contacts.map((c) => ({ id: c.id, name: c.name, title: c.title, customFieldValues: cf(c) })) },
        files: { nodes: (a.files || []).map((f, i) => ({ id: `F${i}`, name: f.name, url: `https://files.jobtread.example/${i}.pdf`, createdAt: '2026-10-01T15:00:00Z', fileTags: { nodes: f.tags.map((id) => ({ id })) } })) },
      } });
    }
    if (query.updateAccount) { const a = world.accounts[query.updateAccount.$.id]; Object.assign(a.values, query.updateAccount.$.customFieldValues || {}); return Response.json({}); }
    if (query.createAccount) {
      const id = `ACC-NEW${world.made.length + 1}`;
      world.accounts[id] = { name: query.createAccount.$.name, values: {}, primary: null, contacts: [], files: [] };
      world.made.push(query.createAccount.$);
      return Response.json({ createAccount: { createdAccount: { id, name: query.createAccount.$.name } } });
    }
    if (query.createContact) {
      const { accountId, name, title, customFieldValues: v } = query.createContact.$;
      const c = contact(`C${Date.now()}`, name, title, v?.[EMAIL_F] || null, v?.[PHONE_F] || null);
      world.accounts[accountId].contacts.push(c);
      world.accounts[accountId].primary ||= c.id;
      return Response.json({ createContact: { createdContact: { id: c.id } } });
    }
    if (query.updateContact) return Response.json({});
    if (query.createComment) { world.comments.push(query.createComment.$); return Response.json({ createComment: { createdComment: { id: 'X' } } }); }
    if (query.updateComment) return Response.json({});
    throw new Error(`JobTread doesn't know ${Object.keys(query)}`);
  }
  if (url.host === 'api.resend.com') { world.emails.push(...JSON.parse(init.body)); return Response.json({ data: [{ id: 'em1' }] }); }
  if (url.host === 'slack.com') { world.slack.push(JSON.parse(init.body)); return Response.json({ ok: true, channel: 'C1', ts: '1.1' }); }
  return realFetch(input, init);
};

const DB = await createD1({ schemaSql: ['CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)'] });
const env = { DB, JOBTREAD_GRANT_KEY: 'jt', RESEND_API_KEY: 're_test', SLACK_BOT_TOKEN: 'xoxb-test' };
await ensureSpendSchema(DB);
await ensureBillPaySchema(DB);
await ensureVendorSchema(DB);
await ensurePartnerSchema(DB);
await writeSlackConfig(DB, { channel: { id: 'CNEWS', name: 'news' }, finance: { id: 'CFIN', name: 'finance' } });
await jtSetup(env);
const cache = (jtId, name, email, fields, jobs = 0) => DB.prepare('INSERT INTO vendors (id, name, vkey, jt_id, email, facts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  .bind(`jt_${jtId}`, name, name.toLowerCase(), jtId, email, JSON.stringify({ jobs: Array.from({ length: jobs }, (_, i) => ({ jobId: `J${i}` })), emails: email ? [email] : [], fields }), '', '').run();
await cache('ACC-TKO', 'TKO Plumbing', 'tom@tko.example', { w9: false, gl: '2026-09-30', wc: '2027-06-01', docs: null, materials: false, trades: ['Plumbing'] }, 1);
await cache('ACC-RIV', 'Rivera Example Roofing', 'maria@rivera.example', { w9: true, gl: '2027-06-01', wc: '2027-06-01', docs: 'Current', materials: false, trades: ['Roofing'] });
await cache('ACC-SUP', 'Example Supply Co', null, { w9: true, gl: null, wc: null, docs: 'Not needed', materials: true, trades: ['Materials and supplies'] });
for (let i = 0; i < 6; i++) await cache(`ACC-X${i}`, `Example Electric ${i}`, `office${i}@electric.example`, { w9: true, gl: '2027-01-15', wc: '2027-01-15', docs: 'Current', materials: false, trades: ['Electrical'] });
// A held bill, a bill paid, a bank account to confirm, a request waiting
await DB.prepare("INSERT INTO spend_bills (id, job_id, vendor, cents, date, created_at, status, number, lines, account_id, paid, balance) VALUES ('B1', 'J0', 'TKO Plumbing', 185000, '2026-10-20', '', 'approved', '7', '[]', 'ACC-TKO', 0, 185000)").run();
await DB.prepare("INSERT INTO bill_approvals (bill_id, state, pay_state, hold) VALUES ('B1', 'approved', 'held', '{\"reason\":\"documents\"}')").run();
await DB.prepare("INSERT INTO vendor_bank (jt_id, mercury_id, last4, kind, status, changed_at, previous_last4, updated_at) VALUES ('ACC-RIV', 'rec-r', '4321', 'businessChecking', 'pending', ?, '8765', ?)").bind(new Date().toISOString(), new Date().toISOString()).run();
await DB.prepare("INSERT INTO vendor_requests (id, created_at, status, company, trades, name, email, phone, area, note, lang) VALUES ('rq1', ?, 'new', 'Example Painting Co', '[\"Painting\"]', 'Pat Painter', 'pat@painting.example', '+14045550111', 'Decatur, Atlanta', 'We do interiors and cabinets.', 'en')").bind(new Date().toISOString()).run();

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

async function open(browser, base, viewport, hash = '#trade-partners') {
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
    if (url.pathname === '/api/trade-partners-admin') {
      const request = new Request(`https://x.example${url.pathname}${url.search}`, req.method() === 'POST' ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: req.postData() } : {});
      const r = await (req.method() === 'POST' ? adminPost : adminGet)({ env, request, data: { userEmail: ME } });
      return req.respond({ status: r.status, contentType: 'application/json', body: await r.text() });
    }
    if (url.pathname === '/api/live-ws') return req.abort();
    if (url.pathname.startsWith('/api/list-content')) return json({ success: true, items: [], total: 0, hasMore: false });
    if (url.pathname.startsWith('/api/pending-changes')) return json({ success: true, changes: [], since: null });
    if (url.pathname.startsWith('/api/audit-log')) return json({ success: true, entries: [], total: 0 });
    if (url.pathname.startsWith('/api/deployments')) return json({ success: true, deploys: [], source: 'cloudflare' });
    if (url.pathname.startsWith('/api/')) return json({ success: true, ok: true });
    return req.continue();
  });
  await answerAsks(page, { accept: true });
  await page.goto(`${base}/admin/${hash}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.tpm .page-header h2', { timeout: 15000 });
  return { page, errors };
}
const clickText = (page, sel, text) => page.evaluate((sel, text) => {
  const el = [...document.querySelectorAll(sel)].find((b) => b.textContent.trim().startsWith(text));
  if (!el) return false;
  el.click();
  return true;
}, sel, text);
const textOf = (page, sel) => page.$eval(sel, (e) => e.innerText).catch(() => '');
async function axe(page, label) {
  await page.addScriptTag({ content: AXE });
  const r = await page.evaluate(async () => (await window.axe.run(document.querySelector('.tpm') || document, { runOnly: ['wcag2a', 'wcag2aa'] })).violations.map((v) => `${v.id} ×${v.nodes.length}`));
  ok(r.length === 0, `axe (${label}): no violations${r.length ? `: ${r.join(', ')}` : ''}`);
}

const server = await serve();
const base = `http://localhost:${server.address().port}`;
const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
try {
  console.log('Desktop');
  const { page, errors } = await open(browser, base, { width: 1440, height: 1000 });
  ok(await page.evaluate(() => [...document.querySelectorAll('nav a, nav button, aside a, aside button')].some((e) => e.textContent.trim() === 'Trade Partners')), 'the menu has Trade Partners');
  ok((await page.$$('.tpm-row')).length === 9, 'every cached JobTread vendor is listed');
  ok((await textOf(page, '.tpm-stats')).includes('NEEDS DOCUMENTS\n1') || /Needs documents\s*1/i.test(await textOf(page, '.tpm-stats')), 'the counts: one needs documents');
  ok((await textOf(page, '.seg[aria-label="Trade partners"]')).includes('Requests 1') || (await textOf(page, '.seg[aria-label="Trade partners"]')).includes('Requests\n1'), 'the Requests tab counts what’s waiting');
  await page.screenshot({ path: `${OUT}list.png` });
  await axe(page, 'list');
  await clickText(page, '.tpm-stats .stat', 'Needs documents');
  await wait(150);
  const needs = await page.$$eval('.tpm-row .tpm-name', (els) => els.map((e) => e.textContent));
  ok(needs.length === 1 && needs[0] === 'TKO Plumbing', `the Needs documents count filters the list (${needs})`);
  ok((await textOf(page, '.tpm-row')).includes('$1,850.00 held'), 'a held payment shows on its row');
  await clickText(page, '.tpm-stats .stat', 'Needs documents');
  await page.type('.tpm-tools input[type=search]', 'supply');
  await wait(150);
  ok((await page.$$eval('.tpm-row .tpm-name', (els) => els.map((e) => e.textContent))).join() === 'Example Supply Co', 'search finds a company by name');
  ok((await textOf(page, '.tpm-row')).includes('Supplier'), 'a materials-only vendor shows as a supplier');
  await page.$eval('.tpm-tools input[type=search]', (e) => { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); });

  // One partner
  await clickText(page, '.tpm-row', 'TKO Plumbing');
  await page.waitForFunction(() => document.querySelector('.tpm-detail'), { timeout: 10000 });
  ok((await page.evaluate(() => location.hash)) === '#trade-partners/ACC-TKO', 'one partner has its own address');
  const detail = await textOf(page, '.tpm-detail');
  ok(detail.includes('Missing') && detail.includes('COI TKO Plumbing 2025-10-01.pdf') && detail.includes('Tom Kowalski'), 'their W-9 and insurance, files in JobTread and people');
  ok(/#7[\s\S]*\$1,850\.00[\s\S]*Held \(documents\)/.test(detail), 'their invoices, with why one is held');
  await page.screenshot({ path: `${OUT}partner.png`, fullPage: true });
  await page.evaluate(() => [...document.querySelectorAll('.tpm-switch')].find((l) => l.textContent.includes('Materials only')).querySelector('input').click());
  await page.waitForFunction(() => [...document.querySelectorAll('.tpm-switch input')][0]?.checked, { timeout: 10000 });
  ok(world.accounts['ACC-TKO'].values['F-MAT'] === true && /Materials only|materials only/.test(world.comments.at(-1).message), 'materials only is written to JobTread, with a note');
  await clickText(page, '.btn', 'Send the setup invitation');
  await page.waitForFunction(() => document.body.innerText.includes('Sent to tom@tko.example'), { timeout: 10000 });
  ok(world.emails.at(-1)?.to?.[0] === 'tom@tko.example' && /^Set up your account/.test(world.emails.at(-1).subject), 'they’re emailed the setup invitation');
  await axe(page, 'one partner');
  await page.goBack();
  await page.waitForSelector('.tpm-list', { timeout: 5000 });
  ok(true, 'Back returns to the list');

  // Requests
  await clickText(page, '.seg [role="tab"]', 'Requests');
  await page.waitForFunction(() => document.body.innerText.includes('Example Painting Co'));
  ok((await page.evaluate(() => location.hash)) === '#trade-partners/requests', 'Requests has its own address (Slack’s link)');
  await page.screenshot({ path: `${OUT}requests.png` });
  await clickText(page, '.tpm-card .btn', 'Approve and invite');
  await page.waitForFunction(() => document.body.innerText.includes('No requests waiting'), { timeout: 10000 });
  ok(world.made.some((m) => m.name === 'Example Painting Co' && m.type === 'vendor'), 'approving makes the vendor in JobTread');
  ok(world.emails.some((m) => m.to[0] === 'pat@painting.example' && /Set up your account/.test(m.subject)), 'and emails them their invitation');
  ok((await textOf(page, '.tpm-list')).includes(ME), 'decided, by whom');
  await axe(page, 'requests');

  // Bank changes
  await clickText(page, '.seg [role="tab"]', 'Bank changes');
  await page.waitForFunction(() => document.body.innerText.includes('Rivera Example Roofing'));
  const bank = await textOf(page, '.tpm-cards');
  ok(bank.includes('ending 4321') && bank.includes('was ending 8765') && bank.includes('(404) 555-0100'), `the account, what it was, and the number on file to call (${bank.replace(/\n/g, ' | ')})`);
  await page.screenshot({ path: `${OUT}bank.png` });
  await clickText(page, '.tpm-card .btn', 'I called and confirmed it');
  await page.waitForFunction(() => document.body.innerText.includes('Nothing to confirm'), { timeout: 10000 });
  const row = await DB.prepare("SELECT status, confirmed_by FROM vendor_bank WHERE jt_id = 'ACC-RIV'").first();
  ok(row.status === 'confirmed' && row.confirmed_by === ME, 'confirmed after the admin’s own ask dialog, by the signed-in person');
  await axe(page, 'bank changes');

  // Settings
  await clickText(page, '.seg [role="tab"]', 'Settings');
  await page.waitForFunction(() => document.body.innerText.includes('Insurance minimums'));
  await page.evaluate(() => {
    const input = [...document.querySelectorAll('.tpm-field')].find((l) => l.textContent.includes('each occurrence')).querySelector('input');
    input.value = '2000000'; input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await clickText(page, '.tpm-card .btn', 'Save');
  await wait(400);
  ok((await readDocSettings(DB)).glOccurrence === 2000000, 'the minimums save');
  await clickText(page, '.tpm-card .btn', 'Send me the vendor email');
  await page.waitForFunction(() => document.body.innerText.includes(`Sent to holly@example.org`), { timeout: 10000 });
  ok(world.emails.at(-1).to[0] === ME && /^Preview: /.test(world.emails.at(-1).subject), '“Send me the vendor email” sends the preview to the signed-in person');
  await axe(page, 'settings');

  // Add a trade partner
  await clickText(page, '.page-header .btn', 'Add a trade partner');
  await page.waitForSelector('.kd-dialog');
  await page.type('.kd-dialog input[data-autofocus]', 'Example Floors LLC');
  await page.evaluate(() => {
    const set = (label, v) => { const i = [...document.querySelectorAll('.kd-dialog .tpm-field')].find((l) => l.textContent.includes(label)).querySelector('input'); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); };
    set('Contact’s name', 'Fran Floors'); set('Email the invitation to', 'fran@floors.example');
  });
  await page.screenshot({ path: `${OUT}add.png` });
  await axe(page, 'add dialog');
  await clickText(page, '.kd-dialog .btn', 'Send the invitation');
  await page.waitForFunction(() => !document.querySelector('.kd-dialog'), { timeout: 10000 });
  ok(world.made.some((m) => m.name === 'Example Floors LLC') && world.emails.at(-1).to[0] === 'fran@floors.example', 'a new company is made in JobTread and invited');
  ok(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);

  console.log('Phone');
  const phone = await open(browser, base, { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const wide = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(wide <= 0, `no sideways scroll on a phone (${wide}px)`);
  const small = await phone.page.$$eval('.tpm button, .tpm a.btn, .tpm input', (els) => els.filter((e) => e.offsetWidth && !e.closest('[hidden]')).map((e) => [e.textContent.trim().slice(0, 18) || e.type, Math.round(e.getBoundingClientRect().height)]).filter(([, h]) => h < 40));
  ok(small.length === 0, `touch targets at least 40px (${JSON.stringify(small.slice(0, 6))})`);
  await phone.page.screenshot({ path: `${OUT}phone.png` });
  await axe(phone.page, 'phone');
  ok(phone.errors.length === 0, `no console errors on a phone${phone.errors.length ? `: ${phone.errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
  server.close();
  globalThis.fetch = realFetch;
}
console.log(failures.length ? `\n${failures.length} failed` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
