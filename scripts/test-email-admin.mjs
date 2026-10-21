/**
 * test-email-admin.mjs — drive Admin → Email and Publish history in a real browser
 * ================================================================================
 * Serves public/ directly and stubs every /api call. Checks the buttons that
 * have a job and no others:
 *   - the template editor's "See it in your inbox": blank sends to the person
 *     signed in ("Send it to me", no address in the request), a typed address
 *     makes it "Send it", and the toast says where it went
 *   - Email → History and Publish history have no Refresh button and reload
 *     when you come back to the tab
 * Screenshots in test-results/email-admin/. Exits non-zero on any failure or
 * console error.
 *
 *   node scripts/test-email-admin.mjs
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/email-admin/');
mkdirSync(OUT, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };
const fails = []; const ok = (c, m) => { if (!c) fails.push(m); console.log(`${c ? '  ✓' : '  ✗'} ${m}`); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(ROOT, 'public', p));
  if (!existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
const errors = []; const reqs = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource') && !m.text().includes('live-ws')) errors.push(m.text()); });
await page.setRequestInterception(true);
page.on('request', (req) => {
  const url = new URL(req.url());
  const json = (o) => req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (url.origin !== base) return req.abort();
  if (url.pathname.startsWith('/api/')) reqs.push({ m: req.method(), path: url.pathname, body: req.postData() || null });
  if (url.pathname === '/api/send-test-email') { const b = JSON.parse(req.postData() || '{}'); return json({ ok: true, to: b.testEmail || 'peter@soardcharity.com' }); }
  if (url.pathname === '/api/kit-broadcast') return json({ success: true, broadcasts: [] });
  if (url.pathname.startsWith('/api/deployments')) return json({ success: true, deploys: [], source: 'cloudflare' });
  if (url.pathname.startsWith('/api/pending-changes')) return json({ success: true, changes: [], since: null });
  if (url.pathname.startsWith('/api/list-content')) return json({ success: true, items: [], total: 0, hasMore: false });
  if (url.pathname.startsWith('/api/audit-log')) return json({ success: true, entries: [], total: 0 });
  if (url.pathname.startsWith('/api/')) return json({ success: true, ok: true });
  return req.continue();
});
const clickText = (sel, re) => page.evaluate((sel, src) => { const r = new RegExp(src); const el = [...document.querySelectorAll(sel)].find((x) => r.test(x.textContent.trim())); if (el) el.click(); return !!el; }, sel, re.source);
const buttons = () => page.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.textContent.trim()));
try {
  await page.goto(`${base}/admin/`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('nav, .sidebar, aside', { timeout: 15000 });
  console.log('Email → a template');
  ok(await clickText('a, button', /^Email$/), 'Email is in the sidebar');
  await pause(800);
  const opened = await page.evaluate(() => { const el = [...document.querySelectorAll('main button, main [role=button], main .card')].find((x) => /New template/.test(x.textContent)); el?.click(); return !!el; });
  await pause(900);
  ok(opened && await page.evaluate(() => [...document.querySelectorAll('main div')].some((d) => d.textContent.trim() === 'See it in your inbox')), 'a new template opens with "See it in your inbox"');
  ok((await buttons()).includes('Send it to me') && !(await buttons()).includes('Send Test'), 'its button says Send it to me');
  // Need a subject for the button to be enabled
  const subj = await page.$('input[placeholder="What recipients see in their inbox"]');
  if (subj) { await subj.click({ clickCount: 3 }); await subj.type('Hello from SOARD'); }
  await clickText('button', /^Send it to me$/);
  await pause(600);
  const sent = reqs.filter((r) => r.path === '/api/send-test-email').at(-1);
  ok(sent && !JSON.parse(sent.body).testEmail, `blank sends to me: no address in the request (${sent ? 'sent' : 'not sent'})`);
  ok(await page.evaluate(() => document.body.innerText.includes('Sent to peter@soardcharity.com. Look for [TEST] in the subject.')), 'the toast says where it went');
  await page.type('input[aria-label="Send it to (blank for you)"]', 'linzi@soardcharity.com');
  ok((await buttons()).includes('Send it'), 'typing another address makes it Send it');
  await page.screenshot({ path: join(OUT, 'editor-send-it-to-me.png') });

  console.log('Email → History');
  await page.goto(`${base}/admin/`, { waitUntil: 'networkidle2' });
  await clickText('a, button', /^Email$/); await pause(600);
  ok(await clickText('button', /^(Sent|History|Kit history|Sent history)/), 'the history tab');
  await pause(600);
  const kitBefore = reqs.filter((r) => r.path === '/api/kit-broadcast').length;
  ok(!(await buttons()).includes('Refresh'), 'no Refresh button');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await pause(500);
  ok(reqs.filter((r) => r.path === '/api/kit-broadcast').length === kitBefore + 1, 'coming back to the tab (from Kit) reloads the history');

  console.log('Publish history');
  ok(await clickText('a, button', /^Publish history$/), 'Publish history is in the sidebar');
  await pause(800);
  ok(!(await buttons()).some((t) => /Refresh/.test(t)), 'no ↻ Refresh button');
  const depBefore = reqs.filter((r) => r.path.startsWith('/api/deployments')).length;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await pause(500);
  ok(reqs.filter((r) => r.path.startsWith('/api/deployments')).length > depBefore, 'coming back to the tab reloads the deploys');
  ok(errors.length === 0, `no console errors (${errors.slice(0, 3).join(' | ')})`);
} finally { await browser.close(); server.close(); }
console.log(fails.length ? `${fails.length} failed` : 'All passed');
process.exit(fails.length ? 1 : 0);
