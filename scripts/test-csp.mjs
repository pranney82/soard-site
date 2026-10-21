/**
 * test-csp.mjs — the site under its STRICT Content-Security-Policy, enforced
 * ============================================================================
 * Serves a build (after scripts/csp-hash.mjs) with the headers from its
 * dist/_headers, except that each route's Content-Security-Policy-Report-Only
 * policy (inline scripts only by hash, no inline handlers) is sent as the
 * enforced Content-Security-Policy: what ENFORCE = true would ship. Then, in a
 * real browser:
 *   - visits the key pages, scrolls them, and records every
 *     securitypolicyviolation event and console error (target: zero violations)
 *   - a client-router soft navigation (/ → /kids/ → a kid), which runs each new
 *     page's inline scripts under the first page's policy
 *   - forces broken images: partner logos swap to their name, a kid page's
 *     village logo hides, a slate's partner chip drops out; and no logo that
 *     loaded fine was hidden
 *   - checks the policy bites: an injected inline script and an inline handler
 *     are blocked and reported to /api/csp-report
 * Images (/cdn-cgi/imagedelivery/) and public /api reads are fetched from the
 * live site (GET only); nothing is written anywhere. Pages name their images
 * by absolute https://sunshineonaranneyday.com URLs, which are 'self' in
 * production, so the served policy adds that origin wherever it has 'self'.
 *
 *   npx astro build --outDir <dir> && node scripts/csp-hash.mjs <dir>
 *   node scripts/test-csp.mjs <dir>          (PORT=4395 by default)
 * Exits non-zero on a violation or a failed check.
 */
import puppeteer from 'puppeteer';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { patternRegex, hasPlaceholder } from './csp-hash.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const DIST = process.argv[2] || join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 4395);
const SITE = `https://localhost:${PORT}`;
const UPSTREAM = 'https://sunshineonaranneyday.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };

// ── Headers, the way Cloudflare Pages applies _headers ────────────────────
const headersText = readFileSync(join(DIST, '_headers'), 'utf8');
if (hasPlaceholder(headersText)) {
  console.error(`${DIST}/_headers still has the 'csp-hashes' placeholder: run node scripts/csp-hash.mjs ${DIST} first`);
  process.exit(1);
}
const rules = [];
for (const line of headersText.split('\n')) {
  if (!line.trim() || line.trimStart().startsWith('#')) continue;
  if (/^\S/.test(line)) { rules.push({ re: patternRegex(line.trim()), ops: [] }); continue; }
  const rule = rules[rules.length - 1];
  const t = line.trim();
  if (t.startsWith('!')) rule.ops.push(['detach', t.slice(1).trim()]);
  else { const i = t.indexOf(':'); rule.ops.push(['set', t.slice(0, i).trim(), t.slice(i + 1).trim()]); }
}
/** Response headers for a path: every matching block in order, `! Name` detaching, then the strict policy enforced */
function headersFor(path) {
  const h = new Map();
  for (const rule of rules) {
    if (!rule.re.test(path)) continue;
    for (const [op, name, value] of rule.ops) {
      const k = name.toLowerCase();
      if (op === 'detach') h.delete(k);
      else h.set(k, { name, values: [...(h.get(k)?.values || []), value] });
    }
  }
  const strict = h.get('content-security-policy-report-only');
  if (strict) {
    // Pages name images by their absolute https://sunshineonaranneyday.com/cdn-cgi/... URL,
    // which is 'self' in production; here it's another origin, so say so
    const values = strict.values.map((v) => v.replace(/'self'/g, `'self' ${UPSTREAM}`));
    h.set('content-security-policy', { name: 'Content-Security-Policy', values });
    h.delete('content-security-policy-report-only');
  }
  return Object.fromEntries([...h.values()].map((e) => [e.name, e.values.join(', ')]));
}

// ── A static server for the build ─────────────────────────────────────────
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.pdf': 'application/pdf' };
const reports = [];

function fileFor(path) {
  const p = decodeURIComponent(path);
  if (p.includes('..')) return null;
  const f = join(DIST, p.endsWith('/') ? join(p, 'index.html') : p);
  if (existsSync(f) && statSync(f).isFile()) return { file: f };
  if (!p.endsWith('/') && existsSync(join(DIST, p, 'index.html'))) return { redirect: `${p}/` };
  if (existsSync(`${f}.html`)) return { file: `${f}.html` };
  return null;
}

// HTTPS with a throwaway certificate: Chrome sends Reporting API reports
// (report-to) only from secure pages, and plain http://localhost doesn't count
const certDir = mkdtempSync(join(tmpdir(), 'test-csp-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
  '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem')], { stdio: 'ignore' });
const tls = { key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) };
rmSync(certDir, { recursive: true, force: true });

const server = https.createServer(tls, async (req, res) => {
  const url = new URL(req.url, SITE);
  try {
    if (url.pathname === '/api/csp-report') {
      let body = '';
      for await (const c of req) body += c;
      reports.push({ type: req.headers['content-type'], body });
      res.writeHead(204).end();
      return;
    }
    if ((url.pathname.startsWith('/cdn-cgi/imagedelivery/') || url.pathname.startsWith('/api/')) && (req.method === 'GET' || req.method === 'HEAD')) {
      const up = await fetch(UPSTREAM + url.pathname + url.search, { headers: { Accept: req.headers.accept || '*/*' } });
      const buf = Buffer.from(await up.arrayBuffer());
      res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/octet-stream' }).end(req.method === 'HEAD' ? undefined : buf);
      return;
    }
    if (url.pathname.startsWith('/api/')) { res.writeHead(204).end(); return; }
    const hit = fileFor(url.pathname);
    if (hit?.redirect) { res.writeHead(308, { Location: hit.redirect + url.search }).end(); return; }
    const file = hit?.file || join(DIST, '404.html');
    res.writeHead(hit ? 200 : 404, { ...headersFor(url.pathname), 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });
console.log(`serving ${DIST} on ${SITE} (pid ${process.pid}), strict CSP enforced\n`);

// ── The browser ───────────────────────────────────────────────────────────
const browser = await puppeteer.launch({
  headless: 'new',
  acceptInsecureCerts: true,
  // --short-reporting-delay: Reporting API batches go out in ~100 ms instead of a minute
  args: ['--ignore-certificate-errors', '--short-reporting-delay', '--disable-gpu', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'],
});

// Noise a static server always makes (no live /api socket, missing local files, the
// throwaway certificate stopping the service worker): kept out of the per-page list
const NOISE = /Failed to load resource|WebSocket connection to|ERR_CONNECTION_REFUSED|net::ERR_|ServiceWorker|SSL certificate/;
const results = [];

async function open(path, { width = 1280, height = 900 } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) errors.push(m.text().slice(0, 240)); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e.message || e).slice(0, 240)}`));
  await page.evaluateOnNewDocument(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push({
      directive: e.effectiveDirective, blocked: e.blockedURI, source: e.sourceFile, line: e.lineNumber, sample: e.sample,
    }));
  });
  const res = await page.goto(SITE + path, { waitUntil: 'networkidle2', timeout: 90000 }).catch((e) => ({ status: () => `goto failed: ${e.message}` }));
  return { page, errors, status: res?.status?.() };
}

/** Scroll the whole page (lazy images and scripts), then collect what happened */
async function settle(page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight * 0.8) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 80)); }
    scrollTo(0, 0);
  });
  await sleep(1200);
}

async function record(label, page, errors, status) {
  const csp = await page.evaluate(() => window.__csp);
  const csp_errors = errors.filter((e) => /Content Security Policy/i.test(e));
  results.push({ label, status, violations: csp, errors });
  const tag = `${label} [${status}]`;
  ok(csp.length === 0 && csp_errors.length === 0, `${tag}: ${csp.length} violations${errors.length ? `, ${errors.length} console errors` : ''}`);
  for (const v of csp.slice(0, 5)) console.log(`      ${v.directive} blocked ${v.blocked} at ${v.source}:${v.line} ${v.sample ? `"${v.sample}"` : ''}`);
  for (const e of [...new Set(errors)].slice(0, 4)) console.log(`      console: ${e}`);
}

const PAGES = [
  '/', '/kids/', '/kids/ethan/', '/kids/adrian-2025/', '/partners/', '/how-it-works/', '/live/', '/live/slate/', '/live/ethan/slate/',
  '/apply/', '/apply/form/', '/donate/', '/events/', '/events/2026-evening-of-sunshine/', '/about/financials/', '/publicity/', '/faq/',
  '/this-page-does-not-exist/', '/admin/', '/admin/kid-template/full/',
];

console.log('Headers');
{
  const raw = (path) => { const h = new Map(); for (const rule of rules) if (rule.re.test(path)) for (const [op, name, value] of rule.ops) { const k = name.toLowerCase(); if (op === 'detach') h.delete(k); else h.set(k, [...(h.get(k) || []), value]); } return h; };
  for (const [path, marker] of [['/', 'challenges.cloudflare.com'], ['/apply/form/', 'upload.videodelivery.net'], ['/admin/', 'tile.openstreetmap.org']]) {
    const h = raw(path);
    const one = (k) => (h.get(k) || []).length === 1;
    const ro = (h.get('content-security-policy-report-only') || [])[0] || '';
    ok(one('content-security-policy') && one('content-security-policy-report-only') && ro.includes(marker) && /'sha256-/.test(ro) && !/script-src[^;]*'unsafe-inline'/.test(ro),
      `${path}: one enforced and one strict Report-Only policy, the route's own (${marker}), hashed, no 'unsafe-inline'`);
  }
}

console.log('\nPages');
for (const path of PAGES) {
  const { page, errors, status } = await open(path);
  await settle(page);
  if (path === '/admin/') {
    const booted = await page.evaluate(() => document.getElementById('app')?.childElementCount || 0);
    ok(booted > 0, `/admin/: the inline module ran (#app has ${booted} children)`);
  }
  await record(path, page, errors, status);
  await page.close();
}

console.log('\nSoft navigation (client router)');
{
  const { page, errors, status } = await open('/');
  await page.evaluate(() => { window.__sameDocument = true; });
  const go = async (href) => {
    await page.evaluate((h) => {
      const a = Object.assign(document.createElement('a'), { href: h, textContent: 'go', id: '__go' });
      a.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;padding:20px;background:#fff';
      document.body.append(a);
    }, href);
    await Promise.all([
      page.waitForFunction((h) => location.pathname === h && document.readyState === 'complete', { timeout: 30000 }, href),
      page.click('#__go'),
    ]);
    await sleep(1500);
  };
  await go('/kids/');
  const kid = await page.evaluate(() => [...document.querySelectorAll('a[href^="/kids/"]')].map((a) => a.getAttribute('href')).find((h) => /^\/kids\/[^/]+\/$/.test(h)));
  await go(kid);
  const same = await page.evaluate(() => window.__sameDocument === true);
  ok(same, `/ → /kids/ → ${kid} stayed one document (a soft navigation)`);
  await settle(page);
  await record(`/ → /kids/ → ${kid} (soft)`, page, errors, status);
  await page.close();
}

console.log('\nBroken images');
{
  // Partners: a logo that fails hides and shows the partner's name; none that loaded were hidden
  const { page, errors } = await open('/partners/');
  await settle(page);
  const wrong = await page.evaluate(() => [...document.querySelectorAll('img[data-img-fallback]')]
    .filter((i) => i.complete && i.naturalWidth > 0 && getComputedStyle(i).display === 'none').length);
  const total = await page.evaluate(() => document.querySelectorAll('img[data-img-fallback]').length);
  ok(total > 0 && wrong === 0, `/partners/: none of ${total} logos that loaded were hidden (${wrong})`);
  const swapped = await page.evaluate(async () => {
    const img = [...document.querySelectorAll('img[data-img-fallback="next"]')].find((i) => getComputedStyle(i).display !== 'none');
    img.removeAttribute('srcset');
    img.src = '/__broken-logo.png';
    await new Promise((r) => setTimeout(r, 800));
    return { img: getComputedStyle(img).display, name: getComputedStyle(img.nextElementSibling).display, text: img.nextElementSibling.textContent };
  });
  ok(swapped.img === 'none' && swapped.name !== 'none', `/partners/: a broken logo hides and "${swapped.text}" shows (${JSON.stringify(swapped)})`);
  await record('/partners/ (broken logo)', page, errors, 200);
  await page.close();
}
{
  const { page, errors } = await open('/kids/ethan/');
  const r = await page.evaluate(async () => {
    const img = document.querySelector('.village__logo img[data-img-fallback]');
    if (!img) return null;
    img.loading = 'eager';
    img.removeAttribute('srcset');
    img.src = '/__broken-logo.png';
    await new Promise((res) => setTimeout(res, 800));
    return getComputedStyle(img.closest('.village__logo')).display;
  });
  ok(r === 'none', `/kids/ethan/: a broken village logo hides its box (${r})`);
  await record('/kids/ethan/ (broken logo)', page, errors, 200);
  await page.close();
}
{
  const { page, errors } = await open('/live/ethan/slate/?still=1&music=0');
  const r = await page.evaluate(async () => {
    const before = document.querySelectorAll('.chip').length;
    const img = document.querySelector('.chip img[data-img-fallback]');
    if (!img) return { before, after: before, none: true };
    img.src = '/__broken-logo.png';
    await new Promise((res) => setTimeout(res, 800));
    return { before, after: document.querySelectorAll('.chip').length, kid: document.body.dataset.kid };
  });
  ok(r.none || r.after === r.before - 1, `/live/ethan/slate/: a broken partner chip drops out (${JSON.stringify(r)})`);
  ok(r.kid === 'ethan', '/live/ethan/slate/: the kid rides on <body data-kid>');
  await record('/live/ethan/slate/ (broken chip)', page, errors, 200);
  await page.close();
}

console.log('\nThe policy bites');
{
  const { page } = await open('/faq/');
  const r = await page.evaluate(async () => {
    const s = document.createElement('script');
    s.textContent = 'window.__injected = true';
    document.body.append(s);
    const d = document.createElement('div');
    d.setAttribute('onclick', 'window.__handler = true');
    document.body.append(d);
    d.click();
    await new Promise((res) => setTimeout(res, 300));
    return { injected: !!window.__injected, handler: !!window.__handler, violations: window.__csp.map((v) => v.directive) };
  });
  ok(!r.injected, 'an injected inline script is blocked');
  ok(!r.handler, 'an inline onclick handler is blocked');
  ok(r.violations.includes('script-src-elem') && r.violations.includes('script-src-attr'), `both raise violations (${r.violations.join(', ')})`);
  await page.close();
}

for (let i = 0; i < 15 && !reports.length; i++) await sleep(1000);
const delivered = reports.flatMap((r) => { try { const j = JSON.parse(r.body); return Array.isArray(j) ? j.map((x) => x.body?.effectiveDirective) : [j['csp-report']?.['effective-directive']]; } catch { return []; } });
ok(reports.length > 0, `violation reports reached /api/csp-report via the relative Reporting-Endpoints URL (${reports.map((r) => r.type).join(', ') || 'none'}: ${delivered.join(', ')})`);

await browser.close();
server.close();

const unexpected = results.filter((r) => r.violations.length).map((r) => r.label);
console.log(`\n${results.length} page checks, ${unexpected.length} with violations${unexpected.length ? `: ${unexpected.join(', ')}` : ''}; ${failures.length} failed check${failures.length === 1 ? '' : 's'}`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
