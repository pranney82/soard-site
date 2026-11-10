/**
 * test-kid-kit-emails.mjs — the "Emails in Kit" card on a kid in Admin → Kids, in a real browser
 * ===========================================================================
 * The kid's reveal invite, whole-list invite, Project Kickoff and Project Reveal: where each stands
 * in Kit, and Draft in Kit to make one now (functions/api/kid-kit-emails.js).
 * The admin is served as-is from public/ and every /api/* call is answered
 * here, in each state a kid's emails can be in:
 *   - Colin: in build, nothing drafted; Draft in Kit makes the Kickoff, then
 *     the invite and the whole-list invite (each with Colin's JobTread job), and each row turns to Open in Kit
 *   - Amari: finished: the invite is over, the Kickoff would be untrue, the
 *     Project Reveal was never drafted on its own and the page lacks its video;
 *     drafting it fails once and says why
 *   - Abby: every state Kit can report: sent, scheduled, a draft to hold, and Kit
 *     drafts paused (no Draft buttons, Open in Kit still there)
 *   - Adam: no JobTread job, so no invite; deleted in Kit, so Draft it again
 *   - Alex: Kit can't be read (Try again)
 * Checks where the card sits, that it waits for JobTread's job before asking
 * Kit, what each row says, what each button sends, every width from 1440 to
 * 390, 44px targets on touch, axe, and console errors. Screenshots in
 * test-results/kid-kit-emails/.
 *
 *   SITE=http://127.0.0.1:4473 node scripts/test-kid-kit-emails.mjs   (SITE serves public/)
 */
import puppeteer from 'puppeteer';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { axeScan, axeText } from './lib/axe.mjs';
import { answerAsks } from './lib/ask.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/kid-kit-emails/');
mkdirSync(OUT, { recursive: true });
const SITE = (process.env.SITE || 'http://127.0.0.1:4473').replace(/\/$/, '');
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readDir = (d) => Object.fromEntries(readdirSync(join(ROOT, 'src/content', d)).filter((f) => f.endsWith('.json'))
  .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(ROOT, 'src/content', d, f), 'utf8'))]));
const KIDS = readDir('kids');
for (const [slug, d] of Object.entries(KIDS)) d.slug ||= slug;
const PARTNERS = readDir('partners');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');
const KIT = (id) => `https://app.kit.com/campaigns/${id}`;
const WHEN = '2026-11-12T19:30:00Z';

// What Kit has for each kid, as /api/kid-kit-emails answers it
const none = { state: 'none', block: null, missing: [], error: null };
const kit = {
  colin: { off: null, invite: { state: 'none', block: null }, watch: { state: 'none', block: null }, kickoff: { ...none }, reveal: { ...none, block: 'Ready once the kid is Completed: this email says the room is done', missing: ['at least 3 photos', 'the reveal video'] } },
  amari: { off: null, invite: { state: 'none', block: 'The reveal is over' }, watch: { state: 'none', block: 'The reveal is over' }, kickoff: { ...none, block: 'The makeover is finished, and this email says it’s still to come' }, reveal: { ...none, state: 'skipped', missing: ['the reveal video'] } },
  abby: { off: 'Kit drafts are off while reveal invites are paused (Reveals → Invites)', invite: { state: 'draft', id: 501, url: KIT(501), held: 'the job is on hold' },
    watch: { state: 'sent', id: 505, url: KIT(505), at: '2026-10-01T15:00:00Z' },
    kickoff: { ...none, state: 'sent', id: 502, url: KIT(502), at: '2026-10-02T14:05:00Z' }, reveal: { ...none, state: 'scheduled', id: 503, url: KIT(503), at: WHEN } },
  adam: { off: null, invite: { state: 'nojob' }, watch: { state: 'nojob' }, kickoff: { ...none, block: 'The makeover is finished, and this email says it’s still to come' }, reveal: { ...none, state: 'deleted', id: 504, url: KIT(504) } },
};
const posts = [];
const calls = [];
let jobsDelay = 0;
let amariFails = 1;
let alexTries = 0;

async function answer(req) {
  const url = new URL(req.url());
  const p = url.pathname;
  if (url.origin !== SITE || !p.startsWith('/api/')) return false;
  const json = (o, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(o) });
  calls.push(`${req.method()} ${p}${url.search}`);
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
  if (p === '/api/reveals-admin') {
    if (jobsDelay) await sleep(jobsDelay);
    return json({ success: true, reveals: [], jobs: { colin: '22PCOLIN', amari: '22PAMARI', abby: '22PABBY0', alex: '22PALEX00' }, statuses: { colin: 'Build', amari: 'Closed Done', abby: 'Closed Done', alex: 'Closed Done' } });
  }
  if (p === '/api/kid-kit-emails' && req.method() === 'GET') {
    const slug = url.searchParams.get('slug');
    if (slug === 'alex' && ++alexTries === 1) return json({ ok: false, error: 'Kit didn’t answer just now' }, 500);
    const d = kit[slug] || { off: null, invite: { state: 'none', block: null }, watch: { state: 'none', block: null }, kickoff: { ...none }, reveal: { ...none } };
    return json({ ok: true, ...d });
  }
  if (p === '/api/kid-kit-emails' && req.method() === 'POST') {
    const body = JSON.parse(req.postData() || '{}');
    posts.push(body);
    await sleep(400);
    if (body.slug === 'amari' && body.kind === 'reveal' && amariFails-- > 0) return json({ ok: false, made: false, project: 'error', error: 'Kit didn’t take Amari’s Project Reveal email.' });
    const id = 9000 + posts.length;
    const k = kit[body.slug];
    if (k) k[body.kind] = { ...none, state: 'draft', id, url: KIT(id), at: new Date().toISOString() };
    return json({ ok: true, made: true, ...(['invite', 'watch'].includes(body.kind) ? { kit: 'drafted' } : { project: 'drafted' }), id, url: KIT(id) });
  }
  if (p === '/api/job-home') return json({ success: true, job: { id: url.searchParams.get('job'), name: '' }, home: null, fields: [] });
  if (p === '/api/sponsors-admin') return json({ success: true, sponsors: [], jobtread: null, pledges: {} });
  if (p === '/api/content-history') return json({ success: true, versions: [], deleted: [] });
  if (p.startsWith('/api/pending-changes')) return json({ success: true, changes: [], publish: { live: null, active: null, failed: null } });
  if (p.startsWith('/api/live-ws')) { req.abort(); return true; }
  return json({ success: true, ok: true });
}

const browser = await puppeteer.launch({ headless: 'shell', args: ['--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
const errors = [];
async function open(width, height = 1000, { touch = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1, hasTouch: touch, isMobile: touch });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|Content Security Policy|live-ws/.test(m.text())) errors.push(m.text().slice(0, 300)); });
  await answerAsks(page);
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    if (req.isInterceptResolutionHandled()) return;
    if ((await answer(req)) !== false) return;
    if (req.resourceType() === 'image' && /imagedelivery/.test(req.url())) return req.respond({ status: 200, contentType: 'image/png', body: PNG });
    req.continue();
  });
  await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch {} });
  await page.goto(`${SITE}/admin/index.html#kids`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.kd-row', { timeout: 20000 });
  return page;
}
async function openKid(page, name) {
  for (let i = 0; i < 4; i++) {
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
const ready = (page) => page.waitForFunction(() => document.querySelector('.kd-card--kit .kd-kit, .kd-card--kit [role="alert"]'), { timeout: 8000 }).catch(() => {});
const rows = (page) => page.$$eval('.kd-card--kit .kd-kit__row', (els) => els.map((e) => ({
  name: e.querySelector('strong').textContent.trim(),
  word: e.querySelector('.kd-kit__word').textContent.trim(),
  note: e.querySelector('.kd-kit__note').textContent.replace(/\s+/g, ' ').trim(),
  buttons: [...e.querySelectorAll('button')].map((b) => b.textContent.replace(/\s+/g, ' ').trim()),
  links: [...e.querySelectorAll('a')].map((a) => ({ text: a.textContent.trim(), href: a.href, target: a.target, rel: a.rel })),
  tone: [...e.classList].find((c) => c.startsWith('is-')),
})));
const row = async (page, name) => (await rows(page)).find((r) => r.name === name);
const press = async (page, rowName, text) => page.evaluate((rowName, text) => {
  const li = [...document.querySelectorAll('.kd-card--kit .kd-kit__row')].find((e) => e.querySelector('strong').textContent.trim() === rowName);
  const b = [...(li?.querySelectorAll('button') || [])].find((x) => x.textContent.trim() === text);
  b?.click();
  return !!b;
}, rowName, text);
const toasts = (page) => page.$$eval('.toast, [class*="toast"]', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean)).catch(() => []);

try {
  console.log('Colin: in build, nothing drafted yet');
  jobsDelay = 1200;
  const page = await open(1440);
  await openKid(page, 'Colin');
  // Before JobTread answers, the card waits: never "No job" for a kid who has one. (The list may have read
  // JobTread already, in which case the card reads Kit at once; either way, never without the job.)
  const early = calls.filter((c) => c.startsWith('GET /api/kid-kit-emails'));
  const loading = await page.evaluate(() => ({ text: document.querySelector('.kd-card--kit')?.innerText || '', busy: document.querySelector('.kd-card--kit')?.getAttribute('aria-busy') }));
  ok(early.every((c) => /jobId=22PCOLIN/.test(c)) && (early.length > 0 || (/Reading Kit/.test(loading.text) && loading.busy === 'true')), `Kit is never read without Colin’s job, and it says it's reading meanwhile (${early.join(', ')} ${JSON.stringify(loading).slice(0, 80)})`);
  await ready(page);
  jobsDelay = 0;
  const reads = calls.filter((c) => c.startsWith('GET /api/kid-kit-emails'));
  ok(reads.length === 1 && reads[0] === 'GET /api/kid-kit-emails?slug=colin&jobId=22PCOLIN', `one read, with Colin's job (${reads.join(', ')})`);

  const cards = await page.$$eval('.kd-rail > *', (els) => els.map((e) => ({ name: [...e.classList].find((c) => /^kd-card--/.test(c)) || e.tagName.toLowerCase(), top: Math.round(e.getBoundingClientRect().top) })));
  const dom = cards.map((c) => c.name);
  const seen = [...cards].sort((a, b) => a.top - b.top).map((c) => c.name);
  ok(dom.indexOf('kd-card--kit') === dom.indexOf('kd-card--site') - 1 && JSON.stringify(dom) === JSON.stringify(seen), `just above On the site, on screen and in Tab order alike (${seen.join(', ')})`);
  const head = await page.$eval('.kd-card--kit', (e) => e.innerText.split('\n').filter(Boolean).slice(0, 2).join(' | '));
  ok(/^Emails in Kit \| Drafts only\. Nothing goes out until someone sends it from Kit\.$/i.test(head), `it says up front that these are drafts only (${head})`);

  let r = await rows(page);
  ok(JSON.stringify(r.map((x) => x.name)) === JSON.stringify(['Reveal invite', 'Whole-list invite', 'Project Kickoff', 'Project Reveal']), `the four emails, the two invites together, in the order they go out (${r.map((x) => x.name).join(', ')})`);
  ok(r[0].word === 'Not drafted' && r[0].note === 'Drafts itself once JobTread confirms the reveal with a time.' && JSON.stringify(r[0].buttons) === '["Draft in Kit"]', `invite: when it drafts itself, and Draft in Kit (${JSON.stringify(r[0])})`);
  ok(r[1].word === 'Not drafted' && r[1].note === 'No address, to watch live. Drafts itself with the reveal invite.' && JSON.stringify(r[1].buttons) === '["Draft in Kit"]', `whole-list invite: what it is, when it drafts itself, and Draft in Kit (${JSON.stringify(r[1])})`);
  ok(r[2].word === 'Not drafted' && r[2].note === 'Drafts itself when Set Start Date is checked off in JobTread.' && JSON.stringify(r[2].buttons) === '["Draft in Kit"]', `kickoff: the same (${JSON.stringify(r[2])})`);
  ok(r[3].note === 'Ready once the kid is Completed: this email says the room is done.' && r[3].buttons.length === 0, `Project Reveal: held back, and why, with no button (${JSON.stringify(r[3])})`);

  const t0 = Date.now();
  ok(await press(page, 'Project Kickoff', 'Draft in Kit'), 'Draft in Kit on the Kickoff');
  await sleep(80);
  const mid = await page.evaluate(() => [...document.querySelectorAll('.kd-card--kit button')].map((b) => ({ t: b.textContent.trim(), d: b.disabled })));
  ok(mid.some((b) => b.t === 'Drafting…') && mid.every((b) => b.d), `while it drafts: "Drafting…", and no second press anywhere on the card (${JSON.stringify(mid)})`);
  await page.waitForFunction(() => /Open in Kit/.test([...document.querySelectorAll('.kd-card--kit .kd-kit__row')][2]?.innerText || ''), { timeout: 8000 }).catch(() => {});
  ok(JSON.stringify(posts[0]) === JSON.stringify({ slug: 'colin', kind: 'kickoff', jobId: '22PCOLIN' }), `it asks for the kid's Kickoff (${JSON.stringify(posts[0])})`);
  const tk = (await toasts(page)).join(' | ');
  ok(/Colin’s Project Kickoff is drafted in Kit\. Nothing is sent until someone sends it there/.test(tk), `and says it's a draft (${tk})`);
  r = await rows(page);
  ok(r[2].word === 'Draft' && /^Drafted .+\. Waiting for someone to review it and send it from Kit\.$/.test(r[2].note) && r[2].buttons.length === 0, `then: a draft, waiting for someone to send it (${JSON.stringify(r[2])})`);
  ok(r[2].links[0]?.text === 'Open in Kit' && r[2].links[0].href === KIT(9001) && r[2].links[0].target === '_blank' && /noopener/.test(r[2].links[0].rel), `with Open in Kit, in a new tab (${JSON.stringify(r[2].links)})`);
  ok(Date.now() - t0 < 6000, 'quickly');

  await press(page, 'Reveal invite', 'Draft in Kit');
  await page.waitForFunction(() => /Open in Kit/.test(document.querySelector('.kd-card--kit .kd-kit__row')?.innerText || ''), { timeout: 8000 }).catch(() => {});
  ok(JSON.stringify(posts[1]) === JSON.stringify({ slug: 'colin', kind: 'invite', jobId: '22PCOLIN' }), `the invite goes with Colin's JobTread job (${JSON.stringify(posts[1])})`);
  ok(/Colin’s reveal invite is drafted in Kit/.test((await toasts(page)).join(' | ')), 'named in plain words');

  await press(page, 'Whole-list invite', 'Draft in Kit');
  await page.waitForFunction(() => /Open in Kit/.test([...document.querySelectorAll('.kd-card--kit .kd-kit__row')][1]?.innerText || ''), { timeout: 8000 }).catch(() => {});
  ok(JSON.stringify(posts[2]) === JSON.stringify({ slug: 'colin', kind: 'watch', jobId: '22PCOLIN' }), `the whole-list invite goes with Colin's JobTread job too (${JSON.stringify(posts[2])})`);
  ok(/Colin’s whole-list invite is drafted in Kit/.test((await toasts(page)).join(' | ')), `named in plain words, lowercase mid-sentence (${(await toasts(page)).join(' | ')})`);
  ok((await row(page, 'Whole-list invite')).word === 'Draft', 'and its row turns to a draft');

  const axe = await axeScan(page, '.kd-card--kit');
  ok(axe.length === 0, `axe finds nothing on the card (${axeText(axe)})`);
  await page.$eval('.kd-card--kit', (e) => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
  const clip = await page.$eval('.kd-rail', (e) => { const b = e.getBoundingClientRect(); return { x: b.x - 20, y: 0, width: b.width + 40, height: 1000 }; });
  await page.screenshot({ path: join(OUT, '01-colin-panel.png'), clip });

  console.log('Every width');
  for (const width of [1440, 1280, 1180, 1100, 1025, 820, 768, 390]) {
    await page.setViewport({ width, height: 1000, deviceScaleFactor: 1 });
    await sleep(300);
    const at = await page.evaluate(() => {
      const c = document.querySelector('.kd-card--kit');
      const box = c.getBoundingClientRect();
      const main = document.querySelector('.kd-main').getBoundingClientRect();
      const col = document.querySelector('.main').getBoundingClientRect();
      const past = [...c.querySelectorAll('*')].filter((el) => { const r = el.getBoundingClientRect(); return r.width && (r.right > box.right + 0.5 || r.left < box.left - 0.5); }).length;
      // A state word never lands under the email's name
      const level = [...c.querySelectorAll('.kd-kit__top')].every((t) => Math.abs(t.querySelector('strong').getBoundingClientRect().top - t.querySelector('.kd-kit__word').getBoundingClientRect().top) < 8);
      return { side: box.left >= main.right - 1, below: box.top >= main.bottom - 1, past, level, inCol: box.right <= col.right + 0.5 && box.left >= col.left - 0.5, page: document.documentElement.scrollWidth <= document.documentElement.clientWidth };
    });
    ok(at.past === 0 && at.level && at.inCol && at.page && (at.side || at.below), `at ${width}px: ${at.side ? 'in the side panel' : 'after the editor'}, nothing past it (${JSON.stringify(at)})`);
    if (width === 390) {
      await page.$eval('.kd-card--kit', (e) => e.scrollIntoView({ block: 'start', behavior: 'instant' }));
      await page.screenshot({ path: join(OUT, '02-colin-phone.png') });
    }
  }
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await sleep(300);

  console.log('Amari: finished');
  await back(page);
  await openKid(page, 'Amari');
  await ready(page);
  r = await rows(page);
  ok(r[0].note === 'The reveal is over.' && r[0].buttons.length === 0, `invite: over, no button (${JSON.stringify(r[0])})`);
  ok(r[1].note === 'The reveal is over.' && r[1].buttons.length === 0, `whole-list invite: over too, no button (${JSON.stringify(r[1])})`);
  ok(r[2].note === 'The makeover is finished, and this email says it’s still to come.' && r[2].buttons.length === 0, `kickoff: would be untrue, no button (${JSON.stringify(r[2])})`);
  ok(r[3].note === 'Missing on the page: the reveal video. Won’t draft itself for this kid.' && JSON.stringify(r[3].buttons) === '["Draft in Kit"]', `Project Reveal: what's missing, that it won't come on its own, and Draft in Kit (${JSON.stringify(r[3])})`);
  await press(page, 'Project Reveal', 'Draft in Kit');
  await page.waitForFunction(() => [...document.querySelectorAll('.kd-card--kit button')].every((b) => !b.disabled), { timeout: 8000 }).catch(() => {});
  await sleep(300);
  const fail = (await toasts(page)).join(' | ');
  ok(/Kit didn’t take Amari’s Project Reveal email\./.test(fail), `a failure says what happened (${fail})`);
  ok(JSON.stringify((await row(page, 'Project Reveal')).buttons) === '["Draft in Kit"]', 'and the button is there to try again');
  await press(page, 'Project Reveal', 'Draft in Kit');
  await page.waitForFunction(() => /Open in Kit/.test([...document.querySelectorAll('.kd-card--kit .kd-kit__row')][3]?.innerText || ''), { timeout: 8000 }).catch(() => {});
  ok((await row(page, 'Project Reveal')).word === 'Draft', 'the second press drafts it');
  await page.$eval('.kd-card--kit', (e) => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await page.screenshot({ path: join(OUT, '03-amari-panel.png'), clip });

  console.log('Abby: sent, scheduled, hold it, and Kit drafts paused');
  await back(page);
  await openKid(page, 'Abby');
  await ready(page);
  r = await rows(page);
  const off = await page.$eval('.kd-card--kit .kd-kit__off', (e) => e.textContent.trim()).catch(() => '');
  ok(off === 'Kit drafts are off while reveal invites are paused (Reveals → Invites).', `paused: says so once, at the top (${off})`);
  ok(!(await page.$('.kd-card--kit button')), 'and there is no Draft button anywhere');
  ok(r[0].word === 'Hold it' && r[0].tone === 'is-warn' && r[0].note === 'JobTread says the job is on hold.' && r[0].links[0]?.href === KIT(501), `a draft JobTread says may be off: Hold it, with Open in Kit (${JSON.stringify(r[0])})`);
  ok(r[1].word === 'Sent' && r[1].tone === 'is-done' && /^Sent from Kit Oct 1, .+\.$/.test(r[1].note) && r[1].links[0]?.href === KIT(505), `whole-list invite sent: when (${JSON.stringify(r[1])})`);
  ok(r[2].word === 'Sent' && r[2].tone === 'is-done' && /^Sent from Kit Oct 2, .+\.$/.test(r[2].note) && r[2].links[0]?.href === KIT(502), `sent: when (${JSON.stringify(r[2])})`);
  ok(r[3].word === 'Scheduled' && /^Scheduled in Kit for Nov 12, .+\.$/.test(r[3].note) && r[3].links[0]?.href === KIT(503), `scheduled: for when (${JSON.stringify(r[3])})`);
  await page.$eval('.kd-card--kit', (e) => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await page.screenshot({ path: join(OUT, '04-abby-panel.png'), clip });
  const axe2 = await axeScan(page, '.kd-card--kit');
  ok(axe2.length === 0, `axe finds nothing here either (${axeText(axe2)})`);

  console.log('Adam: no job, and a draft deleted in Kit');
  await back(page);
  await openKid(page, 'Adam');
  await ready(page);
  ok(calls.includes('GET /api/kid-kit-emails?slug=adam'), 'read with no job');
  r = await rows(page);
  ok(r[0].word === 'No job' && r[0].note === 'No JobTread job matches this kid, so there’s no reveal to invite to.' && r[0].buttons.length === 0, `invite: no job, so nothing to invite to (${JSON.stringify(r[0])})`);
  ok(r[1].word === 'No job' && r[1].buttons.length === 0, `whole-list invite: no job either (${JSON.stringify(r[1])})`);
  ok(r[3].word === 'Deleted' && r[3].note === 'Deleted in Kit. You can draft it again.' && JSON.stringify(r[3].buttons) === '["Draft it again"]' && r[3].links.length === 0, `deleted in Kit: Draft it again, and nothing to open (${JSON.stringify(r[3])})`);
  await press(page, 'Project Reveal', 'Draft it again');
  await page.waitForFunction(() => /Open in Kit/.test([...document.querySelectorAll('.kd-card--kit .kd-kit__row')][3]?.innerText || ''), { timeout: 8000 }).catch(() => {});
  ok(JSON.stringify(posts.at(-1)) === JSON.stringify({ slug: 'adam', kind: 'reveal' }), `with no job, none is sent (${JSON.stringify(posts.at(-1))})`);

  console.log('Alex: Kit can’t be read');
  await back(page);
  await openKid(page, 'Alex');
  await ready(page);
  const alex = await page.$eval('.kd-card--kit', (e) => e.innerText.replace(/\s+/g, ' ').trim());
  ok(/Kit didn’t answer just now/.test(alex) && !!(await page.$('.kd-card--kit [role="alert"]')), `says so (${alex})`);
  await page.evaluate(() => [...document.querySelectorAll('.kd-card--kit button')].find((b) => b.textContent.trim() === 'Try again')?.click());
  await page.waitForFunction(() => document.querySelector('.kd-card--kit .kd-kit'), { timeout: 8000 }).catch(() => {});
  ok((await rows(page)).length === 4, 'Try again reads it again');

  await page.close();

  console.log('Phone, touch: 44px targets');
  const phone = await open(390, 844, { touch: true });
  await openKid(phone, 'Colin');
  await ready(phone);
  const small = await phone.$$eval('.kd-card--kit button, .kd-card--kit a', (els) => els.map((e) => ({ t: e.textContent.trim(), h: Math.round(e.getBoundingClientRect().height) })).filter((x) => x.h < 44));
  ok(small.length === 0, `every button and link is 44px tall on touch (${JSON.stringify(small)})`);
  await phone.$eval('.kd-card--kit', (e) => e.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await phone.screenshot({ path: join(OUT, '05-phone-touch.png') });
  await phone.close();
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
