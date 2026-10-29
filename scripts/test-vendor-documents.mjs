/**
 * test-vendor-documents.mjs — a vendor's W-9 and insurance page, in a browser
 * ===========================================================================
 * /vendor-documents/#t=<token> on an Astro dev server, with its /api calls
 * answered by the REAL handler (functions/api/vendor-docs.js → _vendors.js)
 * over an in-memory D1, a pretend JobTread and a pretend Workers AI:
 *   - what's needed and why, both documents marked Needed, the minimums
 *   - a dropped connection: said in words, not the browser's "Failed to fetch"
 *   - a good certificate: its text and its first page, drawn by pdf.js under
 *     the page's CSP as a 2000 px JPEG, both read; filed in JobTread, On file
 *   - a W-9 that falls short: read from its drawn page alone; why, and "send
 *     it to our team" that files it for a person
 *   - a good W-9 after that: "You're all set"
 *   - an iPhone photo (HEIC) that won't open: what to send instead, nothing
 *     sent; a real one (made with macOS sips, 3000 px) is decoded by
 *     heic-to.js under the page's own CSP from public/_headers and goes up as
 *     a 2400 px JPEG for the vision model (Safari decodes HEIC itself)
 *   - a transparent 3000 px PNG goes up as a 2400 px JPEG on white, not black
 *   - a link that has expired; the phone (no sideways scroll, 44px targets);
 *     axe; no console errors
 * Screenshots land in test-results/vendor-documents/.
 *
 *   npx astro dev --port 4391 &   (any free port)
 *   BASE=http://127.0.0.1:4391 node scripts/test-vendor-documents.mjs
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { join } from 'node:path';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import { onRequestGet, onRequestPost } from '../functions/api/vendor-docs.js';
import { createLink, ensureVendorSchema, jtSetup } from '../functions/api/_vendors.js';
import { ensureSpendSchema } from '../functions/api/_spend.js';
import { ensureBillPaySchema } from '../functions/api/_bill-pay.js';
import { axeScan, axeText } from './lib/axe.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/vendor-documents/');
mkdirSync(OUT, { recursive: true });
const BASE = (process.env.BASE || 'http://127.0.0.1:4391').replace(/\/$/, '');
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VENDOR = 'ACC-TKO';

// A certificate and a W-9 to pick: real letter-size PDFs in pdf-lib's Helvetica, a font they name
// without embedding (so pdf.js fetches it from the page's own standard_fonts/). Their words come from the pretend AI.
async function letterPdf(path, lines) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  lines.forEach((l, i) => page.drawText(l, { x: 54, y: 720 - i * 24, size: 14, font }));
  writeFileSync(path, await doc.save());
}
const PDF = join(OUT, 'certificate.pdf');
await letterPdf(PDF, ['ACORD 25 CERTIFICATE OF LIABILITY INSURANCE', '(a test file)']);
const W9 = join(OUT, 'w9.pdf');
await letterPdf(W9, ['Form W-9 Request for Taxpayer Identification Number', '(a test file)']);
const HEIC = join(OUT, 'IMG_0412.HEIC');
writeFileSync(HEIC, Buffer.concat([Buffer.from([0, 0, 0, 0x24]), Buffer.from('ftypheicmif1MiPr'), Buffer.alloc(64)]));
// A real iPhone-style photo of a W-9, 3000 px across (macOS can write HEIC; elsewhere the W-9 PDF stands in)
const W9_PHOTO = join(OUT, 'IMG_0413.HEIC');
const realHeic = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 245, g: 244, b: 238 } } }).png().toFile(join(OUT, 'w9-photo.png'))
  .then(() => { execFileSync('sips', ['-s', 'format', 'heic', join(OUT, 'w9-photo.png'), '--out', W9_PHOTO], { stdio: 'ignore' }); return true; })
  .catch(() => false);
// A screenshot of a certificate with a see-through background, 3000 px across
const PNG = join(OUT, 'certificate-screenshot.png');
await sharp({ create: { width: 3000, height: 2000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: { create: { width: 1200, height: 200, channels: 4, background: { r: 20, g: 20, b: 20, alpha: 1 } } }, top: 300, left: 300 }]).png().toFile(PNG);
// The page's own CSP, as Cloudflare serves it (astro dev doesn't read _headers)
const VENDOR_CSP = readFileSync(join(ROOT, 'public/_headers'), 'utf8').split('\n/vendor-documents/*\n')[1].split('\n')
  .find((l) => l.startsWith('  Content-Security-Policy: ')).replace('  Content-Security-Policy: ', '')
  // what only the dev server needs: its reloading sockets, and the live site's images (same-origin in production)
  .replace("connect-src 'self'", `connect-src 'self' ${BASE.replace('http', 'ws')} ws://127.0.0.1:5173`)
  .replace("img-src 'self'", "img-src 'self' https://sunshineonaranneyday.com");

// ─── A pretend JobTread and Workers AI (the handler runs here, in Node) ─
const world = { values: {}, fields: [{ id: 'F-W9', name: 'W-9', type: 'boolean' }], tags: [], files: [], comments: [], ai: null, posts: 0, read: [], drop: false };
const fid = (name) => world.fields.find((f) => f.name === name)?.id;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.host === 'uploads.jobtread.example') return new Response('', { status: 200 });
  if (url.host === 'api.jobtread.com') {
    const { query } = JSON.parse(init.body);
    if (query.organization?.customFields) return Response.json({ organization: { customFields: { nodes: world.fields }, fileTags: { nodes: world.tags } } });
    if (query.createCustomField) { const f = { id: `F-${query.createCustomField.$.name}`, ...query.createCustomField.$ }; world.fields.push(f); return Response.json({ createCustomField: { createdCustomField: { id: f.id } } }); }
    if (query.createFileTag) { const t = { id: `T-${query.createFileTag.$.name}`, name: query.createFileTag.$.name }; world.tags.push(t); return Response.json({ createFileTag: { createdFileTag: { id: t.id } } }); }
    if (query.account) {
      const email = { nodes: [{ value: 'office@tko.example' }] };
      return Response.json({ account: { id: VENDOR, name: 'TKO Plumbing', archivedAt: null, customFieldValues: { nodes: Object.entries(world.values).map(([id, value]) => ({ value, customField: { id } })) }, primaryContact: { customFieldValues: email }, contacts: { nodes: [] } } });
    }
    if (query.updateAccount) { Object.assign(world.values, query.updateAccount.$.customFieldValues); return Response.json({}); }
    if (query.createComment) { world.comments.push(query.createComment.$); return Response.json({ createComment: { createdComment: { id: 'C1' } } }); }
    if (query.createUploadRequest) return Response.json({ createUploadRequest: { createdUploadRequest: { id: 'U1', url: 'https://uploads.jobtread.example/put', method: 'PUT', headers: {} } } });
    if (query.createFile) { world.files.push(query.createFile.$); return Response.json({ createFile: { createdFile: { id: 'F1' } } }); }
    throw new Error(`JobTread doesn't know ${Object.keys(query)}`);
  }
  if (url.host === 'slack.com') return Response.json({ ok: true, channel: 'C1', ts: '1.1' });
  return realFetch(input, init);
};

const DB = await createD1({ schemaSql: ['CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)'] });
const env = {
  DB, JOBTREAD_GRANT_KEY: 'jt',
  AI: {
    toMarkdown: async () => ({ format: 'text', data: 'The document text, long enough to read. '.repeat(5) }),
    run: async (model, { messages }) => {
      const url = [messages.at(-1).content].flat().find((c) => c?.image_url)?.image_url.url;
      const img = url ? Buffer.from(url.split(',')[1], 'base64') : null;
      const meta = img ? await sharp(img).metadata() : null;
      const mean = img ? Math.round((await sharp(img).stats()).channels[0].mean) : null;
      world.read.push({ model, image: meta && { format: meta.format, width: meta.width, height: meta.height, mean } });
      return { response: world.ai };
    },
  },
};
await ensureSpendSchema(DB);
await ensureBillPaySchema(DB);
await ensureVendorSchema(DB);
await jtSetup(env);
world.values[fid('Liability Expires')] = '2026-09-30';
const link = await createLink(DB, VENDOR);
const old = await createLink(DB, VENDOR, { now: Date.now() - 40 * 86400e3 });

// The page's /api calls go to the real handler here (Chrome won't hand over a
// multipart body with a file in it to request interception)
const api = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://api.test${req.url}`, {
    method: req.method, headers: { 'content-type': req.headers['content-type'] || 'text/plain' }, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
  });
  if (req.method === 'POST') world.posts++;
  const r = await (req.method === 'POST' ? onRequestPost : onRequestGet)({ env, request });
  res.writeHead(r.status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(await r.text());
});
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
const API = `http://127.0.0.1:${api.address().port}`;

async function open(browser, viewport, token = link.token) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|vite|\[astro\]/i.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const url = new URL(req.url());
    if (req.isNavigationRequest() && url.pathname.startsWith('/vendor-documents/')) {
      const r = await realFetch(req.url());
      return req.respond({ status: r.status, headers: { 'content-type': 'text/html', 'content-security-policy': VENDOR_CSP }, body: await r.text() });
    }
    if (url.pathname !== '/api/vendor-docs') return req.continue();
    if (req.method() === 'POST' && world.drop) { world.drop = false; return req.abort('connectionreset'); }
    return req.continue({ url: `${API}${url.pathname}${url.search}` });
  });
  await page.goto(`${BASE}/vendor-documents/#t=${token}`, { waitUntil: 'networkidle2' });
  return { page, errors };
}

const text = (page, sel) => page.$eval(sel, (e) => e.innerText).catch(() => '');
const visible = (page, sel) => page.$eval(sel, (e) => !!(e.offsetWidth || e.offsetHeight) && !e.closest('[hidden]')).catch(() => false);

// The page is handed over by interception (to add its CSP), so Chrome would count it as public and block its calls to this machine
const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=LocalNetworkAccessChecks'] });
try {
  console.log('Desktop');
  const { page, errors } = await open(browser, { width: 1440, height: 1000 });
  await page.waitForSelector('#vd-main:not([hidden])', { timeout: 15000 });
  ok((await text(page, '#vd-lead')).startsWith('For TKO Plumbing.'), 'the page is for the vendor the link was made for');
  const needs = await text(page, '#vd-items');
  ok(needs.includes('A W-9: we don’t have one for you yet.') && needs.includes('the one we have ended September 30, 2026'), `what’s needed and why (${needs.replace(/\n/g, ' | ')})`);
  ok(await text(page, '#vd-doc-coi [data-role="tag"]') === 'Needed' && await text(page, '#vd-doc-w9 [data-role="tag"]') === 'Needed', 'both documents are marked Needed');
  ok((await text(page, '#vd-reqs')).includes('at least $1,000,000 each occurrence and $2,000,000 aggregate'), 'the certificate’s minimums are listed');
  await page.screenshot({ path: `${OUT}desktop.png`, fullPage: false });
  const a1 = await axeScan(page, 'main');
  ok(a1.length === 0, `axe: no violations${a1.length ? `: ${axeText(a1)}` : ''}`);

  // An iPhone photo that won't open, even with libheif
  await (await page.$('#vd-doc-coi input[type="file"]')).uploadFile(HEIC);
  await page.waitForFunction(() => document.querySelector('#vd-doc-coi [data-role="result"]')?.dataset.tone === 'fix', { timeout: 30000 });
  ok((await text(page, '#vd-doc-coi [data-role="result"]')).includes('IMG_0412.HEIC is an iPhone photo (HEIC) that wouldn’t open. Send a PDF or a JPG instead.') && world.posts === 0,
    'an iPhone photo that won’t open says what to send instead, and nothing is sent');
  await page.screenshot({ path: `${OUT}heic.png`, fullPage: false });

  // A good certificate
  world.ai = {
    isCertificate: true, readable: true, insured: 'TKO Plumbing LLC', certificateHolder: 'Sunshine on a Ranney Day',
    policies: [
      { kind: 'general liability', insurer: 'Hartford', expires: '2027-03-01', eachOccurrence: 1000000, aggregate: 2000000 },
      { kind: 'workers compensation', insurer: 'Travelers', expires: '2027-03-01', employersLiabilityEachAccident: 500000 },
    ],
  };
  // The connection drops on the way
  world.drop = true;
  await (await page.$('#vd-doc-coi input[type="file"]')).uploadFile(PDF);
  await page.waitForFunction(() => /connection/.test(document.querySelector('#vd-doc-coi [data-role="result"]')?.innerText || ''), { timeout: 30000 });
  ok(await text(page, '#vd-doc-coi [data-role="result"]') === 'That didn’t go through. Check your connection and try again.', 'a dropped connection is said in words, not “Failed to fetch”');
  world.read = [];
  await (await page.$('#vd-doc-coi input[type="file"]')).uploadFile(PDF);
  await page.waitForFunction(() => document.querySelector('#vd-doc-coi [data-role="result"]')?.dataset.tone === 'good', { timeout: 30000 });
  const drawn = world.read.find((r) => /scout/.test(r.model))?.image;
  ok(world.read.length === 2 && world.read.some((r) => !/scout/.test(r.model)) && drawn?.format === 'jpeg' && drawn.height === 2000 && drawn.width === 1545,
    `the certificate is read from its text and from its first page, drawn by pdf.js under the page’s CSP (${JSON.stringify(world.read)})`);
  const coiResult = await text(page, '#vd-doc-coi [data-role="result"]');
  ok(coiResult.includes('Got it, and it checks out.') && coiResult.includes('General liability $1,000,000 each occurrence'), `a good certificate is accepted on the spot (${coiResult.replace(/\n/g, ' | ')})`);
  ok(world.files.length === 1 && world.files[0].folder === 'W-9 & Insurance', 'it’s filed on the vendor in JobTread');
  ok(world.values[fid('Liability Expires')] === '2027-03-01', 'Liability Expires is filled in JobTread');
  ok(await text(page, '#vd-doc-coi [data-role="tag"]') === 'On file' && await visible(page, '#vd-doc-coi [data-role="again"]'), 'the certificate shows On file, with a way to send a newer one');
  ok(!(await text(page, '#vd-items')).includes('general liability'), 'what’s needed now lists only the W-9');

  // A W-9 without a tax ID: why, then sent to the team anyway
  world.ai = { isW9: true, readable: true, name: 'TKO Plumbing LLC', hasTaxId: false, signed: true };
  world.read = [];
  await (await page.$('#vd-doc-w9 input[type="file"]')).uploadFile(W9);
  await page.waitForFunction(() => document.querySelector('#vd-doc-w9 [data-role="result"]')?.dataset.tone === 'fix', { timeout: 30000 });
  ok(world.read.length === 1 && /scout/.test(world.read[0].model) && world.read[0].image?.format === 'jpeg', `a W-9 is read from its drawn page alone (${JSON.stringify(world.read)})`);
  ok((await text(page, '#vd-doc-w9 [data-role="result"]')).includes('doesn’t show a tax ID'), 'a W-9 that falls short says why');
  ok(world.files.length === 1, 'and isn’t filed');
  const anyway = await page.$eval('#vd-doc-w9 .vd-anyway', (b) => b.getBoundingClientRect().height);
  ok(anyway >= 44, `“Send it to our team” is a 44px target (${anyway}px)`);
  ok(await page.$eval('#vd-doc-w9 [data-role="result"] li', (li) => getComputedStyle(li).display === 'list-item' && getComputedStyle(li.parentElement).listStyleType === 'disc'), 'the reasons are a bulleted list');
  await page.screenshot({ path: `${OUT}w9-fix.png`, fullPage: false });
  await page.click('#vd-doc-w9 .vd-anyway');
  await page.waitForFunction(() => document.querySelector('#vd-doc-w9 [data-role="result"]')?.innerText.includes('Our team will look at it'), { timeout: 15000 });
  ok(world.files.length === 2 && world.values[fid('Documents')] === 'Needs a look', '“Send it to our team” files it in JobTread as Needs a look');

  // A good W-9, as an iPhone photo: all set
  world.ai = { isW9: true, readable: true, name: 'TKO Plumbing LLC', hasTaxId: true, signed: true, signedDate: '2026-10-27' };
  world.read = [];
  await page.click('#vd-doc-w9 [data-role="again"]');
  await (await page.$('#vd-doc-w9 input[type="file"]')).uploadFile(realHeic ? W9_PHOTO : W9);
  await page.waitForFunction(() => !document.querySelector('#vd-done')?.hidden, { timeout: 30000 });
  if (realHeic) {
    ok(world.read.length === 1 && world.read[0].image?.format === 'jpeg' && world.read[0].image.width === 2400 && /scout/.test(world.read[0].model),
      `an iPhone photo in Chrome is decoded under the page’s CSP and read as a 2400 px JPEG (${JSON.stringify(world.read)})`);
    ok(world.files.at(-1).name.endsWith('.jpg'), 'and filed in JobTread as a JPG');
  } else console.log('  - (no sips here: the iPhone photo check is skipped)');
  ok((await text(page, '#vd-done')).includes('You’re all set'), 'with both in, the page says they’re all set');
  ok(world.values['F-W9'] === true && world.values[fid('Documents')] === 'Current', 'JobTread: W-9 ticked, Documents Current');
  await page.screenshot({ path: `${OUT}done.png`, fullPage: false });
  ok(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);

  console.log('An old link');
  const { page: gone } = await open(browser, { width: 1440, height: 900 }, old.token);
  await page.waitForFunction(() => true);
  await gone.waitForFunction(() => document.querySelector('#vd-status')?.textContent.includes('expired'), { timeout: 10000 });
  ok(true, 'a link past 30 days says it has expired');

  console.log('Phone');
  world.values = { [fid('Liability Expires')]: '2026-09-30' };
  const { page: phone, errors: phoneErrors } = await open(browser, { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await phone.waitForSelector('#vd-main:not([hidden])', { timeout: 15000 });
  const wide = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(wide <= 0, `no sideways scroll on a phone (${wide}px)`);
  const small = await phone.$$eval('.vd-pick, .vd-again', (els) => els.filter((e) => e.offsetWidth && !e.closest('[hidden]')).map((e) => e.getBoundingClientRect().height).filter((h) => h < 44));
  ok(small.length === 0, `buttons are at least 44px tall (${small.join(', ') || 'all'})`);
  await phone.screenshot({ path: `${OUT}phone.png`, fullPage: false });
  const a2 = await axeScan(phone, 'main');
  ok(a2.length === 0, `axe on a phone: no violations${a2.length ? `: ${axeText(a2)}` : ''}`);
  // A screenshot with a see-through background: shrunk onto white
  world.ai = { isCertificate: true, readable: true, insured: 'TKO Plumbing LLC', certificateHolder: 'Sunshine on a Ranney Day', policies: [
    { kind: 'general liability', insurer: 'Hartford', expires: '2027-03-01', eachOccurrence: 1000000, aggregate: 2000000 },
    { kind: 'workers compensation', insurer: 'Travelers', expires: '2027-03-01', employersLiabilityEachAccident: 500000 },
  ] };
  world.read = [];
  await (await phone.$('#vd-doc-coi input[type="file"]')).uploadFile(PNG);
  await phone.waitForFunction(() => document.querySelector('#vd-doc-coi [data-role="result"]')?.dataset.tone, { timeout: 30000 });
  const shot = world.read[0]?.image;
  ok(shot?.format === 'jpeg' && shot.width === 2400 && shot.mean > 200, `a transparent PNG goes up as a 2400 px JPEG on white (${JSON.stringify(world.read)})`);
  ok(phoneErrors.length === 0, `no console errors on a phone${phoneErrors.length ? `: ${phoneErrors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
  api.close();
  globalThis.fetch = realFetch;
}

console.log(failures.length ? `\n${failures.length} failed` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
