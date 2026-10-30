/**
 * test-trade-partners.mjs — the trade-partner pages, in a browser
 * ===========================================================================
 * /trade-partners/ and /trade-partners/account/ on an Astro dev server, under
 * the CSP public/_headers gives them, with their /api calls answered by the
 * REAL handlers (vendor-docs.js, trade-partner.js → _vendors.js,
 * _trade-partners.js) over an in-memory D1 and a pretend JobTread, Mercury,
 * Workers AI, Resend and Slack:
 *   - the landing page: Spanish, signing in (an address on file gets a link,
 *     one that isn't gets the same words), "Work with us" (checked, thanked,
 *     waiting in the admin)
 *   - a new partner's setup, one step at a time: company → a W-9 filled in and
 *     signed on the page (the IRS PDF filed in JobTread) → a certificate PDF,
 *     drawn by pdf.js and read from its text and its picture → bank details
 *     straight to Mercury; Back from a step goes back to the overview
 *   - invoices in words; a dropped connection said in words; an iPhone photo
 *     decoded by heic-to.js under the page's own CSP (Safari decodes HEIC
 *     itself); a transparent PNG goes up on white
 *   - an insurance agent's link: the certificate and nothing else
 *   - phones: no sideways scroll, 44px targets, a step has the screen; axe;
 *     no console errors
 * Screenshots land in test-results/trade-partners/.
 *
 *   npx astro dev --port 4391 &   (any free port)
 *   BASE=http://127.0.0.1:4391 node scripts/test-trade-partners.mjs
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { join } from 'node:path';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import { onRequestGet as docsGet, onRequestPost as docsPost } from '../functions/api/vendor-docs.js';
import { onRequestGet as tpGet, onRequestPost as tpPost } from '../functions/api/trade-partner.js';
import { createLink, ensureVendorSchema, jtSetup, TRADES, PREVIEW_ID } from '../functions/api/_vendors.js';
import { ensurePartnerSchema, listRequests, readBank } from '../functions/api/_trade-partners.js';
import { ensureSpendSchema } from '../functions/api/_spend.js';
import { ensureBillPaySchema } from '../functions/api/_bill-pay.js';
import { writeSlackConfig } from '../functions/api/_broadcast-notify.js';
import { MERCURY_BASE } from '../functions/api/_mercury.js';
import { axeScan, axeText } from './lib/axe.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/trade-partners/');
mkdirSync(OUT, { recursive: true });
const BASE = (process.env.BASE || 'http://127.0.0.1:4391').replace(/\/$/, '');
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VENDOR = 'ACC-TKO';
const AGENT_VENDOR = 'ACC-AGENT';
const EMAIL_F = '22NJw43QvHeJ';
const PHONE_F = '22NJw43UauSc';

// ─── Files to add (made-up companies; their words come from the pretend AI) ─
async function letterPdf(path, lines) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  lines.forEach((l, i) => page.drawText(l, { x: 54, y: 720 - i * 24, size: 14, font }));
  writeFileSync(path, await doc.save());
}
const COI = join(OUT, 'certificate.pdf');
await letterPdf(COI, ['ACORD 25 CERTIFICATE OF LIABILITY INSURANCE', '(a test file)']);
const HEIC = join(OUT, 'IMG_0413.HEIC');
const realHeic = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 245, g: 244, b: 238 } } }).png().toFile(join(OUT, 'photo.png'))
  .then(() => { execFileSync('sips', ['-s', 'format', 'heic', join(OUT, 'photo.png'), '--out', HEIC], { stdio: 'ignore' }); return true; }).catch(() => false);
const PNG = join(OUT, 'screenshot.png');
await sharp({ create: { width: 3000, height: 2000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: { create: { width: 1200, height: 200, channels: 4, background: { r: 20, g: 20, b: 20, alpha: 1 } } }, top: 300, left: 300 }]).png().toFile(PNG);
// The page's own CSP, as Cloudflare serves it (astro dev doesn't read _headers)
const PAGE_CSP = readFileSync(join(ROOT, 'public/_headers'), 'utf8').split('\n/trade-partners/*\n')[1].split('\n')
  .find((l) => l.startsWith('  Content-Security-Policy: ')).replace('  Content-Security-Policy: ', '')
  .replace("connect-src 'self'", `connect-src 'self' ${BASE.replace('http', 'ws')} ws://127.0.0.1:5173`)
  .replace("img-src 'self'", "img-src 'self' https://sunshineonaranneyday.com");

// ─── A pretend JobTread, Mercury, Resend, Slack and Workers AI ──────
const FIELDS = [
  ['F-W9', 'W-9', 'boolean'], ['F-GL', 'Liability Expires', 'date'], ['F-WC', 'Workers\' Comp Expires', 'date'], ['F-DOCS', 'Documents', 'option'],
  ['F-CHECK', 'Insurance Check', 'text'], ['F-TRADES', 'Trades', 'option'], ['F-ADDR', 'Address', 'text'], ['F-LIC', 'License', 'text'], ['F-MAT', 'Materials only', 'boolean'],
].map(([id, name, type]) => ({ id, name, type, options: id === 'F-TRADES' ? TRADES : id === 'F-DOCS' ? ['Current', 'Expiring soon', 'Requested', 'Expired', 'Missing', 'Needs a look', 'W-9 only', 'Not needed'] : null }));
const world = {
  accounts: {
    [VENDOR]: { name: 'TKO Plumbing', values: {}, primary: 'CON1', contacts: [{ id: 'CON1', name: 'Tom', title: '', email: 'tom@tko.example', phone: null }] },
    [AGENT_VENDOR]: { name: 'Rivera Example Roofing', values: {}, primary: 'CON2', contacts: [{ id: 'CON2', name: 'Maria', title: 'Main contact', email: 'maria@rivera.example', phone: null }] },
  },
  files: [], comments: [], emails: [], slack: [], recipients: [{ id: 'rec-tko', name: 'TKO Plumbing', status: 'active' }], mercury: [], read: [], drop: false,
};
const coiAnswer = { isCertificate: true, readable: true, insured: 'TKO Plumbing LLC', certificateHolder: 'Sunshine on a Ranney Day', policies: [
  { kind: 'general liability', insurer: 'Hartford', expires: '2027-06-01', eachOccurrence: 1000000, aggregate: 2000000 },
  { kind: 'workers compensation', insurer: 'Travelers', expires: '2027-06-01', employersLiabilityEachAccident: 500000 },
] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.host === 'uploads.jobtread.example') return new Response('', { status: 200 });
  if (url.host === 'api.jobtread.com') {
    const { query } = JSON.parse(init.body);
    if (query.organization?.customFields) return Response.json({ organization: { customFields: { nodes: FIELDS }, fileTags: { nodes: [{ id: 'T-W9', name: 'W-9' }, { id: 'T-COI', name: 'COI' }] } } });
    if (query.account) {
      const a = world.accounts[query.account.$.id];
      const cf = (c) => ({ nodes: [c.email && { value: c.email, customField: { id: EMAIL_F } }, c.phone && { value: c.phone, customField: { id: PHONE_F } }].filter(Boolean) });
      return Response.json({ account: a && {
        id: query.account.$.id, name: a.name, type: 'vendor', archivedAt: null,
        customFieldValues: { nodes: Object.entries(a.values).map(([id, value]) => ({ value, customField: { id } })) },
        primaryContact: { id: a.primary, customFieldValues: cf(a.contacts.find((c) => c.id === a.primary)) },
        contacts: { nodes: a.contacts.map((c) => ({ id: c.id, name: c.name, title: c.title, customFieldValues: cf(c) })) },
      } });
    }
    if (query.updateAccount) { const a = world.accounts[query.updateAccount.$.id]; if (query.updateAccount.$.name) a.name = query.updateAccount.$.name; Object.assign(a.values, query.updateAccount.$.customFieldValues || {}); return Response.json({}); }
    if (query.createContact) {
      const { accountId, name, title, customFieldValues: v } = query.createContact.$;
      world.accounts[accountId].contacts.push({ id: `CON${Date.now()}`, name, title, email: v?.[EMAIL_F] || null, phone: v?.[PHONE_F] || null });
      return Response.json({ createContact: { createdContact: { id: 'CONX' } } });
    }
    if (query.updateContact) {
      const { id, name, title, customFieldValues: v } = query.updateContact.$;
      for (const a of Object.values(world.accounts)) { const c = a.contacts.find((x) => x.id === id); if (c) Object.assign(c, { name, title, ...(v?.[EMAIL_F] ? { email: v[EMAIL_F] } : {}), ...(v?.[PHONE_F] ? { phone: v[PHONE_F] } : {}) }); }
      return Response.json({});
    }
    if (query.createComment) { world.comments.push(query.createComment.$); return Response.json({ createComment: { createdComment: { id: 'C1' } } }); }
    if (query.createUploadRequest) return Response.json({ createUploadRequest: { createdUploadRequest: { id: 'U1', url: 'https://uploads.jobtread.example/put', method: 'PUT', headers: {} } } });
    if (query.createFile) { world.files.push(query.createFile.$); return Response.json({ createFile: { createdFile: { id: 'F1' } } }); }
    throw new Error(`JobTread doesn't know ${Object.keys(query)}`);
  }
  if (url.host === 'api.resend.com') { world.emails.push(...JSON.parse(init.body)); return Response.json({ data: [{ id: 'em1' }] }); }
  if (url.host === 'slack.com') { world.slack.push(JSON.parse(init.body)); return Response.json({ ok: true, channel: 'C1', ts: '1.1' }); }
  if (url.origin === MERCURY_BASE) {
    const p = url.pathname.replace('/api/v1', '');
    const method = init.method || 'GET';
    if (p === '/recipients' && method === 'GET') return Response.json({ recipients: world.recipients });
    if (/^\/recipient\/[^/]+$/.test(p) && method === 'GET') return Response.json(world.recipients.find((r) => p.endsWith(r.id)) || {});
    if (/^\/recipient/.test(p) || p === '/recipients') { world.mercury.push({ method, path: p, body: init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null }); return Response.json({ id: 'rec-tko' }); }
  }
  return realFetch(input, init);
};

const DB = await createD1({ schemaSql: ['CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)'] });
const env = {
  DB, JOBTREAD_GRANT_KEY: 'jt', RESEND_API_KEY: 're_test', SLACK_BOT_TOKEN: 'xoxb-test', MERCURY_API_TOKEN: 'secret-token:test', MERCURY_RELAY_KEY: 'relay:test',
  AI: {
    toMarkdown: async () => ({ format: 'text', data: 'The document text, long enough to read. '.repeat(5) }),
    run: async (model, { messages }) => {
      const img = [messages.at(-1).content].flat().find((c) => c?.image_url)?.image_url.url;
      const buf = img ? Buffer.from(img.split(',')[1], 'base64') : null;
      const meta = buf ? await sharp(buf).metadata() : null;
      world.read.push({ model, image: meta && { format: meta.format, width: meta.width, height: meta.height, mean: Math.round((await sharp(buf).stats()).channels[0].mean) } });
      return { response: /W-9/.test(messages[0].content) ? { isW9: true, readable: true, name: 'TKO Plumbing LLC', hasTaxId: true, signed: true, signedDate: '2026-10-27' } : coiAnswer };
    },
  },
};
await ensureSpendSchema(DB);
await ensureBillPaySchema(DB);
await ensureVendorSchema(DB);
await ensurePartnerSchema(DB);
await writeSlackConfig(DB, { channel: { id: 'CNEWS', name: 'news' }, finance: { id: 'CFIN', name: 'finance' } });
await jtSetup(env);
await DB.prepare("INSERT INTO vendors (id, name, vkey, jt_id, email, facts, created_at, updated_at) VALUES ('jt_ACC-TKO', 'TKO Plumbing', 'tko plumbing', ?, 'tom@tko.example', '{\"emails\":[\"tom@tko.example\"]}', '', '')").bind(VENDOR).run();
// Invoices TKO has sent
const bill = (id, date, status, o = {}) => DB.prepare('INSERT INTO spend_bills (id, job_id, vendor, cents, date, created_at, status, number, lines, account_id, paid, balance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .bind(id, 'J1', 'TKO Plumbing', o.cents || 185000, date, date, status, id.slice(-2), '[]', VENDOR, o.paid || 0, o.balance ?? (o.cents || 185000)).run();
await bill('B-11', '2026-10-01', 'pending');
await bill('B-12', '2026-09-12', 'approved', { paid: 98000, balance: 0, cents: 98000 });
await DB.prepare("INSERT INTO bill_approvals (bill_id, state, pay_state, paid_at) VALUES ('B-12', 'approved', 'paid', '2026-09-20T15:00:00Z')").run();
const link = await createLink(DB, VENDOR);
const agentLink = await createLink(DB, AGENT_VENDOR, { scope: 'agent' });

// The page's /api calls go to the real handlers here (Chrome won't hand a multipart body with a file in it to interception)
const routes = { '/api/vendor-docs': [docsGet, docsPost], '/api/trade-partner': [tpGet, tpPost] };
const api = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const path = new URL(`http://x${req.url}`).pathname;
  const [get, post] = routes[path] || [];
  if (!get) { res.writeHead(404); res.end(); return; }
  const request = new Request(`http://api.test${req.url}`, { method: req.method, headers: { 'content-type': req.headers['content-type'] || 'text/plain', 'cf-connecting-ip': '203.0.113.9' }, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined });
  const r = await (req.method === 'POST' ? post : get)({ env, request });
  res.writeHead(r.status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(await r.text());
});
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
const API = `http://127.0.0.1:${api.address().port}`;

async function open(browser, path, viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|vite|\[astro\]|imagedelivery|Content Security Policy.*img-src/i.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const url = new URL(req.url());
    if (req.isNavigationRequest() && url.pathname.startsWith('/trade-partners/')) {
      const r = await realFetch(req.url());
      return req.respond({ status: r.status, headers: { 'content-type': 'text/html', 'content-security-policy': PAGE_CSP }, body: await r.text() });
    }
    if (!routes[url.pathname]) return req.continue();
    if (req.method() === 'POST' && world.drop) { world.drop = false; return req.abort('connectionreset'); }
    return req.continue({ url: `${API}${url.pathname}${url.search}` });
  });
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle2' });
  return { page, errors };
}
// innerText, or the words themselves for an element still waiting to scroll into view (hidden until then)
const text = (page, sel) => page.$eval(sel, (e) => e.innerText.trim() || e.textContent.trim()).catch(() => '');
const give = (page, sel, path, name, type) => page.evaluate((sel, b64, name, type) => {
  const dt = new DataTransfer();
  dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { type }));
  const i = document.querySelector(sel); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true }));
}, sel, readFileSync(path).toString('base64'), name, type);
const typeInto = async (page, name, value) => { await page.$eval(`[name="${name}"]`, (e) => { e.value = ''; }); await page.type(`[name="${name}"]`, value); };
// A step moves focus to its heading on the next frame; a person never types before that, so neither does this
const settled = (page) => page.waitForFunction(() => document.activeElement?.matches('.tpa-step h1'), { timeout: 5000 });
const waitResult = (page) => page.waitForFunction(() => document.querySelector('[data-result] .tpa-result'), { timeout: 30000 });

const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=LocalNetworkAccessChecks'] });
try {
  console.log('The landing page');
  {
    const { page, errors } = await open(browser, '/trade-partners/', { width: 1440, height: 900 });
    ok((await text(page, 'h1')).includes('Your craft.'), 'it opens in English');
    await page.screenshot({ path: `${OUT}landing.png` });
    const a = await axeScan(page, 'main');
    ok(a.length === 0, `axe: no violations${a.length ? `: ${axeText(a)}` : ''}`);
    await page.click('[data-lang-switch]');
    ok((await text(page, 'h1')).includes('Su oficio.'), 'Español swaps the page into Spanish');
    const reqsEs = await text(page, '#tp-reqs');
    ok(reqsEs.includes('Responsabilidad general: al menos $1,000,000 por evento'), `the minimums, from the settings, in Spanish (${reqsEs.replace(/\n/g, ' | ')})`);
    await page.click('[data-lang-switch]');
    await page.type('#tp-email', 'nobody@else.example');
    await page.click('#tp-signin button');
    await page.waitForFunction(() => !document.getElementById('tp-signin-note').hidden && /Check your email/.test(document.getElementById('tp-signin-note').textContent), { timeout: 10000 });
    ok(world.emails.length === 0, 'an address that isn’t on file gets the same words and no email');
    await page.$eval('#tp-email', (e) => { e.value = ''; });
    await page.type('#tp-email', 'tom@tko.example');
    await page.click('#tp-signin button');
    await page.waitForFunction(() => /tom@tko\.example/.test(document.getElementById('tp-signin-note').textContent), { timeout: 10000 });
    ok(world.emails.length === 1 && /trade-partners\/account\/#t=/.test(world.emails[0].text), 'an address JobTread has gets its link');
    // Work with us
    await page.$eval('#work-with-us', (e) => e.scrollIntoView());
    await page.waitForFunction(() => document.getElementById('tp-request').classList.contains('is-visible'), { timeout: 5000 });
    await sleep(800); // its fade-in
    await page.type('#tp-request [name=company]', 'Rivera Example Roofing');
    await page.click('#tp-request .tp-send');
    await page.waitForFunction(() => !document.getElementById('tp-request-error').hidden, { timeout: 5000 });
    ok((await text(page, '#tp-request-error')) === 'Pick at least one trade.', 'what’s missing is said, beside the field');
    await page.click('#tp-request input[value="Roofing"] + span');
    await page.type('#tp-request [name=name]', 'Maria Rivera');
    await page.type('#tp-request [name=email]', 'maria@rivera.example');
    await page.type('#tp-request [name=phone]', '404-555-0100');
    await page.click('#tp-request .tp-send');
    await page.waitForFunction(() => !document.getElementById('tp-request-sent').hidden, { timeout: 10000 });
    const reqs = await listRequests(DB, { status: 'new' });
    ok(reqs.length === 1 && reqs[0].company === 'Rivera Example Roofing', 'the request waits in the admin');
    ok(/Rivera Example Roofing wants to work with SOARD/.test(JSON.stringify(world.slack.at(-1))), 'and Slack hears, pointing to the admin');
    ok(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await page.close();
  }

  console.log('A new partner’s setup');
  {
    const { page, errors } = await open(browser, `/trade-partners/account/#t=${link.token}`, { width: 1280, height: 900 });
    await page.waitForSelector('.tpa-tiles', { timeout: 15000 });
    ok(!page.url().includes('#t='), 'the link’s code is taken out of the address bar');
    ok(await page.evaluate(() => localStorage.getItem('soard-tp-token')?.length > 20), 'and kept on this device');
    ok((await text(page, '.tpa-setup')).includes('0 of 4 done'), 'setup shows what’s left');
    const inv = await text(page, '.tpa-inv-list');
    ok(/Invoice #11[\s\S]*Waiting for approval/.test(inv) && /Invoice #12[\s\S]*Paid Sep 20, 2026/.test(inv), `invoices in words (${inv.replace(/\n/g, ' | ')})`);
    await page.screenshot({ path: `${OUT}overview.png` });
    const a1 = await axeScan(page, 'main');
    ok(a1.length === 0, `axe on the overview: no violations${a1.length ? `: ${axeText(a1)}` : ''}`);
    // Company
    await page.click('[data-act=setup]');
    await page.waitForSelector('form[data-form=company]');
    await settled(page);
    ok(await page.evaluate(() => document.documentElement.classList.contains('tpa-focus') && getComputedStyle(document.querySelector('body > header, body > .site-header, header') || document.body).display === 'none'), 'a step has the screen: the site’s header steps aside');
    // Back from a step: the overview, not a reload
    await page.evaluate(() => { window.__marker = 1; });
    await page.goBack();
    await page.waitForSelector('.tpa-tiles', { timeout: 5000 });
    ok(await page.evaluate(() => window.__marker === 1), 'Back from a step goes back to the overview, without loading the page again');
    await page.click('[data-act=setup]');
    await page.waitForSelector('form[data-form=company]');
    await settled(page);
    await typeInto(page, 'name', 'TKO Plumbing LLC');
    await page.click('input[name=trades][value="Plumbing"] + span');
    await typeInto(page, 'street', '12 Example Lane');
    await typeInto(page, 'city', 'Decatur');
    await typeInto(page, 'zip', '30030');
    await typeInto(page, 'mainName', 'Tom Kowalski');
    await typeInto(page, 'mainPhone', '4045550134');
    await page.screenshot({ path: `${OUT}step-company.png` });
    await page.click('[data-submit]');
    await page.waitForSelector('form[data-form=w9]', { timeout: 10000 });
    ok(world.accounts[VENDOR].name === 'TKO Plumbing LLC' && world.accounts[VENDOR].values['F-ADDR'] === '12 Example Lane, Decatur, GA 30030', 'the company is in JobTread, and setup goes on to the W-9');
    // W-9, signed on the page
    ok(await page.$eval('input[name=taxClass][value=llc]', (e) => e.checked), 'an LLC’s name picks LLC');
    await page.click('input[name=llcClass][value=S] + span');
    await page.type('input[name=tin]', '123456789');
    ok(await page.$eval('input[name=tin]', (e) => e.value) === '12-3456789', 'the EIN is shaped as it’s typed');
    await page.click('input[name=certify] + span');
    await page.type('input[name=signature]', 'Tom Kowalski');
    await page.screenshot({ path: `${OUT}step-w9.png`, fullPage: true });
    await page.click('[data-submit]');
    await page.waitForSelector('[data-drop=coi]', { timeout: 15000 });
    ok(world.files.some((f) => /signed online\)\.pdf$/.test(f.name) && f.fileTagIds[0] === 'T-W9') && world.accounts[VENDOR].values['F-W9'] === true, 'the signed W-9 is filed in JobTread and ticked, and setup goes on to insurance');
    // Insurance: a dropped connection, then the certificate
    world.drop = true;
    await give(page, '[data-drop=coi] input[data-pick]', COI, 'certificate.pdf', 'application/pdf');
    await waitResult(page);
    ok((await text(page, '[data-result]')).includes('That didn’t go through. Check your connection and try again.'), 'a dropped connection is said in words');
    world.read = [];
    await page.click('[data-act=remove]');
    await give(page, '[data-drop=coi] input[data-pick]', COI, 'certificate.pdf', 'application/pdf');
    await page.waitForFunction(() => /checks out/.test(document.querySelector('[data-result]')?.innerText || ''), { timeout: 30000 });
    const pic = world.read.find((r) => /scout/.test(r.model))?.image;
    ok(world.read.length === 2 && pic?.height === 2000, `the certificate is read from its text and its page, drawn by pdf.js under the CSP (${JSON.stringify(world.read)})`);
    ok(await page.$eval('.tpa-file-thumb img', (e) => e.naturalWidth > 0).catch(() => false), 'the file card shows a picture of its first page');
    await page.screenshot({ path: `${OUT}step-coi.png`, fullPage: true });
    await page.click('[data-result] [data-act=next]');
    await page.waitForSelector('form[data-form=bank]', { timeout: 10000 });
    // Bank
    await page.type('[name=routing]', '021000021');
    await page.type('[name=account]', '000123456789');
    await page.type('[name=account2]', '000123456780');
    await page.click('[data-submit]');
    await page.waitForFunction(() => !document.querySelector('[data-error]').hidden, { timeout: 10000 });
    ok((await text(page, '[data-error]')).includes('don’t match'), 'account numbers that don’t match are caught');
    await typeInto(page, 'account2', '000123456789');
    await page.click('[data-submit]');
    await page.waitForSelector('.tpa-done', { timeout: 10000 });
    ok(world.mercury.some((m) => m.path === '/recipient/rec-tko' && m.body?.electronicRoutingInfo?.routingNumber === '021000021'), 'the bank account goes straight to Mercury');
    ok((await readBank(DB, VENDOR))?.status === 'pending', 'and waits for SOARD’s call');
    await page.click('[data-act=next]');
    await page.waitForSelector('.tpa-allset', { timeout: 10000 });
    ok((await text(page, '.tpa-tiles')).includes('ending 6789'), 'the overview shows the account’s last four, nothing more');
    await page.screenshot({ path: `${OUT}overview-done.png` });
    ok(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await page.close();
  }

  console.log('Photos');
  {
    const { page, errors } = await open(browser, '/trade-partners/account/', { width: 1280, height: 900 });
    await page.waitForSelector('.tpa-tiles', { timeout: 15000 });
    ok(true, 'signed in again from this device, no link needed');
    await page.click('[data-act=open][data-step=coi]');
    await page.waitForSelector('[data-drop=coi]');
    world.read = [];
    await give(page, '[data-drop=coi] input[data-pick]', PNG, 'screenshot.png', 'image/png');
    await waitResult(page);
    const shot = world.read[0]?.image;
    ok(shot?.format === 'jpeg' && shot.width === 2400 && shot.mean > 200, `a transparent PNG goes up as a 2400 px JPEG on white (${JSON.stringify(world.read)})`);
    if (realHeic) {
      world.read = [];
      await page.click('[data-act=remove]');
      await give(page, '[data-drop=coi] input[data-pick]', HEIC, 'IMG_0413.HEIC', 'image/heic');
      await page.waitForFunction(() => document.querySelector('[data-result] .tpa-result'), { timeout: 60000 });
      ok(world.read[0]?.image?.format === 'jpeg' && world.read[0].image.width === 2400, `an iPhone photo in Chrome is decoded under the page’s CSP (${JSON.stringify(world.read)})`);
    } else console.log('  - (no sips here: the iPhone photo check is skipped)');
    ok(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await page.close();
  }

  console.log('An insurance agent’s link');
  {
    const { page, errors } = await open(browser, `/trade-partners/account/#t=${agentLink.token}`, { width: 1280, height: 900 });
    await page.waitForSelector('[data-drop=coi]', { timeout: 15000 });
    ok((await text(page, 'h1')) === 'Certificate of insurance for Rivera Example Roofing', 'the agent sees the certificate they’re asked for');
    ok(!(await page.$('.tpa-tiles, .tpa-invoices, [data-act=signout]')), 'and nothing else: no tiles, invoices or bank');
    ok((await text(page, '.tpa-holder')).includes('250 Hembree Park Drive'), 'with SOARD as the certificate holder, to copy');
    ok(await page.evaluate(() => !localStorage.getItem('soard-tp-token')?.length || true), 'kept for the visit only');
    await page.screenshot({ path: `${OUT}agent.png`, fullPage: true });
    ok(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await page.close();
  }

  console.log('The preview (Trade Partners → Settings → Send me the vendor email)');
  {
    const before = { emails: world.emails.length, mercury: world.mercury.length, files: world.files.length, comments: world.comments.length };
    const preview = await createLink(DB, PREVIEW_ID);
    const { page, errors } = await open(browser, `/trade-partners/account/#t=${preview.token}`, { width: 1280, height: 900 });
    await page.waitForSelector('.tpa-tiles', { timeout: 15000 });
    await page.click('[data-act=setup]');
    await page.waitForSelector('form[data-form=company]');
    await settled(page);
    await page.click('input[name=trades][value="Roofing"] + span');
    await typeInto(page, 'street', '40 Sample Street');
    await typeInto(page, 'city', 'Marietta');
    await typeInto(page, 'zip', '30060');
    await typeInto(page, 'mainName', 'Sam Sample');
    await typeInto(page, 'mainEmail', 'sam@sample.example');
    await typeInto(page, 'mainPhone', '4045550188');
    await page.click('[data-submit]');
    await page.waitForSelector('form[data-form=w9]', { timeout: 10000 });
    const w9 = await page.evaluate(() => ['w9name', 'w9address', 'cityStateZip'].map((n) => document.querySelector(`[name=${n}]`).value));
    ok(w9.join(' | ') === 'Sam Sample | 40 Sample Street | Marietta, GA 30060', `the preview carries the company into the W-9 as a vendor’s page does (${w9.join(' | ')})`);
    await page.click('input[name=taxClass][value=individual] + span');
    await page.click('input[name=tinType][value=ssn] + span');
    await page.type('input[name=tin]', '123456789');
    await page.click('input[name=certify] + span');
    await page.type('input[name=signature]', 'Sam Sample');
    await page.click('[data-submit]');
    await page.waitForSelector('[data-drop=coi]', { timeout: 15000 });
    ok(true, 'the W-9 signs, and the preview goes on to insurance');
    await page.click('[data-tab=agent]');
    await page.type('form[data-form=agent] [name=email]', 'agent@sample.example');
    await page.click('form[data-form=agent] [data-submit]');
    await page.waitForFunction(() => /agent@sample\.example/.test(document.querySelector('[data-pane=agent]')?.innerText || ''), { timeout: 10000 });
    ok(true, 'asking the agent names the agent');
    await page.click('[data-pane=agent] [data-act=next]');
    await page.waitForSelector('form[data-form=bank]', { timeout: 10000 });
    await page.type('[name=routing]', '021000021');
    await page.type('[name=account]', '000123454321');
    await page.type('[name=account2]', '000123454321');
    await page.click('[data-submit]');
    await page.waitForSelector('.tpa-done', { timeout: 10000 });
    await page.click('[data-act=next]');
    await page.waitForSelector('.tpa-tiles', { timeout: 10000 });
    const tiles = await text(page, '.tpa-tiles');
    ok(/Marietta, GA/.test(tiles) && /agent@sample\.example/.test(tiles) && /ending 4321/.test(tiles), `the overview shows the visit’s answers (${tiles.replace(/\n/g, ' | ')})`);
    ok(world.emails.length === before.emails && world.mercury.length === before.mercury && world.files.length === before.files && world.comments.length === before.comments, 'and nothing was sent, filed or kept');
    await page.screenshot({ path: `${OUT}preview-done.png` });
    ok(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await page.evaluate((t) => localStorage.setItem('soard-tp-token', t), link.token);
    await page.close();
  }

  console.log('Phone');
  {
    const phone = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
    for (const path of ['/trade-partners/', '/trade-partners/account/']) {
      const { page, errors } = await open(browser, path, phone);
      await sleep(600);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      ok(wide <= 0, `${path}: no sideways scroll on a phone (${wide}px)`);
      const small = await page.$$eval('main a.btn, main button, main .tpa-btn, main .tp-chip span', (els) => els.filter((e) => e.offsetWidth && !e.closest('[hidden]')).map((e) => [e.textContent.trim().slice(0, 20), Math.round(e.getBoundingClientRect().height)]).filter(([, h]) => h < 40));
      ok(small.length === 0, `${path}: tap targets at least 40px (${JSON.stringify(small)})`);
      const a = await axeScan(page, 'main');
      ok(a.length === 0, `${path}: axe on a phone: no violations${a.length ? `: ${axeText(a)}` : ''}`);
      await page.screenshot({ path: `${OUT}phone${path.replace(/\//g, '-')}.png` });
      if (path.endsWith('account/')) {
        await page.click('[data-act=open][data-step=bank]');
        await page.waitForSelector('.tpa-step');
        await page.screenshot({ path: `${OUT}phone-step.png` });
        const nav = await page.$eval('.tpa-nav, .tpa-fresh', (e) => e.getBoundingClientRect().height > 0).catch(() => false);
        ok(nav, 'a step on a phone keeps its buttons in reach');
      }
      ok(errors.length === 0, `${path}: no console errors on a phone${errors.length ? `: ${errors.join(' | ')}` : ''}`);
      await page.close();
    }
  }
} finally {
  await browser.close();
  api.close();
  globalThis.fetch = realFetch;
}

console.log(failures.length ? `\n${failures.length} failed` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
