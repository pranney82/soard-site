/**
 * test-publish-history.mjs — drive Admin → Publish history in a real browser
 * ==========================================================================
 * Serves public/ directly and stubs every /api call. Checks:
 *   - the sidebar has no Email tab (newsletters are written and sent in Kit)
 *   - Publish history has no Refresh button and reloads when you come back
 *     to the tab
 * Exits non-zero on any failure or console error.
 *
 *   node scripts/test-publish-history.mjs
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
const ROOT = new URL('..', import.meta.url).pathname;
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
  console.log('Sidebar');
  ok(!(await page.evaluate(() => [...document.querySelectorAll('.sidebar a, .sidebar button, nav a, nav button')].some((x) => x.textContent.trim() === 'Email'))), 'no Email tab: newsletters are made in Kit');
  ok(await page.evaluate(() => [...document.querySelectorAll('.sidebar a, .sidebar button, nav a, nav button')].some((x) => x.textContent.trim() === 'Reveals')), 'Comms still has Reveals');

  console.log('Publish history');
  ok(await clickText('a, button', /^Publish history$/), 'Publish history is in the sidebar');
  await pause(800);
  ok(!(await buttons()).some((t) => /Refresh/.test(t)), 'no ↻ Refresh button');
  const depBefore = reqs.filter((r) => r.path.startsWith('/api/deployments')).length;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await pause(500);
  ok(reqs.filter((r) => r.path.startsWith('/api/deployments')).length > depBefore, 'coming back to the tab reloads the deploys');
  ok(!reqs.some((r) => /^\/api\/(kit-broadcast|send-test-email|send-direct)/.test(r.path)), 'nothing calls the removed email endpoints');
  ok(errors.length === 0, `no console errors (${errors.slice(0, 3).join(' | ')})`);
} finally { await browser.close(); server.close(); }
console.log(fails.length ? `${fails.length} failed` : 'All passed');
process.exit(fails.length ? 1 : 0);
