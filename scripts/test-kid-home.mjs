/**
 * test-kid-home.mjs — the Home card beside a kid in Admin → Kids, in a real browser
 * ===========================================================================
 * The family's house as JobTread has it (functions/api/_home.js, read through
 * /api/job-home; how each field reads is public/admin/home-shared.js). The
 * admin is served as-is from public/ and every /api/* call is answered here,
 * with JobTread's answers in each state a kid can be in:
 *   - Colin: a full home (DataX's Zillow details, a retired field, bookkeeping,
 *     a long typed answer and an unbroken parcel number)
 *   - Amari: a job with no home in JobTread
 *   - Abby: JobTread fails once (Try again), then a home with nothing filled in
 *   - AJ: messy data: a Zillow link typed without https, a long field name with
 *     no spaces, a Tax ID, and 30 more fields nobody has filled in
 *   - Alex: a job JobTread no longer has
 *   - Adam: no job, so no card
 * Checks the order the card sits in, every value, the links, the read-only
 * wording, that each kid shows its own home, every width from 1440 to 390
 * (side panel and stacked), axe, and console errors. Screenshots in
 * test-results/kid-home/.
 *
 *   SITE=http://127.0.0.1:4471 node scripts/test-kid-home.mjs   (SITE serves public/)
 */
import puppeteer from 'puppeteer';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { axeScan, axeText } from './lib/axe.mjs';
import { answerAsks } from './lib/ask.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/kid-home/');
mkdirSync(OUT, { recursive: true });
const SITE = (process.env.SITE || 'http://127.0.0.1:4471').replace(/\/$/, '');
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readDir = (d) => Object.fromEntries(readdirSync(join(ROOT, 'src/content', d)).filter((f) => f.endsWith('.json'))
  .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(ROOT, 'src/content', d, f), 'utf8'))]));
const KIDS = readDir('kids');
for (const [slug, d] of Object.entries(KIDS)) d.slug ||= slug;
const PARTNERS = readDir('partners');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');

// SOARD's location fields as JobTread lists them (Nov 9 2026)
const FIELDS = [
  { id: 'fZillow', name: 'Zillow URL', type: 'url', position: 'a0' }, { id: 'fArea', name: 'Living Area', type: 'number', position: 'a1' },
  { id: 'fBedBath', name: 'Bed Bath', type: 'text', position: 'a2' }, { id: 'fYearOld', name: 'Year Built (old)', type: 'number', position: 'a3' },
  { id: 'fCounty', name: 'County', type: 'text', position: 'a4' }, { id: 'fSewer', name: 'Sewer/Septic', type: 'option', position: 'a5', options: ['Sewer', 'Septic'] },
  { id: 'fPower', name: 'Power Company', type: 'text', position: 'a6' }, { id: 'fWater', name: 'Water Source', type: 'text', position: 'a7' },
  { id: 'fParcel', name: 'Parcel Number', type: 'text', position: 'a8' }, { id: 'fPermit', name: 'Permit Number', type: 'text', position: 'a9' },
  { id: 'fZest', name: 'Zestimate', type: 'number', position: 'aA' }, { id: 'fSale', name: 'Latest Sale Price', type: 'number', position: 'aB' },
  { id: 'fSaleDate', name: 'Latest Sale Date', type: 'date', position: 'aC' }, { id: 'fYear', name: 'Year Built', type: 'text', position: 'aD' },
  { id: 'fBook', name: '**REQUIRED FIELDS**', type: 'text', position: 'aE' },
];
const LONG_POWER = 'Sawnee Electric Membership Corporation, billed through the cooperative office in Cumming';
const LONG_PARCEL = '15N23D178000000000000000000000000004417';
const ZILLOW = 'https://www.zillow.com/homedetails/1314-Timuquana-Trl-Woodstock-GA-30188/54837901_zpid/';
const home = (id, values) => ({ id, street: '1314 Timuquana Trail', address: '1314 Timuquana Trail, Woodstock, GA 30188, USA', city: 'Woodstock', state: 'GA', postalCode: '30188', url: `https://app.jobtread.com/locations/${id}`, values });
const COLIN = {
  fZillow: ZILLOW, fArea: 1435, fBedBath: '3 bed, 2.5 bath', fYearOld: 2000, fCounty: 'Cherokee', fSewer: 'Septic', fPower: LONG_POWER, fWater: 'Public',
  fParcel: LONG_PARCEL, fZest: 336500, fSale: 128700, fSaleDate: '2001-01-23', fYear: '2000', fBook: 'x',
};

// AJ's home, typed by hand over the years
const LONG_FIELD = 'NearestFireHydrantDistanceFromFrontDoorInFeetPerCountyGIS';
const AJ_FIELDS = [...FIELDS, { id: 'fHydrant', name: LONG_FIELD, type: 'number', position: 'aF' }, { id: 'fTaxId', name: 'Tax ID', type: 'number', position: 'aG' },
  ...Array.from({ length: 30 }, (_, i) => ({ id: `fExtra${i}`, name: `Extra Field ${i + 1}`, type: 'text', position: `b${String(i).padStart(2, '0')}` }))];
const AJ = { fZillow: 'www.zillow.com/homedetails/9-Oak-Ln/1_zpid/', fHydrant: 350, fTaxId: 15023178, fZest: 210000 };

let abbyTries = 0;
const calls = [];
function answer(req) {
  const url = new URL(req.url());
  const p = url.pathname;
  if (new URL(req.url()).origin !== SITE || !p.startsWith('/api/')) return false;
  const json = (o, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(o) });
  calls.push(`${p}${url.search}`);
  if (p === '/api/list-content') {
    const dir = url.searchParams.get('dir');
    const src = dir === 'src/content/kids' ? KIDS : dir === 'src/content/partners' ? PARTNERS : {};
    const items = Object.entries(src).map(([slug, c]) => ({ name: `${slug}.json`, path: `${dir}/${slug}.json`, sha: slug, content: c }));
    return json({ success: true, items, count: items.length, total: items.length, pages: 1 });
  }
  if (p === '/api/read-content') {
    const m = (url.searchParams.get('path') || '').match(/^src\/content\/kids\/(.+)\.json$/);
    return m && KIDS[m[1]] ? json({ success: true, content: JSON.stringify(KIDS[m[1]]), sha: m[1] }) : json({ success: false, error: 'Not found' }, 404);
  }
  if (p === '/api/reveals-admin') return json({ success: true, reveals: [], jobs: { colin: '22PCOLIN', amari: '22PAMARI', abby: '22PABBY0', aj: '22PAJ0000', alex: '22PALEX00', ally: '22PALLY00' }, statuses: { colin: 'Build', amari: 'Closed Done', abby: 'Closed Done', aj: 'Closed Done', alex: 'Closed Done', ally: 'Closed Done' } });
  // Ally's read never arrives: the connection drops
  if (p === '/api/job-home' && url.searchParams.get('job') === '22PALLY00') { req.abort('internetdisconnected'); return true; }
  if (p === '/api/job-home') {
    const job = url.searchParams.get('job');
    if (job === '22PCOLIN') return json({ success: true, job: { id: job, name: 'Colin (2026)' }, home: home('22PLOCCOL', COLIN), fields: FIELDS });
    if (job === '22PAMARI') return json({ success: true, job: { id: job, name: 'Amari (2025)' }, home: null, fields: FIELDS });
    if (job === '22PABBY0') {
      abbyTries++;
      if (abbyTries === 1) return json({ success: false, error: 'JobTread returned 500' }, 500);
      return json({ success: true, job: { id: job, name: 'Abby (2019)' }, home: { ...home('22PLOCABB', {}), street: '', address: '9 Oak Lane, Marietta, GA 30060, USA', city: 'Marietta', postalCode: '30060' }, fields: FIELDS });
    }
    if (job === '22PAJ0000') return json({ success: true, job: { id: job, name: 'AJ (2014)' }, home: home('22PLOCAJ0', AJ), fields: AJ_FIELDS });
    return json({ success: false, error: 'JobTread has no such job' }, 404);
  }
  if (p === '/api/sponsors-admin') return json({ success: true, sponsors: [], jobtread: null, pledges: {} });
  if (p === '/api/content-history') return json({ success: true, versions: [], deleted: [] });
  if (p.startsWith('/api/pending-changes')) return json({ success: true, changes: [], publish: { live: null, active: null, failed: null } });
  if (p.startsWith('/api/live-ws')) { req.abort(); return true; }
  return json({ success: true, ok: true });
}

const browser = await puppeteer.launch({ headless: 'shell', args: ['--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
const errors = [];
async function open(width, height = 1000) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|Content Security Policy|live-ws/.test(m.text())) errors.push(m.text().slice(0, 300)); });
  await answerAsks(page);
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.isInterceptResolutionHandled()) return;
    if (answer(req) !== false) return;
    if (req.resourceType() === 'image' && /imagedelivery/.test(req.url())) return req.respond({ status: 200, contentType: 'image/png', body: PNG });
    req.continue();
  });
  await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch {} });
  await page.goto(`${SITE}/admin/index.html#kids`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.kd-row', { timeout: 20000 });
  return page;
}
async function openKid(page, name) {
  for (let i = 0; i < 2; i++) {
    const found = await page.evaluate((n) => {
      const row = [...document.querySelectorAll('.kd-row__name')].find((x) => x.textContent.trim() === n);
      if (row) { row.click(); return true; }
      document.querySelectorAll('.kd-year__btn[aria-expanded="false"]').forEach((b) => b.click());
      return false;
    }, name);
    if (found) break;
    await sleep(400);
  }
  await page.waitForSelector('.kd-ed-head', { timeout: 10000 });
  await sleep(300);
}
const back = async (page) => { await page.evaluate(() => { location.hash = '#kids'; }); await page.waitForSelector('.kd-row', { timeout: 10000 }); await sleep(300); };
const cardText = (page) => page.$eval('.kd-card--home', (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => '');

try {
  console.log('Colin: a full home');
  const page = await open(1440);
  await openKid(page, 'Colin');
  await page.waitForFunction(() => document.querySelector('.kd-card--home .kd-home__addr'), { timeout: 8000 }).catch(() => {});
  ok(calls.filter((c) => c === '/api/job-home?job=22PCOLIN').length === 1, `one read of Colin's home from JobTread (${calls.filter((c) => c.startsWith('/api/job-home')).join(', ')})`);
  // Where it sits on screen, and the order Tab takes: the same
  const cards = await page.$$eval('.kd-rail > *', (els) => els.map((e) => ({ name: [...e.classList].find((c) => /^kd-card--/.test(c)) || e.tagName.toLowerCase(), top: Math.round(e.getBoundingClientRect().top) })));
  const dom = cards.map((c) => c.name);
  const seen = [...cards].sort((a, b) => a.top - b.top).map((c) => c.name);
  ok(dom.indexOf('kd-card--home') === dom.indexOf('kd-card--health') + 1 && JSON.stringify(dom) === JSON.stringify(seen), `in the side panel after Profile health, on screen and in Tab order alike (${seen.join(', ')})`);
  const t = await cardText(page);
  ok(/^HOME 1314 Timuquana Trail Woodstock, GA 30188 Zestimate \$336,500 Zillow/.test(t), `the address, then the Zestimate leading, with Zillow beside it (${t.slice(0, 90)})`);
  const facts = await page.$$eval('.kd-home__facts div', (els) => els.map((d) => [d.querySelector('dt').textContent, d.querySelector('dd').textContent]));
  ok(JSON.stringify(facts) === JSON.stringify([
    ['Living Area', '1,435 sq ft'], ['Bed Bath', '3 bed, 2.5 bath'], ['County', 'Cherokee'], ['Sewer/Septic', 'Septic'], ['Power Company', LONG_POWER],
    ['Water Source', 'Public'], ['Parcel Number', LONG_PARCEL], ['Latest Sale Price', '$128,700'], ['Latest Sale Date', 'Jan 23, 2001'], ['Year Built', '2000'],
  ]), `every other field in JobTread's order, read the way a person reads it (${JSON.stringify(facts)})`);
  ok(!/old\)|REQUIRED|2,000/.test(t), 'no retired field and no bookkeeping');
  ok(/Not filled in yet: Permit Number\./.test(t), 'the empty field is named, so staff know what to fill in');
  const links = await page.$$eval('.kd-card--home a', (as) => as.map((a) => ({ text: a.textContent.trim(), href: a.href, target: a.target, rel: a.rel })));
  ok(links.length === 2 && links[0].text === 'Zillow' && links[0].href === ZILLOW && links[0].target === '_blank' && /noopener/.test(links[0].rel), `Zillow opens in a new tab (${JSON.stringify(links[0])})`);
  ok(links[1].text === 'Change it in JobTread' && links[1].href === 'https://app.jobtread.com/locations/22PLOCCOL' && links[1].target === '_blank', `and the home itself in JobTread, where it's changed (${JSON.stringify(links[1])})`);
  ok(!(await page.$('.kd-card--home input, .kd-card--home textarea, .kd-card--home select')), 'nothing to edit here: JobTread is where it changes');
  // Fits its 300px panel: nothing past the card, the long words wrapped
  const fit = await page.$eval('.kd-card--home', (c) => {
    const box = c.getBoundingClientRect();
    const past = [...c.querySelectorAll('*')].filter((el) => { const r = el.getBoundingClientRect(); return r.width && (r.right > box.right + 0.5 || r.left < box.left - 0.5); }).map((el) => el.className || el.tagName);
    return { width: Math.round(box.width), past, scroll: c.scrollWidth <= c.clientWidth };
  });
  ok(fit.past.length === 0 && fit.scroll && fit.width <= 300, `it fits the side panel, long answers wrapped (${JSON.stringify(fit)})`);
  const axe = await axeScan(page, '.kd-card--home');
  ok(axe.length === 0, `axe finds nothing on the card (${axeText(axe)})`);
  await page.$eval('.kd-card--home', (e) => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
  const r = await page.$eval('.kd-rail', (e) => { const b = e.getBoundingClientRect(); return { x: b.x - 20, y: 0, width: b.width + 40, height: 1000 }; });
  await page.screenshot({ path: join(OUT, '01-colin-panel.png'), clip: r });

  console.log('Every width');
  for (const width of [1440, 1280, 1180, 1100, 1025, 820, 768, 390]) {
    await page.setViewport({ width, height: 1000, deviceScaleFactor: 1 });
    await sleep(300);
    const at = await page.evaluate(() => {
      const c = document.querySelector('.kd-card--home');
      const box = c.getBoundingClientRect();
      const main = document.querySelector('.kd-main').getBoundingClientRect();
      const col = document.querySelector('.main').getBoundingClientRect();
      const past = [...c.querySelectorAll('*')].filter((el) => { const r = el.getBoundingClientRect(); return r.width && (r.right > box.right + 0.5 || r.left < box.left - 0.5); }).length;
      const side = box.left >= main.right - 1;
      return { side, below: box.top >= main.bottom - 1, past, inCol: box.right <= col.right + 0.5 && box.left >= col.left - 0.5, page: document.documentElement.scrollWidth <= document.documentElement.clientWidth };
    });
    ok(at.past === 0 && at.inCol && at.page && (at.side || at.below), `at ${width}px: ${at.side ? 'in the side panel' : 'after the editor'}, nothing past it (${JSON.stringify(at)})`);
    // A label sits on the first line of a value that wraps, here and in the other side cards
    const level = await page.$$eval('.kd-facts div', (rows) => rows.map((d) => {
      // The first line of words on each side (a link's box can be taller than its words)
      const firstLine = (el) => {
        const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
        const node = walk.nextNode();
        if (!node) return el.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getClientRects()[0];
      };
      const dt = firstLine(d.querySelector('dt'));
      const dd = firstLine(d.querySelector('dd'));
      return Math.abs(dt.bottom - dd.bottom) <= 3 ? null : `${d.querySelector('dt').textContent} ${Math.round(dt.bottom - dd.bottom)}px`;
    }).filter(Boolean));
    ok(level.length === 0, `at ${width}px every label sits level with its value's first line (${level.join(', ')})`);
    if (width === 390) {
      await page.$eval('.kd-card--home', (e) => e.scrollIntoView({ block: 'start', behavior: 'instant' }));
      await page.screenshot({ path: join(OUT, '02-colin-phone.png') });
      await page.$eval('.kd-card--site', (e) => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await page.screenshot({ path: join(OUT, '03-on-the-site-phone.png') });
    }
  }
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await sleep(300);

  console.log('Amari: a job with no home');
  await back(page);
  await openKid(page, 'Amari');
  await page.waitForFunction(() => /no home in JobTread/.test(document.querySelector('.kd-card--home')?.innerText || ''), { timeout: 8000 }).catch(() => {});
  const amari = await cardText(page);
  ok(/The job has no home in JobTread yet\. Once it does, its Zillow details show here\./.test(amari) && !/336,500|Timuquana/.test(amari), `says so, and never shows the last kid's home (${amari})`);
  ok(await page.$eval('.kd-card--home a', (a) => a.href) === 'https://app.jobtread.com/jobs/22PAMARI', 'and opens the job, where the home is added');

  console.log('Abby: JobTread fails, then a home with nothing filled in');
  await back(page);
  await openKid(page, 'Abby');
  await page.waitForFunction(() => /Couldn’t read JobTread/.test(document.querySelector('.kd-card--home')?.innerText || ''), { timeout: 8000 }).catch(() => {});
  await page.waitForFunction(() => /didn’t answer/.test(document.querySelector('.kd-card--home')?.innerText || ''), { timeout: 8000 }).catch(() => {});
  ok(/^HOME JobTread didn’t answer just now\. Try again$/.test(await cardText(page)) && !!(await page.$('.kd-card--home [role="alert"]')), `a failure says so in plain words, with Try again (${await cardText(page)})`);
  await page.focus('.kd-card--home .btn');
  await page.keyboard.press('Enter');
  await sleep(50);
  const midFocus = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
  await page.waitForFunction(() => /no details on this home yet/.test(document.querySelector('.kd-card--home')?.innerText || ''), { timeout: 8000 }).catch(() => {});
  const abby = await cardText(page);
  ok(/^HOME 9 Oak Lane, Marietta, GA 30060, USA JobTread has no details on this home yet\. Add details in JobTread/.test(abby), `Try again reads it again; with no street, JobTread's whole address, once (${abby})`);
  const endFocus = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
  ok(midFocus === 'kd-home-h' && endFocus === 'kd-home-h', `focus stays in the card while it reads and after (${midFocus}, ${endFocus})`);
  ok(!/not filled in yet/i.test(abby), 'with nothing filled in, one line says so instead of naming every field');

  console.log('AJ: messy data');
  await back(page);
  await openKid(page, 'AJ');
  await page.waitForFunction(() => document.querySelector('.kd-card--home .kd-home__lead'), { timeout: 8000 }).catch(() => {});
  const aj = await cardText(page);
  const ajLink = await page.$eval('.kd-home__links a', (a) => ({ text: a.textContent.trim(), href: a.href })).catch(() => null);
  ok(ajLink?.text === 'Zillow' && ajLink.href === 'https://www.zillow.com/homedetails/9-Oak-Ln/1_zpid/', `a Zillow link typed without https still opens (${JSON.stringify(ajLink)})`);
  ok(/Tax ID 15023178/.test(aj) && !/\$15,023,178/.test(aj), `an ID reads as typed, never as dollars (${aj.slice(0, 160)})`);
  ok(/Zestimate \$210,000/.test(aj), 'the Zestimate leads');
  ok(/\d+ fields not filled in yet/.test(aj) && !/Extra Field 7/.test(await page.$eval('.kd-home__more', (d) => (d.open ? '' : d.querySelector('summary').textContent))), 'many empty fields fold into one line');
  await page.click('.kd-home__more summary');
  ok(/Extra Field 7/.test(await page.$eval('.kd-home__more', (d) => d.innerText)), 'which opens to name them all');
  for (const width of [1440, 390]) {
    await page.setViewport({ width, height: 1000, deviceScaleFactor: 1 });
    await sleep(300);
    const long = await page.evaluate((name) => {
      const c = document.querySelector('.kd-card--home').getBoundingClientRect();
      const row = [...document.querySelectorAll('.kd-home__facts div')].find((d) => d.querySelector('dt').textContent === name);
      const dt = row.querySelector('dt').getBoundingClientRect();
      const dd = row.querySelector('dd').getBoundingClientRect();
      return { inside: dt.right <= c.right + 0.5 && dt.left >= c.left - 0.5, apart: dt.right <= dd.left + 0.5 };
    }, LONG_FIELD);
    ok(long.inside && long.apart, `at ${width}px a long field name wraps inside the card, clear of its value (${JSON.stringify(long)})`);
    if (width === 390) {
      await page.$eval('.kd-card--home', (e) => e.scrollIntoView({ block: 'start', behavior: 'instant' }));
      await page.screenshot({ path: join(OUT, '04-aj-phone.png') });
    }
  }
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await sleep(300);

  console.log('Alex: a job JobTread no longer has');
  await back(page);
  await openKid(page, 'Alex');
  await page.waitForFunction(() => /anymore/.test(document.querySelector('.kd-card--home')?.innerText || ''), { timeout: 8000 }).catch(() => {});
  const alex = await cardText(page);
  ok(alex === 'HOME This kid’s job isn’t in JobTread anymore, so there’s no home to show.' && !(await page.$('.kd-card--home button')), `says why, with no Try again that couldn't help (${alex})`);

  console.log('Ally: the connection drops');
  await back(page);
  await openKid(page, 'Ally');
  await page.waitForFunction(() => /couldn’t be reached/.test(document.querySelector('.kd-card--home')?.innerText || ''), { timeout: 8000 }).catch(() => {});
  const ally = await cardText(page);
  ok(/^HOME The website couldn’t be reached\. Check the connection, or reload the page if it’s been open a while\. Try again$/.test(ally), `a dropped connection says so, not that JobTread failed (${ally})`);

  console.log('Adam: no job');
  await back(page);
  await openKid(page, 'Adam');
  await sleep(500);
  ok(!(await page.$('.kd-card--home')), 'no job, no Home card (On the site already says no job matches)');
  ok(!calls.some((c) => c === '/api/job-home?job=' || /job=undefined|job=null/.test(c)), 'and no read of JobTread for it');

  console.log('Loading');
  await back(page);
  // The card holds its shape while JobTread answers, and says it's reading
  await page.setRequestInterception(false);
  await page.setRequestInterception(true);
  page.removeAllListeners('request');
  page.on('request', async (req) => {
    if (req.isInterceptResolutionHandled()) return;
    if (new URL(req.url()).pathname === '/api/job-home') { await sleep(1500); }
    if (answer(req) !== false) return;
    if (req.resourceType() === 'image' && /imagedelivery/.test(req.url())) return req.respond({ status: 200, contentType: 'image/png', body: PNG });
    req.continue();
  });
  await openKid(page, 'Colin');
  const loading = await page.evaluate(() => ({ skel: document.querySelectorAll('.kd-card--home .skel').length, status: document.querySelector('.kd-card--home [role="status"]')?.textContent, busy: document.querySelector('.kd-card--home')?.getAttribute('aria-busy') }));
  ok(loading.skel >= 4 && /Reading the home from JobTread/.test(loading.status || '') && loading.busy === 'true', `while it reads: still blocks, a status for screen readers (${JSON.stringify(loading)})`);
  await page.waitForFunction(() => document.querySelector('.kd-card--home .kd-home__lead'), { timeout: 8000 }).catch(() => {});
  ok(await page.$eval('.kd-card--home', (e) => e.getAttribute('aria-busy')) === 'false', 'then the home');
  await page.close();
} catch (e) {
  failures.push(`crashed: ${e.message}`);
  console.error(e);
} finally {
  await browser.close();
}
ok(errors.length === 0, `no console errors (${errors.slice(0, 3).join(' | ')})`);
writeFileSync(join(OUT, 'result.json'), JSON.stringify({ failures }, null, 2));
console.log(failures.length ? `\n${failures.length} failed:\n- ${failures.join('\n- ')}` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
