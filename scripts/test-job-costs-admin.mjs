/**
 * test-job-costs-admin.mjs — drive Admin → Job Costs in a real browser
 * ===================================================================
 * Opens the admin at #job-costs (public/ served directly, every /api call
 * stubbed; /api/job-costs-admin answers like production would with two
 * jobs, a few charges, rules and Ramp bills) and checks: the menu entry,
 * job cards with spent and forecast against budget, a job's cost-code table
 * and its charges, sorting an unsorted charge into the store (the POST it
 * sends), adding a rule, Setup's cards and categories, recoding a Ramp bill
 * through the admin's own dialog, the address for each tab and job, phones
 * (no sideways scroll, 44px touch targets), axe, and no console errors.
 * Screenshots land in test-results/job-costs/.
 *
 *   node scripts/test-job-costs-admin.mjs
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { answerAsks } from './lib/ask.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/job-costs/');
mkdirSync(OUT, { recursive: true });
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const DAY = 86400e3;

const CODES = [{ id: 'C01', name: '01 DESIGN & ENGINEERING' }, { id: 'C19', name: '19 PLUMBING' }, { id: 'C20', name: '20 ELECTRICAL' }, { id: 'C24', name: '24 DRYWALL' }];
function freshData() {
  return {
    success: true,
    codes: CODES,
    jobs: [
      { id: 'J1', name: 'Max Daniel (2026)', status: 'Build', staff: ['amy@soardcharity.com'] },
      { id: 'J2', name: 'Colin Lindsay (2026)', status: 'Mobilization', staff: ['amy@soardcharity.com', 'bo@soardcharity.com'] },
    ],
    ledgers: [
      { jobId: 'J1', name: 'Max Daniel (2026)', status: 'Build', address: '12 Oak St, Decatur, GA', updatedAt: iso(60e3), alerted: {},
        rows: [
          { codeId: 'C19', budget: 500000, committed: 0, billed: 326400, pending: 0, forecast: 326400 },
          { codeId: 'C24', budget: 150000, committed: 80000, billed: 90000, pending: 12000, forecast: 182000 },
          { codeId: 'uncoded', budget: 0, committed: 0, billed: 0, pending: 9900, forecast: 9900 },
        ],
        totals: { budget: 650000, committed: 80000, billed: 416400, pending: 21900, forecast: 518300 } },
      { jobId: 'J2', name: 'Colin Lindsay (2026)', status: 'Mobilization', updatedAt: iso(120e3), alerted: {},
        rows: [{ codeId: 'C19', budget: 200000, committed: 0, billed: 280500, pending: 0, forecast: 280500 }],
        totals: { budget: 200000, committed: 0, billed: 280500, pending: 0, forecast: 280500 } },
    ],
    charges: [
      { id: 'tx1', kind: 'creditCardTransaction', status: 'pending', cents: 46710, vendor: 'THE HOME DEPOT #121', email: 'amy@soardcharity.com', createdAt: iso(3 * 3600e3), bucket: 'job', jobId: 'J1', jobHow: 'build', costCodeId: null, billId: null, link: 'https://app.mercury.com/x' },
      { id: 'tx2', kind: 'creditCardTransaction', status: 'sent', cents: 9900, vendor: 'TRUE LOO WASTE', email: 'bo@soardcharity.com', createdAt: iso(3 * DAY), bucket: 'job', jobId: 'J1', jobHow: 'rule', costCodeId: null, billId: null },
      { id: 'tx3', kind: 'creditCardTransaction', status: 'sent', cents: 3412, vendor: 'HOBBY LOBBY #88', email: 'amy@soardcharity.com', createdAt: iso(DAY), bucket: null, jobId: null, billId: null },
      { id: 'tx4', kind: 'creditCardTransaction', status: 'sent', cents: 326400, vendor: 'TKO PLUMBING', email: 'bo@soardcharity.com', createdAt: iso(6 * DAY), bucket: 'job', jobId: 'J1', jobHow: 'bill', costCodeId: 'C19', billId: 'B9' },
      { id: 'tx5', kind: 'creditCardTransaction', status: 'sent', cents: 1500, vendor: 'CANVA', email: 'peter@soardcharity.com', createdAt: iso(2 * DAY), bucket: 'operating', jobId: null, billId: null },
    ],
    rules: [
      { vendor: 'tko plumbing', name: 'TKO Plumbing', kind: 'code', costCodeId: 'C19', source: 'seed' },
      { vendor: 'canva', name: 'Canva', kind: 'operating', source: 'staff', by: 'peter@soardcharity.com' },
    ],
    recode: [
      { billId: 'R1', jobName: 'Dylan Marchena (2026)', vendor: 'The Home Depot', cents: 26938, date: '2026-10-08', state: 'proposed', proposedBy: 'datax', proposal: [{ costCodeId: 'C24', cents: 20000, name: 'Drywall, mud' }, { costCodeId: 'C20', cents: 6938, name: 'Outlets' }] },
      { billId: 'R2', jobName: 'Max Daniel (2026)', vendor: 'TKO Plumbing', cents: 326400, date: '2026-10-22', state: 'proposed', proposedBy: 'rule', proposal: [{ costCodeId: 'C19', cents: 326400 }] },
      { billId: 'R3', jobName: 'Max Daniel (2026)', vendor: 'Wayfair', cents: 21535, date: '2026-10-15', state: 'waiting' },
    ],
    config: { accountBuckets: {}, cardBuckets: {}, categories: {}, caps: false, receiptInbox: 'ap@example.org' },
    bills: [
      { id: 'B1', jobId: 'J1', vendor: 'TKO Plumbing', cents: 185000, owed: 185000, date: '2026-10-20', number: '7', status: 'pending', lines: [], jobName: 'Max Daniel (2026)', job: { budget: 650000, forecast: 518300 },
        codes: [{ id: 'C19', name: '19 PLUMBING', budget: 500000, forecast: 326400 }], big: false, link: 'https://app.jobtread.com/documents/B1',
        approval: { state: 'waiting', askedAt: iso(DAY), askedCount: 1, approvals: [] } },
      { id: 'B2', jobId: 'J2', vendor: 'Power Up Electrical', cents: 92000, owed: 92000, date: '2026-10-10', number: '3', status: 'pending', lines: [], jobName: 'Colin Lindsay (2026)', job: null, codes: [], big: false, link: 'https://app.jobtread.com/documents/B2',
        approval: { state: 'approved', approvals: [{ by: 'approver@example.org', decision: 'approved', at: iso(2 * DAY), via: 'email' }], payState: 'paid' } },
    ],
    billPay: { approvers: ['approver@example.org'], bigApprovers: [], bigBillCents: 1000000, dailyCapCents: 2500000, payMode: 'off', payFromAccountId: null },
    closeouts: [
      { jobId: 'J0', name: 'Ava Brooks (2026)', closedOn: '2026-09-30', budget: 1200000, actual: 1312000, rooms: 2, codedShare: 0.95,
        rows: [{ codeId: 'C19', budget: 500000, actual: 610000 }, { codeId: 'C20', budget: 300000, actual: 280000 }, { codeId: 'C24', budget: 400000, actual: 422000 }],
        over: [{ codeId: 'C19', by: 110000 }, { codeId: 'C24', by: 22000 }] },
    ],
    history: { jobs: 3, codes: [{ codeId: 'C19', seen: 3, share: 1, perRoom: 290000, low: 260000, high: 310000, perJob: 600000, overBy: 18 }, { codeId: 'C20', seen: 3, share: 1, perRoom: 140000, low: 120000, high: 150000, perJob: 280000, overBy: -5 }] },
    odd: [{ key: 'duplicate:tx1:tx9', kind: 'duplicate', chargeIds: ['tx1'], vendor: 'THE HOME DEPOT #121', cents: 46710, detail: '$467.10 twice within a day', foundAt: iso(3600e3) }],
    health: { mercury: true, jobtread: true, slack: true, webhook: { registered: true, lastEventAt: iso(3 * 3600e3) }, lastCatchUp: { at: iso(60e3) }, lastRebuildAt: iso(5 * 60e3), agentUsedAt: iso(3600e3) },
  };
}
const SETUP = {
  accounts: [{ id: 'acc-1', name: 'Operating checking', kind: 'checking', lastFour: '1234' }, { id: 'acc-2', name: 'Mercury IO', kind: 'credit' }],
  cards: [{ id: 'card-a', name: 'Amy Lee', lastFour: '4401', status: 'active' }, { id: 'card-s', name: 'Peter Ranney', lastFour: '7788', nickname: 'Store', status: 'active' }],
  categories: [{ id: 'cat-cogs', name: 'Makeover COGS' }, { id: 'cat-store', name: 'Store inventory' }],
  caps: [{ cardId: 'card-a', name: 'Amy Lee', lastFour: '4401', nowCents: 500000, interval: 'monthly', wantCents: 330000, jobs: ['Max Daniel (2026)', 'Colin Lindsay (2026)'] }],
};

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

async function open(browser, base, viewport, hash = '#job-costs') {
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
    if (url.pathname === '/api/job-costs-admin') {
      if (url.searchParams.get('budget')) {
        const rooms = Number(url.searchParams.get('rooms')) || 2;
        return json({ success: true, codes: CODES, budget: { jobId: 'J1', builds: { 'Dream Bedroom': 1, 'Accessible Bathroom': 1 }, roomsFromProfile: 2, history: { jobs: 3, all: 5 }, rooms,
          lines: [{ codeId: 'C19', suggested: 290000 * rooms, low: 260000 * rooms, high: 310000 * rooms, seen: 3, overBy: 18, current: 500000, add: false }, { codeId: 'C20', suggested: 140000 * rooms, low: 120000 * rooms, high: 150000 * rooms, seen: 3, overBy: -5, current: 0, add: true }],
          total: 430000 * rooms, current: 500000 } });
      }
      if (req.method() === 'POST') {
        const b = JSON.parse(req.postData());
        posts.push(b);
        if (b.action === 'sort') data.charges = data.charges.map((c) => (c.id === b.chargeId ? { ...c, bucket: b.bucket, jobId: b.jobId || null } : c));
        if (b.action === 'rule-save') data.rules = [...data.rules, { vendor: b.name.toLowerCase(), name: b.name, kind: b.kind, costCodeId: b.costCodeId, source: 'staff', by: 'peter@soardcharity.com' }];
        if (b.action === 'recode-apply') {
          data.recode = data.recode.map((r) => (b.billIds.includes(r.billId) ? { ...r, state: 'applied' } : r));
          return json({ ...data, results: b.billIds.map((id) => ({ billId: id, ok: true })) });
        }
        if (b.action === 'bill-decide') data.bills = data.bills.map((x) => (x.id === b.billId ? { ...x, approval: { ...x.approval, state: b.decision, approvals: [{ by: 'peter@example.org', decision: b.decision, at: new Date().toISOString(), via: 'admin' }] } } : x));
        if (b.action === 'odd-clear') data.odd = [];
        if (b.action === 'budget-add') return json({ success: true, added: b.lines.length, skipped: 0 });
        if (b.action === 'setup') data.config = { ...data.config, cardBuckets: b.cardBuckets, accountBuckets: b.accountBuckets, categories: b.categories };
        return json({ ...data, ...(b.action === 'setup' ? SETUP : {}) });
      }
      return json({ ...data, ...(url.searchParams.get('setup') === '1' ? SETUP : {}) });
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
  await page.waitForSelector('.jc .page-header h2', { timeout: 15000 });
  return { page, errors, posts };
}

const clickText = (page, sel, text) => page.evaluate((sel, text) => {
  const el = [...document.querySelectorAll(sel)].find((b) => b.textContent.trim().startsWith(text));
  if (!el) return false;
  el.click();
  return true;
}, sel, text);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function axe(page, label) {
  // Pills fade between colors for 150ms: measure contrast after they settle
  await wait(300);
  await page.evaluate(AXE);
  const r = await page.evaluate(async () => (await window.axe.run(document.querySelector('.jc'), { resultTypes: ['violations'] })).violations.map((v) => `${v.id} (${v.nodes.length}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join('; ')})`));
  ok(r.length === 0, `axe: no violations on ${label}${r.length ? `: ${r.join(', ')}` : ''}`);
}

const server = await serve();
const base = `http://localhost:${server.address().port}`;
const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
try {
  console.log('Desktop');
  const { page, errors, posts } = await open(browser, base, { width: 1440, height: 1000 });
  ok(await page.evaluate(() => [...document.querySelectorAll('a, button')].some((e) => e.textContent.trim() === 'Job Costs')), 'Job Costs is in the menu');
  const cards = await page.$$eval('.jc-job h3', (h) => h.map((x) => x.textContent));
  ok(cards.length === 2 && cards[0].startsWith('Colin Lindsay') && cards[0].includes('Over budget'), `jobs listed, most over budget first, flagged (${cards.join(' | ')})`);
  ok((await page.$eval('.jc-job', (e) => e.textContent)).includes('$2,805 spent'), 'a card says what was spent');
  ok(await page.$eval('.seg [role="tab"]:nth-child(2) .count', (e) => e.textContent.trim() === '2'), 'Charges shows 1 to sort and 1 odd');
  ok(await page.$eval('.seg [role="tab"]:nth-child(3) .count', (e) => e.textContent.trim() === '1'), 'Bills shows 1 waiting for approval');
  await page.screenshot({ path: `${OUT}jobs.png` });
  await axe(page, 'Jobs');

  await clickText(page, '.jc-job', 'Max Daniel');
  await page.waitForSelector('.jc-table');
  ok(page.url().endsWith('#job-costs/J1'), `a job has its own address (${page.url().split('#')[1]})`);
  const rows = await page.$eval('.jc-table', (t) => [...t.querySelectorAll('tbody tr')].map((x) => x.children[0].textContent));
  ok(rows.join('|') === '19 PLUMBING|24 DRYWALL|Not coded yet', `cost codes by name, uncoded last (${rows.join(', ')})`);
  ok(await page.$eval('.jc-table tbody tr:nth-child(2)', (e) => e.classList.contains('is-over')), 'a code over its line is marked');
  ok((await page.$eval('.jc-table tfoot', (e) => e.textContent)).includes('$5,183'), 'the total forecast shows');
  const jobCharges = await page.$$eval('.jc-charge strong', (s) => s.map((x) => x.textContent));
  ok(jobCharges.length === 3, `the job’s card charges are listed (${jobCharges.join(', ')})`);
  await page.waitForFunction(() => document.body.textContent.includes('Budget builder') && document.querySelectorAll('.jc-table').length >= 2);
  const bb = await page.evaluate(() => [...document.querySelectorAll('.card')].find((c) => c.textContent.includes('Budget builder')).textContent);
  ok(bb.includes('From 3 finished makeovers') && bb.includes('runs 18% over'), 'the budget builder shows its history and a code that runs over');
  await clickText(page, '.jc button', 'Add 1 to JobTread');
  await wait(300);
  const add = posts.find((p) => p.action === 'budget-add');
  ok(add?.lines?.length === 1 && add.lines[0].codeId === 'C20' && add.lines[0].cents === 280000, `only the code the job has none of goes to JobTread (${JSON.stringify(add?.lines)})`);
  await page.screenshot({ path: `${OUT}job.png`, fullPage: false });
  await axe(page, 'a job');

  await clickText(page, '.seg [role="tab"]', 'Charges');
  await page.waitForSelector('.jc-sort select');
  ok(page.url().endsWith('#job-costs/charges'), 'Charges has its own address');
  ok((await page.$$eval('.jc-charge strong', (s) => s.map((x) => x.textContent))).join() === 'HOBBY LOBBY #88', 'To sort lists the one unsorted charge');
  await page.select('.jc-sort select', 'store');
  await wait(50);
  ok(await page.$eval('.jc-sort label', (e) => e.textContent.includes('Always for HOBBY LOBBY #88')), 'it offers to remember the vendor');
  await clickText(page, '.jc-sort button', 'Save');
  await page.waitForFunction(() => !document.querySelector('.jc-sort'));
  const sort = posts.find((p) => p.action === 'sort');
  ok(sort && sort.bucket === 'store' && sort.chargeId === 'tx3' && sort.remember === true, `sorting sends store + remember (${JSON.stringify(sort)})`);
  ok(await page.$eval('.jc-body', (e) => e.textContent.includes('Every charge has a home')), 'the list empties');
  await clickText(page, '.pill', 'No receipt after 2 days');
  ok((await page.$$eval('.jc-charge strong', (s) => s.map((x) => x.textContent))).join() === 'TRUE LOO WASTE', 'a makeover charge 3 days old with no bill is listed as missing its receipt');
  await page.screenshot({ path: `${OUT}charges.png` });
  await axe(page, 'Charges');
  await clickText(page, '.pill', 'Odd');
  await page.waitForFunction(() => document.body.textContent.includes('Charged twice?'));
  await clickText(page, '.jc-sort button', 'It’s fine');
  await wait(200);
  ok(posts.some((p) => p.action === 'odd-clear' && p.key === 'duplicate:tx1:tx9'), 'an odd charge can be marked fine');

  await clickText(page, '.seg [role="tab"]', 'Bills');
  await page.waitForFunction(() => document.body.textContent.includes('TKO Plumbing · #7'));
  ok(page.url().endsWith('#job-costs/bills'), 'Bills has its own address');
  const active = await page.$$eval('.seg [role="tab"][aria-selected="true"]', (t) => t.map((x) => x.textContent.trim()));
  ok(active.length === 1 && active[0].startsWith('Bills'), `only Bills is the active tab (${active.join(', ')})`);
  ok(await page.evaluate(() => document.body.textContent.includes('Asked 1 days ago') || document.body.textContent.includes('Asked 24 h ago') || document.body.textContent.includes('Asked 1 day')), 'a bill says when the approver was asked');
  await page.screenshot({ path: `${OUT}bills.png` });
  await axe(page, 'Bills');
  await clickText(page, '.jc-sort button', 'Approve');
  await page.waitForFunction(() => !document.body.textContent.includes('TKO Plumbing · #7'));
  ok(posts.some((p) => p.action === 'bill-decide' && p.billId === 'B1' && p.decision === 'approved'), 'Approve sends the decision after the dialog');
  await clickText(page, '.pill', 'Paid');
  ok(await page.evaluate(() => document.body.textContent.includes('Paid · recorded in JobTread')), 'a paid bill says it was recorded in JobTread');
  await clickText(page, '.jc button', 'Settings');
  await page.waitForFunction(() => document.body.textContent.includes('When a bill is approved'));
  ok(await page.evaluate(() => [...document.querySelectorAll('input[name="pay-mode"]')].filter((r) => r.disabled).length === 2), 'paying from Mercury waits for a pay-from account');
  await axe(page, 'Bill settings');

  await clickText(page, '.seg [role="tab"]', 'Close-outs');
  await page.waitForFunction(() => document.body.textContent.includes('Where budgets miss'));
  ok(await page.evaluate(() => document.body.textContent.includes('18% over')), 'codes that run over are listed');
  await page.screenshot({ path: `${OUT}closeouts.png` });
  await axe(page, 'Close-outs');
  await clickText(page, '.jc-charge', '');
  await page.waitForFunction(() => location.hash === '#job-costs/closeouts/J0');
  ok(await page.evaluate(() => document.body.textContent.includes('9% over') && document.body.textContent.includes('$6,560')), 'a close-out shows over/under and cost per room');
  await axe(page, 'a close-out');

  await clickText(page, '.seg [role="tab"]', 'Rules');
  await page.waitForSelector('.jc-table');
  await page.type('.jc-body input', 'Sherwin-Williams');
  await page.select('.jc-body select[aria-label="Cost code"]', 'C24');
  await clickText(page, '.jc-body button', 'Add');
  await page.waitForFunction(() => document.querySelector('.jc-table').textContent.includes('Sherwin-Williams'));
  const rule = posts.find((p) => p.action === 'rule-save');
  ok(rule && rule.kind === 'code' && rule.costCodeId === 'C24', 'a rule is added with its cost code');
  await axe(page, 'Rules');

  await clickText(page, '.seg [role="tab"]', 'Setup');
  await page.waitForSelector('select[aria-label="Card ending 7788"]');
  await page.select('select[aria-label="Card ending 7788"]', 'store');
  await clickText(page, '.jc-body button', 'Save');
  await page.waitForFunction(() => !document.querySelector('.jc .sec-head__hint')?.textContent.includes('Unsaved'));
  await wait(100);
  const setup = posts.find((p) => p.action === 'setup');
  ok(setup?.cardBuckets?.['card-s'] === 'store', 'Setup saves the store’s card');
  ok(await page.evaluate(() => document.body.textContent.includes('$3,300/mo')), 'card limits show what budgets would set');
  await page.screenshot({ path: `${OUT}setup.png` });
  await axe(page, 'Setup');

  await clickText(page, '.seg [role="tab"]', 'Ramp bills');
  await page.waitForSelector('.jc-split');
  ok((await page.$eval('.jc-split', (e) => e.textContent)).includes('24 DRYWALL'), 'a proposed split shows its codes');
  await page.click('input[aria-label="Pick The Home Depot"]');
  await clickText(page, '.jc button', 'Recode 1');
  await page.waitForFunction(() => document.body.textContent.includes('Recoded'));
  const rec = posts.find((p) => p.action === 'recode-apply');
  ok(rec?.billIds?.join() === 'R1', 'Recode sends only the picked bill, after the dialog');
  await page.screenshot({ path: `${OUT}ramp.png` });
  await axe(page, 'Ramp bills');
  ok(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await page.close();

  console.log('Phone');
  const phone = await open(browser, base, { width: 390, height: 844, isMobile: true, hasTouch: true }, '#job-costs/charges');
  await phone.page.waitForSelector('.jc-sort');
  const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow <= 0, `no sideways scroll on a phone (${overflow}px)`);
  const small = await phone.page.$$eval('.jc-sort select, .jc-sort button', (els) => els.filter((e) => e.getBoundingClientRect().height < 44).length);
  ok(small === 0, 'the sort controls are 44px touch targets');
  await phone.page.screenshot({ path: `${OUT}phone-charges.png` });
  await phone.page.evaluate(() => { location.hash = '#job-costs/J1'; });
  await phone.page.waitForSelector('.jc-table');
  const overflow2 = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow2 <= 0, `a job’s table scrolls inside its card on a phone (${overflow2}px)`);
  await phone.page.screenshot({ path: `${OUT}phone-job.png` });
  ok(phone.errors.length === 0, `no console errors on a phone${phone.errors.length ? `: ${phone.errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} failed` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
