/**
 * test-finance-admin.mjs — drive Admin → Finance in a real browser
 * ===================================================================
 * Mounts public/admin/finance.js on a page carrying the admin's own styles
 * (index.html's stylesheet), every /api call stubbed with answers shaped
 * like production's, and checks: the P&L's three columns, the unsorted line,
 * last year beside it, the CSV link, picking what a deposit is (the POST it
 * sends); the cash forecast's tiles, chart and sources, saving the floor;
 * the close checklist, closing a month through the admin's own dialog and
 * the "Send the CPA's email to me" preview; Setup's CPA email; each tab's
 * address; phones (no sideways scroll, 44px targets); axe; no console errors.
 * Screenshots land in test-results/finance/.
 *
 *   node scripts/test-finance-admin.mjs
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { answerAsks } from './lib/ask.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/finance/');
mkdirSync(OUT, { recursive: true });
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The admin's stylesheet, so the page looks and measures like the real one
const ADMIN = readFileSync(join(ROOT, 'public/admin/index.html'), 'utf8');
const STYLE = ADMIN.slice(ADMIN.indexOf('<style>'), ADMIN.indexOf('</style>') + 8);
const HARNESS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Finance test</title>${STYLE}</head>
<body><main class="main" style="padding:1rem"><div id="root"></div></main>
<script type="module">
  import { h, render } from '/admin/vendor.js';
  import { Finance } from '/admin/finance.js';
  window.__toasts = [];
  render(h(Finance, { addToast: (m, t) => window.__toasts.push([m, t]) }), document.getElementById('root'));
</script></body></html>`;

const z = () => ({ job: 0, store: 0, operating: 0, total: 0 });
const c = (job, store, operating) => ({ job, store, operating, total: job + store + operating });
const period = (scale = 1) => ({
  income: [{ key: 'donations', label: 'Donations', cents: c(0, 0, 1200000 * scale) }, { key: 'store', label: 'Store sales', cents: c(0, 84000 * scale, 0) }],
  incomeTotal: c(0, 84000 * scale, 1200000 * scale),
  expenses: [
    { category: 'Makeover materials', cents: c(812000 * scale, 0, 0) },
    { category: 'Store inventory', cents: c(0, 30500 * scale, 0) },
    { category: 'Software', cents: c(0, 0, 41000 * scale) },
  ],
  unsorted: { cents: 4312 * scale, count: 2 },
  expenseTotal: { ...c(812000 * scale, 30500 * scale, 41000 * scale), unsorted: 4312 * scale, total: 812000 * scale + 30500 * scale + 41000 * scale + 4312 * scale },
  net: { job: -812000 * scale, store: 53500 * scale, operating: 1159000 * scale, total: 1284000 * scale - 887812 * scale },
  jobs: [{ jobId: 'J1', cents: 520000 * scale }, { jobId: 'J2', cents: 292000 * scale }],
  count: 40,
});
const MONTHS = ['2026-11', '2026-10', '2026-09', '2026-08'];
function freshData() {
  const weeks = Array.from({ length: 13 }, (_, i) => {
    const start = new Date(Date.parse('2026-11-02T12:00:00Z') + i * 7 * 86400e3).toISOString().slice(0, 10);
    const likely = 4200000 - i * 180000 + (i > 6 ? 900000 : 0);
    return { start, inLikely: 210000, inLow: 0, inHigh: 600000, out: 380000, outLow: 418000, outHigh: 342000, likely, low: likely - 300000 - i * 120000, high: likely + 200000 + i * 90000, parts: {} };
  });
  return {
    months: MONTHS,
    health: { mercury: true, email: true, history: { since: '2025-01-01T00:00:00Z', doneAt: '2026-11-01T00:00:00Z', read: 1840 }, balancesError: null, cpaError: null },
    settings: { floorCents: 2500000, cpaEmail: '', replyTo: '' },
    pnl: {
      month: '2026-10', label: 'October 2026', lastYearMonth: '2025-10',
      periods: { month: period(1), lastYearMonth: { ...period(0.5), count: 12 }, ytd: period(9), lastYtd: { ...period(7), count: 300 } },
      jobNames: { J1: 'Max Daniel (2026)', J2: 'Colin Lindsay (2026)' },
      perMakeover: { count: 3, averageCents: 2810000, from: 'mercury', jobs: [{ jobId: 'J7', name: 'Ava Brooks (2026)', cents: 3104000 }, { jobId: 'J8', name: 'Eli Stone (2026)', cents: 2700000 }, { jobId: 'J9', name: 'Mia Fox (2026)', cents: 2626000 }] },
      sources: [
        { key: 'zeffy', name: 'ZEFFY', kind: 'donations', picked: false, cents: 9200000, count: 31 },
        { key: 'stripe', name: 'STRIPE TRANSFER', kind: 'store', picked: false, cents: 640000, count: 12 },
        { key: 'john smith', name: 'JOHN SMITH', kind: 'other', picked: false, cents: 50000, count: 1 },
      ],
      closed: null,
    },
    cash: {
      today: '2026-11-03', startCents: 4200000, owedCents: 620000, floorCents: 2500000, weeks,
      lowest: { likely: { cents: 3120000, week: '2026-12-07' }, low: { cents: 1980000, week: '2026-12-14' } },
      end: { likely: weeks.at(-1).likely, low: weeks.at(-1).low, high: weeks.at(-1).high },
      belowFloor: { week: '2026-12-07', cents: 2310000 },
      sources: { incomeWeekly: { likely: 210000, low: 0, high: 600000, weeksOfHistory: 96 }, operatingWeekly: 95000, storeWeekly: 9000, makeoversCents: 1800000, makeoverCount: 2, unbudgetedCount: 1, averageMakeoverCents: 2810000 },
      balances: { cashCents: 4200000, owedCents: 620000, accounts: [{ name: 'Checking', kind: 'checking', cents: 3100000 }, { name: 'Savings', kind: 'savings', cents: 1100000 }], at: new Date(Date.now() - 600e3).toISOString() },
      averageFrom: 'mercury', jobs: [], unbudgeted: [],
    },
    close: [{
      month: '2026-10', label: 'October 2026', ended: true, ready: false, closed: null,
      checks: [
        { key: 'sorted', label: 'Every charge sorted into a makeover, the store or operating', state: 'todo', count: 2, detail: '2 charges still to sort', link: 'https://sunshineonaranneyday.com/admin/#job-costs/charges' },
        { key: 'receipts', label: 'Every makeover charge has its receipt or JobTread bill', state: 'ok', count: 0, detail: 'All in', link: 'https://sunshineonaranneyday.com/admin/#job-costs/charges' },
        { key: 'categories', label: 'Every payment has a Mercury category', state: 'ok', count: 0, detail: 'All categorized' },
        { key: 'books', label: 'Mercury Books has every transaction synced', state: 'na', count: 0, detail: 'Mercury Books isn’t connected to the API yet, so this is checked in Mercury', link: 'https://app.mercury.com/accounting' },
        { key: 'bills', label: 'Every JobTread bill matched to its Mercury payment', state: 'ok', count: 0, detail: 'All matched' },
        { key: 'statement', label: 'Mercury’s statement for the month is out', state: 'todo', count: 1, detail: 'Not out yet for Checking', link: 'https://app.mercury.com/statements' },
      ],
    }],
  };
}

function serve() {
  const server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/finance-test.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(HARNESS); }
    const file = normalize(join(ROOT, 'public', p));
    if (!file.startsWith(join(ROOT, 'public')) || !existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

async function open(browser, base, viewport, hash = '#finance') {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const errors = [];
  const posts = [];
  const data = freshData();
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = new URL(req.url());
    const json = (obj, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.origin !== base) return req.abort();
    if (url.pathname === '/api/finance-admin') {
      const common = { success: true, months: data.months, health: data.health, settings: data.settings };
      if (req.method() === 'POST') {
        const b = JSON.parse(req.postData());
        posts.push(b);
        if (b.action === 'income-source') data.pnl.sources = data.pnl.sources.map((s) => (s.key === b.key ? { ...s, kind: b.kind, picked: true } : s));
        if (b.action === 'settings') data.settings = { ...data.settings, ...(b.floorCents !== undefined ? { floorCents: b.floorCents } : {}), ...(b.cpaEmail !== undefined ? { cpaEmail: b.cpaEmail, replyTo: b.replyTo } : {}) };
        if (b.action === 'close') data.close = data.close.map((m) => (m.month === b.month ? { ...m, closed: { at: new Date().toISOString(), by: 'peter@soardcharity.com' } } : m));
        if (b.action === 'preview-close') return json({ success: true, sentTo: 'peter@soardcharity.com' });
        return json({ ...common, pnl: data.pnl, close: data.close });
      }
      const view = url.searchParams.get('view');
      if (view === 'pnl') return json({ ...common, pnl: { ...data.pnl, ...(url.searchParams.get('month') ? { month: url.searchParams.get('month'), label: 'September 2026' } : {}) } });
      if (view === 'cash') return json({ ...common, cash: data.cash });
      if (view === 'close') return json({ ...common, close: data.close });
      return json(common);
    }
    return req.continue();
  });
  await answerAsks(page, { accept: true });
  await page.goto(`${base}/finance-test.html${hash}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.fi .page-header h2', { timeout: 15000 });
  return { page, errors, posts };
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
  const r = await page.evaluate(async () => (await window.axe.run(document.querySelector('.fi'), { resultTypes: ['violations'] })).violations.map((v) => `${v.id} (${v.nodes.length}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join('; ')})`));
  ok(r.length === 0, `axe: no violations on ${label}${r.length ? `: ${r.join(', ')}` : ''}`);
}

const server = await serve();
const base = `http://localhost:${server.address().port}`;
const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
try {
  console.log('Desktop');
  const { page, errors, posts } = await open(browser, base, { width: 1440, height: 1100 });
  await page.waitForSelector('.fi-table');
  const heads = await page.$$eval('.fi-table thead th', (t) => t.map((x) => x.textContent));
  ok(heads.join('|') === 'Line|Makeovers|Store|Operating|Total|Last year', `three columns, a total, last year (${heads.join(', ')})`);
  const text = await page.$eval('.fi', (e) => e.textContent);
  ok(text.includes('Not sorted yet (2)') && text.includes('$43 isn’t sorted yet'), 'unsorted spending is its own line and called out');
  ok(text.includes('+100% on last year') || text.includes('on last year'), 'the tiles compare with last year');
  ok(text.includes('Max Daniel (2026)') && text.includes('$5,200'), 'makeovers this month are listed by name');
  ok(text.includes('$28,100 on average, across 3 makeovers'), 'what a finished makeover costs');
  ok(await page.$eval('a[download]', (a) => a.getAttribute('href') === '/api/finance-admin?view=csv&month=2026-10'), 'the CSV link is the month’s');
  await page.screenshot({ path: `${OUT}pnl.png` });
  await axe(page, 'P&L');

  await page.select('#src-john\\ smith', 'donations');
  await wait(200);
  const src = posts.find((p) => p.action === 'income-source');
  ok(src && src.key === 'john smith' && src.kind === 'donations' && src.month === '2026-10', `picking what a deposit is sends it (${JSON.stringify(src)})`);
  ok((await page.$eval('.fi', (e) => e.textContent)).includes('picked by staff'), 'the pick shows as staff’s');

  await clickText(page, '.seg [role="tab"]', 'Year to date');
  ok((await page.$eval('.fi-table tr.is-net', (e) => e.textContent)).includes('$35,657'), 'year to date totals');

  await clickText(page, '.fi > .seg [role="tab"]', 'Cash');
  await page.waitForSelector('.fi-chart');
  ok(page.url().endsWith('#finance/cash'), 'Cash has its own address');
  const cashText = await page.$eval('.fi', (e) => e.textContent);
  ok(cashText.includes('$42,000') && cashText.includes('$6,200 owed on the card'), 'cash today and the card');
  ok(cashText.includes('dips under $25,000 the week of Dec 7'), 'the floor warning says when');
  ok(cashText.includes('Where these numbers come from') && cashText.includes('3 weeks in Build'), 'each number’s source is explained');
  await page.screenshot({ path: `${OUT}cash.png` });
  await axe(page, 'Cash');
  await page.$eval('.fi form input[type="number"]', (el) => { el.value = ''; });
  await page.type('.fi form input[type="number"]', '30000');
  await clickText(page, '.fi form button', 'Save');
  await wait(200);
  ok(posts.some((p) => p.action === 'settings' && p.floorCents === 3000000), 'saving the floor sends cents');

  await clickText(page, '.fi > .seg [role="tab"]', 'Close');
  await page.waitForSelector('.fi-check');
  ok(page.url().endsWith('#finance/close'), 'Close has its own address');
  ok((await page.$eval('.fi .sec-head h3', (e) => e.textContent)).includes('2 to do'), 'the month says how much is left');
  ok(await page.$eval('.fi-check a[href="#job-costs/charges"]', (a) => !a.target), 'a fix in the admin stays in this tab');
  ok(await page.$eval('.fi-check a[href="https://app.mercury.com/statements"]', (a) => a.target === '_blank'), 'a fix in Mercury opens a new tab');
  await page.screenshot({ path: `${OUT}close.png` });
  await axe(page, 'Close');
  await clickText(page, '.fi button', 'Send the CPA’s email to me');
  await wait(200);
  ok(posts.some((p) => p.action === 'preview-close' && p.month === '2026-10'), 'the preview goes to whoever pressed it');
  ok(await page.evaluate(() => window.__toasts.some(([m]) => m.includes('peter@soardcharity.com'))), 'and says where it went');
  await clickText(page, '.fi button', 'Close October 2026');
  await page.waitForFunction(() => document.querySelector('.fi').textContent.includes('Its P&L is frozen'));
  ok(posts.some((p) => p.action === 'close' && p.month === '2026-10'), 'closing goes through the admin’s dialog');

  await clickText(page, '.fi > .seg [role="tab"]', 'Setup');
  await page.waitForSelector('.fi input[type="email"]');
  await page.type('.fi input[type="email"]', 'cpa@firm.com');
  await clickText(page, '.fi button', 'Save');
  await wait(200);
  ok(posts.some((p) => p.action === 'settings' && p.cpaEmail === 'cpa@firm.com'), 'the CPA’s email saves');
  await axe(page, 'Setup');
  ok(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await page.close();

  console.log('Phone');
  for (const [hash, label] of [['#finance', 'P&L'], ['#finance/cash', 'Cash'], ['#finance/close', 'Close']]) {
    const p2 = await open(browser, base, { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, hash);
    await p2.page.waitForSelector(hash === '#finance' ? '.fi-table' : hash.endsWith('cash') ? '.fi-chart' : '.fi-check');
    const wide = await p2.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(wide <= 0, `${label}: no sideways scroll on a phone (${wide}px)`);
    const small = await p2.page.evaluate(() => [...document.querySelectorAll('.fi button, .fi select, .fi a.btn, .fi input')]
      .filter((e) => e.offsetParent && e.getBoundingClientRect().height < 43.5 && !e.closest('.seg')).map((e) => e.textContent.trim() || e.tagName));
    ok(small.length === 0, `${label}: touch targets are 44px (${small.join(', ')})`);
    await p2.page.screenshot({ path: `${OUT}phone-${label.toLowerCase().replace(/\W/g, '')}.png` });
    ok(p2.errors.length === 0, `${label}: no console errors on a phone${p2.errors.length ? `: ${p2.errors.join(' | ')}` : ''}`);
    await p2.page.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} failed` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
