/**
 * test-vendors-admin.mjs — drive Admin → Vendors in a real browser
 * ================================================================
 * Opens the admin at #vendors (public/ served directly, every /api call
 * stubbed; /api/vendors-admin answers like production would with a sub that
 * needs a W-9 and insurance, a supplier, a sub with everything on file, and
 * a pair that might be one vendor) and checks: the list (who needs
 * something first), one vendor's page and its address, saving an email,
 * adding a certificate staff received (the multipart POST it sends), the
 * kind/insurance choices, linking a suggested pair through the admin's own
 * dialog, the 1099 list and its CSV link, Settings' switches (dialog on the
 * way on) and previews, phones (no sideways scroll, 44px controls), axe,
 * and no console errors. Screenshots land in test-results/vendors/.
 *
 * Until index.html has the Vendors entry, the area is mounted into the
 * admin's page by hand, so the module is still tested in the admin's styles.
 *
 *   node scripts/test-vendors-admin.mjs
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { answerAsks } from './lib/ask.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/vendors/');
mkdirSync(OUT, { recursive: true });
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const YEAR = new Date().getFullYear();
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const day = (n) => new Date(Date.now() + n * 86400e3).toLocaleDateString('en-CA');
const day300 = day(300);

const money = (rep, card, months = {}) => ({ reportable: { [YEAR]: rep, [YEAR - 1]: 0 }, card: { [YEAR]: card, [YEAR - 1]: 0 }, months, lastPaid: rep ? iso(5 * 86400e3) : null });
function freshData() {
  const vendors = [
    { id: 'v1', name: 'Example Plumbing LLC', mercuryId: 'r1', jtId: 'j1', email: 'office@plumbing.example', kind: 'sub', autoKind: 'sub', kindSet: null, corp: false, coiNeeded: true, coiNeededSet: null, coiState: 'missing',
      w9: null, coi: null, invite: { id: 'inv1', status: 'created', at: iso(2 * 86400e3), count: 1 }, coiAsk: null, onJob: true, onSite: true,
      needs: { w9: true, coi: true, coiOnSite: true, email: false }, facts: { names: ['Example Plumbing LLC', 'Example Plumbing'], jobs: [{ jobId: 'J1', jobName: 'Sample Family (2026)', status: 'Build', order: true }], mercury: { method: 'ach', address: '1 Pipe St, Atlanta, GA 30301' } },
      paid: money(420000, 0, { [`${YEAR}-06`]: 300000, [`${YEAR}-09`]: 120000 }) },
    { id: 'v2', name: 'The Home Depot', mercuryId: null, jtId: 'j2', email: null, kind: 'supplier', autoKind: 'supplier', kindSet: null, corp: false, coiNeeded: false, coiNeededSet: null, coiState: 'not-needed',
      w9: null, coi: null, invite: null, coiAsk: null, onJob: true, onSite: true, needs: { w9: false, coi: false, coiOnSite: false, email: false }, facts: { jobs: [{ jobId: 'J1', jobName: 'Sample Family (2026)', status: 'Build', order: false }] }, paid: money(0, 812345) },
    { id: 'v3', name: 'Sample Electric Co', mercuryId: 'r3', jtId: null, email: 'billing@electric.example', kind: 'sub', autoKind: 'sub', kindSet: null, corp: false, coiNeeded: true, coiNeededSet: null, coiState: 'current',
      w9: { source: 'mercury', at: iso(90 * 86400e3), name: 'w9.pdf' }, coi: { key: 'vendors/v3/coi-1.pdf', expires: day(200), insurer: 'Sample Mutual', at: iso(30 * 86400e3), by: 'vendor' }, invite: null, coiAsk: null, onJob: false, onSite: false,
      needs: { w9: false, coi: false, coiOnSite: false, email: false }, facts: { mercury: { method: 'check' } }, paid: money(95000, 0, { [`${YEAR}-04`]: 95000 }) },
    { id: 'v4', name: 'Bright Coat Painting', mercuryId: null, jtId: 'j4', email: null, kind: 'sub', autoKind: 'sub', kindSet: null, corp: false, coiNeeded: true, coiNeededSet: null, coiState: 'missing',
      w9: null, coi: null, invite: null, coiAsk: null, onJob: true, onSite: false, needs: { w9: true, coi: true, coiOnSite: false, email: true }, facts: { jobs: [{ jobId: 'J2', jobName: 'Another Family (2026)', status: 'Approval', order: true }] }, paid: money(0, 0) },
    { id: 'v5', name: 'Bright Coat Painting Inc', mercuryId: 'r5', jtId: null, email: 'hi@brightcoat.example', kind: 'sub', autoKind: 'sub', kindSet: null, corp: false, coiNeeded: true, coiNeededSet: null, coiState: 'missing',
      w9: null, coi: null, invite: null, coiAsk: null, onJob: false, onSite: false, needs: { w9: true, coi: false, coiOnSite: false, email: false }, facts: {}, paid: money(60000, 0, { [`${YEAR}-02`]: 60000 }) },
  ];
  return {
    success: true, year: YEAR, vendors,
    suggestions: [{ a: 'v5', b: 'v4', aName: 'Bright Coat Painting Inc', bName: 'Bright Coat Painting' }],
    settings: { autoW9: false, autoCoi: false, threshold: 600, coiDays: 30, replyTo: '' },
    filings: {
      [YEAR]: [{ id: 'v1', name: 'Example Plumbing LLC', total: 420000, w9: false, address: '1 Pipe St, Atlanta, GA 30301', months: {} }, { id: 'v3', name: 'Sample Electric Co', total: 95000, w9: true, address: null, months: {} }],
      [YEAR - 1]: [{ id: 'v1', name: 'Example Plumbing LLC', total: 90000, w9: false, address: '1 Pipe St, Atlanta, GA 30301', months: {} }],
    },
    health: { mercury: true, jobtread: true, email: true, files: true, recipientsAt: iso(20 * 60e3), jobtreadAt: iso(2 * 3600e3), lastError: null },
  };
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(browser, base, viewport, hash = '#vendors') {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const errors = [];
  const posts = [];
  let data = freshData();
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = new URL(req.url());
    const json = (obj, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.origin !== base) return req.abort();
    if (url.pathname === '/api/vendors-admin') {
      if (req.method() === 'POST') {
        const type = req.headers()['content-type'] || '';
        if (type.startsWith('multipart/form-data')) {
          const body = req.postData() || '';
          posts.push({ action: 'upload', multipart: true, body });
          data.vendors = data.vendors.map((v) => (v.id === 'v1' ? { ...v, coi: { key: 'vendors/v1/coi-2.pdf', expires: day(300), insurer: 'Sample Mutual', at: iso(0), by: 'staff' }, coiState: 'current', needs: { ...v.needs, coi: false, coiOnSite: false } } : v));
          return json(data);
        }
        const b = JSON.parse(req.postData());
        posts.push(b);
        if (b.action === 'set' && b.email !== undefined) data.vendors = data.vendors.map((v) => (v.id === b.id ? { ...v, email: b.email, needs: { ...v.needs, email: false } } : v));
        if (b.action === 'set' && b.kind !== undefined) data.vendors = data.vendors.map((v) => (v.id === b.id ? { ...v, kindSet: b.kind, kind: b.kind || v.autoKind } : v));
        if (b.action === 'link') { data.vendors = data.vendors.filter((v) => v.id !== b.b); data.suggestions = []; }
        if (b.action === 'settings') data.settings = { ...data.settings, ...Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'action')) };
        return json({ ...data, ...(b.action === 'preview' ? { sentTo: 'staff@soardcharity.com' } : {}) });
      }
      return json(data);
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
  // The admin's own Vendors entry, or (before it's wired) the area mounted into the page
  const wired = await page.waitForSelector('.vd .page-header h2', { timeout: 4000 }).then(() => true, () => false);
  if (!wired) {
    await page.evaluate(async () => {
      const [{ h, render }, { Vendors }] = await Promise.all([import('/admin/vendor.js'), import('/admin/vendors.js')]);
      const host = document.querySelector('.main-content') || document.querySelector('main') || document.body;
      host.innerHTML = '';
      const box = document.createElement('div');
      host.append(box);
      render(h(Vendors, { addToast: (m, kind) => { window.__toasts = [...(window.__toasts || []), `${kind}: ${m}`]; } }), box);
    });
    await page.waitForSelector('.vd .page-header h2', { timeout: 15000 });
  }
  // The admin fades a view in: let it finish before pictures and contrast checks
  await wait(700);
  return { page, errors, posts, wired };
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
  const r = await page.evaluate(async () => (await window.axe.run(document.querySelector('.vd'), { resultTypes: ['violations'] })).violations.map((v) => `${v.id} (${v.nodes.length}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join('; ')})`));
  ok(r.length === 0, `axe: no violations on ${label}${r.length ? `: ${r.join(', ')}` : ''}`);
}

const server = await serve();
const base = `http://localhost:${server.address().port}`;
const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
try {
  console.log('Desktop');
  const { page, errors, posts, wired } = await open(browser, base, { width: 1440, height: 1000 });
  if (wired) ok(await page.evaluate(() => [...document.querySelectorAll('a, button')].some((e) => e.textContent.trim() === 'Vendors')), 'Vendors is in the menu');
  else console.log('  · Vendors isn’t in index.html yet: mounted by hand');
  const names = await page.$$eval('.vd-row h3', (h) => h.map((x) => x.textContent));
  ok(names.length === 3 && names[0] === 'Example Plumbing LLC', `Need something lists the three with gaps, most paid first (${names.join(' | ')})`);
  ok(await page.$eval('.seg [role="tab"] .count', (e) => e.textContent.trim() === '3'), 'the Vendors tab counts 3 needing something');
  ok((await page.$eval('.vd-row', (e) => e.textContent)).includes('Needs a W-9'), 'a sub without a W-9 says so');
  ok(await page.evaluate(() => document.body.textContent.includes('Same vendor?')), 'a likely pair is offered for linking');
  await page.screenshot({ path: `${OUT}list.png` });
  await axe(page, 'the list');

  await clickText(page, '.vd-tools .seg button', 'Suppliers');
  ok((await page.$$eval('.vd-row h3', (h) => h.map((x) => x.textContent))).join() === 'The Home Depot', 'Suppliers shows Home Depot');
  ok(!(await page.$eval('.vd-row', (e) => e.textContent)).includes('W-9'), 'a card-only supplier never shows a W-9 tag');
  await clickText(page, '.vd-tools .seg button', 'Need something');

  await clickText(page, '.vd-suggest button', 'Link them');
  await page.waitForFunction(() => !document.body.textContent.includes('Same vendor?'));
  ok(posts.some((p) => p.action === 'link' && p.a === 'v5' && p.b === 'v4'), 'Link them sends the pair, after the dialog');

  await clickText(page, '.vd-row', 'Example Plumbing LLC');
  await page.waitForSelector('.vd-facts');
  ok(page.evaluate(() => location.hash) && (await page.evaluate(() => location.hash)) === '#vendors/v1', 'a vendor has its own address');
  ok((await page.$eval('.vd-facts', (e) => e.textContent)).includes('$4,200 by ACH, check or wire'), 'what they were paid, by how');
  ok(await page.evaluate(() => document.body.textContent.includes('Mercury asked them 1 time')), 'the W-9 request so far is shown');
  // FormData bodies with files don't reach request interception: note what the page sends
  await page.evaluate(() => {
    const real = window.fetch;
    window.__forms = [];
    window.fetch = (url, init = {}) => { if (init.body instanceof FormData) window.__forms.push(Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `file:${v.name}`]))); return real(url, init); };
  });
  await page.$eval('.vd details', (d) => { d.open = true; });
  const fileInput = await page.$('.vd details input[type="file"]');
  const tmp = join(OUT, 'sample-coi.pdf');
  (await import('node:fs')).writeFileSync(tmp, '%PDF-1.7\n% sample\n');
  await fileInput.uploadFile(tmp);
  await page.$eval('.vd details input[type="date"]', (e, d) => { e.value = d; e.dispatchEvent(new Event('input', { bubbles: true })); }, day(300));
  await clickText(page, '.vd details button', 'Save the certificate');
  await page.waitForFunction(() => document.body.textContent.includes('Good through'));
  const [form] = await page.evaluate(() => window.__forms);
  ok(form?.action === 'upload' && form.doc === 'coi' && form.id === 'v1' && form.file === 'file:sample-coi.pdf' && form.coiExpires === day300 && 'coiInsurer' in form, `adding a certificate sends the file, its end date and insurer (${JSON.stringify(form)})`);
  await page.select('.vd-field select', 'supplier');
  await wait(100);
  ok(posts.some((p) => p.action === 'set' && p.id === 'v1' && p.kind === 'supplier'), 'Sub or supplier saves');
  await page.screenshot({ path: `${OUT}vendor.png` });
  await axe(page, 'a vendor');

  await clickText(page, '.seg [role="tab"]', '1099');
  await page.waitForSelector('.vd-table');
  ok(await page.evaluate(() => location.hash) === '#vendors/1099', '1099 has its own address');
  ok((await page.$eval('.vd-table tbody', (e) => e.textContent)).includes('Missing'), 'a payee without a W-9 is flagged');
  ok(await page.$eval('a[download]', (a) => a.getAttribute('href').includes(`csv=1099&year=${new Date().getFullYear() - 1}`)), 'the CSV is last year’s');
  await page.screenshot({ path: `${OUT}1099.png` });
  await axe(page, '1099');

  await clickText(page, '.seg [role="tab"]', 'Settings');
  await page.waitForSelector('.vd-switch');
  await clickText(page, '.vd-switch button', 'Send it to me');
  await wait(100);
  ok(posts.some((p) => p.action === 'preview' && p.kind === 'w9'), 'Send it to me asks for a preview');
  await clickText(page, '.vd-switch button', 'Turn on');
  await page.waitForFunction(() => [...document.querySelectorAll('.vd-switch button')].some((b) => b.textContent.trim() === 'Turn off'));
  ok(posts.some((p) => p.action === 'settings' && p.autoW9 === true), 'turning W-9 requests on goes through the dialog');
  await page.screenshot({ path: `${OUT}settings.png` });
  await axe(page, 'Settings');
  ok(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await page.close();

  console.log('Phone');
  const phone = await open(browser, base, { width: 390, height: 844, isMobile: true, hasTouch: true }, '#vendors/v1');
  await phone.page.waitForSelector('.vd-facts');
  const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow <= 0, `no sideways scroll on a vendor’s page on a phone (${overflow}px)`);
  const small = await phone.page.$$eval('.vd-actions .btn, .vd-actions .form-input, .vd-tools .form-input', (els) => els.filter((e) => e.offsetParent && e.getBoundingClientRect().height < 44).length);
  ok(small === 0, 'controls are 44px touch targets');
  await phone.page.screenshot({ path: `${OUT}phone-vendor.png` });
  await phone.page.evaluate(() => { location.hash = '#vendors/1099'; });
  await wait(300);
  const overflow2 = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow2 <= 0, `the 1099 table fits a phone (${overflow2}px)`);
  await phone.page.screenshot({ path: `${OUT}phone-1099.png` });
  ok(phone.errors.length === 0, `no console errors on a phone${phone.errors.length ? `: ${phone.errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} failed` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
