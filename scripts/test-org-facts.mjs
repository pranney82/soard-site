/**
 * test-org-facts.mjs — SOARD's facts and brand, in a real browser
 * ============================================================================
 * Two sides of one record, with the real handlers on an in-memory D1 seeded from src/content/site (run the
 * prebuild first, read-only):
 *
 *  1. The board page as a board member signs in to it (the real sign-in middleware, an RS256 Access token made
 *     here): Documents → SOARD's facts (each fact and its copy button, Copy all, the tax status from the IRS's
 *     list, the papers forms ask for opening in the viewer, Print alone), SOARD's brand (six official logos,
 *     PNG and an SVG out of the kit, the colors' hex to copy, the fonts), the Documents filter, ⌘K landing on a
 *     fact's copy button; at 1440px and 390px, nothing past the right edge, axe WCAG 2.1 AA, no console errors.
 *     The check behind it is real (_org-facts.js): the IRS's list (SOARD's own published line) and Workers AI
 *     reading the W-9 are faked at the network.
 *  2. Site Config → Organization & contact (staff): what doesn't match, from the real /api/org-facts-admin, each
 *     put right with its button and saved through the real save-content (nothing else in the documents
 *     touched); the mailing address, the mission (moved here from the Media Kit), the vision and values; a
 *     value with no name blocks saving; Check again; the Media Kit's links to its fields' new home.
 * Screenshots in test-results/org-facts/. Exits non-zero on any failure.
 *
 *   node scripts/prebuild.js && node scripts/test-org-facts.mjs
 */
import puppeteer from 'puppeteer';
import http from 'node:http';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import { answerAsks } from './lib/ask.mjs';
import { onRequest as middleware } from '../functions/api/_middleware.js';
import * as boardPortal from '../functions/api/board-portal.js';
import * as boardFile from '../functions/api/board-file.js';
import * as downloadLogo from '../functions/api/download-logo.js';
import * as orgAdmin from '../functions/api/org-facts-admin.js';
import * as readContentApi from '../functions/api/read-content.js';
import * as saveContentApi from '../functions/api/save-content.js';
import { ensureSchema } from '../functions/api/_board.js';
import { checkOrgFacts } from '../functions/api/_org-facts.js';

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/org-facts/');
mkdirSync(OUT, { recursive: true });
const failures = [];
const ok = (cond, msg, more = '') => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}${!cond && more ? `\n      ${more}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function section(name, fn) {
  console.log(name);
  try { await fn(); } catch (e) { failures.push(`${name}: crashed: ${e.message}`); console.error(`  ✗ crashed: ${e.stack || e.message}`); }
}
if (!existsSync(join(ROOT, 'src/content/site/settings.json'))) { console.error('No src/content/site: run node scripts/prebuild.js first'); process.exit(1); }

// ── The world: SOARD's own documents as the site has them, a founder, a board member ──
const FOUNDER = 'jane@soardcharity.com';
const MEMBER = 'alex.board@example.com';
const PEOPLE = {
  'jane-doe': { name: 'Jane Doe', group: 'team', title: 'Co-Founder/President', role: 'founder', status: 'active', order: 1 },
  'alex-rivera': { name: 'Alex Rivera', group: 'board', title: 'Board Chair', organization: 'Rivera Builders', order: 1 },
};
const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
for (const sql of [
  'CREATE TABLE IF NOT EXISTS team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)',
  'CREATE TABLE IF NOT EXISTS reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)',
]) await DB.exec(sql);
for (const [slug, d] of Object.entries(PEOPLE)) await DB.prepare('INSERT OR REPLACE INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.group, JSON.stringify(d)).run();
await DB.prepare('INSERT OR REPLACE INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind('alex-rivera', MEMBER).run();
for (const [slug, d] of Object.entries({ 'maya-2026': { name: 'Maya', year: 2026, childCount: 1, roomCount: 1 }, 'leo-2026': { name: 'Leo', year: 2026, childCount: 2, roomCount: 2 }, 'zoe-2025': { name: 'Zoe', year: 2025 } })) {
  await DB.prepare('INSERT OR REPLACE INTO kids (slug, name, year, data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.year, JSON.stringify(d)).run();
}
const SITE_DOCS = ['settings', 'faq', 'our-story', 'media', 'financial-snapshot', 'financials'];
const seed = {};
for (const k of SITE_DOCS) {
  seed[k] = JSON.parse(readFileSync(join(ROOT, `src/content/site/${k}.json`), 'utf8'));
  await DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind(k, JSON.stringify(seed[k]), new Date().toISOString()).run();
}
// As the site has it today: no legal name or mailing address yet, the Media Kit's mission
for (const k of ['legalName', 'mailingAddress', 'vision', 'values']) delete seed.settings[k];
seed.settings.application = { ...(seed.settings.application || {}), open: false, openChangedBy: 'peter@soardcharity.com' };
await DB.prepare("UPDATE site_config SET data = ? WHERE key = 'settings'").bind(JSON.stringify(seed.settings)).run();
const stored = async (k) => JSON.parse((await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(k).first()).data);

class FakeR2 {
  constructor() { this.map = new Map(); }
  async put(key, bytes, opts) { this.map.set(key, { bytes: new Uint8Array(bytes), type: opts?.httpMetadata?.contentType }); }
  async get(key) { const o = this.map.get(key); return o ? { body: o.bytes, size: o.bytes.length, httpMetadata: { contentType: o.type } } : null; }
  async delete(key) { this.map.delete(key); }
}
const env = { DB, FILES: new FakeR2(), CF_ACCESS_TEAM_DOMAIN: 'soard', CF_ACCESS_AUD: 'aud-tag' };
// Workers AI reading SOARD's W-9: the IRS's address on it, which the site doesn't have yet (read twice, the same)
env.AI = { run: async () => ({ response: { isW9: true, name: 'Sunshine on a Ranney Day Inc', businessName: '', ein: '45-4773997', street: '10800 Alpharetta Hwy Suite 208-625', cityStateZip: 'Roswell, GA 30076', signedDate: '2026-02-09' } }) };

// SOARD's papers on Board → Documents: the W-9 (a picture), the IRS letter and the Board Manual (PDFs, the manual with its words)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
async function pdf(title) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText(title, { x: 72, y: 700, size: 18, font });
  return Buffer.from(await doc.save());
}
await ensureSchema(DB);
const MANUAL_WORDS = 'MISSION & GOALS MISSION STATEMENT Creating spaces that are fully customizable for children with special needs, each renovation is thoughtfully designed to support the child’s physical, emotional and developmental needs. GOALS AND PURPOSE Raise public awareness.';
for (const [id, title, kind, bytes, type, words] of [
  ['d_w9doc1', 'W-9', 'governance', PNG, 'image/png', ''],
  ['d_irsltr1', 'IRS 501(c)(3) determination letter', 'governance', await pdf('Determination letter'), 'application/pdf', ''],
  ['d_manual1', 'SunShine on a Ranney Day, Inc. Board Manual with Policies', 'policy', await pdf('Board Manual'), 'application/pdf', MANUAL_WORDS],
]) {
  await DB.prepare('INSERT INTO board_docs (id, data, updated_at) VALUES (?, ?, ?)').bind(id, JSON.stringify({ id, title, kind, shared: true }), new Date().toISOString()).run();
  const fid = `f_${id.slice(2)}`;
  await env.FILES.put(`board/docs/${fid}`, bytes, { httpMetadata: { contentType: type } });
  await DB.prepare('INSERT INTO board_files (id, owner_type, owner_id, r2_key, name, type, size, kind, staff_only, at, by, words) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)')
    .bind(fid, 'doc', id, `board/docs/${fid}`, `${title}.${type === 'image/png' ? 'png' : 'pdf'}`, type, bytes.length, 'other', new Date().toISOString(), FOUNDER, words || null).run();
}

// The IRS's list for Georgia: others, and SOARD's own line as the IRS publishes it
const HEADER = 'EIN,NAME,ICO,STREET,CITY,STATE,ZIP,GROUP,SUBSECTION,AFFILIATION,CLASSIFICATION,RULING,DEDUCTIBILITY,FOUNDATION,ACTIVITY,ORGANIZATION,STATUS,TAX_PERIOD,ASSET_CD,INCOME_CD,FILING_REQ_CD,PF_FILING_REQ_CD,ACCT_PD,ASSET_AMT,INCOME_AMT,REVENUE_AMT,NTEE_CD,SORT_NAME';
const SOARD = '454773997,SUNSHINE ON A RANNEY DAY INCORPORATED,% SUNSHINE ON A RANNEY DAY IN,10800 ALPHARETTA HWY SUITE 208 625,ROSWELL,GA,30076-1417,0000,03,3,1000,201207,1,15,000000000,1,01,202512,5,6,01,0,12,947936,2460929,1867189,G19,';
const irs = { gets: 0 };
const irsFetch = async (url, init = {}) => {
  if (!String(url).startsWith('https://www.irs.gov/pub/irs-soi/eo_ga.csv')) throw new Error(`no fake for ${url}`);
  const headers = { 'last-modified': 'Tue, 13 Oct 2026 19:13:29 GMT' };
  if (init.method === 'HEAD') return new Response(null, { headers });
  irs.gets++;
  return new Response([HEADER, '580188650,"CHAMBER OF COMMERCE OF GREATER AUGUSTA GEORGIA,INC",,1 10TH ST STE 120,AUGUSTA,GA,30901-0101,0000,06,3,3000,197311,2,00,200000000,1,01,202512,6,6,01,0,12,0,0,0,,', SOARD, ''].join('\r\n'), { headers });
};
// The check itself, as the heartbeat runs it
const first = await checkOrgFacts(env, { fetchImpl: irsFetch, slack: false });
// Site Config's Check again runs in this process: the IRS's address answers from the fake, everything else goes on
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => (String(typeof input === 'string' ? input : input.url).startsWith('https://www.irs.gov/') ? irsFetch(String(input.url || input), init) : realFetch(input, init));

section('The check behind it', async () => {
  ok(first.irs.found && first.irs.date === 'October 13, 2026', `the IRS’s list read (${first.irs.date})`);
  ok(first.w9?.read?.isW9 && first.w9.read.ein === '454773997', 'SOARD’s W-9 read');
  ok(/^Creating spaces/.test(first.manual?.mission || ''), 'the Board Manual’s mission found in its words');
  ok(['legal-name', 'mailing', 'w9-address'].every((k) => first.problems.some((p) => p.key === k)), `what doesn’t match today: ${first.problems.map((p) => p.key).join(', ')}`);
});

// ── Sign-in: Access tokens made here, as test-board.mjs does ──
const certsKey = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', certsKey.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
async function tokenFor(email) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ iss: 'https://soard.cloudflareaccess.com', aud: ['aud-tag'], email, iat: now, nbf: now, exp: now + 3600 }));
  return `${h}.${p}.${b64u(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', certsKey.privateKey, new TextEncoder().encode(`${h}.${p}`))))}`;
}
const withCerts = globalThis.fetch;
globalThis.fetch = (input, init) => (String(typeof input === 'string' ? input : input?.url) === 'https://soard.cloudflareaccess.com/cdn-cgi/access/certs' ? Promise.resolve(Response.json({ keys: [jwk] })) : withCerts(input, init));

// ── The server: public/ with the admin's real CSP, /api/* through the real middleware ──
const ROUTES = { '/api/board-portal': boardPortal, '/api/board-file': boardFile, '/api/download-logo': downloadLogo, '/api/org-facts-admin': orgAdmin, '/api/read-content': readContentApi, '/api/save-content': saveContentApi };
const csp = (() => {
  const lines = readFileSync(join(ROOT, 'public/_headers'), 'utf8').split('\n');
  const at = lines.findIndex((l) => l.trim() === '/admin/*');
  return lines.slice(at + 1).find((l) => /^\s+Content-Security-Policy:/.test(l)).split('Content-Security-Policy:')[1].trim();
})();
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.zip': 'application/zip' };
const saves = [];
const refreshes = [];
const images = new Map();
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const who = req.headers['x-test-user'] || '';
    if (url.pathname === '/cdn-cgi/access/get-identity') { res.writeHead(who ? 200 : 401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(who ? { email: who, name: '' } : {})); return; }
    if (url.pathname.startsWith('/cdn-cgi/imagedelivery/')) {
      // The real image (the official logos, for the screenshots), else a pixel
      if (!images.has(url.pathname)) images.set(url.pathname, await realFetch(`https://imagedelivery.net/${url.pathname.slice('/cdn-cgi/imagedelivery/'.length)}`).then(async (r) => (r.ok ? { type: r.headers.get('content-type') || 'image/png', body: Buffer.from(await r.arrayBuffer()) } : null)).catch(() => null));
      const img = images.get(url.pathname);
      res.writeHead(200, { 'Content-Type': img?.type || 'image/png' }); res.end(img?.body || PNG); return;
    }
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !['host', 'connection', 'content-length'].includes(k)) headers.set(k, v);
      if (who) headers.set('CF-Access-JWT-Assertion', await tokenFor(who));
      const request = new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks), duplex: 'half' });
      if (url.pathname === '/api/save-content') saves.push(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      if (url.pathname === '/api/org-facts-admin' && req.method === 'POST') refreshes.push(JSON.parse(Buffer.concat(chunks).toString() || '{}').action);
      const ctx = { request, env, data: {}, waitUntil: () => {} };
      ctx.next = async () => {
        const fn = ROUTES[url.pathname]?.[`onRequest${req.method[0]}${req.method.slice(1).toLowerCase()}`];
        if (fn) return fn(ctx);
        if (url.pathname.startsWith('/api/pending-changes')) return Response.json({ success: true, changes: [], publish: {} });
        if (url.pathname === '/api/list-content') return Response.json({ success: true, items: [], pages: 1 });
        return Response.json({ success: true, ok: true, items: [], list: [], entries: [], files: [] });
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
async function tab(email, width = 1440) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 1000, deviceScaleFactor: 1, isMobile: width < 600, hasTouch: width < 600 });
  await page.setExtraHTTPHeaders({ 'x-test-user': email });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  // What's copied and printed, as the page asks for it
  await page.evaluateOnNewDocument(() => {
    window.__copied = [];
    window.__printed = 0;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied.push(t); } } });
    window.print = () => { window.__printed++; };
  });
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|sunshineonaranneyday\.com\/cdn-cgi\/imagedelivery|x-test-user|fonts\.g/.test(m.text())) consoleErrors.push(`${email} ${width}: ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`${email} ${width}: ${e.message}`));
  await answerAsks(page);
  return page;
}
const text = (page) => page.evaluate(() => document.body.innerText);
const waitText = (page, re, timeout = 8000) => page.waitForFunction((src, fl) => new RegExp(src, fl).test(document.body.innerText), { timeout }, re.source, re.flags).then(() => true, () => false);
const clickText = (page, selector, re) => page.evaluate((sel, src) => {
  const el = [...document.querySelectorAll(sel)].find((e) => e.offsetParent !== null && new RegExp(src).test(e.textContent.trim()));
  if (el) el.click();
  return !!el;
}, selector, re.source);
const overflow = (page) => page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
const copied = (page) => page.evaluate(() => window.__copied.slice());
async function shot(page, name) {
  const vp = page.viewport();
  const h = await page.evaluate(() => Math.min(7000, document.scrollingElement.scrollHeight));
  await page.setViewport({ ...vp, height: Math.max(vp.height, h) });
  await sleep(300);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  await page.setViewport(vp);
}
async function axeScan(page, scope, label) {
  await page.evaluate(AXE);
  const res = await page.evaluate(async (sel) => {
    const r = await window.axe.run(sel, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } });
    return r.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  }, scope);
  ok(res.length === 0, `axe: ${label}`, res.join('\n      '));
}
const ST = seed.settings;

try {
  // ── 1. The board page ──
  for (const width of [1440, 390]) {
    await section(`Board page → Documents, ${width}px`, async () => {
      const page = await tab(MEMBER, width);
      await page.goto(`${SITE}/admin/board/#/documents`, { waitUntil: 'networkidle0' });
      ok(await waitText(page, /SOARD’s facts/), 'SOARD’s facts on Documents');
      // Small: the six a form asks for first, the rest folded
      const visible = () => page.$$eval('.bp-org__fact', (els) => els.filter((e) => e.offsetParent !== null).map((e) => e.id.replace('fact-', '')));
      ok((await visible()).join(',') === 'name,ein,status,office,phone,email', `the six a form asks for first (${(await visible()).join(', ')})`);
      const height = await page.$eval('.bp-org', (e) => Math.round(e.getBoundingClientRect().height));
      ok(height <= (width === 1440 ? 330 : 720), `the card is small (${height}px)`);
      const facts = await page.$$eval('.bp-org__fact', (els) => els.map((e) => ({ id: e.id, label: e.querySelector('dt').textContent, v: e.querySelector('.bp-org__v').textContent })));
      const by = Object.fromEntries(facts.map((f) => [f.id, f]));
      ok(by['fact-ein']?.v.startsWith(ST.ein), `the EIN (${by['fact-ein']?.v})`);
      ok(/501\(c\)\(3\) public charity/.test(by['fact-status']?.v || ''), `the tax status as the IRS lists it (${by['fact-status']?.v})`);
      ok(await page.$eval('#fact-status .bp-org__note', (n) => getComputedStyle(n).display === 'none'), 'its small print waits for the rest to open');
      ok(by['fact-office']?.v.startsWith(ST.address.street) && !by['fact-mailing'], 'the address; no mailing address until Site Config has one');
      ok(by['fact-mission']?.v.trim().startsWith(String(seed.media.mission).trim().slice(0, 40)) && by['fact-website'] && by['fact-founded'] && by['fact-impact'], 'the mission, website, founding and impact folded under them');
      ok(!by['fact-legal'] && !by['fact-vision'] && !by['fact-duns'], 'no legal name, vision, values or DUNS number shown while there are none');
      ok(await page.$eval('#fact-phone a', (a) => a.getAttribute('href')) === `tel:+1${String(ST.phone).replace(/\D/g, '').slice(-10)}`, 'the phone a tap to call');
      // Copy one
      await page.click('#fact-ein .bp-org__copy');
      await sleep(150);
      ok((await copied(page)).at(-1) === ST.ein, 'the EIN’s copy button copies the EIN');
      ok(await page.$eval('#fact-ein .bp-org__copy', (b) => b.classList.contains('is-done')), 'and ticks');
      ok(await waitText(page, /EIN copied/), 'and says so (“EIN copied”)');
      // Copy all: every fact, the folded ones too
      await clickText(page, '.bp-org .bp-btn', /^Copy all$/);
      await sleep(150);
      const all = (await copied(page)).at(-1) || '';
      ok(all.startsWith(ST.name) && all.includes(`EIN: ${ST.ein}`) && /Tax status: 501\(c\)\(3\) public charity, 509\(a\)\(1\)/.test(all) && all.includes(`Phone: ${ST.phone}`) && /Mission: /.test(all) && /Website: /.test(all) && !/SOARD in a few lines/.test(all), 'Copy all: every fact, form-ready', all.slice(0, 300));
      // The rest, a click away, and kept open next time
      await clickText(page, '.bp-org__toggle', /^All of SOARD’s facts$/);
      await sleep(250);
      ok((await visible()).includes('mission') && await page.$eval('.bp-org__toggle', (b) => b.getAttribute('aria-expanded') === 'true'), 'All of SOARD’s facts opens the rest');
      ok(await page.$eval('#fact-status .bp-org__note', (n) => getComputedStyle(n).display !== 'none' && /Since July 2012/.test(n.textContent) && /509\(a\)\(1\)/.test(n.textContent)), 'the tax status’s small print with it');
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('.bp-org');
      ok((await visible()).includes('mission'), 'still open after a reload, as it was left');
      await clickText(page, '.bp-org__toggle', /^Fewer facts$/);
      await sleep(200);
      ok(!(await visible()).includes('mission'), 'Fewer facts folds them again');
      // The papers forms ask for
      const papers = await page.$$eval('.bp-org__papers a', (as) => as.map((a) => a.textContent.trim()));
      ok(papers.join(',') === 'W-9,IRS letter', `the papers beside the facts (${papers.join(', ')})`);
      await clickText(page, '.bp-org__papers a', /^W-9$/);
      const viewer = await page.waitForSelector('.fv[role="dialog"]', { timeout: 4000 }).then(() => page.$eval('.fv[role="dialog"]', (d) => d.getAttribute('aria-label')), () => null);
      ok(/^W-9( \(\d of \d\))?$/.test(viewer || ''), `the W-9 opens in the viewer, named W-9 (${viewer})`);
      await page.keyboard.press('Escape');
      await sleep(300);
      // The brand is the website's page; tell the founder
      ok(!(await page.$('.bp-kit')), 'no brand card on the board page');
      ok(await page.$eval('.bp-org__more a[href="/branding/"]', (a) => /Logos, colors and fonts/.test(a.textContent) && a.target === '_blank'), 'Logos, colors and fonts: the brand page, in a tab of its own');
      ok(await page.$eval('.bp-org__more', (p) => /Tell Jane/.test(p.textContent) && /mailto:jane@soardcharity\.com/.test(p.innerHTML)), 'something out of date: tell Jane');
      if (width === 390) ok(await page.$eval('.bp-org__copy', (b) => b.getBoundingClientRect().height >= 44) && await page.$eval('.bp-org__papers a', (a) => a.getBoundingClientRect().height >= 44), 'a finger’s size on a phone (44px)');
      const gradients = await page.evaluate(() => [...document.querySelectorAll('.bp-org, .bp-org *')].filter((e) => /gradient/.test(getComputedStyle(e).backgroundImage + getComputedStyle(e).maskImage)).length);
      ok(gradients === 0, 'flat: no gradients');
      ok(await overflow(page) <= 0, `nothing past the right edge (${await overflow(page)}px)`);
      await axeScan(page, '.bp-org', 'SOARD’s facts');
      await shot(page, `documents-${width}`);
      // Print: the facts alone, every one of them
      await page.evaluate(() => window.scrollTo(0, 0));
      await clickText(page, '.bp-org .bp-btn', /^Print$/);
      await sleep(200);
      ok(await page.evaluate(() => window.__printed === 1 && document.documentElement.classList.contains('bp-printing-org')), 'Print asks the browser to print');
      await page.emulateMediaType('print');
      const shown = await page.evaluate(() => [...document.querySelector('.bp-main').children].filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.className));
      ok(shown.length === 1 && /bp-org/.test(shown[0]), `printed, the facts alone (${shown.join(' | ')})`);
      ok(await page.$eval('#fact-mission', (f) => f.offsetParent !== null), 'the folded ones printed too');
      ok(await page.$eval('.bp-org__copy', (b) => getComputedStyle(b).display === 'none'), 'without their buttons');
      if (width === 1440) await page.pdf({ path: join(OUT, 'fact-sheet.pdf'), format: 'letter', printBackground: true });
      await page.emulateMediaType('screen');
      await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
      ok(await page.evaluate(() => !document.documentElement.classList.contains('bp-printing-org')), 'and the page is itself again after');
      // The Documents filter: the facts that match, folded or not
      const filter = 'input[type="search"][placeholder^="Find a document"]';
      await page.type(filter, 'mailing');
      await sleep(250);
      ok(!(await page.$('.bp-org')), 'a word no fact has (no mailing address yet): no facts card');
      await page.$eval(filter, (i) => { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.type(filter, 'tax id');
      await sleep(250);
      const only = await page.$$eval('.bp-org__fact', (els) => els.map((e) => e.id));
      ok(only.join(',') === 'fact-ein', `“tax id” finds the EIN alone (${only.join(', ')})`);
      await page.$eval(filter, (i) => { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.type(filter, 'mission');
      await sleep(250);
      ok((await visible()).join(',') === 'mission', '“mission” finds the folded mission');
      await page.$eval(filter, (i) => { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.close();
    });
  }

  await section('Board page: a paper to sign this year comes before the facts, until it’s signed', async () => {
    // A PDF to sign (signed right there in the list, where a jump would show)
    await DB.prepare('INSERT INTO board_docs (id, data, updated_at) VALUES (?, ?, ?)').bind('d_expect1', JSON.stringify({ id: 'd_expect1', title: 'Board Member Expectations', kind: 'policy', shared: true, sign: true }), new Date().toISOString()).run();
    const exp = await pdf('Board Member Expectations');
    await env.FILES.put('board/docs/f_expect1', exp, { httpMetadata: { contentType: 'application/pdf' } });
    await DB.prepare("INSERT INTO board_files (id, owner_type, owner_id, r2_key, name, type, size, kind, staff_only, at, by) VALUES ('f_expect1', 'doc', 'd_expect1', 'board/docs/f_expect1', 'Board Member Expectations.pdf', 'application/pdf', ?, 'other', 0, ?, ?)").bind(exp.length, new Date().toISOString(), FOUNDER).run();
    const page = await tab(MEMBER, 390);
    await page.goto(`${SITE}/admin/board/#/documents`, { waitUntil: 'networkidle0' });
    await waitText(page, /To read and sign/);
    const order = () => page.evaluate(() => [...document.querySelectorAll('.bp-main > section')].map((x) => (x.classList.contains('bp-tosign') ? 'sign' : x.classList.contains('bp-org') ? 'facts' : x.classList.contains('bp-papers') ? 'papers' : '')).filter(Boolean).join(' '));
    ok(await order() === 'sign facts papers', `to sign first, then the facts (${await order()})`);
    // Signed: nothing moves while they're there; the next visit has the facts on top
    await page.type('#sign-d_expect1', 'Alex Rivera');
    await clickText(page, '.bp-sign button', /I’ve read it and agree/);
    ok(await waitText(page, /Signed: Board Member Expectations|Signed\s*by Alex Rivera/), 'signed');
    await sleep(400);
    ok(await order() === 'sign facts papers', `signing moves nothing (${await order()})`);
    await page.evaluate(() => { location.hash = '#/'; });
    await sleep(500);
    await page.evaluate(() => { location.hash = '#/documents'; });
    await page.waitForSelector('.bp-org', { timeout: 5000 });
    await sleep(300);
    ok(await order() === 'facts sign papers', `the next visit: the facts first (${await order()})`);
    await page.close();
    await DB.prepare("DELETE FROM board_signatures WHERE doc_id = 'd_expect1'").run().catch(() => {});
    await DB.prepare("DELETE FROM board_files WHERE id = 'f_expect1'").run();
    await DB.prepare("DELETE FROM board_docs WHERE id = 'd_expect1'").run();
  });

  await section('Board page: search lands on a fact, its copy button ready', async () => {
    const page = await tab(MEMBER, 1440);
    await page.goto(`${SITE}/admin/board/#/`, { waitUntil: 'networkidle0' });
    await page.keyboard.down('Meta'); await page.keyboard.press('KeyK'); await page.keyboard.up('Meta');
    const open = await page.waitForSelector('dialog.bp-finder[open] input', { timeout: 4000 }).then(() => true, () => false);
    ok(open, 'the search opens');
    await page.keyboard.type('ein');
    await sleep(400);
    const rows = await page.evaluate(() => [...document.querySelectorAll('dialog.bp-finder[open] [role="option"], dialog.bp-finder[open] li')].map((x) => x.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean));
    ok(rows.some((r) => /^EIN\b/.test(r) && r.includes(ST.ein)), `“ein” finds the EIN with its number (${rows.slice(0, 3).join(' | ')})`);
    // The EIN's row, chosen
    const picked = await page.evaluate((ein) => { const el = [...document.querySelectorAll('dialog.bp-finder[open] [role="option"], dialog.bp-finder[open] li a, dialog.bp-finder[open] li button')].find((x) => /^EIN/.test(x.innerText.trim()) && x.innerText.includes(ein)); if (el) el.click(); return !!el; }, ST.ein);
    ok(picked, 'chosen');
    const landed = await page.waitForFunction(() => location.hash === '#/documents' && document.activeElement?.closest('#fact-ein'), { timeout: 5000 }).then(() => true, () => false);
    ok(landed, 'Documents, the focus on the EIN’s copy button');
    await page.keyboard.press('Enter');
    await sleep(150);
    ok((await copied(page)).at(-1) === ST.ein, 'Enter copies it');
    // A folded one: the rest open for it
    await page.evaluate(() => { location.hash = '#/'; });
    await sleep(500);
    await page.keyboard.down('Meta'); await page.keyboard.press('KeyK'); await page.keyboard.up('Meta');
    await page.waitForSelector('dialog.bp-finder[open] input', { timeout: 4000 });
    await page.keyboard.type('mission statement');
    await sleep(400);
    await page.evaluate(() => { const el = [...document.querySelectorAll('dialog.bp-finder[open] [role="option"], dialog.bp-finder[open] li a, dialog.bp-finder[open] li button')].find((x) => /^Mission/.test(x.innerText.trim())); el?.click(); });
    ok(await page.waitForFunction(() => document.activeElement?.closest('#fact-mission') && document.querySelector('#fact-mission').offsetParent !== null, { timeout: 5000 }).then(() => true, () => false), 'a folded fact: the rest open, the focus on its copy button');
    // The brand: the website's page
    await page.keyboard.down('Meta'); await page.keyboard.press('KeyK'); await page.keyboard.up('Meta');
    await page.waitForSelector('dialog.bp-finder[open] input', { timeout: 4000 });
    await page.keyboard.type('logo');
    await sleep(400);
    ok(await page.evaluate(() => /SOARD’s logos, colors and fonts\s*The brand guide, on the website/.test(document.querySelector('dialog.bp-finder[open]')?.innerText || '')), '“logo” finds the brand page (it opens /branding/ in a tab of its own)', await page.evaluate(() => `${document.querySelector('dialog.bp-finder[open] input')?.value} :: ${(document.querySelector('dialog.bp-finder[open]')?.innerText || 'no dialog').replace(/\s+/g, ' ').slice(0, 300)}`));
    await page.close();
  });

  // ── 2. Site Config → Organization & contact ──
  await section('Site Config → Organization & contact', async () => {
    const page = await tab(FOUNDER, 1440);
    await page.goto(`${SITE}/admin/index.html#site/org`, { waitUntil: 'networkidle0' });
    ok(await waitText(page, /things don’t match/, 15000), 'what doesn’t match, at the top');
    const items = await page.$$eval('.sc-orgcheck__list > li', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ')));
    ok(items.length === 4 && /No legal name yet/.test(items[0]) && /Sunshine on a Ranney Day Incorporated/.test(items[0]), `the legal name, with the IRS’s (${items.length} things)`, items.join('\n      '));
    ok(items.some((i) => /The IRS has another address for SOARD/.test(i) && i.includes(ST.address.street) && /10800 Alpharetta Hwy Suite 208 625, Roswell, GA 30076-1417/.test(i) && /Form 8822-B/.test(i)), 'the address, both of them, and Form 8822-B');
    ok(items.some((i) => /SOARD’s W-9 has another address/.test(i)), 'the W-9’s address');
    ok(items.some((i) => /The Board Manual words the mission another way/.test(i) && /Creating spaces/.test(i)), 'the Board Manual’s mission');
    ok(await page.$eval('.sc-orgcheck .sc-sub', (p) => /the IRS’s list of October 13, 2026, SOARD’s W-9 and the Board Manual/.test(p.textContent)), 'what it was checked against');
    await shot(page, 'site-config-org-before');
    // Each put right
    await clickText(page, '.sc-orgcheck button', /^Add it$/);
    await sleep(200);
    ok(await page.evaluate(() => [...document.querySelectorAll('.sc-field')].find((f) => /^Legal name/.test(f.querySelector('.sc-label')?.textContent || ''))?.querySelector('input').value) === 'Sunshine on a Ranney Day Incorporated', 'Add it: the legal name is in');
    await clickText(page, '.sc-orgcheck button', /^Add it as the mailing address$/);
    await sleep(200);
    const mailing = await page.$$eval('#sc-mailing input', (is) => is.map((i) => i.value));
    ok(mailing.join('|') === '10800 Alpharetta Hwy Suite 208 625|Roswell|GA|30076-1417', `the mailing address is in (${mailing.join(', ')})`);
    ok(!(await text(page)).includes('SOARD’s W-9 has another address'), 'the W-9 now matches the mailing address');
    await clickText(page, '.sc-orgcheck button', /^Use the Board Manual’s$/);
    await sleep(200);
    ok(await page.$eval('#sc-mission textarea', (t) => t.value.startsWith('Creating spaces')), 'the mission is the Board Manual’s');
    ok(await waitText(page, /Matches the IRS’s list of October 13, 2026, SOARD’s W-9 and the Board Manual/), 'everything matches, said in a line');
    // The DUNS number: one digit short is said, and blocks saving with the value below
    const duns = await page.evaluateHandle(() => [...document.querySelectorAll('.sc-field')].find((f) => /^DUNS number/.test(f.querySelector('.sc-label')?.textContent || ''))?.querySelector('input'));
    ok(!!(await duns.evaluate((i) => i && i.value === '')), 'a DUNS number box, empty');
    await duns.type('04931028');
    ok(await waitText(page, /Nine digits, like 12-345-6789/), 'a DUNS number a digit short is said');
    // A value with no name can't be saved
    await clickText(page, '#sc-mission button', /Add a value/);
    await sleep(200);
    await clickText(page, '.sc-bar-actions button', /^Save$/);
    ok(await waitText(page, /a value without its name/) && await waitText(page, /the DUNS number/), 'a value with no name, or a DUNS number a digit short, blocks saving');
    await duns.type('9');
    ok(!(await text(page)).includes('Nine digits, like'), 'nine digits: nothing said');
    const valueInput = await page.$('#sc-mission .sc-value input');
    await valueInput.type('Joy');
    await page.type('#sc-mission .sc-value input:nth-of-type(1)', '');
    const vision = await page.evaluateHandle(() => [...document.querySelectorAll('#sc-mission .sc-field')].find((f) => /^Vision/.test(f.querySelector('.sc-label')?.textContent || ''))?.querySelector('textarea'));
    await vision.type('Every child home, in a space made for them.');
    await clickText(page, '.sc-bar-actions button', /^Save$/);
    await page.waitForFunction(() => !/Saving/.test(document.querySelector('.sc-bar-state')?.textContent || ''), { timeout: 10000 }).catch(() => {});
    await sleep(600);
    const st = await stored('settings');
    const md = await stored('media');
    ok(st.legalName === 'Sunshine on a Ranney Day Incorporated' && st.mailingAddress?.street === '10800 Alpharetta Hwy Suite 208 625' && st.vision === 'Every child home, in a space made for them.' && st.values?.[0]?.name === 'Joy' && st.duns === '049310289', 'saved: legal name, mailing address, vision, values, DUNS number', JSON.stringify({ l: st.legalName, m: st.mailingAddress, v: st.vision, vals: st.values }));
    ok(md.mission.startsWith('Creating spaces') && md.founderStory === seed.media.founderStory && JSON.stringify(md.brandingPhotos) === JSON.stringify(seed.media.brandingPhotos), 'saved: the mission, the rest of the Media Kit as it was');
    ok(st.application?.openChangedBy === 'peter@soardcharity.com' && st.ein === ST.ein && JSON.stringify(st.homeHero) === JSON.stringify(ST.homeHero), 'nothing else in the settings touched');
    // The board page has it at once
    const member = await tab(MEMBER, 1440);
    await member.goto(`${SITE}/admin/board/#/documents`, { waitUntil: 'networkidle0' });
    await waitText(member, /SOARD’s facts/);
    const after = await member.$$eval('.bp-org__fact', (els) => Object.fromEntries(els.map((e) => [e.id, e.querySelector('.bp-org__v').innerText])));
    ok(after['fact-legal']?.startsWith('Sunshine on a Ranney Day Incorporated') && after['fact-mailing']?.startsWith('10800 Alpharetta Hwy Suite 208 625, Roswell, GA 30076-1417') && /Office/.test(await member.$eval('#fact-office dt', (d) => d.textContent)), 'the board page: the legal name, the mailing address, the office as the office');
    ok(after['fact-vision']?.startsWith('Every child home') && /Joy/.test(after['fact-values'] || '') && after['fact-mission']?.startsWith('Creating spaces'), 'the board page: the vision, values and mission as saved');
    ok(after['fact-duns']?.startsWith('049310289') && /^DUNS$/.test(await member.$eval('#fact-duns dt', (d) => d.textContent)), 'the board page: the DUNS number as saved', after['fact-duns']);
    await member.close();
    // Saved: compared again at once (so Slack's post turns ✅), and Check again still there to read it all again
    ok(refreshes.length === 1, `the save sent the light refresh (${refreshes.join(', ')})`);
    ok(!(await page.$('.sc-orgcheck')) && !!(await page.$('.sc-orgok__again')), 'it all matches; Check again still a click away');
    await page.evaluate(() => { location.hash = '#site/media'; });
    await sleep(600);
    ok(!(await page.evaluate(() => [...document.querySelectorAll('.sc-label')].some((l) => /^Mission statement$/.test(l.textContent.trim()) || /^EIN$/.test(l.textContent.trim())))), 'the Media Kit has no mission or EIN box of its own');
    await clickText(page, '.sc-page button.sc-link', /^Organization & contact$/);
    await sleep(500);
    ok(await page.evaluate(() => location.hash === '#site/org'), 'its link goes to Organization & contact');
    await shot(page, 'site-config-org-after');
    await page.close();
  });

  await section('Site Config: Check again, and the EIN changed', async () => {
    // Someone saves another EIN elsewhere: said, and Check again reads the list for it
    const st = await stored('settings');
    await DB.prepare("UPDATE site_config SET data = ? WHERE key = 'settings'").bind(JSON.stringify({ ...st, ein: '12-3456789' })).run();
    const page = await tab(FOUNDER, 390);
    await page.goto(`${SITE}/admin/index.html#site/org`, { waitUntil: 'networkidle0' });
    ok(await waitText(page, /The EIN changed since the last check/, 15000), 'a new EIN is said, not judged on the old one’s line');
    const before = irs.gets;
    await clickText(page, '.sc-orgcheck button', /Check again/);
    ok(await waitText(page, /The IRS’s list of tax-exempt organizations doesn’t have this EIN/, 15000), 'Check again: 12-3456789 isn’t on the list, and says so first');
    ok(irs.gets === before + 1 && refreshes.at(-1) === 'check', 'the list was read again');
    ok(await overflow(page) <= 0, `phone: nothing past the right edge (${await overflow(page)}px)`);
    await shot(page, 'site-config-org-390');
    await DB.prepare("UPDATE site_config SET data = ? WHERE key = 'settings'").bind(JSON.stringify(st)).run();
    await page.close();
  });

  ok(consoleErrors.length === 0, 'no console errors', consoleErrors.join('\n      '));
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} failed:\n  ${failures.join('\n  ')}` : '\nAll passed.');
process.exit(failures.length ? 1 : 0);
