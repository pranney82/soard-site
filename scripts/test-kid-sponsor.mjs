/**
 * test-kid-sponsor.mjs — Admin → Kids → Monetary sponsor, in a real browser
 * ==========================================================================
 * The website is the source of truth for who pays for a kid's room
 * (functions/api/_sponsors.js). The admin is loaded from an Astro dev server
 * with every /api/* call answered from in-memory copies of src/content/kids and
 * src/content/partners, plus a small JobTread (each job's Monetary Sponsor
 * field and who has access). Checks, at 1440px and 390px:
 *   - an awaiting-funding kid: the card sits right under Status, asks who's
 *     paying, the list and the checklist flag it
 *   - JobTread's suggestion ("Use <partner>") picks the sponsor, puts their
 *     logo first in Partners, and Save sends the sync: the contact added to
 *     the job as a Sponsor first, then the Monetary Sponsor field mirroring
 *     who has that access; the toast and the card say so
 *   - searching Partners by keyboard, "Add “…” as a new sponsor" with a logo
 *     and a private contact (never in the saved partner record)
 *   - editing contacts, taking the sponsor off (Undo), History naming them
 *   - a bad email is refused; phone: no sideways scroll, 44px targets; axe
 * Screenshots land in test-results/kid-sponsor/. Exits non-zero on any failure.
 *
 *   SITE=http://localhost:4321 node scripts/test-kid-sponsor.mjs
 * Without SITE it starts `astro dev` on a spare port and stops it after.
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { answerAsks } from './lib/ask.mjs';
import { axeScan, axeText } from './lib/axe.mjs';
import { sponsorView, mirrorText, fromSponsor, cleanPeople } from '../functions/api/_sponsors.js';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/kid-sponsor/');
mkdirSync(OUT, { recursive: true });
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let SITE = process.env.SITE?.replace(/\/$/, '');
let dev = null;
if (!SITE) {
  const port = 4300 + Math.floor(Math.random() * 600);
  dev = spawn('npx', ['astro', 'dev', '--port', String(port)], { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TZ: 'UTC' } });
  SITE = `http://localhost:${port}`;
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('astro dev did not start within 2 minutes')), 120000);
    const seen = (b) => { if (/Local\s+http/.test(String(b))) { clearTimeout(t); resolve(); } };
    dev.stdout.on('data', seen);
    dev.stderr.on('data', seen);
    dev.on('exit', (code) => { clearTimeout(t); reject(new Error(`astro dev exited (${code})`)); });
  });
}
const stopDev = () => { if (dev) try { process.kill(-dev.pid); } catch {} };

const readDir = (d) => Object.fromEntries(readdirSync(join(ROOT, 'src/content', d)).filter((f) => f.endsWith('.json'))
  .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(ROOT, 'src/content', d, f), 'utf8'))]));
const PARTNERS0 = readDir('partners');
const KIDS0 = readDir('kids');
for (const [slug, d] of Object.entries(KIDS0)) d.slug ||= slug;
const PNG = join(OUT, 'pixel.png');
writeFileSync(PNG, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64'));

// The kid awaiting funding, and a sponsor JobTread already names on its job
const KID = Object.values(KIDS0).find((k) => k.status === 'needs-funding');
const VOILA = PARTNERS0['the-voila-foundation'];
if (!KID || !VOILA) { console.log('Needs an awaiting-funding kid and The Voila Foundation in src/content'); process.exit(1); }
const JOB = '22PJOBSPONS1';

function makeApi() {
  const st = {
    kids: structuredClone(KIDS0), partners: structuredClone(PARTNERS0), contacts: {}, calls: [], versions: {}, syncs: [],
    jobs: { [JOB]: { id: JOB, name: `${KID.name} (${KID.year})`, closedOn: null, field: 'Voila Foundation',
      people: [{ membershipId: 'm1', name: 'Dana Reed', email: 'dana@voilafdn.org', role: 'Sponsor', company: 'The Voila Foundation' }] } },
  };
  const partnerList = () => Object.values(st.partners).map((p) => ({ slug: p.slug, name: p.name, website: p.website || '', logo: p.logo || '' }));
  const chosenOf = (slug) => (st.kids[slug].sponsors || []).map((s) => partnerList().find((p) => p.slug === s)).filter(Boolean);
  const jobNow = () => ({ ...st.jobs[JOB], access: st.jobs[JOB].people.map((x) => ({ email: x.email, role: x.role })) });
  const view = (slug) => {
    const v = sponsorView(jobNow(), chosenOf(slug), st.contacts, {}, partnerList());
    return { sponsors: v.sponsors, jobtread: { ...v.job, others: v.others } };
  };
  const respond = (req) => {
    const url = new URL(req.url());
    const json = (o, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(o) });
    const body = () => { try { return JSON.parse(req.postData() || '{}'); } catch { return {}; } };
    const p = url.pathname;
    if (!p.startsWith('/api/')) return false;
    const isPost = req.method() === 'POST';
    st.calls.push({ path: p, method: req.method(), body: isPost && !/upload-image/.test(p) ? body() : null, query: url.search });
    if (p === '/api/list-content') {
      const dir = url.searchParams.get('dir');
      const src = dir === 'src/content/kids' ? st.kids : dir === 'src/content/partners' ? st.partners : {};
      const items = Object.entries(src).map(([slug, c]) => ({ name: `${slug}.json`, path: `${dir}/${slug}.json`, sha: slug, content: c }));
      return json({ success: true, items, count: items.length, total: items.length, pages: 1 });
    }
    if (p === '/api/read-content') {
      const m = url.searchParams.get('path').match(/^src\/content\/kids\/(.+)\.json$/);
      const c = m && st.kids[m[1]];
      return c ? json({ success: true, content: c, sha: `sha-${m[1]}-${JSON.stringify(c).length}` }) : json({ success: false, error: 'Not found' }, 404);
    }
    if (p === '/api/save-content') {
      const b = body();
      const [, dir, slug] = b.path.match(/content\/(kids|partners)\/(.+)\.json$/) || [];
      const rec = JSON.parse(b.content);
      if (dir === 'partners') { st.partners[slug] = rec; return json({ success: true, sha: `sha-${slug}` }); }
      const before = st.kids[slug];
      st.kids[slug] = rec;
      const list = (st.versions[slug] ||= []);
      if (!list.length) list.push({ id: 1, at: new Date(Date.now() - 60000).toISOString(), by: null, data: before });
      list.push({ id: list.length + 1, at: new Date().toISOString(), by: 'staff@soardcharity.com', data: rec });
      return json({ success: true, sha: `sha-${slug}-${Date.now()}` });
    }
    if (p === '/api/content-history') {
      const q = url.searchParams;
      if (q.get('deleted')) return json({ success: true, deleted: [] });
      const list = st.versions[q.get('slug')] || [];
      if (q.get('id')) { const v = list.find((x) => x.id === Number(q.get('id'))); return json({ success: true, data: v?.data }); }
      return json({ success: true, versions: list.map((v) => ({ id: v.id, at: v.at, by: v.by, changed: null })).reverse() });
    }
    if (p === '/api/sponsors-admin') {
      const q = url.searchParams;
      if (!isPost && q.get('kid')) return json({ success: true, ...view(q.get('kid')) });
      if (!isPost) return json({ success: true, contacts: Object.fromEntries(q.get('partners').split(',').map((s) => [s, st.contacts[s] || []])) });
      const b = body();
      if (b.contacts) {
        try { st.contacts[b.contacts.partner] = cleanPeople(b.contacts.people); } catch (e) { return json({ success: false, error: e.message }, 400); }
        return json({ success: true, contacts: st.contacts[b.contacts.partner], granted: [], problems: [] });
      }
      if (b.sync) {
        // As _sponsors.js does it: job access first (taken off, then added), then the field mirrors it
        const job = st.jobs[b.sync.job];
        const chosen = chosenOf(b.sync.kid);
        const done = { wrote: null, granted: [], removed: [], filled: [], adopted: [], problems: [] };
        for (const p of (b.sync.previous || []).filter((x) => !chosen.some((c) => c.slug === x)).map((x) => partnerList().find((y) => y.slug === x)).filter(Boolean)) {
          for (const x of job.people.filter((y) => y.role === 'Sponsor' && fromSponsor(y, p, { contacts: st.contacts[p.slug] || [] }))) {
            job.people = job.people.filter((y) => y !== x);
            done.removed.push({ slug: p.slug, name: x.name, email: x.email });
          }
        }
        for (const c of chosen.flatMap((x) => st.contacts[x.slug] || [])) {
          if (!c.email || job.people.some((x) => x.email === c.email)) continue;
          job.people.push({ membershipId: `m${job.people.length + 1}`, name: c.name, email: c.email, role: 'Sponsor', company: null });
          done.granted.push({ name: c.name || c.email, email: c.email, role: 'Sponsor', kept: false });
        }
        const mirror = mirrorText(jobNow(), chosen, partnerList(), st.contacts);
        if (mirror !== job.field) { done.wrote = { from: job.field, to: mirror }; job.field = mirror; }
        st.syncs.push({ granted: done.granted.length, wrote: !!done.wrote });
        return json({ success: true, ...view(b.sync.kid), ...done });
      }
      return json({ success: false, error: 'Nothing to do' }, 400);
    }
    if (p === '/api/upload-image') return json({ success: true, imageId: 'partners/new/1', imageUrl: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/partners/new/1/public' });
    if (p === '/api/reveals-admin') return json({ success: true, reveals: [], jobs: { [KID.slug]: JOB }, statuses: { [KID.slug]: 'Awaiting Funding' } });
    if (p.startsWith('/api/pending-changes')) return json({ success: true, changes: [], publish: { live: null, active: null, failed: null, typicalSeconds: 480 } });
    if (p.startsWith('/api/audit-log')) return json({ success: true, entries: [], total: 0 });
    if (p.startsWith('/api/deployments')) return json({ success: true, deploys: [], source: 'cloudflare' });
    if (p.startsWith('/api/live-ws')) { req.abort(); return true; }
    return json({ success: true, ok: true });
  };
  return { st, respond };
}

async function open(browser, { width, height, mobile }) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|net::ERR/.test(m.text())) errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 300)}`));
  await answerAsks(page);
  const api = makeApi();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.isInterceptResolutionHandled()) return;
    if (new URL(req.url()).origin === SITE && api.respond(req) !== false) return;
    if (req.resourceType() === 'image' && /imagedelivery|i\.ytimg|videodelivery/.test(req.url())) return req.respond({ status: 200, contentType: 'image/png', body: readFileSync(PNG) });
    req.continue();
  });
  await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch {} });
  await page.goto(`${SITE}/admin/index.html`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.nav-item, .sidebar', { timeout: 20000 });
  return { page, api, errors };
}
const clickText = (page, sel, text) => page.evaluate((sel, text) => {
  const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.replace(/\s+/g, ' ').trim().startsWith(text));
  if (el) el.click();
  return !!el;
}, sel, text);
async function goKids(page, mobile) {
  if (mobile) { await page.evaluate(() => document.querySelector('.hamburger')?.click()); await sleep(350); }
  await clickText(page, '.nav-item', 'Kids');
  await page.waitForSelector('.kd-row', { timeout: 15000 });
  await sleep(400);
}
const openKid = async (page, name) => {
  await page.evaluate((n) => [...document.querySelectorAll('.kd-row__name')].find((x) => x.textContent.trim() === n)?.click(), name);
  await page.waitForSelector('.kd-ed-head', { timeout: 10000 });
  await sleep(600);
};
const card = (page) => page.$eval('#kd-sec-sponsor', (el) => el.innerText.replace(/\s+/g, ' ').trim()).catch(() => '');
const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\s+/g, ' ').trim()));
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false }).catch(() => {});
const lastCall = (api, path, pred = () => true) => [...api.st.calls].reverse().find((c) => c.path === path && pred(c));

const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
try {
  // ── Desktop ──
  console.log(`\nDesktop 1440 (${KID.name}, awaiting funding)`);
  {
    const { page, api, errors } = await open(browser, { width: 1440, height: 1000, mobile: false });
    await goKids(page, false);
    const row = await page.evaluate((n) => [...document.querySelectorAll('.kd-row')].find((r) => r.querySelector('.kd-row__name')?.textContent.trim() === n)?.innerText || '', KID.name);
    ok(/No monetary sponsor yet/.test(row), `the Kids list flags ${KID.name}: no monetary sponsor yet`);
    await openKid(page, KID.name);

    // The card: right after Status, saying what to do
    const order = await page.$$eval('.kd-rail > section', (els) => els.map((e) => e.className.match(/kd-card--(\w+)/)?.[1]));
    ok(order[0] === 'status' && order[1] === 'sponsor', `the sponsor card is second in the side panel, after Status (${order.join(', ')})`);
    ok(await page.$eval('#kd-sec-sponsor', (el) => el.classList.contains('is-needed')), 'awaiting funding with no sponsor: the card is marked as needed');
    let text = await card(page);
    ok(/Who’s paying for/.test(text), `it asks who’s paying (“${text.slice(0, 90)}”)`);
    await page.waitForFunction(() => /Use The Voila Foundation/.test(document.querySelector('#kd-sec-sponsor')?.innerText || ''), { timeout: 5000 }).catch(() => {});
    text = await card(page);
    ok(/JobTread’s Monetary Sponsor says Voila Foundation/.test(text) && /Use The Voila Foundation/.test(text), 'JobTread’s “Voila Foundation” is offered as The Voila Foundation');
    ok(/Dana Reed/.test(text) || /Use The Voila Foundation/.test(text), 'the Sponsor user on the job is shown or folded into the same suggestion');
    const health = await page.$eval('.kd-card--health', (el) => el.innerText);
    ok(/Monetary sponsor/.test(health), 'the checklist has Monetary sponsor');
    await shot(page, 'desktop-1-needed');

    // Use the suggestion
    await clickText(page, '#kd-sec-sponsor button', 'Use The Voila Foundation');
    await sleep(400);
    text = await card(page);
    ok(/The Voila Foundation/.test(text) && /Saving gives The Voila Foundation access to the job in JobTread as a Sponsor\. JobTread’s Monetary Sponsor then shows who has that access/.test(text), 'picked, and the card says Save gives them job access, then the field follows');
    const firstLogo = await page.$eval('.kd-logos li input', (el) => el.value).catch(() => '');
    ok(firstLogo === VOILA.name, `their logo leads the Partners logos (first: “${firstLogo}”)`);
    ok(await page.$eval('#kd-sec-sponsor', (el) => !el.classList.contains('is-needed')), 'no longer marked as needed');

    // Their contact, before saving
    await clickText(page, '#kd-sec-sponsor button', 'Add a contact');
    await page.waitForSelector('#kd-sp-contact-name-0', { timeout: 5000 });
    await page.type('#kd-sp-contact-name-0', 'Dana Reed');
    await page.type('#kd-sp-contact-email-0', 'not-an-email');
    await clickText(page, '.kd-dialog__foot button', 'Save');
    await sleep(300);
    ok(await page.$eval('#kd-sp-contact-email-0', (el) => el.classList.contains('is-invalid')), 'a bad email is refused in place');
    ok(!lastCall(api, '/api/sponsors-admin', (c) => c.body?.contacts), 'nothing was sent');
    await page.$eval('#kd-sp-contact-email-0', (el) => { el.value = ''; });
    await page.type('#kd-sp-contact-email-0', 'x', { delay: 0 });
    await page.evaluate(() => { const el = document.querySelector('#kd-sp-contact-email-0'); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.type('#kd-sp-contact-email-0', 'dana@voilafdn.org');
    await page.type('#kd-sp-contact-phone-0', '404 555 0100');
    await clickText(page, '.kd-dialog__foot button', 'Save');
    await page.waitForFunction(() => !document.querySelector('#kd-sp-contact-name-0'), { timeout: 5000 }).catch(() => {});
    const sent = lastCall(api, '/api/sponsors-admin', (c) => c.body?.contacts)?.body?.contacts;
    ok(sent?.partner === 'the-voila-foundation' && sent.people[0]?.email === 'dana@voilafdn.org', 'the contact is saved to the private contacts API');
    text = await card(page);
    ok(/dana@voilafdn\.org/.test(text) && /404 555 0100/.test(text), 'the card lists the contact');
    ok(!Object.values(api.st.partners).some((p) => JSON.stringify(p).includes('dana@')), 'the partner record never carries the contact');

    // Save: the kid record, then JobTread follows
    await page.click('.kd-save');
    await page.waitForFunction(() => /Monetary Sponsor says “The Voila Foundation”/.test(document.querySelector('#kd-sec-sponsor')?.innerText || ''), { timeout: 8000 }).catch(() => {});
    ok(JSON.stringify(api.st.kids[KID.slug].sponsors) === '["the-voila-foundation"]', 'the saved kid has sponsors: ["the-voila-foundation"]');
    ok(api.st.kids[KID.slug].partnerLogos[0]?.name === VOILA.name, 'the saved record leads Partners with their logo');
    const sync = lastCall(api, '/api/sponsors-admin', (c) => c.body?.sync)?.body?.sync;
    ok(sync?.kid === KID.slug && sync.job === JOB && Array.isArray(sync.previous) && !sync.previous.length, 'Save sends the JobTread sync for this kid’s job');
    ok(api.st.jobs[JOB].field === 'The Voila Foundation', 'JobTread’s Monetary Sponsor now mirrors who has Sponsor access: The Voila Foundation');
    text = await card(page);
    ok(/Dana Reed is on the job as a Sponsor/.test(text), 'the card shows Dana on the job as a Sponsor');
    const said = (await toasts(page)).join(' | ');
    ok(/JobTread: .*Monetary Sponsor now says “The Voila Foundation”/.test(said), `a toast says what JobTread got (${said.slice(0, 200)})`);
    ok(/says “The Voila Foundation”, from who has Sponsor access/.test(await card(page)), 'the card says the field comes from who has Sponsor access');
    await shot(page, 'desktop-2-saved');

    // Another contact: not on the job yet → said; Save adds them
    await clickText(page, '#kd-sec-sponsor button', 'Edit contacts');
    await page.waitForSelector('#kd-sp-contact-name-0');
    await clickText(page, '.kd-dialog button', 'Add another person');
    await page.type('#kd-sp-contact-name-1', 'Ray Cole');
    await page.type('#kd-sp-contact-email-1', 'ray@voilafdn.org');
    await clickText(page, '.kd-dialog__foot button', 'Save');
    await page.waitForFunction(() => /Ray Cole isn’t on the job yet/.test(document.querySelector('#kd-sec-sponsor')?.innerText || ''), { timeout: 5000 }).catch(() => {});
    ok(/Ray Cole isn’t on the job yet\. Saving adds them as a Sponsor/.test(await card(page)), 'a contact not on the job: “Saving adds them as a Sponsor”');
    // Nothing else changed, but JobTread is behind: Save still syncs
    await page.evaluate(() => { const el = document.querySelector('#kd-diagnosis'); el.value += ' '; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('.kd-save');
    await page.waitForFunction(() => /Ray Cole are on the job as a Sponsor|Dana Reed and Ray Cole/.test(document.querySelector('#kd-sec-sponsor')?.innerText || ''), { timeout: 8000 }).catch(() => {});
    ok(api.st.jobs[JOB].people.some((x) => x.email === 'ray@voilafdn.org' && x.role === 'Sponsor'), 'Ray was added to the job as a Sponsor');
    ok(/Ray Cole added to the job as a Sponsor/.test((await toasts(page)).join(' ')), 'the toast names Ray');

    // A second sponsor, new to Partners, by keyboard
    await page.click('#kd-sponsor-q');
    await page.type('#kd-sponsor-q', 'Kind Neighbors Fund');
    await sleep(200);
    const opts = await page.$$eval('#kd-sponsor-list [role=option]', (els) => els.map((e) => e.innerText.trim()));
    ok(opts.at(-1) === 'Add “Kind Neighbors Fund” as a new sponsor', `the list ends with Add “Kind Neighbors Fund” (${opts.join(' / ')})`);
    for (let i = 0; i < opts.length - 1; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#pt-new-name', { timeout: 5000 });
    ok(await page.$eval('#pt-new-name', (el) => el.value) === 'Kind Neighbors Fund', 'the Add a sponsor dialog has the name');
    const dlg = await page.$eval('.kd-dialog', (el) => el.innerText);
    ok(/Add Kind Neighbors Fund/.test(dlg) && /Only staff see their contact/.test(dlg) && /Who to reach there/.test(dlg), 'the dialog is the sponsor version, with a private contact');
    ok(await page.$eval('.pt-create input[type=file]', (el) => !!el), 'it takes a logo');
    const fileInput = await page.$('.pt-create input[type=file]');
    await fileInput.uploadFile(PNG);
    await page.waitForFunction(() => document.querySelector('.pt-create__drop')?.classList.contains('has-logo'), { timeout: 8000 }).catch(() => {});
    await page.type('#pt-new-person-name-0', 'Jordan Lee');
    await page.type('#pt-new-person-email-0', 'jordan@kindneighbors.org');
    await clickText(page, '.kd-dialog__foot button', 'Add sponsor');
    await page.waitForFunction(() => !document.querySelector('#pt-new-name'), { timeout: 8000 }).catch(() => {});
    const added = api.st.partners['kind-neighbors-fund'];
    ok(added && JSON.stringify(added.category) === '["funding"]', `a new partner, under Funding (${JSON.stringify(added?.category)})`);
    ok(added && !JSON.stringify(added).includes('jordan@'), 'its record has no contact in it');
    ok(api.st.contacts['kind-neighbors-fund']?.[0]?.email === 'jordan@kindneighbors.org', 'its contact went to the private store');
    text = await card(page);
    ok(/Kind Neighbors Fund/.test(text) && /jordan@kindneighbors\.org/.test(text) && /Saving gives Kind Neighbors Fund access to the job in JobTread as a Sponsor/.test(text), 'the card lists both sponsors and what Save will do');
    await page.click('.kd-save');
    await page.waitForFunction(() => /Monetary Sponsor says “The Voila Foundation & Kind Neighbors Fund”/.test(document.querySelector('#kd-sec-sponsor')?.innerText || ''), { timeout: 8000 }).catch(() => {});
    ok(api.st.jobs[JOB].people.some((x) => x.email === 'jordan@kindneighbors.org' && x.role === 'Sponsor'), 'Jordan got Sponsor access first');
    ok(api.st.jobs[JOB].field === 'The Voila Foundation & Kind Neighbors Fund', `then the field names both (“${api.st.jobs[JOB].field}”)`);
    await shot(page, 'desktop-3-two');

    // Take one off, with Undo
    // (toasts stack over the panel's lower half, so the button is clicked directly)
    await page.$eval('[aria-label="Remove Kind Neighbors Fund as the sponsor"]', (el) => el.click());
    await sleep(300);
    ok(!/jordan@/.test(await card(page)), 'taken off');
    await page.evaluate(() => [...document.querySelectorAll('.toast-undo')].reverse().find((b) => b.textContent.trim() === 'Undo')?.click());
    await sleep(300);
    ok(/jordan@/.test(await card(page)), 'Undo puts them back');

    // Taken off for real: Save takes Jordan off the job, then the field follows
    await page.$eval('[aria-label="Remove Kind Neighbors Fund as the sponsor"]', (el) => el.click());
    await sleep(300);
    ok(/Saving takes Kind Neighbors Fund off it/.test(await card(page)), 'the card says Save takes them off the job');
    await page.click('.kd-save');
    await page.waitForFunction(() => /says “The Voila Foundation”, from/.test(document.querySelector('#kd-sec-sponsor')?.innerText || ''), { timeout: 8000 }).catch(() => {});
    const off = lastCall(api, '/api/sponsors-admin', (c) => c.body?.sync)?.body?.sync;
    ok(JSON.stringify(off?.previous) === '["the-voila-foundation","kind-neighbors-fund"]', `the sync names who was there before (${JSON.stringify(off?.previous)})`);
    ok(!api.st.jobs[JOB].people.some((x) => x.email === 'jordan@kindneighbors.org'), 'Jordan is off the job');
    ok(api.st.jobs[JOB].field === 'The Voila Foundation', `and the field mirrors that (“${api.st.jobs[JOB].field}”)`);
    ok(/Jordan Lee taken off the job/.test((await toasts(page)).join(' ')), 'the toast says Jordan was taken off');

    // History says it in names
    const hist = await page.$eval('.kd-card--history', (el) => el.innerText).catch(() => '');
    ok(/Monetary sponsor/.test(hist) || /The Voila Foundation/.test(hist), `History names the sponsor change (${hist.replace(/\s+/g, ' ').slice(0, 140)})`);

    const ax = await axeScan(page, '#kd-sec-sponsor');
    ok(!ax.length, `axe: the sponsor card has no WCAG A/AA violations ${axeText(ax)}`);
    ok(!errors.length, `no console errors (${errors.join(' | ').slice(0, 300)})`);
    await page.close();
  }

  // ── Phone ──
  console.log('\nPhone 390');
  {
    const { page, api, errors } = await open(browser, { width: 390, height: 844, mobile: true });
    await goKids(page, true);
    await openKid(page, KID.name);
    const pos = await page.evaluate(() => {
      const s = document.querySelector('#kd-sec-sponsor').getBoundingClientRect();
      const m = document.querySelector('.kd-main').getBoundingClientRect();
      return { above: s.top < m.top, right: s.right };
    });
    ok(pos.above, 'on a phone the sponsor card comes before the editor sections');
    await page.waitForFunction(() => /Use The Voila Foundation/.test(document.querySelector('#kd-sec-sponsor')?.innerText || ''), { timeout: 5000 }).catch(() => {});
    await clickText(page, '#kd-sec-sponsor button', 'Use The Voila Foundation');
    await sleep(300);
    await page.click('#kd-sponsor-q');
    await sleep(200);
    const listShown = await page.$('#kd-sponsor-list');
    ok(!!listShown, 'focusing the search lists funding partners');
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(wide <= 0, `nothing past the screen edge (${wide}px)`);
    const small = await page.$$eval('#kd-sec-sponsor button, #kd-sec-sponsor [role=option]', (els) => els.filter((e) => e.offsetParent && e.getBoundingClientRect().height < 44).map((e) => `${e.textContent.trim().slice(0, 30)} ${Math.round(e.getBoundingClientRect().height)}px`));
    ok(!small.length, `44px touch targets in the card (${small.join(', ')})`);
    await page.keyboard.press('Escape');
    await page.$eval('#kd-sec-sponsor', (el) => el.scrollIntoView());
    await shot(page, 'phone-1');
    ok(!errors.length, `no console errors (${errors.join(' | ').slice(0, 300)})`);
    void api;
    await page.close();
  }
} catch (e) {
  failures.push(`crashed: ${e.stack || e.message}`);
  console.log(e);
} finally {
  await browser.close();
  stopDev();
}
console.log(`\n${failures.length ? `${failures.length} failed:\n - ${failures.join('\n - ')}` : 'All passed'}`);
process.exit(failures.length ? 1 : 0);
